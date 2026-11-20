#!/bin/bash
# Calibration characterization, the halves ctest does not run:
#   ts     backend calibration TypeScript (calibration.ts, calibration-handler.ts, lc-tare.ts,
#          ball-valve-cal.ts, routes/calibration-profiles.ts) via npx tsx -> golden/ts.txt
#   stack  build/bin/calibration_service against a stand-in Elodin on 127.0.0.1, fed a scripted
#          raw-sample and command stream -> golden/stack.txt
# The C++ library / service-function goldens are ctest's (CMakeLists.txt here).
#
# CHAR_UPDATE=1 rewrites the goldens (only ever on main's behaviour). Off the stand only; the
# stack half binds a port, so it runs under the machine-wide stack lock (re-entrant).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../../.." && pwd -P)"
BUILD="${CHAR_BUILD_DIR:-}"
if [ -z "$BUILD" ]; then
  for b in "$ROOT/build-gate" "$ROOT/build"; do [ -f "$b/CMakeCache.txt" ] && BUILD="$b" && break; done
fi
[ -n "$BUILD" ] && [ -x "$BUILD/bin/calibration_service" ] ||
  { echo "calibration/run.sh: no built calibration_service (run scripts/build.sh)" >&2; exit 2; }

fail=0
run() {
  local name="$1"; shift
  local t0=$SECONDS rc
  "$@"
  rc=$?
  case "$rc" in
    0) echo "   calibration/$name: ok ($((SECONDS - t0))s)" ;;
    *) echo "   calibration/$name: FAILED"; fail=1 ;;
  esac
}

ts_half() {
  [ -d "$ROOT/diablo_server/backend/node_modules" ] ||
    { echo "calibration/run.sh: diablo_server/backend has no node_modules (npm ci)" >&2; return 1; }
  # The modules' console chatter goes to a log, shown only when the half fails.
  local log rc
  log="$(mktemp "${TMPDIR:-/tmp}/char_cal_ts.XXXXXX")"
  (cd "$ROOT/diablo_server/backend" &&
    bash "$HERE/check_golden.sh" "$HERE/golden/ts.txt" \
      npx --no-install tsx "$HERE/ts_harness.mts" "$HERE/fixtures") 2> "$log"
  rc=$?
  [ "$rc" = 0 ] || tail -n 150 "$log" >&2
  rm -f "$log"
  return "$rc"
}

stack_half() {
  bash "$ROOT/test/characterization/with_stack_lock.sh" \
    bash "$HERE/check_golden.sh" "$HERE/golden/stack.txt" \
      python3 "$HERE/service_run.py" --cal "$BUILD/bin/calibration_service" --fixtures "$HERE/fixtures"
}

run ts ts_half
run stack stack_half
exit "$fail"
