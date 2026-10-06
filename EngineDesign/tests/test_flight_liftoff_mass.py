"""The vehicle flies at the liftoff mass it was weighed at.

Judged by RocketPy's own mass bookkeeping (``rocket.total_mass(0)``), not by the arithmetic that
sets the airframe: the airframe is set from the booked motor, propellants and gases, and RocketPy
sums its tanks and gases independently.
"""

from __future__ import annotations

import contextlib
import copy
import io

import pytest
from scipy.interpolate import interp1d

from tests import flight_cases as fc

LB = 0.45359237


def _fly(liftoff=None):
    from ui.flight_sim import setup_flight

    cfg = copy.deepcopy(fc.roomy_tanks(fc.shipped()))
    t, F, mO, mF = fc.header_curve()
    cfg.thrust.burn_time = float(t[-1])
    f = lambda y: interp1d(t, y, bounds_error=False, fill_value=0.0)  # noqa: E731
    with contextlib.redirect_stdout(io.StringIO()):
        return setup_flight(cfg, f(F), f(mO), f(mF), liftoff_mass=liftoff)


@pytest.fixture(scope="module")
def as_configured():
    return _fly()


def test_the_budget_is_rocketpys_own_total(as_configured):
    budget = as_configured["mass_budget"]
    assert budget["airframe_source"] == "config"
    assert as_configured["flight"].rocket.total_mass(0.0) == pytest.approx(budget["liftoff_kg"], abs=1e-3)


def test_a_weighed_vehicle_lifts_off_at_its_weight_and_flies_lower(as_configured):
    target = 190.0 * LB
    heavier = _fly(target)
    assert heavier["flight"].rocket.total_mass(0.0) == pytest.approx(target, abs=1e-3)
    budget = heavier["mass_budget"]
    assert budget["airframe_source"] == "liftoff mass"
    assert budget["liftoff_kg"] == pytest.approx(target, abs=1e-9)
    # Only the airframe moved: the motor, propellants and gases are what the burn carries.
    for key in ("motor_dry_kg", "oxidizer_kg", "fuel_kg", "pressurant_kg", "ullage_gas_kg"):
        assert budget[key] == pytest.approx(as_configured["mass_budget"][key], rel=1e-12), key
    assert (target > as_configured["mass_budget"]["liftoff_kg"]) == (heavier["apogee"] < as_configured["apogee"])


def test_a_liftoff_mass_lighter_than_the_motor_is_refused(as_configured):
    with pytest.raises(ValueError, match="leaves nothing for the airframe"):
        _fly(as_configured["mass_budget"]["motor_dry_kg"])


def _fly_with(liftoff=None, gas=None):
    from ui.flight_sim import setup_flight

    cfg = copy.deepcopy(fc.roomy_tanks(fc.shipped()))
    t, F, mO, mF = fc.header_curve()
    cfg.thrust.burn_time = float(t[-1])
    f = lambda y: interp1d(t, y, bounds_error=False, fill_value=0.0)  # noqa: E731
    with contextlib.redirect_stdout(io.StringIO()):
        return setup_flight(cfg, f(F), f(mO), f(mF), liftoff_mass=liftoff, ullage_gas_kg=gas)


def test_the_drawings_ullage_gas_flies_with_the_vehicle(as_configured):
    own = as_configured["mass_budget"]["ullage_gas_kg"]
    gas = own + 0.515                      # the drawing's larger tanks hold more gas at T-0
    flown = _fly_with(gas=gas)
    total = flown["flight"].rocket.total_mass(0.0)
    assert total == pytest.approx(as_configured["flight"].rocket.total_mass(0.0) + 0.515, abs=1e-3)
    assert flown["mass_budget"]["ullage_gas_kg"] == pytest.approx(gas)
    assert flown["mass_budget"]["airframe_kg"] == pytest.approx(as_configured["mass_budget"]["airframe_kg"])
    # Weighed: the gas is inside the weight, so it comes out of the airframe, not on top of it.
    weighed = _fly_with(liftoff=190.0 * LB, gas=gas)
    assert weighed["flight"].rocket.total_mass(0.0) == pytest.approx(190.0 * LB, abs=1e-3)
