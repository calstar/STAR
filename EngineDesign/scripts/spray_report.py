"""Spray and mixing report for a design at its own tank pressures.

    python3 scripts/spray_report.py configs/<design>.yaml [--no-sensitivity]

engine/core/injectors/spray_report.py builds it; the Geometry tab shows the same report.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--no-sensitivity", action="store_true")
    a = ap.parse_args()
    from engine.pipeline.io import load_config
    from engine.core.injectors.spray_report import spray_mixing_report
    rep = spray_mixing_report(load_config(a.config), with_sensitivity=not a.no_sensitivity)
    d = rep["design"]
    print(f"{a.config}: F {d['F']:.0f} N, Pc {d['Pc_psia']:.1f} psia, O/F {d['OF']:.3f}, Isp {d['Isp']:.1f} s")
    for sec in rep["sections"]:
        print(f"\n{sec['title']}")
        for r in sec["rows"]:
            v = r["value"]
            vs = f"{v:.4g}" if isinstance(v, float) else str(v)
            print(f"  {r['status']:4s} {r['label']:34s} {vs:>10s} {r['unit']:14s} {r['band']:24s} {r['note']}")
    if rep["sensitivity"]:
        print("\nWhat it rests on (re-solved as written)")
        print(f"  {'case':38s}{'F N':>8s}{'Isp s':>8s}{'Pc psia':>9s}{'O/F':>7s}{'η c*':>8s}{'η vap':>8s}{'η mix':>8s}{'fuel vap':>9s}")
        for s in rep["sensitivity"]:
            if "error" in s:
                print(f"  {s['case']:38s} did not solve: {s['error']}")
                continue
            print(f"  {s['case']:38s}{s['F']:8.0f}{s['Isp']:8.1f}{s['Pc_psia']:9.1f}{s['OF']:7.3f}"
                  f"{s['eta_cstar']:8.4f}{s['eta_vap']:8.4f}{s['eta_mix']:8.4f}{s['vap_F'] * 100:8.1f}%"
                  + ("" if s["applied"] else "  <-- NOT APPLIED"))


if __name__ == "__main__":
    main()
