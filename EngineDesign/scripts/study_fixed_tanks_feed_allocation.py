#!/usr/bin/env python3
"""Fixed stagnation tanks + feed-system ΔP allocation study (impinging injector).

Tank pressures are **frozen** (not optimized). Layer‑1 searches throat + injector geometry only.

Hydraulic bookkeeping (matches ``engine/core/injectors/impinging.py`` / ``report_pressure_budget_breakdown.py``)::

    P_inj = P_tank − ΔP_feed          (feed model gives ΔP_feed ≥ 0 at the solution)
    ΔP_inj = max(0, P_inj − Pc)       ⇒  P_inj = Pc + ΔP_inj   when P_inj ≥ Pc

    P_tank − Pc = ΔP_feed + ΔP_inj

**Feed loss fraction** (share of tank→chamber static head on each propellant path)::

    f_feed = ΔP_feed / (P_tank − Pc)

Candidates with **effective** negative feed allocation are rejected::
``P_inj > P_tank`` (⇒ ΔP_feed = P_tank − P_inj < 0), or diagnostics ``ΔP_feed < 0``.

Does **not** change Cd discharge models or injector mass-flow equations.

Workflow
~~~~~~~~

1. Run ``run_layer1_optimization`` with ``frozen_parameters`` pinning ``P_O_start_psi`` /
   ``P_F_start_psi`` to the chosen tank pressures.

2. Re-evaluate `layer1_best` + diversified ``iteration_history`` rows at the **same**
   stagnation pressures; extract pressures from ``runner.evaluate`` output.

Example::

  python scripts/study_fixed_tanks_feed_allocation.py \\
    --p-tank-o-psi 644 --p-tank-f-psi 410 \\
    --skip-layer1

"""

from __future__ import annotations

import argparse
import copy
import csv
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.optimizer.injector_dp_penalty import injector_dp_ratios_from_eval_result  # noqa: E402
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

PSI_TO_PA = 6894.76
PA_TO_PSI = 1.0 / PSI_TO_PA
F_TARGET = 8000.0
MR_TARGET = 3.5


def _strip_none_fp(fp: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in fp.items() if v is not None}


def _apply_throat_mm2(cfg: Any, mm2: float) -> None:
    cg = cfg.chamber_geometry
    if cg is None:
        raise ValueError("chamber_geometry required")
    At = float(mm2) * 1.0e-6
    eps = float(cg.expansion_ratio)
    Ae = eps * At
    cg.A_throat = At
    cg.A_exit = Ae
    cg.exit_diameter = 2.0 * math.sqrt(max(Ae, 1e-30) / math.pi)


def _hist_signature(h: Dict[str, Any]) -> Tuple[Any, ...]:
    return (
        round(float(h["A_throat"]), 14),
        int(h["n_elements_O"]),
        int(h["n_elements_F"]),
        round(float(h["d_jet_O"]), 8),
        round(float(h["d_jet_F"]), 8),
        round(float(h["spacing_O"]), 8),
        round(float(h["spacing_F"]), 8),
        round(float(h["impingement_angle_O"]), 4),
        round(float(h["impingement_angle_F"]), 4),
    )


def _apply_hist_to_cfg(cfg: Any, h: Dict[str, Any]) -> None:
    _apply_throat_mm2(cfg, float(h["A_throat"]) * 1e6)
    ig = cfg.injector.geometry
    ig.oxidizer.n_elements = int(h["n_elements_O"])
    ig.oxidizer.d_jet = float(h["d_jet_O"])
    ig.oxidizer.impingement_angle = float(h["impingement_angle_O"])
    ig.oxidizer.spacing = float(h["spacing_O"])
    ig.fuel.n_elements = int(h["n_elements_F"])
    ig.fuel.d_jet = float(h["d_jet_F"])
    ig.fuel.impingement_angle = float(h["impingement_angle_F"])
    ig.fuel.spacing = float(h["spacing_F"])


def _inj_diag(res: Dict[str, Any], key: str) -> Optional[float]:
    ip = res.get("injector_pressure") if isinstance(res.get("injector_pressure"), dict) else {}
    di = res.get("diagnostics") if isinstance(res.get("diagnostics"), dict) else {}
    v = ip.get(key)
    if v is None or not np.isfinite(float(v)):
        v = di.get(key)
    if v is None or not np.isfinite(float(v)):
        return None
    return float(v)


def _evaluate_feed_row(
    cfg_template: Path,
    h: Dict[str, Any],
    *,
    P_tank_O_psi: float,
    P_tank_F_psi: float,
    dp_inj_pc_lo: float,
    dp_inj_pc_hi: float,
) -> Dict[str, Any]:
    cfg = load_config(str(cfg_template))
    _apply_hist_to_cfg(cfg, h)
    p_to = float(P_tank_O_psi) * PSI_TO_PA
    p_tf = float(P_tank_F_psi) * PSI_TO_PA
    rej: List[str] = []
    row: Dict[str, Any] = {
        "P_tank_O_psi": float(P_tank_O_psi),
        "P_tank_F_psi": float(P_tank_F_psi),
        "source_iter": int(h.get("iteration", -2)),
        "accepted": False,
        "reject_reason": "",
        "geom_line": "",
    }
    try:
        runner = PintleEngineRunner(cfg)
        res = runner.evaluate(p_to, p_tf, silent=True)
    except Exception as e:
        row["reject_reason"] = f"eval_exception:{e}"
        return row

    pc_pa = float(res.get("Pc", float("nan")))
    if not np.isfinite(pc_pa) or pc_pa <= 0:
        row["reject_reason"] = "invalid_pc"
        return row

    P_inj_O = _inj_diag(res, "P_injector_O")
    P_inj_F = _inj_diag(res, "P_injector_F")
    d_inj_O = _inj_diag(res, "delta_p_injector_O")
    d_inj_F = _inj_diag(res, "delta_p_injector_F")
    d_fd_O = _inj_diag(res, "delta_p_feed_O")
    d_fd_F = _inj_diag(res, "delta_p_feed_F")

    if None in (P_inj_O, P_inj_F, d_inj_O, d_inj_F, d_fd_O, d_fd_F):
        row["reject_reason"] = "missing_pressure_diagnostics"
        return row

    # Physical rejection: injector inlet above tank ⇒ negative required feed restriction
    d_feed_geom_O = p_to - P_inj_O
    d_feed_geom_F = p_tf - P_inj_F
    if d_fd_O < -1e-3 or d_fd_F < -1e-3:
        rej.append("diag_negative_delta_p_feed")
    if d_feed_geom_O < -1e-3:
        rej.append("negative_feed_allocation_O(P_inj>P_tank)")
    if d_feed_geom_F < -1e-3:
        rej.append("negative_feed_allocation_F(P_inj>P_tank)")

    dp_tot_O = p_to - pc_pa
    dp_tot_F = p_tf - pc_pa
    f_feed_O = (d_fd_O / dp_tot_O) if dp_tot_O > 1000.0 else float("nan")
    f_feed_F = (d_fd_F / dp_tot_F) if dp_tot_F > 1000.0 else float("nan")

    budget_res_O = dp_tot_O - d_fd_O - d_inj_O
    budget_res_F = dp_tot_F - d_fd_F - d_inj_F

    ratio_o = (d_inj_O / pc_pa) if pc_pa > 0 else float("nan")
    ratio_f = (d_inj_F / pc_pa) if pc_pa > 0 else float("nan")
    ro, rf = injector_dp_ratios_from_eval_result(pc_pa, res)

    diag = res.get("diagnostics") if isinstance(res.get("diagnostics"), dict) else {}
    R = diag.get("momentum_ratio_R")
    Rv = float(R) if R is not None and np.isfinite(R) else float("nan")
    Fo = float(res.get("F", float("nan")))
    MRo = float(res.get("MR", float("nan")))

    ig = cfg.injector.geometry
    geom = (
        f"LOX n={ig.oxidizer.n_elements} d={ig.oxidizer.d_jet*1000:.4f}mm "
        f"sp={ig.oxidizer.spacing*1000:.4f}mm θ={ig.oxidizer.impingement_angle:.2f}° | "
        f"F n={ig.fuel.n_elements} d={ig.fuel.d_jet*1000:.4f}mm "
        f"sp={ig.fuel.spacing*1000:.4f}mm θ={ig.fuel.impingement_angle:.2f}°"
    )

    tgt_ok_o = dp_inj_pc_lo <= ratio_o <= dp_inj_pc_hi if np.isfinite(ratio_o) else False
    tgt_ok_f = dp_inj_pc_lo <= ratio_f <= dp_inj_pc_hi if np.isfinite(ratio_f) else False
    mr_ok = abs(MRo / MR_TARGET - 1.0) <= 0.06 if np.isfinite(MRo) else False
    r_ok = abs(Rv - 1.0) <= 0.10 if np.isfinite(Rv) else False

    row.update(
        {
            "F_N": Fo,
            "MR": MRo,
            "R": Rv,
            "Pc_psi": pc_pa * PA_TO_PSI,
            "Pc_Pa": pc_pa,
            "P_inj_O_psi": P_inj_O * PA_TO_PSI,
            "P_inj_F_psi": P_inj_F * PA_TO_PSI,
            "delta_p_inj_O_psi": d_inj_O * PA_TO_PSI,
            "delta_p_inj_F_psi": d_inj_F * PA_TO_PSI,
            "delta_p_feed_O_psi": d_fd_O * PA_TO_PSI,
            "delta_p_feed_F_psi": d_fd_F * PA_TO_PSI,
            "delta_P_tank_minus_Pc_O_psi": dp_tot_O * PA_TO_PSI,
            "delta_P_tank_minus_Pc_F_psi": dp_tot_F * PA_TO_PSI,
            "dP_inj_over_Pc_O": ratio_o,
            "dP_inj_over_Pc_F": ratio_f,
            "dP_inj_over_Pc_solver_O": float(ro) if ro is not None and np.isfinite(ro) else None,
            "dP_inj_over_Pc_solver_F": float(rf) if rf is not None and np.isfinite(rf) else None,
            "feed_loss_fraction_O": f_feed_O,
            "feed_loss_fraction_F": f_feed_F,
            "budget_residual_O_Pa": budget_res_O,
            "budget_residual_F_Pa": budget_res_F,
            "A_throat_mm2": float(h["A_throat"]) * 1e6,
            "n_O": int(h["n_elements_O"]),
            "n_F": int(h["n_elements_F"]),
            "d_jet_O_mm": float(h["d_jet_O"]) * 1000,
            "d_jet_F_mm": float(h["d_jet_F"]) * 1000,
            "spacing_O_mm": float(h["spacing_O"]) * 1000,
            "spacing_F_mm": float(h["spacing_F"]) * 1000,
            "theta_O_deg": float(h["impingement_angle_O"]),
            "theta_F_deg": float(h["impingement_angle_F"]),
            "goal_dp_band_O": tgt_ok_o,
            "goal_dp_band_F": tgt_ok_f,
            "goal_mr_3p5_tol6pct": mr_ok,
            "goal_R_unity_tol10pct": r_ok,
            "geom_line": geom,
        }
    )

    row["accepted"] = len(rej) == 0
    row["reject_reason"] = ";".join(rej) if rej else "ok"

    mr_e = abs(MRo / MR_TARGET - 1.0) if np.isfinite(MRo) else 1e9
    r_e = abs(Rv - 1.0) if np.isfinite(Rv) else 1e9
    f_err = (
        max(0.0, dp_inj_pc_lo - ratio_o, ratio_o - dp_inj_pc_hi) ** 2
        + max(0.0, dp_inj_pc_lo - ratio_f, ratio_f - dp_inj_pc_hi) ** 2
        if (np.isfinite(ratio_o) and np.isfinite(ratio_f))
        else 1e9
    )
    thrust_e = abs(Fo / F_TARGET - 1.0) if np.isfinite(Fo) else 1e9
    row["_sort_key"] = (thrust_e, mr_e, r_e, f_err)

    return row


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument(
        "--p-tank-o-psi",
        type=float,
        default=644.0,
        help="Fixed LOX tank stagnation pressure [psi] (not optimized)",
    )
    ap.add_argument(
        "--p-tank-f-psi",
        type=float,
        default=410.0,
        help="Fixed fuel tank stagnation pressure [psi] (not optimized)",
    )
    ap.add_argument("--throat-min-mm2", type=float, default=2520.0)
    ap.add_argument("--throat-max-mm2", type=float, default=2600.0)
    ap.add_argument("--layer1-max-iterations", type=int, default=320)
    ap.add_argument("--layer1-cma-restarts", type=int, default=2)
    ap.add_argument("--dp-inj-over-pc-min", type=float, default=0.15, help="Reporting / goal hinge lower")
    ap.add_argument("--dp-inj-over-pc-max", type=float, default=0.40, help="Reporting / goal hinge upper (both streams)")
    ap.add_argument("--history-pick", type=int, default=72)
    ap.add_argument(
        "--max-pressure-cap-margin-psi",
        type=float,
        default=50.0,
        help="pressure_config caps = tank + margin (must exceed stagnation pressures for Layer‑1 ratio checks)",
    )
    ap.add_argument("--skip-layer1", action="store_true", help="Only evaluate baseline YAML+jets at frozen tanks")
    ap.add_argument("--output-csv", type=str, default=str(ROOT / "output/study_fixed_tanks_feed_allocation.csv"))
    args = ap.parse_args()

    cfg_path = Path(args.config)
    if not cfg_path.is_absolute():
        cfg_path = ROOT / cfg_path

    dp_lo = float(args.dp_inj_over_pc_min)
    dp_hi = float(args.dp_inj_over_pc_max)
    po = float(args.p_tank_o_psi)
    pf = float(args.p_tank_f_psi)
    max_lox_cap = po + float(args.max_pressure_cap_margin_psi)
    max_fuel_cap = pf + float(args.max_pressure_cap_margin_psi)

    cfg = load_config(str(cfg_path))
    mid_mm2 = 0.5 * (float(args.throat_min_mm2) + float(args.throat_max_mm2))
    _apply_throat_mm2(cfg, mid_mm2)
    if cfg.chamber_geometry is not None:
        cfg.chamber_geometry.design_MR = float(cfg.design_requirements.optimal_of_ratio)

    ig0 = cfg.injector.geometry
    ig0.oxidizer.n_elements = 68
    ig0.oxidizer.d_jet = 1.424e-3
    ig0.oxidizer.spacing = 5.901e-3
    ig0.oxidizer.impingement_angle = 63.15
    ig0.fuel.n_elements = 32
    ig0.fuel.d_jet = 1.392e-3
    ig0.fuel.spacing = 4.118e-3
    ig0.fuel.impingement_angle = 75.05

    req = cfg.design_requirements.model_dump()
    fp = _strip_none_fp(dict(req.get("frozen_parameters") or {}))
    fp.pop("A_throat_mm2", None)
    fp.pop("P_O_start_psi", None)
    fp.pop("P_F_start_psi", None)
    fp["P_O_start_psi"] = po
    fp["P_F_start_psi"] = pf
    if cfg.chamber_geometry is not None:
        fp["expansion_ratio"] = float(cfg.chamber_geometry.expansion_ratio)
        fp["Lstar_mm"] = float(cfg.chamber_geometry.Lstar) * 1000.0
    req["frozen_parameters"] = fp

    req["layer1_A_throat_mm2_min"] = float(args.throat_min_mm2)
    req["layer1_A_throat_mm2_max"] = float(args.throat_max_mm2)
    req["max_lox_tank_pressure_psi"] = max(float(req.get("max_lox_tank_pressure_psi", 0.0)), max_lox_cap)
    req["max_fuel_tank_pressure_psi"] = max(float(req.get("max_fuel_tank_pressure_psi", 0.0)), max_fuel_cap)

    req["injector_dp_ratio_O_min"] = dp_lo
    req["injector_dp_ratio_O_max"] = dp_hi
    req["injector_dp_ratio_F_min"] = dp_lo
    req["injector_dp_ratio_F_max"] = dp_hi

    req["impinging_momentum_R_min"] = 0.93
    req["impinging_momentum_R_max"] = 1.07

    req["W_MOM"] = 1600.0
    req["W_geom_ao_af_momentum"] = 6500.0
    req["W_DP"] = 400.0
    req["W_DP_O"] = 900.0
    req["W_DP_F"] = 900.0

    req["target_thrust"] = F_TARGET
    req["optimal_of_ratio"] = MR_TARGET

    req["require_stable_state"] = False
    req["min_stability_score"] = min(float(req.get("min_stability_score", 0.75)), 0.58)
    req["min_stability_margin"] = min(float(req.get("min_stability_margin", 1.2)), 1.05)
    req["layer1_infeasibility_gate_eps"] = 2.0e-3

    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
        "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
    }

    print("Fixed stagnation tanks + feed ΔP allocation study")
    print(f"  P_tank_O = {po:.3f} psi   P_tank_F = {pf:.3f} psi  (frozen; not optimized)")
    print(f"  Throat [{args.throat_min_mm2:.0f}, {args.throat_max_mm2:.0f}] mm²")
    print(f"  Goal hinges: ΔP_inj/Pc ∈ [{dp_lo:.2f}, {dp_hi:.2f}] (both streams) | MR≈{MR_TARGET} | R≈1")
    print()
    print("Model: P_inj = P_tank − ΔP_feed ;  ΔP_inj = max(0, P_inj − Pc)  ⇒  P_tank − Pc = ΔP_feed + ΔP_inj")

    hist: List[Dict[str, Any]] = []

    if not args.skip_layer1:
        print("\nRunning Layer‑1 (geometry + throat only)...")
        _opt_cfg, results = run_layer1_optimization(
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
        hist = list(results.get("iteration_history") or [])
        oc = _opt_cfg.chamber_geometry
        og = _opt_cfg.injector.geometry
        assert oc is not None and og is not None
        hist.append(
            {
                "A_throat": float(oc.A_throat),
                "n_elements_O": int(og.oxidizer.n_elements),
                "d_jet_O": float(og.oxidizer.d_jet),
                "impingement_angle_O": float(og.oxidizer.impingement_angle),
                "spacing_O": float(og.oxidizer.spacing),
                "n_elements_F": int(og.fuel.n_elements),
                "d_jet_F": float(og.fuel.d_jet),
                "impingement_angle_F": float(og.fuel.impingement_angle),
                "spacing_F": float(og.fuel.spacing),
                "iteration": -1,
                "eval_success": True,
                "objective": float(results.get("convergence_info", {}).get("final_change", float("nan"))),
                "thrust": (results.get("performance") or {}).get("F"),
            }
        )
    else:
        cg = cfg.chamber_geometry
        ig = cfg.injector.geometry
        assert cg is not None
        hist = [
            {
                "A_throat": float(cg.A_throat),
                "n_elements_O": int(ig.oxidizer.n_elements),
                "d_jet_O": float(ig.oxidizer.d_jet),
                "impingement_angle_O": float(ig.oxidizer.impingement_angle),
                "spacing_O": float(ig.oxidizer.spacing),
                "n_elements_F": int(ig.fuel.n_elements),
                "d_jet_F": float(ig.fuel.d_jet),
                "impingement_angle_F": float(ig.fuel.impingement_angle),
                "spacing_F": float(ig.fuel.spacing),
                "iteration": -2,
                "eval_success": True,
                "thrust": None,
                "objective": float("nan"),
            }
        ]

    sorted_hist = sorted(hist, key=lambda z: float(z.get("objective", 1e30)))
    picked: List[Dict[str, Any]] = []
    seen_sig = set()
    for h in sorted_hist:
        if not h.get("eval_success"):
            continue
        if h.get("thrust") is not None:
            thrust_v = float(h["thrust"])
            if not np.isfinite(thrust_v):
                continue
        sig = _hist_signature(h)
        if sig in seen_sig:
            continue
        seen_sig.add(sig)
        picked.append(h)
        if len(picked) >= int(args.history_pick):
            break

    rows: List[Dict[str, Any]] = []
    for h in picked:
        r = _evaluate_feed_row(
            cfg_path,
            h,
            P_tank_O_psi=po,
            P_tank_F_psi=pf,
            dp_inj_pc_lo=dp_lo,
            dp_inj_pc_hi=dp_hi,
        )
        r["_hist_order"] = len(rows)
        rows.append(r)

    accepted = [r for r in rows if r["accepted"]]
    print("\n=== Summary ===")
    print(f"  Candidates replayed: {len(rows)}  |  Accepted (non‑negative feed): {len(accepted)}")

    good = sorted(
        [r for r in accepted if isinstance(r.get("_sort_key"), tuple)],
        key=lambda z: z["_sort_key"],  # type: ignore[arg-type]
    )
    if good:
        b = good[0]
        print("\nBest accepted candidate (combined distance to thrust→MR→R→ΔP band):")
        print(
            f"  F={b['F_N']:.2f} N  MR={b['MR']:.4f}  R={b['R']:.4f}  Pc={b['Pc_psi']:.2f} psi\n"
            f"  ΔP_inj/Pc: O={b['dP_inj_over_Pc_O']:.4f}  F={b['dP_inj_over_Pc_F']:.4f}\n"
            f"  f_feed (share of P_tank−Pc): O={b['feed_loss_fraction_O']:.4f}  F={b['feed_loss_fraction_F']:.4f}\n"
            f"  {b['geom_line']}"
        )
    else:
        print("\nNo accepted candidates — inspect reject_reason column in CSV.")

    out_path = Path(args.output_csv)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if rows:
        preferred = [
            "accepted",
            "reject_reason",
            "source_iter",
            "F_N",
            "MR",
            "R",
            "Pc_psi",
            "P_tank_O_psi",
            "P_tank_F_psi",
            "P_inj_O_psi",
            "P_inj_F_psi",
            "delta_p_inj_O_psi",
            "delta_p_inj_F_psi",
            "delta_p_feed_O_psi",
            "delta_p_feed_F_psi",
            "dP_inj_over_Pc_O",
            "dP_inj_over_Pc_F",
            "feed_loss_fraction_O",
            "feed_loss_fraction_F",
            "budget_residual_O_Pa",
            "budget_residual_F_Pa",
            "goal_dp_band_O",
            "goal_dp_band_F",
            "goal_mr_3p5_tol6pct",
            "goal_R_unity_tol10pct",
            "A_throat_mm2",
            "n_O",
            "n_F",
            "d_jet_O_mm",
            "d_jet_F_mm",
            "spacing_O_mm",
            "spacing_F_mm",
            "theta_O_deg",
            "theta_F_deg",
            "geom_line",
        ]
        extras = sorted(
            k
            for k in rows[0].keys()
            if not str(k).startswith("_") and k not in preferred
        )
        fieldnames = [k for k in preferred if k in rows[0]] + extras
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow({k: r.get(k) for k in fieldnames})
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
