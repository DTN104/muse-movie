import { NextRequest } from 'next/server';
import { db } from '@/db';
import { CLI_API_KEY, CLI_PROVIDER_LABEL, cliBaseUrl, cliModelId, isCliProvider } from '@/lib/llm-cli';
import {
  MAX_SCENE_PROMPT_CHAR_BLOCK_CHARS,
  MAX_SCENE_PROMPT_LOGLINE_CHARS,
  MAX_SCENE_PROMPT_PLOT_CHARS,
  MAX_SCENE_PROMPT_THEMES_CHARS,
  MAX_SCENES_PER_REQUEST,
  buildSceneSystemPrompt,
  clipForScenePrompt,
  generateLMStudioText,
  generateOllamaText,
  generateOpenAICompatText,
  newSceneId,
  openRouterOptionalHeaders,
  parseSceneBlock,
  sseKeepAlive,
  sseNamedEvent,
} from '@/lib/generation/scenesBatchSupport';

/**
 * POST /api/generate/scenes
 *
 * Reads the confirmed storyline from DB for a project, then streams an LLM
 * to generate a set of scene scripts. Saves each scene to the DB as it's parsed.
 *
 * Large scene counts (e.g. 40) can cause timeouts and stream issues. We cap at
 * MAX_SCENES_PER_REQUEST and scale Ollama num_predict/timeout by count.
 *
 * SSE events (named):
 *   event: import  — storyline field imported (for the checklist animation)
 *   event: text    — raw LLM text delta (for optional display)
 *   event: scene   — a complete parsed + saved scene
 *   event: done    — all done
 *   event: error   — fatal error
 *   : ping         — keep-alive comment while model loads
 */

export async function POST(req: NextRequest) {
  // Read raw body once so we can both log and parse it safely
  const rawBody = await req.text();

  // #region agent log
  fetch('http://127.0.0.1:7792/ingest/28803232-41f8-4ca2-8286-1055ebb53327', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': 'ccff78',
    },
    body: JSON.stringify({
      sessionId: 'ccff78',
      runId: 'initial',
      hypothesisId: 'H1',
      location: 'app/api/generate/scenes/route.ts:POST:entry',
      message: 'scenes POST raw body',
      data: {
        method: req.method,
        url: req.url,
        contentType: req.headers.get('content-type'),
        contentLength: req.headers.get('content-length'),
        rawSnippet: rawBody.slice(0, 200),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  let body: { projectId?: string; targetScenes?: number } = {};
  try {
    body = rawBody ? (JSON.parse(rawBody) as { projectId?: string; targetScenes?: number }) : {};
  } catch (err) {
    // #region agent log
    fetch('http://127.0.0.1:7792/ingest/28803232-41f8-4ca2-8286-1055ebb53327', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': 'ccff78',
      },
      body: JSON.stringify({
        sessionId: 'ccff78',
        runId: 'initial',
        hypothesisId: 'H2',
        location: 'app/api/generate/scenes/route.ts:POST:parseError',
        message: 'Failed to parse scenes POST body as JSON',
        data: {
          error: err instanceof Error ? err.message : String(err),
          rawSnippet: rawBody.slice(0, 200),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    return new Response(JSON.stringify({ error: 'Invalid JSON body for scenes generation' }), {
      status: 400,
    });
  }
  const { projectId } = body;

  if (!projectId) {
    return new Response(JSON.stringify({ error: 'Missing projectId' }), { status: 400 });
  }

  // Load project + storyline from DB
  const projectRow = db
    .prepare<[string], {
      storyline_logline: string | null;
      storyline_plot_outline: string | null;
      storyline_characters: string | null;
      storyline_themes: string | null;
      storyline_genre: string | null;
    }>('SELECT storyline_logline, storyline_plot_outline, storyline_characters, storyline_themes, storyline_genre FROM projects WHERE id = ?')
    .get(projectId);

  if (!projectRow?.storyline_plot_outline) {
    return new Response(JSON.stringify({ error: 'Project has no confirmed storyline' }), { status: 400 });
  }

  const loglineRaw = projectRow.storyline_logline ?? '';
  const plotOutlineRaw = projectRow.storyline_plot_outline;
  const charactersRaw: string[] = projectRow.storyline_characters ? JSON.parse(projectRow.storyline_characters) : [];
  const themes: string[] = projectRow.storyline_themes ? JSON.parse(projectRow.storyline_themes) : [];
  const genre = projectRow.storyline_genre ?? '';

  const logline = loglineRaw
    ? clipForScenePrompt(
        loglineRaw,
        MAX_SCENE_PROMPT_LOGLINE_CHARS,
        'Logline truncated for scene-generation prompt; full line is stored in the project.',
      )
    : '';
  const plotOutline = clipForScenePrompt(
    plotOutlineRaw,
    MAX_SCENE_PROMPT_PLOT_CHARS,
    'Plot truncated for scene-generation prompt; full outline is stored in the project.',
  );
  const characters = charactersRaw.map((c, i) =>
    clipForScenePrompt(
      c,
      MAX_SCENE_PROMPT_CHAR_BLOCK_CHARS,
      `Character ${i + 1} truncated for scene-generation prompt; full bio is stored in the project.`,
    ),
  );

  // Load LLM settings
  const settingRows = db
    .prepare<[], { key: string; value: string }>('SELECT key, value FROM settings')
    .all();
  const settings = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));

  const provider = settings.llm_provider ?? 'ollama';
  const ollamaUrl = settings.ollama_base_url ?? 'http://localhost:11434';
  const ollamaModel = settings.ollama_model ?? 'qwen3-vl:latest';
  const openaiModel = settings.openai_model ?? 'gpt-4o';
  const claudeModel = settings.claude_model ?? 'claude-sonnet-4-6';
  const lmstudioBaseUrl = settings.lmstudio_base_url ?? 'http://127.0.0.1:1234';
  const lmstudioModel = settings.lmstudio_model ?? 'gpt-4o-mini';
  const openrouterModel = settings.openrouter_model ?? 'openai/gpt-4o-mini';
  const openrouterBaseUrl = settings.openrouter_base_url ?? 'https://openrouter.ai/api/v1';


  // Resolve requested scene count (fallback to 5 for compatibility); cap to avoid timeouts/stream issues
  const requested = Number.isFinite(body.targetScenes as number)
    ? Math.max(1, Math.floor(body.targetScenes as number))
    : 5;
  if (requested > MAX_SCENES_PER_REQUEST) {
    return new Response(
      JSON.stringify({
        error: `Requested ${requested} scenes. For stability, generate at most ${MAX_SCENES_PER_REQUEST} scenes per run. Use ${MAX_SCENES_PER_REQUEST} and add more from the Kanban.`,
      }),
      { status: 400 },
    );
  }
  const targetScenes = requested;

  // OpenAI-style APIs need enough output tokens for N scene blocks; 3k cuts off around 1–2 scenes.
  const openaiMaxOutput = Math.min(16_384, Math.max(4_096, Math.round(600 * targetScenes)));
  const openaiStreamTimeoutMs = Math.min(60 * 60 * 1000, 120_000 + targetScenes * 25_000);
  const claudeMaxOutput = Math.min(8_192, Math.max(4_096, Math.round(520 * targetScenes)));

  const sceneSystemPrompt = buildSceneSystemPrompt(targetScenes);

  // Scale Ollama token limit and timeout for large scene counts
  const ollamaNumPredict = Math.min(32_000, Math.max(3_000, 500 * targetScenes));
  const ollamaTimeoutMs = 15 * 60 * 1000 + Math.max(0, targetScenes - 10) * 60 * 1000;
  const ollamaTimeoutCapped = Math.min(60 * 60 * 1000, ollamaTimeoutMs);

  const themesJoined = themes.join(', ');
  const themesClipped =
    themesJoined.length > MAX_SCENE_PROMPT_THEMES_CHARS
      ? `${themesJoined.slice(0, MAX_SCENE_PROMPT_THEMES_CHARS)}… [themes truncated for prompt]`
      : themesJoined;

  // Build the user message from storyline
  const userMessage = [
    `PROJECT STORYLINE`,
    logline ? `LOGLINE: ${logline}` : '',
    `PLOT OUTLINE:\n${plotOutline}`,
    characters.length ? `CHARACTERS:\n${characters.map((c) => `- ${c}`).join('\n')}` : '',
    themes.length ? `THEMES: ${themesClipped}` : '',
    genre ? `GENRE: ${genre}` : '',
    '',
    `Generate between ${Math.max(1, targetScenes - 1)} and ${targetScenes + 2} scenes as specified.`,
  ].filter(Boolean).join('\n\n');

  // Build the streaming response
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (bytes: Uint8Array) => controller.enqueue(bytes);

      // ── Phase 1: Import events ────────────────────────────────────────────
      const importFields = [
        {
          field: 'logline',
          label: 'Logline',
          value: loglineRaw
            ? loglineRaw.slice(0, 80) + (loglineRaw.length > 80 ? '…' : '')
            : '(none)',
        },
        {
          field: 'plotOutline',
          label: 'Plot Outline',
          value: plotOutlineRaw.slice(0, 60) + (plotOutlineRaw.length > 60 ? '…' : ''),
        },
        {
          field: 'characters',
          label: 'Characters',
          value: `${charactersRaw.length} character${charactersRaw.length !== 1 ? 's' : ''}`,
        },
        { field: 'themes', label: 'Themes', value: `${themes.length} theme${themes.length !== 1 ? 's' : ''}` },
        { field: 'genre', label: 'Genre', value: genre || 'Unspecified' },
      ];

      for (let i = 0; i < importFields.length; i++) {
        enqueue(sseNamedEvent('import', { ...importFields[i], index: i, total: importFields.length }));
      }

      enqueue(sseNamedEvent('generating', { message: 'Story Muse is writing your scene scripts…' }));

      // ── Phase 2: LLM scene generation ────────────────────────────────────
      let generator: AsyncGenerator<string>;

      try {
        if (provider === 'openai') {
          generator = generateOpenAICompatText({
            baseUrl: 'https://api.openai.com/v1',
            apiKey: process.env.OPENAI_API_KEY ?? '',
            model: openaiModel,
            systemPrompt: sceneSystemPrompt,
            userMessage,
            providerName: 'OpenAI',
            maxOutputTokens: openaiMaxOutput,
            timeoutMs: openaiStreamTimeoutMs,
          });
        } else if (provider === 'claude') {
          generator = generateOpenAICompatText({
            baseUrl: 'https://api.anthropic.com/v1',
            apiKey: process.env.ANTHROPIC_API_KEY ?? '',
            model: claudeModel,
            systemPrompt: sceneSystemPrompt,
            userMessage,
            providerName: 'Claude',
            maxOutputTokens: claudeMaxOutput,
            timeoutMs: openaiStreamTimeoutMs,
          });
        } else if (provider === 'lmstudio') {
          generator = generateLMStudioText({
            baseUrl: lmstudioBaseUrl,
            model: lmstudioModel,
            systemPrompt: sceneSystemPrompt,
            userMessage,
            maxOutputTokens: openaiMaxOutput,
            timeoutMs: openaiStreamTimeoutMs,
          });
        } else if (isCliProvider(provider)) {
          generator = generateOpenAICompatText({
            baseUrl: cliBaseUrl(),
            apiKey: CLI_API_KEY,
            model: cliModelId(provider, provider === 'codex' ? settings.codex_model : (settings.claude_code_model ?? 'sonnet')),
            systemPrompt: sceneSystemPrompt,
            userMessage,
            providerName: CLI_PROVIDER_LABEL[provider],
            maxOutputTokens: openaiMaxOutput,
            timeoutMs: openaiStreamTimeoutMs,
          });
        } else if (provider === 'openrouter') {
          generator = generateOpenAICompatText({
            baseUrl: openrouterBaseUrl,
            apiKey: process.env.OPENROUTER_API_KEY ?? '',
            model: openrouterModel,
            systemPrompt: sceneSystemPrompt,
            userMessage,
            providerName: 'OpenRouter',
            maxOutputTokens: openaiMaxOutput,
            timeoutMs: openaiStreamTimeoutMs,
            extraHeaders: openRouterOptionalHeaders(),
            missingKeyHint: 'Set OPENROUTER_API_KEY in muse-studio/.env.local.',
          });
        } else {
          generator = generateOllamaText({
            baseUrl: ollamaUrl,
            model: ollamaModel,
            systemPrompt: sceneSystemPrompt,
            userMessage,
            numPredict: ollamaNumPredict,
            timeoutMs: ollamaTimeoutCapped,
          });
        }
      } catch (err) {
        enqueue(sseNamedEvent('error', { message: String(err) }));
        controller.close();
        return;
      }

      // Keep-alive while model is loading (Ollama can take a while to load the model)
      let firstTokenReceived = false;
      let streamClosed = false;
      const keepAlive = setInterval(() => {
        if (streamClosed || firstTokenReceived) return;
        try {
          controller.enqueue(sseKeepAlive());
        } catch {
          streamClosed = true;
          clearInterval(keepAlive);
        }
      }, 5000);

      let accumulated = '';
      let parsedCount = 0;
      const now = new Date().toISOString();

      const insertScene = db.prepare(`
        INSERT INTO scenes
          (id, project_id, scene_number, title, heading, description,
           dialogue, technical_notes, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SCRIPT', ?, ?)
      `);

      const safeEnqueue = (bytes: Uint8Array) => {
        try {
          controller.enqueue(bytes);
        } catch {
          streamClosed = true;
          clearInterval(keepAlive);
        }
      };

      try {
        for await (const chunk of generator) {
          if (streamClosed) break;
          firstTokenReceived = true;
          accumulated += chunk;

          // Send raw text delta so overlay can optionally show it (client may have disconnected)
          safeEnqueue(sseNamedEvent('text', { delta: chunk }));

          // Parse complete <<<SCENE>>>...<<<END>>> blocks
          while (true) {
            const endIdx = accumulated.indexOf('<<<END>>>');
            if (endIdx === -1) break;
            const startIdx = accumulated.lastIndexOf('<<<SCENE>>>', endIdx);
            if (startIdx === -1) break;

            const block = accumulated.substring(startIdx + 11, endIdx);
            accumulated = accumulated.substring(endIdx + 9);

            const scene = parseSceneBlock(block, parsedCount + 1);
            if (!scene) {
              console.warn('[scenes] Unable to parse scene block, skipping.');
              continue;
            }

            parsedCount++;
            const sceneId = newSceneId();

            try {
              insertScene.run(
                sceneId, projectId, scene.sceneNumber,
                scene.title, scene.heading, scene.description,
                scene.dialogue || null, scene.technicalNotes || null,
                now, now,
              );

              safeEnqueue(sseNamedEvent('scene', {
                sceneId,
                sceneNumber: scene.sceneNumber,
                title: scene.title,
                heading: scene.heading,
                description: scene.description.slice(0, 120) + (scene.description.length > 120 ? '…' : ''),
              }));
            } catch (dbErr) {
              console.error('[scenes] DB insert error:', dbErr);
            }
          }
        }
      } catch (err) {
        if (!streamClosed) safeEnqueue(sseNamedEvent('error', { message: String(err) }));
      } finally {
        streamClosed = true;
        clearInterval(keepAlive);
        // Final attempt to parse any remaining complete blocks in the buffer
        while (true) {
          const endIdx = accumulated.indexOf('<<<END>>>');
          if (endIdx === -1) break;
          const startIdx = accumulated.lastIndexOf('<<<SCENE>>>', endIdx);
          if (startIdx === -1) break;

          const block = accumulated.substring(startIdx + 11, endIdx);
          accumulated = accumulated.substring(endIdx + 9);

          const scene = parseSceneBlock(block, parsedCount + 1);
          if (!scene) {
            console.warn('[scenes] Unable to parse trailing scene block, skipping.');
            continue;
          }

          parsedCount++;
          const sceneId = newSceneId();
          try {
            insertScene.run(
              sceneId, projectId, scene.sceneNumber,
              scene.title, scene.heading, scene.description,
              scene.dialogue || null, scene.technicalNotes || null,
              now, now,
            );

            safeEnqueue(sseNamedEvent('scene', {
              sceneId,
              sceneNumber: scene.sceneNumber,
              title: scene.title,
              heading: scene.heading,
              description: scene.description.slice(0, 120) + (scene.description.length > 120 ? '…' : ''),
            }));
          } catch (dbErr) {
            console.error('[scenes] DB insert error (final pass):', dbErr);
          }
        }

        const underfilled = parsedCount > 0 && parsedCount < targetScenes;
        try {
          if (!streamClosed) controller.enqueue(sseNamedEvent('done', { totalScenes: parsedCount, underfilled }));
          controller.close();
        } catch {
          // Client may have disconnected; ignore
        }
      }
    },
  });

  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
