"""Compare our Mach-dependent CP to RocketPy's own, on identical trapezoidal fins.

There is no live flight data to validate against, so the honest check is a
model-vs-model cross-check: build the *same* fin set two ways and sweep Mach.

  * **Ours** -- ``fin_set_aero`` (OpenRocket-24.12 Barrowman, CP migrates with Mach).
  * **RocketPy** -- a native ``TrapezoidalFins`` on a ``Rocket``; RocketPy's fin CP
    is a fixed geometric value, and its CNa freezes ``beta`` through the transonic.

Both share the reference radius and fin placement, so the comparison is apples to
apples. Expected outcome (this is the whole point of the CP work):

  * subsonic (M ≲ 0.8): CNa and CP agree closely -- mutual validation;
  * transonic/supersonic: RocketPy's fin CP stays put while ours migrates aft
    (quarter- toward mid-MAC), and the CNa curves part as RocketPy freezes beta.

Needs ``rocketpy`` installed (heavy, optional). ``compare_fins_vs_mach`` returns the
raw arrays; running the module prints the table.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .barrowman_fins import DIVISIONS, fin_set_aero


@dataclass
class FinCompare:
    """CNa and absolute CP (from the nose) vs Mach, ours and RocketPy's."""

    mach: list[float]
    our_cna: list[float]
    rocketpy_cna: list[float]
    our_cp: list[float]
    rocketpy_cp: list[float]


def _our_strips(root: float, tip: float, span: float, sweep: float, position: float):
    """Trapezoid leading/trailing edges per spanwise strip, root LE at ``position``."""
    y = np.linspace(0.0, span, DIVISIONS)
    lead = position + sweep * y / span
    trail = position + root + (sweep + tip - root) * y / span
    return lead, trail


def compare_fins_vs_mach(
    n: int = 3,
    root_chord: float = 0.05,
    tip_chord: float = 0.03,
    span: float = 0.05,
    sweep_length: float = 0.02,
    rocket_radius: float = 0.05,
    position: float = 0.9,
    machs: list[float] | None = None,
) -> FinCompare:
    """Fin-set CNa and CP vs Mach, computed our way and RocketPy's, same geometry.

    ``position`` is the fin root leading edge, measured from the nose tip (matching
    RocketPy's ``nose_to_tail`` frame). CP is returned in that same frame.
    """
    from rocketpy import Rocket  # lazy: heavy, optional dependency

    if machs is None:
        machs = [0.1, 0.3, 0.5, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0]

    rocket = Rocket(
        radius=rocket_radius,
        mass=5.0,
        inertia=(1.0, 1.0, 0.01),
        power_off_drag=0.5,
        power_on_drag=0.5,
        center_of_mass_without_motor=0.0,
        coordinate_system_orientation="nose_to_tail",
    )
    rocket.add_trapezoidal_fins(
        n=n, root_chord=root_chord, tip_chord=tip_chord, span=span,
        position=position, sweep_length=sweep_length,
    )
    fin_surface, fin_pos = rocket.aerodynamic_surfaces[-1]
    # RocketPy: absolute fin CP = placement + local cpz; both Mach-independent.
    rp_cp = fin_pos[2] + fin_surface.cp[2]
    # RocketPy's set CNa = single-fin clalpha × fin-count factor (== ours' N/2·(1+τ)·k
    # up to the interference model); compare the whole-set value for both.
    lead, trail = _our_strips(root_chord, tip_chord, span, sweep_length, position)

    our_cna, rp_cna, our_cp, rp_cp_list = [], [], [], []
    for m in machs:
        ours = fin_set_aero(lead, trail, span, rocket_radius, n_fins=n, r_ref=rocket_radius, mach=m)
        our_cna.append(ours.cna)
        our_cp.append(ours.cp)
        rp_cna.append(_rocketpy_set_cna(rocket, m))
        rp_cp_list.append(rp_cp)
    return FinCompare(list(machs), our_cna, rp_cna, our_cp, rp_cp_list)


def _rocketpy_set_cna(rocket, mach: float) -> float:
    """Whole fin-set CNa RocketPy would use: clalpha-weighted over the set.

    RocketPy stores the set's ``clalpha`` as a Mach Function on the surface; use it
    directly so the comparison reflects RocketPy's own value, not a re-derivation.
    """
    fin_surface, _ = rocket.aerodynamic_surfaces[-1]
    return float(fin_surface.clalpha(mach))


def _print_table(cmp: FinCompare) -> None:
    print(f"{'M':>5} {'our_CNa':>9} {'rp_CNa':>9} {'our_CP':>9} {'rp_CP':>9} {'dCP':>8}")
    for i, m in enumerate(cmp.mach):
        dcp = cmp.our_cp[i] - cmp.rocketpy_cp[i]
        print(
            f"{m:5.2f} {cmp.our_cna[i]:9.3f} {cmp.rocketpy_cna[i]:9.3f} "
            f"{cmp.our_cp[i]:9.4f} {cmp.rocketpy_cp[i]:9.4f} {dcp:8.4f}"
        )


if __name__ == "__main__":  # pragma: no cover
    _print_table(compare_fins_vs_mach())
