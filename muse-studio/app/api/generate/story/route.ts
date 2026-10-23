import { NextRequest } from 'next/server';
import { getProjectById } from '@/lib/actions/projects';
import { getLLMSettings } from '@/lib/actions/settings';
import { CLI_API_KEY, CLI_PROVIDER_LABEL, cliBaseUrl, cliModelId } from '@/lib/llm-cli';
import { openRouterOptionalHeaders } from '@/lib/generation/openRouterHeaders';
import {
  STORY_GENERATION_SYSTEM_PROMPTS,
  formatProjectForRag,
  streamStoryLMStudio,
  streamStoryOllama,
  streamStoryOpenAICompat,
  storySseError,
} from '@/lib/generation/storyGenerationInternals';

/**
 * POST /api/generate/story
 *
 * Calls LLM providers DIRECTLY from Next.js — does NOT require the Python backend.
 * Supports: Ollama (local), OpenAI, Anthropic Claude (OpenAI-compat)
 *
 * SSE response format (same as before — hook/UI unchanged):
 *   data: {"text": "...", "is_final": false}
 *   data: {"text": "...", "is_final": true}
 *
 * When project_id is present in the body, the project's storyline and script are
 * injected as project_context for RAG.
 */

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    task = 'default',
    prompt,
    context: contextFromBody,
    project_id: projectId,
    provider_id = 'ollama',
    ollama_base_url = 'http://localhost:11434',
    ollama_model = 'qwen3-vl',
    openai_model = 'gpt-4o',
    claude_model = 'claude-sonnet-4-6',
    max_tokens,
    temperature,
    lmstudio_base_url,
    lmstudio_model,
    openrouter_model: openrouterModelBody,
    openrouter_base_url: openrouterBaseUrlBody,
  } = body as {
    task?: string;
    prompt: string;
    context?: Record<string, unknown>;
    project_id?: string;
    provider_id?: string;
    ollama_base_url?: string;
    ollama_model?: string;
    openai_model?: string;
    claude_model?: string;
    max_tokens?: number;
    temperature?: number;
    lmstudio_base_url?: string;
    lmstudio_model?: string;
    openrouter_model?: string;
    openrouter_base_url?: string;
  };

  const systemPrompt =
    STORY_GENERATION_SYSTEM_PROMPTS[task] ?? STORY_GENERATION_SYSTEM_PROMPTS.default;

  let context: Record<string, unknown> = contextFromBody ? { ...contextFromBody } : {};

  if (projectId) {
    const project = await getProjectById(projectId);
    if (project) {
      context.project_context = formatProjectForRag(project);
    }
  }

  let userMessage = prompt;
  if (Object.keys(context).length > 0) {
    const ctx = Object.entries(context)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    userMessage = `Context:\n${ctx}\n\nRequest:\n${prompt}`;
  }

  switch (provider_id) {
    case 'ollama':
      return streamStoryOllama({
        baseUrl: ollama_base_url,
        model: ollama_model,
        systemPrompt,
        userMessage,
        maxTokens: max_tokens,
        temperature,
        disableThinking: task === 'visual_keyframe_prompt',
      });

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY ?? '';
      return streamStoryOpenAICompat({
        baseUrl: 'https://api.openai.com/v1',
        apiKey,
        model: openai_model,
        systemPrompt,
        userMessage,
        maxTokens: max_tokens,
        temperature,
        providerName: 'OpenAI',
      });
    }

    case 'claude': {
      const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      return streamStoryOpenAICompat({
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey,
        model: claude_model,
        systemPrompt,
        userMessage,
        maxTokens: max_tokens,
        temperature,
        providerName: 'Claude',
      });
    }

    case 'lmstudio': {
      const baseUrl =
        lmstudio_base_url ??
        process.env.NEXT_PUBLIC_LMSTUDIO_BASE_URL ??
        'http://127.0.0.1:1234';
      const model = lmstudio_model || openai_model || 'gpt-4o-mini';
      return streamStoryLMStudio({
        baseUrl,
        model,
        systemPrompt,
        userMessage,
        maxTokens: max_tokens,
        temperature,
      });
    }

    case 'claude_code':
    case 'codex': {
      const saved = await getLLMSettings();
      return streamStoryOpenAICompat({
        baseUrl: cliBaseUrl(),
        apiKey: CLI_API_KEY,
        model: cliModelId(provider_id, provider_id === 'codex' ? saved.codexModel : saved.claudeCodeModel),
        systemPrompt,
        userMessage,
        maxTokens: max_tokens,
        temperature,
        providerName: CLI_PROVIDER_LABEL[provider_id],
      });
    }

    case 'openrouter': {
      const saved = await getLLMSettings();
      const baseUrl = (
        openrouterBaseUrlBody || saved.openrouterBaseUrl || 'https://openrouter.ai/api/v1'
      ).replace(/\/+$/, '');
      const model = openrouterModelBody || saved.openrouterModel || 'openai/gpt-4o-mini';
      const apiKey = process.env.OPENROUTER_API_KEY ?? '';
      return streamStoryOpenAICompat({
        baseUrl,
        apiKey,
        model,
        systemPrompt,
        userMessage,
        maxTokens: max_tokens,
        temperature,
        providerName: 'OpenRouter',
        extraHeaders: openRouterOptionalHeaders(),
      });
    }

    default:
      return storySseError(
        `Unknown provider: "${provider_id}". Choose: ollama, openai, claude, lmstudio, openrouter`,
      );
  }
}
