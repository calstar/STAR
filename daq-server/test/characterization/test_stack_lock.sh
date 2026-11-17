#!/bin/bash
# Self-test for with_stack_lock.sh (run by run.sh): an ownerless lock dir is taken over, a stale
# pid is taken over, re-entry does not deadlock, and a priority waiter beats an ordinary one.
set -u
LOCKSH="${LOCKSH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/with_stack_lock.sh}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export DAQ_STACK_LOCK="$T/lock" DAQ_STACK_LOCK_WAIT=20 DAQ_STACK_LOCK_EMPTY_STALE_S=1
unset DAQ_STACK_LOCK_HELD DAQ_STACK_LOCK_PRIORITY
fail=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }

# 1. ownerless (empty) lock dir, back-dated: taken over
mkdir "$DAQ_STACK_LOCK" && touch -t 202001010000 "$DAQ_STACK_LOCK"
out="$(bash "$LOCKSH" echo took-empty 2>/dev/null)"
check "an ownerless lock dir is taken over" '[ "$out" = took-empty ]'

# 2. lock whose owner pid is dead: taken over within one poll (LEDGER D98: 5 s bound)
mkdir "$DAQ_STACK_LOCK" && echo 999999 > "$DAQ_STACK_LOCK/pid"
s=$SECONDS; out="$(bash "$LOCKSH" echo took-stale 2>/dev/null)"; el=$((SECONDS - s))
check "a lock held by a dead pid is taken over within 5 s (${el} s)" '[ "$out" = took-stale ] && [ "$el" -le 5 ]'

# 2b. lock whose owner is a zombie (killed, parent never reaped it — a TaskStop'd holder's shell):
# kill -0 succeeds on a zombie on macOS and Linux alike, so the owner must be judged by its state.
python3 -c 'import subprocess, sys, time
p = subprocess.Popen(["true"]); time.sleep(0.3)
open(sys.argv[1], "w").write(str(p.pid)); time.sleep(60)' "$T/zpid" & zparent=$!
for _ in $(seq 20); do [ -s "$T/zpid" ] && break; sleep 0.1; done
zpid="$(cat "$T/zpid" 2>/dev/null)"
if [ -n "$zpid" ] && [[ "$(ps -o stat= -p "$zpid" 2>/dev/null)" == Z* ]]; then
  mkdir "$DAQ_STACK_LOCK" && echo "$zpid" > "$DAQ_STACK_LOCK/pid"
  s=$SECONDS; out="$(bash "$LOCKSH" echo took-zombie 2>/dev/null)"; el=$((SECONDS - s))
  check "a lock held by a zombie pid is taken over within 5 s (${el} s)" '[ "$out" = took-zombie ] && [ "$el" -le 5 ]'
else
  echo "  FAIL could not stage a zombie owner (pid '$zpid', stat '$(ps -o stat= -p "${zpid:-0}" 2>/dev/null)')"; fail=1
fi
kill "$zparent" 2>/dev/null; wait "$zparent" 2>/dev/null
rm -rf "$DAQ_STACK_LOCK"

# 3. re-entry
out="$(bash "$LOCKSH" bash "$LOCKSH" echo nested 2>/dev/null)"
check "re-entry under a held lock runs" '[ "$out" = nested ]'

# 4. priority waiter goes before an ordinary waiter that queued first
bash "$LOCKSH" sleep 2 & h=$!
sleep 0.5
(bash "$LOCKSH" bash -c "echo ordinary >> '$T/order'" 2>/dev/null) & o=$!
sleep 0.5
(DAQ_STACK_LOCK_PRIORITY=1 bash "$LOCKSH" bash -c "echo priority >> '$T/order'" 2>/dev/null) & p=$!
wait $h $o $p
check "priority waiter goes first" '[ "$(head -1 "$T/order" 2>/dev/null)" = priority ]'
check "lock released at the end" '[ ! -e "$DAQ_STACK_LOCK" ]'
exit $fail
