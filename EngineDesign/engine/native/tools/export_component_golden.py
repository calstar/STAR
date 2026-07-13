#!/usr/bin/env python3
"""Export self-contained parity samples for the leaf physics ports that are
implemented in Stage 1: feed_loss.delta_p_feed, discharge.cd_inf_from_orifice_diameter,
and discharge.cd_from_re.

Each sample carries BOTH the config fields and the inputs, so the C test can
reconstruct an identical EdFeed/EdDischarge and call the matching C function —
true parity against the live Python implementation. NEW FILE, read-only on engine/.

    python engine/native/tools/export_component_golden.py --out engine/native/tests/golden
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from engine.pipeline.io import load_config                       # noqa: E402
from engine.pipeline.feed_loss import delta_p_feed               # noqa: E402
from engine.core.discharge import (                              # noqa: E402
    cd_inf_from_orifice_diameter, cd_from_re,
)

PHI = {"none": 0, "sqrtP": 1, "logP": 2}


def feed_dict(cfg):
    return {
        "d_inlet": float(getattr(cfg, "d_inlet", 0.0) or 0.0),
        "A_hydraulic": float(getattr(cfg, "A_hydraulic", 0.0) or 0.0),
        "K0": float(cfg.K0), "K1": float(cfg.K1),
        "phi_type": PHI[cfg.phi_type],
    }


def disc_dict(cfg):
    return {
        "Cd_inf": float(cfg.Cd_inf), "a_Re": float(cfg.a_Re), "Cd_min": float(cfg.Cd_min),
        "use_geometry_cd": int(bool(cfg.use_geometry_cd)),
        "d_ref_m": float(cfg.d_ref_m), "d_min_m": float(cfg.d_min_m),
        "cd_small_hole_exponent": float(cfg.cd_small_hole_exponent),
        "cd_large_hole_log_gain": float(cfg.cd_large_hole_log_gain),
        "cd_inf_max": float(cfg.cd_inf_max), "cd_inf_min_geom": float(cfg.cd_inf_min_geom),
        "use_pressure_correction": int(bool(cfg.use_pressure_correction)),
        "P_ref": float(cfg.P_ref), "a_P": float(cfg.a_P),
        "use_temperature_correction": int(bool(cfg.use_temperature_correction)),
        "T_ref": float(cfg.T_ref), "a_T": float(cfg.a_T),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="configs/canonical/impinging.yaml")
    ap.add_argument("--out", default="engine/native/tests/golden")
    args = ap.parse_args()
    cfg = load_config(args.config)

    feed_O = cfg.feed_system["oxidizer"]
    feed_F = cfg.feed_system["fuel"]
    disc_O = cfg.discharge["oxidizer"]
    disc_F = cfg.discharge["fuel"]

    # ---- feed loss -------------------------------------------------------
    feed_samples = []
    feed_cases = [
        (feed_O, 1140.0), (feed_F, 810.0),
        (feed_O.model_copy(update={"phi_type": "sqrtP", "K1": 1e-3}), 1140.0),
        (feed_F.model_copy(update={"phi_type": "logP", "K1": 0.5}), 810.0),
    ]
    for fc, rho in feed_cases:
        for mdot in (0.0, 0.5, 1.5, 3.0, 5.0):
            for P_tank in (3.0e6, 4.0e6, 5.0e6):
                dp = delta_p_feed(mdot, rho, fc, P_tank)
                s = feed_dict(fc)
                s.update({"mdot": mdot, "rho": rho, "P_tank": P_tank, "expected": float(dp)})
                feed_samples.append(s)

    # ---- discharge -------------------------------------------------------
    cd_inf_samples = []
    for dc in (disc_O, disc_F, disc_O.model_copy(update={"use_geometry_cd": False})):
        for d in (3e-4, 4e-4, 1e-3, 2e-3, 3e-3, 6e-3, 1e-2):
            s = disc_dict(dc)
            s.update({"d_hyd": d, "expected": float(cd_inf_from_orifice_diameter(d, dc))})
            cd_inf_samples.append(s)

    cd_re_samples = []
    disc_pc = disc_O.model_copy(update={"use_pressure_correction": True, "a_P": 0.05})
    disc_tc = disc_O.model_copy(update={"use_temperature_correction": True, "a_T": 0.03})
    for dc in (disc_O, disc_F, disc_pc, disc_tc):
        for Re in (0.0, 100.0, 5e3, 5e4, 5e5):
            for d in (2e-3, 5e-4):
                P_in, T_in = 6e6, 250.0
                cd = cd_from_re(Re, dc, P_in, T_in, d)
                s = disc_dict(dc)
                s.update({"Re": Re, "P_inlet": P_in, "T_inlet": T_in,
                          "d_hyd": d, "expected": float(cd)})
                cd_re_samples.append(s)

    os.makedirs(args.out, exist_ok=True)
    out = {
        "feed": feed_samples,
        "cd_inf": cd_inf_samples,
        "cd_from_re": cd_re_samples,
    }
    path = os.path.join(args.out, "component_samples.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1)
    print(f"[ok] wrote {path}  feed={len(feed_samples)} cd_inf={len(cd_inf_samples)} cd_re={len(cd_re_samples)}")


if __name__ == "__main__":
    main()
