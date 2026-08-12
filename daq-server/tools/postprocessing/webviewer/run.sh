#!/bin/bash
# Launch the Elodin past-run web viewer locally (backend + frontend dev server).
#
# Usage:
#   ./run.sh              # dev: uvicorn :8420 (reload) + vite :5273
#   ./run.sh --build      # build frontend, then serve everything from uvicorn :8420
#
# Env:
#   ELODIN_DB_DIR       DB location (default ~/.local/share/elodin)
#   WEBVIEWER_CACHE_DIR parquet cache (default ./.cache)
#   PORT                backend port (default 8420)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-8420}"
VENV="$SCRIPT_DIR/.venv"

# ── Backend venv ──────────────────────────────────────────────────────────────
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "📦 Creating backend venv…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r backend/requirements.txt
fi

# ── Build mode: single-process (uvicorn serves built frontend) ────────────────
if [[ "${1:-}" == "--build" ]]; then
  echo "🏗️  Building frontend…"
  (cd frontend && { [[ -d node_modules ]] || npm install; } && npm run build)
  # Deployment cap: pace CSV downloads so a big export can't saturate the box
  # uplink. Local dev (non-build mode) stays unthrottled. Override as needed.
  export WEBVIEWER_MAX_DOWNLOAD_BPS="${WEBVIEWER_MAX_DOWNLOAD_BPS:-10485760}"  # 10 MB/s
  echo "🚀 Serving on http://localhost:$PORT  (download cap ${WEBVIEWER_MAX_DOWNLOAD_BPS} B/s)"
  exec "$VENV/bin/uvicorn" backend.main:app --host 0.0.0.0 --port "$PORT"
fi

# ── Dev mode: backend + vite ──────────────────────────────────────────────────
echo "🚀 Backend  → http://localhost:$PORT"
"$VENV/bin/uvicorn" backend.main:app --reload --port "$PORT" &
BACK=$!
trap 'kill $BACK 2>/dev/null' INT TERM EXIT

cd frontend
[[ -d node_modules ]] || npm install
echo "🌐 Frontend → http://localhost:5273  (open this one)"
npm run dev
