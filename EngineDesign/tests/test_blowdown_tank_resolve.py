"""Tests for blowdown tank volume / propellant resolution."""

import pytest
from types import SimpleNamespace

from copv.blowdown_solver import (
    resolve_blowdown_tank_state,
    resolve_tank_volume_m3,
    split_propellant_by_of,
)


def _mock_config():
    return SimpleNamespace(
        fluids={
            "oxidizer": SimpleNamespace(density=1140.0),
            "fuel": SimpleNamespace(density=422.0),
        },
        design_requirements=SimpleNamespace(optimal_of_ratio=3.5),
        lox_tank=SimpleNamespace(tank_volume_m3=0.017474, mass=6.75),
        fuel_tank=SimpleNamespace(tank_volume_m3=0.011109, mass=7.0),
    )


def test_split_propellant_by_of():
    m_o, m_f = split_propellant_by_of(13.75, 3.5)
    assert m_o + m_f == pytest.approx(13.75)
    assert m_o / m_f == pytest.approx(3.5)


def test_resolve_tank_volume_from_ullage():
    vol = resolve_tank_volume_m3(
        tank_volume_m3=None,
        ullage_volume_m3=0.011,
        propellant_mass_kg=6.75,
        density_kg_m3=1140.0,
        tank_name="LOX",
    )
    assert vol == pytest.approx(0.011 + 6.75 / 1140.0)


def test_resolve_blowdown_from_total_propellant_and_tank_volumes():
    config = _mock_config()
    V_lox, m_lox, _, V_fuel, m_fuel, _ = resolve_blowdown_tank_state(
        config,
        total_propellant_kg=13.75,
        of_ratio=3.5,
        lox_tank_volume_m3=0.017474,
        fuel_tank_volume_m3=0.011109,
    )
    assert m_lox + m_fuel == pytest.approx(13.75)
    assert m_lox / m_fuel == pytest.approx(3.5)
    assert V_lox == pytest.approx(0.017474)
    assert V_fuel == pytest.approx(0.011109)


def test_overfilled_tank_raises():
    with pytest.raises(ValueError, match="too small"):
        resolve_tank_volume_m3(
            tank_volume_m3=0.001,
            ullage_volume_m3=None,
            propellant_mass_kg=6.75,
            density_kg_m3=1140.0,
            tank_name="LOX",
        )
