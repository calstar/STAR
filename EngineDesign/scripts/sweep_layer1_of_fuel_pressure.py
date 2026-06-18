#!/usr/bin/env python3
"""Sweep Layer-1 over target O/F and fuel tank pressure cap.

Each run: free throat ±12.5%, R ∈ [0.85, 1.15], ΔP_inj/Pc ∈ [0.15, 0.40] both streams,
target thrust 8000 N via ``design_requirements``, ``optimal_of_ratio`` sets MR target.

Writes CSV under ``output/layer1_sweep_of_fuel_pressure.csv`` and prints a summary table.
"""

from __future__ import annotations

import argparse
import copy
import csv
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

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


def _sf(x: Any) -> float:
    try:
        if x is None:
            return float("nan")
        v = float(x)
        return v if math.isfinite(v) else float("nan")
    except (TypeError, ValueError):
        return float("nan")


def _dp_ratios(perf: Dict[str, Any]) -> Tuple[float, float]:
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


def _cds(perf: Dict[str, Any]) -> Tuple[float, float]:
    diag = perf.get("diagnostics") or {}
    co = perf.get("Cd_O", diag.get("Cd_O"))
    cf = perf.get("Cd_F", diag.get("Cd_F"))
    return _sf(co), _sf(cf)


def _geom_row(opt_cfg: Any) -> str:
    ig = opt_cfg.injector.geometry
    return (
        f"LOX n={int(ig.oxidizer.n_elements)} d={ig.oxidizer.d_jet*1000:.3f}mm "
        f"sp={ig.oxidizer.spacing*1000:.3f}mm θ={ig.oxidizer.impingement_angle:.1f}° | "
        f"F n={int(ig.fuel.n_elements)} d={ig.fuel.d_jet*1000:.3f}mm "
        f"sp={ig.fuel.spacing*1000:.3f}mm θ={ig.fuel.impingement_angle:.1f}°"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--a-throat-center-mm2", type=float, default=2443.263433372886)
    ap.add_argument("--throat-span-fraction", type=float, default=0.125)
    ap.add_argument("--layer1-max-iterations", type=int, default=150)
    ap.add_argument("--layer1-cma-restarts", type=int, default=1)
    ap.add_argument("--output-csv", type=str, default=str(ROOT / "output/layer1_sweep_of_fuel_pressure.csv"))
    ap.add_argument(
        "--of-targets",
        type=str,
        default="3.5,3.7,4.0",
        help="Comma-separated optimal_of_ratio targets (default: 3.5,3.7,4.0)",
    )
    ap.add_argument(
        "--fuel-caps",
        type=str,
        default="900,800,700",
        help="Comma-separated max fuel tank pressure caps [psi] (default: 900,800,700)",
    )
    args = ap.parse_args()

    cfg_path = Path(args.config)
    center = float(args.a_throat_center_mm2)
    frac = float(args.throat_span_fraction)
    dp_band = (0.15, 0.40)
    r_lo, r_hi = 0.85, 1.15

    of_targets = [float(x.strip()) for x in args.of_targets.split(",") if x.strip()]
    fuel_caps_psi = [float(x.strip()) for x in args.fuel_caps.split(",") if x.strip()]

    rows: List[Dict[str, Any]] = []

    out_path = Path(args.output_csv)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    for of_tgt in of_targets:
        for pf_cap in fuel_caps_psi:
            cfg = load_config(str(cfg_path))
            if cfg.chamber_geometry is not None:
                cfg.chamber_geometry.design_MR = float(of_tgt)

            req = cfg.design_requirements.model_dump()
            _clean_frozen(req)

            req["target_thrust"] = 8000.0
            req["optimal_of_ratio"] = float(of_tgt)
            req["layer1_A_throat_mm2_min"] = center * (1.0 - frac)
            req["layer1_A_throat_mm2_max"] = center * (1.0 + frac)
            req["injector_dp_ratio_O_min"] = dp_band[0]
            req["injector_dp_ratio_O_max"] = dp_band[1]
            req["injector_dp_ratio_F_min"] = dp_band[0]
            req["injector_dp_ratio_F_max"] = dp_band[1]
            req["W_MOM"] = 300.0
            req["W_geom_ao_af_momentum"] = 2800.0
            req["impinging_momentum_R_min"] = float(r_lo)
            req["impinging_momentum_R_max"] = float(r_hi)

            req["max_fuel_tank_pressure_psi"] = float(pf_cap)

            pcfg = {
                "mode": "optimizer_controlled",
                "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
                "max_fuel_pressure_psi": float(pf_cap),
            }

            print(f"\n>>> OF_target={of_tgt}  max_fuel_psi={pf_cap:.0f}", flush=True)

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
            ro, rf = _dp_ratios(perf)
            cdo, cdf = _cds(perf)
            R = _sf(perf.get("momentum_ratio_R"))

            ci = results.get("convergence_info") or {}
            ls = results.get("layer_status") or {}
            diag = perf.get("diagnostics") if isinstance(perf.get("diagnostics"), dict) else {}
            finite_core = (
                math.isfinite(_sf(perf.get("F")))
                and math.isfinite(_sf(perf.get("MR")))
                and math.isfinite(_sf(perf.get("Pc")))
            )
            inj_succ = diag.get("constraints_satisfied")
            mdot_ratio = diag.get("mdot_ratio")

            row = {
                "OF_target": of_tgt,
                "max_fuel_psi_cap": pf_cap,
                "F_N": round(_sf(perf.get("F")), 2),
                "MR_actual": round(_sf(perf.get("MR")), 5),
                "R": round(R, 5),
                "dP_O_over_Pc": round(ro, 5),
                "dP_F_over_Pc": round(rf, 5),
                "P_O_psi": round(_sf(perf.get("P_O_start_psi")), 4),
                "P_F_psi": round(_sf(perf.get("P_F_start_psi")), 4),
                "Cd_O": round(cdo, 5),
                "Cd_F": round(cdf, 5),
                "injector_geometry": _geom_row(opt_cfg),
                "cma_converged": bool(ci.get("converged")),
                "pressure_candidate_valid": bool(ls.get("layer_1_pressure_candidate")),
                "finite_F_MR_Pc": bool(finite_core),
                "injector_constraints_ok": inj_succ if isinstance(inj_succ, bool) else "",
                "mdot_ratio_diag": mdot_ratio if mdot_ratio is not None else "",
                "thrust_ok_5pct": abs(_sf(perf.get("F")) - 8000.0) / 8000.0 <= 0.05,
                "dP_F_ok": dp_band[0] <= rf <= dp_band[1] if math.isfinite(rf) else False,
                "R_ok": r_lo <= R <= r_hi if math.isfinite(R) else False,
            }
            rows.append(row)

    fieldnames = list(rows[0].keys()) if rows else []
    if fieldnames:
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(rows)

    print("\n" + "=" * 100)
    print("SUMMARY (target thrust 8000 N, R∈[0.85,1.15], ΔP/Pc∈[0.15,0.40])")
    print("=" * 100)
    hdr = (
        f"{'OF':>5} {'P_F_cap':>8} {'F[N]':>8} {'MR':>8} {'R':>8} "
        f"{'dP_O':>8} {'dP_F':>8} {'P_O':>8} {'P_F':>8} {'Cd_O':>7} {'Cd_F':>7} "
        f"{'cma':>4} {'pCV':>4}"
    )
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(
            f"{r['OF_target']:5.1f} {r['max_fuel_psi_cap']:8.0f} {r['F_N']:8.1f} "
            f"{r['MR_actual']:8.4f} {r['R']:8.4f} {r['dP_O_over_Pc']:8.4f} {r['dP_F_over_Pc']:8.4f} "
            f"{r['P_O_psi']:8.1f} {r['P_F_psi']:8.1f} {r['Cd_O']:7.4f} {r['Cd_F']:7.4f} "
            f"{int(r['cma_converged']):4d} {int(r['pressure_candidate_valid']):4d}"
        )

    hits = [
        r
        for r in rows
        if r["thrust_ok_5pct"] and r["dP_F_ok"] and r["R_ok"] and dp_band[0] <= r["dP_O_over_Pc"] <= dp_band[1]
    ]
    print("\nJoint feasibility (|F−8000|/8000≤5%, both ΔP/Pc in band, R in band): ", end="")
    if hits:
        print(f"YES — {len(hits)} row(s)")
        for h in hits:
            print(f"  OF={h['OF_target']} P_F_cap={h['max_fuel_psi_cap']:.0f} → dP_F={h['dP_F_over_Pc']:.4f}")
    else:
        print("NO")

    if fieldnames:
        print(f"\nCSV written: {out_path}")


if __name__ == "__main__":
    main()
