#!/bin/bash
# Run the whole characterization suite: the ctest half (label "characterization") and every
# area's run.sh (the halves that need node, python or a running stack). Exit non-zero on any
# failure. CHAR_UPDATE=1 rewrites goldens — only on main's behaviour, never to make a change pass.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
BUILD="${CHAR_BUILD_DIR:-}"
if [ -z "$BUILD" ]; then
  for b in "$ROOT/build-gate" "$ROOT/build"; do [ -f "$b/CTestTestfile.cmake" ] && BUILD="$b" && break; done
fi
[ -n "$BUILD" ] || { echo "run.sh: no build dir; run scripts/build.sh first" >&2; exit 2; }
export CHAR_BUILD_DIR="$BUILD"
fail=0
echo "── stack lock self-test"
bash "$HERE/test_stack_lock.sh" || fail=1
echo "── ctest -L characterization ($BUILD)"
(cd "$BUILD" && ctest -L characterization --output-on-failure) || fail=1
for r in "$HERE"/*/run.sh; do
  [ -f "$r" ] || continue
  echo "── $(basename "$(dirname "$r")")/run.sh"
  bash "$r" || { echo "   FAILED: $r"; fail=1; }
done
[ "$fail" = 0 ] && echo "CHARACTERIZATION: PASS" || { echo "CHARACTERIZATION: FAIL"; exit 1; }
