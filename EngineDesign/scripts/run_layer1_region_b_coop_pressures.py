#!/usr/bin/env python3
"""Region B Layer‑1: impinging geometry + **co-optimized** tank pressures (narrow bands).

- ``layer1_A_throat_mm2_min/max`` = 2520–2600 mm²
- LOX tank search: ``layer1_P_O_start_psi_min/max`` default 580–700 psi
- Fuel tank search: ``layer1_P_F_start_psi_min/max`` default 350–500 psi
- ``pressure_config`` caps: max LOX 700 psi, max fuel 500 psi (for ratio guidance in Layer‑1)
- ``layer1_infeasibility_gate_eps`` = 2e-3 (see ``layer1_static_optimization``)

Post-process: re-evaluates history + best point; ranks by lexicographic priorities:

  1. Thrust near 8000 N  
  2. MR near 3.5  
  3. R near 1  
  4. Fuel ΔP/Pc near [0.40, 0.50]  
  5. Minimize LOX ΔP/Pc (lower is better)  

Does **not** change Cd or injector physics.

Example::

  python scripts/run_layer1_region_b_coop_pressures.py \\
    --output-csv output/layer1_region_b_coop_ranked.csv
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
from engine.optimizer.injector_dp_penalty import (  # noqa: E402
    injector_dp_ratios_from_eval_result,
    stream_injector_dp_band_hinge_squared,
)
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

PSI_TO_PA = 6894.76
F_TARGET = 8000.0
MR_TARGET = 3.5
LARGE = 1.0e9


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
        round(float(h.get("P_O_start_psi", -1.0)), 6),
        round(float(h.get("P_F_start_psi", -1.0)), 6),
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


def _prioritized_sort_key(ev: Dict[str, Any]) -> Tuple[float, float, float, float, float]:
    """Lower tuple is better: thrust err, MR err, |R−1|, fuel ΔP hinge, LOX ΔP/Pc."""
    Fo = float(ev.get("F", float("nan")))
    MRo = float(ev.get("MR", float("nan")))
    Rv = float(ev.get("R", float("nan")))
    r_o = float(ev.get("r_O", float("nan")))
    r_f = float(ev.get("r_F", float("nan")))
    thrust_e = abs(Fo / F_TARGET - 1.0) if np.isfinite(Fo) else LARGE
    mr_e = abs(MRo / MR_TARGET - 1.0) if np.isfinite(MRo) else LARGE
    r_e = abs(Rv - 1.0) if np.isfinite(Rv) else LARGE
    fuel_hinge = stream_injector_dp_band_hinge_squared(r_f, 0.40, 0.50)
    fuel_hinge = float(fuel_hinge) if np.isfinite(fuel_hinge) else LARGE
    lox_r = float(r_o) if (r_o is not None and np.isfinite(r_o)) else LARGE
    return (thrust_e, mr_e, r_e, fuel_hinge, lox_r)


def _evaluate_candidate(
    cfg_template: Any,
    h: Dict[str, Any],
    *,
    P_O_psi: float,
    P_F_psi: float,
) -> Optional[Dict[str, Any]]:
    cfg = copy.deepcopy(cfg_template)
    _apply_hist_to_cfg(cfg, h)
    try:
        runner = PintleEngineRunner(cfg)
        res = runner.evaluate(float(P_O_psi) * PSI_TO_PA, float(P_F_psi) * PSI_TO_PA, silent=True)
    except Exception as e:
        return {"error": str(e)}
    pc = float(res.get("Pc", float("nan")))
    if not math.isfinite(pc) or pc <= 0:
        return None
    ro, rf = injector_dp_ratios_from_eval_result(pc, res)
    diag = res.get("diagnostics") if isinstance(res.get("diagnostics"), dict) else {}
    R = diag.get("momentum_ratio_R")
    Rv = float(R) if R is not None and np.isfinite(R) else float("nan")
    Fo = float(res.get("F", float("nan")))
    MRo = float(res.get("MR", float("nan")))
    r_o = float(ro) if ro is not None and np.isfinite(ro) else float("nan")
    r_f = float(rf) if rf is not None and np.isfinite(rf) else float("nan")
    out = {
        "F": Fo,
        "MR": MRo,
        "Pc_MPa": pc / 1e6,
        "r_O": r_o,
        "r_F": r_f,
        "R": Rv,
        "P_O_psi_replay": float(P_O_psi),
        "P_F_psi_replay": float(P_F_psi),
        "iter": int(h.get("iteration", -1)),
        "hist_objective": float(h.get("objective", float("nan"))),
    }
    out["rank_key"] = _prioritized_sort_key(out)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--layer1-max-iterations", type=int, default=500)
    ap.add_argument("--layer1-cma-restarts", type=int, default=2)
    ap.add_argument("--p-o-min-psi", type=float, default=580.0)
    ap.add_argument("--p-o-max-psi", type=float, default=700.0)
    ap.add_argument("--p-f-min-psi", type=float, default=350.0)
    ap.add_argument("--p-f-max-psi", type=float, default=500.0)
    ap.add_argument("--max-lox-pressure-psi", type=float, default=700.0)
    ap.add_argument("--max-fuel-pressure-psi", type=float, default=500.0)
    ap.add_argument("--throat-min-mm2", type=float, default=2520.0)
    ap.add_argument("--throat-max-mm2", type=float, default=2600.0)
    ap.add_argument("--history-pick", type=int, default=80)
    ap.add_argument("--output-csv", type=str, default=str(ROOT / "output/layer1_region_b_coop_ranked.csv"))
    args = ap.parse_args()

    cfg_path = Path(args.config)
    if not cfg_path.is_absolute():
        cfg_path = ROOT / cfg_path

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
    if cfg.chamber_geometry is not None:
        fp["expansion_ratio"] = float(cfg.chamber_geometry.expansion_ratio)
        fp["Lstar_mm"] = float(cfg.chamber_geometry.Lstar) * 1000.0
    req["frozen_parameters"] = fp

    req["layer1_A_throat_mm2_min"] = float(args.throat_min_mm2)
    req["layer1_A_throat_mm2_max"] = float(args.throat_max_mm2)
    req["layer1_P_O_start_psi_min"] = float(args.p_o_min_psi)
    req["layer1_P_O_start_psi_max"] = float(args.p_o_max_psi)
    req["layer1_P_F_start_psi_min"] = float(args.p_f_min_psi)
    req["layer1_P_F_start_psi_max"] = float(args.p_f_max_psi)
    req["max_fuel_tank_pressure_psi"] = float(args.max_fuel_pressure_psi)
    req["max_lox_tank_pressure_psi"] = float(args.max_lox_pressure_psi)

    req["injector_dp_ratio_O_min"] = 0.15
    req["injector_dp_ratio_O_max"] = 0.40
    req["injector_dp_ratio_F_min"] = 0.40
    req["injector_dp_ratio_F_max"] = 0.50

    req["impinging_momentum_R_min"] = 0.93
    req["impinging_momentum_R_max"] = 1.07

    req["W_MOM"] = 1400.0
    req["W_geom_ao_af_momentum"] = 6500.0
    req["W_DP"] = 320.0
    req["W_DP_O"] = 720.0
    req["W_DP_F"] = 420.0

    req["target_thrust"] = F_TARGET
    req["optimal_of_ratio"] = MR_TARGET

    req["require_stable_state"] = False
    req["min_stability_score"] = min(float(req.get("min_stability_score", 0.75)), 0.58)
    req["min_stability_margin"] = min(float(req.get("min_stability_margin", 1.2)), 1.05)
    req["layer1_infeasibility_gate_eps"] = 2.0e-3

    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(args.max_lox_pressure_psi),
        "max_fuel_pressure_psi": float(args.max_fuel_pressure_psi),
    }

    print(
        "Region B Layer‑1 (co‑opt pressures) — "
        "At [{:.0f}, {:.0f}] mm² | P_O∈[{:.0f},{:.0f}] psi | P_F∈[{:.0f},{:.0f}] psi".format(
            args.throat_min_mm2,
            args.throat_max_mm2,
            args.p_o_min_psi,
            args.p_o_max_psi,
            args.p_f_min_psi,
            args.p_f_max_psi,
        )
    )
    print(
        "layer1_infeasibility_gate_eps={} | max_iter={} | cma_restarts={}".format(
            req["layer1_infeasibility_gate_eps"],
            int(args.layer1_max_iterations),
            int(args.layer1_cma_restarts),
        )
    )
    print()

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
    hist: List[Dict[str, Any]] = list(results.get("iteration_history") or [])

    lt = getattr(opt_cfg.lox_tank, "initial_pressure_psi", None)
    ft = getattr(opt_cfg.fuel_tank, "initial_pressure_psi", None)
    print("\n=== Layer‑1 reported optimum ===")
    print(f"Tanks psi: P_O={lt}  P_F={ft}")
    print(f"Thrust={perf.get('F')} N  MR={perf.get('MR')}  R={perf.get('momentum_ratio_R')}")
    print(f"ΔP_O/Pc={perf.get('injector_dp_ratio_O')}  ΔP_F/Pc={perf.get('injector_dp_ratio_F')}")
    ig = opt_cfg.injector.geometry
    print(
        f"Geometry LOX n={ig.oxidizer.n_elements} d={ig.oxidizer.d_jet*1000:.3f}mm "
        f"sp={ig.oxidizer.spacing*1000:.3f}mm θ={ig.oxidizer.impingement_angle:.1f}° | "
        f"F n={ig.fuel.n_elements} d={ig.fuel.d_jet*1000:.3f}mm "
        f"sp={ig.fuel.spacing*1000:.3f}mm θ={ig.fuel.impingement_angle:.1f}°"
    )

    sorted_hist = sorted(hist, key=lambda z: float(z.get("objective", 1e30)))
    picked: List[Dict[str, Any]] = []
    seen_sig = set()
    for h in sorted_hist:
        if not h.get("eval_success"):
            continue
        if h.get("thrust") is None or not np.isfinite(float(h["thrust"])):
            continue
        sig = _hist_signature(h)
        if sig in seen_sig:
            continue
        seen_sig.add(sig)
        picked.append(h)
        if len(picked) >= int(args.history_pick):
            break

    cfg_eval_base = load_config(str(cfg_path))

    oc = opt_cfg.chamber_geometry
    assert oc is not None
    poh = float(lt) if lt is not None and np.isfinite(float(lt)) else 640.0
    pfh = float(ft) if ft is not None and np.isfinite(float(ft)) else 400.0
    og = opt_cfg.injector.geometry
    h_final = {
        "A_throat": float(oc.A_throat),
        "n_elements_O": int(og.oxidizer.n_elements),
        "d_jet_O": float(og.oxidizer.d_jet),
        "impingement_angle_O": float(og.oxidizer.impingement_angle),
        "spacing_O": float(og.oxidizer.spacing),
        "n_elements_F": int(og.fuel.n_elements),
        "d_jet_F": float(og.fuel.d_jet),
        "impingement_angle_F": float(og.fuel.impingement_angle),
        "spacing_F": float(og.fuel.spacing),
        "P_O_start_psi": poh,
        "P_F_start_psi": pfh,
        "iteration": -1,
        "objective": float(results.get("convergence_info", {}).get("final_change", float("nan"))),
        "eval_success": True,
    }

    rows_out: List[Dict[str, Any]] = []

    def _row_from_hist(hh: Dict[str, Any], *, src: str) -> Optional[Dict[str, Any]]:
        po = float(hh["P_O_start_psi"])
        pf = float(hh["P_F_start_psi"])
        ev = _evaluate_candidate(cfg_eval_base, hh, P_O_psi=po, P_F_psi=pf)
        if ev is None or ev.get("error"):
            return None
        rk = ev["rank_key"]
        return {
            "source": src,
            "rank_thr_e": rk[0],
            "rank_mr_e": rk[1],
            "rank_R_e": rk[2],
            "rank_fuel_dp_hinge": rk[3],
            "rank_lox_dp_ratio": rk[4],
            "F_N": float(ev["F"]),
            "MR": float(ev["MR"]),
            "Pc_MPa": float(ev["Pc_MPa"]),
            "dP_O_over_Pc": float(ev["r_O"]),
            "dP_F_over_Pc": float(ev["r_F"]),
            "R": float(ev["R"]),
            "P_O_psi": po,
            "P_F_psi": pf,
            "A_throat_mm2": float(hh["A_throat"]) * 1e6,
            "n_O": int(hh["n_elements_O"]),
            "n_F": int(hh["n_elements_F"]),
            "d_jet_O_mm": float(hh["d_jet_O"]) * 1000,
            "d_jet_F_mm": float(hh["d_jet_F"]) * 1000,
            "spacing_O_mm": float(hh["spacing_O"]) * 1000,
            "spacing_F_mm": float(hh["spacing_F"]) * 1000,
            "theta_O_deg": float(hh["impingement_angle_O"]),
            "theta_F_deg": float(hh["impingement_angle_F"]),
            "hist_iter": int(ev["iter"]),
            "hist_objective": float(ev["hist_objective"]),
        }

    rf = _row_from_hist(h_final, src="layer1_best")
    if rf:
        rows_out.append(rf)

    for h in picked:
        row = _row_from_hist(h, src="history")
        if row:
            rows_out.append(row)

    rows_out.sort(key=lambda r: (r["rank_thr_e"], r["rank_mr_e"], r["rank_R_e"], r["rank_fuel_dp_hinge"], r["rank_lox_dp_ratio"]))

    def _row_key(r: Dict[str, Any]) -> Tuple[Any, ...]:
        return (
            round(float(r["A_throat_mm2"]), 3),
            int(r["n_O"]),
            int(r["n_F"]),
            round(float(r["d_jet_O_mm"]), 4),
            round(float(r["d_jet_F_mm"]), 4),
            round(float(r["spacing_O_mm"]), 3),
            round(float(r["spacing_F_mm"]), 3),
            round(float(r["theta_O_deg"]), 2),
            round(float(r["theta_F_deg"]), 2),
            round(float(r["P_O_psi"]), 4),
            round(float(r["P_F_psi"]), 4),
            r.get("source", ""),
        )

    dedup: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
    for r in rows_out:
        k = _row_key(r)
        if k not in dedup:
            dedup[k] = r
        else:
            old = dedup[k]
            old_key = (old["rank_thr_e"], old["rank_mr_e"], old["rank_R_e"], old["rank_fuel_dp_hinge"], old["rank_lox_dp_ratio"])
            new_key = (r["rank_thr_e"], r["rank_mr_e"], r["rank_R_e"], r["rank_fuel_dp_hinge"], r["rank_lox_dp_ratio"])
            if new_key < old_key:
                dedup[k] = r
    rows_out = sorted(
        dedup.values(),
        key=lambda r: (r["rank_thr_e"], r["rank_mr_e"], r["rank_R_e"], r["rank_fuel_dp_hinge"], r["rank_lox_dp_ratio"]),
    )

    out_path = Path(args.output_csv)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if rows_out:
        fieldnames = list(rows_out[0].keys())
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(rows_out)

    print("\n=== Top candidates (lexicographic rank key) ===")
    print("Order: thrust→MR→R→fuel ΔP band→min LOX ΔP/Pc | replay at stored P_O, P_F")
    for i, r in enumerate(rows_out[:15], start=1):
        print(
            f"{i:2d}  thr_e={r['rank_thr_e']:.4f}  mr_e={r['rank_mr_e']:.4f}  R_e={r['rank_R_e']:.4f}  "
            f"fuel_h={r['rank_fuel_dp_hinge']:.5f}  dP_O={r['dP_O_over_Pc']:.3f}  "
            f"P_O={r['P_O_psi']:.1f} P_F={r['P_F_psi']:.1f}  F={r['F_N']:.0f}  MR={r['MR']:.3f}  R={r['R']:.3f}  "
            f"dP_F={r['dP_F_over_Pc']:.3f}  At={r['A_throat_mm2']:.1f}"
        )
        print(
            f"      LOX n={r['n_O']} d={r['d_jet_O_mm']:.3f} sp={r['spacing_O_mm']:.3f} θ={r['theta_O_deg']:.1f}° | "
            f"F n={r['n_F']} d={r['d_jet_F_mm']:.3f} sp={r['spacing_F_mm']:.3f} θ={r['theta_F_deg']:.1f}°"
        )

    print(f"\nCSV: {out_path}")


if __name__ == "__main__":
    main()
