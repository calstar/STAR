#!/usr/bin/env bash
# Landing page dev server (Vite).
#
# Run ./dev.sh --help for the flags. Same interface in every STAR project.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../scripts/dev_common.sh"

# 5175 so this can run alongside EngineDesign (5173) and pid-designer (5174).
UI_PORT="${LANDING_UI_PORT:-5175}"

dev_init landing "$HERE"

dev_preflight() {
  if [ ! -d "$HERE/node_modules" ]; then
    echo "  installing dependencies..."
    (cd "$HERE" && npm install)
  fi
}

dev_pane frontend "npm run dev -- --port $UI_PORT"

dev_service Landing "$UI_PORT" "http://localhost:$UI_PORT"

dev_main "$@"
