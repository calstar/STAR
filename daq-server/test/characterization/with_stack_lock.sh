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

# --status: every lock of this clone — the stack lock and the Linux leg's (LEDGER D90) — with its
# holder, age and priority tickets, and each with_stack_lock.sh process under the lock it is on
# (its DAQ_STACK_LOCK). A process whose command line merely names the script, such as a shell that
# will call it once its own load guard clears, is listed apart: it waits on no lock (LEDGER D98,
# when such a shell and two Linux-lock waiters read as stack-lock waiters).
if [ "$1" = "--status" ]; then
  # The clone's common git dir, where both standard locks live, whatever DAQ_STACK_LOCK says here;
  # outside a clone (a container's export, the self-test's temp lock) the configured lock's directory.
  common="$( (cd "$(dirname "${BASH_SOURCE[0]}")" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" && pwd -P) 2>/dev/null || dirname "$LOCK_DIR")"
  lock_of() {  # the lock dir a with_stack_lock.sh process uses: its DAQ_STACK_LOCK, else the default
    local env
    if [ -r "/proc/$1/environ" ]; then env="$(tr '\0' '\n' < "/proc/$1/environ")"
    else env="$(ps -Eo command= -p "$1" 2>/dev/null | tr ' ' '\n')"; fi
    sed -n 's/^DAQ_STACK_LOCK=//p' <<< "$env" | tail -1 | grep . || echo "$common/daq-stack.lock"
  }
  procs="$(ps -axo pid=,etime=,command= | awk -v me=$$ '$1 != me && $4 ~ /with_stack_lock\.sh$/ && $5 != "--status"')"
  for lock in $(printf '%s\n' "$LOCK_DIR" "$common/daq-stack.lock" "$common/daq-linux.lock" | awk '!seen[$0]++'); do
    printf '%s: ' "$(basename "$lock")"
    if [ -d "$lock" ]; then
      age=$(($(date +%s) - $(mtime_of "$lock")))
      echo "held ${age}s by pid $(cat "$lock/pid" 2>/dev/null || echo '?'): $(cat "$lock/what" 2>/dev/null || echo '?')"
      [ "$age" -lt 600 ] || echo "  !! held over 10 min — iterate with a subset (LEDGER D23)"
    else
      echo free
    fi
    for t in "$lock.priority"/*; do [ -e "$t" ] && echo "  priority ticket: pid $(basename "$t")"; done
    while read -r pid etime cmd; do
      [ -n "$pid" ] && [ "$(lock_of "$pid")" = "$lock" ] || continue
      if [ "$pid" = "$(cat "$lock/pid" 2>/dev/null)" ]; then echo "  holder  $pid $etime $cmd"; else echo "  waiting $pid $etime $cmd"; fi
    done <<< "$procs"
  done
  others="$(ps -axo pid=,etime=,command= | grep '[w]ith_stack_lock.sh' | grep -v -- '--status' | awk '$4 !~ /with_stack_lock\.sh$/')"
  [ -z "$others" ] || { echo "naming the script, not in its loop (e.g. an own load guard), on no lock:"; cut -c1-160 <<< "$others" | sed 's/^/  /'; }
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
# A pid is alive when it exists and is not a zombie: kill -0 succeeds on a zombie (a holder whose
# shell was killed and never reaped it) on macOS and Linux alike, so a dead owner would hold the
# lock until something reaped it (LEDGER D98: a guard, not a diagnosed cause).
alive() { kill -0 "$1" 2>/dev/null && [[ "$(ps -o stat= -p "$1" 2>/dev/null)" != Z* ]]; }
priority_waiting() {
  [ "${DAQ_STACK_LOCK_PRIORITY:-}" = 1 ] && return 1
  local t
  for t in "$PRIO_DIR"/*; do
    [ -e "$t" ] || continue
    if alive "$(basename "$t")"; then return 0; else rm -f "$t"; fi
  done
  return 1
}

deadline=$((SECONDS + WAIT_S))
announced=0
while priority_waiting || ! mkdir "$LOCK_DIR" 2>/dev/null; do
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && ! alive "$owner"; then
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
