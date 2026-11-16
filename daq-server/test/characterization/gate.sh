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
  # Ninja buffers each command's output, so parallel diagnostics never interleave mid-line.
  cmake -S "$ROOT" -B "$ROOT/build-gate" -G Ninja -Wno-dev -DCMAKE_BUILD_TYPE=Release &&
    cmake --build "$ROOT/build-gate" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tee "$LOG/build-output.txt"
  [ "${PIPESTATUS[0]}" = 0 ] || return 1
  grep -E 'warning:' "$LOG/build-output.txt" |
    sed -E "s#^$ROOT/##; s#^$REPO/#../#; s#:[0-9]+:[0-9]+: warning:#: warning:#" | sort -u > "$LOG/warnings.txt"
  local new
  new="$(comm -13 "$CHAR/baseline_warnings.txt" "$LOG/warnings.txt")"
  [ -z "$new" ] || { echo "NEW WARNINGS:"; echo "$new"; return 1; }
}
# ctest binds real UDP ports (BoardListener), so it shares the stack lock with the integration run.
# Tests that fail on main on macOS only are listed in baseline_ctest_failures.txt (see LEDGER: all
# three pass on Linux). The allowlist applies on Darwin only; elsewhere any failure fails the gate.
ctest_all() {
  (cd "$ROOT/build-gate" && bash "$CHAR/with_stack_lock.sh" ctest --output-on-failure -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)") > "$LOG/ctest-output.txt" 2>&1
  local rc=$? new
  cat "$LOG/ctest-output.txt"
  [ "$rc" = 0 ] && return 0
  new="$(sed -n '/The following tests FAILED/,$p' "$LOG/ctest-output.txt" | sed -nE 's/^[[:space:]]*[0-9]+ - ([^ ]+) .*/\1/p' |
    sort -u | comm -23 - <(if [ "$(uname)" = Darwin ]; then sort -u "$CHAR/baseline_ctest_failures.txt"; fi))"
  grep -q 'The following tests FAILED' "$LOG/ctest-output.txt" || { echo "ctest failed without a test list"; return 1; }
  [ -z "$new" ] || { echo "NEW CTEST FAILURES:"; echo "$new"; return 1; }
  echo "(only baseline-known failures: $(tr '\n' ' ' < "$CHAR/baseline_ctest_failures.txt"))"
}
# Backend tests that fail on main on this machine are listed in baseline_vitest_failures.txt
# ("file > describe > test", as vitest prints them); any other failure fails the gate.
backend_vitest() {
  (cd "$ROOT/diablo_server/backend" && npx vitest run --exclude 'dist/**' --reporter=json --outputFile="$LOG/backend-vitest.json") ||
    true
  node -e '
    const r = require(process.argv[1]); const fs = require("fs");
    const known = new Set(fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean));
    const failed = [];
    for (const f of r.testResults) for (const t of f.assertionResults)
      if (t.status === "failed") failed.push([require("path").relative(process.argv[3], f.name), ...t.ancestorTitles, t.title].join(" > "));
    const fresh = failed.filter((n) => !known.has(n));
    console.log(`backend vitest: ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped`);
    if (!r.testResults.length) { console.log("no test results"); process.exit(1); }
    if (fresh.length) { console.log("NEW VITEST FAILURES:\n" + fresh.join("\n")); process.exit(1); }
    if (failed.length) console.log("(only baseline-known failures)");
  ' "$LOG/backend-vitest.json" "$CHAR/baseline_vitest_failures.txt" "$ROOT/diablo_server/backend"
}
frontend_vitest() { (cd "$ROOT/diablo_server/frontend" && npm test); }
frontend_lint() { (cd "$ROOT/diablo_server/frontend" && npm run lint); }
frontend_build() { (cd "$ROOT/diablo_server/frontend" && npm run test:build); }
shared_types() {
  (cd "$ROOT/diablo_server/frontend" && npm run build:shared) &&
    git -C "$ROOT" diff --exit-code -- diablo_server/shared/
}
# The 9 tests vitest skips by default (CI's separate video-gateway job). Needs
# `scripts/video-gateway.sh --fetch` and `npx playwright-core install chromium` once.
video_gateway() { (cd "$ROOT/diablo_server/backend" && bash "$CHAR/with_stack_lock.sh" npm run test:video-gateway); }
# Timing-sensitive steps (characterization, integration) wait until the 1-minute load average is
# below the core count: at 2-3x oversubscription the lifecycle and pipeline goldens see real timing
# drift that the stand never does (2026-11-16: load 33 on 14 cores). Gives up after 30 min.
wait_for_load() {
  local ncpu deadline=$((SECONDS + 1800)) load
  ncpu="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
  while :; do
    load="$(uptime | sed -E 's/.*load averages?: *([0-9.]+).*/\1/')"
    awk -v l="$load" -v n="$ncpu" 'BEGIN{exit !(l < n)}' && return 0
    [ "$SECONDS" -lt "$deadline" ] || { echo "load ${load} still >= ${ncpu} cores after 30 min"; return 1; }
    echo "gate: load ${load} >= ${ncpu} cores, waiting" >&2
    sleep 30
  done
}
characterization() {
  wait_for_load || return 1
  CHAR_BUILD_DIR="$ROOT/build-gate" bash "$CHAR/with_stack_lock.sh" bash "$CHAR/run.sh"
}
integration() { wait_for_load && bash "$CHAR/with_stack_lock.sh" bash "$ROOT/test/test_integration.sh"; }
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

# Tests must not write tracked files (H-1: test_integration.sh used to rewrite the live
# abort_thresholds.txt). Files already dirty when the gate starts (work in progress) are ignored,
# and so is docs/remaster/ (the orchestrator's ledger, edited while gates run).
git -C "$ROOT" diff --name-only > "$LOG/dirty-before.txt"
tree_unchanged() {
  local new
  new="$(comm -13 <(sort "$LOG/dirty-before.txt") <(git -C "$ROOT" diff --name-only | sort) | grep -v '^daq-server/docs/remaster/' || true)"
  [ -z "$new" ] || { echo "the gate's runs modified tracked files:"; echo "$new"; git -C "$ROOT" diff --stat -- $new; return 1; }
}

step build build_clean
step ctest ctest_all
step backend-vitest backend_vitest
step video-gateway video_gateway
step frontend-vitest frontend_vitest
step frontend-lint frontend_lint
step frontend-build frontend_build
step shared-types shared_types
[ -x "$CHAR/run.sh" ] || [ -f "$CHAR/run.sh" ] && step characterization characterization
[ "$FAST" = 1 ] || step integration integration
step format format_check
step tree-unchanged tree_unchanged

echo
if [ ${#fails[@]} -eq 0 ]; then echo "GATE: PASS"; else echo "GATE: FAIL — ${fails[*]}"; exit 1; fi
