#!/bin/bash
# Run the remaster gate on Linux in a container, from a clean export of a commit.
#
#   bash test/characterization/linux/linux_gate.sh [--amd64] [--cc gcc|clang] [rev]
#
# arm64 (native here): build, ctest, characterization, integration.
# --amd64 (emulated): build, ctest, characterization only (integration is too slow emulated).
# --areas a,b: build, then only those characterization areas (with the leftover checks) — the mode
# agents use (LEDGER D36). The full leg is for queue/* branches and the tag candidate.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
PLATFORM=linux/arm64; FULL=1; CC_KIND=gcc; REV=HEAD; AREAS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --amd64) PLATFORM=linux/amd64; FULL=0 ;;
    --cc) CC_KIND="$2"; shift ;;
    --areas) AREAS="$2"; shift ;;
    *) REV="$1" ;;
  esac
  shift
done
# Tagged by the Dockerfile's content: worktrees share Docker's image store, and a shared tag let an
# older Dockerfile (without numpy) overwrite a newer one's image.
TAG="daq-remaster-linux:${PLATFORM#linux/}-$(shasum -a 256 "$HERE/Dockerfile" 2>/dev/null | cut -c1-12 || sha256sum "$HERE/Dockerfile" | cut -c1-12)"
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
echo "linux_gate: $(git -C "$REPO" rev-parse --short "$REV") on $PLATFORM with $CC_KIND${AREAS:+, areas $AREAS only}"
# Under its own lock (LEDGER D90), not the stack lock: the container has its own network namespace and
# mounts only its export and log dir, so it cannot collide with a host stack; one Linux leg at a time.
# One directory per run, never deleted here: a red leg's full step logs must survive the next run
# (LEDGER D89). Clean .tmp/linux-gate/ by hand when it grows.
LOGS="$(cd "$HERE/../../.." && pwd -P)/.tmp/linux-gate/${PLATFORM#linux/}/$(date +%Y%m%d-%H%M%S)-$(git -C "$REPO" rev-parse --short "$REV")"
mkdir -p "$LOGS"
echo "linux_gate: full step logs in $LOGS"
DAQ_STACK_LOCK="$(cd "$(git -C "$HERE" rev-parse --git-common-dir)" && pwd -P)/daq-linux.lock" \
  bash "$HERE/../with_stack_lock.sh" docker run --rm --security-opt seccomp=unconfined --platform "$PLATFORM" -v "$LOGS":/logs -v "$WORK":/src -w /src/daq-server "$TAG" bash -c "
  set -uo pipefail; export $CCS; export DAQ_STACK_LOCK=/tmp/daq-stack.lock  # no .git in an export
  [ $FULL = 1 ] || export CHAR_EMULATED=1  # amd64 runs emulated: slow-start tests get their long timeout
  fails=()
  step() { local n=\$1; shift; printf '── %-18s ' \$n; if \"\$@\" > /logs/\$n.log 2>&1; then echo ok; grep -E '^(RETRY PASSED|KNOWN FAILURE)' /logs/\$n.log; else echo FAIL; tail -40 /logs/\$n.log; grep -E '^(RETRY PASSED|KNOWN FAILURE|FAILED )|FAILED:|^[A-Za-z ]+: (PASS|FAIL)|^CHARACTERIZATION' /logs/\$n.log; fails+=(\$n); fi; }
  step npm bash -c '(cd diablo_server/backend && npm ci --no-audit --no-fund) && (cd diablo_server/frontend && npm ci --no-audit --no-fund)'
  step build bash -c 'cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -Wno-dev && cmake --build build && bash test/characterization/include_guard.sh build'
  if [ -z '$AREAS' ]; then
    step ctest bash test/characterization/ctest_with_retry.sh build -j\$(nproc)
    step backend-vitest bash -c 'cd diablo_server/backend && npm test'
  fi
  step characterization bash -c 'CHAR_AREAS=$AREAS CHAR_BUILD_DIR=/src/daq-server/build bash test/characterization/run.sh'
  [ $FULL = 1 ] && [ -z '$AREAS' ] && step integration bash test/test_integration.sh
  echo; [ \${#fails[@]} -eq 0 ] && echo 'LINUX GATE: PASS' || { echo \"LINUX GATE: FAIL — \${fails[*]}\"; exit 1; }
"
