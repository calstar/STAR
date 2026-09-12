"""Verification helpers for the P1 contour->mesh path (supplementary to the paper's
V1-V6 ladder; these guard the *geometry* machinery specifically, before the V4
cross-code benchmark exists).

Two independent references are built here:

1. ``webster_modes`` — Webster's horn equation, the 1-D limit of the thermoacoustic
   Helmholtz equation (paper Eq. 6, passive, uniform c) in a duct of slowly varying
   cross-section A(x). Derivation: assume p_hat uniform over each cross-section
   (valid when the wall slope is small and the frequency is below the first
   transverse cutoff), integrate Eq. 6 over the cross-section, and use the rigid-wall
   condition to drop the wall flux:

       d/dx ( A(x) c^2 dp_hat/dx ) + omega^2 A(x) p_hat = 0,   p_hat'(0)=p_hat'(L)=0.

   This is NOT exact for our 2-D domains — its error is O(wall slope^2) — so it is
   used as a cross-check on gently tapered contours (10 deg cone: slope^2 ~ 0.03),
   where sub-1% agreement is expected, and deliberately NOT on the 45-deg hardware
   contour (slope^2 = 1), where self-convergence is the right check instead.
   Discretized by 1-D P1 FEM with A(x) linear per element (exact element integrals),
   on a grid fine enough (thousands of elements) that its own discretization error is
   negligible against the model error being tolerated.

2. ``revolved_volume`` — the exact volume of the revolved contour by adaptive
   quadrature of pi * r_wall(x)^2 dx (piecewise-analytic integrand, split at the
   segment breaks). The FEM mesh must reproduce this through the identity
   2*pi*sum_ij(M2_ij) = 2*pi*int r dOmega = Volume (rows of M2 sum shape functions
   to 1) — a direct test that the mapped mesh covers exactly the intended solid of
   revolution, independent of any eigenvalue.
"""

from __future__ import annotations

from typing import List

import numpy as np
from scipy import linalg as sla
from scipy.integrate import quad

from engine.stability_hifi.acoustics.contour import ChamberAcousticContour


def webster_modes(contour: ChamberAcousticContour, c_sound: float, n_modes: int,
                  n_elements: int = 4000) -> List[float]:
    """Lowest ``n_modes`` longitudinal frequencies [Hz] of the Webster horn equation
    on [0, x_end] with rigid ends, A(x) = pi * r_wall(x)^2.

    1-D P1 FEM: with A linear over each element (endpoint values A1, A2, length h),

        K_e = c^2 * (A1+A2)/2 / h * [[1, -1], [-1, 1]]          (A linear, p' const: exact)
        M_e = h/12 * [[3*A1 + A2, A1 + A2], [A1 + A2, A1 + 3*A2]]   (cubic integrand: exact)

    giving the symmetric GEVP K p = omega^2 M p; rigid ends are natural (no boundary
    term). Dense solve — a 1-D problem of a few thousand nodes is trivial.
    """
    xs = np.linspace(0.0, contour.x_end, n_elements + 1)
    A = np.pi * contour.r_wall(xs) ** 2
    n = len(xs)
    K = np.zeros((n, n))
    M = np.zeros((n, n))
    for k in range(n_elements):
        h = xs[k + 1] - xs[k]
        A1, A2 = A[k], A[k + 1]
        Ke = c_sound ** 2 * 0.5 * (A1 + A2) / h * np.array([[1.0, -1.0], [-1.0, 1.0]])
        Me = h / 12.0 * np.array([[3 * A1 + A2, A1 + A2], [A1 + A2, A1 + 3 * A2]])
        K[k:k + 2, k:k + 2] += Ke
        M[k:k + 2, k:k + 2] += Me
    w2 = sla.eigh(K, M, eigvals_only=True)
    w2 = np.clip(w2, 0.0, None)
    freqs = np.sqrt(w2) / (2.0 * np.pi)
    # The all-Neumann problem has one exact zero eigenvalue (uniform pressure — same
    # trivial mode V1 excludes); discard everything far below the 1L scale c/(2L).
    freqs = freqs[freqs > 0.05 * c_sound / (2.0 * contour.x_end)]
    return [float(f) for f in freqs[:n_modes]]


def revolved_volume(contour: ChamberAcousticContour) -> float:
    """Exact volume [m^3] of the revolved acoustic domain, by adaptive quadrature of
    pi * r_wall^2 dx split at the segment breaks (integrand is analytic per segment).
    """
    breaks = sorted({0.0, min(contour.L_cyl, contour.x_end),
                     min(contour.x_cone_end, contour.x_end), contour.x_end})
    total = 0.0
    for a, b in zip(breaks[:-1], breaks[1:]):
        if b <= a:
            continue
        val, _err = quad(lambda x: np.pi * float(contour.r_wall(x)) ** 2, a, b, limit=200)
        total += val
    return float(total)
