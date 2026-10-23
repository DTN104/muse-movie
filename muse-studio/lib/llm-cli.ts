/**
 * Subscription-CLI LLM providers (Claude Code, Codex).
 *
 * The Python backend wraps the locally installed, signed-in CLIs behind an
 * OpenAI-compatible endpoint (muse_backend/app/api/routes/llm_cli.py), so every
 * call site that already speaks `chat/completions` can use them by pointing at
 * `cliBaseUrl()` with the placeholder key and a "<provider>/<model>" model id.
 */

export const CLI_PROVIDERS = ['claude_code', 'codex'] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];

export const CLI_API_KEY = 'subscription-cli'; // backend ignores it; non-empty to satisfy key checks

export const CLAUDE_CODE_MODELS = [
  { id: 'sonnet', label: 'Claude Sonnet', description: 'Balanced — recommended' },
  { id: 'opus', label: 'Claude Opus', description: 'Most capable, slower' },
  { id: 'haiku', label: 'Claude Haiku', description: 'Fastest' },
];

export const CODEX_MODELS = [
  { id: '', label: 'Codex default', description: 'Whatever `codex` is configured to use' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Latest Codex model' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', description: 'Previous Codex model' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex mini', description: 'Fast, cheaper on quota' },
];

export const CLI_PROVIDER_LABEL: Record<CliProvider, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
};

export function isCliProvider(p: string | undefined | null): p is CliProvider {
  return p === 'claude_code' || p === 'codex';
}

export function cliBaseUrl(): string {
  const backend = (process.env.MUSE_BACKEND_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
  return `${backend}/llm/cli/v1`;
}

/** Model id the façade expects: "claude_code/sonnet", "codex/gpt-5.3-codex" or just "codex". */
export function cliModelId(provider: CliProvider, model: string | undefined | null): string {
  const m = (model ?? '').trim();
  return m ? `${provider}/${m}` : provider;
}
