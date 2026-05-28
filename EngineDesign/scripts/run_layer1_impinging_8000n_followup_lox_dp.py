#!/usr/bin/env python3
"""Follow-up Layer 1 starting from prior valid optimum: steer LOX dP_inj/Pc up with soft floor + W_DP_O."""

from __future__ import annotations

import argparse
import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization
from engine.pipeline.io import load_config


def _seed_from_last_valid_followup(cfg):
    """Warm-start from last good follow-up (~7354 N, dP_O/Pc≈0.131, MR≈3.68).

    Keeps ``A_exit = A_throat * expansion_ratio`` so ``PintleEngineRunner.evaluate`` does not abort.
    """
    cg = cfg.chamber_geometry
    if cg is None:
        raise ValueError("chamber_geometry required")
    cg.A_throat = 0.001849
    cg.expansion_ratio = 6.0
    cg.A_exit = float(cg.A_throat) * float(cg.expansion_ratio)
    cg.Lstar = 1.18811
    cg.chamber_diameter = 0.15159999999999998
    ox = cfg.injector.geometry.oxidizer
    fu = cfg.injector.geometry.fuel
    nd = 83
    ox.n_elements = nd
    ox.d_jet = 0.0014579
    ox.impingement_angle = 63.70
    ox.spacing = 0.0054755
    fu.n_elements = nd
    fu.d_jet = 0.0008857
    fu.impingement_angle = 64.71
    fu.spacing = 0.0061195
    cfg.lox_tank.initial_pressure_psi = float(494.2608184424503)
    cfg.fuel_tank.initial_pressure_psi = float(538.0149922949225)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--max-it", type=int, default=95)
    ap.add_argument("--restarts", type=int, default=2)
    args = ap.parse_args()

    cfg = load_config(args.config)
    _seed_from_last_valid_followup(cfg)

    req = cfg.design_requirements.model_dump()
    # LOX: hinge [0.15, 0.37] + floor at 0.15; YAML upper 0.37 preserved via model_dump.
    req["injector_dp_ratio_O_min"] = 0.15
    req["injector_dp_ratio_O_soft_floor"] = 0.15
    req["W_DP_O_FLOOR"] = 9000.0
    req["W_DP_O"] = 2500.0
    req["injector_dp_ratio_F_min"] = 0.32
    req["injector_dp_ratio_F_max"] = 0.57
    req["layer1_P_O_start_psi_min"] = 490.0
    req["layer1_P_O_start_psi_max"] = 515.0
    req["layer1_P_F_start_psi_min"] = 535.0
    req["layer1_P_F_start_psi_max"] = 552.0

    runner = PintleEngineRunner(copy.deepcopy(cfg))
    dr = cfg.design_requirements
    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(dr.max_lox_tank_pressure_psi),
        "max_fuel_pressure_psi": float(dr.max_fuel_tank_pressure_psi),
    }

    opt_cfg, results = run_layer1_optimization(
        copy.deepcopy(cfg),
        runner,
        req,
        target_burn_time=float(req.get("target_burn_time", 6.0)),
        tolerances={"thrust": 0.10, "apogee": 0.15},
        pressure_config=pcfg,
        layer1_smoke=False,
        layer1_max_iterations=max(1, int(args.max_it)),
        layer1_cma_restarts=max(1, int(args.restarts)),
    )

    perf = results.get("performance") or {}
    ox = opt_cfg.injector.geometry.oxidizer
    fu = opt_cfg.injector.geometry.fuel

    print("\n=== Follow-up Layer 1 (warm LOX dP/Pc toward ≥0.15, prefer ≤0.37) ===")
    print(f"req: LOX hinge [{req['injector_dp_ratio_O_min']},{req['injector_dp_ratio_O_max']}], "
          f"W_DP_O={req['W_DP_O']}, W_DP_O_FLOOR={req['W_DP_O_FLOOR']}, "
          f"fuel [{req['injector_dp_ratio_F_min']},{req['injector_dp_ratio_F_max']}]")
    print()
    print(f"thrust [N]:                 {perf.get('F')}")
    print(f"MR:                         {perf.get('MR')}")
    print(f"momentum_ratio_R:           {perf.get('momentum_ratio_R')}")
    print(f"dP_O/Pc:                   {perf.get('injector_dp_ratio_O')}")
    print(f"dP_F/Pc:                   {perf.get('injector_dp_ratio_F')}")
    print(f"P_O / P_F [psi]:           {perf.get('P_O_start_psi')} / {perf.get('P_F_start_psi')}")
    cg = opt_cfg.chamber_geometry
    if cg is not None:
        eps_s = float(cg.A_exit) / float(cg.A_throat) if cg.A_throat and cg.A_exit else float("nan")
        print(
            f"A_throat [m2] / A_exit [m2] / eps(sync check):  "
            f"{getattr(cg, 'A_throat', None)} / {getattr(cg, 'A_exit', None)} / {eps_s:.5g}"
        )
    print(
        f"n_O/n_F | d_jet_O/d_jet_F [mm] | sp_O/sp_F [mm] | ang_O/ang_F [deg]:  "
        f"{int(ox.n_elements)}/{int(fu.n_elements)} | "
        f"{ox.d_jet*1000:.4f}/{fu.d_jet*1000:.4f} | "
        f"{ox.spacing*1000:.4f}/{fu.spacing*1000:.4f} | "
        f"{ox.impingement_angle:.2f}/{fu.impingement_angle:.2f}"
    )
    print(f"pressure_candidate_valid:  {perf.get('pressure_candidate_valid')}")


if __name__ == "__main__":
    main()
