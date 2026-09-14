"""Verification case V1: uniform closed-closed cylinder, passive (paper Section VII.A).

Analytic reference (rigid walls at both ends and the side wall):

    f_{m,n,k} = (c / 2*pi) * sqrt( (alpha'_{m,n} / R_c)^2 + (k*pi / L)^2 )

where ``alpha'_{m,n}`` is the n-th positive zero of ``J'_m`` (hard-wall transverse
eigenvalue — the same zeros used by the lumped model's
``engine.pipeline.stability.core.TRANSVERSE_EIGENVALUES``, cross-checked here from
first principles via a 2-D FEM solve rather than assumed) and ``k`` is the number of
axial half-wavelengths (``k=0`` allowed: a pure transverse mode with no axial
variation). ``m=n=k=0`` is excluded: it is the trivial uniform-pressure mode, an exact
zero eigenvalue of an all-Neumann-boundary problem (constant pressure has zero
gradient, hence zero stiffness) — physically real but not an *acoustic* mode.

This module builds the FEM prediction (via ``eigen.passive.solve_passive_modes`` on a
``synthetic_uniform_cylinder`` mean flow) and reports it against the closed form.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np
from scipy.special import jnp_zeros

from engine.stability_hifi.eigen.passive import solve_passive_modes
from engine.stability_hifi.meanflow.spec import synthetic_uniform_cylinder


@dataclass
class ModeComparison:
    m: int
    alpha: float          # J'_m zero used (0.0 for the uniform-in-r branch, m=0 only)
    k: int                # axial half-wavelength count
    f_analytic_hz: float
    f_fem_hz: float

    @property
    def rel_error(self) -> float:
        return abs(self.f_fem_hz - self.f_analytic_hz) / self.f_analytic_hz


def radial_eigenvalues(m: int, n_max: int) -> np.ndarray:
    """Positive zeros of J'_m relevant to azimuthal wavenumber ``m``.

    For ``m=0`` the r=0 axis condition is Neumann (natural), so alpha=0 (uniform-in-r)
    is an admissible branch, prepended to the true positive zeros of J'_0. For ``m>=1``
    the axis condition is Dirichlet (p=0 at r=0, Section III.E), so alpha=0 is not
    admissible and only the true positive zeros of J'_m apply.
    """
    zeros = jnp_zeros(m, n_max) if n_max > 0 else np.array([])
    if m == 0:
        return np.concatenate([[0.0], zeros])
    return zeros


def analytic_frequencies(c: float, L: float, R: float, m: int,
                         n_radial_max: int = 2, k_max: int = 2) -> List[ModeComparison]:
    """All analytic (alpha, k) candidate frequencies for wavenumber ``m``, trivial mode excluded."""
    out = []
    for alpha in radial_eigenvalues(m, n_radial_max):
        for k in range(k_max + 1):
            if alpha == 0.0 and k == 0:
                continue   # trivial uniform-pressure mode (mu=0), not acoustic
            f = (c / (2.0 * np.pi)) * np.sqrt((alpha / R) ** 2 + (k * np.pi / L) ** 2)
            out.append(ModeComparison(m=m, alpha=float(alpha), k=k, f_analytic_hz=float(f), f_fem_hz=float("nan")))
    out.sort(key=lambda mc: mc.f_analytic_hz)
    return out


def run_case(*, c: float, L: float, R: float, m: int, nx: int, nr: int,
            n_radial_max: int = 2, k_max: int = 2, n_compare: int = 4) -> List[ModeComparison]:
    """Run the FEM solve for wavenumber ``m`` and match the lowest ``n_compare`` modes
    against the analytic candidates (both lists sorted ascending, matched pairwise).
    """
    candidates = analytic_frequencies(c, L, R, m, n_radial_max, k_max)[:n_compare]
    sigma = (2.0 * np.pi * 0.5 * candidates[0].f_analytic_hz) ** 2   # below the lowest true mode

    spec = synthetic_uniform_cylinder(L, R, nx, nr, c_sound=c)
    freqs_hz, _ = solve_passive_modes(spec.mesh, spec.c, m, n_modes=n_compare + 2, sigma=sigma)

    # Drop near-zero (trivial) modes before matching against the (already trivial-excluded)
    # analytic candidates; keep the lowest n_compare survivors.
    f_min_analytic = candidates[0].f_analytic_hz
    freqs_hz = np.sort(freqs_hz[freqs_hz > 0.05 * f_min_analytic])[:n_compare]

    for mc, f_fem in zip(candidates, freqs_hz):
        mc.f_fem_hz = float(f_fem)
    return candidates
