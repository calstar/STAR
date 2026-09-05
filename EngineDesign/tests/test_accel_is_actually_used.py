"""Guard against a SILENT BYPASS: production quietly stopping using the accelerator.

Everything else in CI proves the accelerator *works* -- that numba imports, that
the kernels compile, that their numbers match Python. None of it proves the
production call sites still *call* them. Delete the `accel.evaluate(...)` line
from Layer-1's `_eval_candidate` and every other check stays green while the
optimizer silently runs ~120x slower on the Python path. That was verified by
doing exactly that: pre-flight, the strict impinging tests, the A/B parity suite
and the outcome tests all passed with the call disabled.

These tests close that hole by asserting the accelerator is actually reached
through the real code paths, not called directly by a test.
"""
from __future__ import annotations

import copy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PA = 101325.0


@pytest.fixture(scope="module")
def cfg():
    from engine import accel
    from engine.pipeline.io import load_config
    if not accel.available():
        pytest.skip("numba unavailable")
    return load_config(str(ROOT / "configs/canonical/impinging.yaml"))


def test_runner_evaluate_routes_through_the_accelerator(cfg, monkeypatch):
    """chamber_solver / closure must reach the accelerator, not just be able to.

    runner.evaluate -> chamber_solver._accel_chamber_pc -> accel.chamber_solve,
    and the Brent residual -> closure.flows -> accel.solve.
    """
    from engine import accel
    from engine.core.runner import PintleEngineRunner

    calls = {"chamber_solve": 0, "solve": 0}
    for name in calls:
        real = getattr(accel, name)
        def counting(*a, _r=real, _n=name, **k):
            calls[_n] += 1
            return _r(*a, **k)
        monkeypatch.setattr(accel, name, counting)

    r = PintleEngineRunner(cfg)
    res = r.evaluate(4.0e6, 4.0e6, P_ambient=PA, silent=True)
    assert res is not None and res["Pc"] > 0

    assert sum(calls.values()) > 0, (
        "runner.evaluate completed without reaching the accelerator at all -- the "
        f"call sites have been bypassed (counts={calls}). Everything still "
        "'passes' because Python silently produces the same numbers, just ~120x "
        "slower."
    )


def test_layer1_inner_loop_routes_through_the_accelerator(cfg):
    """The Layer-1 seam: EVERY candidate must go through accel.evaluate.

    Asserts a RATIO, not merely a non-zero count. A count-only check would pass
    if one candidate went through the accelerator and the next thousand did not.
    Measured ratio is exactly 1.000 -- every candidate -- so the 0.9 floor has
    real margin while still failing hard (ratio 0.0) on a bypass.

    Runs a genuine one-iteration smoke optimization rather than calling the
    accelerator directly, because the thing under test is the WIRING.
    """
    from engine import accel
    import engine.optimizer.layers.layer1_static_optimization as L1
    from engine.core.runner import PintleEngineRunner

    n = {"cand": 0, "accel": 0}
    real_ec, real_ev = L1._eval_candidate, accel.evaluate

    def counting_candidate(x):
        n["cand"] += 1
        return real_ec(x)

    def counting_evaluate(*a, **k):
        n["accel"] += 1
        return real_ev(*a, **k)

    base = copy.deepcopy(cfg)
    req = base.design_requirements.model_dump()
    req["layer1_random_seed"] = 0          # pin the CMA trajectory
    pcfg = {"mode": "optimizer_controlled",
            "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
            "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"])}

    L1._get_num_workers = lambda c: 1      # serial, so the patches are in-process
    L1._eval_candidate, accel.evaluate = counting_candidate, counting_evaluate
    try:
        L1.run_layer1_optimization(
            copy.deepcopy(base), PintleEngineRunner(copy.deepcopy(base)), req,
            target_burn_time=float(req.get("target_burn_time", 6.0)),
            tolerances={"thrust": 0.10, "apogee": 0.15}, pressure_config=pcfg,
            layer1_smoke=True, layer1_max_iterations=1, layer1_cma_restarts=1)
    finally:
        L1._eval_candidate, accel.evaluate = real_ec, real_ev

    assert n["cand"] > 0, "no candidates were evaluated -- the smoke run did nothing"
    ratio = n["accel"] / n["cand"]
    assert ratio >= 0.9, (
        f"only {n['accel']}/{n['cand']} candidates ({ratio:.1%}) went through the "
        "accelerator -- the Layer-1 inner-loop fast path is bypassed. The optimizer "
        "still produces correct results on the Python path, which is why no other "
        "test catches this."
    )


def test_stability_tail_routes_through_the_chug_kernel(cfg, monkeypatch):
    """The chug seam: stability analysis must reach accel.chug_margin_fast.

    Separate from the others because it is reached through
    comprehensive_stability_analysis rather than the chamber solve, so a bypass
    there is invisible to every check above. Chug is ~53x accelerated and is the
    dominant per-evaluation stability cost, so silently dropping to Python here
    is a large regression with no wrong answer to give it away.
    """
    from engine import accel
    from engine.core.runner import PintleEngineRunner

    n = {"calls": 0}
    real = accel.chug_margin_fast

    def counting(*a, **k):
        n["calls"] += 1
        return real(*a, **k)

    monkeypatch.setattr(accel, "chug_margin_fast", counting)
    r = PintleEngineRunner(cfg)
    res = r.evaluate(4.0e6, 4.0e6, P_ambient=PA, silent=True)
    assert res is not None

    assert n["calls"] > 0, (
        "stability analysis ran without reaching accel.chug_margin_fast -- the "
        "compiled chug sweep is bypassed and the ~53x slower Python sweep is "
        "running instead, with identical numbers."
    )
