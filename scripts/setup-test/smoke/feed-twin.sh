#!/usr/bin/env bash
# Smoke check: feed-twin setup produced a working backend + frontend.
# Runs from the repo root (harness cd's there before invoking).
set -euo pipefail

echo "  → venv exists, on Python 3.11 or newer"
test -d feed-twin/.venv || { echo "  ✗ feed-twin/.venv missing"; exit 1; }
feed-twin/.venv/bin/python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" \
  || { echo "  ✗ feed-twin/.venv is $(feed-twin/.venv/bin/python --version 2>&1); lib/feedtwin needs 3.11+"; exit 1; }

echo "  → the physics core, the document store and the backend import"
(cd feed-twin && .venv/bin/python -c "
import feedtwin, stardesign
import backend.main
print('  ✓ feedtwin', feedtwin.__version__, '+ stardesign + backend.main importable')
")

echo "  → frontend node_modules, and a Node the toolchain takes"
test -d feed-twin/frontend/node_modules || { echo "  ✗ frontend/node_modules missing"; exit 1; }
test -x feed-twin/frontend/node_modules/.bin/vite \
  || { echo "  ✗ vite not present in node_modules"; exit 1; }
node -e '
  const [a, b] = process.versions.node.split(".").map(Number);
  process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1);' \
  || { echo "  ✗ node $(node -v) on PATH; vitest 5 needs 22.12 or newer"; exit 1; }

echo "  → frontend builds"
(cd feed-twin/frontend && npm run build --silent >/dev/null) \
  || { echo "  ✗ npm run build failed in feed-twin/frontend"; exit 1; }

echo "  ✓ feed-twin smoke passed"
