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

# Create and populate a local Python virtualenv for the backend if needed.
if [ ! -d ".venv" ]; then
  echo "Creating backend virtualenv..."
  python3 -m venv .venv
fi
PYTHON_CMD="$SCRIPT_DIR/.venv/bin/python3"

# Install backend deps if uvicorn isn't present in the venv yet.
if [ ! -x "$SCRIPT_DIR/.venv/bin/uvicorn" ]; then
  echo "Installing backend dependencies..."
  "$PYTHON_CMD" -m pip install --upgrade pip >/dev/null
  "$PYTHON_CMD" -m pip install -r backend/requirements.txt
fi

# Install frontend deps if needed
if [ ! -d "frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  (cd frontend && npm install)
fi

# Free port 8001 if a previous run left something behind.
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti:8001 2>/dev/null || true)
  [ -n "$PIDS" ] && echo "Freeing port 8001..." && echo "$PIDS" | xargs kill -9 2>/dev/null || true
fi

echo "Starting backend on http://localhost:8001"
"$PYTHON_CMD" -m uvicorn backend.main:app --reload --port 8001 &
BACKEND_PID=$!

echo "Starting frontend on http://localhost:5174"
(cd frontend && npm run dev) &
FRONTEND_PID=$!

wait "$BACKEND_PID" "$FRONTEND_PID"
