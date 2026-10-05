"""The injector's feed-loss / orifice closure is a root per stream, not a relaxed fixed point.

At a fixed Pc the two streams do not interact. The old loop relaxed both together at w = 0.35
with a 1e-6 step test: it stopped ~2e-6 short of the root, and whenever the chamber solver probed
a Pc above one tank it ran all 150 steps (that stream's flow shrinking by 0.65 a step, never
"converging") and logged a warning each time -- ~12,000 lines in one Layer 1 run.
"""
import logging

import pytest

PSI = 6894.757


def _injector():
    from engine.pipeline.io import load_config
    from engine.core.injectors.impinging import ImpingingInjector

    cfg = load_config("configs/ethalox_6500N.yaml")
    if getattr(cfg.injector, "plate", None) is not None:
        cfg.injector.plate.manifold_model = "plenum"   # the plenum closure; rings: test_injector_ring_manifold
    return ImpingingInjector(cfg)


@pytest.mark.parametrize("pc_psi", [300.0, 420.0, 500.0])
def test_returned_flow_is_the_bernoulli_flow_at_the_returned_head(pc_psi):
    P_tank = 584.27 * PSI
    mo, mf, d = _injector().solve(P_tank, P_tank, pc_psi * PSI)
    assert mo > 0 and mf > 0
    assert mo == pytest.approx(d["mdot_from_bernoulli_O"], rel=1e-10)
    assert mf == pytest.approx(d["mdot_from_bernoulli_F"], rel=1e-10)
    assert d["P_injector_O"] == pytest.approx(P_tank - d["delta_p_feed_O"], rel=1e-12)
    assert d["delta_p_injector_F"] == pytest.approx(d["P_injector_F"] - pc_psi * PSI, rel=1e-12)


def test_a_tank_at_or_below_pc_does_not_flow_and_does_not_iterate(caplog):
    caplog.set_level(logging.WARNING)
    mo, mf, d = _injector().solve(584.27 * PSI, 380.0 * PSI, 400.0 * PSI)
    assert mf == 0.0
    assert mo > 0.0
    assert d["feed_orifice_coupling_iterations"] < 40
    assert not [r for r in caplog.records if "feed-orifice" in r.getMessage() or "stream flow" in r.getMessage()]
