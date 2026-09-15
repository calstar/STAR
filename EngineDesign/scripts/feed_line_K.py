#!/usr/bin/env python3
"""Compute EngineDesign's lumped feed ``K0`` from an actual component list.

EngineDesign's feed model is a single lumped coefficient per side:

    dp = K0 * 0.5 * rho * v^2,     v = mdot / (rho * A_hydraulic)

``docs/integration/line-loss-plan.md`` rates that "estimated K" -- rung 4 of 5, a
guess. Until the P&ID path lands, this script is rung 3: itemise the run, take each
K from a correlation rather than memory, and refer every one to a single reference
bore so the sum is a valid K0 for that A_hydraulic.

Reference-area conversion. dp is one number, so for two bores
    K_ref = K_local * (A_ref / A_local)^2
because v ~ 1/A. Losses at a WIDE section shrink when expressed against the high
velocity of a NARROW reference bore. Getting this backwards is the classic error.

Friction factors come from ``fluids`` (Colebrook); fitting K's are Crane TP-410 /
Idelchik forms, each labelled at its call site. Run:

    python3 scripts/feed_line_K.py
"""
from __future__ import annotations

import math
from fluids.friction import friction_factor

IN = 0.0254
PSI = 6894.757
ROUGHNESS_M = 1.5e-6  # drawn stainless tube, Crane TP-410 Table A-23

def area(d: float) -> float:
    return math.pi / 4.0 * d * d

def tube_id(od_in: float, wall_in: float = 0.035) -> float:
    return (od_in - 2.0 * wall_in) * IN

class Run:
    """One feed run, itemised. All K's accumulate against ``d_ref``."""

    def __init__(self, name: str, d_ref: float, mdot: float, rho: float, mu: float):
        self.name, self.d_ref, self.mdot, self.rho, self.mu = name, d_ref, mdot, rho, mu
        self.A_ref = area(d_ref)
        self.v_ref = mdot / (rho * self.A_ref)
        self.rows: list[tuple[str, float, str]] = []

    def _refer(self, K_local: float, d_local: float) -> float:
        return K_local * (self.A_ref / area(d_local)) ** 2

    def add(self, label: str, K_local: float, d_local: float, note: str) -> None:
        self.rows.append((label, self._refer(K_local, d_local), note))

    def entrance(self, d: float) -> None:
        # Sharp-edged entrance from a vessel, Crane TP-410 A-29.
        self.add("tank exit -> line (sharp entrance)", 0.5, d, "Crane A-29, K=0.5")

    def ball_valve_full_bore(self, d: float, f_T: float) -> None:
        # Crane TP-410: full-bore ball valve, fully open, K = 3 f_T.
        self.add(f"full-bore ball valve {d/IN:.3f}\" bore", 3.0 * f_T, d,
                 f"Crane TP-410, K=3*f_T, f_T={f_T}")

    def contraction(self, d_big: float, d_small: float) -> None:
        # Sudden contraction, referenced to the SMALL (downstream) velocity.
        beta2 = (d_small / d_big) ** 2
        self.add(f"contraction {d_big/IN:.3f}\" -> {d_small/IN:.3f}\"",
                 0.5 * (1.0 - beta2), d_small, "K=0.5(1-beta^2), at small-bore v")

    def expansion(self, d_small: float, d_big: float) -> None:
        # Sudden expansion, referenced to the SMALL (upstream) velocity.
        beta2 = (d_small / d_big) ** 2
        self.add(f"expansion {d_small/IN:.3f}\" -> {d_big/IN:.3f}\"",
                 (1.0 - beta2) ** 2, d_small, "K=(1-beta^2)^2, at small-bore v")

    def straight(self, d: float, L: float) -> None:
        v = self.mdot / (self.rho * area(d))
        Re = self.rho * v * d / self.mu
        f = friction_factor(Re=Re, eD=ROUGHNESS_M / d)
        self.add(f"straight tube {d/IN:.3f}\" ID x {L/IN:.1f}\"", f * L / d, d,
                 f"Darcy f*L/D, Re={Re:.3e}, f={f:.4f}")

    def report(self) -> float:
        K0 = sum(k for _, k, _ in self.rows)
        q = 0.5 * self.rho * self.v_ref ** 2
        print(f"\n{self.name}")
        print(f"  reference bore {self.d_ref*1000:.3f} mm   mdot {self.mdot:.3f} kg/s"
              f"   v_ref {self.v_ref:.1f} m/s   q {q/PSI:.1f} psi")
        print(f"  {'component':44s} {'K@ref':>8s}  source")
        print("  " + "-" * 92)
        for label, k, note in self.rows:
            print(f"  {label:44s} {k:8.4f}  {note}")
        print("  " + "-" * 92)
        print(f"  {'K0 (use this for A_hydraulic at the reference bore)':44s} {K0:8.4f}")
        print(f"  => dp_line = {K0 * q / PSI:.1f} psi")
        return K0


def main() -> None:
    # Design point the runs must carry.
    F, Isp, OF, Pc_psi = 8000.0, 237.0, 1.65, 430.0
    mdot = F / (Isp * 9.80665)
    mdot_O, mdot_F = mdot * OF / (1 + OF), mdot / (1 + OF)

    d_half_npt = 0.5 * IN          # 1/2" NPT through-bore and full-bore ball valve bore
    d_half_tube = tube_id(0.500)   # 1/2" Swagelok tube, 0.035" wall -> 0.430" ID
    d_38_tube = tube_id(0.375)     # 3/8" Swagelok tube, 0.035" wall -> 0.305" ID

    print("=" * 96)
    print("CalSTAR ethalox flight feed runs -- K0 from the as-built component list (operator, 2026-09-13)")
    print(f"design point: F {F:.0f} N, O/F {OF}, Pc {Pc_psi:.0f} psia"
          f"  ->  mdot_O {mdot_O:.3f}, mdot_F {mdot_F:.3f} kg/s")
    print("=" * 96)

    # --- LOX: 1/2" NPT -> 1/2" full-flow ball valve -> 1/2" NPT-to-Swage -> 4" of 1/2"
    #          tube -> 1/2" Swage-to-NPT -> injector. No bends.
    lox = Run("OXIDISER  (reference: 1/2\" tube ID)", d_half_tube, mdot_O, 1140.0, 1.8e-4)
    lox.entrance(d_half_npt)
    lox.ball_valve_full_bore(d_half_npt, f_T=0.027)
    lox.contraction(d_half_npt, d_half_tube)
    lox.straight(d_half_tube, 4.0 * IN)
    lox.expansion(d_half_tube, d_half_npt)
    K_O = lox.report()

    # --- FUEL: 1/2" NPT full-flow ball valve -> 1/2"-to-3/8" Swage -> ~3 ft of 3/8"
    #           tube (straight) -> 3/8" Swage-to-1/2" NPT -> injector.
    fu = Run("FUEL      (reference: 3/8\" tube ID)", d_38_tube, mdot_F, 789.0, 1.2e-3)
    fu.entrance(d_half_npt)
    fu.ball_valve_full_bore(d_half_npt, f_T=0.027)
    fu.contraction(d_half_npt, d_38_tube)
    fu.straight(d_38_tube, 36.0 * IN)
    fu.expansion(d_38_tube, d_half_npt)
    K_F = fu.report()

    # --- Does the design point close on a 600 psi tank?
    print("\n" + "=" * 96)
    print("PRESSURE BUDGET at a 600 psi tank")
    print("=" * 96)
    for tag, run, K in (("LOX", lox, K_O), ("FUEL", fu, K_F)):
        dp_line = K * 0.5 * run.rho * run.v_ref ** 2 / PSI
        for frac in (0.20, 0.25):
            need = Pc_psi + dp_line + frac * Pc_psi
            mark = "OK" if need <= 600 else f"SHORT {need-600:.0f} psi"
            print(f"  {tag:4s} dP/Pc {frac:.2f}: {Pc_psi:.0f} Pc + {dp_line:5.1f} line"
                  f" + {frac*Pc_psi:5.1f} inj = {need:5.1f} psi   {mark}")

    # --- What a 1/2" fuel run would buy, since the 3/8" one is the binding side.
    print("\n" + "=" * 96)
    print("IF THE FUEL RUN WERE 1/2\" TUBE INSTEAD (same layout, 3 ft straight)")
    print("=" * 96)
    alt = Run("FUEL alt  (reference: 1/2\" tube ID)", d_half_tube, mdot_F, 789.0, 1.2e-3)
    alt.entrance(d_half_npt)
    alt.ball_valve_full_bore(d_half_npt, f_T=0.027)
    alt.contraction(d_half_npt, d_half_tube)
    alt.straight(d_half_tube, 36.0 * IN)
    alt.expansion(d_half_tube, d_half_npt)
    K_alt = alt.report()
    dp_alt = K_alt * 0.5 * alt.rho * alt.v_ref ** 2 / PSI
    for frac in (0.20, 0.25, 0.30):
        need = Pc_psi + dp_alt + frac * Pc_psi
        mark = "OK" if need <= 600 else f"SHORT {need-600:.0f} psi"
        print(f"  FUEL dP/Pc {frac:.2f}: {Pc_psi:.0f} + {dp_alt:5.1f} + {frac*Pc_psi:5.1f}"
              f" = {need:5.1f} psi   {mark}")


if __name__ == "__main__":
    main()
