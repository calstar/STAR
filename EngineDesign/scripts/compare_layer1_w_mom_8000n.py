#!/usr/bin/env python3
"""Run short Layer-1 smoke trials at several W_MOM values (requirements dict).

Compare impinging momentum_ratio_R vs thrust/MR/ΔP bands on configs/impinging_lox_ch4_8000N.yaml.
"""

from __future__ import annotations

import argparse
import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--layer1-max-iterations", type=int, default=22)
    args = ap.parse_args()

    cfg_path = Path(args.config)
    weights = [300.0, 1000.0, 3000.0]
    base_cfg = load_config(str(cfg_path))

    print("\n=== Layer-1 W_MOM comparison (same smoke budget per trial) ===")

    for w_mom in weights:
        cfg = copy.deepcopy(base_cfg)
        req = cfg.design_requirements.model_dump()
        req["W_MOM"] = float(w_mom)
        pcfg = {
            "mode": "optimizer_controlled",
            "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
            "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
        }

        _, results = run_layer1_optimization(
            cfg,
            PintleEngineRunner(copy.deepcopy(base_cfg)),
            req,
            target_burn_time=float(req.get("target_burn_time", 6.0)),
            tolerances={"thrust": 0.10, "apogee": 0.15},
            pressure_config=pcfg,
            layer1_smoke=True,
            layer1_max_iterations=int(args.layer1_max_iterations),
            layer1_cma_restarts=1,
        )
        perf = results.get("performance") or {}
        print(
            f"W_MOM={w_mom:g}\tR={perf.get('momentum_ratio_R')}\tMR={perf.get('MR')}\t"
            f"F={perf.get('F')}\tdP_O/Pc={perf.get('injector_dp_ratio_O')}\t"
            f"dP_F/Pc={perf.get('injector_dp_ratio_F')}\t"
            f"AoAf={perf.get('geom_ao_af')}\texp_R1={perf.get('expected_ao_af_for_R1')}"
        )


if __name__ == "__main__":
    main()
