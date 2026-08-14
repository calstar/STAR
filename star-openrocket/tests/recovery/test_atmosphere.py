"""Atmosphere, PLAN.md §5 eqs (1)-(7a).

The published ISA table is the oracle here: if these equations reproduce it,
the constants, the exponent and the layer form are all right simultaneously.
"""

import math

import pytest

from physics.atmosphere import (
    Atmosphere,
    T_standard,
    geometric,
    geopotential,
    p_standard,
    refit_lapse,
)
from physics.constants import G0, L0_ISA, P0, RD, RE, RHO0, T0, T_TROP


# --- eq (1) geopotential ---------------------------------------------------


def test_geopotential_is_identity_at_sea_level():
    assert geopotential(0.0) == 0.0


def test_geopotential_at_10km():
    # 10 km geometric is 9984.29 m geopotential -- a 15.7 m correction, which
    # PLAN.md §15.2 records as negligible but retains because it is free.
    assert geopotential(10000.0) == pytest.approx(9984.293, abs=0.01)


def test_geopotential_round_trips():
    for z in (0.0, 500.0, 3000.0, 11000.0, 30000.0):
        assert geometric(geopotential(z)) == pytest.approx(z, rel=1e-12)


# --- the published ISA table ----------------------------------------------
#
# These are the numbers in every ISA reference. Reproducing them pins the
# constants and the eq (3) form together.


def test_standard_pressure_matches_published_table():
    for h, want in (
        (0.0, 101325.0),
        (1000.0, 89874.6),
        (1400.0, 85598.9),
        (11000.0, 22632.1),
        (20000.0, 5474.89),
        (32000.0, 868.02),
    ):
        assert p_standard(h) == pytest.approx(want, rel=2e-5)


def test_standard_temperature_matches_published_table():
    for h, want in (
        (0.0, 288.15),
        (11000.0, 216.65),
        (20000.0, 216.65),
        (32000.0, 228.65),
        (47000.0, 270.65),
    ):
        assert T_standard(h) == pytest.approx(want, abs=1e-9)


def test_layer0_exponent():
    assert -G0 / (RD * L0_ISA) == pytest.approx(5.255877, abs=1e-5)


def test_sea_level_density_is_the_defined_value():
    # rho0 is a consequence of p0, T0 and Rd rather than an independent
    # constant, so deriving it is a real check on the three.
    assert P0 / (RD * T0) == pytest.approx(RHO0, rel=2e-5)


def test_tropopause_temperature_is_implied_not_assumed():
    # 288.15 - 6.5 * 11 = 216.65 exactly. If this drifts, the eq (7) anchor
    # and the layer table have come apart.
    assert T0 + L0_ISA * 11000.0 == pytest.approx(T_TROP, abs=1e-9)


def test_above_the_model_ceiling_raises():
    with pytest.raises(ValueError):
        p_standard(90000.0)


# --- eq (7) pad re-fit -----------------------------------------------------


def test_refit_returns_isa_lapse_for_a_standard_pad():
    # The free regression test PLAN.md §5 calls out: feed standard sea-level
    # conditions, get the standard lapse rate back exactly.
    assert refit_lapse(288.15, 0.0) == pytest.approx(-0.0065, abs=1e-9)


def test_standard_pad_reproduces_the_standard_column():
    # A site at 500 m whose pad temperature happens to be the ISA value must
    # give back plain ISA at every altitude -- the re-fit is then a no-op, and
    # this is the strongest available check that it is wired up correctly.
    atm = Atmosphere(500.0, T_pad=T_standard(geopotential(500.0)))
    assert atm._refit is False
    for z in (0.0, 250.0, 900.0, 3000.0):
        h = geopotential(z + 500.0)
        assert atm.p(z) == pytest.approx(p_standard(h), rel=1e-9)
        assert atm.T(z) == pytest.approx(T_standard(h), rel=1e-9)


def test_defaults_are_the_standard_column():
    atm = Atmosphere(500.0)
    assert atm.T_pad == pytest.approx(T_standard(geopotential(500.0)))
    assert atm.p_pad == pytest.approx(p_standard(geopotential(500.0)))


def test_hot_pad_gives_lower_density():
    cold = Atmosphere(500.0, T_pad=273.15)
    hot = Atmosphere(500.0, T_pad=313.15)
    assert hot.rho(0.0) < cold.rho(0.0)
    # 40 K on a ~290 K base is ~13% in density -- an order of magnitude more
    # than anything §5 does about pressure. This is why the thermometer is the
    # one instrument worth bringing.
    assert cold.rho(0.0) / hot.rho(0.0) == pytest.approx(313.15 / 273.15, rel=1e-3)


# --- the isothermal guard, eq (4) ------------------------------------------


def test_isothermal_branch_when_refit_lapse_vanishes():
    # T_pad exactly at the tropopause anchor makes eq (7) return L0 = 0, and
    # eq (3) divides by zero there. Nobody launches at -56 C, but the guard is
    # one line and its absence is a crash rather than an inaccuracy.
    atm = Atmosphere(0.0, T_pad=T_TROP)
    assert atm.L0 == pytest.approx(0.0, abs=1e-15)
    p = atm.p(1000.0)
    assert math.isfinite(p) and p > 0.0
    # An isothermal layer is a pure exponential; check it against the closed form.
    want = atm.p_pad * math.exp(-G0 * geopotential(1000.0) / (RD * T_TROP))
    assert p == pytest.approx(want, rel=1e-9)


def test_isothermal_branch_is_continuous_with_the_sloped_one():
    # Approaching L0 = 0 from the sloped side must converge on the isothermal
    # answer, which is what makes the epsilon safe to pick arbitrarily.
    z = 2000.0
    p_iso = Atmosphere(0.0, T_pad=T_TROP).p(z)
    p_near = Atmosphere(0.0, T_pad=T_TROP + 1e-6).p(z)
    assert p_near == pytest.approx(p_iso, rel=1e-6)


# --- eq (6) gravity --------------------------------------------------------


def test_gravity_is_g0_at_sea_level():
    assert Atmosphere(0.0).g(0.0) == pytest.approx(G0, rel=1e-12)


def test_gravity_falls_off_inverse_square():
    atm = Atmosphere(0.0)
    assert atm.g(3000.0) == pytest.approx(G0 * (RE / (RE + 3000.0)) ** 2, rel=1e-12)
    # PLAN.md §15.2 quotes 0.09% at 3 km; hold the model to its own claim.
    assert (1.0 - atm.g(3000.0) / G0) == pytest.approx(0.00094, abs=1e-4)


# --- profile sanity --------------------------------------------------------


def test_density_and_pressure_decrease_with_altitude():
    atm = Atmosphere(500.0, T_pad=290.0)
    zs = [0.0, 100.0, 500.0, 1000.0, 3000.0, 8000.0]
    for a, b in zip(zs, zs[1:]):
        assert atm.p(b) < atm.p(a)
        assert atm.rho(b) < atm.rho(a)


def test_profile_is_continuous_across_the_tropopause():
    # Above 11 km the re-fit layer stops and the standard table takes over.
    # The handover must not introduce a step.
    atm = Atmosphere(500.0, T_pad=300.0)
    below = atm.p(11000.0 - 500.0 - 1.0)
    above = atm.p(11000.0 - 500.0 + 1.0)
    assert above == pytest.approx(below, rel=1e-3)
    assert above < below


def test_rejects_nonsense_inputs():
    with pytest.raises(ValueError):
        Atmosphere(500.0, T_pad=0.0)
    with pytest.raises(ValueError):
        Atmosphere(500.0, p_pad=-1.0)
