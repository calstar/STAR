#!/usr/bin/env python3
"""Feasibility sweep: impinging LOX/CH4 geometry vs ΔP/Pc band (no physics changes).

Loads a YAML config (default: configs/impinging_lox_ch4_8000N.yaml) with frozen
chamber/throat/nozzle, sweeps injector counts/orifice diameters (optional tank
pressures), runs runner.evaluate, and ranks cases vs design_requirements thrust/O/F
plus momentum R window and ΔP_inj/Pc band.

Before ``evaluate``, unrealistic impinging combinations are skipped (precheck tags
in ``Row.err``): area vs throat, face packing density, spacing / ring count / n·d_jet,
and coarse mdot-vs-throat proxies from tank PSI.

Usage (from repo root, with venv and PYTHONPATH=.):
  PYTHONPATH=. python scripts/feasibility_impinging_lox_ch4_sweep.py --config configs/impinging_lox_ch4_8000N.yaml
  PYTHONPATH=. python scripts/feasibility_impinging_lox_ch4_sweep.py --quick

Related: ``scripts/pareto_throat_dp_pressures.py`` sweeps throat area × tank-cap scenarios
and solves tank pressures for thrust/MR targets (geometry fixed from YAML).
"""

from __future__ import annotations

# Mission window for momentum ratio R (impinging diagnostics)
R_BAND_LO = 0.909
R_BAND_HI = 1.1
# Preferred injector ΔP/Pc per stream
DP_BAND_LO = 0.20
DP_BAND_HI = 0.35
# "Near" thrust / O/F for counting full mission hits (relative)
MISSION_F_REL = 0.05
MISSION_MR_REL = 0.05

import argparse
import copy
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

# Repo root = parent of scripts/
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner
from engine.core.injectors.flow_capacity import effective_flow_areas_from_cd
from engine.optimizer.injector_dp_penalty import injector_dp_ratios_from_eval_result
from engine.optimizer.layers.layer1_static_optimization import TOTAL_WALL_THICKNESS_M
from engine.optimizer.utils import (
    impinging_chamber_inner_diameter_for_bounds,
    impinging_d_jet_upper_bound_m,
    impinging_n_elements_hi_int,
    impinging_spacing_upper_bound_m,
)
from engine.pipeline.config_schemas import ensure_chamber_geometry
from engine.pipeline.io import load_config

PSI_TO_PA = 6894.76


def _symmetric_n_values(
    n_min: int,
    n_max: int,
    *,
    quick: bool,
    bins: Optional[int] = None,
    quick_clip_max: Optional[int] = None,
) -> List[int]:
    """Coarse n_grid: small engines keep step-5 sweep; large n_max uses ~8-bin linspace."""
    if n_max <= n_min:
        return [n_min]
    hi = min(n_max, quick_clip_max) if (quick and quick_clip_max is not None) else n_max
    if quick:
        nb = bins or 4
        return sorted({int(round(v)) for v in np.linspace(n_min, hi, num=nb)})
    if n_max <= 40:
        return list(range(n_min, n_max + 1, 5))
    nb = bins or 8
    return sorted({int(round(v)) for v in np.linspace(n_min, n_max, num=nb)})


def _geom_A(n: int, d_jet: float) -> float:
    return float(n) * np.pi * (d_jet / 2.0) ** 2


def _precheck_impinging_skip_reason(
    cfg,
    n_O: int,
    d_O: float,
    n_F: int,
    d_F: float,
    *,
    P_O_psi: float,
    P_F_psi: float,
) -> Optional[str]:
    """Return skip tag if geometry is unrealistic before runner.evaluate(); else None.

    Mirrors Layer-1 soft limits (area vs throat, packing, d_jet vs spacing) plus coarse
    Bernoulli mdot proxies using tank PSI and a guessed Pc so obviously oversized A_eff
    does not burn closure iterations.
    """
    try:
        cg = ensure_chamber_geometry(cfg)
        At = float(cg.A_throat or 0.0)
        D_inner = float(cg.chamber_diameter or 0.0)
    except Exception:
        return None
    if At <= 0 or not np.isfinite(At) or D_inner <= 0 or not np.isfinite(D_inner):
        return None

    A_go = _geom_A(n_O, d_O)
    A_gf = _geom_A(n_F, d_F)

    # --- 1) Geometric injector area vs throat (per-stream and combined) ---
    # Layer-1 penalizes effective-area ratios ~0.95 vs throat; use geometric cap pre-eval.
    if max(A_go, A_gf) / At > 0.92:
        return "precheck:max_geometric_area_vs_throat"
    if (A_go + A_gf) / At > 1.35:
        return "precheck:sum_geometric_area_vs_throat"

    # Cd-weighted capacity (discharge Cd_inf as upper-ish effective discharge)
    try:
        cd_o_cfg = float(getattr(cfg.discharge["oxidizer"], "Cd_inf", 0.4) or 0.4)
        cd_f_cfg = float(getattr(cfg.discharge["fuel"], "Cd_inf", 0.3) or 0.3)
    except Exception:
        cd_o_cfg, cd_f_cfg = 0.4, 0.3
    a_eff_o = max(cd_o_cfg, 0.08) * A_go
    a_eff_f = max(cd_f_cfg, 0.08) * A_gf
    if max(a_eff_o, a_eff_f) / At > 0.96:
        return "precheck:max_Aeff_vs_throat"
    if (a_eff_o + a_eff_f) / At > 1.15:
        return "precheck:sum_Aeff_vs_throat"

    # --- 2) Face packing (same form as Layer-1 infeasibility) ---
    g = cfg.injector.geometry
    sp_o = float(getattr(g.oxidizer, "spacing", 0.012) or 0.012)
    sp_f = float(getattr(g.fuel, "spacing", 0.012) or 0.012)
    face_a = np.pi * (D_inner / 2.0) ** 2
    pack = float(n_O + n_F) * max(sp_o, sp_f) ** 2
    if face_a > 0 and pack / face_a > 0.68:
        return "precheck:packing_density"

    # --- 3) Circumference / spacing vs d_jet ---
    circ = np.pi * D_inner
    if d_O >= sp_o * 0.998 or d_F >= sp_f * 0.998:
        return "precheck:d_jet_ge_spacing"
    if 2.0 * d_O > sp_o or 2.0 * d_F > sp_f:
        return "precheck:layer1_spacing_rule_2p0dj"
    # Jets cannot occupy more than ~full ring per stream (side-by-side diameter sum)
    if n_O > 0 and n_O * d_O > 1.08 * circ:
        return "precheck:n_O_d_O_vs_circ"
    if n_F > 0 and n_F * d_F > 1.08 * circ:
        return "precheck:n_F_d_F_vs_circ"
    k_ring = 1.65
    n_cap_o = max(int(circ / max(k_ring * d_O, 1e-9)), 1)
    n_cap_f = max(int(circ / max(k_ring * d_F, 1e-9)), 1)
    if n_O > n_cap_o + 2 or n_F > n_cap_f + 2:
        return "precheck:ring_element_count"

    # --- 4) Coarse mdot vs choked throat capacity (order-of-magnitude) ---
    try:
        rho_o = float(cfg.fluids["oxidizer"].density)
        rho_f = float(cfg.fluids["fuel"].density)
    except Exception:
        rho_o, rho_f = 1140.0, 422.6
    P_O = float(P_O_psi) * PSI_TO_PA
    P_F = float(P_F_psi) * PSI_TO_PA
    # Conservative chamber estimate: sub-fraction of weaker feed branch
    Pc_est = min(P_O, P_F) * 0.38
    Pc_est = max(Pc_est, 8.0e4)
    cstar_typ = 1580.0  # LOX/CH4-class c* [m/s] for mdot_cap order-of-magnitude only
    mdot_cap = max(Pc_est * At / cstar_typ, 1e-9)
    dP_o = max(P_O - Pc_est, 0.07 * P_O, 4.0e4)
    dP_f = max(P_F - Pc_est, 0.07 * P_F, 4.0e4)
    md_o = a_eff_o * np.sqrt(max(2.0 * rho_o * dP_o, 0.0))
    md_f = a_eff_f * np.sqrt(max(2.0 * rho_f * dP_f, 0.0))
    if md_o > 2.3 * mdot_cap or md_f > 2.3 * mdot_cap:
        return "precheck:mdot_proxy_stream_vs_throat"
    if md_o + md_f > 2.85 * mdot_cap:
        return "precheck:mdot_proxy_combined_vs_throat"

    return None


def _failed_row(
    n_O: int,
    d_O: float,
    n_F: int,
    d_F: float,
    P_O_psi: float,
    P_F_psi: float,
    err: str,
) -> Row:
    ag_o = _geom_A(n_O, d_O)
    ag_f = _geom_A(n_F, d_F)
    return Row(
        n_O,
        d_O,
        n_F,
        d_F,
        P_O_psi,
        P_F_psi,
        False,
        err,
        np.nan,
        np.nan,
        np.nan,
        np.nan,
        np.nan,
        np.nan,
        np.nan,
        np.nan,
        np.nan,
        np.nan,
        ag_o,
        ag_f,
    )


@dataclass
class Row:
    n_O: int
    d_O: float
    n_F: int
    d_F: float
    P_O_psi: float
    P_F_psi: float
    ok: bool
    err: str
    F: float
    MR: float
    Pc: float
    r_O: float
    r_F: float
    R: float
    Cd_O: float
    Cd_F: float
    A_eff_O: float
    A_eff_F: float
    A_geom_O: float
    A_geom_F: float


def _apply_impinging_geometry(cfg, n_O: int, d_O: float, n_F: int, d_F: float) -> None:
    g = cfg.injector.geometry
    g.oxidizer.n_elements = max(1, int(n_O))
    g.oxidizer.d_jet = float(d_O)
    g.fuel.n_elements = max(1, int(n_F))
    g.fuel.d_jet = float(d_F)


def _one_eval(
    base_cfg,
    n_O: int,
    d_O: float,
    n_F: int,
    d_F: float,
    P_O_psi: float,
    P_F_psi: float,
) -> Row:
    reason = _precheck_impinging_skip_reason(
        base_cfg,
        n_O,
        d_O,
        n_F,
        d_F,
        P_O_psi=P_O_psi,
        P_F_psi=P_F_psi,
    )
    if reason is not None:
        return _failed_row(n_O, d_O, n_F, d_F, P_O_psi, P_F_psi, reason)

    A_geom_O = _geom_A(n_O, d_O)
    A_geom_F = _geom_A(n_F, d_F)
    cfg = copy.deepcopy(base_cfg)
    try:
        _apply_impinging_geometry(cfg, n_O, d_O, n_F, d_F)
        runner = PintleEngineRunner(cfg)
        res = runner.evaluate(P_O_psi * PSI_TO_PA, P_F_psi * PSI_TO_PA, silent=True)
    except Exception as e:
        return _failed_row(
            n_O,
            d_O,
            n_F,
            d_F,
            P_O_psi,
            P_F_psi,
            type(e).__name__ + ": " + str(e)[:120],
        )

    pc = float(res.get("Pc") or np.nan)
    diag = res.get("diagnostics") if isinstance(res.get("diagnostics"), dict) else {}
    ro, rf = injector_dp_ratios_from_eval_result(pc, res)
    if ro is None:
        ro = np.nan
    if rf is None:
        rf = np.nan
    R = diag.get("momentum_ratio_R")
    if R is None:
        R = np.nan
    cd_o = diag.get("Cd_O")
    cd_f = diag.get("Cd_F")
    if cd_o is None:
        cd_o = np.nan
    if cd_f is None:
        cd_f = np.nan

    ae_o, ae_f, _ = effective_flow_areas_from_cd(diag, A_geom_O, A_geom_F)

    return Row(
        n_O,
        d_O,
        n_F,
        d_F,
        P_O_psi,
        P_F_psi,
        True,
        "",
        float(res.get("F", np.nan)),
        float(res.get("MR", np.nan)),
        pc,
        float(ro),
        float(rf),
        float(R),
        float(cd_o),
        float(cd_f),
        float(ae_o),
        float(ae_f),
        A_geom_O,
        A_geom_F,
    )


def _in_dp_band(
    r_o: float,
    r_f: float,
    lo: float = DP_BAND_LO,
    hi: float = DP_BAND_HI,
) -> bool:
    return (
        np.isfinite(r_o)
        and np.isfinite(r_f)
        and lo <= r_o <= hi
        and lo <= r_f <= hi
    )


def _in_r_band(r: float, lo: float = R_BAND_LO, hi: float = R_BAND_HI) -> bool:
    return np.isfinite(r) and lo <= r <= hi


def _mission_all_met(
    row: Row,
    F_t: float,
    MR_t: float,
    *,
    f_rel: float = MISSION_F_REL,
    mr_rel: float = MISSION_MR_REL,
) -> bool:
    """F/MR near targets, R in band, both ΔP/Pc streams in band."""
    if not row.ok or not np.isfinite(row.F) or not np.isfinite(row.MR):
        return False
    if abs(row.F - F_t) > f_rel * F_t:
        return False
    if abs(row.MR - MR_t) > mr_rel * MR_t:
        return False
    if not _in_r_band(row.R):
        return False
    if not _in_dp_band(row.r_O, row.r_F):
        return False
    return True


def _distance_score(
    row: Row,
    F_t: float,
    MR_t: float,
    w_dp: float = 5.0,
    *,
    r_lo: float = R_BAND_LO,
    r_hi: float = R_BAND_HI,
    dp_lo: float = DP_BAND_LO,
    dp_hi: float = DP_BAND_HI,
) -> float:
    """Lower is better (composite deviation from targets)."""
    if not row.ok or not np.isfinite(row.F):
        return 1e30
    e_f = (row.F - F_t) ** 2 / max(F_t**2, 1.0)
    e_mr = (row.MR - MR_t) ** 2 / max(MR_t**2, 1e-9)

    def r_pen(r: float) -> float:
        if not np.isfinite(r):
            return 1.0
        if r < r_lo:
            return (r_lo - r) ** 2
        if r > r_hi:
            return (r - r_hi) ** 2
        return 0.0

    e_r = r_pen(row.R)

    def dp_pen(r: float) -> float:
        if not np.isfinite(r):
            return 1.0
        if r < dp_lo:
            return (dp_lo - r) ** 2
        if r > dp_hi:
            return (r - dp_hi) ** 2
        return 0.0

    e_dp = dp_pen(row.r_O) + dp_pen(row.r_F)
    return float(e_f + e_mr + 4.0 * e_r + w_dp * e_dp)


def run_grid_independent(
    rows: List[Row],
    base,
    n_O_list: Sequence[int],
    n_F_list: Sequence[int],
    d_O_list: Sequence[float],
    d_F_list: Sequence[float],
    tank_grid: Sequence[Tuple[float, float]],
) -> int:
    """Append evaluations; returns total count for this grid."""
    total = (
        len(n_O_list)
        * len(n_F_list)
        * len(d_O_list)
        * len(d_F_list)
        * len(tank_grid)
    )
    done = 0
    for po, pf in tank_grid:
        for n_O in n_O_list:
            for n_F in n_F_list:
                for d_O in d_O_list:
                    for d_F in d_F_list:
                        rows.append(_one_eval(base, n_O, d_O, n_F, d_F, po, pf))
                        done += 1
                        if done % 500 == 0:
                            print(f"  progress {done}/{total} …", flush=True)
    return total


def _scenario_spec(
    name: str,
    *,
    n_min: int,
    n_max: int,
    quick: bool,
    P_O_yaml: float,
    P_F_yaml: float,
    max_lox_psi: float,
    max_fuel_psi: float,
    P_O_lo_l1: float,
    P_O_hi_l1: float,
    P_F_lo_l1: float,
    P_F_hi_l1: float,
    d_jet_upper_m: float = 0.004,
) -> Tuple[List[int], List[int], List[float], List[float], List[Tuple[float, float]], str]:
    """Return (n_O, n_F, d_O, d_F, tanks, description). n_max/d_jet_hi scale with chamber bore."""
    # Default tank corners (Layer-1 style + YAML)
    tanks_l1 = [
        (P_O_yaml, P_F_yaml),
        (P_O_lo_l1, P_F_lo_l1),
        (P_O_hi_l1, P_F_hi_l1),
        (P_O_lo_l1, P_F_hi_l1),
        (P_O_hi_l1, P_F_lo_l1),
        ((P_O_lo_l1 + P_O_hi_l1) / 2, (P_F_lo_l1 + P_F_hi_l1) / 2),
    ]

    if name == "widen_ox":
        if quick:
            n_O = [6, 18, 30, 42]
            n_F = list(range(n_min, min(n_max + 1, 28), 6))
            d_O = [0.0015, 0.0025, 0.0035, 0.0045, 0.0049]
            d_F = [0.0012, 0.0020, 0.0028, 0.0034]
        else:
            n_O = [6, 10, 14, 18, 22, 26, 30, 34, 38, 42]
            n_F = list(range(n_min, n_max + 1, 4))
            d_O = [0.0010, 0.0018, 0.0026, 0.0034, 0.0040, 0.0046, 0.0049]
            d_F = np.linspace(0.0009, 0.0036, num=6, dtype=float).tolist()
        desc = (
            "widen_ox: extend oxidizer side — n_O up to 42, d_jet_O up to 4.9 mm; "
            "fuel n_F/d_F same class as Layer-1 (cap n_F by n_max). Tanks: Layer-1 corners + YAML."
        )
        return n_O, n_F, d_O, d_F, tanks_l1, desc

    if name == "tighten_fuel":
        n_F_hi = 16
        if quick:
            n_O = [6, 14, 22, 30, 34]
            n_F = [6, 10, 14, n_F_hi]
            d_O = [0.0012, 0.0022, 0.0032]
            d_F = [0.0009, 0.0013, 0.0017, 0.0021, 0.0025]
        else:
            n_O = list(range(n_min, n_max + 1, 4))
            n_F = [6, 8, 10, 12, 14, n_F_hi]
            d_O = np.linspace(0.001, 0.0036, num=6, dtype=float).tolist()
            d_F = [0.00085, 0.00115, 0.00145, 0.00175, 0.00205, 0.00235]
        desc = (
            "tighten_fuel: cap fuel injectors — n_F ≤ 16, d_jet_F ≤ ~2.35 mm (coarse grid); "
            "oxidizer side unchanged span vs Layer-1. Tanks: Layer-1 corners + YAML."
        )
        return n_O, n_F, d_O, d_F, tanks_l1, desc

    if name == "expand_tanks":
        n_sym = _symmetric_n_values(n_min, n_max, quick=quick)
        d_hi_grid = float(min(max(float(d_jet_upper_m), 0.0034), 0.0075))
        if quick:
            d_sym = [0.0014, 0.0022, min(0.0030, d_hi_grid)]
            d_sym = sorted({float(round(d, 6)) for d in d_sym if d <= d_hi_grid + 1e-9})
            if not d_sym:
                d_sym = [0.001]
        else:
            d_sym = np.linspace(0.001, d_hi_grid, num=5, dtype=float).tolist()
        # Higher LOX (up to ~98% catalog max), lower/higher fuel across wider range
        tank_grid = [
            (P_O_yaml, P_F_yaml),
            (max_lox_psi * 0.92, max_fuel_psi * 0.48),
            (max_lox_psi * 0.97, max_fuel_psi * 0.45),
            (max_lox_psi * 0.88, max_fuel_psi * 0.90),
            (max_lox_psi * 0.72, max_fuel_psi * 0.55),
            (max_lox_psi * 0.82, max_fuel_psi * 0.40),
            (max_lox_psi * 0.65, max_fuel_psi * 0.68),
            (max_lox_psi * 0.55, max_fuel_psi * 0.78),
        ]
        desc = (
            "expand_tanks: symmetric injector grid; tank grid extends LOX toward ~0.97·P_max_lox "
            "and fuel toward ~0.40–0.90·P_max_fuel (outside strict Layer-1 0.65–0.85 band)."
        )
        return n_sym, n_sym, d_sym, d_sym, tank_grid, desc

    if name == "asymmetric":
        if quick:
            n_O = [12, 22, 34, 42]
            n_F = [6, 10, 14]
            d_O = [0.0024, 0.0034, 0.0044]
            d_F = [0.0010, 0.0016, 0.0022]
        else:
            n_O = [10, 18, 26, 34, 42]
            n_F = [6, 8, 10, 12, 14, 16]
            d_O = [0.0018, 0.0026, 0.0034, 0.0042, 0.0049]
            d_F = [0.00095, 0.00135, 0.00175, 0.00215, 0.00255]
        tank_grid = [
            (P_O_yaml, P_F_yaml),
            (max_lox_psi * 0.95, max_fuel_psi * 0.55),
            (max_lox_psi * 0.92, max_fuel_psi * 0.48),
            (max_lox_psi * 0.88, max_fuel_psi * 0.62),
            (max_lox_psi * 0.78, max_fuel_psi * 0.42),
            (P_O_hi_l1, max_fuel_psi * 0.50),
        ]
        desc = (
            "asymmetric: large oxidizer / small fuel grid (explicit O–F imbalance) + tank pairs "
            "favoring high LOX / moderate–low fuel feed pressure."
        )
        return n_O, n_F, d_O, d_F, tank_grid, desc

    raise ValueError(f"unknown scenario {name!r}")


def _stream_dp_ok(r: float) -> bool:
    return np.isfinite(r) and DP_BAND_LO <= r <= DP_BAND_HI


def _r_distance_to_band(r: float) -> float:
    """0 if R in [R_BAND_LO, R_BAND_HI], else squared distance to nearest edge."""
    if not np.isfinite(r):
        return 1e6
    if r < R_BAND_LO:
        return float((R_BAND_LO - r) ** 2)
    if r > R_BAND_HI:
        return float((r - R_BAND_HI) ** 2)
    return 0.0


def _print_extended_feasibility_analysis(
    ok_rows: List[Row],
    band_rows: List[Row],
    F_target: float,
    MR_target: float,
    *,
    max_show: int = 8,
) -> None:
    """Pairwise-best rows and marginal constraint failure stats (successful evals only)."""
    if not ok_rows:
        return

    print()
    print("=== Extended feasibility analysis (pairwise bests + constraint margins) ===")

    # --- Pairwise bests (ignore unstated constraints) ---
    def fmt_geo(r: Row) -> str:
        return (
            f"nO={r.n_O} dO={r.d_O*1000:.2f}mm nF={r.n_F} dF={r.d_F*1000:.2f}mm "
            f"tanks ({r.P_O_psi:.0f},{r.P_F_psi:.0f}) psi"
        )

    tf_mr_score = lambda r: (
        ((r.F - F_target) / max(MISSION_F_REL * F_target, 1e-9)) ** 2
        + ((r.MR - MR_target) / max(MISSION_MR_REL * MR_target, 1e-9)) ** 2
        if np.isfinite(r.F) and np.isfinite(r.MR)
        else np.inf
    )
    tf_mr_best = sorted(ok_rows, key=tf_mr_score)[:max_show]
    print()
    print(f"--- Best: thrust + O/F only (min Σ normalized² vs ±{MISSION_F_REL:.0%} gates) — top {max_show} ---")
    for i, r in enumerate(tf_mr_best):
        print(
            f"{i+1:3d}  F={r.F:.1f}  MR={r.MR:.3f}  R={r.R:.3f}  "
            f"rO={r.r_O:.3f} rF={r.r_F:.3f}  {fmt_geo(r)}"
        )

    if band_rows:
        tb = sorted(
            band_rows,
            key=lambda r: abs(r.F - F_target) / max(F_target, 1e-9),
        )[:max_show]
        print()
        print(f"--- Best: thrust + ΔP/Pc band (both streams in band) — top {max_show} ---")
        for i, r in enumerate(tb):
            print(
                f"{i+1:3d}  |F−tgt|/tgt={(abs(r.F-F_target)/F_target)*100:.2f}%  "
                f"F={r.F:.1f} MR={r.MR:.3f} R={r.R:.3f} rO={r.r_O:.3f} rF={r.r_F:.3f}  {fmt_geo(r)}"
            )

        ob = sorted(
            band_rows,
            key=lambda r: abs(r.MR - MR_target) / max(MR_target, 1e-9),
        )[:max_show]
        print()
        print(f"--- Best: O/F + ΔP/Pc band — top {max_show} ---")
        for i, r in enumerate(ob):
            print(
                f"{i+1:3d}  |MR−tgt|/tgt={(abs(r.MR-MR_target)/MR_target)*100:.2f}%  "
                f"F={r.F:.1f} MR={r.MR:.3f} R={r.R:.3f} rO={r.r_O:.3f} rF={r.r_F:.3f}  {fmt_geo(r)}"
            )

        rb = sorted(band_rows, key=lambda r: _r_distance_to_band(r.R))[:max_show]
        print()
        print(f"--- Best: momentum R + ΔP/Pc band (min distance of R to [{R_BAND_LO},{R_BAND_HI}]) — top {max_show} ---")
        for i, r in enumerate(rb):
            print(
                f"{i+1:3d}  R_dist={_r_distance_to_band(r.R):.5f}  R={r.R:.3f}  "
                f"F={r.F:.1f} MR={r.MR:.3f} rO={r.r_O:.3f} rF={r.r_F:.3f}  {fmt_geo(r)}"
            )
    else:
        print()
        print("--- Pairwise ΔP-band sections skipped (no ΔP/Pc-in-band rows) ---")

    # --- Marginal constraint violations (counts among successful evaluations) ---
    n = len(ok_rows)
    c_thrust = c_mr = c_r = 0
    c_ro_hi = c_ro_lo = c_rf_hi = c_rf_lo = 0
    c_dp_pair = 0
    for r in ok_rows:
        if not (np.isfinite(r.F) and abs(r.F - F_target) <= MISSION_F_REL * F_target):
            c_thrust += 1
        if not (np.isfinite(r.MR) and abs(r.MR - MR_target) <= MISSION_MR_REL * MR_target):
            c_mr += 1
        if not _in_r_band(r.R):
            c_r += 1
        if np.isfinite(r.r_O):
            if r.r_O > DP_BAND_HI:
                c_ro_hi += 1
            elif r.r_O < DP_BAND_LO:
                c_ro_lo += 1
        if np.isfinite(r.r_F):
            if r.r_F > DP_BAND_HI:
                c_rf_hi += 1
            elif r.r_F < DP_BAND_LO:
                c_rf_lo += 1
        if _stream_dp_ok(r.r_O) and _stream_dp_ok(r.r_F):
            c_dp_pair += 1

    def pct(k: int) -> float:
        return 100.0 * float(k) / float(max(n, 1))

    print()
    print(
        f"--- Constraint margins among {n} successful evaluations "
        f"(each line is fraction failing that condition; rows can fail multiple) ---"
    )
    print(f"  Thrust outside ±{MISSION_F_REL:.0%} of {F_target:.0f} N:     {c_thrust:6d}  ({pct(c_thrust):5.1f}%)")
    print(f"  O/F outside ±{MISSION_MR_REL:.0%} of {MR_target:.3f}:       {c_mr:6d}  ({pct(c_mr):5.1f}%)")
    print(f"  R outside [{R_BAND_LO},{R_BAND_HI}]:                  {c_r:6d}  ({pct(c_r):5.1f}%)")
    print(f"  Oxidizer ΔP/Pc > {DP_BAND_HI:.2f}:                     {c_ro_hi:6d}  ({pct(c_ro_hi):5.1f}%)")
    print(f"  Oxidizer ΔP/Pc < {DP_BAND_LO:.2f}:                     {c_ro_lo:6d}  ({pct(c_ro_lo):5.1f}%)")
    print(f"  Fuel ΔP/Pc > {DP_BAND_HI:.2f}:                         {c_rf_hi:6d}  ({pct(c_rf_hi):5.1f}%)")
    print(f"  Fuel ΔP/Pc < {DP_BAND_LO:.2f}:                         {c_rf_lo:6d}  ({pct(c_rf_lo):5.1f}%)")
    print(
        f"  BOTH ΔP/Pc streams in [{DP_BAND_LO:.2f},{DP_BAND_HI:.2f}]:     "
        f"{c_dp_pair:6d}  ({pct(c_dp_pair):5.1f}%)"
    )


def _print_report(
    rows: List[Row],
    F_target: float,
    MR_target: float,
    max_rows: int,
    req: Dict[str, Any],
    n_max: int,
    P_O_lo: float,
    P_O_hi: float,
    P_F_lo: float,
    P_F_hi: float,
    scenario_footer: str = "",
) -> None:
    ok_rows = [r for r in rows if r.ok]
    pre_rows = [r for r in rows if r.err.startswith("precheck:")]
    eval_exc_rows = [r for r in rows if (not r.ok) and (not r.err.startswith("precheck:"))]
    band_rows = [r for r in ok_rows if _in_dp_band(r.r_O, r.r_F)]
    mission_rows = [r for r in ok_rows if _mission_all_met(r, F_target, MR_target)]

    print(f"Total grid points: {len(rows)}")
    print(f"Precheck skips (no evaluate): {len(pre_rows)}")
    if pre_rows:
        ctr = Counter(r.err for r in pre_rows)
        for tag, k in ctr.most_common(12):
            print(f"    {tag}: {k}")
    print(f"Evaluate attempts: {len(rows) - len(pre_rows)}")
    print(f"Successful evaluates: {len(ok_rows)}")
    print(f"Evaluate failures (exceptions): {len(eval_exc_rows)}")
    print(f"Both ΔP/Pc in [{DP_BAND_LO:.2f}, {DP_BAND_HI:.2f}]: {len(band_rows)}")
    print(f"Full mission criteria met (F, MR, R band, ΔP band): {len(mission_rows)}")
    print()

    if mission_rows:
        print(f"--- Cases meeting ALL mission criteria — up to {min(20, len(mission_rows))} ---")
        for i, r in enumerate(mission_rows[:20]):
            print(
                f"{i+1:3d}  F={r.F:.1f}  MR={r.MR:.3f}  R={r.R:.3f}  "
                f"rO={r.r_O:.3f} rF={r.r_F:.3f}  "
                f"nO={r.n_O} dO={r.d_O*1000:.2f}mm  nF={r.n_F} dF={r.d_F*1000:.2f}mm  "
                f"tanks ({r.P_O_psi:.0f},{r.P_F_psi:.0f}) psi"
            )
        print()

    ok_sorted = sorted(ok_rows, key=lambda r: _distance_score(r, F_target, MR_target))
    print(f"--- Closest cases (composite score, lower=better) — top {max_rows} ---")
    for i, r in enumerate(ok_sorted[:max_rows]):
        sc = _distance_score(r, F_target, MR_target)
        print(
            f"{i+1:3d}  score={sc:.4g}  F={r.F:.1f}  MR={r.MR:.3f}  R={r.R:.3f}  "
            f"rO={r.r_O:.3f} rF={r.r_F:.3f}  nO={r.n_O} dO={r.d_O*1000:.2f}mm  "
            f"nF={r.n_F} dF={r.d_F*1000:.2f}mm  tanks psi ({r.P_O_psi:.0f},{r.P_F_psi:.0f})"
        )

    if band_rows:
        bs = sorted(band_rows, key=lambda r: _distance_score(r, F_target, MR_target, w_dp=0.0))
        print()
        print(f"--- Best among ΔP/Pc-in-band cases (no ΔP term in score) — top {min(15, max_rows)} ---")
        for i, r in enumerate(bs[: min(15, max_rows)]):
            sc = _distance_score(r, F_target, MR_target, w_dp=0.0)
            print(
                f"{i+1:3d}  score={sc:.4g}  F={r.F:.1f}  MR={r.MR:.3f}  R={r.R:.3f}  "
                f"rO={r.r_O:.3f} rF={r.r_F:.3f}  nO={r.n_O} dO={r.d_O*1000:.2f}mm  "
                f"nF={r.n_F} dF={r.d_F*1000:.2f}mm  tanks ({r.P_O_psi:.0f},{r.P_F_psi:.0f}) psi"
            )
    else:
        print()
        print(
            f"No successful evaluation had BOTH streams with "
            f"{DP_BAND_LO:.2f} <= ΔP/Pc <= {DP_BAND_HI:.2f}."
        )

    partial = [
        r
        for r in ok_rows
        if _in_dp_band(r.r_O, r.r_F)
        and _in_r_band(r.R)
        and abs(r.F - F_target) <= MISSION_F_REL * F_target * 2
    ]
    partial.sort(key=lambda r: abs(r.MR - MR_target))
    if partial:
        print()
        print(
            "--- Among F±10%, ΔP band, R band: smallest |MR−MR_target| (diagnostic) — top 12 ---"
        )
        for i, r in enumerate(partial[:12]):
            print(
                f"{i+1:3d}  |MR−tgt|={abs(r.MR-MR_target):.3f}  F={r.F:.0f}  MR={r.MR:.3f}  R={r.R:.3f}  "
                f"rO={r.r_O:.3f} rF={r.r_F:.3f}  nO={r.n_O} dO={r.d_O*1000:.2f}  "
                f"nF={r.n_F} dF={r.d_F*1000:.2f}  ({r.P_O_psi:.0f},{r.P_F_psi:.0f}) psi"
            )

    _print_extended_feasibility_analysis(
        ok_rows,
        band_rows,
        F_target,
        MR_target,
        max_show=min(10, max_rows),
    )

    print()
    if scenario_footer:
        print(scenario_footer)
        print()
    throat_mm2 = req.get("frozen_parameters", {}).get("A_throat_mm2")
    if throat_mm2:
        print(
            f"Frozen throat: A_throat = {throat_mm2:.2f} mm² — choked throat sets mdot(Pc)."
        )


def main(argv: Optional[Sequence[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Smaller grid (~few hundred evals)",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=50,
        help="How many top rows to print per category",
    )
    parser.add_argument(
        "--tank-sweep",
        action="store_true",
        help="After main grid (YAML tanks), add Layer-1 tank-box corners on a sparse geometry grid (~hundreds of evals).",
    )
    parser.add_argument(
        "--config",
        type=str,
        default="configs/impinging_lox_ch4_8000N.yaml",
        help="Path to engine YAML (relative to repo root or absolute).",
    )
    parser.add_argument(
        "--scenario",
        type=str,
        choices=("baseline", "widen_ox", "tighten_fuel", "expand_tanks", "asymmetric"),
        default="baseline",
        help=(
            "baseline: symmetric Layer-1-style grid (+ optional --tank-sweep). "
            "Other scenarios relax/adjust injector O/F bounds or tank PSI grid only "
            "(physics unchanged)."
        ),
    )
    args = parser.parse_args(argv)

    cfg_path = Path(args.config)
    if not cfg_path.is_absolute():
        cfg_path = ROOT / cfg_path
    base = load_config(cfg_path)
    req = base.design_requirements.model_dump()
    F_target = float(req.get("target_thrust", 4000.0))
    MR_target = float(req.get("optimal_of_ratio", 3.2))
    max_chamber_od = float(req.get("max_chamber_outer_diameter", 0.15))
    max_lox_psi = float(req.get("max_lox_tank_pressure_psi") or 700.0)
    max_fuel_psi = float(req.get("max_fuel_tank_pressure_psi") or 850.0)

    D_inner_fb = impinging_chamber_inner_diameter_for_bounds(
        base,
        max_chamber_outer_diameter_m=max_chamber_od,
        wall_thickness_m=TOTAL_WALL_THICKNESS_M,
    )
    n_hi_int = impinging_n_elements_hi_int(D_inner_fb)
    d_jet_hi = impinging_d_jet_upper_bound_m(D_inner_fb)
    spacing_hi = impinging_spacing_upper_bound_m(D_inner_fb)
    n_min, n_max = 6, int(n_hi_int)

    # YAML baseline tanks [psi]
    P_O_yaml = float(base.lox_tank.initial_pressure_psi)
    P_F_yaml = float(base.fuel_tank.initial_pressure_psi)

    # Layer-1 pressure bands (same as optimization)
    min_P_ratio, max_P_ratio = 0.65, 0.85
    P_O_lo = max_lox_psi * min_P_ratio
    P_O_hi = max_lox_psi * max_P_ratio
    P_F_lo = max_fuel_psi * min_P_ratio
    P_F_hi = max_fuel_psi * max_P_ratio

    print("=== Impinging LOX/CH4 feasibility sweep ===")
    print(f"Config: {cfg_path}")
    print(f"Scenario: {args.scenario}")
    print(f"Frozen chamber/throat/nozzle: from YAML (A_throat frozen_parameters / chamber_geometry).")
    print(
        f"Targets: F={F_target:.0f} N, MR={MR_target:.3f}, "
        f"R in [{R_BAND_LO:.3f},{R_BAND_HI:.3f}], "
        f"ΔP_inj/Pc per stream in [{DP_BAND_LO:.2f}, {DP_BAND_HI:.2f}]"
    )
    print(
        f"Full mission hit (count): |F−F_target|/F_target ≤ {MISSION_F_REL:.0%}, "
        f"|MR−MR_target|/MR_target ≤ {MISSION_MR_REL:.0%}, plus R band and ΔP band."
    )
    print(
        f"Injector face inner Ø (bounds/packing ref): {D_inner_fb*1000:.2f} mm "
        f"({D_inner_fb / 0.0254:.3f} in bore)"
    )
    print(
        f"Scaled injector bounds (Layer-1 class): n_elements ≤ {n_hi_int}, "
        f"d_jet ≤ {d_jet_hi*1000:.2f} mm, spacing ≤ {spacing_hi*1000:.2f} mm "
        f"(packing uses face_a = π·D_inner²/4 from runner geometry)."
    )
    print(f"Layer-1 reference n_hi≈{float(n_hi_int):.1f} (oxidizer scenarios may exceed n_hi).")
    print(f"Tank bands (Layer-1 ref): LOX [{P_O_lo:.1f}, {P_O_hi:.1f}] psi, fuel [{P_F_lo:.1f}, {P_F_hi:.1f}] psi")
    print(f"YAML tanks: LOX={P_O_yaml:.1f} psi, fuel={P_F_yaml:.1f} psi")
    print()

    rows: List[Row] = []

    if args.scenario == "baseline":
        if args.quick:
            n_list = _symmetric_n_values(n_min, n_max, quick=True, quick_clip_max=40)
            d_list = sorted(
                {round(x, 6) for x in [0.0010, 0.0015, 0.0020, 0.0025, min(0.0030, d_jet_hi)]}
            )
            tank_grid = [(P_O_yaml, P_F_yaml)]
        else:
            n_list = _symmetric_n_values(n_min, n_max, quick=False)
            d_hi_use = float(min(max(d_jet_hi, 0.0036), 0.0075))
            d_list = np.linspace(0.0008, d_hi_use, num=6, dtype=float).tolist()
            tank_grid = [(P_O_yaml, P_F_yaml)]
        total_main = len(n_list) ** 2 * len(d_list) ** 2 * len(tank_grid)
        print(f"Main grid evaluations (symmetric): {total_main}")
        run_grid_independent(rows, base, n_list, n_list, d_list, d_list, tank_grid)

        if args.tank_sweep:
            tank_corners = [
                (P_O_yaml, P_F_yaml),
                (P_O_lo, P_F_lo),
                (P_O_hi, P_F_hi),
                (P_O_lo, P_F_hi),
                (P_O_hi, P_F_lo),
                ((P_O_lo + P_O_hi) / 2, (P_F_lo + P_F_hi) / 2),
            ]
            n_sparse = _symmetric_n_values(n_min, n_max, quick=False, bins=6)
            d_hi_sparse = float(min(max(d_jet_hi, 0.0034), 0.0075))
            d_sparse = np.linspace(0.001, d_hi_sparse, num=4, dtype=float).tolist()
            extra = len(n_sparse) ** 2 * len(d_sparse) ** 2 * len(tank_corners)
            print(f"Tank-sweep add-on evaluations: {extra}")
            run_grid_independent(rows, base, n_sparse, n_sparse, d_sparse, d_sparse, tank_corners)
        scenario_footer = (
            "baseline: symmetric Layer-1-class injector bounds; optional --tank-sweep adds Layer-1 tank corners."
        )
    else:
        n_O, n_F, d_O, d_F, tank_grid, scen_desc = _scenario_spec(
            args.scenario,
            n_min=n_min,
            n_max=n_max,
            quick=args.quick,
            P_O_yaml=P_O_yaml,
            P_F_yaml=P_F_yaml,
            max_lox_psi=max_lox_psi,
            max_fuel_psi=max_fuel_psi,
            P_O_lo_l1=P_O_lo,
            P_O_hi_l1=P_O_hi,
            P_F_lo_l1=P_F_lo,
            P_F_hi_l1=P_F_hi,
            d_jet_upper_m=d_jet_hi,
        )
        print(scen_desc)
        total_main = (
            len(n_O) * len(n_F) * len(d_O) * len(d_F) * len(tank_grid)
        )
        print(f"Scenario grid evaluations: {total_main}")
        print(f"  n_O ∈ {min(n_O)}…{max(n_O)} ({len(n_O)} pts), n_F ∈ {min(n_F)}…{max(n_F)} ({len(n_F)} pts)")
        print(
            f"  d_O ∈ [{min(d_O)*1000:.2f},{max(d_O)*1000:.2f}] mm ({len(d_O)} pts), "
            f"d_F ∈ [{min(d_F)*1000:.2f},{max(d_F)*1000:.2f}] mm ({len(d_F)} pts)"
        )
        print(f"  tank combos: {len(tank_grid)}")
        print()
        run_grid_independent(rows, base, n_O, n_F, d_O, d_F, tank_grid)
        scenario_footer = scen_desc

    _print_report(
        rows,
        F_target,
        MR_target,
        args.max_rows,
        req,
        n_max,
        P_O_lo,
        P_O_hi,
        P_F_lo,
        P_F_hi,
        scenario_footer=scenario_footer,
    )


if __name__ == "__main__":
    main()
