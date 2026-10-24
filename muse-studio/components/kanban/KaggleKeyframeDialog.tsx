
'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ImageIcon, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { createKeyframe, updateKeyframeOutput, updateSceneStatus } from '@/lib/actions/scenes';
import { fetchJobFromApi, JOB_POLL_INTERVAL_MS } from '@/lib/jobs/jobPolling';
import type { Keyframe, Scene } from '@/lib/types';

interface KaggleKeyframeDialogProps {
  open: boolean;
  scene: Scene | null;
  onClose: () => void;
  onKeyframeSaved: (sceneId: string, keyframe: Keyframe) => void;
}

type KaggleModel = 'sdxl' | 'juggernaut';

const RATIOS = ['16:9', '9:16', '1:1'] as const;
const MODELS: { id: KaggleModel; label: string }[] = [
  { id: 'sdxl', label: 'SDXL' },
  { id: 'juggernaut', label: 'Juggernaut XL' },
];

const btn = (active: boolean) =>
  cn(
    'flex-1 rounded-lg border px-2 py-1.5 text-xs transition-colors',
    active ? 'border-amber-500/50 bg-amber-500/10 text-amber-300' : 'border-white/10 bg-white/3 hover:bg-white/6',
  );

export function KaggleKeyframeDialog({ open, scene, onClose, onKeyframeSaved }: KaggleKeyframeDialogProps) {
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState<string>('16:9');
  const [model, setModel] = useState<KaggleModel>('sdxl');
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outputPath: string } | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!open || !scene) return;
    setPrompt(scene.keyframes[0]?.generationParams?.prompt?.trim() || scene.description || scene.heading);
    setError(null);
    setResult(null);
    setProgress(null);
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, [open, scene]);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!scene || !prompt.trim()) return;
    setGenerating(true);
    setError(null);
    setResult(null);
    setProgress(null);
    try {
      const res = await fetch('/api/generate/keyframe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene_id: scene.id,
          prompt: prompt.trim(),
          provider_id: 'kaggle_sdxl',
          aspect_ratio: ratio,
          model,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data?.detail ?? data?.error;
        setError(typeof detail === 'string' ? detail : detail?.reason ?? detail?.error ?? 'Kaggle request failed.');
        return;
      }
      setProgress('Kaggle: job queued');
      while (!cancelled.current) {
        await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS.fast));
        const polled = await fetchJobFromApi(data.job_id as string);
        if (!polled.ok) {
          setError(polled.status === 404 ? 'Job lost — backend restarted.' : 'Could not poll job status.');
          return;
        }
        const job = polled.job;
        if (job.status === 'completed' && job.output_path) {
          setResult({ outputPath: job.output_path });
          return;
        }
        if (job.status === 'failed') {
          setError(job.error ?? 'Kaggle generation failed.');
          return;
        }
        setProgress(job.message ?? 'Kaggle: running…');
      }
    } catch {
      setError('Network error. Is the backend running?');
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  }

  async function handleSave() {
    if (!scene || !result) return;
    setSaving(true);
    setError(null);
    try {
      const keyframeId = await createKeyframe({
        sceneId: scene.id,
        source: 'VISUAL_MUSE',
        prompt: prompt.trim(),
        aspectRatio: ratio,
      });
      await updateKeyframeOutput(keyframeId, { draftImagePath: result.outputPath });
      await updateSceneStatus(scene.id, 'KEYFRAME');
      onKeyframeSaved(scene.id, {
        keyframeId,
        sequenceOrder: scene.keyframes.length + 1,
        source: 'VISUAL_MUSE',
        status: 'DRAFT',
        referenceImages: [],
        generationParams: { prompt: prompt.trim(), aspectRatio: ratio },
        draftImage: { id: `${keyframeId}-draft`, url: `/api/outputs/${result.outputPath}`, width: 0, height: 0 },
      });
      onClose();
    } catch {
      setError('Failed to save keyframe.');
    } finally {
      setSaving(false);
    }
  }

  const busy = generating || saving;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-xl max-h-[calc(100dvh-2rem)] overflow-y-auto border-white/10 bg-[oklch(0.13_0.012_264)] p-0">
        <DialogHeader className="border-b border-white/8 px-6 py-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-amber-400" />
            Generate keyframe
          </DialogTitle>
          <DialogDescription className="text-xs">{scene?.title} · SDXL on Kaggle GPU</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleGenerate} className="space-y-5 px-6 py-5">
          <div className="space-y-1.5">
            <label htmlFor="kaggle-keyframe-prompt" className="text-xs font-medium text-muted-foreground">Prompt</label>
            <Textarea
              id="kaggle-keyframe-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              required
              disabled={busy}
              className="resize-y border-white/10 bg-white/5 text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium text-muted-foreground">Aspect ratio</legend>
              <div className="flex gap-1.5">
                {RATIOS.map((item) => (
                  <button key={item} type="button" onClick={() => setRatio(item)} aria-pressed={ratio === item} disabled={busy} className={cn(btn(ratio === item), 'font-mono')}>
                    {item}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium text-muted-foreground">Model</legend>
              <div className="flex gap-1.5">
                {MODELS.map((item) => (
                  <button key={item.id} type="button" onClick={() => setModel(item.id)} aria-pressed={model === item.id} disabled={busy} className={btn(model === item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          {generating && progress && (
            <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/3 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span className="truncate">{progress}</span>
            </div>
          )}
          {result && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/outputs/${result.outputPath}`} alt="Generated keyframe" className="w-full rounded-xl border border-white/10 bg-black/40 object-contain max-h-[50dvh]" />
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p className="break-words">{error}</p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            {result ? (
              <>
                <Button type="submit" variant="outline" disabled={busy || !prompt.trim()} className="gap-2">
                  {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Regenerate
                </Button>
                <Button type="button" onClick={handleSave} disabled={busy} className="gap-2 bg-amber-600 text-white hover:bg-amber-500">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                  Save as keyframe
                </Button>
              </>
            ) : (
              <Button type="submit" disabled={busy || !prompt.trim()} className="gap-2 bg-amber-600 text-white hover:bg-amber-500">
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {generating ? 'Generating…' : 'Generate image'}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
