#!/bin/bash
# Run the remaster gate on Linux in a container, from a clean export of a commit.
#
#   bash test/characterization/linux/linux_gate.sh [--amd64] [--cc gcc|clang] [rev]
#
# arm64 (native here): build, ctest, characterization, integration.
# --amd64 (emulated): build, ctest, characterization only (integration is too slow emulated).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
PLATFORM=linux/arm64; FULL=1; CC_KIND=gcc; REV=HEAD
while [ $# -gt 0 ]; do
  case "$1" in
    --amd64) PLATFORM=linux/amd64; FULL=0 ;;
    --cc) CC_KIND="$2"; shift ;;
    *) REV="$1" ;;
  esac
  shift
done
TAG="daq-remaster-linux:${PLATFORM#linux/}"
docker build -q --platform "$PLATFORM" -t "$TAG" "$HERE" >/dev/null
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
# The whole tree, as CI checks it out: the backend reads repo-level paths (firmware/Hotfire_Code for
# /api/firmware), so a partial export changes what it serves.
git -C "$REPO" archive "$REV" | tar -x -C "$WORK"
case "$CC_KIND" in gcc) CCS="CC=gcc-12 CXX=g++-12" ;; clang) CCS="CC=clang-18 CXX=clang++-18" ;; esac
# Same load guard as gate.sh: the container shares the host's cores.
NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"; deadline=$((SECONDS + 300))
while load="$(uptime | sed -E 's/.*load averages?: *([0-9.]+).*/\1/')" &&
  ! awk -v l="$load" -v n="$NCPU" 'BEGIN{exit !(l < n)}'; do
  [ "$SECONDS" -lt "$deadline" ] || { echo "linux_gate: load $load still >= $NCPU after 5 min; running anyway" >&2; break; }
  echo "linux_gate: load $load >= $NCPU cores, waiting" >&2; sleep 30
done
echo "linux_gate: $(git -C "$REPO" rev-parse --short "$REV") on $PLATFORM with $CC_KIND"
# Under the stack lock: the VM's CPU would otherwise overlap a stress pass or a gate (D27).
bash "$HERE/../with_stack_lock.sh" docker run --rm --security-opt seccomp=unconfined --platform "$PLATFORM" -v "$WORK":/src -w /src/daq-server "$TAG" bash -c "
  set -uo pipefail; export $CCS
  fails=()
  step() { local n=\$1; shift; printf '── %-18s ' \$n; if \"\$@\" > /tmp/\$n.log 2>&1; then echo ok; else echo FAIL; tail -40 /tmp/\$n.log; fails+=(\$n); fi; }
  step npm bash -c '(cd diablo_server/backend && npm ci --no-audit --no-fund) && (cd diablo_server/frontend && npm ci --no-audit --no-fund)'
  step build bash -c 'cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -Wno-dev && cmake --build build'
  step ctest bash -c 'cd build && ctest --output-on-failure -j\$(nproc)'
  step backend-vitest bash -c 'cd diablo_server/backend && npm test'
  step characterization bash -c 'CHAR_BUILD_DIR=/src/daq-server/build bash test/characterization/run.sh'
  [ $FULL = 1 ] && step integration bash test/test_integration.sh
  echo; [ \${#fails[@]} -eq 0 ] && echo 'LINUX GATE: PASS' || { echo \"LINUX GATE: FAIL — \${fails[*]}\"; exit 1; }
"
