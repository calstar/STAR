"""A verdict that rests on a gap in the drawing says so up front (W14, known open).

Since 2026-10-03 the chug margin is graded on the drawing's own feed lines, and the line losses are
the drawing's. LE4 (3) draws its LOX path as direct connections (no line at all) and gives its fuel
tank line a 0 mm bore: the graded margin is 1.004 (warn) against 1.21 on EngineDesign's own
feed_system, and the flown burn depletes the other tank first. Preflight said nothing on the pad,
and the flags sat inside ``diagnostics.stability.flags``. Preflight now warns, per side, and the
graded chug limit names the gaps in its hint. The drawing itself is pid-designer's to fix.
"""

from __future__ import annotations

import copy
from dataclasses import replace
from pathlib import Path

import pytest

pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx import DrawingStore, LayerXSettings, prepare  # noqa: E402
from engine.layerx.diag.limits import grade  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

GN2 = "copv_study_gn2"
CFG = Path(__file__).resolve().parent / "fixtures" / "ethalox_6500N_doublet_cad_2026-09-28.yaml"
needs_drawing = pytest.mark.skipif(not (shipped_drawings_dir() / f"{GN2}.json").is_file(),
                                   reason="feed-twin's shipped drawings are not next to this checkout")


@needs_drawing
def test_preflight_names_a_feed_line_with_no_bore():
    config = load_config(str(CFG))
    drawing = {d.name: d for d in DrawingStore(None).list()}[GN2]
    settings = dict(replay=False, engine_model="native", tank_pressure_psia=600.0)
    whole = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, **settings))
    assert whole.ok and not any(c.key == "feed_lines" for c in whole.checks)

    payload = copy.deepcopy(drawing.payload)
    for e in payload["edges"]:
        if e["id"] == "l_fu1":
            e["data"]["params"]["bore"]["value"] = 0.0      # as LE4 (3)'s fuel tank line is drawn
    gap = replace(drawing, id=drawing.id + "-gap", payload=payload)
    prep = prepare(config, None, gap, LayerXSettings(drawing_id=gap.id, **settings))
    check = next(c for c in prep.checks if c.key == "feed_lines")
    assert check.status == "warn"
    assert check.detail.startswith("Fuel: l_fu1 has no usable length or bore")
    assert "LOX" not in check.detail


def _result():
    t = [-0.05, 0.0, 0.05, 0.10]
    side = {"tank_psia": [578.0] * 4, "stiffness": [0.0, 0.0, 0.3, 0.3], "liquid_kg": [5.0] * 4}
    block = {"t0_psia": 578.0, "min_psia": 570.0, "stiffness_min": 0.3, "peak_psia": 578.0, "loaded_kg": 5.0,
             "residual_kg": 0.0}
    return {"series": {"t": t, "dt": [0.05] * 4, "firing": [False, False, True, True], "converged": [True] * 4,
                       "copv_psia": [1500.0] * 4, "ox": dict(side), "fuel": dict(side)},
            "summary": {"depleted_side": "oxidiser", "burn_time_s": 0.1, "copv_end_psia": 1500.0, "copv_t0_psia": 4500.0,
                        "ox": dict(block), "fuel": dict(block), "failed_steps": 0, "t0_settled": True, "steps": 4},
            "events": [], "converged": True,
            "provenance": {"derived": {"roles": {"oxidiser": "OXT", "fuel": "FUT"}, "ambient_pa": 101325.0}},
            "diagnostics": {"stability": {
                "basis": "drawing", "worst": {"t": 0.05, "index": 2, "margin": 1.004},
                "settled_min": {"t": 0.10, "index": 3, "margin": 1.004}, "start_window_s": 0.05,
                "flags": ["oxidiser: OM-R: no length on the drawing, so its body's inertance is not counted",
                          "fuel: node_15-node_38: no usable length/bore; left out of the inertance",
                          "oxidiser: the drawing declares no line on the path; the config's inertance is kept"]}}}


def test_the_graded_chug_margin_names_the_gaps_it_rests_on():
    chug = next(e for e in grade(_result()) if e["key"] == "chug_margin")
    assert chug["grade"] == "warn" and chug["value"] == 1.004
    assert "It rests on gaps in the drawing: fuel: node_15-node_38: no usable length/bore" in chug["hint"]
    assert "oxidiser: the drawing declares no line on the path" in chug["hint"]
    assert len(chug["drawing_gaps"]) == 2          # the valve-body note is not a gap in the line
