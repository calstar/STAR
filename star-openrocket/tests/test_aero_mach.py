"""Mach-dependent fin CP/CNa (OpenRocket 24.12) and the RocketPy CP-injection math.

Covers the extension of the Barrowman port from a single Mach-0.3 condition to a
full CP(M)/CNa(M) curve, and the coefficient encoding that feeds it to RocketPy.
All offline -- no geometry store, no rocketpy.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pytest

from backend.onshape.aero.barrowman_fins import (
    CNA_SUBSONIC,
    CNA_SUPERSONIC,
    CP_SUBSONIC,
    CP_SUPERSONIC,
    fin_cp_fraction,
    fin_set_aero,
    single_fin_cna1,
)
from backend.onshape.aero.rocketpy_adapter import (
    cl_alpha_of_mach,
    cm_alpha_of_mach,
    effective_cp,
)
from backend.onshape.aero.stability import AeroCore, aero_at_mach

# Estes Alpha III trapezoid (matches test_aero_fins), for a realistic AR.
from test_aero_fins import BODY_R, R_REF, SPAN, alpha_iii_strips

AR = 2 * SPAN**2 / (((0.05 + 0.03) / 2) * SPAN)  # 2 s^2 / planform area


# ---- fin CP fraction vs Mach ------------------------------------------------

def test_cp_fraction_is_quarter_chord_subsonic():
    for m in (0.0, 0.2, 0.4, CP_SUBSONIC):
        assert fin_cp_fraction(AR, m) == pytest.approx(0.25)


def test_cp_fraction_migrates_toward_mid_chord_supersonic():
    frac_lo = fin_cp_fraction(AR, 0.5)
    frac_hi = fin_cp_fraction(AR, 3.0)
    assert frac_lo == pytest.approx(0.25)
    assert 0.45 < frac_hi < 0.5  # approaches mid-chord (0.5) from below
    # Monotone aft through the transition.
    fracs = [fin_cp_fraction(AR, m) for m in np.linspace(0.5, 3.0, 40)]
    assert all(b >= a - 1e-9 for a, b in zip(fracs, fracs[1:]))


def test_cp_fraction_continuous_at_seams():
    for seam in (CP_SUBSONIC, CP_SUPERSONIC):
        lo = fin_cp_fraction(AR, seam - 1e-4)
        hi = fin_cp_fraction(AR, seam + 1e-4)
        assert abs(hi - lo) < 1e-3, (seam, lo, hi)


# ---- fin CNa vs Mach --------------------------------------------------------

def test_subsonic_cna_unchanged_and_grows_with_mach():
    a_ref = math.pi * R_REF**2
    args = (0.002, SPAN, 0.98, a_ref)
    lo = single_fin_cna1(*args, 0.1)
    mid = single_fin_cna1(*args, 0.8)
    assert mid > lo  # Prandtl-Glauert growth


def test_cna_continuous_at_regime_seams():
    a_ref = math.pi * R_REF**2
    args = (0.002, SPAN, 0.98, a_ref)
    for seam in (CNA_SUBSONIC, CNA_SUPERSONIC):
        lo = single_fin_cna1(*args, seam - 1e-4)
        hi = single_fin_cna1(*args, seam + 1e-4)
        assert abs(hi - lo) < 1e-2, (seam, lo, hi)


def test_supersonic_cna_falls_off_with_mach():
    a_ref = math.pi * R_REF**2
    args = (0.002, SPAN, 0.98, a_ref)
    # Beyond ~M1, the 2/beta slope shrinks as beta grows.
    assert single_fin_cna1(*args, 2.0) > single_fin_cna1(*args, 3.0)


def test_openrocket_anchor_still_holds_at_low_mach():
    # The subsonic branch must reproduce OpenRocket's FinSetCalcTest value.
    lead, trail = alpha_iii_strips()
    aero = fin_set_aero(lead, trail, SPAN, BODY_R, n_fins=3, r_ref=R_REF, mach=0.3)
    assert abs(aero.cna - 24.146933) < 1e-3
    assert abs(aero.cp - 0.0193484) < 1e-4


# ---- merged core CP migrates with Mach --------------------------------------

@dataclass
class _StubProfile:
    r_max: float
    x_fore: float


def _finned_core() -> AeroCore:
    """An AeroCore with a real fin planform and a slender Mach-flat body."""
    from backend.onshape.aero.fins import FinPlanform

    lead, trail = alpha_iii_strips()
    pf = FinPlanform(
        chord_lead=lead,
        chord_trail=trail,
        span=SPAN,
        body_radius=BODY_R,
        n_fins=3,
        root_chord=0.05,
        tip_chord=0.03,
        sweep=0.02,
        area=((0.05 + 0.03) / 2) * SPAN,
        azimuths=[0.0, 120.0, 240.0],
    )
    profile = _StubProfile(r_max=R_REF, x_fore=0.0)
    # Body cp forward (near nose), modest CNa, so the fin migration is visible.
    return AeroCore(
        profile=profile, axis=None, cp_axial=0.0, cna_total=0.0,
        fin_count=3, fin_cna=0.0, fin_pf=pf, body_cna=2.0, body_cp_axial=0.05,
    )


def test_merged_cp_moves_aft_with_mach():
    core = _finned_core()
    cp_sub, _ = aero_at_mach(core, 0.3)
    cp_super, _ = aero_at_mach(core, 2.5)
    assert cp_super > cp_sub  # transonic/supersonic CP migration pulls the total aft


# ---- RocketPy CP-injection round-trip ---------------------------------------

def test_effective_cp_round_trips_our_cp_for_any_xref():
    core = _finned_core()
    ref_length = 2.0 * core.profile.r_max
    cl_of = cl_alpha_of_mach(core)
    for x_ref in (0.0, 0.03, -0.1, 0.2):
        cm_of = cm_alpha_of_mach(core, x_ref, ref_length)
        for mach in (0.2, 0.9, 1.2, 2.0, 3.0):
            cp_true, _ = aero_at_mach(core, mach)
            cp_back = effective_cp(cl_of(mach), cm_of(mach), x_ref, ref_length)
            assert cp_back == pytest.approx(cp_true, rel=1e-9, abs=1e-12)
