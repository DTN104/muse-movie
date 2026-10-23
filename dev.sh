#!/usr/bin/env bash
# Run Muse backend + frontend together in one terminal (macOS/Linux).
# Ctrl+C stops both.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  echo ""
  echo "Stopping servers..."
  kill 0 2>/dev/null
}
trap cleanup INT TERM EXIT

# Backend
(
  cd "$ROOT/muse_backend"
  source .venv/bin/activate
  uvicorn app.main:app --reload --port 8000 2>&1 | sed -u 's/^/[backend]  /'
) &

# Frontend
(
  cd "$ROOT/muse-studio"
  npm run dev 2>&1 | sed -u 's/^/[frontend] /'
) &

echo "Backend:  http://localhost:8000  (docs: /docs)"
echo "Frontend: http://localhost:3000"
wait
