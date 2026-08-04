#!/usr/bin/env bash
# EngineDesign dev stack — FastAPI backend + Vite frontend.
#
# Run ./dev.sh --help for the flags. Same interface in every STAR project.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../scripts/dev_common.sh"

# Ports are declared, not hardcoded deep in a command line -- override to run
# two checkouts side by side, or to dodge something already on the port.
API_PORT="${ENGINE_DESIGN_API_PORT:-8000}"
UI_PORT="${ENGINE_DESIGN_UI_PORT:-5173}"

dev_init engine-design "$HERE"

dev_preflight() {
  if [ ! -d "$HERE/frontend/node_modules" ]; then
    echo "  installing frontend dependencies..."
    (cd "$HERE/frontend" && npm install)
  fi
}

# Prefer the project virtualenv when there is one.
PYTHON_BIN="python3"
[ -x "$HERE/.venv/bin/python3" ] && PYTHON_BIN="$HERE/.venv/bin/python3"

dev_pane backend "$(printf '%q' "$PYTHON_BIN") -m uvicorn backend.main:app --reload --port $API_PORT"

# LIBGL_ALWAYS_SOFTWARE quiets MESA/OpenGL spam under WSL2; the grep drops what
# is left. Harmless noise, but it buries real output in the pane.
dev_pane frontend "export LIBGL_ALWAYS_SOFTWARE=1
cd frontend && npm run dev -- --port $UI_PORT 2>&1 | grep -v 'MESA\|ZINK\|glx\|drisw'"

dev_service Frontend "$UI_PORT"  "http://localhost:$UI_PORT"
dev_service API      "$API_PORT" "http://localhost:$API_PORT/docs"

dev_main "$@"
