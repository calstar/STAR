"""The spray fan should point straight down the chamber: tilt preference around 0 deg.

Positive tilt is OUTWARD (toward the liner). Inward lean is allowed at the plain quadratic cost;
outward costs ``outward_multiplier`` times as much. The hard wall guard is separate.
"""
import pytest

from engine.optimizer.layers.layer1_static_optimization import (
    _impinging_resultant_tilt_preference as pref,
)


def test_zero_tilt_is_free_and_the_cost_grows_quadratically():
    assert pref(0.0) == 0.0
    assert pref(-2.0, scale_deg=2.0) == pytest.approx(1.0)
    assert pref(-4.0, scale_deg=2.0) == pytest.approx(4.0)


def test_outward_costs_the_multiplier_more_than_the_same_lean_inward():
    assert pref(1.0, scale_deg=2.0, outward_multiplier=25.0) == pytest.approx(25.0 * pref(-1.0, scale_deg=2.0))
    assert pref(0.5, outward_multiplier=25.0) > pref(-2.0, outward_multiplier=25.0)


def test_unusable_tilt_costs_nothing():
    assert pref(None) == 0.0
    assert pref(float("nan")) == 0.0


def test_the_weight_reaches_the_objective_constants():
    import inspect
    from engine.optimizer.layers import layer1_static_optimization as L
    src = inspect.getsource(L.run_layer1_optimization)
    assert "'layer1_W_TILT': layer1_W_TILT" in src
    assert "resultant_tilt_penalty" in inspect.getsource(L._compute_objective_value)
