#!/bin/bash
# elodin/ TypeScript half: drive the backend's Elodin modules (elodin-vtable-registry.ts,
# elodin-protocol.ts, elodin-client.ts) from a plain tsx script — no vitest, no sockets — and
# compare their JSON dumps with golden/. CHAR_UPDATE=1 rewrites the goldens.
# The C++ half (schema_*.txt) runs under ctest -L characterization.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../../.." && pwd -P)"
BACKEND="$ROOT/diablo_server/backend"
[ -d "$BACKEND/node_modules" ] || { echo "elodin/run.sh: run npm ci in $BACKEND first" >&2; exit 2; }

OUT="$(mktemp -d "${TMPDIR:-/tmp}/char-elodin.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT

(cd "$BACKEND" && npx --no-install tsx "$HERE/ts_dump.mts" "$ROOT" "$OUT") > "$OUT/log.txt" 2>&1 || {
  echo "elodin/run.sh: ts_dump.mts failed:" >&2
  cat "$OUT/log.txt" >&2
  exit 1
}

fail=0
for f in ts_registry.json ts_protocol.json; do
  if [ "${CHAR_UPDATE:-0}" != "0" ] && [ -n "${CHAR_UPDATE:-}" ]; then
    cp "$OUT/$f" "$HERE/golden/$f"
    echo "[golden] wrote $HERE/golden/$f"
  elif [ ! -f "$HERE/golden/$f" ]; then
    echo "[golden] MISSING $HERE/golden/$f" >&2
    fail=1
  elif diff -u "$HERE/golden/$f" "$OUT/$f" > "$OUT/$f.diff"; then
    echo "[golden] $f: match"
  else
    echo "[golden] $f: MISMATCH" >&2
    head -80 "$OUT/$f.diff" >&2
    fail=1
  fi
done
exit "$fail"
