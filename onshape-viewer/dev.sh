#!/usr/bin/env bash
# onshape-viewer/dev.sh — run the backend (:8002) and frontend (:5175) together.
#
# Usage: ./dev.sh    (Ctrl-C stops both)
#
# First-time install is `bash onshape-viewer/setup.sh` from the repo root, or
# `./setup.sh --onshape-viewer`. This script installs missing dependencies as a
# convenience but is not the setup path — it will not fetch system packages.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# Onshape credentials, if present. The server below needs these now: the model
# picker refreshes documents and runs builds through it, so without them those
# endpoints return 503 and the viewer can only show what is already in cache/.
#
# .env is gitignored and setup.sh writes an empty stub. Nothing in the repo ever
# holds a key; if this file is missing, create it and paste in a pair from
# https://dev-portal.onshape.com.
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Checked after sourcing rather than by testing for the file: setup.sh writes a
# stub with blank values, so "the file exists" says nothing about whether the
# keys are usable.
if [ -z "${ONSHAPE_ACCESS_KEY:-}" ] || [ -z "${ONSHAPE_SECRET_KEY:-}" ]; then
  echo ""
  echo "warning: no Onshape credentials, so search and build will return 503."
  echo "Put a key pair from https://dev-portal.onshape.com in onshape-viewer/.env:"
  echo "  ONSHAPE_ACCESS_KEY=..."
  echo "  ONSHAPE_SECRET_KEY=..."
  echo "Already-built models in cache/ still load fine without them."
  echo ""
fi

if [ ! -d ".venv" ]; then
  echo "Creating backend virtualenv..."
  python3 -m venv .venv
fi
PYTHON_CMD="$SCRIPT_DIR/.venv/bin/python3"

if [ ! -x "$SCRIPT_DIR/.venv/bin/uvicorn" ]; then
  echo "Installing backend dependencies..."
  "$PYTHON_CMD" -m pip install --upgrade pip >/dev/null
  "$PYTHON_CMD" -m pip install -r requirements.txt
fi

if [ ! -d "frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  (cd frontend && npm install)
fi

# Count built models, not files: cache/ also holds browse.json (the picker's
# document cache), so a plain emptiness check stopped being meaningful.
if ! ls cache/*/manifest.json >/dev/null 2>&1; then
  echo ""
  echo "warning: no models built yet, so the viewer will have nothing to show."
  echo "Build one from the picker in the header, or from the CLI:"
  echo "  .venv/bin/python -m backend.onshape.build <onshape-assembly-url>"
  echo ""
fi

# Free port 8002 if a previous run left something behind.
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti:8002 2>/dev/null || true)
  [ -n "$PIDS" ] && echo "Freeing port 8002..." && echo "$PIDS" | xargs kill -9 2>/dev/null || true
fi

echo "Starting backend on http://localhost:8002"
"$PYTHON_CMD" -m uvicorn backend.main:app --reload --port 8002 &
BACKEND_PID=$!

echo "Starting frontend on http://localhost:5175"
(cd frontend && npm run dev) &
FRONTEND_PID=$!

wait "$BACKEND_PID" "$FRONTEND_PID"
