"""Convert a PintleEngineConfig into the flat field set backing EdEngineState.

NOT imported by runner.py. This is the future "config -> binary snapshot" shim.

Stage 1 implements the *mapping* (config -> flat Python dict whose keys mirror
ed_state.h) and a JSON dump, which is what the parity tooling needs today. Emitting
the packed binary EdEngineState requires a ctypes Structure mirror of the full
nested layout in ed_state.h; that mirror is added together with ed_evaluate (so the
two never drift), at which point build_state_bin() is filled in. See README.
"""
from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

PHI = {"none": 0, "sqrtP": 1, "logP": 2}
INJ = {"pintle": 0, "impinging": 1, "coaxial": 2}


def _feed(c):
    return {
        "d_inlet": float(getattr(c, "d_inlet", 0.0) or 0.0),
        "A_hydraulic": float(getattr(c, "A_hydraulic", 0.0) or 0.0),
        "K0": float(c.K0), "K1": float(c.K1), "phi_type": PHI[c.phi_type],
    }


def _disc(c):
    return {k: (int(getattr(c, k)) if k.startswith("use_") else float(getattr(c, k)))
            for k in ("Cd_inf", "a_Re", "Cd_min", "use_geometry_cd", "d_ref_m",
                      "d_min_m", "cd_small_hole_exponent", "cd_large_hole_log_gain",
                      "cd_inf_max", "cd_inf_min_geom", "use_pressure_correction",
                      "P_ref", "a_P", "use_temperature_correction", "T_ref", "a_T")}


def build_state_dict(cfg) -> dict:
    """Flatten the parts of a PintleEngineConfig needed for one evaluation."""
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    cg = ensure_chamber_geometry(cfg)
    inj = cfg.injector

    state = {
        "injector_type": INJ[inj.type],
        "feed_O": _feed(cfg.feed_system["oxidizer"]),
        "feed_F": _feed(cfg.feed_system["fuel"]),
        "discharge_O": _disc(cfg.discharge["oxidizer"]),
        "discharge_F": _disc(cfg.discharge["fuel"]),
        "geom": {
            "A_throat": float(cg.A_throat), "A_exit": float(cg.A_exit),
            "volume": float(cg.volume),
            "Lstar": float(cg.Lstar) if cg.Lstar else 0.0,
            "length": float(cg.length),
            "length_cylindrical": float(cg.length_cylindrical or 0.0),
            "length_contraction": float(cg.length_contraction or 0.0),
            "chamber_diameter": float(cg.chamber_diameter or 0.0),
            "exit_diameter": float(cg.exit_diameter or 0.0),
            "expansion_ratio": float(cg.expansion_ratio),
            "nozzle_efficiency": float(cg.nozzle_efficiency),
            "Cf": float(cg.Cf or 0.0),
            "design_pressure": float(cg.design_pressure or 0.0),
        },
        "solver": {
            "Pc_min_bound": float(cfg.solver.Pc_bounds[0]),
            "Pc_max_bound": float(cfg.solver.Pc_bounds[1]),
            "tolerance": float(cfg.solver.tolerance),
            "max_iterations": int(cfg.solver.max_iterations),
        },
        "cooling": {
            "regen_enabled": int(bool(cfg.regen_cooling and cfg.regen_cooling.enabled)),
            "film_enabled": int(bool(cfg.film_cooling and cfg.film_cooling.enabled)),
            "ablative_enabled": int(bool(cfg.ablative_cooling and cfg.ablative_cooling.enabled)),
            "graphite_enabled": int(bool(getattr(cfg, "graphite_insert", None) and cfg.graphite_insert.enabled)),
        },
    }
    if inj.type == "impinging":
        for branch, key in ((inj.geometry.oxidizer, "imp_O"), (inj.geometry.fuel, "imp_F")):
            state[key] = {
                "n_elements": int(branch.n_elements), "d_jet": float(branch.d_jet),
                "impingement_angle": float(branch.impingement_angle),
                "spacing": float(branch.spacing),
            }
    return state


def build_state_bin(cfg, path: str) -> None:  # pragma: no cover - staged
    raise NotImplementedError(
        "Binary EdEngineState emission lands with the ed_evaluate port "
        "(needs the ctypes EdEngineState mirror of ed_state.h). Use build_state_dict() "
        "for the flat field mapping today."
    )


if __name__ == "__main__":
    import argparse
    from engine.pipeline.io import load_config

    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="configs/canonical/impinging.yaml")
    ap.add_argument("--out", default="engine/native/tests/golden/state_impinging.json")
    args = ap.parse_args()
    cfg = load_config(args.config)
    d = build_state_dict(cfg)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(d, f, indent=1)
    print(f"[ok] wrote {args.out}")
