"""Time-Series tank fill levels start from the configured load, and a curve that needs more says so.

They used to start from the mass the curve consumes, so every run ended at exactly 0: on the LE4
(3) stand's engine at 578/578 psia for the config's 3.994 s the chart drew 7.55 kg of LOX for a
tank loaded with 6.61 kg (lox_tank.mass, the fire load), while the Flight tab on the same series
said the LOX runs dry at 3.50 s. Hand check: 6.611 kg / 1.8755 kg/s = 3.525 s.
"""

from __future__ import annotations

import types

import numpy as np
import pytest

from backend.routers import timeseries as ts


class _Runner:
    def __init__(self, lox_load, fuel_load, mdot_O=1.8755, mdot_F=1.2451):
        self.config = types.SimpleNamespace(
            ablative_cooling=None, press_tank=None,
            lox_tank=types.SimpleNamespace(mass=lox_load), fuel_tank=types.SimpleNamespace(mass=fuel_load),
        )
        self.m = (mdot_O, mdot_F)

    def evaluate_arrays(self, P_O, P_F):
        one = np.ones(len(P_O))
        return {
            "Pc": 2.7374e6 * one, "F": 6870.0 * one, "Isp": 224.5 * one, "MR": 1.506 * one,
            "mdot_O": self.m[0] * one, "mdot_F": self.m[1] * one, "mdot_total": sum(self.m) * one,
            "cstar_actual": 1568.0 * one, "gamma": 1.2 * one, "diagnostics": [{} for _ in P_O],
        }


def _run(runner, duration=3.994, n=200):
    t = np.linspace(0.0, duration, n)
    return ts.compute_timeseries_results(runner, t, 578.0 * np.ones(n), 578.0 * np.ones(n), run_copv=False)


def test_levels_start_at_the_load_and_the_shortfall_is_said():
    data, summary = _run(_Runner(6.611, 7.0))
    lox = data["lox_mass_remaining_kg"]
    assert lox[0] == pytest.approx(6.611), "the LOX level does not start at the loaded mass"
    assert min(lox) == 0.0, "a tank cannot hold less than nothing"
    assert summary["lox_depletion_time_s"] == pytest.approx(6.611 / 1.8755, rel=1e-3)
    assert summary["lox_short_kg"] == pytest.approx(1.8755 * 3.994 - 6.611, rel=1e-3)
    assert "LOX runs dry at t = 3.5" in summary["propellant_short_note"]
    # Fuel: 1.2451 kg/s x 3.994 s = 4.97 kg of 7.0 loaded -- 2.03 kg left, no warning for it.
    fuel = data["fuel_mass_remaining_kg"]
    assert fuel[0] == pytest.approx(7.0) and fuel[-1] == pytest.approx(7.0 - 1.2451 * 3.994, rel=1e-6)
    assert "fuel_short_kg" not in summary and "Fuel" not in summary["propellant_short_note"]


def test_a_load_that_covers_the_burn_adds_no_warning():
    data, summary = _run(_Runner(10.0, 10.0))
    assert data["lox_mass_remaining_kg"][-1] == pytest.approx(10.0 - 1.8755 * 3.994, rel=1e-6)
    assert "propellant_short_note" not in summary


def test_without_a_load_the_levels_are_the_curves_consumption_as_before():
    data, summary = _run(_Runner(None, None))
    assert data["lox_mass_remaining_kg"][0] == pytest.approx(summary["lox_propellant_kg"])
    assert data["lox_mass_remaining_kg"][-1] == pytest.approx(0.0, abs=1e-9)
    assert "lox_loaded_kg" not in summary and "propellant_short_note" not in summary


def test_the_curves_themselves_are_not_cut():
    """This tab solves the curve it is given; the Flight tab truncates at dry-out."""
    data, _ = _run(_Runner(1.0, 1.0))
    assert all(v == pytest.approx(6.87) for v in data["thrust_kN"])
