"""Fin-set Barrowman against OpenRocket's own FinSetCalcTest values.

Estes Alpha III trapezoidal fins (root 0.05, tip 0.03, sweep 0.02, height 0.05,
body radius 0.012). OpenRocket asserts, at AoA 0:
    3 fins: CNa = 24.146933, cp.x = 0.0193484
    4 fins: CNa = 32.195911, cp.x = 0.0193484
"""

from __future__ import annotations

import numpy as np

from backend.onshape.aero.barrowman_fins import DIVISIONS, fin_set_aero

ROOT, TIP, SWEEP, SPAN = 0.05, 0.03, 0.02, 0.05
BODY_R = 0.012
R_REF = 0.012


def alpha_iii_strips():
    """Leading/trailing edge x at each spanwise strip for the trapezoid fin.

    Leading edge sweeps from 0 (root) to `sweep` (tip); the trailing edge is
    straight at root+? -> here root trailing = ROOT and tip trailing =
    SWEEP + TIP = 0.05, so it is constant.
    """
    y = np.linspace(0.0, SPAN, DIVISIONS)
    lead = SWEEP * y / SPAN
    trail = np.full(DIVISIONS, SWEEP + TIP)  # = 0.05, constant
    return lead, trail


def test_three_fins_match_openrocket():
    lead, trail = alpha_iii_strips()
    aero = fin_set_aero(lead, trail, SPAN, BODY_R, n_fins=3, r_ref=R_REF, mach=0.3)
    assert abs(aero.cna - 24.146933) < 1e-3, aero.cna
    assert abs(aero.cp - 0.0193484) < 1e-4, aero.cp


def test_four_fins_match_openrocket():
    lead, trail = alpha_iii_strips()
    aero = fin_set_aero(lead, trail, SPAN, BODY_R, n_fins=4, r_ref=R_REF, mach=0.3)
    assert abs(aero.cna - 32.195911) < 1e-3, aero.cna
    # cp is independent of fin count.
    assert abs(aero.cp - 0.0193484) < 1e-4, aero.cp


def test_fin_count_interference_scales_cna():
    lead, trail = alpha_iii_strips()
    c3 = fin_set_aero(lead, trail, SPAN, BODY_R, 3, R_REF).cna
    c4 = fin_set_aero(lead, trail, SPAN, BODY_R, 4, R_REF).cna
    # 4 fins over 3 is the (N/2) ratio exactly, since interference is 1 for N<=4.
    assert abs(c4 / c3 - 4 / 3) < 1e-6
    # Six fins get a 0.913 interference penalty vs the naive 6/2 scaling.
    c6 = fin_set_aero(lead, trail, SPAN, BODY_R, 6, R_REF).cna
    assert abs(c6 - c3 * (6 / 3) * 0.913) < 1e-6
