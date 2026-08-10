#!/usr/bin/env bash
# Auth service dev server.
#
# Only needed when working on the login flow itself -- the other projects' dev
# stacks are unauthenticated, because nothing calls /verify without Caddy.
#
# Needs auth/.env with real Google OAuth credentials, and
# http://localhost:5000/callback registered as an authorized redirect URI.
#
# Run ./dev.sh --help for the flags. Same interface in every STAR project.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../scripts/dev_common.sh"

PORT="${AUTH_PORT:-5000}"

dev_init auth "$HERE"

dev_preflight() {
  if [ ! -f "$HERE/.env" ]; then
    echo "  ❌ auth/.env is missing. Copy auth/.env.example and fill it in." >&2
    exit 1
  fi
  if [ ! -d "$HERE/.venv" ]; then
    echo "  creating virtualenv..."
    python3 -m venv "$HERE/.venv"
  fi
  if [ ! -x "$HERE/.venv/bin/flask" ]; then
    echo "  installing dependencies..."
    "$HERE/.venv/bin/python3" -m pip install --upgrade pip >/dev/null
    "$HERE/.venv/bin/python3" -m pip install -r "$HERE/requirements-dev.txt"
  fi
}

# --app main: bare `flask run` looks for app.py / wsgi.py and would not find it.
dev_pane auth ".venv/bin/flask --app main run --debug --port $PORT"

dev_service Auth "$PORT" "http://localhost:$PORT/"

dev_main "$@"
