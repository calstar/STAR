#!/usr/bin/env python3
"""Follow-up free-throat Layer-1 grid: emphasize LOX ΔP/Pc band via W_DP_O ≥ W_DP_F.

Runs multiple optimizations (±12.5%% / ±15%% throat span × oxidizer ΔP weight sweep),
then ranks results by user's gates + LOX proximity preference toward 0.35.

Cd / injector physics unchanged (weights only).
"""

from __future__ import annotations

import argparse
import copy
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402


def _clean_frozen(req: Dict[str, Any]) -> None:
    fp = req.get("frozen_parameters")
    if not isinstance(fp, dict):
        fp = {}
    else:
        fp = {k: v for k, v in fp.items() if v is not None}
    fp.pop("A_throat_mm2", None)
    req["frozen_parameters"] = fp


def _injector_dp_ratios(perf: Dict[str, Any]) -> Tuple[float, float]:
    ro = perf.get("injector_dp_ratio_O")
    rf = perf.get("injector_dp_ratio_F")
    if ro is not None and rf is not None:
        return float(ro), float(rf)
    diag = perf.get("diagnostics") or {}
    pc = float(perf.get("Pc", float("nan")))
    dpo = diag.get("delta_p_injector_O")
    dpf = diag.get("delta_p_injector_F")
    ro_v = float(dpo) / pc if dpo is not None and pc > 0 else float("nan")
    rf_v = float(dpf) / pc if dpf is not None and pc > 0 else float("nan")
    return ro_v, rf_v


def _gates(
    perf: Dict[str, Any],
    *,
    o_band: Tuple[float, float],
    f_cap: float,
) -> Tuple[bool, bool, bool, bool, bool]:
    F = float(perf.get("F", float("nan")))
    MR = float(perf.get("MR", float("nan")))
    R = perf.get("momentum_ratio_R")
    R = float(R) if R is not None else float("nan")
    ro, rf = _injector_dp_ratios(perf)
    ok_f = abs(F - 8000.0) / 8000.0 <= 0.05 if math.isfinite(F) else False
    ok_mr = abs(MR - 3.5) / 3.5 <= 0.05 if math.isfinite(MR) else False
    ok_r = abs(R - 1.0) <= 0.10 if math.isfinite(R) else False
    ok_o = o_band[0] <= ro <= o_band[1] if math.isfinite(ro) else False
    ok_ff = rf <= f_cap if math.isfinite(rf) else False
    return ok_f, ok_mr, ok_r, ok_o, ok_ff


def _sf(x: Any) -> float:
    try:
        if x is None:
            return float("nan")
        v = float(x)
        return v if math.isfinite(v) else float("nan")
    except (TypeError, ValueError):
        return float("nan")


def _rank_key(
    perf: Dict[str, Any],
    *,
    o_band: Tuple[float, float],
    f_cap: float,
) -> Tuple[int, float, float]:
    """Sort ascending: fewer gate failures; lower LOX stress metric."""
    ok_f, ok_mr, ok_r, ok_o, ok_ff = _gates(perf, o_band=o_band, f_cap=f_cap)
    fails = sum(not x for x in (ok_f, ok_mr, ok_r, ok_o, ok_ff))

    ro, _rf = _injector_dp_ratios(perf)
    lo_o, hi_o = o_band
    if not math.isfinite(ro):
        return fails, 1e9, 1e9
    # Prefer LOX inside band hugging hi_o (0.35); penalize violations.
    if ro < lo_o:
        lox_primary = 1000.0 + (lo_o - ro)
        lox_secondary = lo_o - ro
    elif ro > hi_o:
        lox_primary = 500.0 + (ro - hi_o)
        lox_secondary = ro - hi_o
    else:
        lox_primary = hi_o - ro
        lox_secondary = abs(ro - hi_o)

    return fails, lox_primary, lox_secondary


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--a-throat-center-mm2", type=float, default=2443.263433372886)
    ap.add_argument("--layer1-max-iterations", type=int, default=110)
    ap.add_argument("--layer1-cma-restarts", type=int, default=1)
    ap.add_argument("--w-dp-base", type=float, default=160.0)
    args = ap.parse_args()

    cfg_path = Path(args.config)
    a_center = float(args.a_throat_center_mm2)
    w_base = float(args.w_dp_base)

    cases: List[Tuple[str, float, float, Optional[float], Optional[float]]] = [
        ("sym ±12.5%", 0.125, w_base, None, None),
        ("O-heavy ±12.5% ×1.5", 0.125, w_base, w_base * 1.5, w_base),
        ("O-heavy ±12.5% ×2", 0.125, w_base, w_base * 2.0, w_base),
        ("O-heavy ±15% ×1.5", 0.15, w_base, w_base * 1.5, w_base),
        ("O-heavy ±15% ×2", 0.15, w_base, w_base * 2.0, w_base),
        ("O-heavy ±15% ×2.25", 0.15, w_base, w_base * 2.25, w_base),
    ]

    rows: List[Dict[str, Any]] = []

    print("\n=== LOX-focused free-throat Layer-1 grid ===\n")

    for label, throat_frac, w_dp, w_o, w_f in cases:
        cfg = load_config(str(cfg_path))
        req = cfg.design_requirements.model_dump()
        _clean_frozen(req)

        req["layer1_A_throat_mm2_min"] = a_center * (1.0 - throat_frac)
        req["layer1_A_throat_mm2_max"] = a_center * (1.0 + throat_frac)

        req["W_MOM"] = 300.0
        req["W_geom_ao_af_momentum"] = 2800.0
        req["injector_dp_ratio_F_min"] = 0.5
        req["injector_dp_ratio_F_max"] = 1.5
        req["W_DP"] = float(w_dp)
        if w_o is not None:
            req["W_DP_O"] = float(w_o)
        else:
            req.pop("W_DP_O", None)
        if w_f is not None:
            req["W_DP_F"] = float(w_f)
        else:
            req.pop("W_DP_F", None)

        pcfg = {
            "mode": "optimizer_controlled",
            "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
            "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
        }

        print(f"\n--- Case: {label} ---")

        opt_cfg, results = run_layer1_optimization(
            copy.deepcopy(cfg),
            PintleEngineRunner(copy.deepcopy(cfg)),
            req,
            target_burn_time=float(req.get("target_burn_time", 6.0)),
            tolerances={"thrust": 0.10, "apogee": 0.15},
            pressure_config=pcfg,
            layer1_smoke=False,
            layer1_max_iterations=int(args.layer1_max_iterations),
            layer1_cma_restarts=int(args.layer1_cma_restarts),
        )
        perf = results.get("performance") or {}
        ro, rf = _injector_dp_ratios(perf)
        cg = getattr(opt_cfg, "chamber_geometry", None)
        atm = getattr(cg, "A_throat", None) if cg is not None else None
        a_mm2 = float(atm) * 1e6 if atm is not None else float("nan")

        ok_f, ok_mr, ok_r, ok_o, ok_ff = _gates(
            perf,
            o_band=(float(req["injector_dp_ratio_O_min"]), float(req["injector_dp_ratio_O_max"])),
            f_cap=float(req["injector_dp_ratio_F_max"]),
        )

        rows.append(
            {
                "label": label,
                "throat_frac": throat_frac,
                "W_DP": w_dp,
                "W_DP_O": w_o if w_o is not None else w_dp,
                "W_DP_F": w_f if w_f is not None else w_dp,
                "F": perf.get("F"),
                "MR": perf.get("MR"),
                "R": perf.get("momentum_ratio_R"),
                "dP_O": ro,
                "dP_F": rf,
                "A_throat_mm2": a_mm2,
                "P_O_psi": perf.get("P_O_start_psi"),
                "P_F_psi": perf.get("P_F_start_psi"),
                "ok_F": ok_f,
                "ok_MR": ok_mr,
                "ok_R": ok_r,
                "ok_LOX": ok_o,
                "ok_FuelCap": ok_ff,
                "perf": perf,
                "opt_cfg": opt_cfg,
            }
        )

    o_band = (0.20, 0.35)
    f_cap = 1.50

    rows_sorted = sorted(rows, key=lambda r: _rank_key(r["perf"], o_band=o_band, f_cap=f_cap))

    print("\n" + "=" * 110)
    print("RANKED CANDIDATES (best first)")
    print("Gates: |F−8000|/8000≤5%; |MR−3.5|/3.5≤5%; |R−1|≤10%; LOX ΔP/Pc∈[0.20,0.35]; fuel ΔP/Pc≤1.50")
    print("Secondary: minimize LOX violation / maximize LOX ΔP/Pc toward 0.35 inside band")
    print("=" * 110)

    hdr = (
        f"{'rank':>4} {'case':<26} {'At_mm2':>9} {'F':>9} {'MR':>7} {'R':>7} "
        f"{'dP_O':>7} {'dP_F':>7} {'gF':>3}{'gMR':>4}{'gR':>4}{'gO':>4}{'gf':>4}"
    )
    print(hdr)
    print("-" * len(hdr))

    for i, r in enumerate(rows_sorted, start=1):
        print(
            f"{i:4d} {r['label']:<26} {r['A_throat_mm2']:9.1f} "
            f"{_sf(r['F']):9.2f} {_sf(r['MR']):7.4f} {_sf(r['R']):7.4f} "
            f"{_sf(r['dP_O']):7.4f} {_sf(r['dP_F']):7.4f} "
            f"{'Y' if r['ok_F'] else 'N':>3}"
            f"{'Y' if r['ok_MR'] else 'N':>4}"
            f"{'Y' if r['ok_R'] else 'N':>4}"
            f"{'Y' if r['ok_LOX'] else 'N':>4}"
            f"{'Y' if r['ok_FuelCap'] else 'N':>4}"
        )

    best = rows_sorted[0]
    print("\nBest-ranked row:", best["label"])
    ig = best["opt_cfg"].injector.geometry
    print(
        f"  Injector  n_O={int(ig.oxidizer.n_elements)} d_O={ig.oxidizer.d_jet*1000:.4f} mm  "
        f"n_F={int(ig.fuel.n_elements)} d_F={ig.fuel.d_jet*1000:.4f} mm"
    )


if __name__ == "__main__":
    main()
