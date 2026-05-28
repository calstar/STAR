#!/usr/bin/env python3
"""
Audit Gemini-style proposals without changing repo defaults.

1) High tank-pressure sweep (evaluate-only): geometry fixed near mission; sweep P_O,P_F up to ~1150 psi.
2) Layer 1 W_MOM sensitivity (75 / 300 / 1000 / 3000), smoke CMA, shared short budget.
3) Layer 1 with n_elements_O/F frozen (25 / 63), other impinging DOFs + pressures free.

Run from repo root:
  PYTHONPATH=. python scripts/audit_gemini_proposals.py
  PYTHONPATH=. python scripts/audit_gemini_proposals.py --layer1-iters 8   # faster

Uses configs/impinging_lox_ch4_8000N.yaml (deepcopy only).
"""

from __future__ import annotations

import argparse
import copy
import math
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner
from engine.optimizer.injector_dp_penalty import injector_dp_ratios_from_eval_result
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization
from engine.pipeline.io import load_config

PSI_TO_PA = 6894.757293168361
TARGET_F = 8000.0
TARGET_MR = 3.5


def ambient_pa(cfg) -> float:
    el = float(getattr(cfg.environment, "elevation", 0.0) or 0.0)
    return float(
        101325.0
        * math.exp(-0.0289644 * 9.80665 * el / (8.31447 * 288.15))
    )


def mission_metrics(result: Dict[str, Any]) -> Tuple[float, float, float, float, float, Optional[float]]:
    """Returns F, MR, R_mom, r_dp_o, r_dp_f, Pc."""
    F = float(result.get("F", float("nan")))
    MR = float(result.get("MR", float("nan")))
    diag = result.get("diagnostics") or {}
    Rm = diag.get("momentum_ratio_R")
    R_mom = float(Rm) if Rm is not None and np.isfinite(float(Rm)) else float("nan")
    pc = float(result.get("Pc", float("nan")))
    ro, rf = injector_dp_ratios_from_eval_result(pc, result)
    return F, MR, R_mom, float(ro or np.nan), float(rf or np.nan), pc


def full_mission_ok(
    F: float,
    MR: float,
    R_mom: float,
    r_o: float,
    r_f: float,
    *,
    thrust_band: float = 0.05,
    mr_band: float = 0.05,
    r_band: float = 0.10,
    dp_lo: float = 0.20,
    dp_hi: float = 0.35,
) -> bool:
    if not np.isfinite(F) or TARGET_F <= 0:
        return False
    if abs(F / TARGET_F - 1.0) > thrust_band:
        return False
    if not np.isfinite(MR) or TARGET_MR <= 0 or abs(MR / TARGET_MR - 1.0) > mr_band:
        return False
    if not np.isfinite(R_mom) or abs(R_mom - 1.0) > r_band:
        return False
    if not np.isfinite(r_o) or not np.isfinite(r_f):
        return False
    if not (dp_lo <= r_o <= dp_hi and dp_lo <= r_f <= dp_hi):
        return False
    return True


def fuel_geometry_for_ratio(a_o: float, ratio_ao_af: float, n_f: int) -> float:
    a_f = a_o / ratio_ao_af
    return float(2.0 * math.sqrt(max(a_f, 1e-12) / (math.pi * max(n_f, 1))))


def task1_high_pressure_sweep(cfg_base, p_lo: float, p_hi: float, n_steps: int) -> None:
    print("\n" + "=" * 70)
    print("TASK 1 — Tank pressure sweep (evaluate-only; ceilings not binding here)")
    print("  Nominal YAML max LOX ~700 psi caps *optimizer* bounds, not physics evaluate().")
    print("  Sweeping P_O,P_F directly up to high psi tests whether ΔP/Pc can enter [0.20,0.35]")
    print("  while staying near F≈8000, MR≈3.5, R≈1 (same frozen throat geometry).")
    print("=" * 70)

    cfg = copy.deepcopy(cfg_base)
    pa = ambient_pa(cfg)

    n_o, d_o = 25, 0.00244
    n_f = 63
    ao_af = TARGET_MR / math.sqrt(cfg.fluids["oxidizer"].density / cfg.fluids["fuel"].density)
    a_o = n_o * math.pi * (d_o / 2.0) ** 2
    d_f = fuel_geometry_for_ratio(a_o, ao_af, n_f)

    cfg.injector.geometry.oxidizer.n_elements = n_o
    cfg.injector.geometry.oxidizer.d_jet = d_o
    cfg.injector.geometry.fuel.n_elements = n_f
    cfg.injector.geometry.fuel.d_jet = d_f

    po_list = np.linspace(p_lo, p_hi, int(n_steps))
    pf_list = np.linspace(p_lo, p_hi, int(n_steps))

    hits_full = []
    mission_band = []  # thrust/MR/R only (ΔP unconstrained)

    runner = PintleEngineRunner(cfg)
    n_ok = 0
    for po in po_list:
        for pf in pf_list:
            try:
                res = runner.evaluate(float(po) * PSI_TO_PA, float(pf) * PSI_TO_PA, P_ambient=pa, silent=True)
                n_ok += 1
            except Exception:
                continue
            F, MR, Rm, ro, rf, _pc = mission_metrics(res)
            if full_mission_ok(F, MR, Rm, ro, rf):
                hits_full.append((po, pf, F, MR, Rm, ro, rf))

            thrust_ok = np.isfinite(F) and abs(F / TARGET_F - 1.0) <= 0.05
            mr_ok = np.isfinite(MR) and abs(MR / TARGET_MR - 1.0) <= 0.05
            r_ok = np.isfinite(Rm) and abs(Rm - 1.0) <= 0.10
            if thrust_ok and mr_ok and r_ok and np.isfinite(rf) and np.isfinite(ro):
                mission_band.append((rf, ro, po, pf, F, MR, Rm))

    print(f"Grid {len(po_list)}×{len(pf_list)} = {len(po_list)*len(pf_list)} points, successful evaluates: {n_ok}")
    print(
        "Full-mission hits (|F|,|MR|,|R| gates + both ΔP/Pc ∈ [0.20,0.35]): "
        f"{len(hits_full)}"
    )
    if hits_full:
        for row in hits_full[:15]:
            print("  ", row)

    print(
        f"\nAmong points with |F-8000|/8000≤5%, |MR-3.5|/3.5≤5%, |R-1|≤10% (ΔP unconstrained): "
        f"N={len(mission_band)}"
    )
    if mission_band:
        rfs = [t[0] for t in mission_band]
        ros = [t[1] for t in mission_band]
        in_dp_band = sum(1 for t in mission_band if 0.20 <= t[0] <= 0.35 and 0.20 <= t[1] <= 0.35)
        print(f"  ΔP_F/Pc min/med/max: {min(rfs):.4f} / {float(np.median(rfs)):.4f} / {max(rfs):.4f}")
        print(f"  ΔP_O/Pc min/med/max: {min(ros):.4f} / {float(np.median(ros)):.4f} / {max(ros):.4f}")
        print(f"  Count with BOTH streams in [0.20, 0.35]: {in_dp_band}/{len(mission_band)}")
        mission_band.sort(key=lambda t: t[0])
        rf, ro, po, pf, F, MR, Rm = mission_band[0]
        print(
            "  Lowest fuel ΔP/Pc within mission kinematic band: "
            f"ΔP_F/Pc={rf:.4f}, ΔP_O/Pc={ro:.4f}, P_O={po:.1f} psi, P_F={pf:.1f} psi, "
            f"F={F:.1f}, MR={MR:.4f}, R={Rm:.4f}"
        )


def patch_near_mission_seed(cfg):
    cfg.injector.geometry.oxidizer.n_elements = 25
    cfg.injector.geometry.oxidizer.d_jet = 0.00244
    cfg.injector.geometry.oxidizer.impingement_angle = 45.0
    cfg.injector.geometry.oxidizer.spacing = 0.008
    cfg.injector.geometry.fuel.n_elements = 63
    cfg.injector.geometry.fuel.d_jet = 0.00105
    cfg.injector.geometry.fuel.impingement_angle = 45.0
    cfg.injector.geometry.fuel.spacing = 0.008


def build_pressure_config(max_lox: float, max_fuel: float) -> Dict[str, Any]:
    return {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(max_lox),
        "max_fuel_pressure_psi": float(max_fuel),
    }


def summarize_layer1(tag: str, results: Dict[str, Any]) -> None:
    perf = results.get("performance") or {}
    pc = float(perf.get("Pc", float("nan")))
    F = float(perf.get("F", float("nan")))
    MR = float(perf.get("MR", float("nan")))
    Rm = perf.get("momentum_ratio_R")
    R_mom = float(Rm) if Rm is not None and np.isfinite(float(Rm)) else float("nan")
    ro = perf.get("injector_dp_ratio_O")
    rf = perf.get("injector_dp_ratio_F")
    if ro is None or rf is None or (not np.isfinite(float(ro))) or (not np.isfinite(float(rf))):
        _ro, _rf = injector_dp_ratios_from_eval_result(pc, perf)
        ro, rf = _ro, _rf
    ro_f = float(ro) if ro is not None and np.isfinite(float(ro)) else float("nan")
    rf_f = float(rf) if rf is not None and np.isfinite(float(rf)) else float("nan")

    ok = full_mission_ok(F, MR, R_mom, ro_f, rf_f)

    print(f"\n[{tag}]")
    print(
        f"  F={F:.2f} N  MR={MR:.4f}  R={R_mom:.4f}  "
        f"ΔP_O/Pc={ro_f}  ΔP_F/Pc={rf_f}  full-mission-feasible={ok}"
    )
    print(f"  P_O_opt_psi≈{perf.get('P_O_start_psi')}  P_F_opt_psi≈{perf.get('P_F_start_psi')}")
    failure_reasons = perf.get("failure_reasons") or []
    if failure_reasons:
        print(f"  failure_reasons: {failure_reasons[:5]}")


def run_layer1_case(
    *,
    tag: str,
    cfg_seed,
    requirements: Dict[str, Any],
    pressure_config: Dict[str, Any],
    layer1_iters: int,
) -> None:
    cfg = copy.deepcopy(cfg_seed)

    runner = PintleEngineRunner(copy.deepcopy(cfg))
    _, results = run_layer1_optimization(
        config_obj=cfg,
        runner=runner,
        requirements=requirements,
        target_burn_time=float(requirements.get("target_burn_time", 6.0)),
        tolerances={"thrust": 0.10, "apogee": 0.15},
        pressure_config=pressure_config,
        layer1_smoke=True,
        layer1_max_iterations=int(layer1_iters),
        layer1_cma_restarts=1,
    )
    summarize_layer1(tag, results)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layer1-iters", type=int, default=12, help="CMA generations per Layer-1 run (smoke)")
    ap.add_argument("--skip-layer1", action="store_true")
    args = ap.parse_args()

    cfg_base = load_config(str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))

    # -------- Task 1 --------
    task1_high_pressure_sweep(cfg_base, p_lo=450.0, p_hi=1150.0, n_steps=17)

    if args.skip_layer1:
        print("\n(--skip-layer1: W_MOM and frozen-n experiments not run)")
        return

    # Shared: raise *optimizer* tank bounds to 1200 psi (both) for these experiments only.
    max_p = 1200.0
    pressure_hi = build_pressure_config(max_p, max_p)

    print("\n" + "=" * 70)
    print("TASK 2 — W_MOM sensitivity (short smoke Layer 1)")
    print(f"  Tank caps in pressure_config: LOX/Fuel max = {max_p:.0f} psi")
    print(f"  layer1_max_iterations = {args.layer1_iters}, restarts = 1")
    print("=" * 70)

    for w_mom in (75.0, 300.0, 1000.0, 3000.0):
        cfg_seed = copy.deepcopy(cfg_base)
        patch_near_mission_seed(cfg_seed)
        req = cfg_seed.design_requirements.model_dump()
        req["W_MOM"] = float(w_mom)
        req["max_lox_tank_pressure_psi"] = max_p
        req["max_fuel_tank_pressure_psi"] = max_p
        run_layer1_case(
            tag=f"W_MOM={w_mom:g}",
            cfg_seed=cfg_seed,
            requirements=req,
            pressure_config=pressure_hi,
            layer1_iters=args.layer1_iters,
        )

    print("\n" + "=" * 70)
    print("TASK 3 — Frozen n_elements_O=25, n_elements_F=63 (other DOFs free)")
    print("=" * 70)
    cfg_seed = copy.deepcopy(cfg_base)
    patch_near_mission_seed(cfg_seed)
    req = cfg_seed.design_requirements.model_dump()
    req["max_lox_tank_pressure_psi"] = max_p
    req["max_fuel_tank_pressure_psi"] = max_p
    fp = dict(req.get("frozen_parameters") or {})
    fp["n_elements_O"] = 25
    fp["n_elements_F"] = 63
    req["frozen_parameters"] = fp
    run_layer1_case(
        tag="frozen_n_only",
        cfg_seed=cfg_seed,
        requirements=req,
        pressure_config=pressure_hi,
        layer1_iters=args.layer1_iters,
    )

    print("\n" + "=" * 70)
    print("TASK 4 — Interpretation printed inline per run (full-mission feasible?)")
    print("  Full-mission gate: |F-8000|/8000≤5%, |MR-3.5|/3.5≤5%, |R-1|≤10%,")
    print("  both ΔP_inj/Pc ∈ [0.20, 0.35].")
    print("=" * 70)


if __name__ == "__main__":
    main()
