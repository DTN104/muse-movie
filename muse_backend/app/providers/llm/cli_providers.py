"""
Story Muse — LLM Providers backed by locally installed coding-agent CLIs.

Uses the user's *subscription* login (ChatGPT Plus/Pro via Codex CLI, Claude Pro/Max via
Claude Code) instead of an API key, by running the CLIs in their documented headless modes:

  claude -p --output-format stream-json ...     (token streaming)
  codex exec --json ...                          (final message as one chunk)

No OAuth tokens are read or reused by this code; the CLI handles auth itself.
Global hooks, plugins and MCP servers of the CLIs are disabled so Story Muse prompts stay
cheap and deterministic. Requires `claude` / `codex` on PATH and a completed login.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

from app.providers.base import LLMChunk, LLMProvider
from app.providers.llm.shared_prompts import system_prompts_openai_compatible

logger = logging.getLogger(__name__)

SYSTEM_PROMPTS: dict[str, str] = system_prompts_openai_compatible(include_general_query=True)

CLAUDE_MODELS = ["sonnet", "opus", "haiku"]
CODEX_MODELS = ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.2", "gpt-5.1-codex-mini"]
DEFAULT_TIMEOUT_S = 600

_WORKDIR = Path(tempfile.gettempdir()) / "muse-studio-cli-llm"  # empty cwd: no AGENTS.md/CLAUDE.md picked up


def _which(binary: str) -> Optional[str]:
    # Dev servers started from an IDE may miss the user's shell PATH; check the usual spots too.
    found = shutil.which(binary)
    if found:
        return found
    for candidate in (Path.home() / ".local/bin" / binary, Path("/opt/homebrew/bin") / binary, Path("/usr/local/bin") / binary):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _user_message(prompt: str, context: Optional[dict[str, Any]]) -> str:
    if not context:
        return prompt
    context_str = "\n".join(f"{k}: {v}" for k, v in context.items())
    return f"Context:\n{context_str}\n\nRequest:\n{prompt}"


async def _spawn(argv: list[str], stdin_text: str | None = None) -> asyncio.subprocess.Process:
    _WORKDIR.mkdir(parents=True, exist_ok=True)
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(_WORKDIR),
        stdin=asyncio.subprocess.PIPE if stdin_text is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    if stdin_text is not None and proc.stdin is not None:
        proc.stdin.write(stdin_text.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()
    return proc


async def _finish(proc: asyncio.subprocess.Process, name: str) -> None:
    """Wait for exit; surface stderr if the CLI failed (e.g. not logged in)."""
    stderr = (await proc.stderr.read()).decode("utf-8", "replace") if proc.stderr else ""
    code = await proc.wait()
    if code != 0:
        detail = stderr.strip().splitlines()[-1] if stderr.strip() else f"exit {code}"
        raise RuntimeError(f"{name} exited with {code}: {detail}")


async def _kill(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        proc.kill()
        await proc.wait()


# ── Claude Code ───────────────────────────────────────────────────────────────

async def stream_claude_code(
    *, system_prompt: str, user_message: str, model: str, timeout_s: float = DEFAULT_TIMEOUT_S
) -> AsyncGenerator[str, None]:
    """Yield text deltas from `claude -p` (stream-json). Raises RuntimeError on CLI failure."""
    binary = _which("claude")
    if not binary:
        raise RuntimeError("Claude Code CLI not found. Install it and run `claude` once to sign in.")
    argv = [
        binary, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--no-session-persistence", "--tools", "", "--setting-sources", "",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--model", model or "sonnet", "--system-prompt", system_prompt,
    ]
    proc = await _spawn(argv, stdin_text=user_message)
    try:
        async with asyncio.timeout(timeout_s):
            assert proc.stdout is not None
            async for raw in proc.stdout:
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                if ev.get("type") == "stream_event":
                    inner = ev.get("event") or {}
                    if inner.get("type") == "content_block_delta":
                        text = (inner.get("delta") or {}).get("text")
                        if text:
                            yield text
                elif ev.get("type") == "result" and ev.get("is_error"):
                    raise RuntimeError(ev.get("result") or "Claude Code returned an error")
            await _finish(proc, "claude")
    except TimeoutError:
        await _kill(proc)
        raise RuntimeError(f"Claude Code timed out after {timeout_s:.0f}s")
    finally:
        await _kill(proc)


# ── Codex ─────────────────────────────────────────────────────────────────────

async def stream_codex(
    *, system_prompt: str, user_message: str, model: str, timeout_s: float = DEFAULT_TIMEOUT_S
) -> AsyncGenerator[str, None]:
    """Yield the final agent message from `codex exec --json` (no token streaming in exec mode)."""
    binary = _which("codex")
    if not binary:
        raise RuntimeError("Codex CLI not found. Install it and run `codex` once to sign in.")
    argv = [
        binary, "exec", "--json", "--skip-git-repo-check", "--ephemeral",
        "-s", "read-only", "-c", "mcp_servers={}",
        "-C", str(_WORKDIR),
    ]
    if model:
        argv += ["-m", model]
    # codex exec has no system-prompt flag: prepend it to the single prompt.
    prompt = f"{system_prompt}\n\n---\n\n{user_message}"
    argv.append("-")  # read prompt from stdin
    proc = await _spawn(argv, stdin_text=prompt)
    try:
        async with asyncio.timeout(timeout_s):
            assert proc.stdout is not None
            async for raw in proc.stdout:
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                if ev.get("type") == "item.completed":
                    item = ev.get("item") or {}
                    if item.get("type") == "agent_message" and item.get("text"):
                        yield item["text"]
                elif ev.get("type") == "turn.failed" or ev.get("type") == "error":
                    raise RuntimeError((ev.get("error") or {}).get("message") or ev.get("message") or "Codex turn failed")
            await _finish(proc, "codex")
    except TimeoutError:
        await _kill(proc)
        raise RuntimeError(f"Codex timed out after {timeout_s:.0f}s")
    finally:
        await _kill(proc)


# ── Provider classes ──────────────────────────────────────────────────────────

class _CliProvider(LLMProvider):
    provider_type = "local"
    binary: str
    install_hint: str
    models: list[str]
    model_param: str

    def is_available(self) -> bool:
        return _which(self.binary) is not None

    def unavailable_reason(self) -> Optional[str]:
        if not self.is_available():
            return self.install_hint
        return None

    def capabilities(self) -> dict[str, Any]:
        return {"models": self.models, "streaming": True, "max_context_tokens": 200000, "auth": "subscription"}

    def _stream(self, **kw) -> AsyncGenerator[str, None]:  # pragma: no cover - overridden
        raise NotImplementedError

    async def generate_stream(
        self, task: str, prompt: str, context: Optional[dict[str, Any]], params: dict[str, Any]
    ) -> AsyncGenerator[LLMChunk, None]:
        if not self.is_available():
            yield LLMChunk(text=f"Error: {self.install_hint}", is_final=True)
            return
        system_prompt = SYSTEM_PROMPTS.get(task, SYSTEM_PROMPTS["default"])
        model = params.get(self.model_param) or self.models[0]
        try:
            async for text in self._stream(system_prompt=system_prompt, user_message=_user_message(prompt, context), model=model):
                yield LLMChunk(text=text)
            yield LLMChunk(text="", is_final=True)
        except Exception as exc:  # noqa: BLE001
            yield LLMChunk(text=f"\n\n[{self.display_name} error: {exc}]", is_final=True)


class ClaudeCodeProvider(_CliProvider):
    provider_id = "claude_code"
    display_name = "Claude Code (subscription)"
    binary = "claude"
    install_hint = "Claude Code CLI not found. Install it (https://claude.com/claude-code) and run `claude` once to sign in."
    models = CLAUDE_MODELS
    model_param = "claude_code_model"

    def _stream(self, **kw):
        return stream_claude_code(**kw)


class CodexProvider(_CliProvider):
    provider_id = "codex"
    display_name = "Codex CLI (subscription)"
    binary = "codex"
    install_hint = "Codex CLI not found. Install it (`npm i -g @openai/codex`) and run `codex` once to sign in."
    models = CODEX_MODELS
    model_param = "codex_model"

    def _stream(self, **kw):
        return stream_codex(**kw)


CLI_STREAMERS = {"claude_code": stream_claude_code, "codex": stream_codex}
