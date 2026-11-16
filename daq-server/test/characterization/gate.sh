#!/bin/bash
# The backend-remastered gate: everything a package must pass before it merges.
#
#   bash test/characterization/gate.sh            # full gate (integration under the stack lock)
#   bash test/characterization/gate.sh --fast     # skip the full-stack integration run
#
# Steps: clean build in build-gate/ with no compiler warning outside the baseline list, ctest
# (unit + characterization), backend and frontend vitest, frontend lint and vite build, shared
# types in sync, the characterization goldens, test_integration.sh (58/58) and format --check.
# Off the stand only: see daq-server/CLAUDE.md.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
REPO="$(cd "$ROOT/.." && pwd -P)"
CHAR="$ROOT/test/characterization"
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

if [ "$(hostname)" = "star-rfs" ] || { command -v ip >/dev/null && ip -4 -o addr | grep -q ' 192\.168\.2\.'; } \
  || ifconfig 2>/dev/null | grep -q 'inet 192\.168\.2\.'; then
  echo "gate: this is the stand (star-rfs / board LAN). Refusing to run." >&2
  exit 3
fi

LOG="$ROOT/.tmp/gate"
mkdir -p "$LOG"
fails=()
step() {
  local name="$1"; shift
  printf '── %-28s ' "$name"
  if "$@" > "$LOG/$name.log" 2>&1; then echo ok; else echo "FAIL (see .tmp/gate/$name.log)"; fails+=("$name"); fi
}

# Warnings are compared without line numbers so a moved line is not a new warning.
build_clean() {
  rm -rf "$ROOT/build-gate"
  cmake -S "$ROOT" -B "$ROOT/build-gate" -Wno-dev -DCMAKE_BUILD_TYPE=Release &&
    cmake --build "$ROOT/build-gate" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tee "$LOG/build-output.txt"
  [ "${PIPESTATUS[0]}" = 0 ] || return 1
  grep -E 'warning:' "$LOG/build-output.txt" |
    sed -E "s#^$ROOT/##; s#^$REPO/#../#; s#:[0-9]+:[0-9]+: warning:#: warning:#" | sort -u > "$LOG/warnings.txt"
  local new
  new="$(comm -13 "$CHAR/baseline_warnings.txt" "$LOG/warnings.txt")"
  [ -z "$new" ] || { echo "NEW WARNINGS:"; echo "$new"; return 1; }
}
ctest_all() { (cd "$ROOT/build-gate" && ctest --output-on-failure -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"); }
backend_vitest() { (cd "$ROOT/diablo_server/backend" && npm test); }
frontend_vitest() { (cd "$ROOT/diablo_server/frontend" && npm test); }
frontend_lint() { (cd "$ROOT/diablo_server/frontend" && npm run lint); }
frontend_build() { (cd "$ROOT/diablo_server/frontend" && npm run test:build); }
shared_types() {
  (cd "$ROOT/diablo_server/frontend" && npm run build:shared) &&
    git -C "$ROOT" diff --exit-code -- diablo_server/shared/
}
characterization() { bash "$CHAR/run.sh"; }
integration() { bash "$CHAR/with_stack_lock.sh" bash "$ROOT/test/test_integration.sh"; }
format_check() {
  local cf="${CLANG_FORMAT_19_DIR:-}"
  (cd "$REPO" && PATH="${cf:+$cf:}$PATH" ./format.sh --check)
}

step build build_clean
step ctest ctest_all
step backend-vitest backend_vitest
step frontend-vitest frontend_vitest
step frontend-lint frontend_lint
step frontend-build frontend_build
step shared-types shared_types
[ -x "$CHAR/run.sh" ] || [ -f "$CHAR/run.sh" ] && step characterization characterization
[ "$FAST" = 1 ] || step integration integration
step format format_check

echo
if [ ${#fails[@]} -eq 0 ]; then echo "GATE: PASS"; else echo "GATE: FAIL — ${fails[*]}"; exit 1; fi
