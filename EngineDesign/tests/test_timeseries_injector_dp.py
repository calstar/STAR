"""The Time-Series run reports each point's injector pressure drop, as forward mode does.

The per-point diagnostics a run collects are the injector closure's, keyed
``delta_p_injector_O`` / ``_F`` (engine/core/injectors/impinging.py, pintle.py). The Time-Series
router read ``delta_P_injector_*`` (capital P), found nothing at any point, and left
``delta_P_injector_O_psi`` out of every response -- so PressureCurveChart's "Injector Pressure Drops
vs Time" never rendered and the plotter offered a series that was never there.
"""

from __future__ import annotations

import types

import numpy as np
import pytest

from backend.routers import timeseries as ts

PSI = 6894.76


class _Runner:
    """Stands in for PintleEngineRunner.evaluate_arrays, closure diagnostics and all."""

    def __init__(self, dp_O_pa, dp_F_pa):
        self.config = types.SimpleNamespace(ablative_cooling=None, press_tank=None)
        self._dp = (dp_O_pa, dp_F_pa)

    def evaluate_arrays(self, P_O, P_F):
        n = len(P_O)
        one = np.ones(n)
        return {
            "Pc": 2.7374e6 * one, "F": 6870.0 * one, "Isp": 230.0 * one, "MR": 1.6 * one,
            "mdot_O": 1.8755 * one, "mdot_F": 1.17 * one, "mdot_total": 3.0455 * one,
            "cstar_actual": 1568.0 * one, "gamma": 1.2 * one,
            "diagnostics": [
                {"delta_p_injector_O": self._dp[0], "delta_p_injector_F": self._dp[1]} for _ in range(n)
            ],
        }


def test_injector_drops_reach_the_response():
    # Forward mode on the LE4 (3) stand's engine at 578/578 psia: 139.1 / 132.0 psi.
    runner = _Runner(139.1 * PSI, 132.0 * PSI)
    times = np.linspace(0.0, 1.0, 3)
    data, _ = ts.compute_timeseries_results(runner, times, 578.0 * np.ones(3), 578.0 * np.ones(3), run_copv=False)
    assert "delta_P_injector_O_psi" in data and "delta_P_injector_F_psi" in data, (
        "the Time-Series response has no injector pressure drops: the chart cannot show"
    )
    assert data["delta_P_injector_O_psi"] == pytest.approx([139.1] * 3)
    assert data["delta_P_injector_F_psi"] == pytest.approx([132.0] * 3)


def test_a_point_without_the_key_is_missing_not_zero():
    runner = _Runner(139.1 * PSI, 132.0 * PSI)
    times = np.linspace(0.0, 1.0, 3)
    real = runner.evaluate_arrays

    def gappy(P_O, P_F):
        out = real(P_O, P_F)
        out["diagnostics"][1] = {"error": "solver failed"}
        return out

    runner.evaluate_arrays = gappy
    data, _ = ts.compute_timeseries_results(runner, times, 578.0 * np.ones(3), 578.0 * np.ones(3), run_copv=False)
    v = data["delta_P_injector_O_psi"]
    assert v[0] == pytest.approx(139.1) and np.isnan(v[1]) and v[2] == pytest.approx(139.1)
