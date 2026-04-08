#!/bin/bash
# Export and plot the latest Elodin DB run.
#
# Usage:
#   ./plot_latest_db.sh                    # use latest DB by mtime
#   ./plot_latest_db.sh daq_20260307_174529 # use specific DB name
#   ./plot_latest_db.sh /path/to/db         # use full path
#
# Output: ./output/postprocessing/latest/*.png

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

ELODIN_DIR="${ELODIN_DB_DIR:-$HOME/.local/share/elodin}"
EXPORT_DIR="./export_csv"
OUT_DIR="./output/postprocessing/latest"

DB_PATH="${1:-}"

if [[ -z "$DB_PATH" ]]; then
  # Find latest DB by modification time (exclude _metadata)
  LATEST=$(find "$ELODIN_DIR" -maxdepth 1 -mindepth 1 -type d ! -name '*_metadata' ! -name '2240' \
    -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
  if [[ -z "$LATEST" ]]; then
    echo "❌ No Elodin DB found under $ELODIN_DIR"
    echo "   Run a session first (e.g. scripts/startup/start_tmux_dev.sh)"
    exit 1
  fi
  DB_PATH="$LATEST"
  echo "📂 Latest DB: $DB_PATH"
else
  if [[ "$DB_PATH" != /* ]]; then
    if [[ -d "$ELODIN_DIR/$DB_PATH" ]]; then
      DB_PATH="$ELODIN_DIR/$DB_PATH"
    fi
  fi
  if [[ ! -d "$DB_PATH" ]]; then
    echo "❌ DB not found: $DB_PATH"
    exit 1
  fi
  echo "📂 Using DB: $DB_PATH"
fi

echo ""
echo "1️⃣  Exporting to CSV..."
FORMAT=csv "$SCRIPT_DIR/export_elodin_db.sh" "$DB_PATH" "$EXPORT_DIR"

echo ""
echo "2️⃣  Validating export (DB write sanity)..."
python3 "$SCRIPT_DIR/validate_export.py" "$EXPORT_DIR" || exit 1

echo ""
echo "3️⃣  Analyzing and plotting..."
# State fallback: backend writes to data/state_transitions.csv when Elodin publish fails
python3 "$SCRIPT_DIR/analyze_run.py" "$EXPORT_DIR" -o "$OUT_DIR"

echo ""
echo "✅ Plots saved to $OUT_DIR"
ls -la "$OUT_DIR"/*.png 2>/dev/null || ls -la "$OUT_DIR"
