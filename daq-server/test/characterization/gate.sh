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
# The gate is the merge queue: it jumps ordinary stack-lock waiters (see with_stack_lock.sh).
export DAQ_STACK_LOCK_PRIORITY="${DAQ_STACK_LOCK_PRIORITY:-1}"

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
# ctest binds real UDP ports (BoardListener), so it shares the stack lock with the integration run.
# Tests that fail on main on this machine are listed in baseline_ctest_failures.txt (see LEDGER);
# any other failure fails the gate.
ctest_all() {
  (cd "$ROOT/build-gate" && bash "$CHAR/with_stack_lock.sh" ctest --output-on-failure -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)") > "$LOG/ctest-output.txt" 2>&1
  local rc=$? new
  cat "$LOG/ctest-output.txt"
  [ "$rc" = 0 ] && return 0
  new="$(sed -n '/The following tests FAILED/,$p' "$LOG/ctest-output.txt" | sed -nE 's/^[[:space:]]*[0-9]+ - ([^ ]+) .*/\1/p' |
    sort -u | comm -23 - <(sort -u "$CHAR/baseline_ctest_failures.txt"))"
  grep -q 'The following tests FAILED' "$LOG/ctest-output.txt" || { echo "ctest failed without a test list"; return 1; }
  [ -z "$new" ] || { echo "NEW CTEST FAILURES:"; echo "$new"; return 1; }
  echo "(only baseline-known failures: $(tr '\n' ' ' < "$CHAR/baseline_ctest_failures.txt"))"
}
backend_vitest() { (cd "$ROOT/diablo_server/backend" && npm test); }
frontend_vitest() { (cd "$ROOT/diablo_server/frontend" && npm test); }
frontend_lint() { (cd "$ROOT/diablo_server/frontend" && npm run lint); }
frontend_build() { (cd "$ROOT/diablo_server/frontend" && npm run test:build); }
shared_types() {
  (cd "$ROOT/diablo_server/frontend" && npm run build:shared) &&
    git -C "$ROOT" diff --exit-code -- diablo_server/shared/
}
characterization() { CHAR_BUILD_DIR="$ROOT/build-gate" bash "$CHAR/with_stack_lock.sh" bash "$CHAR/run.sh"; }
integration() { bash "$CHAR/with_stack_lock.sh" bash "$ROOT/test/test_integration.sh"; }
# format.sh --check is red on main in firmware/ Python (out of scope), so the gate checks what this
# refactor owns: every daq-server C/C++ file format.sh targets must be clang-format-19 clean (it is
# on main), and every Python file added since main must be black-clean.
format_check() {
  local cf="${CLANG_FORMAT_19_DIR:-}"
  export PATH="${cf:+$cf:}$PATH"
  clang-format --version | grep -q 'version 19\.' || { echo "need clang-format 19 (CLANG_FORMAT_19_DIR)"; return 1; }
  (cd "$REPO" && git ls-files 'daq-server/diablo_server' 'daq-server/archive/legacy/utl' 'daq-server/test' |
    grep -E '\.(c|cc|cpp|h|hpp)$' | grep -v -E '/(nlohmann|toml\+\+)/' |
    xargs clang-format --dry-run --Werror) || return 1
  local newpy
  newpy="$(cd "$REPO" && git diff --name-only --diff-filter=A "$(git merge-base HEAD main)" -- 'daq-server/*.py')"
  [ -z "$newpy" ] || (cd "$REPO" && echo "$newpy" | xargs black --check)
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
