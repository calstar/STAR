#!/bin/bash
# Full pipeline: engine LUT → policy LUT.
# 1. Engine LUT: stems from engine config + tank pressure range. Precomputes F, MR, mdot, etc.
# 2. Policy LUT: DDP uses engine LUT for fast lookups (or physics if no engine LUT).
#
# Usage: ./scripts/controller_lut/generate_engine_and_policy_lut.sh [small|full]
# Optional: JOBS=8 ./generate_engine_and_policy_lut.sh  (parallel workers, default: all CPUs)

set -e
cd "$(dirname "$0")/../.."
PROJECT_ROOT="$(pwd)"
JOBS="${JOBS:-}"

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
THRUST_CURVE_CSV="output/lut/thrust_curve.csv"

echo "[0/4] Thrust curve from Layer 2 pressure curves..."
python -m scripts.controller_lut.extract_thrust_curve_from_config \
  --config engine_sim/configs/default.yaml \
  --project-root "$PROJECT_ROOT" \
  --output "$THRUST_CURVE_CSV"

JOBS_ARG=""
[[ -n "$JOBS" ]] && JOBS_ARG="--jobs $JOBS"

echo "[1/4] Engine LUT (engine config + tank pressure range)..."
python -m scripts.controller_lut.generate_controller_lut \
  --lut-config "$ENGINE_CONFIG" \
  --output "$ENGINE_NPZ" \
  --project-root "$PROJECT_ROOT" \
  $JOBS_ARG

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
  --project-root "$PROJECT_ROOT" \
  $JOBS_ARG

echo "[3/4] Export policy LUT for FSW..."
python -m scripts.controller_lut.export_lut_for_fsw \
  --input "$POLICY_NPZ" \
  --output "$POLICY_BIN" \
  --project-root "$PROJECT_ROOT"

echo "Done. Engine: $ENGINE_NPZ  Policy: $POLICY_BIN  Thrust curve: $THRUST_CURVE_CSV"
