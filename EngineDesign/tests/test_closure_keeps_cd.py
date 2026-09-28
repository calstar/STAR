"""The impinging closure never touches Cd, whatever solver.closure.Cd_reduction_factor says.

configs/default.yaml (the template every new session loads) and 13 other configs still carry
Cd_reduction_factor 0.95. With the spray constraints violated -- the 6500N's x* is 54 mm against
its 50 mm limit -- the closure multiplied Cd by 0.95 up to six times: Cd_O 0.80 -> 0.62, F -12 %,
and x* got WORSE (lower Cd, slower jets, bigger drops). Cd is orifice geometry and Reynolds
number (Lichtarowicz 1965; SP-8089); an x* or We violation is reported, not "fixed".

The expected Cd is the published sharp-inlet short-tube fit at the hole's L/d, less the Re term.
"""
from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PSI = 6894.757


@pytest.fixture(autouse=True, scope="module")
def _python_physics():
    """The authoritative Python path; engine/accel mirrors it and test_numba_ab_parity holds the
    two together."""
    from engine import accel
    real = accel.enabled, accel.require
    accel.enabled = lambda: False
    accel.require = lambda: False
    try:
        yield
    finally:
        accel.enabled, accel.require = real


def _evaluate(factor):
    from engine.pipeline.io import load_config
    from engine.pipeline.config_schemas import PintleEngineConfig
    from engine.core.runner import PintleEngineRunner
    d = load_config(str(ROOT / "configs/ethalox_6500N.yaml")).model_dump()
    d["solver"]["closure"]["Cd_reduction_factor"] = factor
    cfg = PintleEngineConfig.model_validate(d)
    P = 584.2669657943025 * PSI
    return PintleEngineRunner(cfg).evaluate(P_tank_O=P, P_tank_F=P)


def test_a_violated_spray_constraint_does_not_shrink_cd():
    r95, r1 = _evaluate(0.95), _evaluate(1.0)
    d95 = r95["diagnostics"]
    assert d95["constraints_satisfied"] is False, "the 6500N's x* is over its limit; the case needs a violation"
    lod = 4.0
    assert d95["Cd_O"] == pytest.approx(0.827 - 0.0085 * lod, abs=2e-3)
    assert d95["Cd_O"] == pytest.approx(r1["diagnostics"]["Cd_O"], rel=1e-9)
    assert r95["F"] == pytest.approx(r1["F"], rel=1e-9)


def test_the_ignored_factor_is_recorded():
    from engine.pipeline import assumptions
    with assumptions.scope() as used:
        _evaluate(0.95)
    assert "solver.closure.Cd_reduction_factor" in used, used
