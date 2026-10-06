"""The chug loop reads the line's resistance, not the regulator's droop folded into K0.

Layer X's feed fit makes Forward mode agree with a burn by writing K0 = K_line + K_supply: the
supply term is the regulator sagging under flow. It lowers the injector inlet like a line loss, so
it belongs in K0 for the operating point; at chug frequencies it is the regulator's compliance,
which the stability model carries separately (Regulator), so as a feed resistance it was counted
twice and raised the gain margin. ``feed_system.<side>.supply_K`` names that share.

Judged on the model's own structure, not on a number it produced: the operating point must not
move at all, the default must be exactly the old behaviour, and the margin must fall when the
share is declared.
"""
import copy
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

CFG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "configs", "ethalox_6800N.yaml")
PSI = 6894.757293168361


@pytest.fixture(autouse=True)
def _python_physics(monkeypatch):
    monkeypatch.setenv("ED_ACCEL", "off")


def _eval(cfg):
    P = 578.0 * PSI
    out = PintleEngineRunner(copy.deepcopy(cfg)).evaluate(P, P, P_ambient=94070.0, silent=True)
    ch = out["stability_results"]["chugging"]
    return out["Pc"], out["F"], ch["chug_gain_margin"]


def test_declaring_the_supply_share_lowers_the_margin_and_moves_nothing_else():
    base = load_config(CFG)
    fitted = copy.deepcopy(base)
    # The stand fit's own numbers: K0 1.27 of which 0.63 is the regulator (K_line 0.643).
    for side, k_supply in (("oxidizer", 0.63), ("fuel", 0.85)):
        fitted.feed_system[side].K0 = base.feed_system[side].K0 + k_supply
    folded = copy.deepcopy(fitted)                       # K0 with the supply in it, undeclared
    declared = copy.deepcopy(fitted)
    for side, k_supply in (("oxidizer", 0.63), ("fuel", 0.85)):
        declared.feed_system[side].supply_K = k_supply

    pc_f, F_f, gm_folded = _eval(folded)
    pc_d, F_d, gm_declared = _eval(declared)
    assert pc_d == pytest.approx(pc_f, rel=1e-12) and F_d == pytest.approx(F_f, rel=1e-12)
    assert gm_declared < gm_folded

    # Default: supply_K 0 is the old model exactly.
    assert base.feed_system["oxidizer"].supply_K == 0.0
    zero = copy.deepcopy(folded)
    for side in ("oxidizer", "fuel"):
        zero.feed_system[side].supply_K = 0.0
    assert _eval(zero)[2] == gm_folded
