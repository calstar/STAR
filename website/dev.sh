#!/usr/bin/env bash
# Public website dev server (Vite).
#
# Run ./dev.sh --help for the flags. Same interface in every STAR project.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../scripts/dev_common.sh"

# 5176 so this can run alongside EngineDesign (5173), pid-designer (5174),
# and landing (5175).
UI_PORT="${WEBSITE_UI_PORT:-5176}"

dev_init website "$HERE"

dev_preflight() {
  if [ ! -d "$HERE/node_modules" ]; then
    echo "  installing dependencies..."
    (cd "$HERE" && npm install)
  fi
}

dev_pane frontend "npm run dev -- --port $UI_PORT"

dev_service Website "$UI_PORT" "http://localhost:$UI_PORT"

dev_main "$@"
