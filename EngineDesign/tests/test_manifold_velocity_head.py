"""The back-face channels are the manifold, and their velocity head is checked against the
injector drop.

Holes fed from a cross-flowing channel see the channel's STATIC pressure; with the approach
flow normal to the hole axis none of the channel's velocity head is recovered (Rohde, Richards
& Metger, NASA TN D-5467, 1969), and Elverum & Morey (JPL Memo 30-5) ask for as uniform a
manifold flow as possible. Sizing rule: the channel's velocity head at the inlet, q_ch, is a
small fraction f of the injector dp, i.e. A_ch >= mdot_branch / sqrt(2 rho f dp); one inlet
per channel splits two ways, mdot_branch = mdot / 2.

On the 6500N the channels are 22.8 / 24.0 mm^2 against 45 / 38 mm^2 of orifices, so q_ch is
~63 % / 40 % of dp (config audit H-1: at least 81 / 68 mm^2 for f = 5 %). The layout used to
report the area ratio at 'info' and nothing read it.

Expected values are hand arithmetic on the layout's channel area and the solved flows.
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
C6500 = ROOT / "configs/ethalox_6500N.yaml"
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


def _hand(area, mdot, rho, dp, inlets=1, f=0.05):
    branch = mdot / (2.0 * inlets)
    v = branch / (rho * area)
    q = 0.5 * rho * v * v
    return q / dp, branch / math.sqrt(2.0 * rho * f * dp)


def test_velocity_head_function_is_the_sizing_rule():
    from engine.core.injectors.layout import channel_velocity_head
    out = channel_velocity_head(flow_area=22.75e-6, mdot=1.6792, rho=1140.0, dp=947.9e3)
    q_dp, A_need = _hand(22.75e-6, 1.6792, 1140.0, 947.9e3)
    assert out["q_over_dp"] == pytest.approx(q_dp, rel=1e-12)
    assert out["area_needed"] == pytest.approx(A_need, rel=1e-12)
    assert out["q_over_dp"] == pytest.approx(0.63, abs=0.01)          # audit H-1
    assert out["area_needed"] * 1e6 == pytest.approx(80.8, abs=0.3)    # audit H-1
    two = channel_velocity_head(flow_area=22.75e-6, mdot=1.6792, rho=1140.0, dp=947.9e3, inlets=2)
    assert two["q_over_dp"] == pytest.approx(out["q_over_dp"] / 4.0, rel=1e-12)


@pytest.fixture(scope="module")
def solved():
    from engine.pipeline.io import load_config
    from engine.core.runner import PintleEngineRunner
    cfg = load_config(str(C6500))
    P = 584.2669657943025 * PSI
    r = PintleEngineRunner(cfg).evaluate(P_tank_O=P, P_tank_F=P)
    dg = r["diagnostics"]
    return {"mdot_O": r["mdot_O"], "mdot_F": r["mdot_F"],
            "dp_O": dg["delta_p_injector_O"], "dp_F": dg["delta_p_injector_F"],
            "rho_O": cfg.fluids["oxidizer"].density, "rho_F": cfg.fluids["fuel"].density}


def _codes(out):
    return {w["code"]: w for w in out["warnings"]}


def test_6500N_channels_are_flagged_with_the_area_they_need(solved):
    from engine.core.injectors.layout import layout_from_config
    out = layout_from_config(yaml.safe_load(C6500.read_text()), drawings=False, flows=solved)
    for k, side in (("O", "O"), ("F", "F")):
        ch = out["passages"][k]["channel"]
        q_dp, A_need = _hand(ch["flow_area"], solved[f"mdot_{side}"], solved[f"rho_{side}"], solved[f"dp_{side}"])
        assert ch["q_over_dp"] == pytest.approx(q_dp, rel=1e-9)
        assert ch["area_needed"] == pytest.approx(A_need, rel=1e-9)
        w = _codes(out).get(f"manifold_q_{k}")
        assert w is not None and w["level"] == "bad", out["warnings"]
        assert f"{A_need * 1e6:.0f} mm²" in w["text"]
    # With the ring-manifold solve the starved channel carries less flow than the plenum model
    # assumed, so q/dp is lower than the old 0.5+; it is still well past MANIFOLD_Q_FRAC.
    from engine.core.injectors.layout import MANIFOLD_Q_FRAC
    assert out["passages"]["O"]["channel"]["q_over_dp"] > 5 * MANIFOLD_Q_FRAC


def test_a_channel_big_enough_is_not_flagged(solved):
    from engine.core.injectors.layout import layout_from_config
    cfg = yaml.safe_load(C6500.read_text())
    cfg["injector"]["plate"]["channel_inlets"] = 4    # q falls 16x
    out = layout_from_config(cfg, drawings=False, flows=solved)
    for k in ("O", "F"):
        assert out["passages"][k]["channel"]["q_over_dp"] < 0.05
        assert f"manifold_q_{k}" not in _codes(out)


def test_without_flows_the_area_ratio_is_still_reported():
    from engine.core.injectors.layout import layout_from_config
    out = layout_from_config(yaml.safe_load(C6500.read_text()), drawings=False)
    assert "channel_area_O" in _codes(out)
    assert out["passages"]["O"]["channel"].get("q_over_dp") is None
