import { NextRequest, NextResponse } from 'next/server';

const BACKEND = process.env.MUSE_BACKEND_URL ?? 'http://localhost:8000';

/** POST { scene_id, prompt, provider_id, aspect_ratio?, model? } → backend /generate/keyframe (returns job_id). */
export async function POST(req: NextRequest) {
  try {
    const res = await fetch(`${BACKEND}/generate/keyframe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await req.json()),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ detail: 'Backend unreachable' }, { status: 503 });
  }
}
