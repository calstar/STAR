#!/usr/bin/env python3
"""Which numbers in this config did anyone actually choose?

EngineDesign configs carry ~900 fields. Most arrive by inheriting configs/default.yaml,
which is a GENERIC template -- its feed system is 3/8" NPT at K0 2.0 with 0.305 m runs,
which is nobody's vehicle in particular. Those values are perfectly valid config, so
nothing in the loader, the optimizer or the UI ever flags them, and a design point can
miss by 20%+ on O/F with every gate reporting a clean reason that points somewhere else.

This prints, for a given config, every physically consequential field that is
BIT-IDENTICAL to default.yaml -- i.e. inherited, not chosen.

    python3 scripts/config_provenance_audit.py configs/mine.yaml [--all]

Note the obvious limit: identical-to-default is not the same as wrong. Prandtl 0.7 is
fine for anyone. The point is that nothing distinguishes the fields where that is true
from the fields where it is not, so the list is where to start looking, not a defect list.
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

# Sections whose values change the answer rather than the presentation.
CONSEQUENTIAL = (
    "feed_system", "injector", "combustion.efficiency", "spray", "stability",
    "ablative_cooling", "film_cooling", "regen_cooling", "chamber_geometry",
)
# Fields that have bitten a real design point. Printed first, loudly.
KNOWN_TRAPS = {
    "feed_system.oxidizer.line_size": "sets LOX bore; dP ~ 1/A^2, so a name is worth ~2x",
    "feed_system.fuel.line_size": "sets fuel bore; dP ~ 1/A^2",
    "feed_system.oxidizer.K0": "lumped loss coeff; NOT length-scaled -- must cover the whole run",
    "feed_system.fuel.K0": "lumped loss coeff; NOT length-scaled",
    "feed_system.oxidizer.length": "chug inertance ONLY -- does not touch dP",
    "feed_system.fuel.length": "chug inertance ONLY -- does not touch dP",
    "spray.evaporation.x_star_limit": "caps vaporisation length; gates L* feasibility",
    "ablative_cooling.initial_thickness": "sets chamber bore for a given OD",
}


def flatten(d, pre=""):
    out = {}
    if isinstance(d, dict):
        for k, v in d.items():
            out.update(flatten(v, f"{pre}.{k}" if pre else k))
    elif isinstance(d, list):
        out[pre] = json.dumps(d)[:80]
    else:
        out[pre] = d
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("config", help="config YAML to audit")
    ap.add_argument("--baseline", default=str(ROOT / "configs/default.yaml"))
    ap.add_argument("--all", action="store_true", help="every inherited field, not just consequential ones")
    a = ap.parse_args()

    cfg = flatten(yaml.safe_load(open(a.config)))
    base = flatten(yaml.safe_load(open(a.baseline)))

    inherited = [k for k in sorted(cfg)
                 if k in base and str(cfg[k]) == str(base[k]) and cfg[k] is not None]
    if not a.all:
        inherited = [k for k in inherited if any(k.startswith(s) for s in CONSEQUENTIAL)]

    traps = [k for k in inherited if k in KNOWN_TRAPS]
    rest = [k for k in inherited if k not in KNOWN_TRAPS]

    print(f"config   : {a.config}")
    print(f"baseline : {a.baseline}")
    print(f"\n{len(inherited)} consequential fields are bit-identical to the baseline "
          f"(inherited, not chosen).\n")

    if traps:
        print("  These have each cost a design point before:")
        for k in traps:
            print(f"    {k:44s} = {str(cfg[k]):<14s}  {KNOWN_TRAPS[k]}")
        print()
    if rest:
        print("  Also inherited:")
        for k in rest:
            print(f"    {k:44s} = {cfg[k]}")
    if not inherited:
        print("  (none -- every consequential field differs from the baseline)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
