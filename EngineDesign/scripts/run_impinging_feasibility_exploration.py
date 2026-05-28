#!/usr/bin/env python3
"""Exploration run: relaxed fuel ΔP band + reduced fuel tank pressure *upper* bound via pressure_config.

Layer-1 uses (see layer1_static_optimization):

    P_F bounds = [max_fuel_pressure_psi * 0.65, max_fuel_pressure_psi * 0.85]

Setting pressure_config[\"max_fuel_pressure_psi\"] = 900 gives ~585–765 psi search band.

Also overrides requirements for this session:

    injector_dp_ratio_F_max = 1.50  (oxidizer band unchanged from YAML)
    W_MOM = 300
    W_geom_ao_af_momentum = 2800

Then: AO/AF evaluate sweep [1.8, 2.5] at optimized tank pressures,
      Cd sensitivity grid (0.9/1/1.1)× on Cd_inf and Cd_min per propellant (in-memory copies only).

Does not modify YAML or committed Cd defaults.
"""

from __future__ import annotations

import argparse
import copy
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PSI_TO_PA = 6894.76

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization  # noqa: E402
from engine.pipeline.config_schemas import DischargeConfig, PintleEngineConfig  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402


def _dp_ratios(ev: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    pc = float(ev.get("Pc", float("nan")))
    if not (np.isfinite(pc) and pc > 0):
        return None, None
    diag = ev.get("diagnostics") or {}
    dpo = diag.get("delta_p_injector_O")
    dpf = diag.get("delta_p_injector_F")
    ro = float(dpo) / pc if dpo is not None and np.isfinite(dpo) else None
    rf = float(dpf) / pc if dpf is not None and np.isfinite(dpf) else None
    return ro, rf


def _feasible(
    F: float,
    MR: float,
    R: Optional[float],
    ro: Optional[float],
    rf: Optional[float],
    *,
    f_band_o: Tuple[float, float],
    rf_cap: float,
) -> bool:
    if not np.isfinite(F) or not np.isfinite(MR):
        return False
    if abs(F - 8000.0) / 8000.0 > 0.05:
        return False
    if abs(MR - 3.5) / 3.5 > 0.05:
        return False
    if R is None or not np.isfinite(R) or abs(R - 1.0) > 0.10:
        return False
    if ro is None or rf is None:
        return False
    if ro < f_band_o[0] or ro > f_band_o[1]:
        return False
    if rf > rf_cap:
        return False
    return True


def _scale_discharge_inplace(dc: DischargeConfig, factor: float) -> None:
    dc.Cd_inf = float(np.clip(dc.Cd_inf * factor, 1e-6, 1.0))
    dc.Cd_min = float(min(dc.Cd_min * factor, dc.Cd_inf))


def _apply_cd_factors(cfg: PintleEngineConfig, fo: float, ff: float) -> PintleEngineConfig:
    c = copy.deepcopy(cfg)
    ox = c.discharge["oxidizer"]
    fu = c.discharge["fuel"]
    _scale_discharge_inplace(ox, fo)
    _scale_discharge_inplace(fu, ff)
    return c


def _print_layer1_metrics(title: str, opt_cfg: PintleEngineConfig, perf: Dict[str, Any]) -> None:
    diag = perf.get("diagnostics") or {}
    pc = float(perf.get("Pc", float("nan")))
    ro, rf = _dp_ratios({"Pc": pc, "diagnostics": diag})

    ig = opt_cfg.injector.geometry
    n_o = int(ig.oxidizer.n_elements)
    n_f = int(ig.fuel.n_elements)
    d_o_mm = float(ig.oxidizer.d_jet) * 1000.0
    d_f_mm = float(ig.fuel.d_jet) * 1000.0
    s_o_mm = float(ig.oxidizer.spacing) * 1000.0
    s_f_mm = float(ig.fuel.spacing) * 1000.0

    a_go = perf.get("A_geom_O") or diag.get("A_geom_O")
    a_gf = perf.get("A_geom_F") or diag.get("A_geom_F")
    a_eo = perf.get("A_eff_O") or diag.get("A_eff_O")
    a_ef = perf.get("A_eff_F") or diag.get("A_eff_F")

    print(f"\n{'=' * 80}\n{title}\n{'=' * 80}")
    print(f"Thrust F [N]:           {perf.get('F')}")
    print(f"MR:                     {perf.get('MR')}")
    print(f"momentum_ratio_R:       {perf.get('momentum_ratio_R')}")
    print(f"ΔP_inj_O / Pc:          {ro}")
    print(f"ΔP_inj_F / Pc:          {rf}")
    print(f"P_O_start_psi:          {perf.get('P_O_start_psi')}")
    print(f"P_F_start_psi:          {perf.get('P_F_start_psi')}")
    print(f"A_geom_O / A_geom_F:    {perf.get('geom_ao_af')}")
    print(f"A_geom_O [m²]:          {a_go}")
    print(f"A_geom_F [m²]:          {a_gf}")
    ao_af_eff = (
        float(a_eo) / float(a_ef)
        if a_eo is not None and a_ef is not None and float(a_ef) > 0
        else float("nan")
    )
    print(f"A_eff_O / A_eff_F:      {ao_af_eff}")
    print(f"expected_AO_AF_for_R≈1: {perf.get('expected_ao_af_for_R1')}")
    print(
        f"Injector: n_O={n_o} d_O={d_o_mm:.4f} mm spacing_O={s_o_mm:.4f} mm imp_O={ig.oxidizer.impingement_angle:.2f}°"
    )
    print(
        f"          n_F={n_f} d_F={d_f_mm:.4f} mm spacing_F={s_f_mm:.4f} mm imp_F={ig.fuel.impingement_angle:.2f}°"
    )


def _ao_af_sweep(
    opt_cfg: PintleEngineConfig,
    po_pa: float,
    pf_pa: float,
    *,
    ratio_min: float,
    ratio_max: float,
    steps: int,
    silent: bool,
    f_band_o: Tuple[float, float],
    rf_cap: float,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    geom = opt_cfg.injector.geometry
    ox = geom.oxidizer
    fu = geom.fuel
    n_o = max(1, int(ox.n_elements))
    n_f = max(1, int(fu.n_elements))
    d_f = float(fu.d_jet)

    runner_base = PintleEngineRunner(copy.deepcopy(opt_cfg))
    pa = runner_base._get_ambient_pressure(None)

    ratios = np.linspace(ratio_min, ratio_max, steps)
    rows: List[Dict[str, Any]] = []
    print(f"\n{'=' * 80}\nAO/AF sweep (fixed tank P, vary d_O)\n{'=' * 80}")

    for r_tgt in ratios:
        cfg_i = copy.deepcopy(opt_cfg)
        g = cfg_i.injector.geometry
        scale = math.sqrt(max(1e-30, float(r_tgt) * float(n_f) / float(n_o)))
        g.oxidizer.d_jet = d_f * scale
        runner = PintleEngineRunner(cfg_i)
        try:
            ev = runner.evaluate(po_pa, pf_pa, P_ambient=pa, silent=silent)
        except Exception as e:
            rows.append({"AoAf_tgt": r_tgt, "error": str(e)})
            continue

        diag = ev.get("diagnostics") or {}
        R = diag.get("momentum_ratio_R")
        ro, rf = _dp_ratios(ev)
        F = float(ev.get("F", float("nan")))
        MR = float(ev.get("MR", float("nan")))
        ok = _feasible(F, MR, float(R) if R is not None else None, ro, rf, f_band_o=f_band_o, rf_cap=rf_cap)
        rows.append(
            {
                "AoAf_tgt": float(r_tgt),
                "F": F,
                "MR": MR,
                "R": float(R) if R is not None else float("nan"),
                "dP_O_Pc": ro,
                "dP_F_Pc": rf,
                "feasible": ok,
            }
        )

    hdr = f"{'AoAf':>8} {'F':>10} {'MR':>8} {'R':>8} {'dPO':>8} {'dPF':>8} {'ok':>5}"
    print(hdr)
    print("-" * len(hdr))
    for row in rows:
        if "error" in row:
            print(f"{row['AoAf_tgt']:8.4f} ERROR {row['error']}")
            continue
        print(
            f"{row['AoAf_tgt']:8.4f} {row['F']:10.2f} {row['MR']:8.4f} {row['R']:8.4f} "
            f"{row['dP_O_Pc'] if row['dP_O_Pc'] is not None else float('nan'):8.4f} "
            f"{row['dP_F_Pc'] if row['dP_F_Pc'] is not None else float('nan'):8.4f} "
            f"{str(row['feasible']):>5}"
        )

    good = [r for r in rows if r.get("feasible")]
    return rows, good


def _cd_sweep(
    opt_cfg: PintleEngineConfig,
    po_pa: float,
    pf_pa: float,
    *,
    silent: bool,
) -> None:
    print(f"\n{'=' * 80}\nCd sensitivity (×Cd_inf & Cd_min per stream; in-memory copy only)\n{'=' * 80}")
    factors = [0.9, 1.0, 1.1]
    runner_ref = PintleEngineRunner(copy.deepcopy(opt_cfg))
    pa = runner_ref._get_ambient_pressure(None)

    print(f"{'f_O':>6} {'f_F':>6} {'R':>8} {'dPF/Pc':>10} {'MR':>8} {'F[N]':>10}")
    print("-" * 52)
    for fo in factors:
        for ff in factors:
            cfg_cd = _apply_cd_factors(opt_cfg, fo, ff)
            runner = PintleEngineRunner(cfg_cd)
            try:
                ev = runner.evaluate(po_pa, pf_pa, P_ambient=pa, silent=silent)
            except Exception as e:
                print(f"{fo:6.2f} {ff:6.2f} ERROR {e}")
                continue
            diag = ev.get("diagnostics") or {}
            R = diag.get("momentum_ratio_R")
            _, rf = _dp_ratios(ev)
            print(
                f"{fo:6.2f} {ff:6.2f} {float(R) if R is not None else float('nan'):8.4f} "
                f"{rf if rf is not None else float('nan'):10.4f} {float(ev.get('MR', float('nan'))):8.4f} "
                f"{float(ev.get('F', float('nan'))):10.2f}"
            )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--layer1-max-iterations", type=int, default=150)
    ap.add_argument("--layer1-cma-restarts", type=int, default=1)
    ap.add_argument("--max-fuel-pressure-psi-band-cap", type=float, default=900.0)
    ap.add_argument("--injector-dp-f-max", type=float, default=1.50)
    ap.add_argument("--w-mom", type=float, default=300.0)
    ap.add_argument("--w-geom-ao-af", type=float, default=2800.0)
    ap.add_argument("--aoaf-min", type=float, default=1.8)
    ap.add_argument("--aoaf-max", type=float, default=2.5)
    ap.add_argument("--aoaf-steps", type=int, default=22)
    ap.add_argument("--silent-eval", action="store_true")
    args = ap.parse_args()

    cfg = load_config(args.config)
    req = cfg.design_requirements.model_dump()
    req["W_MOM"] = float(args.w_mom)
    req["W_geom_ao_af_momentum"] = float(args.w_geom_ao_af)
    req["injector_dp_ratio_F_max"] = float(args.injector_dp_f_max)

    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
        # User-requested exploration band: 0.65–0.85 × this cap ≈ 585–765 psi when cap = 900
        "max_fuel_pressure_psi": float(args.max_fuel_pressure_psi_band_cap),
    }

    f_band_o = (float(req["injector_dp_ratio_O_min"]), float(req["injector_dp_ratio_O_max"]))
    rf_cap = float(args.injector_dp_f_max)

    print(
        "\nExploration overrides:\n"
        f"  pressure_config[max_fuel_pressure_psi]={pcfg['max_fuel_pressure_psi']} "
        f"→ fuel P search [{pcfg['max_fuel_pressure_psi'] * 0.65:.1f}, {pcfg['max_fuel_pressure_psi'] * 0.85:.1f}] psi\n"
        f"  injector_dp_ratio_F_max={rf_cap}\n"
        f"  W_MOM={req['W_MOM']}  W_geom_ao_af_momentum={req['W_geom_ao_af_momentum']}\n"
        f"  Layer-1 iterations={args.layer1_max_iterations} restarts={args.layer1_cma_restarts}\n"
    )

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
    _print_layer1_metrics("Layer-1 result (exploration overrides)", opt_cfg, perf)

    po_pa = float(perf["P_O_start_psi"]) * PSI_TO_PA
    pf_pa = float(perf["P_F_start_psi"]) * PSI_TO_PA

    rows, good = _ao_af_sweep(
        opt_cfg,
        po_pa,
        pf_pa,
        ratio_min=float(args.aoaf_min),
        ratio_max=float(args.aoaf_max),
        steps=int(args.aoaf_steps),
        silent=args.silent_eval,
        f_band_o=f_band_o,
        rf_cap=rf_cap,
    )

    _cd_sweep(opt_cfg, po_pa, pf_pa, silent=args.silent_eval)

    print(f"\n{'=' * 80}\nCONCLUSION / BEST CANDIDATES\n{'=' * 80}")

    def _score(evdict: Dict[str, Any]) -> float:
        F = float(evdict.get("F", 0))
        MR = float(evdict.get("MR", 0))
        R = float(evdict.get("R", 1.0))
        ro = evdict.get("dP_O_Pc")
        rf = evdict.get("dP_F_Pc")
        pen = 0.0
        pen += ((F - 8000) / 8000) ** 2
        pen += ((MR - 3.5) / 3.5) ** 2
        pen += (R - 1.0) ** 2
        if ro is not None:
            pen += max(0.0, 0.20 - ro) ** 2 + max(0.0, ro - 0.35) ** 2
        if rf is not None:
            pen += max(0.0, rf - rf_cap) ** 2
        return pen

    if good:
        best = min(good, key=_score)
        print(f"AO/AF sweep: {len(good)} feasible point(s). Best composite row:\n  {best}")
    else:
        print("AO/AF sweep: **no** point satisfied all tightened feasibility filters.")

    print(
        "\nInterpretation checklist:\n"
        "  (a) Cd asymmetry — compare Cd grid: if R and ΔP_F move strongly with f_O,f_F, Cd coupling matters.\n"
        "  (b) Fuel tank pressure lower bound — if lowering max_fuel_pressure_psi cap (narrower high-P bound)\n"
        "      shifts ΔP_F/Pc downward while holding MR/thrust, bound was limiting.\n"
        "  (c) Throat-fixed mdot — frozen A_throat ties mdot at Pc; cannot independently satisfy all jets without\n"
        "      compatible injector areas and ΔP split.\n"
        "  (d) AO/AF limits — if sweep never enters feasible set, geometry-pressure coupling dominates.\n"
        "  (e) Momentum coupling — R responds to √(ρ_O/ρ_F)·(v_O/v_F)² with MR tying mdots; fixing throat couples\n"
        "      mdot_sum leaving ΔP and areas to reconcile MR and R.\n"
    )

    print("\nBest geometry under exploration: **Layer-1 optimum above** (frozen throat + relaxed penalties).\n")


if __name__ == "__main__":
    main()
