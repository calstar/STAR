"""The accelerator must distinguish "can't handle this" from "didn't converge".

Both used to surface as a bare None, which made them impossible to tell apart at
the call site or in instrumentation. They mean opposite things:

  NOT_HANDLED  no implementation exists for this config -- Python is the only
               one, so the fallback is mandatory and does real work.
  NO_SOLUTION  the physics ran and did not converge. Measured over 102 such
               candidates, the Python fallback then failed on every one, so that
               fallback is re-deriving "infeasible" at full cost.

Only the second is a candidate for ever being short-circuited. Conflating them
would make that change unsafe, because skipping the fallback on NOT_HANDLED would
silently drop every config the accelerator doesn't cover.

The public evaluate/solve/chamber_solve keep the plain-None contract; these tests
also pin that, since every caller keys on `is None`.
"""
from __future__ import annotations

import copy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PA = 101325.0


@pytest.fixture(scope="module")
def rig():
    from engine import accel
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config
    if not accel.available():
        pytest.skip("numba unavailable")
    cfg = load_config(str(ROOT / "configs/canonical/impinging.yaml"))
    return cfg, PintleEngineRunner(cfg)


def test_converged_is_ok(rig):
    from engine import accel
    cfg, r = rig
    res, oc = accel.evaluate_ex(cfg, r.cea_cache, 4.0e6, 4.0e6, PA)
    assert oc is accel.Outcome.OK
    assert res is not None and res["Pc"] > 0


def test_non_convergence_is_no_solution(rig):
    """Tank pressures below the chamber: the physics runs and gives up."""
    from engine import accel
    cfg, r = rig
    res, oc = accel.evaluate_ex(cfg, r.cea_cache, 1.2e5, 1.2e5, PA)
    assert res is None
    assert oc is accel.Outcome.NO_SOLUTION, (
        "a non-converged solve must NOT report NOT_HANDLED -- that would mark a "
        "skippable fallback as mandatory"
    )


def test_unsupported_config_is_not_handled(rig):
    """Film cooling has no port; the accelerator must say so, not 'no solution'."""
    from engine import accel
    cfg, r = rig
    bad = copy.deepcopy(cfg)
    bad.film_cooling.enabled = True
    res, oc = accel.evaluate_ex(bad, r.cea_cache, 4.0e6, 4.0e6, PA)
    assert res is None
    assert oc is accel.Outcome.NOT_HANDLED, (
        "an unsupported config must NOT report NO_SOLUTION -- short-circuiting "
        "that would silently drop the only implementation that can run it"
    )


def test_solve_and_chamber_solve_discriminate(rig):
    from engine import accel
    cfg, r = rig
    assert accel.solve_ex(cfg, 4.0e6, 4.0e6, 2.4e6)[1] is accel.Outcome.OK
    assert accel.chamber_solve_ex(cfg, r.cea_cache, 4.0e6, 4.0e6)[1] is accel.Outcome.OK
    bad = copy.deepcopy(cfg)
    bad.film_cooling.enabled = True
    assert accel.solve_ex(bad, 4.0e6, 4.0e6, 2.4e6)[1] is accel.Outcome.NOT_HANDLED
    assert accel.chamber_solve_ex(bad, r.cea_cache, 4.0e6, 4.0e6)[1] is accel.Outcome.NOT_HANDLED


def test_plain_api_still_returns_bare_none_or_result(rig):
    """Callers key on `is None`; the *_ex split must not have changed that."""
    from engine import accel
    cfg, r = rig
    ok = accel.evaluate(cfg, r.cea_cache, 4.0e6, 4.0e6, PA)
    assert isinstance(ok, dict), "evaluate() must still return the plain result dict"
    assert accel.evaluate(cfg, r.cea_cache, 1.2e5, 1.2e5, PA) is None
    assert isinstance(accel.solve(cfg, 4.0e6, 4.0e6, 2.4e6), tuple)
    assert isinstance(accel.chamber_solve(cfg, r.cea_cache, 4.0e6, 4.0e6), tuple)
