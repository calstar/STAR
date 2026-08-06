#!/usr/bin/env bash
# Smoke check: onshape-viewer setup produced a working backend + frontend.
# Runs from the repo root (harness cd's there before invoking).
#
# Deliberately does not touch the Onshape API. The viewer's whole test suite is
# fixture-backed for the same reason: calls are billed against a finite quota,
# and a setup check should cost nothing.
set -euo pipefail

echo "  → venv exists"
test -d onshape-viewer/.venv || { echo "  ✗ onshape-viewer/.venv missing"; exit 1; }

echo "  → backend imports"
# shellcheck disable=SC1091
source onshape-viewer/.venv/bin/activate
(cd onshape-viewer && python -c "from backend.main import app; print('  ✓ backend.main.app importable')")

# The build pipeline's own dependencies, which the FastAPI app does not pull in
# on its own — a venv that can serve cached artifacts but cannot write a GLB is
# a half-finished install.
(cd onshape-viewer && python -c "import httpx, numpy, pygltflib; print('  ✓ httpx/numpy/pygltflib import')")
deactivate

echo "  → frontend node_modules"
test -d onshape-viewer/frontend/node_modules \
  || { echo "  ✗ frontend/node_modules missing"; exit 1; }
test -x onshape-viewer/frontend/node_modules/.bin/vite \
  || { echo "  ✗ vite not present in node_modules"; exit 1; }

echo "  → credentials stub present (not filled in — that's the user's job)"
if [ -f onshape-viewer/.env ]; then
  echo "  ✓ onshape-viewer/.env exists"
else
  echo "  ! onshape-viewer/.env missing — builds will fail until it is created"
fi

echo "  ✓ onshape-viewer smoke passed"
