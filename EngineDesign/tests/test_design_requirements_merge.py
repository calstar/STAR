"""Saving design requirements must not erase the ones the form did not send.

``POST /api/optimizer/design-requirements`` used to rebuild ``design_requirements`` from the
request body alone (only ``frozen_parameters`` was merged). A form that sends the dozen
fields it knows about therefore reset every other key -- the ~100 ``layer1_*`` knobs, the
injector face limits, the pinned random seed -- to their schema defaults, and the next run
optimised a different problem with the UI giving no sign. This is the same hazard already
recorded for the checkout path ("an open Design Requirements tab reverts the backend to form
defaults mid-run").

Semantics pinned here: a key ABSENT from the payload keeps its current value; a key sent
with an explicit ``null`` is cleared. Those are different intents and both must work.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.routers.optimizer import merge_design_requirements  # noqa: E402

OLD = {
    "target_thrust": 6500.0,
    "optimal_of_ratio": 1.5,
    "layer1_random_seed": 37,
    "layer1_injector_center_clear_dia_m": 0.0381,
    "layer1_W_MASS": 3000.0,
    "frozen_parameters": {"Lstar": 1.0},
}


def test_absent_keys_survive():
    out = merge_design_requirements(OLD, {"target_thrust": 6600.0})
    assert out["target_thrust"] == 6600.0
    assert out["optimal_of_ratio"] == 1.5
    assert out["layer1_random_seed"] == 37
    assert out["layer1_injector_center_clear_dia_m"] == 0.0381
    assert out["layer1_W_MASS"] == 3000.0


def test_explicit_null_clears():
    out = merge_design_requirements(OLD, {"layer1_random_seed": None})
    assert out["layer1_random_seed"] is None
    assert out["layer1_W_MASS"] == 3000.0


def test_frozen_parameters_merge_key_by_key():
    out = merge_design_requirements(OLD, {"frozen_parameters": {"n_elements": 24}})
    assert out["frozen_parameters"] == {"Lstar": 1.0, "n_elements": 24}
    out = merge_design_requirements(OLD, {"frozen_parameters": {"Lstar": None}})
    assert out["frozen_parameters"] is None


def test_no_previous_requirements():
    out = merge_design_requirements(None, {"target_thrust": 1.0})
    assert out == {"target_thrust": 1.0}
