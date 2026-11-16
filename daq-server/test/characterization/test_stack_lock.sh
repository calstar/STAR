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

# 2. lock whose owner pid is dead: taken over
mkdir "$DAQ_STACK_LOCK" && echo 999999 > "$DAQ_STACK_LOCK/pid"
out="$(bash "$LOCKSH" echo took-stale 2>/dev/null)"
check "a lock held by a dead pid is taken over" '[ "$out" = took-stale ]'

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
