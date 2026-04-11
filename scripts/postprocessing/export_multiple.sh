#!/bin/bash
# Export multiple Elodin DBs to CSV for postprocessing.
#
# Usage:
#   ./export_multiple.sh <DB_NAME_1> <DB_NAME_2> ...
#
# Example:
#   ./export_multiple.sh "Fuel Flow Test" "Fuel Flow Test take 2"
#
# It will export each to:
#   data/runs/Fuel_Flow_Test/export/
#   data/runs/Fuel_Flow_Test_take_2/export/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."

if [[ -z "$1" ]]; then
  echo "Usage: ./export_multiple.sh <DB_NAME_1> <DB_NAME_2> ..."
  echo "Example: ./export_multiple.sh \"Fuel Flow Test\" \"Fuel Flow Test take 2\""
  echo ""
  echo "Available DBs under ~/.local/share/elodin/:"
  find "$HOME/.local/share/elodin" -maxdepth 1 -mindepth 1 -type d -printf '  %f\n' 2>/dev/null | grep -v _metadata | head -20 || echo "  (none)"
  exit 1
fi

export FORMAT=csv

for DB_NAME in "$@"; do
  DB_PATH="$HOME/.local/share/elodin/$DB_NAME"

  if [[ ! -d "$DB_PATH" ]]; then
    echo "❌ DB not found: $DB_PATH"
    continue
  fi

  # Replace spaces and special chars with underscores for safely naming the directory
  SAFE_DB_NAME="$(echo "$DB_NAME" | tr ' ' '_')"
  OUT_DIR="data/runs/$SAFE_DB_NAME/export"

  echo "============================================================"
  echo "🚀 Exporting DB: $DB_NAME"
  echo "   Output Dir:   $OUT_DIR"
  echo "============================================================"

  mkdir -p "$OUT_DIR"

  # Run the existing export script
  # We use the full path to avoid relative path issues since we changed directory to project root
  "$SCRIPT_DIR/export_elodin_db.sh" "$DB_PATH" "$OUT_DIR"

  echo ""
done

echo "🎉 All exports completed successfully!"
echo "You can now run the Cd script on any of these directories, for example:"
echo "  ./scripts/postprocessing/characterize_cd.py data/runs/$(echo "$1" | tr ' ' '_')/export"
