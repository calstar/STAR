"""Unit tests for flight altitude optimizer (no RocketPy required)."""

import numpy as np

from engine.pipeline.flight_altitude_optimizer import (
    BurnTimeEval,
    optimize_minimum_fuel_burn_time,
    required_propellant_at_burn_time,
    truncate_time_series,
)


def test_truncate_time_series_interpolates_endpoint():
    times = np.array([0.0, 1.0, 2.0, 3.0])
    thrust = np.array([100.0, 200.0, 300.0, 400.0])
    mdot_O = np.ones(4) * 2.0
    mdot_F = np.ones(4) * 0.5

    t_out, thrust_out, mdot_O_out, mdot_F_out = truncate_time_series(
        times, thrust, mdot_O, mdot_F, 2.5
    )

    assert np.isclose(t_out[-1], 2.5)
    assert np.isclose(thrust_out[-1], 350.0)
    assert np.isclose(mdot_O_out[-1], 2.0)
    assert np.isclose(mdot_F_out[-1], 0.5)


def test_required_propellant_scales_with_burn_time():
    times = np.linspace(0, 4, 5)
    thrust = np.linspace(1000, 2000, 5)
    mdot_O = np.ones(5) * 1.0
    mdot_F = np.ones(5) * 0.25

    _, fuel_short, _ = required_propellant_at_burn_time(times, thrust, mdot_O, mdot_F, 2.0)
    _, fuel_long, _ = required_propellant_at_burn_time(times, thrust, mdot_O, mdot_F, 4.0)

    assert fuel_long > fuel_short
    assert np.isclose(fuel_short, 0.5, rtol=0.05)
    assert np.isclose(fuel_long, 1.0, rtol=0.05)


def test_optimize_picks_minimum_fuel_burn_time():
    times = np.linspace(0, 10, 11)
    thrust = np.ones(11) * 5000.0
    mdot_O = np.ones(11) * 2.0
    mdot_F = np.ones(11) * 0.4

    # Synthetic apogee ~ 500 * burn_time (monotonic)
    def simulate_at_burn_time(t: float) -> BurnTimeEval:
        lox, fuel, _ = required_propellant_at_burn_time(times, thrust, mdot_O, mdot_F, t)
        apogee = 500.0 * t
        return BurnTimeEval(
            burn_time_s=t,
            lox_required_kg=lox,
            fuel_required_kg=fuel,
            apogee_m=apogee,
            success=True,
        )

    result = optimize_minimum_fuel_burn_time(
        times=times,
        thrust=thrust,
        mdot_O=mdot_O,
        mdot_F=mdot_F,
        target_apogee_m=2000.0,
        apogee_tolerance_m=50.0,
        simulate_at_burn_time=simulate_at_burn_time,
        time_resolution_s=0.1,
    )

    assert result.success
    assert np.isclose(result.optimal_burn_time_s, 4.0, atol=0.15)
    assert np.isclose(result.optimal_fuel_kg, 1.6, rtol=0.1)
    assert result.achieved_apogee_m >= 1950.0


def test_optimize_infeasible_when_full_burn_below_target():
    times = np.linspace(0, 5, 6)
    thrust = np.ones(6) * 3000.0
    mdot_O = np.ones(6)
    mdot_F = np.ones(6) * 0.2

    def simulate_at_burn_time(t: float) -> BurnTimeEval:
        lox, fuel, _ = required_propellant_at_burn_time(times, thrust, mdot_O, mdot_F, t)
        return BurnTimeEval(
            burn_time_s=t,
            lox_required_kg=lox,
            fuel_required_kg=fuel,
            apogee_m=100.0 * t,
            success=True,
        )

    result = optimize_minimum_fuel_burn_time(
        times=times,
        thrust=thrust,
        mdot_O=mdot_O,
        mdot_F=mdot_F,
        target_apogee_m=2000.0,
        apogee_tolerance_m=10.0,
        simulate_at_burn_time=simulate_at_burn_time,
    )

    assert not result.success
    assert result.infeasible_reason is not None
