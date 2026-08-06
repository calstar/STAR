"""Loads: eqs (19)-(37), and the eq (36) selection logic. PLAN.md §8."""

import math

import pytest

from physics.constants import G0, LBF_TO_N
from physics.loads import (
    DeviceLoads,
    X1_of,
    ballistic_parameter,
    design_load,
    equivalent_height,
    impact_energy,
    v_s_max,
)
from physics.schema import Hardware


def _dl(name, F_inf, F_snatch=None, fired=True):
    return DeviceLoads(name=name, fired=fired, F_inf=F_inf, F_snatch=F_snatch)


# --- eq (36) design load ---------------------------------------------------


def test_design_load_names_the_governing_device_and_candidate():
    """A design limited by drogue snatch and one limited by main opening call
    for different fixes, and the bare maximum cannot tell them apart."""
    d = design_load([_dl("drogue", 55.0, 385.0), _dl("main", 1613.0, 597.0)],
                    264.0, 1.8)
    assert d.governing_device == "main"
    assert d.governing_candidate == "F_inf (bound)"
    assert d.F_design == pytest.approx(1.5 * 1613.0)


def test_snatch_can_govern():
    d = design_load([_dl("drogue", 55.0, 900.0), _dl("main", 400.0, 300.0)],
                    100.0, 1.8)
    assert d.governing_device == "drogue"
    assert d.governing_candidate == "snatch"


def test_numerical_peak_can_govern():
    d = design_load([_dl("main", 100.0, 50.0)], 500.0, 1.8)
    assert d.governing_candidate == "Cx * max F_T (numerical)"
    assert d.F_design == pytest.approx(1.5 * 1.8 * 500.0)


def test_pflanz_can_never_govern():
    """F_pflanz = F_inf * X1 with X1 <= 1 by construction, which is exactly
    why §8.7 reports it separately rather than folding it into the max."""
    per = [_dl("main", 1613.0, 597.0)]
    per[0].X1 = 0.2663
    per[0].F_pflanz = 1613.0 * 0.2663
    d = design_load(per, 264.0, 1.8)
    assert d.governing_value >= per[0].F_pflanz


def test_devices_that_never_opened_are_excluded():
    d = design_load([_dl("dud", None, None, fired=False),
                     _dl("main", 800.0, 200.0)], 100.0, 1.8)
    assert d.governing_device == "main"


def test_no_candidates_returns_no_design_load():
    d = design_load([], None, 1.8)
    assert d.F_design is None


# --- hardware verdict, §4.2 ------------------------------------------------


def test_verdict_uses_the_weakest_link():
    hw = Hardware.from_lbf({"quick_link": 1000.0, "eyebolt": 1500.0,
                            "shock_cord": 2000.0})
    assert hw.governing_link == "quick_link"
    assert hw.F_allow == pytest.approx(1000.0 * LBF_TO_N / 1.5)

    d = design_load([_dl("main", 1613.0, 597.0)], 264.0, 1.8, hardware=hw)
    assert d.governing_link == "quick_link"
    assert d.passes is True

    d2 = design_load([_dl("main", 5000.0, 597.0)], 264.0, 1.8, hardware=hw)
    assert d2.passes is False


def test_no_hardware_means_no_verdict():
    """§4.2: without it the tool reports loads, with it a verdict. Optional so
    a run is possible before hardware is chosen."""
    d = design_load([_dl("main", 1613.0, 597.0)], 264.0, 1.8)
    assert d.F_allow is None
    assert d.passes is None


def test_hardware_with_no_links_still_carries_a_safety_factor():
    hw = Hardware(safety_factor=2.0)
    assert hw.F_allow is None
    d = design_load([_dl("main", 100.0)], None, 1.8, hardware=hw)
    assert d.safety_factor == 2.0
    assert d.F_design == pytest.approx(200.0)


# --- eq (37) speed limit ---------------------------------------------------


def test_v_s_max_inverts_the_opening_load():
    F_allow, rho, CdS, Cx = 2965.0, 1.15, 2.489, 1.8
    v = v_s_max(F_allow, rho, CdS, Cx)
    # Round trip: at exactly this speed the load equals F_allow.
    assert 0.5 * rho * v ** 2 * CdS * Cx == pytest.approx(F_allow, rel=1e-12)


def test_bigger_canopy_means_lower_survivable_speed():
    """The useful form of eq (37): the drogue has a minimum size set by
    hardware ratings, not by descent-rate preference."""
    assert v_s_max(2965.0, 1.15, 2.489, 1.8) < v_s_max(2965.0, 1.15, 0.15, 1.8)


# --- eq (33)/(34) snatch ---------------------------------------------------


def test_snatch_scales_with_sqrt_stiffness_and_linearly_with_v_rel():
    """Design lever: k proportional to 1/L, so F_snatch goes as L^-1/2.
    Doubling harness length cuts snatch 29%. Conversely F_snatch is linear in
    v_rel, so over-charging the ejection buys shock load directly."""
    def F(k, v_rel, mu=0.2049):
        return v_rel * math.sqrt(k * mu)

    assert F(2 * 17400.0, 10.0) / F(17400.0, 10.0) == pytest.approx(math.sqrt(2))
    assert F(17400.0, 20.0) / F(17400.0, 10.0) == pytest.approx(2.0)
    # Doubling length halves k, cutting snatch by 29%.
    assert F(17400.0 / 2, 10.0) / F(17400.0, 10.0) == pytest.approx(0.707, abs=0.001)


def test_reduced_mass_is_dominated_by_the_lighter_side():
    """mu = m_b*m_c/(m_b+m_c). With a 5.4 kg body and a 0.21 kg canopy, mu is
    within 4% of the canopy mass -- which is why a 70 g bag on a 213 g canopy
    raises snatch by ~14% (§6.1.3)."""
    m_b = 5.397
    mu_bare = m_b * 0.213 / (m_b + 0.213)
    mu_bagged = m_b * 0.283 / (m_b + 0.283)
    assert mu_bare == pytest.approx(0.2049, abs=1e-4)
    assert math.sqrt(mu_bagged / mu_bare) == pytest.approx(1.14, abs=0.01)


# --- eq (35) the rigid-harness justification -------------------------------


def test_harness_period_is_far_shorter_than_filling_time():
    """§8.5: t_f/t_n ~ 30 puts this deep in the quasi-static regime, so
    DAF ~ 1 and eq (20) is valid without a two-body elastic model."""
    for k, mu in ((17400.0, 0.2049), (25000.0, 0.0593), (1e5, 3.0)):
        t_n = 2 * math.pi * math.sqrt(mu / k)
        assert t_n < 0.05
        assert 0.5 / t_n > 10  # against a ~0.5 s filling time


# --- eqs (38)/(39) landing -------------------------------------------------


def test_impact_energy_and_equivalent_height():
    assert impact_energy(5.67, 6.0) == pytest.approx(102.06, abs=0.01)
    assert equivalent_height(6.0) == pytest.approx(36.0 / (2 * G0), rel=1e-12)
    # A 24.8 m/s impact is a 31 m drop -- §11.5 case 2.
    assert equivalent_height(24.84) == pytest.approx(31.5, abs=0.5)


def test_equivalent_height_round_trips_free_fall():
    for v in (5.0, 12.0, 25.0):
        h = equivalent_height(v)
        assert math.sqrt(2 * G0 * h) == pytest.approx(v, rel=1e-12)


# --- X1 guards -------------------------------------------------------------


def test_X1_rejects_a_nonpositive_ballistic_parameter():
    with pytest.raises(ValueError):
        X1_of(0.0, 2)
    with pytest.raises(ValueError):
        X1_of(-1.0, 2)


def test_ballistic_parameter_grows_as_the_canopy_shrinks():
    """A drogue sits at A ~ 15 where the bound is nearly free (1/X1 = 1.05); a
    large main at A ~ 0.3 where it costs 3.75x. Which regime a device is in is
    what decides whether measuring Cx is worth the trouble (§8.7)."""
    drogue = ballistic_parameter(5.67, 1.07, 0.15, 4.8)
    main = ballistic_parameter(5.67, 1.15, 2.489, 12.808)
    assert drogue > 10.0
    assert main < 0.5
    assert 1.0 / X1_of(drogue, 2) == pytest.approx(1.05, abs=0.01)
    assert 1.0 / X1_of(main, 2) == pytest.approx(3.75, abs=0.02)
