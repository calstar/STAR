#!/usr/bin/env python3
"""Read-only thrust-model comparison harness (Step 1 of the thrust-bug investigation).

For a set of configs, operating points, expansion ratios, and ambient pressures, compare
three thrust numbers WITHOUT touching any production code:

  1. MODEL    — engine/core/nozzle.py momentum + shifting reconstruction (runner.evaluate).
  2. CF_VAC   — F(Pa) = Cf_vac * Pc * At - Pa * Ae, with Cf_vac from CEA at the model's real Pc.
                Efficiency rides in through Pc (the chamber solve already reduced it by eta_c*).
  3. CEA ref  — CEA's ideal equilibrium ambient Isp (the ceiling) and eta_c**ideal (physical target).

The claim under test: delivered Isp must be <= eta_c* * Isp_ideal. The MODEL instead sits at the
ideal ceiling; the CF_VAC method should land at eta_c**ideal.

Run:  ED_USE_NATIVE=0 python scripts/thrust_model_comparison.py
"""
import os
import sys
from pathlib import Path

os.environ["ED_USE_NATIVE"] = "0"  # pure-Python authoritative path is the subject under test
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402
from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.pipeline.cea_cache import _get_CEA_Obj  # noqa: E402

G0 = 9.80665
PSI = 6894.76
CONFIGS = [
    ("impinging/CH4", "configs/canonical/impinging.yaml"),
    ("pintle/Ethanol", "configs/canonical/pintle.yaml"),
]


def cea_obj(cfg):
    return _get_CEA_Obj()(oxName=cfg.combustion.cea.ox_name, fuelName=cfg.combustion.cea.fuel_name)


def cea_refs(ch, Pc_pa, MR, eps, Pa_pa):
    """CEA ideal numbers at the model's real operating point."""
    P = Pc_pa / PSI
    isp_vac = ch.get_Isp(Pc=P, MR=MR, eps=eps)                       # s, vacuum, equilibrium
    cstar = ch.get_Cstar(Pc=P, MR=MR) * 0.3048                       # m/s
    cf_vac = isp_vac * G0 / cstar                                    # vacuum thrust coeff
    try:
        isp_amb = ch.estimate_Ambient_Isp(Pc=P, MR=MR, eps=eps, Pamb=Pa_pa / PSI)[0]
    except Exception:
        isp_amb = float("nan")
    return cf_vac, cstar, isp_vac, isp_amb


def one_case(runner, ch, P_O_pa, P_F_pa, Pa_pa, eps_override=None):
    cfg = runner.config
    cg = cfg.chamber_geometry
    if eps_override is not None:
        cg.expansion_ratio = eps_override
        cg.A_exit = eps_override * cg.A_throat
    res = runner.evaluate(P_O_pa, P_F_pa, P_ambient=Pa_pa)
    Pc, MR, mdot = res["Pc"], res["MR"], res["mdot_total"]
    At, Ae, eps = cg.A_throat, cg.A_exit, cg.expansion_ratio
    eta = (res.get("diagnostics") or {}).get("eta_cstar", float("nan"))

    model_F = res["F"]
    model_Isp = model_F / (mdot * G0)

    cf_vac, cstar, isp_vac, isp_amb = cea_refs(ch, Pc, MR, eps, Pa_pa)
    cfvac_F = cf_vac * Pc * At - Pa_pa * Ae      # delivered thrust, perfect nozzle, real Pc
    cfvac_Isp = cfvac_F / (mdot * G0)
    expected_Isp = eta * isp_amb                  # physically correct delivered (eta_cf=1)

    return dict(Pc=Pc, MR=MR, eps=eps, eta=eta, mdot=mdot,
                model_F=model_F, model_Isp=model_Isp,
                cfvac_F=cfvac_F, cfvac_Isp=cfvac_Isp,
                ceiling=isp_amb, expected=expected_Isp,
                model_err=model_Isp / isp_amb - 1.0,        # vs ideal ceiling
                model_vs_expected=model_Isp / expected_Isp - 1.0,
                cfvac_vs_expected=cfvac_Isp / expected_Isp - 1.0)


def fmt_row(label, r):
    flag = "  <<OVER CEILING>>" if r["model_Isp"] > r["ceiling"] else ""
    return (f"  {label:22s} Pc={r['Pc']/1e6:5.2f}MPa MR={r['MR']:.2f} eps={r['eps']:.2f} "
            f"eta={r['eta']:.3f} | MODEL Isp={r['model_Isp']:6.1f} CF_VAC={r['cfvac_Isp']:6.1f} "
            f"ceiling={r['ceiling']:6.1f} expected={r['expected']:6.1f} | "
            f"model+{r['model_vs_expected']*100:5.1f}% cfvac{r['cfvac_vs_expected']*100:+4.1f}%{flag}")


def main():
    for name, path in CONFIGS:
        cfg = load_config(path)
        runner = PintleEngineRunner(cfg)
        ch = cea_obj(cfg)
        print(f"\n{'='*120}\n{name}  ({path})\n{'='*120}")

        print("\n[A] Operating-point sweep (sea level, design eps):")
        for po, pf in [(1305, 974), (1200, 900), (1100, 820), (1000, 750), (900, 680)]:
            try:
                print(fmt_row(f"P=({po},{pf})", one_case(runner, ch, po*PSI, pf*PSI, 101325.0)))
            except Exception as e:
                print(f"  P=({po},{pf})  skipped: {type(e).__name__}: {e}")

        print("\n[B] Expansion-ratio sweep (P=(1305,974), sea level):")
        base_eps = cfg.chamber_geometry.expansion_ratio
        for eps in [3.0, 4.0, 5.0, 6.5, 8.0]:
            try:
                print(fmt_row(f"eps={eps}", one_case(runner, ch, 1305*PSI, 974*PSI, 101325.0, eps_override=eps)))
            except Exception as e:
                print(f"  eps={eps}  skipped: {type(e).__name__}: {e}")
        cfg.chamber_geometry.expansion_ratio = base_eps
        cfg.chamber_geometry.A_exit = base_eps * cfg.chamber_geometry.A_throat

        print("\n[C] Altitude sweep (P=(1305,974), design eps):")
        for alt_pa in [101325.0, 70000.0, 40000.0, 10000.0, 1.0]:
            try:
                print(fmt_row(f"Pa={alt_pa/1000:.0f}kPa", one_case(runner, ch, 1305*PSI, 974*PSI, alt_pa)))
            except Exception as e:
                print(f"  Pa={alt_pa}  skipped: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
