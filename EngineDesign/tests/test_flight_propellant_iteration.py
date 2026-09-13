"""Flight-sim propellant iteration -- regression tests against the shipped default config.

- Tank caps: a fuel tank too small for the requested load is capped by the flight router, a tank
  that fits the load is not, and an explicit design_requirements capacity wins over geometry.
- Apogee rises with propellant while the burn is truncated.
- Excess propellant above the full-burn requirement does not raise apogee.
- A longer burn with enough propellant raises impulse and apogee.

The previous version of this module read a config out of one developer's ~/Downloads folder and
asserted a property of that file's tank, so it skipped on every other machine and failed on his
once the file changed. Everything here is built from configs/default.yaml.
"""

from __future__ import annotations

import copy
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("rocketpy")

CONFIG = Path(__file__).resolve().parents[1] / "configs" / "default.yaml"


@pytest.fixture(scope="module")
def config():
    from engine.pipeline.io import load_config

    cfg = load_config(str(CONFIG))
    # Tanks sized so that no volume cap can bite in the propellant-response tests below; the cap
    # logic has its own test. (default.yaml's fuel tank holds ~4.7 kg of methane at 100%.)
    for tank, h in ((cfg.lox_tank, "lox_h"), (cfg.fuel_tank, "rp1_h")):
        tank.tank_volume_m3 = None
        setattr(tank, h, 2.0)
    return cfg


def _pressure_profiles(config, duration_s: float, n_points: int = 101):
    """Exponential blowdown from each tank's configured initial pressure to 70% of it."""
    from engine.pipeline.time_series import generate_pressure_profile

    P_O0 = float(config.lox_tank.initial_pressure_psi or config.design_requirements.max_lox_tank_pressure_psi)
    P_F0 = float(config.fuel_tank.initial_pressure_psi or config.design_requirements.max_fuel_tank_pressure_psi)
    times, lox_psi = generate_pressure_profile("exponential", P_O0, 0.7 * P_O0, duration_s, n_points, decay_constant=3.0)
    _, fuel_psi = generate_pressure_profile("exponential", P_F0, 0.7 * P_F0, duration_s, n_points, decay_constant=3.0)
    return times, lox_psi, fuel_psi


def _run_timeseries(config, duration_s: float):
    from engine.core.runner import PintleEngineRunner
    from backend.routers.timeseries import compute_timeseries_results

    runner = PintleEngineRunner(config)
    times, lox_psi, fuel_psi = _pressure_profiles(config, duration_s)
    return compute_timeseries_results(runner, times, lox_psi, fuel_psi, run_copv=False)


def _run_flight(config, data, lox_kg: float, fuel_kg: float):
    from engine.optimizer.copv_flight_helpers import run_flight_simulation

    cfg = copy.deepcopy(config)
    cfg.lox_tank.mass = lox_kg
    cfg.fuel_tank.mass = fuel_kg
    times = np.asarray(data["time"], dtype=float)
    times = times - times[0]
    pressure_curves = {
        "time": times,
        "thrust": np.asarray(data["thrust_kN"], dtype=float) * 1000.0,
        "mdot_O": np.asarray(data["mdot_O_kg_s"], dtype=float),
        "mdot_F": np.asarray(data["mdot_F_kg_s"], dtype=float),
    }
    return run_flight_simulation(cfg, pressure_curves, float(times[-1]))


def test_fuel_mass_is_capped_to_tank_and_left_alone_when_it_fits(config):
    """The flight router caps a load the tank cannot hold, matches the shared resolver, does not
    touch a load that fits, and honours an explicit design_requirements capacity over geometry."""
    from backend.routers.flight import _apply_propellant_mass_caps
    from engine.pipeline.config_schemas import PintleEngineConfig
    from engine.pipeline.tank_capacity import resolve_fuel_tank_limits

    rho_F = float(config.fluids["fuel"].density)
    base = config.model_dump()
    requested = 7.0

    small = copy.deepcopy(base)
    small["fuel_tank"].update(mass=requested, tank_volume_m3=None, rp1_h=0.3, rp1_radius=0.05)
    adj, _, fuel_max, fill_factor = _apply_propellant_mass_caps(small, config)
    expected_max, _, expected_ff, explicit = resolve_fuel_tank_limits(PintleEngineConfig(**small), rho_F)
    assert not explicit
    assert fuel_max == pytest.approx(expected_max) and fill_factor == pytest.approx(expected_ff)
    assert fuel_max < requested, "test premise: this tank must be too small for the load"
    assert adj["fuel"]["was_capped"] is True
    assert small["fuel_tank"]["mass"] == pytest.approx(fuel_max), "router must write the capped mass back"
    assert adj["fuel"]["original"] == pytest.approx(requested) and adj["fuel"]["capped"] == pytest.approx(fuel_max)

    big = copy.deepcopy(base)
    big["fuel_tank"].update(mass=requested, tank_volume_m3=None, rp1_h=2.0, rp1_radius=0.15)
    adj, _, fuel_max, _ = _apply_propellant_mass_caps(big, config)
    assert fuel_max > requested
    assert adj["fuel"]["was_capped"] is False
    assert big["fuel_tank"]["mass"] == pytest.approx(requested), "a load that fits must not be touched"

    capped = copy.deepcopy(big)
    capped["design_requirements"]["fuel_tank_capacity_kg"] = 3.0
    adj, _, fuel_max, _ = _apply_propellant_mass_caps(capped, config)
    assert fuel_max == pytest.approx(3.0) and adj["fuel"]["explicit_capacity_kg"] == pytest.approx(3.0)
    assert adj["fuel"]["was_capped"] is True and capped["fuel_tank"]["mass"] == pytest.approx(3.0)


def test_apogee_increases_with_propellant_when_truncated(config):
    data, summary = _run_timeseries(config, duration_s=6.8)

    lox_required = float(summary.get("lox_propellant_kg") or 0)
    fuel_required = float(summary.get("fuel_propellant_kg") or 0)
    assert lox_required > 0 and fuel_required > 0

    low = _run_flight(config, data, max(0.5, lox_required * 0.45), max(0.3, fuel_required * 0.45))
    high = _run_flight(config, data, lox_required * 1.05, fuel_required * 1.05)

    assert low.get("success"), low.get("error")
    assert high.get("success"), high.get("error")
    assert low["truncation_info"].get("truncated") is True
    assert high["apogee"] > low["apogee"] + 5.0, (
        f"Expected higher propellant to raise apogee when truncated: low={low['apogee']:.1f}m high={high['apogee']:.1f}m"
    )


def test_excess_propellant_does_not_increase_apogee(config):
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


def test_longer_burn_time_changes_impulse_and_apogee_with_enough_propellant(config):
    short_data, short_summary = _run_timeseries(config, duration_s=4.0)
    long_data, long_summary = _run_timeseries(config, duration_s=8.0)

    short_imp = float(short_summary["total_impulse_kNs"])
    long_imp = float(long_summary["total_impulse_kNs"])
    assert long_imp > short_imp * 1.15, "Longer burn should deliver materially more impulse"

    short_flight = _run_flight(
        config, short_data,
        float(short_summary["lox_propellant_kg"]) * 1.1, float(short_summary["fuel_propellant_kg"]) * 1.1,
    )
    long_flight = _run_flight(
        config, long_data,
        float(long_summary["lox_propellant_kg"]) * 1.1, float(long_summary["fuel_propellant_kg"]) * 1.1,
    )

    assert short_flight.get("success"), short_flight.get("error")
    assert long_flight.get("success"), long_flight.get("error")
    assert long_flight["apogee"] > short_flight["apogee"] + 20.0, (
        f"Longer burn + enough propellant should raise apogee: short={short_flight['apogee']:.1f}m "
        f"long={long_flight['apogee']:.1f}m"
    )
