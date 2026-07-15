"""Flight sim propellant iteration — regression tests.

Verifies that:
- Apogee rises when propellant increases below truncation threshold
- Apogee falls (or plateaus) when excess propellant is loaded above full-burn requirement
- Tank mass caps are surfaced (fuel tank smaller than config mass)
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("rocketpy")

USER_CONFIG = Path("/Users/carlton/Downloads/Liquid Engine Designer Config.yaml")


def _load_user_config():
    if not USER_CONFIG.is_file():
        pytest.skip(f"User config not found: {USER_CONFIG}")
    from engine.pipeline.io import load_config

    return load_config(str(USER_CONFIG))


def _simple_pressure_profiles(duration_s: float, n_points: int = 101):
    from engine.pipeline.time_series import generate_pressure_profile

    times, lox_psi = generate_pressure_profile(
        "exponential",
        560.8013772234059,
        400.0,
        duration_s,
        n_points,
        decay_constant=3.0,
    )
    _, fuel_psi = generate_pressure_profile(
        "exponential",
        568.9552250017153,
        350.0,
        duration_s,
        n_points,
        decay_constant=3.0,
    )
    return times, lox_psi, fuel_psi


def _run_timeseries(config, duration_s: float):
    from engine.core.runner import PintleEngineRunner
    from backend.routers.timeseries import compute_timeseries_results

    runner = PintleEngineRunner(config)
    times, lox_psi, fuel_psi = _simple_pressure_profiles(duration_s)
    data, summary = compute_timeseries_results(
        runner,
        times,
        lox_psi,
        fuel_psi,
        run_copv=False,
    )
    return data, summary


def _run_flight(config, data, lox_kg: float, fuel_kg: float):
    import copy

    from engine.optimizer.copv_flight_helpers import run_flight_simulation

    cfg = copy.deepcopy(config)
    cfg.lox_tank.mass = lox_kg
    cfg.fuel_tank.mass = fuel_kg
    times = np.asarray(data["time"], dtype=float)
    times = times - times[0]
    burn_time = float(times[-1])
    pressure_curves = {
        "time": times,
        "thrust": np.asarray(data["thrust_kN"], dtype=float) * 1000.0,
        "mdot_O": np.asarray(data["mdot_O_kg_s"], dtype=float),
        "mdot_F": np.asarray(data["mdot_F_kg_s"], dtype=float),
    }
    return run_flight_simulation(cfg, pressure_curves, burn_time)


def test_fuel_tank_cap_below_config_mass():
    config = _load_user_config()
    from engine.pipeline.tank_capacity import resolve_fuel_tank_limits

    fuel_density = float(config.fluids["fuel"].density)
    max_fill, _, fill_factor, _ = resolve_fuel_tank_limits(config, fuel_density)
    config_mass = float(config.fuel_tank.mass)
    assert config_mass > max_fill, (
        f"Expected config fuel mass ({config_mass} kg) to exceed tank cap ({max_fill:.2f} kg at {fill_factor*100:.0f}% fill)"
    )


def test_apogee_increases_with_propellant_when_truncated():
    config = _load_user_config()
    data, summary = _run_timeseries(config, duration_s=6.8)

    lox_required = float(summary.get("lox_propellant_kg") or 0)
    fuel_required = float(summary.get("fuel_propellant_kg") or 0)
    assert lox_required > 0 and fuel_required > 0

    low_lox = max(0.5, lox_required * 0.45)
    low_fuel = max(0.3, fuel_required * 0.45)
    high_lox = lox_required * 1.05
    high_fuel = fuel_required * 1.05

    low = _run_flight(config, data, low_lox, low_fuel)
    high = _run_flight(config, data, high_lox, high_fuel)

    assert low.get("success"), low.get("error")
    assert high.get("success"), high.get("error")
    assert low["truncation_info"].get("truncated") is True
    assert high["apogee"] > low["apogee"] + 5.0, (
        f"Expected higher propellant to raise apogee when truncated: low={low['apogee']:.1f}m high={high['apogee']:.1f}m"
    )


def test_excess_propellant_does_not_increase_apogee():
    config = _load_user_config()
    # Use a shorter burn so full-burn is achievable within tank caps
    data, summary = _run_timeseries(config, duration_s=3.5)

    lox_required = float(summary["lox_propellant_kg"])
    fuel_required = float(summary["fuel_propellant_kg"])

    optimal = _run_flight(config, data, lox_required * 1.02, fuel_required * 1.02)
    heavy = _run_flight(config, data, lox_required * 1.35, fuel_required * 1.35)

    assert optimal.get("success"), optimal.get("error")
    assert heavy.get("success"), heavy.get("error")
    assert optimal["truncation_info"].get("truncated") is False

    assert heavy["apogee"] <= optimal["apogee"] + 15.0, (
        f"Excess propellant should not increase apogee: optimal={optimal['apogee']:.1f}m heavy={heavy['apogee']:.1f}m"
    )


def test_longer_burn_time_changes_impulse_and_apogee_with_enough_propellant():
    config = _load_user_config()
    short_data, short_summary = _run_timeseries(config, duration_s=4.0)
    long_data, long_summary = _run_timeseries(config, duration_s=8.0)

    short_imp = float(short_summary["total_impulse_kNs"])
    long_imp = float(long_summary["total_impulse_kNs"])
    assert long_imp > short_imp * 1.15, "Longer burn should deliver materially more impulse"

    short_flight = _run_flight(
        config,
        short_data,
        float(short_summary["lox_propellant_kg"]) * 1.1,
        float(short_summary["fuel_propellant_kg"]) * 1.1,
    )
    long_flight = _run_flight(
        config,
        long_data,
        float(long_summary["lox_propellant_kg"]) * 1.1,
        float(long_summary["fuel_propellant_kg"]) * 1.1,
    )

    assert short_flight.get("success"), short_flight.get("error")
    assert long_flight.get("success"), long_flight.get("error")
    assert long_flight["apogee"] > short_flight["apogee"] + 20.0, (
        f"Longer burn + enough propellant should raise apogee: short={short_flight['apogee']:.1f}m "
        f"long={long_flight['apogee']:.1f}m"
    )
