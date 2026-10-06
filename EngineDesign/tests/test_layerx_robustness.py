"""Layer X's loops do not report "settled" on missing data, and a burn's step fits its clock.

Each case is a failure the 2026-10-02 audit found reachable: a throat history with a gap, a time
step that straddles Fire, and the flight's inputs reaching it from a run.
"""

from __future__ import annotations

import math
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.layerx import replay as rpl  # noqa: E402


def test_a_history_that_vanishes_is_not_settled():
    old = (np.array([0.0, 1.0]), np.array([1.0, 1.04]))
    assert rpl.schedule_change(old, None) == math.inf
    assert rpl.schedule_change(None, None) == 0.0


def test_a_gap_in_the_throat_history_is_bridged_not_dropped():
    rp = {"available": True, "t": [0.0, 1.0, 2.0, 3.0], "A_throat_m2": [1.0, float("nan"), 1.04, 1.06]}
    t, a = rpl.throat_schedule(rp)
    assert np.all(np.isfinite(a)) and a[1] == pytest.approx(1.02)
    assert rpl.throat_schedule({"available": True, "t": [0.0, 1.0], "A_throat_m2": [float("nan"), 1.0]}) is None


feedtwin = pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx import DrawingStore, LayerXSettings, prepare, run_prepared  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "configs", "ethalox_6800N.yaml")
# The GN2 drawing is a nitrogen-over-LOX hot fire, refused since 2026-10-03 unless acknowledged
# (engine/layerx/prepare.py gn2_on_lox); these tests study its burn, so their settings acknowledge it.
needs_drawings = pytest.mark.skipif(not (shipped_drawings_dir() / "copv_study_gn2.json").is_file(),
                                    reason="feed-twin's shipped drawings are not next to this checkout")


@pytest.fixture(scope="module")
def setup():
    drawing = {d.name: d for d in DrawingStore(None).list()}["copv_study_gn2"]
    return load_config(CFG), drawing


@needs_drawings
def test_a_step_that_straddles_fire_is_refused(setup):
    cfg, drawing = setup
    bad = prepare(cfg, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, dt=0.2), [])
    assert not bad.ok and any(c.key == "time_step" and c.status == "fail" for c in bad.checks)
    good = prepare(cfg, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, dt=0.05), [])
    assert good.ok


@needs_drawings
def test_the_run_hands_the_flight_its_mass_and_a_first_failure_leaves_the_pad_burn(setup, monkeypatch):
    from engine.layerx import flight as flt

    cfg, drawing = setup
    seen = {}

    def fake_fly(config, timeseries, loads, ambient_pa, **kw):
        seen.update(kw)
        return {"ok": False, "error": "no vehicle today", "notes": []}

    monkeypatch.setattr(flt, "fly", fake_fly)
    st = LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, replay=False, flight=True, liftoff_mass_kg=86.18)
    res = run_prepared(prepare(cfg, None, drawing, st, []), replay=False, config=cfg)
    assert seen["liftoff_mass_kg"] == pytest.approx(86.18)
    # The drawing's 15.1 L + 8.67 L tanks at lockup hold about half a kilogram of nitrogen.
    assert 0.3 < seen["ullage_gas_kg"] < 0.8
    assert res["converged"] is True
    assert any(e["label"] == "Flight failed" for e in res["events"])
