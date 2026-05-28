#!/usr/bin/env python3
"""Equal LOX/fuel stagnation tanks + modeled feed ΔP allocation (three pressure levels).

For each stagnation pressure **P_tank_O = P_tank_F = P₀** ∈ {700, 800, 900} psi:

* Tanks are **frozen** in Layer‑1 (not optimized).
* **Different injector inlets** arise from hydraulic feed losses: ``P_inj = P_tank − ΔP_feed``.
* **Reject** evaluation rows when any of:

  - ``P_inj ≤ Pc`` on either stream (no meaningful injector ΔP toward the chamber).
  - **Negative feed** (diagnostic ``ΔP_feed < 0`` or ``P_inj > P_tank``).
  - Chamber/nozzle reported **unchoked**: ``chamber_intrinsics["is_choked"] is False`` (see
    ``calculate_chamber_intrinsics`` — uses ``P_back/Pc`` vs critical ratio).
  - **Feed loss fraction** ``f_feed = ΔP_feed / (P_tank − Pc)`` exceeds ``--max-feed-fraction``
    on **either** stream (default ``0.60`` captures “>&nbsp;50–60 % extreme” envelope).

Hydraulic bookkeeping matches ``study_fixed_tanks_feed_allocation.py``.

Does **not** change Cd / injector equations.

Outputs one CSV aggregating every replay row with ``P_equal_psi`` and rejection flags.

Example::

  python scripts/study_equal_tank_pressure_feed_allocation.py \\
    --output-csv output/study_equal_tank_pressure_feed_allocation.csv

"""

from __future__ import annotations

import argparse
import copy
import csv
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

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
PC_MARGIN_PA = 2.0  # numerical slack for P_inj > Pc check


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


def _inj_diag(res: Dict[str, Any], key: str):
    ip = res.get("injector_pressure") if isinstance(res.get("injector_pressure"), dict) else {}
    di = res.get("diagnostics") if isinstance(res.get("diagnostics"), dict) else {}
    v = ip.get(key)
    if v is None or not np.isfinite(float(v)):
        v = di.get(key)
    if v is None or not np.isfinite(float(v)):
        return None
    return float(v)


def _evaluate_row_equal_tanks(
    cfg_template: Path,
    h: Dict[str, Any],
    *,
    P_equal_psi: float,
    dp_inj_pc_lo: float,
    dp_inj_pc_hi: float,
    max_feed_fraction: float,
) -> Dict[str, Any]:
    P_tank_psi = float(P_equal_psi)
    p_to = P_tank_psi * PSI_TO_PA
    p_tf = P_tank_psi * PSI_TO_PA
    rej: List[str] = []
    row: Dict[str, Any] = {
        "P_equal_psi": P_tank_psi,
        "P_tank_O_psi": P_tank_psi,
        "P_tank_F_psi": P_tank_psi,
        "source_iter": int(h.get("iteration", -2)),
        "accepted_strict": False,
        "reject_reason": "",
        "is_choked": None,
        "P_back_over_Pc": None,
        "geom_line": "",
    }
    cfg = load_config(str(cfg_template))
    _apply_hist_to_cfg(cfg, h)
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

    ci = res.get("chamber_intrinsics")
    if isinstance(ci, dict):
        row["is_choked"] = ci.get("is_choked")
        row["P_back_over_Pc"] = ci.get("actual_pressure_ratio")
        if ci.get("is_choked") is False:
            rej.append("nozzle_unchoked(P_back/Pc>P_crit)")
        if ci.get("is_choked") is None:
            rej.append("missing_is_choked_flag")
    else:
        rej.append("missing_chamber_intrinsics")
        row["is_choked"] = None

    P_inj_O = _inj_diag(res, "P_injector_O")
    P_inj_F = _inj_diag(res, "P_injector_F")
    d_inj_O = _inj_diag(res, "delta_p_injector_O")
    d_inj_F = _inj_diag(res, "delta_p_injector_F")
    d_fd_O = _inj_diag(res, "delta_p_feed_O")
    d_fd_F = _inj_diag(res, "delta_p_feed_F")

    if None in (P_inj_O, P_inj_F, d_inj_O, d_inj_F, d_fd_O, d_fd_F):
        row["reject_reason"] = "missing_pressure_diagnostics"
        return row

    if P_inj_O <= pc_pa + PC_MARGIN_PA:
        rej.append("P_inj_O_le_Pc")
    if P_inj_F <= pc_pa + PC_MARGIN_PA:
        rej.append("P_inj_F_le_Pc")

    d_feed_geom_O = p_to - P_inj_O
    d_feed_geom_F = p_tf - P_inj_F
    if d_fd_O < -1e-3 or d_fd_F < -1e-3:
        rej.append("diag_negative_delta_p_feed")
    if d_feed_geom_O < -1e-3:
        rej.append("negative_feed_allocation_O")
    if d_feed_geom_F < -1e-3:
        rej.append("negative_feed_allocation_F")

    dp_tot_O = p_to - pc_pa
    dp_tot_F = p_tf - pc_pa
    f_feed_O = (d_fd_O / dp_tot_O) if dp_tot_O > 1000.0 else float("nan")
    f_feed_F = (d_fd_F / dp_tot_F) if dp_tot_F > 1000.0 else float("nan")

    if np.isfinite(f_feed_O) and f_feed_O > max_feed_fraction:
        rej.append(f"feed_loss_fraction_O>{max_feed_fraction:.2f}")
    if np.isfinite(f_feed_F) and f_feed_F > max_feed_fraction:
        rej.append(f"feed_loss_fraction_F>{max_feed_fraction:.2f}")

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
            "goal_thrust_8k_tol10pct": abs(Fo / F_TARGET - 1.0) <= 0.10 if np.isfinite(Fo) else False,
            "geom_line": geom,
        }
    )

    row["accepted_strict"] = len(rej) == 0
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
    feed_pen = max(
        0.0,
        float(f_feed_O) - max_feed_fraction if np.isfinite(f_feed_O) else 0.0,
        float(f_feed_F) - max_feed_fraction if np.isfinite(f_feed_F) else 0.0,
    )
    row["_sort_key"] = (thrust_e, mr_e, r_e, f_err, feed_pen)

    return row


def _run_one_pressure_level(
    *,
    cfg_path: Path,
    P_equal_psi: float,
    throat_lo_mm2: float,
    throat_hi_mm2: float,
    layer1_max_iterations: int,
    layer1_cma_restarts: int,
    dp_lo: float,
    dp_hi: float,
    max_pressure_cap_margin_psi: float,
    max_feed_fraction: float,
    history_pick: int,
) -> List[Dict[str, Any]]:
    pe = float(P_equal_psi)
    max_lox_cap = pe + float(max_pressure_cap_margin_psi)
    max_fuel_cap = pe + float(max_pressure_cap_margin_psi)

    cfg = load_config(str(cfg_path))
    mid_mm2 = 0.5 * (float(throat_lo_mm2) + float(throat_hi_mm2))
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
    fp["P_O_start_psi"] = pe
    fp["P_F_start_psi"] = pe
    if cfg.chamber_geometry is not None:
        fp["expansion_ratio"] = float(cfg.chamber_geometry.expansion_ratio)
        fp["Lstar_mm"] = float(cfg.chamber_geometry.Lstar) * 1000.0
    req["frozen_parameters"] = fp

    req["layer1_A_throat_mm2_min"] = float(throat_lo_mm2)
    req["layer1_A_throat_mm2_max"] = float(throat_hi_mm2)
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

    print(f"\n--- P_equal = {pe:.1f} psi (Layer‑1 geometry+throat) ---")
    _opt_cfg, results = run_layer1_optimization(
        copy.deepcopy(cfg),
        PintleEngineRunner(copy.deepcopy(cfg)),
        req,
        target_burn_time=float(req.get("target_burn_time", 6.0)),
        tolerances={"thrust": 0.10, "apogee": 0.15},
        pressure_config=pcfg,
        layer1_smoke=False,
        layer1_max_iterations=int(layer1_max_iterations),
        layer1_cma_restarts=int(layer1_cma_restarts),
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
        if len(picked) >= int(history_pick):
            break

    rows_out: List[Dict[str, Any]] = []
    for h in picked:
        r = _evaluate_row_equal_tanks(
            cfg_path,
            h,
            P_equal_psi=pe,
            dp_inj_pc_lo=dp_lo,
            dp_inj_pc_hi=dp_hi,
            max_feed_fraction=max_feed_fraction,
        )
        rows_out.append(r)

    accepted = [r for r in rows_out if r["accepted_strict"]]
    good = sorted([r for r in accepted if isinstance(r.get("_sort_key"), tuple)], key=lambda z: z["_sort_key"])
    print(f"  Replay: {len(rows_out)} geometries | strictly accepted: {len(accepted)}")
    if good:
        b = good[0]
        print(
            f"  Best strictly-accepted sort: F={b['F_N']:.1f} N MR={b['MR']:.3f} R={b['R']:.3f} "
            f"Pc={b['Pc_psi']:.1f} psi  dP/Pc O={b['dP_inj_over_Pc_O']:.3f} F={b['dP_inj_over_Pc_F']:.3f}  "
            f"f_feed O={b['feed_loss_fraction_O']:.3f} F={b['feed_loss_fraction_F']:.3f}  "
            f"choked={b.get('is_choked')}"
        )
    elif rows_out:
        # show mildest rejection
        nf = lambda r: (0 if r["accepted_strict"] else len(r.get("reject_reason", "").split(";")))
        probe = sorted(rows_out, key=nf)[0]
        print(f"  No strict accepts; example row: rejected={probe.get('reject_reason')}")

    return rows_out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument(
        "--pressure-psi",
        type=float,
        nargs="+",
        default=[700.0, 800.0, 900.0],
        help="Equal tank stagnation pressures [psi] to test (same for LOX and fuel)",
    )
    ap.add_argument("--throat-min-mm2", type=float, default=2520.0)
    ap.add_argument("--throat-max-mm2", type=float, default=2600.0)
    ap.add_argument("--layer1-max-iterations", type=int, default=280)
    ap.add_argument("--layer1-cma-restarts", type=int, default=2)
    ap.add_argument("--dp-inj-over-pc-min", type=float, default=0.15)
    ap.add_argument("--dp-inj-over-pc-max", type=float, default=0.40)
    ap.add_argument("--max-feed-fraction", type=float, default=0.60, help="Reject if f_feed>O or F exceeds this")
    ap.add_argument("--history-pick", type=int, default=48)
    ap.add_argument("--max-pressure-cap-margin-psi", type=float, default=100.0)
    ap.add_argument("--output-csv", type=str, default=str(ROOT / "output/study_equal_tank_pressure_feed_allocation.csv"))
    args = ap.parse_args()

    cfg_path = Path(args.config)
    if not cfg_path.is_absolute():
        cfg_path = ROOT / cfg_path

    dp_lo = float(args.dp_inj_over_pc_min)
    dp_hi = float(args.dp_inj_over_pc_max)
    all_rows: List[Dict[str, Any]] = []

    print("Equal tank pressure feed-allocation study")
    print(f"  Levels [psi]: {args.pressure_psi}")
    print(f"  Throat [{args.throat_min_mm2:.0f}, {args.throat_max_mm2:.0f}] mm²")
    print(f"  ΔP_inj/Pc goal band [{dp_lo:.2f}, {dp_hi:.2f}] | max feed frac {args.max_feed_fraction:.2f}")
    print("  Strict reject: P_inj≤Pc | negative ΔP_feed | unchoked | f_feed too high")

    for pe in args.pressure_psi:
        rows = _run_one_pressure_level(
            cfg_path=cfg_path,
            P_equal_psi=float(pe),
            throat_lo_mm2=float(args.throat_min_mm2),
            throat_hi_mm2=float(args.throat_max_mm2),
            layer1_max_iterations=int(args.layer1_max_iterations),
            layer1_cma_restarts=int(args.layer1_cma_restarts),
            dp_lo=dp_lo,
            dp_hi=dp_hi,
            max_pressure_cap_margin_psi=float(args.max_pressure_cap_margin_psi),
            max_feed_fraction=float(args.max_feed_fraction),
            history_pick=int(args.history_pick),
        )
        all_rows.extend(rows)

    out_path = Path(args.output_csv)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    preferred = [
        "P_equal_psi",
        "accepted_strict",
        "reject_reason",
        "source_iter",
        "is_choked",
        "P_back_over_Pc",
        "F_N",
        "MR",
        "R",
        "Pc_psi",
        "delta_p_inj_O_psi",
        "delta_p_inj_F_psi",
        "delta_p_feed_O_psi",
        "delta_p_feed_F_psi",
        "dP_inj_over_Pc_O",
        "dP_inj_over_Pc_F",
        "feed_loss_fraction_O",
        "feed_loss_fraction_F",
        "goal_dp_band_O",
        "goal_dp_band_F",
        "goal_mr_3p5_tol6pct",
        "goal_R_unity_tol10pct",
        "goal_thrust_8k_tol10pct",
        "n_O",
        "n_F",
        "d_jet_O_mm",
        "d_jet_F_mm",
        "spacing_O_mm",
        "spacing_F_mm",
        "theta_O_deg",
        "theta_F_deg",
        "A_throat_mm2",
        "geom_line",
        "budget_residual_O_Pa",
        "budget_residual_F_Pa",
    ]
    if all_rows:
        extras = sorted(k for k in all_rows[0].keys() if k not in preferred and not str(k).startswith("_"))
        fieldnames = [k for k in preferred if k in all_rows[0]] + extras
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            w.writeheader()
            for r in all_rows:
                w.writerow({k: r.get(k) for k in fieldnames})

    na = sum(1 for r in all_rows if r.get("accepted_strict"))
    print(f"\nWrote {out_path}  (total rows={len(all_rows)}, strictly accepted={na})")


if __name__ == "__main__":
    main()
