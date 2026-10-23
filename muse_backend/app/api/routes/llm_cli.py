"""
OpenAI-compatible façade over the subscription CLIs (Claude Code, Codex).

POST /llm/cli/v1/chat/completions   body: {model, messages, stream?}

`model` is "<provider>" or "<provider>/<model>", e.g. "claude_code/sonnet", "codex/gpt-5.3-codex".
Lets every Next.js call site that already speaks `chat/completions` (Story Muse, scene
generation, Extensions orchestration) use the CLIs without new client code.
Loopback-only backend; the Authorization header is ignored.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, AsyncGenerator, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.providers.llm.cli_providers import CLI_STREAMERS, ClaudeCodeProvider, CodexProvider

router = APIRouter(prefix="/llm/cli", tags=["LLM"])

_DEFAULT_MODEL = {"claude_code": ClaudeCodeProvider.models[0], "codex": ""}  # codex "" = CLI default


class ChatMessage(BaseModel):
    role: str
    content: Any = ""


class ChatCompletionRequest(BaseModel):
    model: str = Field(..., min_length=1)
    messages: list[ChatMessage]
    stream: bool = False
    max_tokens: Optional[int] = None  # accepted for compatibility; CLIs manage their own limits
    temperature: Optional[float] = None


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # OpenAI content-part arrays
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content or "")


def split_model(model: str) -> tuple[str, str]:
    provider, _, name = model.partition("/")
    if provider not in CLI_STREAMERS:
        raise HTTPException(400, f"Unknown CLI provider '{provider}'. Use one of: {', '.join(CLI_STREAMERS)}")
    return provider, name or _DEFAULT_MODEL[provider]


def flatten_messages(messages: list[ChatMessage]) -> tuple[str, str]:
    """Headless CLIs take one system prompt and one user turn: fold the history into the user turn."""
    system = "\n\n".join(_text(m.content) for m in messages if m.role == "system").strip()
    turns = [m for m in messages if m.role != "system"]
    if len(turns) == 1:
        return system, _text(turns[0].content)
    lines = []
    for m in turns:
        label = "User" if m.role == "user" else "Assistant"
        lines.append(f"{label}: {_text(m.content)}")
    lines.append("Assistant:")
    return system, "\n\n".join(lines)


def _chunk(cid: str, model: str, delta: dict, finish: str | None = None) -> str:
    payload = {
        "id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(payload)}\n\n"


@router.post("/v1/chat/completions")
async def chat_completions(body: ChatCompletionRequest):
    provider, model_name = split_model(body.model)
    streamer = CLI_STREAMERS[provider]
    system_prompt, user_message = flatten_messages(body.messages)
    if not user_message.strip():
        raise HTTPException(422, "messages must contain a user turn")
    cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"

    if body.stream:
        async def sse() -> AsyncGenerator[str, None]:
            yield _chunk(cid, body.model, {"role": "assistant", "content": ""})
            try:
                async for text in streamer(system_prompt=system_prompt, user_message=user_message, model=model_name):
                    yield _chunk(cid, body.model, {"content": text})
                yield _chunk(cid, body.model, {}, finish="stop")
            except Exception as exc:  # noqa: BLE001
                yield f"data: {json.dumps({'error': {'message': str(exc), 'type': 'cli_error'}})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(sse(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    parts: list[str] = []
    try:
        async for text in streamer(system_prompt=system_prompt, user_message=user_message, model=model_name):
            parts.append(text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc
    return {
        "id": cid, "object": "chat.completion", "created": int(time.time()), "model": body.model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(parts)}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }
