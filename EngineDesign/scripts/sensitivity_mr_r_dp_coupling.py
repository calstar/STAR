#!/usr/bin/env python3
"""Sensitivity sweep: MR, momentum_ratio_R, ΔP/Pc vs AO/AF, tank pressures, Cd_O/Cd_F.

Uses frozen chamber from configs/impinging_lox_ch4_8000N.yaml (no YAML edits).
Filters samples near thrust ~8000 N and R ~ 1; reports MR and ΔP_O/Pc, ΔP_F/Pc.

Run from repo root: PYTHONPATH=. python scripts/sensitivity_mr_r_dp_coupling.py
"""

from __future__ import annotations

import copy
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner
from engine.pipeline.io import load_config

PSI_TO_PA = 6894.757293168361
TARGET_F = 8000.0
TARGET_MR = 3.5


def ambient_pa_from_config(cfg) -> float:
    env = getattr(cfg, "environment", None)
    el = float(getattr(env, "elevation", 0.0) or 0.0)
    p0 = 101325.0
    m_mol = 0.0289644
    g = 9.80665
    r_gas = 8.31447
    t0 = 288.15
    return float(p0 * math.exp(-m_mol * g * el / (r_gas * t0)))


def apply_cd_multipliers(cfg, m_o: float, m_f: float) -> None:
    """Scale Cd_inf and Cd_min for oxidizer/fuel discharge (clamp Cd_inf <= 1)."""
    for side, mult in (("oxidizer", m_o), ("fuel", m_f)):
        d = cfg.discharge[side]
        ci = float(d.Cd_inf) * mult
        cm = float(d.Cd_min) * mult
        ci = min(0.999, max(cm + 1e-6, ci))
        d.Cd_inf = ci
        d.Cd_min = min(cm, d.Cd_inf * 0.99)


def fuel_geometry_for_ratio(a_o: float, ratio_ao_af: float, n_f: int) -> float:
    """Return fuel jet diameter [m] for A_F = A_O / ratio_ao_af with fixed n_F."""
    a_f = a_o / ratio_ao_af
    return float(2.0 * math.sqrt(max(a_f, 1e-12) / (math.pi * max(n_f, 1))))


@dataclass
class Row:
    ao_af: float
    p_o_psi: float
    p_f_psi: float
    cd_o_mult: float
    cd_f_mult: float
    F: float
    MR: float
    R_mom: float
    pc: float
    r_dp_o: float
    r_dp_f: float
    cd_o: float
    cd_f: float


def main() -> None:
    cfg_base = load_config(str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    p_amb = ambient_pa_from_config(cfg_base)

    rho_o = float(cfg_base.fluids["oxidizer"].density)
    rho_f = float(cfg_base.fluids["fuel"].density)
    sqrt_density_ratio = math.sqrt(rho_o / rho_f)
    ao_af_for_mr35_at_R1 = TARGET_MR / sqrt_density_ratio

    # Fixed oxidizer geometry (matches prior diagnostic scale)
    n_o = 25
    d_o = 0.00244
    a_o = n_o * math.pi * (d_o / 2.0) ** 2
    n_f = 63

    # Grid size ~7*5*5*9 ≈ 1600 evaluates (~few minutes locally)
    ao_af_list = np.linspace(1.65, 2.55, 7)
    p_o_grid = np.linspace(400.0, 600.0, 5)
    p_f_grid = np.linspace(500.0, 780.0, 5)
    cd_mults = [0.9, 1.0, 1.1]

    rows: list[Row] = []
    n_eval = 0
    n_fail = 0

    for m_o in cd_mults:
        for m_f in cd_mults:
            for ao_af in ao_af_list:
                d_f = fuel_geometry_for_ratio(a_o, float(ao_af), n_f)
                if not (0.00035 <= d_f <= 0.0065):
                    continue
                for p_o_psi in p_o_grid:
                    for p_f_psi in p_f_grid:
                        cfg = copy.deepcopy(cfg_base)
                        apply_cd_multipliers(cfg, m_o, m_f)
                        cfg.injector.geometry.oxidizer.n_elements = n_o
                        cfg.injector.geometry.oxidizer.d_jet = d_o
                        cfg.injector.geometry.fuel.n_elements = n_f
                        cfg.injector.geometry.fuel.d_jet = d_f

                        try:
                            runner = PintleEngineRunner(cfg)
                            res = runner.evaluate(
                                float(p_o_psi) * PSI_TO_PA,
                                float(p_f_psi) * PSI_TO_PA,
                                P_ambient=p_amb,
                                silent=True,
                            )
                            n_eval += 1
                        except Exception:
                            n_fail += 1
                            continue

                        F = float(res.get("F", float("nan")))
                        MR = float(res.get("MR", float("nan")))
                        pc = float(res.get("Pc", float("nan")))
                        diag = res.get("diagnostics") or {}
                        R_mom = float(diag.get("momentum_ratio_R", float("nan")))
                        dp_o = diag.get("delta_p_injector_O")
                        dp_f = diag.get("delta_p_injector_F")
                        cd_o = float(diag.get("Cd_O", float("nan")))
                        cd_f = float(diag.get("Cd_F", float("nan")))
                        if (
                            not np.isfinite(pc)
                            or pc <= 0
                            or dp_o is None
                            or dp_f is None
                            or not np.isfinite(F)
                            or not np.isfinite(MR)
                        ):
                            continue

                        rows.append(
                            Row(
                                ao_af=float(ao_af),
                                p_o_psi=float(p_o_psi),
                                p_f_psi=float(p_f_psi),
                                cd_o_mult=float(m_o),
                                cd_f_mult=float(m_f),
                                F=F,
                                MR=MR,
                                R_mom=R_mom,
                                pc=pc,
                                r_dp_o=float(dp_o) / pc,
                                r_dp_f=float(dp_f) / pc,
                                cd_o=cd_o,
                                cd_f=cd_f,
                            )
                        )

    print("=== Sweep summary ===")
    print(f"Ambient P_a used in evaluate: {p_amb:.2f} Pa ({p_amb/101325:.4f} atm)")
    print(f"Fixed oxidizer: n_O={n_o}, d_O={d_o*1000:.3f} mm, A_O={a_o*1e6:.4f} mm²")
    print(f"Fuel elements n_F={n_f}; d_F recomputed per AO/AF")
    print(f"rho_O/rho_F = {rho_o/rho_f:.4f}, sqrt(rho_O/rho_F) = {sqrt_density_ratio:.4f}")
    print(f"AO/AF needed for MR≈{TARGET_MR} if R=1 exactly (MR=R*sqrt(rho_O/rho_F)*AO/AF → AO/AF={TARGET_MR}/(R*sqrt…)): {ao_af_for_mr35_at_R1:.4f}")
    print(f"Successful evaluates stored: {len(rows)}, exceptions: {n_fail}, total attempts: {n_eval}")

    # Filters (tight → loose)
    def filt(rel_F: float, band_R: float, mr_lo: float, mr_hi: float) -> list[Row]:
        out = []
        for r in rows:
            if abs(r.F / TARGET_F - 1.0) > rel_F:
                continue
            if not np.isfinite(r.R_mom):
                continue
            if abs(r.R_mom - 1.0) > band_R:
                continue
            if r.MR < mr_lo or r.MR > mr_hi:
                continue
            out.append(r)
        return out

    scenarios = [
        ("strict", 0.03, 0.06, 3.45, 3.55),
        ("medium", 0.05, 0.08, 3.40, 3.60),
        ("loose", 0.08, 0.10, 3.30, 3.70),
    ]

    for name, rf, br, ml, mh in scenarios:
        sel = filt(rf, br, ml, mh)
        print(f"\n--- Filter [{name}]: |F/F_tgt-1|<={rf}, |R-1|<={br}, MR∈[{ml},{mh}] → N={len(sel)} ---")
        if not sel:
            continue
        rf_vals = [x.r_dp_f for x in sel]
        ro_vals = [x.r_dp_o for x in sel]
        print(f"  ΔP_F/Pc: min={min(rf_vals):.4f} med={np.median(rf_vals):.4f} max={max(rf_vals):.4f}")
        print(f"  ΔP_O/Pc: min={min(ro_vals):.4f} med={np.median(ro_vals):.4f} max={max(ro_vals):.4f}")
        print(f"  MR:      min={min(x.MR for x in sel):.4f} med={np.median([x.MR for x in sel]):.4f} max={max(x.MR for x in sel):.4f}")
        below = sum(1 for x in sel if x.r_dp_f <= 0.35)
        above = sum(1 for x in sel if x.r_dp_f > 0.35)
        print(f"  Fuel ΔP/Pc<=0.35: {below}/{len(sel)} ({100*below/len(sel):.1f}%), >0.35: {above}")
        # Example lowest fuel dp
        sel_sorted = sorted(sel, key=lambda x: x.r_dp_f)
        ex = sel_sorted[0]
        print(
            f"  Lowest ΔP_F/Pc sample: ΔP_F/Pc={ex.r_dp_f:.4f}, ΔP_O/Pc={ex.r_dp_o:.4f}, "
            f"MR={ex.MR:.4f}, R={ex.R_mom:.4f}, F={ex.F:.1f}, AO/AF={ex.ao_af:.3f}, "
            f"P_O={ex.p_o_psi:.0f} psi, P_F={ex.p_f_psi:.0f} psi, Cd×=({ex.cd_o_mult:.2f},{ex.cd_f_mult:.2f})"
        )

    # Broader: R~1 and F~8000 only (ignore MR band) — shows MR drift when AO/AF wrong
    loose_rf = 0.06
    loose_br = 0.08
    sel2 = [r for r in rows if np.isfinite(r.R_mom) and abs(r.R_mom - 1.0) <= loose_br and abs(r.F / TARGET_F - 1.0) <= loose_rf]
    print(f"\n--- MR distribution when only |F-8000|/8000<= {loose_rf} and |R-1|<={loose_br} (no MR filter): N={len(sel2)} ---")
    if sel2:
        mrs = [x.MR for x in sel2]
        print(f"  MR min/med/max: {min(mrs):.4f} / {np.median(mrs):.4f} / {max(mrs):.4f}")
        pred = [sqrt_density_ratio * x.ao_af for x in sel2]
        err = [abs(sel2[i].MR - pred[i]) for i in range(len(sel2))]
        print(f"  |MR - sqrt(rho_O/rho_F)*AO/AF| median: {np.median(err):.4f} (injector closure breaks pure analytic relation)")


if __name__ == "__main__":
    main()
