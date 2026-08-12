"""Golden CoP check against OpenRocket's own JUnit expected values.

OpenRocket's ``SymmetricComponentCalcTest`` (release-24.12) asserts exact CP/CNa
for a nose cone at AoA 0, referenced to its own base area:

    conical nose : CNa = 2,  cp.x = (2/3)·L
    ogive nose   : CNa = 2,  cp.x = 0.46216·L

We reconstruct the *same shapes* as tessellated surfaces of revolution, run them
through our CAD pipeline (axis detect -> radial profile -> Barrowman body), and
require the same numbers. The ogive is the meaningful test: its curved profile
exercises the volume integral, and 0.46216·L is OpenRocket's asserted value, not
an analytic identity. Tolerances allow for tessellation faceting only.
"""

from __future__ import annotations

import math

import numpy as np

from backend.onshape.aero.barrowman_body import body_aero
from backend.onshape.aero.profile import build_profile
from test_aero_body import surface_of_revolution

# Estes Alpha III nose from the OpenRocket test.
L = 0.07
R = 0.012


def _cp_fraction_and_cna(z: np.ndarray, r: np.ndarray) -> tuple[float, float]:
    tris = surface_of_revolution(z, r, segments=96)
    profile, _ = build_profile(tris, n_stations=600)
    aero = body_aero(
        x_fore=profile.x_fore,
        x_aft=profile.x_aft,
        r_fore=profile.r_fore,
        r_aft=profile.r_aft,
        volume=profile.volume,
        r_max=profile.r_max,
    )
    return (aero.cp - profile.x_fore) / L, aero.cna


def test_conical_nose_matches_openrocket():
    z = np.linspace(0, L, 300)
    r = R * z / L  # cone
    frac, cna = _cp_fraction_and_cna(z, r)
    assert abs(cna - 2.0) < 1e-3
    # Measured error vs OpenRocket's 0.66667 is ~0.02%; this leaves headroom.
    assert abs(frac - 2.0 / 3.0) < 1e-3


def test_ogive_nose_matches_openrocket():
    # Tangent ogive: arc radius rho, r(x) = sqrt(rho^2 - (L-x)^2) - (rho - R).
    rho = (R * R + L * L) / (2 * R)
    z = np.linspace(0, L, 400)
    r = np.sqrt(rho * rho - (L - z) ** 2) - (rho - R)
    r[0] = 0.0  # exact tip
    frac, cna = _cp_fraction_and_cna(z, r)
    assert abs(cna - 2.0) < 1e-3
    # OpenRocket asserts 0.46216·L; measured error is ~0.01%. Tight on purpose.
    assert abs(frac - 0.46216) < 1e-3, f"ogive cp/L = {frac:.5f}, expected 0.46216"
