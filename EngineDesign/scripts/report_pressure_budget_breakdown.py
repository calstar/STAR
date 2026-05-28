#!/usr/bin/env python3
"""Print tank→chamber pressure budget per propellant stream from a runner.evaluate call.

Model used in ``impinging`` / ``pintle`` injectors::

    P_injector = P_tank − ΔP_feed
    ΔP_injector = max(0, P_injector − Pc)

Therefore::

    P_tank − Pc = ΔP_feed + ΔP_injector

``delta_p_remaining`` is the closure residual::

    (P_tank − Pc) − ΔP_feed − ΔP_injector

which should be ~0 Pa when diagnostics are consistent.

Fraction of total tank-to-chamber drop::

    f_feed = ΔP_feed / (P_tank − Pc)
    f_injector = ΔP_injector / (P_tank − Pc)

Example::

    python scripts/report_pressure_budget_breakdown.py \\
      --config configs/impinging_lox_ch4_8000N.yaml \\
      --po-psi 566.8 --pf-psi 780.1 --silent
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PSI_PER_PA = 1.0 / 6894.76

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402


def _fmt_pa_psi(pa: float) -> str:
    return f"{pa:,.2f} Pa ({pa * PSI_PER_PA:.3f} psi)"


def _stream_breakdown(
    name: str,
    p_tank_pa: float,
    pc_pa: float,
    d_inj: float | None,
    d_feed: float | None,
) -> None:
    d_inj = float(d_inj or 0.0)
    d_feed = float(d_feed or 0.0)
    d_tot = p_tank_pa - pc_pa
    d_rem = d_tot - d_feed - d_inj

    print(f"\n=== {name} ===")
    print(f"  P_tank:           {_fmt_pa_psi(p_tank_pa)}")
    print(f"  Pc:               {_fmt_pa_psi(pc_pa)}")
    print(f"  ΔP_total (tank−Pc): {_fmt_pa_psi(d_tot)}")
    print(f"  ΔP_feed:          {_fmt_pa_psi(d_feed)}")
    print(f"  ΔP_injector:      {_fmt_pa_psi(d_inj)}")
    print(f"  ΔP_remaining:     {_fmt_pa_psi(d_rem)}  (should be ~0)")

    if d_tot > 0:
        f_feed = d_feed / d_tot
        f_inj = d_inj / d_tot
        print(f"\n  Share of (P_tank − Pc):")
        print(f"    Feed system:     {100.0 * f_feed:.2f}%")
        print(f"    Injector element: {100.0 * f_inj:.2f}%")
    else:
        print("\n  (ΔP_total ≤ 0 — fractions undefined.)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=str, required=True, help="Engine YAML path")
    ap.add_argument("--po-psi", type=float, required=True, help="LOX tank pressure [psi]")
    ap.add_argument("--pf-psi", type=float, required=True, help="Fuel tank pressure [psi]")
    ap.add_argument("--silent", action="store_true", help="Quiet runner.evaluate logging")
    args = ap.parse_args()

    cfg = load_config(args.config)
    runner = PintleEngineRunner(cfg)
    po_pa = float(args.po_psi) / PSI_PER_PA
    pf_pa = float(args.pf_psi) / PSI_PER_PA

    ev = runner.evaluate(po_pa, pf_pa, silent=args.silent)
    diag = ev.get("diagnostics") or {}
    inj = ev.get("injector_pressure") or {}
    pc = float(ev["Pc"])

    dpo_inj = inj.get("delta_p_injector_O", diag.get("delta_p_injector_O"))
    dpf_inj = inj.get("delta_p_injector_F", diag.get("delta_p_injector_F"))
    dpo_fd = inj.get("delta_p_feed_O", diag.get("delta_p_feed_O"))
    dpf_fd = inj.get("delta_p_feed_F", diag.get("delta_p_feed_F"))

    print("\nPressure budget (from evaluate diagnostics)")
    print(f"Config: {args.config}")

    _stream_breakdown("LOX (oxidizer)", po_pa, pc, dpo_inj, dpo_fd)
    _stream_breakdown("Fuel", pf_pa, pc, dpf_inj, dpf_fd)


if __name__ == "__main__":
    main()
