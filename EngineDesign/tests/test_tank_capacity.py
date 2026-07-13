"""Tests for configurable propellant tank fill factor."""

from engine.pipeline.tank_capacity import (
    DEFAULT_PROPELLANT_TANK_FILL_FACTOR,
    resolve_fuel_tank_limits,
    resolve_propellant_tank_fill_factor,
)


def test_default_fill_factor_is_90_percent():
    assert DEFAULT_PROPELLANT_TANK_FILL_FACTOR == 0.90


def test_fill_factor_from_design_requirements():
    class DR:
        propellant_tank_fill_factor = 0.95

    class Config:
        design_requirements = DR()

    assert resolve_propellant_tank_fill_factor(Config()) == 0.95


def test_explicit_capacity_overrides_volume_times_fill():
    class DR:
        propellant_tank_fill_factor = 0.90
        fuel_tank_capacity_kg = 12.0

    class FuelTank:
        tank_volume_m3 = 0.011109
        rp1_h = 0.609
        rp1_radius = 0.0762

    class Config:
        design_requirements = DR()
        fuel_tank = FuelTank()

    max_mass, volume, ff, explicit = resolve_fuel_tank_limits(Config(), 422.6)
    assert explicit is True
    assert max_mass == 12.0
    assert ff == 0.90
    assert volume == 0.011109
