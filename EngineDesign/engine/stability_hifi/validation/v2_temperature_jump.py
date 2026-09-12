"""Verification case V2: 1-D duct with a temperature (sound-speed) jump, passive
(paper Section VII.A: "checks: nonuniform-c-bar handling").

The paper *names* this case but does not give its analytic reference solution, so the
derivation below is original (not copied from the paper) — done directly from the
governing equation the paper does give, Eq. (6):

    lambda^2 p_hat - d/dx( c_bar^2 dp_hat/dx ) = 0      (1-D, no heat release)

Setup: a duct of length L = L1 + L2, split at x = L1 into two uniform zones with sound
speeds c1 (zone 1, 0 <= x <= L1) and c2 (zone 2, L1 <= x <= L1+L2). Rigid ("closed") ends
at x=0 and x=L, matching Section III.E's rigid-wall Neumann condition. Only the
sound-speed field is nonuniform; nothing about the boundary condition or the flame
(there is none) is new relative to V1 — this isolates exactly the one new piece of
physics V2 is meant to check.

Derivation
----------
Looking for undamped natural frequencies (lambda = i*omega, omega real — same as V1;
a lossless medium can't grow or decay), Eq. (6) in each uniform zone reduces to the
textbook 1-D Helmholtz equation

    d^2 p_hat/dx^2 = -k_i^2 p_hat,      k_i = omega / c_i     (i = 1, 2)

with general solution p_hat(x) = A*cos(k_i*x) + B*sin(k_i*x). The rigid-end conditions
p_hat'(0) = 0 and p_hat'(L) = 0 fix the form in each zone up to one free amplitude:

    zone 1:  p_hat_1(x) = A1 * cos(k1*x)                    [only cos satisfies p'(0)=0]
    zone 2:  p_hat_2(x) = A2 * cos(k2*(x - L))               [satisfies p'(L)=0 by construction]

At the interface x=L1, we need two matching conditions. Pressure continuity, (a), is
uncontroversial (nothing sources or sinks p there). Condition (b) is the one that is
easy to get wrong, and an earlier draft of this derivation *did* get it wrong (kept
below as a documented correction, since the mistake and the fix are both instructive):

    WRONG first attempt: continuity of mass flux rho_bar*u_hat, on the (mistaken)
    reasoning that this is the standard duct-acoustics matching condition when gas
    properties change across an interface. Using u_hat = -grad(p_hat)/(lambda*rho_bar)
    (given right after Eq. 6), rho1*u_hat_1 = rho2*u_hat_2 reduces (both rho AND lambda
    cancel) to dp_hat_1/dx = dp_hat_2/dx, giving k1*tan(k1*L1) + k2*tan(k2*L2) = 0.

    This numerically MISMATCHED the FEM solution by several percent at every mesh
    resolution, with no improvement on refinement — a strong signal (per the mesh-
    convergence-order test in V1) of a wrong reference formula, not a discretization
    error. Tracking it down: the standard "mass-flux continuity" rule from general duct
    acoustics assumes a mean flow physically carrying mass across the interface. But
    Section III.C's Helmholtz reduction explicitly assumes a *quiescent* mean flow
    (u_bar ~ 0) — there is no throughflow here at all, just a spatially-varying sound
    speed in still gas. The right way to find the correct condition is to go back one
    step further than Eq. 6, to the *pair* of first-order equations it was combined
    from (Eq. 4): the energy equation "dp'/dt + gamma*p_bar*div(u') = (gamma-1)*q_dot'"
    uses the volumetric dilatation div(u') directly (a purely kinematic quantity, not a
    mass flux), and Appendix B's assumption (ii) is that gamma*p_bar is spatially
    UNIFORM (mean pressure barely drops across the chamber) even though rho_bar is not.
    Integrating that energy equation across a vanishingly thin control volume straddling
    the interface forces the u' term's jump to vanish for the equation to stay finite —
    i.e. **u_hat itself (not rho_bar*u_hat) must be continuous.** Equivalently, since
    c_bar^2 = gamma*p_bar/rho_bar and gamma*p_bar is the same constant on both sides,
    continuity of u_hat (using u_hat = -grad(p_hat)/(lambda*rho_bar)) is the same
    statement as continuity of c_bar^2 * dp_hat/dx — which is also exactly the *natural*
    (weak-form) interface condition that Eq. (10)'s FEM discretization enforces
    automatically at any element boundary where c jumps. That the corrected physics
    argument and the FEM's own automatic behavior agree is a good consistency check.

Redoing the algebra with the corrected condition (b): c1^2 * dp_hat_1/dx = c2^2 *
dp_hat_2/dx at x=L1. Substituting the two zone solutions into "p continuous" and
"c^2 p' continuous" and eliminating A1, A2 (using k_i = omega/c_i, so c_i^2 * k_i =
c_i * omega):

    A1 cos(k1*L1) = A2 cos(k2*L2)                                (p continuous)
   -c1*omega*A1 sin(k1*L1) = c2*omega*A2 sin(k2*L2)               (c^2 p' continuous)

gives the dispersion relation:

    c1 * tan(k1*L1) + c2 * tan(k2*L2) = 0.

Sanity check (uniform limit): if c1 = c2 = c, both this and the wrong first attempt
collapse to the same tan(k*L1) = -tan(k*(L-L1)), i.e. f = n*c/(2L) — V1's closed-closed
spectrum. **This is why the uniform-limit check alone did not catch the error**: any
relation of the schematic form (function of c1, k1*L1) + (function of c2, k2*L2) = 0
that is antisymmetric the same way trivially passes it regardless of which power of
c_i actually belongs there. The uniform limit is a necessary but not sufficient check;
comparing against the independently-built FEM solution (which does not share whatever
mistake was made in the by-hand derivation) is what actually caught this one.

Numerically, ``tan`` has poles wherever k_i*L_i passes through (2n+1)*pi/2, which are
not physical roots but *look* like sign changes to a naive root-finder. To avoid that
trap, the code below root-finds the equivalent POLE-FREE form obtained by multiplying
through by cos(k1*L1)*cos(k2*L2):

    g(omega) = c1*sin(k1*L1)*cos(k2*L2) + c2*cos(k1*L1)*sin(k2*L2) = 0

which is smooth (entire) in omega, so every sign change of g really is a root.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np
from scipy.optimize import brentq

from engine.stability_hifi.eigen.passive import solve_passive_modes
from engine.stability_hifi.meanflow.spec import synthetic_two_zone_duct


@dataclass
class ModeComparison:
    f_analytic_hz: float
    f_fem_hz: float

    @property
    def rel_error(self) -> float:
        return abs(self.f_fem_hz - self.f_analytic_hz) / self.f_analytic_hz


def _dispersion_g(f_hz: float, c1: float, L1: float, c2: float, L2: float) -> float:
    """Pole-free dispersion residual (see module docstring). Root at f_hz => a true mode.

    Corrected form ``c1*sin(k1L1)cos(k2L2) + c2*cos(k1L1)sin(k2L2)`` (velocity-continuity
    interface condition) — NOT ``k1*sin(...)+k2*sin(...)`` (mass-flux continuity), which
    was tried first and shown to be wrong; see the module docstring for the full story.
    """
    omega = 2.0 * np.pi * f_hz
    k1, k2 = omega / c1, omega / c2
    return (c1 * np.sin(k1 * L1) * np.cos(k2 * L2)
            + c2 * np.cos(k1 * L1) * np.sin(k2 * L2))


def analytic_frequencies(c1: float, L1: float, c2: float, L2: float,
                         f_max_hz: float, samples_per_period: int = 40) -> List[float]:
    """All positive roots of the dispersion relation below ``f_max_hz``.

    Dense-sample ``g`` finely enough to resolve its fastest oscillation (set by the
    shorter, faster zone) and Brent's method to refine each sign change found. Because
    ``g`` (unlike the raw tan-tan form) has no poles, every sign change IS a root —
    no risk of mistaking an asymptote for a mode, which is exactly why this pole-free
    form was used instead of the more directly-derived tan-tan equation.
    """
    # g's fastest oscillation in frequency is set by whichever zone reaches a quarter-wave
    # resonance soonest as f increases, i.e. the zone with the smaller c/(4L) -- sample
    # several points per that period so no root (sign change) is skipped over.
    c_min = min(c1, c2)
    L_min = min(L1, L2)
    f_period = c_min / (4.0 * L_min)
    df = f_period / samples_per_period
    n_samples = max(int(np.ceil(f_max_hz / df)) + 2, 100)
    f_grid = np.linspace(1e-3, f_max_hz, n_samples)   # start just above 0 (f=0 is a trivial root)
    g_grid = np.array([_dispersion_g(f, c1, L1, c2, L2) for f in f_grid])

    roots = []
    for i in range(len(f_grid) - 1):
        if g_grid[i] == 0.0:
            roots.append(f_grid[i])
        elif g_grid[i] * g_grid[i + 1] < 0.0:
            root = brentq(_dispersion_g, f_grid[i], f_grid[i + 1], args=(c1, L1, c2, L2))
            roots.append(root)
    return sorted(roots)


def run_case(*, c1: float, L1: float, c2: float, L2: float, R: float,
            nx1: int, nx2: int, nr: int, n_compare: int = 4) -> List[ModeComparison]:
    """Solve the FEM two-zone duct at m=0 and match the lowest ``n_compare`` modes
    against the dispersion-relation roots (same sort-and-pair strategy as V1; see the
    completeness pitfall noted in ``docs/stability/stability_hifi_p0_v1_notes.md`` --
    the analytic root search above already returns every root up to ``f_max_hz``, with
    no truncation-by-branch that could silently skip one, so that specific bug class
    does not apply here, but the general "did I search far enough" question still does,
    hence ``f_max_hz`` below is set generously past the highest mode we intend to compare).
    """
    # A rough frequency ceiling to search up to: comfortably past where we expect the
    # n_compare-th mode. Uniform-limit estimate n*c_avg/(2L) as a starting scale, x3 margin.
    c_avg = 0.5 * (c1 + c2)
    L = L1 + L2
    f_max_guess = 3.0 * n_compare * c_avg / (2.0 * L)
    candidates = analytic_frequencies(c1, L1, c2, L2, f_max_guess)[:n_compare]

    spec = synthetic_two_zone_duct(L1, L2, R, nx1, nx2, nr, c1=c1, c2=c2)
    sigma = (2.0 * np.pi * 0.5 * candidates[0]) ** 2   # shift below the lowest true mode
    freqs_hz, _ = solve_passive_modes(spec.mesh, spec.c_element, m=0,
                                      n_modes=n_compare + 2, sigma=sigma)

    f_min = candidates[0]
    freqs_hz = np.sort(freqs_hz[freqs_hz > 0.05 * f_min])[:n_compare]

    return [ModeComparison(f_analytic_hz=float(fa), f_fem_hz=float(ff))
            for fa, ff in zip(candidates, freqs_hz)]
