#!/bin/bash
# WP6 R1b (DESIGN-WP6 §6.3 item 4): the esbuild bundle's module-evaluation order of the backend
# at HEAD (or the working tree) against a base revision. The only permitted difference is new
# src/server/* entries, so those are filtered out before the diff; anything left is a stop.
#
#   bash test/remaster-checks/wp6-module-order.sh <base-rev> [head-rev]
#
# head-rev defaults to the working tree. Runs the backend's own esbuild with every package
# external, so it needs node_modules only in this checkout; the base is a `git archive` export
# into a temp dir (no node_modules needed: nothing is resolved from packages). Exit 0 and no
# output when the orders agree outside src/server/.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"           # daq-server/
BACKEND="$ROOT/diablo_server/backend"
ESB="$BACKEND/node_modules/.bin/esbuild"
[ -x "$ESB" ] || { echo "wp6-module-order: $ESB missing — npm ci in diablo_server/backend" >&2; exit 2; }
BASE="${1:?base rev}"; HEADREV="${2:-}"

order() {  # <backend dir>
  (cd "$1" && "$ESB" src/server.ts --bundle --platform=node --format=esm --packages=external \
     --log-level=error | grep -E '^// (src|\.\./)' \
     | awk '{last[$2]=NR; o[NR]=$2} END{for(i=1;i<=NR;i++) if(last[o[i]]==i) print o[i]}')
}
export_rev() {  # <rev> <dir>
  mkdir -p "$2"
  git -C "$(git -C "$ROOT" rev-parse --show-toplevel)" archive "$1" daq-server/diablo_server/backend/src daq-server/diablo_server/backend/tsconfig.json \
    daq-server/diablo_server/shared | tar -x -C "$2"
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export_rev "$BASE" "$TMP/base"
order "$TMP/base/daq-server/diablo_server/backend" > "$TMP/before.txt"
if [ -n "$HEADREV" ]; then
  export_rev "$HEADREV" "$TMP/head"
  order "$TMP/head/daq-server/diablo_server/backend" > "$TMP/after.txt"
else
  order "$BACKEND" > "$TMP/after.txt"
fi
echo "modules: before $(wc -l < "$TMP/before.txt"), after $(wc -l < "$TMP/after.txt") ($(grep -c '^src/server/' "$TMP/after.txt" || true) in src/server/)"
diff <(grep -v '^src/server/' "$TMP/before.txt") <(grep -v '^src/server/' "$TMP/after.txt")
