#!/usr/bin/env python3
"""Run Layer 1 on ``configs/impinging_lox_ch4_8000N.yaml`` and print injector / performance summary."""

from __future__ import annotations

import argparse
import copy
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization
from engine.pipeline.io import load_config


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--config",
        default=str(ROOT / "configs" / "impinging_lox_ch4_8000N.yaml"),
        help="YAML path",
    )
    ap.add_argument("--layer1-max-iterations", type=int, default=90)
    ap.add_argument("--layer1-cma-restarts", type=int, default=3)
    ap.add_argument(
        "--layer1-smoke",
        action="store_true",
        help="Short single-restart smoke (overrides iterations if used with scripts)",
    )
    ap.add_argument(
        "--write-config",
        metavar="PATH",
        default=None,
        help="After optimization, write optimized PintleEngineConfig YAML (JSON-safe dump)",
    )
    args = ap.parse_args()

    cfg = load_config(args.config)
    req = cfg.design_requirements.model_dump()
    runner = PintleEngineRunner(copy.deepcopy(cfg))

    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
        "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
    }

    smoke = bool(args.layer1_smoke)
    max_it = max(1, int(args.layer1_max_iterations))
    restarts = 1 if smoke else max(1, int(args.layer1_cma_restarts))

    # Match Layer‑1 gates: thrust fallback uses tolerances["thrust"] only when YAML omits layer1_thrust_validation_rel_tol.
    _thr = req.get("layer1_thrust_validation_rel_tol")
    thrust_tol = float(_thr) if _thr is not None else 0.10

    opt_cfg, results = run_layer1_optimization(
        copy.deepcopy(cfg),
        runner,
        req,
        target_burn_time=float(req.get("target_burn_time", 6.0)),
        tolerances={"thrust": thrust_tol, "apogee": 0.15},
        pressure_config=pcfg,
        layer1_smoke=smoke,
        layer1_max_iterations=max_it if not smoke else min(max_it, 24),
        layer1_cma_restarts=restarts if not smoke else 1,
    )

    perf = results.get("performance") or {}
    diag = perf.get("diagnostics") if isinstance(perf.get("diagnostics"), dict) else {}

    def gv(key: str):
        v = perf.get(key)
        return v if v is not None else diag.get(key)

    ox = opt_cfg.injector.geometry.oxidizer
    fu = opt_cfg.injector.geometry.fuel

    a_go = float(gv("A_geom_O"))
    a_gf = float(gv("A_geom_F"))
    a_eo = float(gv("A_eff_O"))
    a_ef = float(gv("A_eff_F"))

    print("=== Layer 1 optimization ===")
    print(f"config: {args.config}")
    print(f"layer1_smoke={smoke}  max_iterations={max_it if not smoke else min(max_it, 24)}  cma_restarts={restarts}")
    print(f"requirements: thrust={req.get('target_thrust')} N  MR={req.get('optimal_of_ratio')}")
    imp_deg = float(ox.impingement_angle) + float(fu.impingement_angle)
    print(f"impingement: θ_total = θ_O+θ_F = {imp_deg:.2f} deg (solver uses this)")
    print()
    print(f"thrust F [N]:              {perf.get('F')}")
    print(f"MR (O/F):                   {perf.get('MR')}")
    print(f"momentum_ratio_R:           {perf.get('momentum_ratio_R')}")
    print(f"ΔP_O/Pc:                    {perf.get('injector_dp_ratio_O')}")
    print(f"ΔP_F/Pc:                    {perf.get('injector_dp_ratio_F')}")
    print(f"P_O / P_F [psi]:           {perf.get('P_O_start_psi')} / {perf.get('P_F_start_psi')}")
    if getattr(opt_cfg.injector, "type", None) == "impinging" and isinstance(diag, dict):
        print(
            "injector inlet P_inj [Pa]: "
            f"O={diag.get('P_injector_O')}  F={diag.get('P_injector_F')}"
        )
        print(
            "Δp_feed tank→inj [Pa]:    "
            f"O={diag.get('delta_p_feed_O')}  F={diag.get('delta_p_feed_F')}"
        )
        print(
            "Δp_inj jet→Pc [Pa]:       "
            f"O={diag.get('delta_p_injector_O')}  F={diag.get('delta_p_injector_F')}  "
            "(ΔP/Pc ratios use these ÷ Pc; tank−Pc would wrongly include feed losses)"
        )
    print(f"Cd_O / Cd_F:               {gv('Cd_O')} / {gv('Cd_F')}")
    print(f"A_geom_O/A_geom_F:          {a_go / a_gf:.6g}")
    print(f"A_eff_O/A_eff_F:           {a_eo / a_ef:.6g}")
    n_d = int(min(int(ox.n_elements), int(fu.n_elements)))
    print(f"n_doublets (min O/F):       {n_d}")
    print(
        f"n_O / n_F:                 {int(ox.n_elements)} / {int(fu.n_elements)}\n"
        f"d_jet_O / d_jet_F [mm]:    {float(ox.d_jet) * 1000:.5f} / {float(fu.d_jet) * 1000:.5f}\n"
        f"spacing_O / spacing_F [mm]: "
        f"{float(ox.spacing) * 1000:.5f} / {float(fu.spacing) * 1000:.5f}\n"
        f"θ_O / θ_F [deg]:            {float(ox.impingement_angle):.2f} / {float(fu.impingement_angle):.2f}"
    )
    foci = diag.get("feed_orifice_coupling_iterations")
    print(f"feed_orifice_coupling_iterations: {foci}")
    mdo, mdf = perf.get("mdot_O"), perf.get("mdot_F")
    mbo, mbf = diag.get("mdot_from_bernoulli_O"), diag.get("mdot_from_bernoulli_F")
    print(f"mdot_O / mdot_from_Bern_O:  {mdo} / {mbo}")
    print(f"mdot_F / mdot_from_Bern_F: {mdf} / {mbf}")
    print(f"pressure_candidate_valid:   {perf.get('pressure_candidate_valid')}")
    fr = perf.get("failure_reasons")
    if fr:
        print(f"failure_reasons:           {fr}")
    cg = opt_cfg.chamber_geometry
    if cg is not None:
        print(f"A_throat [m²] (optimized): {getattr(cg, 'A_throat', None)}")
    if args.write_config:
        out = Path(args.write_config)
        out.parent.mkdir(parents=True, exist_ok=True)
        data = opt_cfg.model_dump(mode="json")
        out.write_text(yaml.safe_dump(data, sort_keys=False))
        print(f"wrote optimized config: {out.resolve()}")


if __name__ == "__main__":
    main()
