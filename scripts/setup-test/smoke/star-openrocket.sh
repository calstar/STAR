#!/usr/bin/env bash
# Smoke check: star-openrocket setup produced a working backend + frontend.
# Runs from the repo root (harness cd's there before invoking).
#
# Deliberately does not touch the Onshape API. The viewer's whole test suite is
# fixture-backed for the same reason: calls are billed against a finite quota,
# and a setup check should cost nothing.
set -euo pipefail

echo "  → venv exists"
test -d star-openrocket/.venv || { echo "  ✗ star-openrocket/.venv missing"; exit 1; }

echo "  → backend imports"
# shellcheck disable=SC1091
source star-openrocket/.venv/bin/activate
(cd star-openrocket && python -c "from backend.main import app; print('  ✓ backend.main.app importable')")

# The build pipeline's own dependencies, which the FastAPI app does not pull in
# on its own — a venv that can serve cached artifacts but cannot write a GLB is
# a half-finished install.
(cd star-openrocket && python -c "import httpx, numpy, pygltflib; print('  ✓ httpx/numpy/pygltflib import')")
deactivate

echo "  → frontend node_modules"
test -d star-openrocket/frontend/node_modules \
  || { echo "  ✗ frontend/node_modules missing"; exit 1; }
test -x star-openrocket/frontend/node_modules/.bin/vite \
  || { echo "  ✗ vite not present in node_modules"; exit 1; }

echo "  → credentials stub present (not filled in — that's the user's job)"
if [ -f star-openrocket/.env ]; then
  echo "  ✓ star-openrocket/.env exists"
else
  echo "  ! star-openrocket/.env missing — builds will fail until it is created"
fi

echo "  ✓ star-openrocket smoke passed"
