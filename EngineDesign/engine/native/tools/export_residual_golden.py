#!/usr/bin/env python3
"""Export residual-physics parity samples: for the canonical config, dump the
combustion-efficiency components and ablative cooling_eff that the chamber residual
computes, at a sweep of (P_tank_O, P_tank_F, Pc) points. Self-contained: each
sample carries the config-derived struct fields so the C test reconstructs an
identical EdCombustionEff / EdCooling / EdGeometry. Read-only on engine/.

    python engine/native/tools/export_residual_golden.py --out engine/native/tests/golden
"""
import argparse, json, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from engine.pipeline.io import load_config
from engine.pipeline.config_schemas import ensure_chamber_geometry
from engine.core.closure import flows
from engine.core.chamber_solver import ChamberSolver
from engine.pipeline.cea_cache import CEACache
from engine.pipeline.combustion_eff import calculate_Lstar, blend_cooling_into_cstar
from engine.pipeline.combustion_physics import calculate_combustion_efficiency_advanced

EFF_MODEL = {"constant": 0, "linear": 1, "exponential": 2}


def comb_dict(eff):
    return {
        "model": EFF_MODEL[eff.model], "C": float(eff.C), "K": float(eff.K),
        "tau_ref": float(eff.tau_ref), "tau_ref_P": float(eff.tau_ref_P),
        "tau_ref_T": float(eff.tau_ref_T), "n_pressure": float(eff.n_pressure),
        "has_tau_Tc_floor": int(getattr(eff, "tau_Tc_floor_K", None) is not None),
        "tau_Tc_floor": float(getattr(eff, "tau_Tc_floor_K", None) or 0.0),
        "Em_peak": float(getattr(eff, "Em_peak", 0.96)),
        "mixing_sigma": float(getattr(eff, "mixing_sigma", 1.5)),
        "R_opt": float(getattr(eff, "R_opt", None) or 0.0),
    }


def cooling_dict(cfg):
    rg, ab, eff = cfg.regen_cooling, cfg.ablative_cooling, cfg.combustion.efficiency
    fc = cfg.film_cooling
    return {
        "regen_enabled": int(bool(rg and rg.enabled)),
        "film_enabled": int(bool(fc and fc.enabled)),
        "ablative_enabled": int(bool(ab and ab.enabled)),
        "graphite_enabled": int(bool(getattr(cfg, "graphite_insert", None) and cfg.graphite_insert.enabled)),
        "use_cooling_coupling": int(bool(eff.use_cooling_coupling)),
        "hot_gas_viscosity": float(rg.hot_gas_viscosity),
        "hot_gas_thermal_conductivity": float(rg.hot_gas_thermal_conductivity),
        "hot_gas_cp": float(rg.hot_gas_cp),
        "hot_gas_prandtl": float(rg.hot_gas_prandtl),
        "gas_turbulence_intensity": float(rg.gas_turbulence_intensity),
        "recovery_factor": float(rg.recovery_factor) if rg.recovery_factor is not None else 0.94,
        "radiation_emissivity_hot": float(rg.radiation_emissivity_hot),
        "radiation_view_factor": float(rg.radiation_view_factor),
        "regen_chamber_inner_diameter": float(rg.chamber_inner_diameter),
        "ablative_coverage_fraction": float(ab.coverage_fraction),
        "ablative_surface_temperature_limit": float(ab.surface_temperature_limit),
        "ablative_material_density": float(ab.material_density),
        "ablative_heat_of_ablation": float(ab.heat_of_ablation),
        "ablative_specific_heat": float(ab.specific_heat),
        "ablative_pyrolysis_temperature": float(ab.pyrolysis_temperature),
        "ablative_use_physics_based_blowing": int(bool(ab.use_physics_based_blowing)),
        "ablative_blowing_efficiency": float(ab.blowing_efficiency),
        "ablative_blowing_coefficient": float(ab.blowing_coefficient),
        "ablative_blowing_min_reduction_factor": float(ab.blowing_min_reduction_factor),
        "ablative_turbulence_reference_intensity": float(ab.turbulence_reference_intensity),
        "ablative_turbulence_sensitivity": float(ab.turbulence_sensitivity),
        "ablative_turbulence_exponent": float(ab.turbulence_exponent),
        "ablative_turbulence_max_multiplier": float(ab.turbulence_max_multiplier),
        "ablative_surface_emissivity": float(ab.surface_emissivity),
        "ablative_ambient_temperature": float(ab.ambient_temperature),
        "ablative_radiative_sink_minimum_threshold": float(ab.radiative_sink_minimum_threshold),
        "ablative_radiative_sink_fallback_temperature": float(ab.radiative_sink_fallback_temperature),
        "cooling_efficiency_floor": float(eff.cooling_efficiency_floor),
    }


def geom_dict(cg):
    return {
        "A_throat": float(cg.A_throat), "A_exit": float(cg.A_exit), "volume": float(cg.volume),
        "Lstar": float(cg.Lstar) if cg.Lstar else 0.0, "length": float(cg.length),
        "length_cylindrical": float(cg.length_cylindrical or 0.0),
        "length_contraction": float(cg.length_contraction or 0.0),
        "chamber_diameter": float(cg.chamber_diameter or 0.0),
        "exit_diameter": float(cg.exit_diameter or 0.0),
        "expansion_ratio": float(cg.expansion_ratio),
        "nozzle_efficiency": float(cg.nozzle_efficiency), "Cf": float(cg.Cf or 0.0),
        "design_pressure": float(cg.design_pressure or 0.0),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="configs/canonical/impinging.yaml")
    ap.add_argument("--out", default="engine/native/tests/golden")
    args = ap.parse_args()

    cfg = load_config(args.config)
    cg = ensure_chamber_geometry(cfg)
    cache = CEACache(cfg.combustion.cea)
    solver = ChamberSolver(cfg, cache)
    solver._debug = False
    eff = cfg.combustion.efficiency

    comb = comb_dict(eff)
    cooling = cooling_dict(cfg)
    geom = geom_dict(cg)

    fuel = cfg.fluids["fuel"]
    L_eff = float(getattr(fuel, "latent_heat", 300e3))
    T_star_cap = float(getattr(eff, "T_star_fuel_cap_K", 1000.0))
    Dinj = float(cfg.injector.geometry.oxidizer.d_jet)
    Lstar = float(calculate_Lstar(cg.volume, cg.A_throat, Lstar_override=cg.Lstar))
    Ac = float(3.141592653589793 * (cg.chamber_diameter / 2.0) ** 2)
    eps_default = float(cg.expansion_ratio)

    PSI = 6894.757293168
    samples = []
    for po_psi in (500.0, 540.0, 580.0):
        for pf_psi in (520.0, 560.0):
            P_O, P_F = po_psi * PSI, pf_psi * PSI
            for Pc in (1.8e6, 2.2e6, 2.6e6):
                try:
                    mo, mf, diag = flows(P_O, P_F, Pc, cfg)
                    MR = mo / mf
                    cea = cache.eval(MR, Pc, 101325.0, eps_default)
                    Tc, gamma, R, M = cea["Tc"], cea["gamma"], cea["R"], cea["M"]
                    cstar_ideal = cea["cstar_ideal"]
                    momentum_ratio_R = diag.get("momentum_ratio_R")
                    R_opt = solver._rupe_R_opt()
                    res = calculate_combustion_efficiency_advanced(
                        Lstar, Pc, Tc, cstar_ideal, gamma, R, MR, eff,
                        Ac, cg.A_throat, Dinj, mo + mf,
                        u_fuel=diag["u_F"], u_lox=diag["u_O"],
                        spray_diagnostics=diag,
                        momentum_ratio_R=momentum_ratio_R, R_opt=R_opt,
                        chamber_length=cg.length, fuel_props=solver._get_fuel_props(),
                    )
                    _, cooling_eff, eff_Tc = solver._evaluate_cooling_models(Pc, mo, mf, cea, diag)
                    heat_removed = 0.0
                    cool = diag.get("cooling", {})
                    if isinstance(cool, dict) and isinstance(cool.get("ablative"), dict):
                        heat_removed = float(cool["ablative"].get("heat_removed", 0.0))
                    # Matches ed_chamber.c: c* efficiency = combustion x
                    # sqrt(cooling), because cooling is an energy fraction and
                    # c* goes as sqrt(Tc). Was linear here; that is what made
                    # this golden stale after the sqrt fix.
                    eta_final = blend_cooling_into_cstar(res["eta_total"], cooling_eff)
                    cstar_actual = eta_final * cstar_ideal
                    mdot_demand = Pc * cg.A_throat / cstar_actual
                    samples.append({
                        "P_tank_O": P_O, "P_tank_F": P_F, "Pc": Pc,
                        "mdot_O": mo, "mdot_F": mf, "MR": MR,
                        "Lstar": Lstar, "Ac": Ac, "At": float(cg.A_throat),
                        "Dinj": Dinj, "chamber_length": float(cg.length),
                        "D32_O": float(diag.get("D32_O") or 0.0), "D32_F": float(diag.get("D32_F") or 0.0),
                        "u_O": float(diag["u_O"]), "u_F": float(diag["u_F"]),
                        "momentum_ratio_R": float(momentum_ratio_R), "R_opt": float(R_opt),
                        "Tc": Tc, "gamma": gamma, "R": R, "M": M, "cstar_ideal": cstar_ideal,
                        "fuel_latent_heat": L_eff, "fuel_T_star_cap": T_star_cap,
                        # expected
                        "eta_Lstar": res["eta_Lstar"], "eta_kinetics": res["eta_kinetics"],
                        "eta_mixing": res["eta_mixing"],
                        "eta_total": res["eta_total"], "cooling_eff": float(cooling_eff),
                        "heat_removed": heat_removed, "eta_final": eta_final,
                        "cstar_actual": cstar_actual, "mdot_demand": mdot_demand,
                    })
                except Exception as e:  # noqa: BLE001
                    samples.append({"P_tank_O": P_O, "P_tank_F": P_F, "Pc": Pc,
                                    "_error": str(e)[:160]})

    os.makedirs(args.out, exist_ok=True)
    out = {"comb": comb, "cooling": cooling, "geom": geom, "samples": samples}
    path = os.path.join(args.out, "residual_samples.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1)
    ok = sum(1 for s in samples if "_error" not in s)
    print(f"[ok] wrote {path}  ({ok}/{len(samples)} samples)")


if __name__ == "__main__":
    main()
