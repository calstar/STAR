"""Verification case V3: duct with a compact n-tau flame, closed/choked ends
(paper Section VII.A: "active flame term, delay nonlinearity, complex lambda,
all three solvers agree").

This is the first case where the eigenproblem is genuinely NONLINEAR in lambda
(the flame delay exp(-lambda*tau), Eq. 7a/11), so it is the first exercise of the
paper's Section IV solver hierarchy: the frozen-delay fixed point (Algorithm 1) and
the bordered Newton polish (Section IV.C). (The third solver of the hierarchy, Beyn
contour integration, is a completeness AUDIT rather than a mode solver and is deferred
to P3 per the paper's phasing — so "all three solvers" is, at P0, these two. Flagged
rather than silently reinterpreted.)

Configuration
-------------
A duct of length L, uniform sound speed c, rigid ("closed") end at x=0, compact
choked-nozzle admittance y_noz = (gamma-1)*Mbar_e/2 (Appendix C) at x=L, and a compact
(delta-in-x, uniform-in-r) pressure-coupled flame at x = x_f:

    q_hat(x) = gain * exp(-lambda*tau) * p_hat(x_f) * delta(x - x_f)

i.e. Eq. (7a) lumped to a single reference point and a single flame sheet, with
``gain`` absorbing (gamma-1) * n_p * (qbar_dot/pbar) * (flame axial thickness)
[units m/s]. The flame is uniform across the cross-section, so for the r-independent
longitudinal modes compared here the 2-D axisymmetric FEM and the 1-D analytic model
below describe *identical* physics.

Discrete form solved (Eq. 11, rank-1 flame):

    N(lambda) p = [K + lambda*C + lambda^2*M2 - lambda*gain*exp(-lambda*tau)*g b^T] p = 0

with b = point sample of p at (x_f, 0) and g = the r-weighted disk load at x_f
(two DIFFERENT vectors; see acoustics/assembly.py for why conflating them is a bug).

Analytic reference (derived, not from the paper)
------------------------------------------------
Zone solutions satisfying the end conditions, with s = lambda/c:

    zone 1 (0..x_f):   P(x) = cosh(s*x)                          [P'(0)=0, rigid]
    zone 2 (x_f..L):   Q(x) = r2*exp(s*(x-L)) + exp(-s*(x-L))

The admittance end condition p'(L) = -s*y_noz*p(L) (from Eq. 8 with y constant) gives

    r2 = (1 - y_noz) / (1 + y_noz)      [lambda-independent for a compact nozzle].

CAUTION (documented wrong turn): an earlier draft had r2 = (y-s')/(y+s') -> the
NEGATIVE of the correct value. The passive limit exposes it: with the wrong sign the
flame-off roots do not reproduce the independently verified tanh(s*L) = -y_noz
spectrum (sigma ~ -y*c/L, f ~ n*c/2L). Always check the passive limit of an
active-flame dispersion relation first.

At the flame, p is continuous and the slope jumps. The jump follows from the FEM's own
strong form (integrate lambda^2*p - d/dx(c^2 p') = lambda*gain*e^{-lambda*tau}
* p(x_f) * delta(x-x_f) across the sheet):

    [p']_{x_f-}^{x_f+} = -lambda * beta * exp(-lambda*tau) * p(x_f),
    beta = gain / c^2.

CAUTION (the bug that cost the most time): beta is gain/c^2, NOT gain*(R^2/2)/c^2.
The r-weighted disk load g sums to R^2/2, but the r dOmega measure multiplies every
OTHER matrix (K, M2) by the same R^2/2, so it cancels exactly in the 1-D reduction.
Double-counting it made the analytic flame coupling 1/(R^2/2) = 5000x too weak, which
presented as "FEM growth rate 5000x larger than analytic" — with frequencies agreeing
to 0.003%, the signature of a coupling-scale error rather than a discretization or
solver error. (The FEM answer was mesh-converged and confirmed independently by
first-order eigenvalue perturbation theory of the discrete system; the closed-form
sensitivity for the fundamental mode of the rigid-rigid case,
d(lambda)/d(gain) = exp(-lambda0*tau) * cos^2(pi*x_f/L) / L, in which R cancels
entirely, is re-checked in the test suite.)

Eliminating the two amplitudes with the two interface conditions gives the dispersion
relation, root-found in pole-free product form (V2's lesson):

    G(lambda) = P'(x_f) Q(x_f) - Q'(x_f) P(x_f)
                - lambda*beta*exp(-lambda*tau) * P(x_f) Q(x_f) = 0.

Phase convention worth knowing (physics finding, verified numerically three ways):
with the pure-delay coupling (7a), the Rayleigh driving of a mode goes as
+cos(omega*tau) — in-phase heat release drives, anti-phase damps — because the
cycle-averaged p'q' is |p_hat|^2 * cos(omega*tau). The sin(omega*tau) rule used by the
suite's lumped model (engine/pipeline/stability/acoustic.py) belongs to the DIFFERENCE
form of the Crocco response, n*[p'(t) - p'(t-tau)], whose transfer n*(1-e^{-i*omega*tau})
has imaginary part n*sin(omega*tau). Both are legitimate n-tau models but their
instability tau-bands sit a quarter-period apart; comparisons between this framework
and the lumped tier must translate conventions first.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from engine.stability_hifi.acoustics.assembly import (
    assemble_boundary_admittance,
    assemble_passive,
    disk_load_vector,
    point_sampling_vector,
)
from engine.stability_hifi.acoustics.mesh import two_zone_duct_mesh
from engine.stability_hifi.eigen.nlevp import fixed_point_solve, newton_polish, residual_N


@dataclass
class V3Result:
    lam_fixed_point: complex     # frozen-delay fixed point (Algorithm 1)
    lam_newton: complex          # after bordered Newton polish (Section IV.C)
    lam_analytic: complex        # root of the 1-D dispersion relation
    fp_iterations: int
    newton_iterations: int
    nlevp_residual: float        # ||N(lam) p|| / ||p|| at the Newton answer

    @property
    def solver_agreement(self) -> float:
        """|lam_fp - lam_newton| / |lam_newton| — paper's V3 acceptance: < 1e-6."""
        return abs(self.lam_fixed_point - self.lam_newton) / abs(self.lam_newton)

    @property
    def rel_error_vs_analytic(self) -> float:
        """|lam_newton - lam_analytic| / |lam_analytic| — paper's V3 acceptance: < 1%."""
        return abs(self.lam_newton - self.lam_analytic) / abs(self.lam_analytic)


def dispersion_G(lam: complex, *, c: float, L: float, x_f: float, y_noz: float,
                 beta: float, tau: float) -> complex:
    """Pole-free dispersion residual G(lambda) (module docstring). Root <=> eigenvalue."""
    s = lam / c
    xi = x_f - L
    r2 = (1.0 - y_noz) / (1.0 + y_noz)
    Pf = np.cosh(s * x_f)
    Pfp = s * np.sinh(s * x_f)
    Qf = r2 * np.exp(s * xi) + np.exp(-s * xi)
    Qfp = s * (r2 * np.exp(s * xi) - np.exp(-s * xi))
    return Pfp * Qf - Qfp * Pf - lam * beta * np.exp(-lam * tau) * Pf * Qf


def dispersion_root(lam_seed: complex, *, c: float, L: float, x_f: float, y_noz: float,
                    beta: float, tau: float, iters: int = 60, max_step: float = 20.0
                    ) -> complex:
    """Bounded-step complex Newton on G, seeded near the expected root.

    Deliberately LOCAL: we want the dispersion root nearest the seed (the FEM
    eigenvalue being cross-checked), and an unbounded/global root-finder can wander to
    a distant root and report success — scipy.fsolve did exactly that during
    development, converging to an unrelated real root thousands of rad/s away.
    Guaranteed-complete root surveys are the job of the Beyn audit tier (P3), not of a
    verification cross-check. The derivative is numerical (central difference, step
    h=1e-2 — G is smooth on O(1) lambda scales, so this is far below its variation).
    """
    lam = complex(lam_seed)
    h = 1e-2
    for _ in range(iters):
        d = dispersion_G(lam, c=c, L=L, x_f=x_f, y_noz=y_noz, beta=beta, tau=tau)
        dd = (dispersion_G(lam + h, c=c, L=L, x_f=x_f, y_noz=y_noz, beta=beta, tau=tau)
              - dispersion_G(lam - h, c=c, L=L, x_f=x_f, y_noz=y_noz, beta=beta, tau=tau)) / (2.0 * h)
        step = d / dd
        if abs(step) > max_step:
            step = step / abs(step) * max_step
        lam = lam - step
    return lam


def run_case(*, c: float, L: float, R: float, x_f: float, gamma: float, Mbar_e: float,
             flame_gain: float, tau: float, nx1: int, nx2: int, nr: int,
             rigid_end: bool = False) -> V3Result:
    """Full V3 run: FEM NLEVP (both solvers) vs the 1-D dispersion relation.

    ``rigid_end=True`` replaces the choked-nozzle admittance at x=L with a rigid wall
    (y_noz = 0) — the pure-flame sub-case, useful for isolating flame handling from
    boundary-damping handling when something disagrees.

    The mesh is built with ``two_zone_duct_mesh`` even though there is no material
    jump, purely to guarantee an exact node column at x = x_f for the disk load
    (see ``disk_load_vector``'s docstring).
    """
    y_noz = 0.0 if rigid_end else (gamma - 1.0) * Mbar_e / 2.0
    beta = flame_gain / c ** 2   # NOT /(R^2/2) — see module docstring, the costly bug

    mesh, _zone = two_zone_duct_mesh(x_f, L - x_f, R, nx1, nx2, nr)
    c_field = np.full(mesh.n_nodes, c)
    K, _Km, M2 = assemble_passive(mesh, c_field, m=0)
    K, M2 = K.toarray(), M2.toarray()
    if rigid_end:
        C = np.zeros_like(K)
    else:
        C = assemble_boundary_admittance(mesh, mesh.nodes_at_x(L),
                                         coefficient=c * y_noz).toarray()
    g = disk_load_vector(mesh, mesh.nodes_at_x(x_f))
    b = point_sampling_vector(mesh, x_f, 0.0)

    # Seed at the passive closed/choked fundamental: f ~ c/2L, sigma ~ -y*c/L
    # (Algorithm 2 step 5's "passive modes seed the shifts", in miniature).
    lam_seed = complex(-y_noz * c / L, 2.0 * np.pi * c / (2.0 * L))

    lam_fp, p_fp, n_fp = fixed_point_solve(K, C, M2, flame_gain, tau, g, b, lam_seed)
    lam_nw, p_nw, n_nw = newton_polish(K, C, M2, flame_gain, tau, g, b, lam_fp, p_fp)
    res = residual_N(K, C, M2, flame_gain, tau, g, b, lam_nw, p_nw)
    res_norm = float(np.linalg.norm(res) / np.linalg.norm(p_nw))

    lam_an = dispersion_root(lam_nw, c=c, L=L, x_f=x_f, y_noz=y_noz, beta=beta, tau=tau)

    return V3Result(lam_fixed_point=lam_fp, lam_newton=lam_nw, lam_analytic=lam_an,
                    fp_iterations=n_fp, newton_iterations=n_nw, nlevp_residual=res_norm)
