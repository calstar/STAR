#!/bin/bash
# WP7 static checks (DESIGN-WP7 §6.1, §8), run from anywhere:
#   bash test/wp7-checks/route_checks.sh [rev]      # rev defaults to backend-remastered
# 1. Route table: the sorted (path, method) predicates of the baseline ladder equal those of
#    src/api-server.ts + src/api/*.ts.
# 2. Dispatch: every exported handle<Group>Request of src/api/*.ts is awaited exactly once in
#    src/api-server.ts, between the router's `try {` and its `} catch (error: any) {`.
# 3. Cycles: no src/api/*.ts imports api-server.ts or server/* (STYLE-S31).
# 4. Operator gates: the 14 literal gate blocks are still 14, none in api/ota.ts (SEC-2 kept).
# Prints nothing but the summary line and exits 0 when every check passes.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SRC="$(cd "$HERE/../../src" && pwd -P)"
ROOT="$(git -C "$SRC" rev-parse --show-toplevel)"
REV="${1:-backend-remastered}"
rc=0
cd "$SRC"

routes() { grep -ohE "url\.pathname( === '[^']+'|\.startsWith\('[^']+'\))( && req\.method === '[A-Z]+')?" "$@" | sort; }
old=$(mktemp)
git -C "$ROOT" show "$REV:daq-server/diablo_server/backend/src/api-server.ts" > "$old"
if ! diff <(routes "$old") <(routes api-server.ts api/*.ts 2>/dev/null); then echo "BAD route table"; rc=1; fi
rm -f "$old"

try_l=$(grep -n "^    try {" api-server.ts | head -1 | cut -d: -f1)
catch_l=$(grep -n "^    } catch (error: any) {" api-server.ts | head -1 | cut -d: -f1)
n=0
for f in $(grep -ohE "export async function handle[A-Za-z]+Request" api/*.ts 2>/dev/null | awk '{print $4}'); do
  hits=$(grep -n "if (await $f(req, res, url, opts)) return true;" api-server.ts | cut -d: -f1)
  if [ "$(echo "$hits" | grep -c .)" = 1 ] && [ "$hits" -gt "$try_l" ] && [ "$hits" -lt "$catch_l" ]; then n=$((n+1)); else echo "BAD dispatch: $f"; rc=1; fi
done

if grep -lE "from '\.\./(api-server\.js|server/)" api/*.ts 2>/dev/null; then echo "BAD import cycle"; rc=1; fi

gates=$(cat api-server.ts api/*.ts 2>/dev/null | grep -c 'if (!isConfigWriteAuthorized(req)) {')
ota_gates=$( [ -f api/ota.ts ] && { grep -c "isConfigWriteAuthorized" api/ota.ts || true; } || echo 0)
if [ "$gates" != 14 ] || [ "$ota_gates" != 0 ]; then echo "BAD gates: $gates total, $ota_gates in api/ota.ts"; rc=1; fi

echo "wp7 route checks: dispatched handlers $n, gates $gates (0 in api/ota.ts), rc=$rc"
exit $rc
