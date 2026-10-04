"""Re-derive a design's headline numbers by hand and set them beside the model's.

    python3 scripts/design_handcheck.py configs/ethalox_6500N.yaml [--pamb 94070]

The checks are engine/pipeline/handcheck.py (forward mode shows the same rows). Nothing there calls
the engine's physics: CEA through rocketcea, and the textbook relation named on each row.

Exits non-zero on any flag.
"""
from __future__ import annotations

import argparse
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

PSI = 6894.757


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--pamb", type=float, default=None, help="ambient pressure [Pa]; default: the config's")
    a = ap.parse_args()

    from engine.pipeline.io import load_config
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.handcheck import handcheck

    cfg = load_config(a.config)
    PO = cfg.lox_tank.initial_pressure_psi * PSI
    PF = cfg.fuel_tank.initial_pressure_psi * PSI
    kw = {} if a.pamb is None else {"P_ambient": a.pamb}
    r = PintleEngineRunner(copy.deepcopy(cfg)).evaluate(PO, PF, silent=True, **kw)
    out = handcheck(cfg, r, PO, PF)
    rows = [(x["quantity"], x["model"], x["hand"], x["diff"], x["source"]) for x in out["rows"]]
    hdr = ("quantity", "model", "hand/bound", "diff", "source")
    w = [max(len(x[i]) for x in rows + [hdr]) for i in range(5)]
    print("  ".join(h.ljust(w[i]) for i, h in enumerate(hdr)))
    for row in rows:
        print("  ".join(c.ljust(w[i]) for i, c in enumerate(row)))
    s = out["summary"]
    print()
    print(f"{a.config}: Pc {s['Pc_psia']:.1f} psia, O/F {s['OF']:.3f}, F {s['F']:.0f} N, Isp {s['Isp']:.1f} s "
          f"at pa {s['Pa'] / 1000:.1f} kPa")
    if out["flags"]:
        print("FLAGS:")
        for f in out["flags"]:
            print("  " + f)
        sys.exit(1)
    print("no flags")


if __name__ == "__main__":
    main()
