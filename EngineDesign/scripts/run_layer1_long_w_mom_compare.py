#!/usr/bin/env python3
"""Long Layer-1 runs: compare W_MOM at fixed W_geom_ao_af_momentum (8000 N impinging config)."""

from __future__ import annotations

import argparse
import copy
import math
import sys
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402


def _geom_row(cfg: Any) -> Dict[str, Any]:
    geom = getattr(getattr(cfg, "injector", None), "geometry", None)
    if geom is None:
        return {}
    ox = geom.oxidizer
    fu = geom.fuel
    return {
        "n_O": int(ox.n_elements),
        "n_F": int(fu.n_elements),
        "d_O_mm": float(ox.d_jet) * 1000.0,
        "d_F_mm": float(fu.d_jet) * 1000.0,
        "spacing_O_mm": float(ox.spacing) * 1000.0,
        "spacing_F_mm": float(fu.spacing) * 1000.0,
        "imp_deg_O": float(ox.impingement_angle),
        "imp_deg_F": float(fu.impingement_angle),
    }


def _collect(w_mom: float, opt_cfg: Any, perf: Dict[str, Any]) -> Dict[str, Any]:
    g = _geom_row(opt_cfg)
    row = {
        "W_MOM": w_mom,
        "F": perf.get("F"),
        "MR": perf.get("MR"),
        "R": perf.get("momentum_ratio_R"),
        "dP_O_Pc": perf.get("injector_dp_ratio_O"),
        "dP_F_Pc": perf.get("injector_dp_ratio_F"),
        "AoAf_geom": perf.get("geom_ao_af"),
        "expected_AO_AF_R1": perf.get("expected_ao_af_for_R1"),
        "P_O_psi": perf.get("P_O_start_psi"),
        "P_F_psi": perf.get("P_F_start_psi"),
        "injector_dp_oors": perf.get("injector_dp_out_of_range"),
        **g,
    }
    return row


def _f(x: Any, default: float = float("nan")) -> float:
    try:
        if x is None:
            return default
        v = float(x)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _score(row: Dict[str, Any]) -> float:
    """Lower is better (soft targets: R=1, MR=3.5, F=8000 N)."""
    R = _f(row.get("R"), 1.0)
    MR = _f(row.get("MR"), 3.5)
    F = _f(row.get("F"), 8000.0)
    dpf = _f(row.get("dP_F_Pc"), 1.0)

    e_r = (math.log(max(R, 1e-9))) ** 2
    e_mr = ((MR - 3.5) / 3.5) ** 2
    e_f = ((F - 8000.0) / 8000.0) ** 2
    e_dpf = max(0.0, dpf - 1.2) ** 2  # prefer fuel ΔP/Pc not far above 1.2

    return 2.0 * e_r + 2.0 * e_mr + 1.5 * e_f + 0.8 * e_dpf


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--layer1-max-iterations", type=int, default=120)
    ap.add_argument("--layer1-cma-restarts", type=int, default=1)
    ap.add_argument("--w-geom-ao-af-momentum", type=float, default=2800.0)
    ap.add_argument("--w-mom-list", type=float, nargs="+", default=[300.0, 1000.0])
    args = ap.parse_args()

    base = load_config(args.config)
    rows: List[Dict[str, Any]] = []

    print(
        f"\n=== Long Layer-1 comparison ===\n"
        f"config={args.config}\n"
        f"W_geom_ao_af_momentum={args.w_geom_ao_af_momentum:g}\n"
        f"W_MOM values={args.w_mom_list}\n"
        f"layer1_max_iterations={args.layer1_max_iterations}\n"
        f"layer1_cma_restarts={args.layer1_cma_restarts}\n"
    )

    for w_mom in args.w_mom_list:
        cfg = copy.deepcopy(base)
        req = cfg.design_requirements.model_dump()
        req["W_MOM"] = float(w_mom)
        req["W_geom_ao_af_momentum"] = float(args.w_geom_ao_af_momentum)

        pcfg = {
            "mode": "optimizer_controlled",
            "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
            "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
        }

        print(f"\n--- Starting run W_MOM={w_mom:g} ---\n")

        opt_cfg, results = run_layer1_optimization(
            cfg,
            PintleEngineRunner(copy.deepcopy(base)),
            req,
            target_burn_time=float(req.get("target_burn_time", 6.0)),
            tolerances={"thrust": 0.10, "apogee": 0.15},
            pressure_config=pcfg,
            layer1_smoke=False,
            layer1_max_iterations=int(args.layer1_max_iterations),
            layer1_cma_restarts=int(args.layer1_cma_restarts),
        )
        perf = results.get("performance") or {}
        rows.append(_collect(float(w_mom), opt_cfg, perf))

    print("\n" + "=" * 100)
    print("SUMMARY TABLE")
    print("=" * 100)
    hdr = (
        f"{'W_MOM':>8} {'F[N]':>10} {'MR':>8} {'R':>8} {'dP_O/Pc':>10} {'dP_F/Pc':>10} "
        f"{'AoAf':>8} {'exp_R1':>8} {'P_O_psi':>10} {'P_F_psi':>10} {'dp_oors':>8}"
    )
    print(hdr)
    print("-" * 100)
    for r in rows:
        print(
            f"{r['W_MOM']:>8g} {_f(r['F']):>10.2f} {_f(r['MR']):>8.4f} {_f(r['R']):>8.4f} "
            f"{_f(r['dP_O_Pc']):>10.4f} {_f(r['dP_F_Pc']):>10.4f} "
            f"{_f(r['AoAf_geom']):>8.4f} {_f(r['expected_AO_AF_R1']):>8.4f} "
            f"{_f(r['P_O_psi']):>10.2f} {_f(r['P_F_psi']):>10.2f} {str(r['injector_dp_oors']):>8}"
        )

    print("\n--- Injector geometry ---\n")
    for r in rows:
        print(
            f"W_MOM={r['W_MOM']:g}: n_O={r.get('n_O')} d_O={_f(r.get('d_O_mm')):.4f} mm  "
            f"spacing_O={_f(r.get('spacing_O_mm')):.4f} mm  imp_O={_f(r.get('imp_deg_O')):.2f}° | "
            f"n_F={r.get('n_F')} d_F={_f(r.get('d_F_mm')):.4f} mm  "
            f"spacing_F={_f(r.get('spacing_F_mm')):.4f} mm  imp_F={_f(r.get('imp_deg_F')):.2f}°"
        )

    scored = [( _score(r), r["W_MOM"], r) for r in rows]
    scored.sort(key=lambda x: x[0])
    best_score, best_w, best_row = scored[0]
    print("\n" + "=" * 100)
    print("COMPROMISE VERDICT (weighted distance to R≈1, MR≈3.5, F≈8000 N, fuel ΔP/Pc ≤ ~1.2)")
    print("=" * 100)
    for s, wm, rr in scored:
        print(f"  W_MOM={wm:g}  composite_score={s:.6f}")
    print(
        f"\nBest compromise by this scalar: **W_MOM = {best_w:g}** "
        f"(score={best_score:.6f}). Inspect row above for thrust / ΔP trade-offs.\n"
    )


if __name__ == "__main__":
    main()
