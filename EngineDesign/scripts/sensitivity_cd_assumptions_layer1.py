#!/usr/bin/env python3
"""Cd **design-assumption** sensitivity (Layer‑1): vary ``Cd_inf`` / ``Cd_min`` only.

Does **not** change injector equations (``engine/core/injectors/impinging.py`` unchanged).
Does **not** commit new Cd defaults — cases override config in-memory before ``run_layer1_optimization``.

Cases (assume ``Cd_*`` applies to oxidizer vs fuel discharge caps::

  A baseline: Cd_O = 0.40, Cd_F = 0.30
  B:          Cd_O = 0.60, Cd_F = 0.60
  C:          Cd_O = 0.70, Cd_F = 0.70
  D:          Cd_O = 0.60, Cd_F = 0.70

``Cd_min`` per stream preserves the oxidizer:fuel baseline **ratio**
``Cd_min / Cd_inf`` from ``configs/impinging_lox_ch4_8000N.yaml`` (0.15/0.40 and 0.2/0.3).

Layer‑1 targets (via requirements):

- Thrust target 8000 N, MR target 3.5  
- Impinging R hinge [0.93, 1.07]  
- ΔP_inj/Pc hinge **both streams** [0.15, 0.40]  
- Tank pressures co‑optimized within CLI bands  
- Default throat band: Region B [2520, 2600] mm² ; optional ±12.5% around YAML ``A_throat``

Outputs one summary CSV plus per-console case blocks.

Example::

  python scripts/sensitivity_cd_assumptions_layer1.py \\
    --output-csv output/sensitivity_cd_layer1_summary.csv

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
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

F_TARGET = 8000.0
MR_TARGET = 3.5
# Baseline ratios from configs/impinging_lox_ch4_8000N.yaml discharge blocks
_RATIO_CD_MIN_INF_O = 0.15 / 0.40
_RATIO_CD_MIN_INF_F = 0.2 / 0.30

CASES: List[Tuple[str, float, float]] = [
    ("A_baseline", 0.40, 0.30),
    ("B", 0.60, 0.60),
    ("C", 0.70, 0.70),
    ("D", 0.60, 0.70),
]


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


def _apply_cd_caps(cfg: Any, cd_o_inf: float, cd_f_inf: float) -> Tuple[float, float, float, float]:
    ox = cfg.discharge["oxidizer"]
    fu = cfg.discharge["fuel"]
    cd_o_min = float(np.clip(cd_o_inf * _RATIO_CD_MIN_INF_O, 0.05, cd_o_inf - 1e-6))
    cd_f_min = float(np.clip(cd_f_inf * _RATIO_CD_MIN_INF_F, 0.05, cd_f_inf - 1e-6))
    cfg.discharge["oxidizer"] = ox.model_copy(update={"Cd_inf": float(cd_o_inf), "Cd_min": cd_o_min})
    cfg.discharge["fuel"] = fu.model_copy(update={"Cd_inf": float(cd_f_inf), "Cd_min": cd_f_min})
    return cd_o_inf, cd_o_min, cd_f_inf, cd_f_min


def _build_req_and_cfg(
    base_cfg_path: Path,
    *,
    throat_lo_mm2: float,
    throat_hi_mm2: float,
    p_o_lo: float,
    p_o_hi: float,
    p_f_lo: float,
    p_f_hi: float,
    max_lox_psi: float,
    max_fuel_psi: float,
) -> Tuple[Any, Dict[str, Any], Dict[str, Any]]:
    cfg = load_config(str(base_cfg_path))
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
    if cfg.chamber_geometry is not None:
        fp["expansion_ratio"] = float(cfg.chamber_geometry.expansion_ratio)
        fp["Lstar_mm"] = float(cfg.chamber_geometry.Lstar) * 1000.0
    req["frozen_parameters"] = fp

    req["layer1_A_throat_mm2_min"] = float(throat_lo_mm2)
    req["layer1_A_throat_mm2_max"] = float(throat_hi_mm2)
    req["layer1_P_O_start_psi_min"] = float(p_o_lo)
    req["layer1_P_O_start_psi_max"] = float(p_o_hi)
    req["layer1_P_F_start_psi_min"] = float(p_f_lo)
    req["layer1_P_F_start_psi_max"] = float(p_f_hi)
    req["max_lox_tank_pressure_psi"] = float(max_lox_psi)
    req["max_fuel_tank_pressure_psi"] = float(max_fuel_psi)

    req["injector_dp_ratio_O_min"] = 0.15
    req["injector_dp_ratio_O_max"] = 0.40
    req["injector_dp_ratio_F_min"] = 0.15
    req["injector_dp_ratio_F_max"] = 0.40

    req["impinging_momentum_R_min"] = 0.93
    req["impinging_momentum_R_max"] = 1.07

    req["W_MOM"] = 1600.0
    req["W_geom_ao_af_momentum"] = 6500.0
    req["W_DP"] = 380.0
    req["W_DP_O"] = 820.0
    req["W_DP_F"] = 820.0

    req["target_thrust"] = F_TARGET
    req["optimal_of_ratio"] = MR_TARGET

    req["require_stable_state"] = False
    req["min_stability_score"] = min(float(req.get("min_stability_score", 0.75)), 0.58)
    req["min_stability_margin"] = min(float(req.get("min_stability_margin", 1.2)), 1.05)
    req["layer1_infeasibility_gate_eps"] = 2.0e-3

    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(max_lox_psi),
        "max_fuel_pressure_psi": float(max_fuel_psi),
    }
    return cfg, req, pcfg


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--layer1-max-iterations", type=int, default=400)
    ap.add_argument("--layer1-cma-restarts", type=int, default=2)
    ap.add_argument(
        "--athroat-mode",
        type=str,
        choices=("region_b", "pct125"),
        default="region_b",
        help="region_b=[2520,2600] mm²; pct125=±12.5%% around YAML nominal A_throat_mm2",
    )
    ap.add_argument("--p-o-min-psi", type=float, default=580.0)
    ap.add_argument("--p-o-max-psi", type=float, default=700.0)
    ap.add_argument("--p-f-min-psi", type=float, default=350.0)
    ap.add_argument("--p-f-max-psi", type=float, default=500.0)
    ap.add_argument("--max-lox-pressure-psi", type=float, default=700.0)
    ap.add_argument("--max-fuel-pressure-psi", type=float, default=500.0)
    ap.add_argument("--output-csv", type=str, default=str(ROOT / "output/sensitivity_cd_layer1_summary.csv"))
    args = ap.parse_args()

    cfg_path = Path(args.config)
    if not cfg_path.is_absolute():
        cfg_path = ROOT / cfg_path

    probe = load_config(str(cfg_path))
    if args.athroat_mode == "region_b":
        throat_lo, throat_hi = 2520.0, 2600.0
    else:
        at0 = float(probe.chamber_geometry.A_throat) * 1e6
        throat_lo, throat_hi = at0 * 0.875, at0 * 1.125
        layer1_logger_info = "A_throat band ±12.5% from nominal {:.1f} mm² → [{:.1f}, {:.1f}]".format(
            at0, throat_lo, throat_hi
        )
        print(layer1_logger_info)

    cfg0, req, pcfg = _build_req_and_cfg(
        cfg_path,
        throat_lo_mm2=throat_lo,
        throat_hi_mm2=throat_hi,
        p_o_lo=args.p_o_min_psi,
        p_o_hi=args.p_o_max_psi,
        p_f_lo=args.p_f_min_psi,
        p_f_hi=args.p_f_max_psi,
        max_lox_psi=args.max_lox_pressure_psi,
        max_fuel_psi=args.max_fuel_pressure_psi,
    )

    print("Cd assumption sensitivity — Layer 1")
    print(
        "  Throat mm² [{:.0f}, {:.0f}]  |  P_O [{:.0f},{:.0f}]  |  P_F [{:.0f},{:.0f}]  |  "
        "ΔP/Pc [0.15,0.40] both  |  R [0.93,1.07]".format(
            throat_lo, throat_hi, args.p_o_min_psi, args.p_o_max_psi, args.p_f_min_psi, args.p_f_max_psi
        )
    )
    print(f"  max_iter={args.layer1_max_iterations}  cma_restarts={args.layer1_cma_restarts}\n")

    rows: List[Dict[str, Any]] = []

    for case_id, cd_o_assume, cd_f_assume in CASES:
        cfg = copy.deepcopy(cfg0)
        cdi_o, cdm_o, cdi_f, cdm_f = _apply_cd_caps(cfg, cd_o_assume, cd_f_assume)
        opt_cfg, results = run_layer1_optimization(
            copy.deepcopy(cfg),
            PintleEngineRunner(copy.deepcopy(cfg)),
            copy.deepcopy(req),
            target_burn_time=float(req.get("target_burn_time", 6.0)),
            tolerances={"thrust": 0.10, "apogee": 0.15},
            pressure_config=copy.deepcopy(pcfg),
            layer1_smoke=False,
            layer1_max_iterations=int(args.layer1_max_iterations),
            layer1_cma_restarts=int(args.layer1_cma_restarts),
        )
        perf = results.get("performance") or {}
        diag = perf.get("diagnostics") if isinstance(perf.get("diagnostics"), dict) else {}

        lt = getattr(opt_cfg.lox_tank, "initial_pressure_psi", None)
        ft = getattr(opt_cfg.fuel_tank, "initial_pressure_psi", None)
        poc = getattr(opt_cfg.chamber_geometry, "A_throat", None)
        at_mm2 = float(poc) * 1e6 if poc is not None and np.isfinite(float(poc)) else float("nan")

        ig = opt_cfg.injector.geometry
        cd_o_act = perf.get("Cd_O", diag.get("Cd_O"))
        cd_f_act = perf.get("Cd_F", diag.get("Cd_F"))

        geo = (
            f"LOX n={ig.oxidizer.n_elements} d={ig.oxidizer.d_jet*1000:.3f}mm "
            f"sp={ig.oxidizer.spacing*1000:.3f}mm θ={ig.oxidizer.impingement_angle:.1f}° | "
            f"F n={ig.fuel.n_elements} d={ig.fuel.d_jet*1000:.3f}mm "
            f"sp={ig.fuel.spacing*1000:.3f}mm θ={ig.fuel.impingement_angle:.1f}°"
        )

        row = {
            "case": case_id,
            "Cd_O_assumed_inf": cdi_o,
            "Cd_O_assumed_min": cdm_o,
            "Cd_F_assumed_inf": cdi_f,
            "Cd_F_assumed_min": cdm_f,
            "Cd_O_actual": cd_o_act,
            "Cd_F_actual": cd_f_act,
            "F_N": perf.get("F"),
            "MR": perf.get("MR"),
            "R": perf.get("momentum_ratio_R"),
            "dP_O_over_Pc": perf.get("injector_dp_ratio_O"),
            "dP_F_over_Pc": perf.get("injector_dp_ratio_F"),
            "P_O_tank_psi": float(lt) if lt is not None and np.isfinite(float(lt)) else None,
            "P_F_tank_psi": float(ft) if ft is not None and np.isfinite(float(ft)) else None,
            "A_throat_mm2": at_mm2,
            "injector_geometry": geo,
            "layer1_objective_approx": results.get("convergence_info", {}).get("final_change"),
        }
        rows.append(row)

        print(f"=== Case {case_id} (Cd_inf O={cdi_o}, F={cdi_f}; Cd_min O={cdm_o:.4f}, F={cdm_f:.4f}) ===")
        print(f"  actual Cd_O={cd_o_act}  Cd_F={cd_f_act}")
        print(f"  F={perf.get('F')} N  MR={perf.get('MR')}  R={perf.get('momentum_ratio_R')}")
        print(f"  ΔP_O/Pc={perf.get('injector_dp_ratio_O')}  ΔP_F/Pc={perf.get('injector_dp_ratio_F')}")
        print(f"  tanks P_O={lt} psi  P_F={ft} psi  At={at_mm2:.2f} mm²")
        print(f"  {geo}\n")

    outp = Path(args.output_csv)
    outp.parent.mkdir(parents=True, exist_ok=True)
    if rows:
        fieldnames = list(rows[0].keys())
        with open(outp, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(rows)
    print(f"Wrote {outp}")


if __name__ == "__main__":
    main()
