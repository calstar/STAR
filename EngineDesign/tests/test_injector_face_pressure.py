"""The injector backs onto the face pressure, not the nozzle-inlet stagnation pressure.

Heat addition in a constant-area chamber costs stagnation pressure (Rayleigh): the gas is at
rest at the face and at M_c at the nozzle inlet, M_c the subsonic root of A_c/A_t, so

    p_face / p0_ns = (1 + gamma M_c^2) / (1 + (gamma-1)/2 M_c^2)^(gamma/(gamma-1)).

Sutton & Biblarz ch. 3 tabulate ~1.05 at A_c/A_t = 2. The reference here is an independent
scipy area-Mach root and the finding's hand numbers at gamma 1.1375.
"""
from __future__ import annotations

import pytest
from scipy.optimize import brentq

from engine.core.injectors.impinging import injector_face_pressure

G = 1.1375


def _rayleigh(g, cr):
    ar = lambda M: (1.0 / M) * ((2.0 / (g + 1.0)) * (1.0 + 0.5 * (g - 1.0) * M * M)) ** ((g + 1.0) / (2.0 * (g - 1.0)))  # noqa: E731
    M = brentq(lambda M: ar(M) - cr, 1e-8, 1.0)
    return (1.0 + g * M * M) / (1.0 + 0.5 * (g - 1.0) * M * M) ** (g / (g - 1.0))


@pytest.mark.parametrize("cr,hand", [(8.26, 1.0030), (4.84, 1.0087), (3.0, 1.0227), (2.0, 1.0518)])
def test_face_pressure_ratio(cr, hand):
    Pc = 2.977e6
    got = injector_face_pressure(Pc, G, cr) / Pc
    assert got == pytest.approx(_rayleigh(G, cr), rel=1e-9)
    assert got == pytest.approx(hand, abs=1e-4)


def test_no_chamber_no_loss():
    assert injector_face_pressure(3e6, G, 1.0) == 3e6
