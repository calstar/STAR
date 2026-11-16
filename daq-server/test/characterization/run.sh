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
# Processes launched from this checkout that outlive an area's run would pollute the next area's
# captures (LEDGER D33: a straggler simulator once fed PT data into lifecycle's ball-valve capture).
# Under the stack lock nothing else from this checkout runs, so anything matching ROOT is a leak.
leftovers() {
  ps -axo pid=,command= 2>/dev/null | grep -F "$ROOT/" |
    grep -E 'board_simulator|board_startup_sim|daq_bridge|_service|elodin-db|t7_bridge|tsx .*src/server' |
    grep -v -E 'grep|run\.sh|ctest' || true
}
for r in "$HERE"/*/run.sh; do
  [ -f "$r" ] || continue
  area="$(basename "$(dirname "$r")")"
  echo "── $area/run.sh"
  bash "$r" || { echo "   FAILED: $r"; fail=1; }
  left="$(leftovers)"
  if [ -n "$left" ]; then
    echo "   FAILED: $area left processes running after its run:"
    echo "$left" | sed 's/^/     /'
    fail=1
  fi
done
[ "$fail" = 0 ] && echo "CHARACTERIZATION: PASS" || { echo "CHARACTERIZATION: FAIL"; exit 1; }
