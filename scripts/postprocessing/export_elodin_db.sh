#!/bin/bash
# Export Elodin DB to parquet/CSV for postprocessing.
#
# Usage:
#   ./export_elodin_db.sh <DB_PATH> [OUTPUT_DIR]
#   FORMAT=csv ./export_elodin_db.sh <DB_PATH> [OUTPUT_DIR]
#
# Examples:
#   ./export_elodin_db.sh ~/.local/share/elodin/daq_20260307_174529 ./export
#   FORMAT=csv ./export_elodin_db.sh ~/.local/share/elodin/daq_live ./out
#
# Data rates (see scripts/postprocessing/README.md):
#   - Raw sensor data: every packet (no downsampling)
#   - Controller measurement: every 10th tick (~1 Hz at 10 Hz loop)
#   - Calibrated PT/TC/RTD/LC: throttled to ~100 Hz per channel

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."

DB_PATH="${1:-}"
OUTPUT_DIR="${2:-./export}"
FORMAT="${FORMAT:-parquet}"

if [[ -z "$DB_PATH" ]]; then
  echo "Usage: $0 <DB_PATH> [OUTPUT_DIR]"
  echo "       FORMAT=csv $0 <DB_PATH> [OUTPUT_DIR]  # export as CSV"
  echo ""
  echo "DB_PATH: Elodin DB directory (e.g. ~/.local/share/elodin/daq_20260307_174529)"
  echo "OUTPUT_DIR: Output directory (default: ./export)"
  echo ""
  echo "Available DBs under ~/.local/share/elodin/:"
  find "$HOME/.local/share/elodin" -maxdepth 1 -mindepth 1 -type d -printf '  %f\n' 2>/dev/null | grep -v _metadata | head -20 || echo "  (none)"
  exit 1
fi

# Resolve DB path
if [[ "$DB_PATH" != /* ]]; then
  if [[ -d "$HOME/.local/share/elodin/$DB_PATH" ]]; then
    DB_PATH="$HOME/.local/share/elodin/$DB_PATH"
  fi
fi

if [[ ! -d "$DB_PATH" ]]; then
  echo "❌ DB not found: $DB_PATH"
  exit 1
fi

ELODIN_DB_BIN=""
[ -f "$HOME/.cargo/bin/elodin-db" ] && ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
[ -z "$ELODIN_DB_BIN" ] && command -v elodin-db &>/dev/null && ELODIN_DB_BIN="elodin-db"

if [[ -z "$ELODIN_DB_BIN" ]]; then
  echo "❌ elodin-db not found. Install: cargo install elodin-db"
  exit 1
fi

# Check for export subcommand
if ! "$ELODIN_DB_BIN" export --help &>/dev/null; then
  echo "⚠️  elodin-db export not available (older elodin-db version)"
  echo ""
  echo "Options:"
  echo "  1. Upgrade: cargo install elodin-db --force"
  echo "  2. Use elodin editor: elodin editor $DB_PATH"
  echo "  3. Use Lua REPL: elodin-db lua --db $DB_PATH"
  echo "     Then :sql localhost:2240 (with DB running in replay mode)"
  echo ""
  echo "See scripts/postprocessing/README.md for full docs."
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
echo "📂 Exporting $DB_PATH → $OUTPUT_DIR (format: $FORMAT)"

EXTRA=""
[[ "$FORMAT" == "csv" ]] && EXTRA="--flatten"

"$ELODIN_DB_BIN" export "$DB_PATH" -o "$OUTPUT_DIR" --format "$FORMAT" $EXTRA

echo "✅ Export complete: $OUTPUT_DIR"
ls -la "$OUTPUT_DIR" 2>/dev/null | head -20
