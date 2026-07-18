#!/usr/bin/env bash
# Smoke check: pid-designer setup produced a working backend + frontend.
# Runs from the repo root (harness cd's there before invoking).
set -euo pipefail

echo "  → venv exists"
test -d pid-designer/.venv || { echo "  ✗ pid-designer/.venv missing"; exit 1; }

echo "  → backend imports"
# shellcheck disable=SC1091
source pid-designer/.venv/bin/activate
(cd pid-designer && python -c "from backend.main import app; print('  ✓ backend.main.app importable')")
deactivate

echo "  → frontend node_modules"
test -d pid-designer/frontend/node_modules || { echo "  ✗ frontend/node_modules missing"; exit 1; }
test -x pid-designer/frontend/node_modules/.bin/vite \
  || { echo "  ✗ vite not present in node_modules"; exit 1; }

echo "  ✓ pid-designer smoke passed"
