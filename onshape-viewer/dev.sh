#!/usr/bin/env bash
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

# Onshape credentials, if present. Only the build step needs them -- the server
# started below never talks to Onshape.
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
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

if [ -z "$(ls -A cache 2>/dev/null)" ]; then
  echo ""
  echo "warning: cache/ is empty, so the viewer will have nothing to show."
  echo "Build a model first:"
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
