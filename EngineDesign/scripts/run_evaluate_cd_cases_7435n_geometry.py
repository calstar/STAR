#!/usr/bin/env python3
"""Evaluate fixed ~7435 N impinging geometry under four Cd scenarios (no Layer-1 optimization)."""

from __future__ import annotations

import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner

# Frozen optimum from Layer-1 follow-up (~7435 N, dP_O/Pc ~ 0.156)
_AT = 0.0018378315868177425
_AE = 0.011028325556581661
_EPS = float(_AE) / float(_AT)

_LS = 0.83704
_DIN = 0.15159999999999998
_PO_PSI = 514.6808186275356
_PF_PSI = 536.3821987535601


def _patch_fixed_geometry(cfg):
    cg = cfg.chamber_geometry
    cg.A_throat = _AT
    cg.expansion_ratio = _EPS
    cg.A_exit = float(cg.A_throat) * float(cg.expansion_ratio)
    cg.Lstar = _LS
    cg.chamber_diameter = _DIN
    ox = cfg.injector.geometry.oxidizer
    fu = cfg.injector.geometry.fuel
    ox.n_elements = 77
    ox.d_jet = 0.0013685
    ox.impingement_angle = 82.30
    ox.spacing = 0.0041361
    fu.n_elements = 119
    fu.d_jet = 8.142e-4
    fu.impingement_angle = 56.83
    fu.spacing = 0.0038040
    cfg.lox_tank.initial_pressure_psi = float(_PO_PSI)
    cfg.fuel_tank.initial_pressure_psi = float(_PF_PSI)


def _set_flat_cd(cfg, cd_o: float, cd_f: float) -> None:
    """Flatten Cd(Re) so effective discharge matches targets (Cd_inf bound, zero Re slope)."""
    o = cfg.discharge["oxidizer"]
    f = cfg.discharge["fuel"]
    o.Cd_inf = float(cd_o)
    o.Cd_min = float(cd_o)
    o.a_Re = 0.0
    f.Cd_inf = float(cd_f)
    f.Cd_min = float(cd_f)
    f.a_Re = 0.0


CASES = {
    "A": (0.40, 0.30),
    "B": (0.40, 0.40),
    "C": (0.50, 0.50),
    "D": (0.40, 0.45),
}


def main() -> None:
    base_path = ROOT / "configs" / "impinging_lox_ch4_8000N.yaml"
    Po_pa = float(_PO_PSI) * 6894.76
    Pf_pa = float(_PF_PSI) * 6894.76

    print("Fixed geometry: 7435 N optimum (throat/exit/sync, 77 LOX / 119 CH4 jets)")
    print(f"A_exit/A_throat = {_EPS:.6f}\n")

    for name, (c_o, c_f) in CASES.items():
        cfg = load_config(str(base_path))
        _patch_fixed_geometry(cfg)
        _set_flat_cd(cfg, c_o, c_f)
        rnr = PintleEngineRunner(cfg)
        res = rnr.evaluate(Po_pa, Pf_pa, silent=True)
        d = res.get("diagnostics") or {}
        pc = float(res.get("Pc", 0))
        dp_o = d.get("delta_p_injector_O")
        dp_f = d.get("delta_p_injector_F")
        r_o = float(dp_o) / pc if dp_o is not None and pc > 0 else float("nan")
        r_f = float(dp_f) / pc if dp_f is not None and pc > 0 else float("nan")

        cd_o_eff = float(d.get("Cd_O", float("nan")))
        cd_f_eff = float(d.get("Cd_F", float("nan")))

        print(
            f"Case {name}: target Cd_O={c_o}  Cd_F={c_f}  "
            f"(diagnostics Cd_O={cd_o_eff:.4f}  Cd_F={cd_f_eff:.4f})"
        )
        print(f"  thrust [N]={res.get('F'):.4f}")
        print(f"  MR={res.get('MR'):.6f}")
        print(f"  momentum_ratio_R={d.get('momentum_ratio_R')}")
        print(f"  ΔP_O/Pc={r_o:.6g}")
        print(f"  ΔP_F/Pc={r_f:.6g}")
        print()


if __name__ == "__main__":
    main()
