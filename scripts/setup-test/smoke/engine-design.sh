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

echo "  → native kernel built"
NATIVE_BUILD="EngineDesign/engine/native/build"
if [ -d "$NATIVE_BUILD" ]; then
  # Any .so / .dylib or executable is a good sign the cmake build did something.
  if ! find "$NATIVE_BUILD" \( -name '*.so' -o -name '*.dylib' -o -name '*.a' \) | grep -q .; then
    echo "  ! no shared/static libs found under $NATIVE_BUILD — build may have been skipped"
  else
    echo "  ✓ native artifacts present"
  fi
else
  echo "  ! $NATIVE_BUILD missing (--no-native was passed?)"
fi

echo "  → frontend node_modules"
if [ -d EngineDesign/frontend ]; then
  test -d EngineDesign/frontend/node_modules \
    || { echo "  ✗ frontend/node_modules missing"; exit 1; }
  echo "  ✓ frontend node_modules present"
fi

echo "  ✓ engine-design smoke passed"
