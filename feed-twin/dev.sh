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
  # lib/feedtwin and lib/stardesign require Python 3.11 or newer, which a bare
  # `python3` is not on every machine (macOS's 3.9, Ubuntu 22.04's 3.10).
  # shellcheck disable=SC1091
  source "$HERE/../scripts/setup_common.sh"
  if [ ! -d "$HERE/.venv" ]; then
    local py
    py="$(python_at_least 11)" || {
      echo "  feed-twin needs Python 3.11 or newer; python3 here is $(python3 --version 2>&1)." >&2
      echo "  Install python3.11 or newer (or run feed-twin/setup.sh) and start again." >&2
      exit 1
    }
    echo "  creating backend virtualenv ($("$py" --version 2>&1))..."
    "$py" -m venv "$HERE/.venv"
  elif ! venv_at_least "$HERE/.venv" 11; then
    echo "  feed-twin/.venv is $("$HERE/.venv/bin/python" --version 2>&1); feed-twin needs 3.11 or newer." >&2
    echo "  Remove feed-twin/.venv and start again to rebuild it." >&2
    exit 1
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
  # The shared design store (stands: sharing, checkout, versions), the one
  # pid-designer and EngineDesign keep their documents in. Checked apart from
  # the venv so an existing venv picks it up too.
  if ! "$HERE/.venv/bin/python3" -c "import stardesign" 2>/dev/null; then
    "$HERE/.venv/bin/python3" -m pip install -e "$HERE/../lib/stardesign"
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
