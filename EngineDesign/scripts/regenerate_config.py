#!/usr/bin/env python3
"""Regenerate a config's optimizer-produced half by re-running Layer 1 against its requirements.

Runs Layer 1 on the config's own ``design_requirements``, stamps the ACHIEVED design point
(F/MR/Pc) into ``chamber_geometry.design_*``, and writes the result through ``io.save_config`` so a
split config (``<name>.yaml`` + ``<name>.outputs.yaml``) re-splits correctly instead of being
collapsed into one file.

    py -3.13 scripts/regenerate_config.py configs/canonical/impinging.yaml            # full run
    py -3.13 scripts/regenerate_config.py configs/canonical/impinging.yaml --smoke    # fast, capped
    py -3.13 scripts/regenerate_config.py configs/canonical/impinging.yaml --dry-run  # don't write

Use --smoke to validate the pipeline; use a full run to produce a real design.
"""

from __future__ import annotations

import argparse
import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner
from engine.optimizer.helpers import stamp_achieved_design_point_from_results
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization
from engine.pipeline.io import load_config, save_config

PSI = 6894.757


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("config", help="path to the config's intent file (e.g. configs/canonical/impinging.yaml)")
    ap.add_argument("--smoke", action="store_true", help="fast run, capped iterations (validation only)")
    ap.add_argument("--max-iterations", type=int, default=90)
    ap.add_argument("--cma-restarts", type=int, default=3)
    ap.add_argument("--dry-run", action="store_true", help="run + stamp but do NOT write to disk")
    args = ap.parse_args()

    cfg_path = Path(args.config).resolve()
    cfg = load_config(str(cfg_path))
    req = cfg.design_requirements.model_dump()

    print(f"config      : {cfg_path}")
    print(f"target      : F={req.get('target_thrust')} N  O/F={req.get('optimal_of_ratio')}  "
          f"preset={cfg.propellant_preset}")
    print(f"stamp BEFORE: design_thrust={cfg.chamber_geometry.design_thrust} "
          f"design_MR={cfg.chamber_geometry.design_MR} "
          f"design_pressure={cfg.chamber_geometry.design_pressure}")

    runner = PintleEngineRunner(copy.deepcopy(cfg))
    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
        "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
    }
    _thr = req.get("layer1_thrust_validation_rel_tol")
    thrust_tol = float(_thr) if _thr is not None else 0.10

    smoke = bool(args.smoke)
    opt_cfg, results = run_layer1_optimization(
        copy.deepcopy(cfg), runner, req,
        target_burn_time=float(req.get("target_burn_time", 6.0)),
        tolerances={"thrust": thrust_tol, "apogee": 0.15},
        pressure_config=pcfg,
        layer1_smoke=smoke,
        layer1_max_iterations=min(int(args.max_iterations), 24) if smoke else int(args.max_iterations),
        layer1_cma_restarts=1 if smoke else max(1, int(args.cma_restarts)),
    )

    perf = results.get("performance") or {}
    valid = perf.get("pressure_candidate_valid")
    print(f"\nachieved    : F={perf.get('F')} N  MR={perf.get('MR')}  Pc={perf.get('Pc')} Pa  valid={valid}")
    if not valid:
        print(f"failure_reasons: {perf.get('failure_reasons')}")

    stamped = stamp_achieved_design_point_from_results(opt_cfg, results)
    if stamped:
        f, mr, pc = stamped
        print(f"stamp AFTER : design_thrust={f} design_MR={mr} design_pressure={pc}")

    if args.dry_run:
        print("\n--dry-run: not writing")
        return 0
    if not valid:
        print("\nNOT writing: Layer 1 did not converge to a valid design. Fix requirements/bounds and retry.")
        return 1

    save_config(opt_cfg.model_dump(mode="json"), cfg_path)
    print(f"\nwrote (split-aware) {cfg_path.name} + {cfg_path.stem}.outputs.yaml")
    # Prove it reloads.
    rc = load_config(str(cfg_path))
    print(f"reload OK: A_throat={rc.chamber_geometry.A_throat:.6e}  "
          f"stamp design_thrust={rc.chamber_geometry.design_thrust}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
