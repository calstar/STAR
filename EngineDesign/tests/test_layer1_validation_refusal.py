"""A design whose validation replay the chamber solver refuses is invalid, not a crash.

The chamber solver says a solve did not close in two ways: a ``ValueError`` from the
root find, and a ``RuntimeError`` from its own checks on the root it found ("Solution
validation failed: Isp is non-positive"). Layer 1's validation replay caught only the
first, so a smoke search whose last candidate replayed onto a non-physical root --
which is what CI's runners produced, and this machine did not -- took the whole
optimizer down. Here the replay is made to land on that refusal deliberately.
"""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
REFUSAL = "Solution validation failed:\nIsp is non-positive: -78.52 s"


@pytest.fixture(scope="module")
def cfg():
    from engine.pipeline.io import load_config

    return load_config(str(ROOT / "configs/canonical/impinging.yaml"))


def _smoke(cfg, monkeypatch, error: Exception):
    import engine.optimizer.layers.layer1_static_optimization as L1
    from engine.core.runner import PintleEngineRunner

    validating = {"on": False}

    def progress(stage: str, _fraction: float, _message: str) -> None:
        if stage == "Layer 1: Validation":
            validating["on"] = True

    real = PintleEngineRunner.evaluate

    def evaluate(self, *a, **k):
        if validating["on"]:
            raise error
        return real(self, *a, **k)

    monkeypatch.setattr(PintleEngineRunner, "evaluate", evaluate)
    monkeypatch.setattr(L1, "_get_num_workers", lambda c: 1)
    base = copy.deepcopy(cfg)
    req = base.design_requirements.model_dump()
    req["layer1_random_seed"] = 0
    pcfg = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": float(req["max_lox_tank_pressure_psi"]),
        "max_fuel_pressure_psi": float(req["max_fuel_tank_pressure_psi"]),
    }
    _, results = L1.run_layer1_optimization(
        copy.deepcopy(base),
        PintleEngineRunner(copy.deepcopy(base)),
        req,
        target_burn_time=float(req.get("target_burn_time", 6.0)),
        tolerances={"thrust": 0.10, "apogee": 0.15},
        pressure_config=pcfg,
        update_progress=progress,
        layer1_smoke=True,
        layer1_max_iterations=1,
        layer1_cma_restarts=1,
    )
    assert validating["on"], "the run never reached validation"
    return results["performance"]


def test_a_refused_replay_reports_the_design_invalid(cfg, monkeypatch):
    perf = _smoke(cfg, monkeypatch, RuntimeError(REFUSAL))
    assert perf["layer1_validation_used_last_good_bundle"] is True
    assert perf["validation_replay_ok"] is False
    assert perf["pressure_candidate_valid"] is False
    assert any("Isp is non-positive" in r for r in perf["failure_reasons"])


def test_any_other_runtime_error_still_surfaces(cfg, monkeypatch):
    """Only the solver's own refusals mean "this design does not close"; a bug is a bug."""
    with pytest.raises(RuntimeError, match="something else entirely"):
        _smoke(cfg, monkeypatch, RuntimeError("something else entirely"))
