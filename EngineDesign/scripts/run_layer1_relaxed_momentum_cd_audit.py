#!/usr/bin/env python3
"""Part 2–3: free-throat Layer-1 with relaxed momentum_ratio_R bands + metrics/Cd reporting.

Requirements keys (optimizer-only; no injector physics edits)::

    impinging_momentum_R_min / impinging_momentum_R_max  — ratio-space deadband for W_MOM hinge

Runs Case A [0.85, 1.15] and Case B [0.75, 1.25], then ±10%% Cd scaling diagnostic on Case B optimum.

Also prints Part 1 Cd model summary from YAML ``discharge`` + ``engine.core.discharge.cd_from_re``.
"""

from __future__ import annotations

import argparse
import copy
import math
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PSI_TO_PA = 6894.76

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization  # noqa: E402
from engine.pipeline.config_schemas import DischargeConfig  # noqa: E402
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


def _scale_dc(dc: DischargeConfig, factor: float) -> None:
    dc.Cd_inf = float(np.clip(dc.Cd_inf * factor, 1e-6, 1.0))
    dc.Cd_min = float(min(dc.Cd_min * factor, dc.Cd_inf))


def _cd_scaled_cfg(base_cfg: Any, fo: float, ff: float) -> Any:
    c = copy.deepcopy(base_cfg)
    _scale_dc(c.discharge["oxidizer"], fo)
    _scale_dc(c.discharge["fuel"], ff)
    return c


def _mission_ok(
    perf: Dict[str, Any],
    *,
    r_lo: float,
    r_hi: float,
    dp_lo: float,
    dp_hi: float,
) -> bool:
    F = _sf(perf.get("F"))
    MR = _sf(perf.get("MR"))
    R = _sf(perf.get("momentum_ratio_R"))
    ro, rf = _dp_ratios(perf)
    ok_f = abs(F - 8000.0) / 8000.0 <= 0.05
    ok_mr = abs(MR - 3.5) / 3.5 <= 0.05
    ok_r = r_lo <= R <= r_hi
    ok_dp = (
        dp_lo <= ro <= dp_hi
        and dp_lo <= rf <= dp_hi
        and math.isfinite(ro)
        and math.isfinite(rf)
    )
    return bool(ok_f and ok_mr and ok_r and ok_dp)


def _print_cd_audit(cfg_path: Path) -> None:
    cfg = load_config(str(cfg_path))
    ox = cfg.discharge["oxidizer"]
    fu = cfg.discharge["fuel"]
    print("\n" + "=" * 72)
    print("PART 1 — Discharge coefficient model (audit)")
    print("=" * 72)
    print(
        "Solver uses ``engine.core.discharge.cd_from_re``:\n"
        "  Cd(Re) = Cd_inf - a_Re / sqrt(Re)   (Re > 0; else Cd_min)\n"
        "  then optional pressure/temperature multipliers if enabled;\n"
        "  finally clip to [Cd_min, Cd_inf].\n"
    )
    print(f"YAML defaults — oxidizer: Cd_inf={ox.Cd_inf}  Cd_min={ox.Cd_min}  a_Re={ox.a_Re}")
    print(f"YAML defaults — fuel:      Cd_inf={fu.Cd_inf}  Cd_min={fu.Cd_min}  a_Re={fu.a_Re}")
    print(
        "\nLOX vs CH4 Cd differ because ``discharge`` entries differ (Cd_inf/Cd_min/a_Re/Re path);\n"
        "the **same function** is applied per stream with its own ``DischargeConfig``.\n"
    )


def _print_case(name: str, perf: Dict[str, Any], opt_cfg: Any, *, r_band: Tuple[float, float]) -> None:
    ro, rf = _dp_ratios(perf)
    cdo, cdf = _cds(perf)
    ig = opt_cfg.injector.geometry
    cg = getattr(opt_cfg, "chamber_geometry", None)
    at = getattr(cg, "A_throat", None) if cg is not None else None
    at_mm2 = float(at) * 1e6 if at is not None else float("nan")

    ae_o = perf.get("A_eff_O") or (perf.get("diagnostics") or {}).get("A_eff_O")
    ae_f = perf.get("A_eff_F") or (perf.get("diagnostics") or {}).get("A_eff_F")
    aeff_ratio = float(ae_o) / float(ae_f) if ae_o and ae_f and float(ae_f) > 0 else float("nan")

    print(f"\n{'=' * 72}\n{name}\n{'=' * 72}")
    print(f"A_throat [mm²]:     {at_mm2:.4f}")
    print(f"Thrust [N]:         {_sf(perf.get('F')):.4g}")
    print(f"MR:                 {_sf(perf.get('MR')):.6g}")
    print(f"momentum_ratio_R:   {_sf(perf.get('momentum_ratio_R')):.6g}  (optimizer band {r_band})")
    print(f"ΔP_inj_O/Pc:        {ro:.6g}")
    print(f"ΔP_inj_F/Pc:        {rf:.6g}")
    print(f"Cd_O / Cd_F:        {cdo:.6g} / {cdf:.6g}")
    print(f"A_geom_O/A_geom_F:  {perf.get('geom_ao_af')}")
    print(f"A_eff_O/A_eff_F:    {aeff_ratio:.6g}")
    print(f"P_O_psi / P_F_psi:  {perf.get('P_O_start_psi')} / {perf.get('P_F_start_psi')}")
    print(
        f"Injector LOX: n={int(ig.oxidizer.n_elements)} d_jet={ig.oxidizer.d_jet*1000:.4f} mm "
        f"spacing={ig.oxidizer.spacing*1000:.4f} mm angle={ig.oxidizer.impingement_angle:.2f}°"
    )
    print(
        f"Injector F:   n={int(ig.fuel.n_elements)} d_jet={ig.fuel.d_jet*1000:.4f} mm "
        f"spacing={ig.fuel.spacing*1000:.4f} mm angle={ig.fuel.impingement_angle:.2f}°"
    )


def _cd_sensitivity_grid(opt_cfg: Any, po_pa: float, pf_pa: float) -> None:
    runner_ref = PintleEngineRunner(copy.deepcopy(opt_cfg))
    pa = runner_ref._get_ambient_pressure(None)
    print("\n" + "=" * 72)
    print("PART 1 (continued) — ±10% Cd_O / Cd_F diagnostic (evaluate only)")
    print("=" * 72)
    print(f"{'f_O':>6} {'f_F':>6} {'R':>8} {'dP_F/Pc':>10} {'MR':>8} {'F[N]':>10}")
    print("-" * 52)
    for fo in (0.9, 1.0, 1.1):
        for ff in (0.9, 1.0, 1.1):
            rcfg = _cd_scaled_cfg(opt_cfg, fo, ff)
            ev = PintleEngineRunner(rcfg).evaluate(po_pa, pf_pa, P_ambient=pa, silent=True)
            diag = ev.get("diagnostics") or {}
            R = diag.get("momentum_ratio_R")
            pc = float(ev.get("Pc", float("nan")))
            dpf = diag.get("delta_p_injector_F")
            rf = float(dpf) / pc if dpf is not None and pc > 0 else float("nan")
            print(
                f"{fo:6.2f} {ff:6.2f} {_sf(R):8.4f} {rf:10.4f} {_sf(ev.get('MR')):8.4f} "
                f"{_sf(ev.get('F')):10.2f}"
            )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=str, default=str(ROOT / "configs/impinging_lox_ch4_8000N.yaml"))
    ap.add_argument("--a-throat-center-mm2", type=float, default=2443.263433372886)
    ap.add_argument("--throat-span-fraction", type=float, default=0.125)
    ap.add_argument("--layer1-max-iterations", type=int, default=150)
    ap.add_argument("--layer1-cma-restarts", type=int, default=1)
    args = ap.parse_args()

    cfg_path = Path(args.config)
    center = float(args.a_throat_center_mm2)
    frac = float(args.throat_span_fraction)
    dp_band = (0.15, 0.40)

    _print_cd_audit(cfg_path)

    scenarios = [
        ("CASE A — R band [0.85, 1.15]", 0.85, 1.15),
        ("CASE B — R band [0.75, 1.25]", 0.75, 1.25),
    ]

    results_store: Dict[str, Any] = {}

    print("\n" + "=" * 72)
    print("PART 2–3 — Layer-1 with relaxed R hinge")
    print("=" * 72)

    for title, r_lo, r_hi in scenarios:
        cfg = load_config(str(cfg_path))
        req = cfg.design_requirements.model_dump()
        _clean_frozen(req)

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

        pcfg = {
            "mode": "optimizer_controlled",
            "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
            "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
        }

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
        key = "A" if r_lo >= 0.85 else "B"
        results_store[key] = {"perf": perf, "opt_cfg": opt_cfg, "r_band": (r_lo, r_hi)}

        _print_case(title, perf, opt_cfg, r_band=(r_lo, r_hi))

        joint = _mission_ok(perf, r_lo=r_lo, r_hi=r_hi, dp_lo=dp_band[0], dp_hi=dp_band[1])
        print(f"\n** Mission gates (F±5%, MR±5%, R∈[{r_lo},{r_hi}], both ΔP∈{dp_band}): "
              f"{'YES' if joint else 'NO'} **")

    print("\n" + "=" * 72)
    print("Cd table — best candidates (Cases A & B)")
    print("=" * 72)
    print(f"{'case':>6} {'Cd_O':>8} {'Cd_F':>8}")
    print("-" * 26)
    for key, lab in ("A", "A"), ("B", "B"):
        if key not in results_store:
            continue
        perf = results_store[key]["perf"]
        cdo, cdf = _cds(perf)
        print(f"{lab:>6} {cdo:8.4f} {cdf:8.4f}")

    # Sensitivity on Case B optimum (typically more slack)
    if "B" in results_store:
        perf_b = results_store["B"]["perf"]
        cfg_b = results_store["B"]["opt_cfg"]
        po = float(perf_b["P_O_start_psi"]) * PSI_TO_PA
        pf = float(perf_b["P_F_start_psi"]) * PSI_TO_PA
        _cd_sensitivity_grid(cfg_b, po, pf)

    print("\n" + "=" * 72)
    print("PART 4 — Dominant constraint (heuristic)")
    print("=" * 72)
    print(
        "If ΔP_inj_F/Pc ≫ 0.40 while LOX sits in-band: **(b) fuel injector pressure drop** / "
        "tank–Pc split dominates.\n"
        "If throat + mdot coupling prevents lowering fuel ΔP without breaking thrust/MR: **(c)**.\n"
        "Cd asymmetry **(a)**: check sensitivity grid — strong motion of R/MR/ΔP_F with f_O,f_F supports "
        "**audit-only** asymmetry.\n"
        "AO/AF limits **(d)** / momentum **(e)**: W_geom + R hinge guide geometry; relaxed R reduces **(e)** "
        "pressure on the optimizer.\n"
    )

    best_key = "B" if "B" in results_store else "A"
    bc = results_store[best_key]["opt_cfg"]
    ig = bc.injector.geometry
    print(
        "Best candidate geometry (prefer Case B if present — otherwise A):\n"
        f"  LOX n={int(ig.oxidizer.n_elements)} d={ig.oxidizer.d_jet*1000:.4f} mm "
        f"sp={ig.oxidizer.spacing*1000:.3f} mm θ={ig.oxidizer.impingement_angle:.2f}°\n"
        f"  F   n={int(ig.fuel.n_elements)} d={ig.fuel.d_jet*1000:.4f} mm "
        f"sp={ig.fuel.spacing*1000:.3f} mm θ={ig.fuel.impingement_angle:.2f}°"
    )


if __name__ == "__main__":
    main()
