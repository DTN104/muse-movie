'use client';

import { useCallback, useEffect, useState } from 'react';
import { ScrollText, Loader2, CheckCircle2, XCircle, Clock, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { JobResult } from '@/lib/backend-client';

const REFRESH_MS = 5000;

const STATUS: Record<JobResult['status'], { label: string; cls: string; Icon: typeof Clock }> = {
  queued: { label: 'Queued', cls: 'text-muted-foreground border-white/15', Icon: Clock },
  running: { label: 'Running', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10', Icon: Loader2 },
  completed: { label: 'Done', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10', Icon: CheckCircle2 },
  failed: { label: 'Failed', cls: 'text-red-300 border-red-500/40 bg-red-500/10', Icon: XCircle },
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Header button + side panel showing recent generation jobs (video/keyframe) with their full error text. */
export function JobLogPanel() {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<JobResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/jobs?limit=30', { cache: 'no-store' });
      const data = await res.json();
      setUnreachable(!res.ok);
      setJobs(Array.isArray(data?.jobs) ? (data.jobs as JobResult[]) : []);
    } catch {
      setUnreachable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll while the panel is open; one light fetch on mount so the badge reflects the latest job.
  useEffect(() => {
    void load();
    if (!open) return;
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [open, load]);

  const latest = jobs[0];
  const running = jobs.some((j) => j.status === 'running' || j.status === 'queued');

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="ml-2 h-8 border-white/15 bg-white/5 text-xs text-muted-foreground hover:bg-white/10 hover:text-foreground relative"
        title="Generation logs"
      >
        {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ScrollText className="mr-1.5 h-3.5 w-3.5" />}
        Logs
        {latest?.status === 'failed' && (
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-background" aria-label="Latest job failed" />
        )}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-xl border-white/10 bg-[oklch(0.13_0.012_264)] p-0 flex flex-col">
          <SheetHeader className="border-b border-white/8 px-5 py-4">
            <SheetTitle className="flex items-center gap-2 text-base">
              <ScrollText className="h-4 w-4 text-amber-400" />
              Generation logs
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void load()}
                disabled={loading}
                className="ml-auto h-7 px-2 text-xs text-muted-foreground"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </Button>
            </SheetTitle>
            <SheetDescription className="text-xs">
              Backend jobs (video &amp; keyframe), newest first · refreshes every {REFRESH_MS / 1000}s while open.
              Full provider messages are shown here even after the toast disappears.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {unreachable && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                Backend unreachable — is <code className="font-mono">run.py</code> running on port 8000?
              </p>
            )}
            {!unreachable && jobs.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No jobs since the backend started. (The job list is in-memory: a backend restart clears it.)
              </p>
            )}
            {jobs.map((job) => {
              const s = STATUS[job.status] ?? STATUS.queued;
              const Icon = s.Icon;
              return (
                <article
                  key={job.job_id}
                  className="rounded-xl border border-white/8 bg-white/3 px-4 py-3 space-y-2 text-xs"
                >
                  <header className="flex flex-wrap items-center gap-2">
                    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium', s.cls)}>
                      <Icon className={cn('h-3 w-3', job.status === 'running' && 'animate-spin')} />
                      {s.label}
                      {job.status === 'running' && typeof job.progress_percent === 'number' && ` ${job.progress_percent}%`}
                    </span>
                    <span className="font-mono text-foreground/80">{job.provider_id}</span>
                    <span className="text-muted-foreground">{fmtTime(job.created_at)}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">{job.job_id}</span>
                  </header>
                  {job.scene_id && (
                    <p className="text-[11px] text-muted-foreground">
                      Scene <span className="font-mono">{job.scene_id}</span>
                    </p>
                  )}
                  {job.message && job.status !== 'failed' && (
                    <p className="text-muted-foreground break-words">{job.message}</p>
                  )}
                  {job.error && (
                    <pre className="whitespace-pre-wrap break-words rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 font-sans text-red-200/90">
                      {job.error}
                    </pre>
                  )}
                  {job.output_path && (
                    <a
                      href={`/api/outputs/${job.output_path}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-block font-mono text-[11px] text-emerald-300 hover:underline break-all"
                    >
                      {job.output_path}
                    </a>
                  )}
                </article>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
