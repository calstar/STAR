#!/usr/bin/env bash
# feed-twin dev stack — FastAPI backend + Vite frontend.
#
# Run ./dev.sh --help for the flags. Same interface in every STAR project.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../scripts/dev_common.sh"

API_PORT="${FEED_TWIN_API_PORT:-8003}"
UI_PORT="${FEED_TWIN_UI_PORT:-5177}"

dev_init feed-twin "$HERE"

dev_preflight() {
  if [ ! -d "$HERE/.venv" ]; then
    echo "  creating backend virtualenv..."
    python3 -m venv "$HERE/.venv"
  fi
  if [ ! -x "$HERE/.venv/bin/uvicorn" ]; then
    echo "  installing backend dependencies..."
    "$HERE/.venv/bin/python3" -m pip install --upgrade pip >/dev/null
    "$HERE/.venv/bin/python3" -m pip install -r "$HERE/requirements.txt"
    # The physics core. Editable, so a change to a correlation shows up on the
    # next request without a reinstall -- which is most of what development on
    # this app actually is.
    "$HERE/.venv/bin/python3" -m pip install -e "$HERE/../lib/feedtwin"
  fi
  if [ ! -d "$HERE/frontend/node_modules" ]; then
    echo "  installing frontend dependencies..."
    (cd "$HERE/frontend" && npm install)
  fi
}

# --reload-dir for the physics core too: it is pip-installed from
# ../lib/feedtwin, so uvicorn does not watch it by default.
dev_pane backend  ".venv/bin/python3 -m uvicorn backend.main:app --reload --reload-dir . --reload-dir ../lib/feedtwin --port $API_PORT"
dev_pane frontend "cd frontend && npm run dev -- --port $UI_PORT"

dev_service Frontend "$UI_PORT"  "http://localhost:$UI_PORT"
dev_service API      "$API_PORT" "http://localhost:$API_PORT/docs"

dev_main "$@"
