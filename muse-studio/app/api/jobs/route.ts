import { NextRequest, NextResponse } from 'next/server';

const BACKEND = process.env.MUSE_BACKEND_URL ?? 'http://localhost:8000';

// Runtime-only polling endpoint — never statically generated.
export const dynamic = 'force-dynamic';

/** GET /api/jobs?limit=30 → backend /jobs (recent generation jobs, newest first). */
export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 30) || 30;
  try {
    const res = await fetch(`${BACKEND}/jobs?limit=${Math.min(limit, 100)}`, { cache: 'no-store' });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ jobs: [], total: 0, error: 'Backend unreachable' }, { status: 503 });
  }
}
