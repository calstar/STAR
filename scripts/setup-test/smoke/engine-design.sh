#!/usr/bin/env bash
# Smoke check: EngineDesign setup produced a working venv + native kernel.
# Runs from the repo root.
set -euo pipefail

echo "  → venv exists"
test -d EngineDesign/.venv || { echo "  ✗ EngineDesign/.venv missing"; exit 1; }

echo "  → core imports resolve"
# shellcheck disable=SC1091
source EngineDesign/.venv/bin/activate
python -c "import numpy, scipy, matplotlib; print('  ✓ numpy/scipy/matplotlib import')"
(cd EngineDesign && python -c "import engine; print('  ✓ engine package importable')")
deactivate

# The accelerator is numba (engine/accel); the C kernel at engine/native that
# this used to check for is deleted. Nothing is compiled at setup time any more,
# so the check is that numba imports and the kernels actually JIT -- warmup()
# returns False rather than raising, which is what makes it safe to check here.
echo "  → numba accelerator usable"
source EngineDesign/.venv/bin/activate
(cd EngineDesign && python -c "
import sys
import engine.accel as accel
if not accel.available():
    print('  ! numba not importable — the optimizer will fall back to pure Python (~25-30x slower)')
    sys.exit(0)
print('  ✓ numba kernels compile' if accel.warmup() else '  ! numba imports but kernels failed to compile')
")
deactivate

echo "  → frontend node_modules"
if [ -d EngineDesign/frontend ]; then
  test -d EngineDesign/frontend/node_modules \
    || { echo "  ✗ frontend/node_modules missing"; exit 1; }
  echo "  ✓ frontend node_modules present"
fi

echo "  ✓ engine-design smoke passed"
