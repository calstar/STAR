#!/usr/bin/env python3
"""One-shot Layer 1 on impinging_lox_ch4_8000N.yaml (for multiprocessing-safe __main__)."""

from __future__ import annotations

import argparse
import copy
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner
from engine.optimizer.layers.layer1_static_optimization import (
    _expected_geom_ao_af_for_unit_momentum_ratio,
    run_layer1_optimization,
)
from engine.pipeline.io import load_config


def print_impinging_momentum_decomposition(
    perf: dict,
    *,
    rho_o: float,
    rho_f: float,
    optimal_mr: float,
) -> None:
    """Print mdot/ρ/A/v and ρv² terms consistent with impinging bulk momentum_ratio_R."""
    diag = perf.get("diagnostics") or {}
    mdot_o = float(perf.get("mdot_O", diag.get("mdot_O") or float("nan")))
    mdot_f = float(perf.get("mdot_F", diag.get("mdot_F") or float("nan")))
    a_go = perf.get("A_geom_O", diag.get("A_geom_O"))
    a_gf = perf.get("A_geom_F", diag.get("A_geom_F"))
    a_go = float(a_go) if a_go is not None else float("nan")
    a_gf = float(a_gf) if a_gf is not None else float("nan")
    a_eo = perf.get("A_eff_O", diag.get("A_eff_O"))
    a_ef = perf.get("A_eff_F", diag.get("A_eff_F"))
    a_eo = float(a_eo) if a_eo is not None else float("nan")
    a_ef = float(a_ef) if a_ef is not None else float("nan")

    v_o = mdot_o / (rho_o * a_go) if np.isfinite(a_go) and a_go > 0 and rho_o > 0 else float("nan")
    v_f = mdot_f / (rho_f * a_gf) if np.isfinite(a_gf) and a_gf > 0 and rho_f > 0 else float("nan")
    flux_o = rho_o * v_o * v_o if np.isfinite(v_o) else float("nan")
    flux_f = rho_f * v_f * v_f if np.isfinite(v_f) else float("nan")
    r_diag = diag.get("momentum_ratio_R")
    r_diag = float(r_diag) if r_diag is not None and np.isfinite(r_diag) else float("nan")
    r_recon = math.sqrt(flux_o / flux_f) if flux_f > 0 and flux_o >= 0 else float("nan")

    cd_o = perf.get("Cd_O", diag.get("Cd_O"))
    cd_f = perf.get("Cd_F", diag.get("Cd_F"))
    cd_o = float(cd_o) if cd_o is not None else float("nan")
    cd_f = float(cd_f) if cd_f is not None else float("nan")

    exp_af = _expected_geom_ao_af_for_unit_momentum_ratio(optimal_mr, rho_o, rho_f)
    ao_af_geom = a_go / a_gf if np.isfinite(a_go) and np.isfinite(a_gf) and a_gf > 0 else float("nan")
    ao_af_eff = a_eo / a_ef if np.isfinite(a_eo) and np.isfinite(a_ef) and a_ef > 0 else float("nan")

    u_o_lin = diag.get("u_O")
    u_f_lin = diag.get("u_F")
    u_o_lin = float(u_o_lin) if u_o_lin is not None else float("nan")
    u_f_lin = float(u_f_lin) if u_f_lin is not None else float("nan")

    print("\n--- Impinging momentum decomposition (bulk v = mdot/(ρ A_geom_tot)) ---")
    print(f"mdot_O [kg/s]:      {mdot_o:.6g}")
    print(f"mdot_F [kg/s]:      {mdot_f:.6g}")
    print(f"rho_O [kg/m³]:      {rho_o:.6g}")
    print(f"rho_F [kg/m³]:      {rho_f:.6g}")
    print(f"A_geom_O [m²]:      {a_go:.6g}")
    print(f"A_geom_F [m²]:      {a_gf:.6g}")
    print(f"A_eff_O [m²]:       {a_eo:.6g}")
    print(f"A_eff_F [m²]:       {a_ef:.6g}")
    print(f"v_O_bulk [m/s]:     {v_o:.6g}   (runner linear u_O [m/s]: {u_o_lin:.6g})")
    print(f"v_F_bulk [m/s]:     {v_f:.6g}   (runner linear u_F [m/s]: {u_f_lin:.6g})")
    print(f"rho_O*v_O² [Pa]:    {flux_o:.6g}")
    print(f"rho_F*v_F² [Pa]:    {flux_f:.6g}")
    print(f"momentum_ratio_R:   {r_diag:.6g}   (reconstructed √(flux_O/flux_F): {r_recon:.6g})")
    print(f"Cd_O / Cd_F:        {cd_o:.6g} / {cd_f:.6g}")
    print("\n--- Geometry momentum hint (optimizer steering; MR from requirements) ---")
    print(f"A_geom_O/A_geom_F:        {ao_af_geom:.6g}")
    print(f"A_eff_O/A_eff_F:          {ao_af_eff:.6g}")
    print(f"expected_AO_AF_for_R≈1:   {exp_af:.6g}  (= MR/√(ρ_O/ρ_F), MR={optimal_mr:g})")
    pg = perf.get("geom_ao_af")
    pe = perf.get("expected_ao_af_for_R1")
    if pg is not None or pe is not None:
        print(f"(promoted perf geom_ao_af / expected): {pg} / {pe}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--config",
        type=str,
        default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"),
        help="YAML config path",
    )
    ap.add_argument("--layer1-max-iterations", type=int, default=22)
    args = ap.parse_args()

    cfg = load_config(args.config)
    req = cfg.design_requirements.model_dump()
    runner = PintleEngineRunner(copy.deepcopy(cfg))
    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
        "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
    }

    opt_cfg, results = run_layer1_optimization(
        copy.deepcopy(cfg),
        runner,
        req,
        target_burn_time=float(req.get("target_burn_time", 6.0)),
        tolerances={"thrust": 0.10, "apogee": 0.15},
        pressure_config=pcfg,
        layer1_smoke=True,
        layer1_max_iterations=int(args.layer1_max_iterations),
        layer1_cma_restarts=1,
    )

    perf = results.get("performance") or {}
    rho_o = float(opt_cfg.fluids["oxidizer"].density)
    rho_f = float(opt_cfg.fluids["fuel"].density)
    optimal_mr = float(req.get("optimal_of_ratio", 3.5))
    geom = getattr(getattr(opt_cfg, "injector", None), "geometry", None)
    ox = getattr(geom, "oxidizer", None)
    fu = getattr(geom, "fuel", None)

    print("\n=== Layer-1 summary (8000 N impinging, asymmetric ΔP/Pc bands) ===")
    print(
        f"Preferred bands: O [{req.get('injector_dp_ratio_O_min')},{req.get('injector_dp_ratio_O_max')}], "
        f"F [{req.get('injector_dp_ratio_F_min')},{req.get('injector_dp_ratio_F_max')}]"
    )
    print(f"Thrust F [N]:        {perf.get('F')}")
    print(f"O/F (MR):            {perf.get('MR')}")
    print(f"momentum_ratio_R:    {perf.get('momentum_ratio_R')}")
    print(f"ΔP_inj_O / Pc:       {perf.get('injector_dp_ratio_O')}")
    print(f"ΔP_inj_F / Pc:       {perf.get('injector_dp_ratio_F')}")
    print(f"P_O_start_psi:       {perf.get('P_O_start_psi')}")
    print(f"P_F_start_psi:       {perf.get('P_F_start_psi')}")
    print(f"injector_dp_out_of_range: {perf.get('injector_dp_out_of_range')}")
    print(
        f"geom AO/AF diagnostics: AoAf={perf.get('geom_ao_af')}  "
        f"expected_R1={perf.get('expected_ao_af_for_R1')}  "
        f"rel_err={perf.get('geom_ao_af_rel_error')}"
    )
    print_impinging_momentum_decomposition(
        perf, rho_o=rho_o, rho_f=rho_f, optimal_mr=optimal_mr
    )
    if ox and fu:
        print(f"n_elements_O / d_jet_O [mm]: {ox.n_elements} / {ox.d_jet * 1000:.4f}")
        print(f"n_elements_F / d_jet_F [mm]: {fu.n_elements} / {fu.d_jet * 1000:.4f}")
        print(f"spacing_O/spacing_F [mm]: {ox.spacing * 1000:.4f} / {fu.spacing * 1000:.4f}")
        print(f"impingement_angle_O/F [deg]: {ox.impingement_angle:.2f} / {fu.impingement_angle:.2f}")


if __name__ == "__main__":
    main()
