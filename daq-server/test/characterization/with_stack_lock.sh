#!/bin/bash
# Run a command while holding the machine-wide DAQ stack lock.
#
#   bash test/characterization/with_stack_lock.sh bash test/test_integration.sh
#
# test_integration.sh, dev.sh --sim and the stack-level characterization goldens bind fixed
# ports (5008, the sim's board ports) and kill whatever holds the test ports on start-up, so two
# runs from different worktrees on one machine kill each other's stack. This serialises them.
# The lock is a directory (mkdir is atomic; macOS has no flock binary) holding the owner's PID;
# a lock whose owner is gone is stale and is taken over.

set -euo pipefail

LOCK_DIR="${DAQ_STACK_LOCK:-${TMPDIR:-/tmp}/daq-stack.lock}"
WAIT_S="${DAQ_STACK_LOCK_WAIT:-7200}"

[ $# -gt 0 ] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }

deadline=$((SECONDS + WAIT_S))
announced=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    echo "with_stack_lock: taking over stale lock from pid $owner" >&2
    rm -rf "$LOCK_DIR"
    continue
  fi
  if [ "$announced" = 0 ]; then
    echo "with_stack_lock: waiting for $LOCK_DIR (held by pid ${owner:-?}: $(cat "$LOCK_DIR/what" 2>/dev/null || echo '?'))" >&2
    announced=1
  fi
  [ "$SECONDS" -lt "$deadline" ] || { echo "with_stack_lock: timed out after ${WAIT_S}s" >&2; exit 75; }
  sleep 2
done

echo $$ > "$LOCK_DIR/pid"
echo "$PWD: $*" > "$LOCK_DIR/what"
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

"$@"
