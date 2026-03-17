#!/bin/bash
# Full pipeline: engine LUT → policy LUT.
# 1. Engine LUT: stems from engine config + tank pressure range. Precomputes F, MR, mdot, etc.
# 2. Policy LUT: DDP uses engine LUT for fast lookups (or physics if no engine LUT).
#
# Usage: ./scripts/controller_lut/generate_engine_and_policy_lut.sh [small|full]

set -e
cd "$(dirname "$0")/../.."
PROJECT_ROOT="$(pwd)"

CONFIG="${1:-small}"
if [[ "$CONFIG" == "small" ]]; then
  ENGINE_CONFIG="scripts/controller_lut/engine_lut_config_small.yaml"
  POLICY_CONFIG="scripts/controller_lut/policy_lut_fsw_small.yaml"
elif [[ "$CONFIG" == "full" ]]; then
  ENGINE_CONFIG="scripts/controller_lut/engine_lut_config.yaml"
  POLICY_CONFIG="scripts/controller_lut/policy_lut_fsw.yaml"
else
  echo "Usage: $0 [small|full]"
  exit 1
fi

ENGINE_NPZ="output/lut/engine_performance.npz"
POLICY_NPZ="output/lut/controller_policy_fsw.npz"
POLICY_BIN="output/lut/controller_policy_fsw.bin"

echo "[1/3] Engine LUT (engine config + tank pressure range)..."
python -m scripts.controller_lut.generate_controller_lut \
  --lut-config "$ENGINE_CONFIG" \
  --output "$ENGINE_NPZ" \
  --project-root "$PROJECT_ROOT"

echo "[2/3] Policy LUT (DDP with engine LUT for fast lookups)..."
python -c "
import yaml
from pathlib import Path
p = Path('$POLICY_CONFIG')
c = yaml.safe_load(p.read_text())
c['engine_lut_path'] = '$ENGINE_NPZ'
t = Path('/tmp/policy_lut_with_engine.yaml')
yaml.dump(c, t.open('w'), default_flow_style=False)
print('  Using engine_lut_path:', c['engine_lut_path'])
"
python -m scripts.controller_lut.generate_controller_lut \
  --lut-config /tmp/policy_lut_with_engine.yaml \
  --output "$POLICY_NPZ" \
  --project-root "$PROJECT_ROOT"

echo "[3/3] Export policy LUT for FSW..."
python -m scripts.controller_lut.export_lut_for_fsw \
  --input "$POLICY_NPZ" \
  --output "$POLICY_BIN" \
  --project-root "$PROJECT_ROOT"

echo "Done. Engine: $ENGINE_NPZ  Policy: $POLICY_BIN"
