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
    """The Layer-1 seam: _eval_candidate must call accel.evaluate per candidate.

    Runs a genuine one-iteration smoke optimization rather than calling the
    accelerator directly, because the thing under test is the WIRING.
    """
    from engine import accel
    import engine.optimizer.layers.layer1_static_optimization as L1
    from engine.core.runner import PintleEngineRunner

    n = {"calls": 0}
    real = accel.evaluate

    def counting(*a, **k):
        n["calls"] += 1
        return real(*a, **k)

    base = copy.deepcopy(cfg)
    req = base.design_requirements.model_dump()
    req["layer1_random_seed"] = 0          # pin the CMA trajectory
    pcfg = {"mode": "optimizer_controlled",
            "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
            "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"])}

    L1._get_num_workers = lambda c: 1      # serial, so the patch is visible in-process
    accel.evaluate = counting
    try:
        L1.run_layer1_optimization(
            copy.deepcopy(base), PintleEngineRunner(copy.deepcopy(base)), req,
            target_burn_time=float(req.get("target_burn_time", 6.0)),
            tolerances={"thrust": 0.10, "apogee": 0.15}, pressure_config=pcfg,
            layer1_smoke=True, layer1_max_iterations=1, layer1_cma_restarts=1)
    finally:
        accel.evaluate = real

    assert n["calls"] > 0, (
        "Layer-1 ran a full iteration without ever calling accel.evaluate -- the "
        "inner-loop fast path is bypassed. The optimizer still produces correct "
        "results on the Python path, which is why no other test catches this."
    )
