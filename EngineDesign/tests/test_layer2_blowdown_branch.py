"""Layer 2 blowdown branch (Phase 3.3-3.5).

The point of this branch: in a PASSIVE blowdown system tank pressure is a *consequence* of ullage
expansion, not a free curve. So the produced P(t) must be physically realisable — monotonically
decaying and continuous — unlike the legacy segment search, which optimised an arbitrary curve.

The engine is mocked (same pattern as the other Layer-2 tests) so these run in ~1 s: the real
runner costs ~1 s per operating point, which is fine for a long-running optimisation but not for
a test suite.
"""

import math
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.optimizer.layers.layer2_pressure import _run_layer2_blowdown  # noqa: E402

P_START = 3.0e6
P_FLOOR = 1.0e6


def _config(lox_vol=0.017474, fuel_vol=0.011109, **dr_kwargs):
    dr = SimpleNamespace(feed_pressure_model="blowdown", **dr_kwargs)
    return SimpleNamespace(
        fluids={
            "oxidizer": SimpleNamespace(density=1140.0),
            "fuel": SimpleNamespace(density=810.0),
        },
        lox_tank=SimpleNamespace(tank_volume_m3=lox_vol) if lox_vol else None,
        fuel_tank=SimpleNamespace(tank_volume_m3=fuel_vol) if fuel_vol else None,
        design_requirements=dr,
        ablative_cooling=None,
        graphite_insert=None,
        injector=None,
    )


def _scale(P):
    return np.sqrt(np.clip((P - P_FLOOR) / (P_START - P_FLOOR), 0.0, None))


def _runner(chug_margin=1.30):
    r = MagicMock()

    def ev(P_lox, P_fuel, silent=True):
        P = min(P_lox, P_fuel)
        if P <= P_FLOOR:
            raise ValueError("No solution: Supply < Demand at all Pc")
        s = math.sqrt((P - P_FLOOR) / (P_START - P_FLOOR))
        return {"Pc": 0.6 * P, "mdot_O": 2.0 * s, "mdot_F": 1.0 * s}

    def ev_arr(t, P_lox, P_fuel, **kw):
        n = len(t)
        s = _scale(np.minimum(P_lox, P_fuel))
        return {
            "F": 8000.0 * s,
            "mdot_O": 2.0 * s,
            "mdot_F": 1.0 * s,
            "MR": np.full(n, 2.0),
            "Pc": 0.6 * np.minimum(P_lox, P_fuel),
            "chugging_stability_margin": np.full(n, chug_margin),
            "chug_gain_margin": np.full(n, 2.0),
        }

    r.evaluate.side_effect = ev
    r.evaluate_arrays_with_time.side_effect = ev_arr
    return r


def _run(cfg=None, chug_margin=1.30, min_stability_margin=1.05):
    cfg = cfg if cfg is not None else _config()
    with patch(
        "engine.optimizer.layers.layer2_pressure.PintleEngineRunner",
        return_value=_runner(chug_margin),
    ):
        return _run_layer2_blowdown(
            optimized_config=cfg,
            initial_lox_pressure_pa=P_START,
            initial_fuel_pressure_pa=P_START,
            peak_thrust=8000.0,
            target_apogee_m=3000.0,
            rocket_dry_mass_kg=60.0,
            max_lox_tank_capacity_kg=100.0,
            max_fuel_tank_capacity_kg=100.0,
            target_burn_time=8.0,
            n_time_points=30,
            optimal_of_ratio=2.0,
            min_stability_margin=min_stability_margin,
            de_n_time_points=12,
        )


def test_returns_standard_six_tuple_and_succeeds():
    cfg, t, P_o, P_f, summary, success = _run()
    assert success is True
    assert summary["regime"] == "blowdown"
    assert len(t) == len(P_o) == len(P_f) == 30


def test_curve_is_physically_realisable():
    """The whole reason this branch exists: a passive tank cannot follow an arbitrary curve.

    Must start at the Layer-1 anchor, decay monotonically, and be continuous (the legacy segment
    renderer produced vertical cliffs at segment boundaries).
    """
    _, _, P_o, P_f, _, _ = _run()

    assert P_o[0] == pytest.approx(P_START), "curve must start at the Layer-1 anchor"
    assert P_f[0] == pytest.approx(P_START)

    for name, P in (("LOX", P_o), ("fuel", P_f)):
        assert np.all(np.diff(P) <= 1e-6), f"{name} pressure must decay monotonically"
        steps = np.abs(np.diff(P))
        assert steps.max() < 0.25 * P_START, (
            f"{name} curve has a discontinuity of {steps.max()/1e6:.2f} MPa — a passive blowdown "
            "tank cannot step; this is the segment-cliff failure mode."
        )


def test_ullage_fractions_respect_configured_bounds():
    cfg = _config(blowdown_ullage_frac_min=0.10, blowdown_ullage_frac_max=0.40)
    _, _, _, _, summary, _ = _run(cfg)
    for key in ("ullage_frac_lox", "ullage_frac_fuel"):
        assert 0.10 - 1e-9 <= summary[key] <= 0.40 + 1e-9, f"{key}={summary[key]} out of bounds"


def test_mass_budget_uses_loaded_not_consumed():
    """Loaded propellant is what you lift; propellant stranded by flameout is dead weight.

    Scoring on consumed would make stranding free and reward steep, chug-unsafe decay.
    """
    _, _, _, _, s, _ = _run()
    loaded = s["loaded_lox_mass_kg"] + s["loaded_fuel_mass_kg"]
    assert s["total_propellant_mass_kg"] == pytest.approx(loaded), (
        "total_propellant_mass_kg (which feeds the required-impulse calc) must be the LOADED mass"
    )
    assert s["loaded_lox_mass_kg"] >= s["lox_mass_kg"] - 1e-9, "cannot consume more than loaded"
    assert s["stranded_lox_kg"] >= -1e-9 and s["stranded_fuel_kg"] >= -1e-9


def test_loaded_mass_follows_ullage_and_tank_volume():
    _, _, _, _, s, _ = _run()
    expected_lox = (1.0 - s["ullage_frac_lox"]) * s["lox_tank_volume_m3"] * 1140.0
    assert s["loaded_lox_mass_kg"] == pytest.approx(expected_lox, rel=1e-9)


def test_chug_gate_rejects_every_candidate_when_margin_is_low():
    """A design that cannot clear the stability gate must FAIL, not be returned anyway."""
    _, _, _, _, summary, success = _run(chug_margin=0.50, min_stability_margin=1.05)
    assert success is False, "the branch must not return a chug-unsafe design as a success"
    assert summary["is_success"] is False


def test_safety_recheck_runs_at_worst_case_exponent():
    _, _, _, _, s, _ = _run()
    assert s["n_polytropic_lox_hi"] > s["n_polytropic_lox"], (
        "the safety re-check exponent must be higher (faster decay) than the nominal one"
    )
    assert s["safety_ok_at_n_hi"] is True
    assert "safety_min_chug_at_n_hi" in s


def test_missing_tank_volume_raises_a_clear_error():
    """Blowdown needs a VOLUME; the kg capacity requirement is density-dependent and won't do."""
    with pytest.raises(ValueError, match="tank volume"):
        _run(_config(lox_vol=None))
