#!/usr/bin/env bash
# openrocket-web dev stack — FastAPI backend (the OpenRocket port) + Vite frontend.
#
# Run ./dev.sh --help for the flags. Same interface in every STAR project.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../scripts/dev_common.sh"

API_PORT="${OPENROCKET_WEB_API_PORT:-8004}"
UI_PORT="${OPENROCKET_WEB_UI_PORT:-5178}"

dev_init openrocket-web "$HERE"

dev_preflight() {
  # shellcheck disable=SC1091
  source "$HERE/../scripts/setup_common.sh"
  if [ ! -d "$HERE/.venv" ]; then
    local py
    py="$(python_at_least 11)" || {
      echo "  openrocket-web needs Python 3.11 or newer; python3 here is $(python3 --version 2>&1)." >&2
      exit 1
    }
    echo "  creating backend virtualenv ($("$py" --version 2>&1))..."
    "$py" -m venv "$HERE/.venv"
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

dev_pane backend  ".venv/bin/python3 -m uvicorn backend.main:app --reload --reload-dir . --port $API_PORT"
dev_pane frontend "cd frontend && npm run dev -- --port $UI_PORT"

dev_service Frontend "$UI_PORT"  "http://localhost:$UI_PORT"
dev_service API      "$API_PORT" "http://localhost:$API_PORT/docs"

dev_main "$@"
