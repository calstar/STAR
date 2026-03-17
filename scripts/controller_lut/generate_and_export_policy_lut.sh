#!/bin/bash
# Generate DDP policy LUT and export for FSW controller.
# Usage:
#   ./scripts/controller_lut/generate_and_export_policy_lut.sh [small|full]
#   small = 16 points (~10 min), full = 288 points (~2 hr)

set -e
cd "$(dirname "$0")/../.."
PROJECT_ROOT="$(pwd)"

CONFIG="${1:-small}"
if [[ "$CONFIG" == "small" ]]; then
  LUT_CONFIG="scripts/controller_lut/policy_lut_fsw_small.yaml"
elif [[ "$CONFIG" == "full" ]]; then
  LUT_CONFIG="scripts/controller_lut/policy_lut_fsw.yaml"
else
  echo "Usage: $0 [small|full]"
  exit 1
fi

NPZ="output/lut/controller_policy_fsw.npz"
BIN="output/lut/controller_policy_fsw.bin"

echo "[policy_lut] Generating from $LUT_CONFIG..."
python -m scripts.controller_lut.generate_controller_lut \
  --lut-config "$LUT_CONFIG" \
  --output "$NPZ" \
  --project-root "$PROJECT_ROOT"

echo "[policy_lut] Exporting to FSW binary..."
python -m scripts.controller_lut.export_lut_for_fsw \
  --input "$NPZ" \
  --output "$BIN" \
  --project-root "$PROJECT_ROOT"

echo "[policy_lut] Done. LUT: $BIN"
echo "  Run FSW controller with: --lut-path $BIN"
