"""The chug margin over a burn uses the closure's own injector drops and SMDs.

The time-varying solve (and the runner's array path) passed the stability analysis only the flows
and tank pressures, so it fell back to placeholder drops (0.30*Pc injector, 0.10*Pc feed) and
SMDs (80/60 um): GM 1.290 against forward mode's 1.479 at the same point on the 6.8 kN engine.
Checked against forward mode, which passes the closure's diagnostics: at the same tank pressures
and t = 0 (no erosion yet) the two must agree.
"""
import copy
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

CFG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "configs", "ethalox_6800N.yaml")
PSI = 6894.757293168361


@pytest.fixture(autouse=True)
def _python_physics(monkeypatch):
    monkeypatch.setenv("ED_ACCEL", "off")


def test_the_burn_reads_the_chug_margin_forward_mode_reads():
    cfg = load_config(CFG)
    P = 578.0 * PSI
    forward = PintleEngineRunner(copy.deepcopy(cfg)).evaluate(P, P, P_ambient=94070.0, silent=True)
    gm = forward["stability_results"]["chugging"]["stability_margin"]
    t = np.array([0.0, 0.05])
    series = PintleEngineRunner(copy.deepcopy(cfg)).evaluate_arrays_with_time(
        t, np.full(2, P), np.full(2, P), use_coupled_solver=True, P_ambient=94070.0)
    assert float(series["chugging_stability_margin"][0]) == pytest.approx(gm, rel=1e-6)
