"""A solve that read CEA off the table's clamped edge says so.

``CEACache.eval`` clamps an off-table Pc, O/F or ε to the table edge and returns the edge's c*, Tc
and γ; chamber_solver recorded ``cea_clamped`` and nothing read it. On the LE4 (3) stand's engine
(ethalox table O/F 1.0–2.5, Pc 1–9 MPa) 578/300 psia solves at O/F 3.52 on the 2.5 edge's c*
(flat past it, though it falls ~116 m/s per unit O/F just inside), and 120/120 psia at Pc 99 psia
below the 145 psia floor -- most of a blowdown Time-Series run on this engine. Forward mode showed
no warning; the Time-Series summary none either.
"""

from __future__ import annotations

import copy
import types

import numpy as np
import pytest

PSI = 6894.757
CFG = "tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml"


@pytest.fixture(scope="module")
def runner():
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config

    cfg = load_config(CFG)
    return cfg, PintleEngineRunner(copy.deepcopy(cfg))


def _verdict(cfg, r):
    from engine.pipeline.forward_report import forward_report

    return {v["key"]: v for v in forward_report(cfg, r)["verdicts"]}["cea_table"]


def test_an_in_table_point_passes(runner):
    cfg, run = runner
    r = run.evaluate(578 * PSI, 578 * PSI, silent=True, rich_stability=True)
    assert r["diagnostics"]["cea_clamped"] == ()
    v = _verdict(cfg, r)
    assert v["status"] == "ok" and v["value"] == "inside"


def test_an_off_table_mixture_ratio_is_flagged_with_the_table_range(runner):
    cfg, run = runner
    r = run.evaluate(578 * PSI, 300 * PSI, silent=True, rich_stability=True)
    assert r["MR"] > 2.5, "the case no longer leaves the table; nothing tested"
    rng = r["diagnostics"]["cea_table_range"]["MR"]
    assert rng == pytest.approx([1.0, 2.5])
    v = _verdict(cfg, r)
    assert v["status"] == "bad"
    assert "O/F 3.5" in v["basis"] and "1.00–2.50" in v["basis"], v["basis"]


def test_a_chamber_pressure_below_the_table_is_flagged(runner):
    cfg, run = runner
    r = run.evaluate(120 * PSI, 120 * PSI, silent=True, rich_stability=True)
    v = _verdict(cfg, r)
    assert v["status"] == "bad" and "Pc" in v["basis"] and "psia" in v["basis"], v["basis"]


class _Runner:
    """evaluate_arrays with closure diagnostics; points 2 and 3 clamped on O/F."""

    def __init__(self):
        self.config = types.SimpleNamespace(ablative_cooling=None, press_tank=None)

    def evaluate_arrays(self, P_O, P_F):
        n = len(P_O)
        one = np.ones(n)
        diags = [{"cea_clamped": (), "cea_table_range": {"MR": [1.0, 2.5]}} for _ in range(n)]
        for i in (2, 3):
            diags[i] = {"cea_clamped": ("MR",), "cea_table_range": {"MR": [1.0, 2.5]}}
        return {
            "Pc": 2.0e6 * one, "F": 6000.0 * one, "Isp": 220.0 * one, "MR": np.array([1.5, 2.0, 3.0, 3.5, 1.5]),
            "mdot_O": 1.8 * one, "mdot_F": 1.0 * one, "mdot_total": 2.8 * one,
            "cstar_actual": 1550.0 * one, "gamma": 1.2 * one, "diagnostics": diags,
        }


def test_the_time_series_counts_and_marks_clamped_points():
    from backend.routers import timeseries as ts

    times = np.linspace(0.0, 4.0, 5)
    data, summary = ts.compute_timeseries_results(_Runner(), times, 500 * np.ones(5), 400 * np.ones(5), run_copv=False)
    assert summary.get("cea_clamped_points") == 2, summary
    assert summary["cea_clamped_axes"] == ["MR"]
    assert data["cea_clamped"] == [False, False, True, True, False]
    assert "t = 2.00 s" in summary["cea_clamped_note"] and "O/F 3.00 outside 1.00–2.50" in summary["cea_clamped_note"]


def test_a_flamed_out_point_is_not_counted():
    from backend.routers import timeseries as ts

    times = np.linspace(0.0, 4.0, 5)
    lox = np.array([5.0, 4.0, 3.0, 0.0, 0.0])  # dry from point 3
    data, summary = ts.compute_timeseries_results(
        _Runner(), times, 500 * np.ones(5), 400 * np.ones(5), run_copv=False, lox_mass_kg=lox, fuel_mass_kg=5 * np.ones(5)
    )
    assert summary["cea_clamped_points"] == 1 and data["cea_clamped"][3] is False


def test_a_run_inside_the_table_adds_nothing():
    from backend.routers import timeseries as ts

    r = _Runner()
    real = r.evaluate_arrays

    def clean(P_O, P_F):
        out = real(P_O, P_F)
        out["diagnostics"] = [{"cea_clamped": ()} for _ in P_O]
        return out

    r.evaluate_arrays = clean
    data, summary = ts.compute_timeseries_results(r, np.linspace(0.0, 4.0, 5), 500 * np.ones(5), 400 * np.ones(5), run_copv=False)
    assert "cea_clamped" not in data and "cea_clamped_note" not in summary
