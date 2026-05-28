#!/usr/bin/env python3
"""Evaluate-only sweep: vary impinging A_geom_O/A_geom_F at fixed tank pressures.

Varies oxidizer jet diameter so that (n_O d_O²)/(n_F d_F²) = target_ratio,
holding fuel geometry and element counts fixed. Uses pressures from an optional
prior Layer-1 run or explicit PSI inputs.

Does not modify injector physics models — geometry-only perturbation + runner.evaluate.
"""

from __future__ import annotations

import argparse
import copy
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PSI_TO_PA = 6894.76

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402


def _diag_dp_ratios(pc: float, ev: dict) -> tuple[float | None, float | None]:
    if not (np.isfinite(pc) and pc > 0):
        return None, None
    dpo = ev.get("diagnostics", {}).get("delta_p_injector_O")
    dpf = ev.get("diagnostics", {}).get("delta_p_injector_F")
    ro = float(dpo) / pc if dpo is not None and np.isfinite(dpo) else None
    rf = float(dpf) / pc if dpf is not None and np.isfinite(dpf) else None
    return ro, rf


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--config",
        type=str,
        default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"),
        help="YAML config path",
    )
    ap.add_argument("--skip-layer1", action="store_true", help="Use --po-psi/--pf-psi instead of optimizing")
    ap.add_argument(
        "--geometry-config",
        type=str,
        default=None,
        help=(
            "When used with --skip-layer1: YAML to copy injector (and fluids) from so the sweep "
            "matches a prior optimized geometry. If omitted, injector geometry comes from --config."
        ),
    )
    ap.add_argument("--po-psi", type=float, default=None, help="LOX tank pressure [psi] when skipping Layer 1")
    ap.add_argument("--pf-psi", type=float, default=None, help="Fuel tank pressure [psi] when skipping Layer 1")
    ap.add_argument("--ratio-min", type=float, default=1.5)
    ap.add_argument("--ratio-max", type=float, default=3.0)
    ap.add_argument("--ratio-steps", type=int, default=16)
    ap.add_argument("--layer1-max-iterations", type=int, default=22)
    ap.add_argument("--silent-eval", action="store_true", help="Pass silent=True to runner.evaluate")
    args = ap.parse_args()

    cfg = load_config(args.config)
    req = cfg.design_requirements.model_dump()
    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
        "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
    }

    if args.skip_layer1:
        if args.po_psi is None or args.pf_psi is None:
            raise SystemExit("--skip-layer1 requires --po-psi and --pf-psi")
        geom_src = load_config(args.geometry_config) if args.geometry_config else cfg
        opt_cfg = copy.deepcopy(geom_src)
        po_pa = float(args.po_psi) * PSI_TO_PA
        pf_pa = float(args.pf_psi) * PSI_TO_PA
        perf_hint = {}
    else:
        opt_cfg, results = run_layer1_optimization(
            copy.deepcopy(cfg),
            PintleEngineRunner(copy.deepcopy(cfg)),
            req,
            target_burn_time=float(req.get("target_burn_time", 6.0)),
            tolerances={"thrust": 0.10, "apogee": 0.15},
            pressure_config=pcfg,
            layer1_smoke=True,
            layer1_max_iterations=int(args.layer1_max_iterations),
            layer1_cma_restarts=1,
        )
        perf_hint = results.get("performance") or {}
        po_pa = float(perf_hint["P_O_start_psi"]) * PSI_TO_PA
        pf_pa = float(perf_hint["P_F_start_psi"]) * PSI_TO_PA

    geom = getattr(getattr(opt_cfg, "injector", None), "geometry", None)
    if geom is None:
        raise SystemExit("No injector.geometry on config")
    ox = geom.oxidizer
    fu = geom.fuel
    n_o = max(1, int(ox.n_elements))
    n_f = max(1, int(fu.n_elements))
    d_f = float(fu.d_jet)
    d_o_base = float(ox.d_jet)

    P_ambient = PintleEngineRunner(copy.deepcopy(opt_cfg))._get_ambient_pressure(None)

    ratios = np.linspace(float(args.ratio_min), float(args.ratio_max), int(args.ratio_steps))

    print("\n=== A_geom_O/A_geom_F sweep (evaluate-only, fixed tank pressures) ===")
    print(f"P_tank_O = {po_pa / PSI_TO_PA:.3f} psi, P_tank_F = {pf_pa / PSI_TO_PA:.3f} psi")
    print(f"Baseline: n_O={n_o} n_F={n_f} d_O={d_o_base * 1000:.4f} mm d_F={d_f * 1000:.4f} mm")
    print(
        f"{'AoAf_tgt':>10} {'AoAf_geom':>10} {'R':>8} {'MR':>8} {'F[N]':>10} "
        f"{'dP_O/Pc':>10} {'dP_F/Pc':>10} {'err':>8}"
    )

    for r_tgt in ratios:
        cfg_i = copy.deepcopy(opt_cfg)
        g = cfg_i.injector.geometry
        scale = math.sqrt(max(1e-30, float(r_tgt) * float(n_f) / float(n_o)))
        d_o_new = d_f * scale
        g.oxidizer.d_jet = d_o_new

        runner = PintleEngineRunner(cfg_i)
        try:
            ev = runner.evaluate(po_pa, pf_pa, P_ambient=P_ambient, silent=args.silent_eval)
        except Exception as e:
            print(f"{r_tgt:10.4f} {'FAIL':>10} — {e}")
            continue

        a_go = float(ev.get("A_geom_O") or 0.0)
        a_gf = float(ev.get("A_geom_F") or 0.0)
        ao_af = a_go / a_gf if a_gf > 0 else float("nan")
        R = ev.get("diagnostics", {}).get("momentum_ratio_R")
        R = float(R) if R is not None and np.isfinite(R) else float("nan")
        MR = float(ev.get("MR", float("nan")))
        F = float(ev.get("F", float("nan")))
        pc = float(ev.get("Pc", float("nan")))
        ro, rf = _diag_dp_ratios(pc, ev)
        err = abs(ao_af - r_tgt) / r_tgt if np.isfinite(ao_af) and r_tgt > 0 else float("nan")

        print(
            f"{r_tgt:10.4f} {ao_af:10.4f} {R:8.4f} {MR:8.4f} {F:10.2f} "
            f"{(ro if ro is not None else float('nan')):10.4f} "
            f"{(rf if rf is not None else float('nan')):10.4f} {err:8.2e}"
        )


if __name__ == "__main__":
    main()
