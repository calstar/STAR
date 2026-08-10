#!/usr/bin/env bash
# P&ID Designer dev stack — FastAPI backend + Vite frontend.
#
# Run ./dev.sh --help for the flags. Same interface in every STAR project.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../scripts/dev_common.sh"

API_PORT="${PID_DESIGNER_API_PORT:-8001}"
UI_PORT="${PID_DESIGNER_UI_PORT:-5174}"

dev_init pid-designer "$HERE"

dev_preflight() {
  if [ ! -d "$HERE/.venv" ]; then
    echo "  creating backend virtualenv..."
    python3 -m venv "$HERE/.venv"
  fi
  if [ ! -x "$HERE/.venv/bin/uvicorn" ]; then
    echo "  installing backend dependencies..."
    "$HERE/.venv/bin/python3" -m pip install --upgrade pip >/dev/null
    "$HERE/.venv/bin/python3" -m pip install -r "$HERE/requirements.txt"
  fi
  if [ ! -d "$HERE/frontend/node_modules" ]; then
    echo "  installing frontend dependencies..."
    (cd "$HERE/frontend" && npm install)
  fi
}

dev_pane backend  ".venv/bin/python3 -m uvicorn backend.main:app --reload --port $API_PORT"
dev_pane frontend "cd frontend && npm run dev -- --port $UI_PORT"

dev_service Frontend "$UI_PORT"  "http://localhost:$UI_PORT"
dev_service API      "$API_PORT" "http://localhost:$API_PORT/docs"

dev_main "$@"
