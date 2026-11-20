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
# The ctest half runs for the areas that declare one (an area's CMakeLists.txt), selected by the
# anchored test name (`char_<area>_*`, `characterization_<area>_*`): a bare `-R pipeline` also
# matched char_packets_pipeline_decode. "No tests were found" used to exit 0, so a label or a
# build that had lost its tests passed silently; it is an error now (LEDGER D61d).
ctest_areas=""
for d in "$HERE"/*/CMakeLists.txt; do
  a="$(basename "$(dirname "$d")")"
  if [ -z "${CHAR_AREAS:-}" ] || [[ ",${CHAR_AREAS}," == *",$a,"* ]]; then ctest_areas="${ctest_areas:+$ctest_areas|}$a"; fi
done
if [ -z "$ctest_areas" ]; then
  echo "── ctest -L characterization: no area in '${CHAR_AREAS:-}' declares a ctest; skipped"
else
  echo "── ctest -L characterization ($BUILD) -R '^(char|characterization)_($ctest_areas)_'"
  (cd "$BUILD" && ctest -L characterization -R "^(char|characterization)_($ctest_areas)_" --no-tests=error --output-on-failure) || fail=1
fi
# Processes launched from this checkout that outlive an area's run would pollute the next area's
# captures (LEDGER D33: a straggler simulator once fed PT data into lifecycle's ball-valve capture).
# Under the stack lock nothing else from this checkout runs, so anything matching ROOT is a leak.
leftovers() {
  ps -axo pid=,command= 2>/dev/null | grep -F "$ROOT/" |
    grep -E 'board_simulator|board_startup_sim|daq_bridge|_service|elodin-db|t7_bridge|tsx .*src/server' |
    grep -v -E 'grep|run\.sh|ctest' || true
}
# A socket held by a reparented or renamed child does not match by path, so the test ports are
# checked too: the stand's fixed ports, the integration test's and every area's private range.
TEST_PORTS='^(2240|2241|3232|5005|5006|5007|5008|5014|5015|5016|8081|8181|8182|8192|9997|9998|9999|26[3-5][0-9][0-9])$'
leftover_ports() {
  command -v lsof >/dev/null || return 0
  lsof -nP -iTCP -sTCP:LISTEN -iUDP 2>/dev/null | awk 'NR>1 {n=$9; sub(/.*:/,"",n); print n" "$1" pid="$2}' |
    while read -r port rest; do [[ "$port" =~ $TEST_PORTS ]] && echo "port $port held by $rest"; done | sort -u
}
# CHAR_AREAS="a,b": run only these areas' run.sh (in this order); empty runs every area.
for r in "$HERE"/*/run.sh; do
  [ -f "$r" ] || continue
  area="$(basename "$(dirname "$r")")"
  if [ -n "${CHAR_AREAS:-}" ] && [[ ",${CHAR_AREAS}," != *",$area,"* ]]; then continue; fi
  echo "── $area/run.sh"
  bash "$r" || { echo "   FAILED: $r"; fail=1; }
  left="$(leftovers; leftover_ports)"
  if [ -n "$left" ]; then
    echo "   FAILED: $area left processes running after its run:"
    echo "$left" | sed 's/^/     /'
    fail=1
  fi
done
[ "$fail" = 0 ] && echo "CHARACTERIZATION: PASS" || { echo "CHARACTERIZATION: FAIL"; exit 1; }
