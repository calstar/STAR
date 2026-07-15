#!/usr/bin/env python3
"""Export impinging-injector parity samples for the Stage 2 C golden test.

Emits the frozen state once (flat dotted keys the C test reads into an
EdEngineState) plus a sweep of (P_tank_O, P_tank_F, Pc) with the live-Python
ImpingingInjector.solve() outputs. NEW FILE, read-only on engine/.

    python engine/native/tools/export_injector_golden.py --out engine/native/tests/golden
"""
import argparse
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from engine.pipeline.io import load_config                  # noqa: E402
from engine.core.injectors import get_injector_model        # noqa: E402

PHI = {"none": 0, "sqrtP": 1, "logP": 2}
PSI = 6894.757293168


def disc(prefix, c, out):
    for k in ("Cd_inf", "a_Re", "Cd_min", "d_ref_m", "d_min_m",
              "cd_small_hole_exponent", "cd_large_hole_log_gain",
              "cd_inf_max", "cd_inf_min_geom", "P_ref", "a_P", "T_ref", "a_T"):
        out[f"{prefix}.{k}"] = float(getattr(c, k))
    for k in ("use_geometry_cd", "use_pressure_correction", "use_temperature_correction"):
        out[f"{prefix}.{k}"] = int(bool(getattr(c, k)))


def feed(prefix, c, out):
    out[f"{prefix}.d_inlet"] = float(getattr(c, "d_inlet", 0.0) or 0.0)
    out[f"{prefix}.A_hydraulic"] = float(getattr(c, "A_hydraulic", 0.0) or 0.0)
    out[f"{prefix}.K0"] = float(c.K0)
    out[f"{prefix}.K1"] = float(c.K1)
    out[f"{prefix}.phi_type"] = PHI[c.phi_type]


def fluid(prefix, f, out):
    out[f"{prefix}.density"] = float(f.density)
    out[f"{prefix}.viscosity"] = float(f.viscosity)
    out[f"{prefix}.surface_tension"] = float(f.surface_tension)
    out[f"{prefix}.temperature"] = float(getattr(f, "temperature", 0.0) or 0.0)


def build_state(cfg):
    g = cfg.injector.geometry
    sp = cfg.spray
    s = {}
    s["injector.type"] = {"pintle": 0, "impinging": 1, "coaxial": 2}[cfg.injector.type]
    for prefix, b in (("imp_O", g.oxidizer), ("imp_F", g.fuel)):
        s[f"{prefix}.n_elements"] = int(b.n_elements)
        s[f"{prefix}.d_jet"] = float(b.d_jet)
        s[f"{prefix}.impingement_angle"] = float(b.impingement_angle)
        s[f"{prefix}.spacing"] = float(getattr(b, "spacing", 0.0) or 0.0)
    disc("discharge_O", cfg.discharge["oxidizer"], s)
    disc("discharge_F", cfg.discharge["fuel"], s)
    feed("feed_O", cfg.feed_system["oxidizer"], s)
    feed("feed_F", cfg.feed_system["fuel"], s)
    fluid("fluid_O", cfg.fluids["oxidizer"], s)
    fluid("fluid_F", cfg.fluids["fuel"], s)
    s["spray.smd_model"] = 1 if sp.smd.model == "ingebo" else 0
    s["spray.smd_C"] = float(sp.smd.C)
    s["spray.smd_m"] = float(sp.smd.m)
    s["spray.smd_p"] = float(sp.smd.p)
    s["spray.smd_C_ingebo"] = float(sp.smd.C_ingebo)
    wcm = getattr(sp.smd, "we_corr_max", None)
    s["spray.smd_we_corr_max"] = float(wcm) if wcm else 0.0
    s["spray.chamber_gas_R"] = float(sp.smd.chamber_gas_R)
    s["spray.chamber_gas_T"] = float(sp.smd.chamber_gas_T)
    s["spray.spray_angle_model"] = 0 if sp.spray_angle.model == "J" else 1
    s["spray.spray_angle_k"] = float(sp.spray_angle.k)
    s["spray.spray_angle_n"] = float(sp.spray_angle.n)
    s["spray.we_min"] = float(sp.weber.get("We_min", 15.0))
    s["spray.evap_K"] = float(sp.evaporation.K)
    s["spray.evap_x_star_limit"] = float(sp.evaporation.x_star_limit)
    s["spray.evap_use_constraint"] = int(bool(sp.evaporation.use_constraint))
    s["solver.closure_max_iterations"] = int(cfg.solver.closure.max_iterations)
    s["solver.closure_Cd_reduction_factor"] = float(cfg.solver.closure.Cd_reduction_factor)
    s["cooling.regen_enabled"] = int(bool(cfg.regen_cooling and cfg.regen_cooling.enabled))
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="configs/canonical/impinging.yaml")
    ap.add_argument("--out", default="engine/native/tests/golden")
    args = ap.parse_args()

    cfg = load_config(args.config)
    model = get_injector_model(cfg)
    state = build_state(cfg)

    rng = np.random.default_rng(3)
    samples = []
    for i in range(24):
        P_O = (500.0 + 70.0 * (i / 23.0)) * PSI + float(rng.uniform(-10, 10)) * PSI
        P_F = P_O + float(rng.uniform(-12, 12)) * PSI
        Pc = (1.4e6 + 1.2e6 * (i / 23.0))
        mO, mF, d = model.solve(P_O, P_F, Pc)
        samples.append({
            "P_tank_O": P_O, "P_tank_F": P_F, "Pc": Pc,
            "mdot_O": float(mO), "mdot_F": float(mF),
            "Cd_O": float(d["Cd_O"]), "Cd_F": float(d["Cd_F"]),
            "momentum_ratio_R": float(d.get("momentum_ratio_R", float("nan"))),
            "A_geom_O": float(d["A_geom_O"]), "A_geom_F": float(d["A_geom_F"]),
            "D32_O": float(d["D32_O"]), "D32_F": float(d["D32_F"]),
            "We_O": float(d["We_O"]), "We_F": float(d["We_F"]),
            "J": float(d["J"]), "TMR": float(d["TMR"]), "theta": float(d["theta"]),
            "x_star": float(d["x_star"]),
            "constraints_satisfied": int(bool(d["constraints_satisfied"])),
        })

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "injector_impinging.json")
    with open(path, "w") as f:
        json.dump({"state": state, "samples": samples}, f, indent=1)
    print(f"[ok] wrote {path}  ({len(samples)} samples)")


if __name__ == "__main__":
    main()
