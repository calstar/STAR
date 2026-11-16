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

# Default: inside the repository's common git dir, which every worktree of this clone shares.
LOCK_DIR="${DAQ_STACK_LOCK:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd "$(git rev-parse --git-common-dir)" && pwd -P)/daq-stack.lock}"
WAIT_S="${DAQ_STACK_LOCK_WAIT:-7200}"

# A file's mtime in epoch seconds. GNU stat first: on Linux `stat -f` is filesystem status (it
# succeeds and prints the wrong thing); BSD stat rejects -c and falls through to -f %m.
mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

[ $# -gt 0 ] || { echo "usage: $0 <command> [args...] | --status" >&2; exit 2; }

# --status: who holds the lock, for how long, and who is waiting.
if [ "$1" = "--status" ]; then
  if [ -d "$LOCK_DIR" ]; then
    age=$(($(date +%s) - $(mtime_of "$LOCK_DIR")))
    echo "held ${age}s by pid $(cat "$LOCK_DIR/pid" 2>/dev/null || echo '?'): $(cat "$LOCK_DIR/what" 2>/dev/null || echo '?')"
    [ "$age" -lt 600 ] || echo "!! held over 10 min — iterate with a subset (LEDGER D23)"
  else
    echo "free"
  fi
  for t in "$LOCK_DIR.priority"/*; do [ -e "$t" ] && echo "priority ticket: pid $(basename "$t")"; done
  echo "waiting / running under the lock:"
  ps -axo pid=,etime=,command= | grep '[w]ith_stack_lock.sh' | grep -v -- '--status' | sed 's/^/  /'
  exit 0
fi

# Never edit this file in place while runs may be executing it: bash reads scripts incrementally.
# Write a new file and mv it over this one.
# Re-entrant: a command already running under the lock (gate.sh → run.sh → an area's run.sh)
# just runs.
if [ "${DAQ_STACK_LOCK_HELD:-}" = "$LOCK_DIR" ]; then exec "$@"; fi

# Priority: DAQ_STACK_LOCK_PRIORITY=1 (the orchestrator's own baseline and merge-gate runs only —
# never an agent's) registers a
# ticket in $LOCK_DIR.priority/; while any live ticket exists, ordinary callers do not take the lock,
# so a priority waiter cannot lose every race to a stream of ordinary ones (mkdir is not FIFO).
PRIO_DIR="$LOCK_DIR.priority"
if [ "${DAQ_STACK_LOCK_PRIORITY:-}" = 1 ]; then
  mkdir -p "$PRIO_DIR"
  touch "$PRIO_DIR/$$"
  trap 'rm -f "$PRIO_DIR/$$"' EXIT INT TERM
fi
priority_waiting() {
  [ "${DAQ_STACK_LOCK_PRIORITY:-}" = 1 ] && return 1
  local t
  for t in "$PRIO_DIR"/*; do
    [ -e "$t" ] || continue
    if kill -0 "$(basename "$t")" 2>/dev/null; then return 0; else rm -f "$t"; fi
  done
  return 1
}

deadline=$((SECONDS + WAIT_S))
announced=0
while priority_waiting || ! mkdir "$LOCK_DIR" 2>/dev/null; do
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    echo "with_stack_lock: taking over stale lock from pid $owner" >&2
    rm -rf "$LOCK_DIR"
    continue
  fi
  # A holder killed between mkdir and writing its pid leaves an empty lock dir nobody owns.
  if [ -z "$owner" ] && [ -d "$LOCK_DIR" ] &&
    [ $(($(date +%s) - $(mtime_of "$LOCK_DIR" 2>/dev/null || date +%s))) -gt "${DAQ_STACK_LOCK_EMPTY_STALE_S:-10}" ]; then
    echo "with_stack_lock: taking over an ownerless lock" >&2
    rmdir "$LOCK_DIR" 2>/dev/null || true
    continue
  fi
  if [ "$announced" = 0 ]; then
    echo "with_stack_lock: waiting for $LOCK_DIR (held by pid ${owner:-?}: $(cat "$LOCK_DIR/what" 2>/dev/null || echo '?'))" >&2
    announced=1
  fi
  [ "$SECONDS" -lt "$deadline" ] || { echo "with_stack_lock: timed out after ${WAIT_S}s" >&2; exit 75; }
  sleep 2
done

trap 'rm -rf "$LOCK_DIR"; rm -f "$PRIO_DIR/$$"' EXIT INT TERM
echo $$ > "$LOCK_DIR/pid"
echo "$PWD: $*" > "$LOCK_DIR/what"
rm -f "$PRIO_DIR/$$"
export DAQ_STACK_LOCK_HELD="$LOCK_DIR"

"$@"
