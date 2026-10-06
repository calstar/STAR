"""The feed line's velocity head is lost where it dumps into the injector manifold, and one
flow area serves the loss model and the chug inertance alike.

Exit loss. From a still tank to a still manifold,
    P_tank - P_manifold = (K_entrance + f L/D + K_exit) q_line,
and a line discharging into a plenum loses its whole velocity head: Borda-Carnot
K = (1 - A_line/A_manifold)^2 -> 1, Crane TP-410 "pipe exit" K = 1.0. The shipped K0 values
(scripts/feed_line_K.py) end at the last fitting, so P_injector was the stagnation pressure of
flow still moving at ~15 m/s, and every orifice was credited one line q too much.

Area. ``A_hydraulic`` is the passage; ``d_inlet`` used to win whenever it was set (it always
is), so a twin line or non-circular passage lost 4x too much in performance while the chug
model used the declared area.

Expected values are hand arithmetic.
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest

from engine.pipeline.config_schemas import FeedSystemConfig
from engine.pipeline.feed_loss import delta_p_feed

ROOT = Path(__file__).resolve().parents[1]
PSI = 6894.757
D_TUBE = 0.010922            # 1/2" x 0.035" tube bore
A_TUBE = math.pi / 4.0 * D_TUBE ** 2
D_NPT = 0.5 * 0.0254         # 1/2" NPT fitting through-bore


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


def _q(mdot, rho, A):
    v = mdot / (rho * A)
    return 0.5 * rho * v * v


def test_exit_loss_defaults_to_one_line_velocity_head():
    cfg = FeedSystemConfig(line_size="1/2_TUBE_035", K0=2.019, K1=0.0)
    assert cfg.K_exit == 1.0
    assert delta_p_feed(1.118, 789.0, cfg, 4.0e6) == pytest.approx((2.019 + 1.0) * _q(1.118, 789.0, A_TUBE), rel=1e-12)


def test_exit_through_a_wider_fitting_is_referred_to_the_line():
    """Tube into a 1/2" NPT bore, then the dump: K at the tube is (A_tube/A_npt)^2 = (0.430/0.500)^4."""
    cfg = FeedSystemConfig(line_size="1/2_TUBE_035", K0=0.643, K1=0.0, d_exit=D_NPT)
    K_ref = (D_TUBE / D_NPT) ** 4
    assert K_ref == pytest.approx(0.547, abs=1e-3)
    assert delta_p_feed(1.68, 1140.0, cfg, 4.0e6) == pytest.approx((0.643 + K_ref) * _q(1.68, 1140.0, A_TUBE), rel=1e-12)


def test_twin_line_area_is_used():
    """Two 1/2" tubes: A = 2 x bore area. 1.118 kg/s of ethanol at K0 2.019 -> 6.61 psi, not 26.4."""
    A2 = 2.0 * A_TUBE
    cfg = FeedSystemConfig(line_size="1/2_TUBE_035", A_hydraulic=A2, K0=2.019, K1=0.0, K_exit=0.0)
    dp = delta_p_feed(1.118, 789.0, cfg, 4.0e6)
    assert dp == pytest.approx(2.019 * _q(1.118, 789.0, A2), rel=1e-12)
    assert dp / PSI == pytest.approx(6.61, abs=0.01)


def test_area_alone_is_a_valid_feed_passage():
    """feed_loss.py's own recipe: give A_hydraulic with d_inlet omitted."""
    A2 = 2.0 * A_TUBE
    cfg = FeedSystemConfig(A_hydraulic=A2, K0=2.019, K1=0.0, K_exit=0.0)
    assert cfg.d_inlet == pytest.approx(math.sqrt(4.0 * A2 / math.pi), rel=1e-12)
    assert delta_p_feed(1.118, 789.0, cfg, 4.0e6) == pytest.approx(2.019 * _q(1.118, 789.0, A2), rel=1e-12)


def _evaluate(**feed):
    from engine.pipeline.io import load_config
    from engine.pipeline.config_schemas import PintleEngineConfig
    from engine.core.runner import PintleEngineRunner
    d = load_config(str(ROOT / "configs/ethalox_6500N.yaml")).model_dump()
    for side in ("oxidizer", "fuel"):
        d["feed_system"][side].update(feed)
    cfg = PintleEngineConfig.model_validate(d)
    P = 584.2669657943025 * PSI
    return cfg, PintleEngineRunner(cfg).evaluate(P_tank_O=P, P_tank_F=P), P


def test_injector_sees_the_manifold_not_the_line_stagnation():
    cfg, r, P = _evaluate()
    dg = r["diagnostics"]
    rho = cfg.fluids["oxidizer"].density
    q = _q(r["mdot_O"], rho, cfg.feed_system["oxidizer"].A_hydraulic)
    K0 = cfg.feed_system["oxidizer"].K0
    assert dg["P_injector_O"] == pytest.approx(P - (K0 + 1.0) * q, rel=2e-6)
    _, r0, _ = _evaluate(K_exit=0.0)
    assert r["Pc"] < r0["Pc"] and r["F"] < r0["F"]
