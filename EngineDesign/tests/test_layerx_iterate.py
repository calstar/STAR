"""The iteration tools: pressurant swap, injector what-ifs, drill choices.

Checked against things that exist independently of the code under test:
  * feed-twin ships the stand drawn twice, once with GN2 and once with helium. Swapping the GN2
    drawing's pressurant must reproduce the helium drawing's fluids exactly, and burn the same;
  * a what-if patch lands on the injector and the passage L/d it was given, and the router
    refuses one outside its limits;
  * number drills are ASME B94.11M's.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx import DrawingStore, LayerXSettings, prepare, run_prepared  # noqa: E402
from engine.layerx.prepare import swap_pressurant  # noqa: E402
from engine.layerx.reconcile import drill_candidates  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "configs", "ethalox_6800N.yaml")
pytestmark = pytest.mark.skipif(not (shipped_drawings_dir() / "copv_study_he.json").is_file(),
                                reason="feed-twin's shipped drawings are not next to this checkout")


@pytest.fixture(scope="module")
def drawings():
    return {d.name: d for d in DrawingStore(None).list()}


def _fluids(payload):
    return {n["id"]: (n.get("data") or {}).get("fluid") for n in payload["nodes"] if (n.get("data") or {}).get("fluid")}


def test_swapping_gn2_for_helium_is_the_helium_drawing(drawings):
    gn2, he = drawings["copv_study_gn2"].payload, drawings["copv_study_he"].payload
    swapped, n, was = swap_pressurant(gn2, "helium")
    assert was == "nitrogen" and n == 10
    assert _fluids(swapped) == _fluids(he)
    assert _fluids(gn2)["KB1"] == "nitrogen"          # the drawing itself is untouched
    back, n_back, _ = swap_pressurant(he, "nitrogen")
    assert _fluids(back) == _fluids(gn2) and n_back == 10
    same, none, _ = swap_pressurant(gn2, "nitrogen")
    assert none == 0 and same is gn2


def test_a_copv_drawn_as_a_tank_is_swapped_too():
    """A pid-designer drawing can draw its COPV with the tank symbol (copv is a tank wall
    material there); feedtwin reads a TANK holding gas above its critical temperature as the
    pressurant bottle. The swap looked only for KBOTTLE symbols, found none, and changed
    nothing -- so "Use helium" on LE4 left it on nitrogen and the GN2-over-LOX check kept
    blocking the run."""
    def P(v, u):
        return {"value": v, "unit": u, "source": "estimated"}

    payload = {
        "nodes": [
            {"id": "copv", "data": {"componentType": "TANK", "label": "TK-1", "fluid": "nitrogen",
                                    "options": {"material": "copv"},
                                    "params": {"pressure": P(4000, "psi"), "temperature": P(293, "K")}}},
            {"id": "lox", "data": {"componentType": "TANK", "label": "TK-3", "fluid": "oxygen",
                                   "params": {"pressure": P(585, "psi"), "temperature": P(90.19, "K")}}},
        ],
        "edges": [],
    }
    swapped, n, was = swap_pressurant(payload, "helium")
    assert was == "nitrogen" and n == 1
    assert _fluids(swapped) == {"copv": "helium", "lox": "oxygen"}
    assert _fluids(payload)["copv"] == "nitrogen"      # the drawing itself is untouched


def test_a_swapped_drawing_burns_as_the_drawn_one(drawings):
    cfg = load_config(CFG)
    gn2, he = drawings["copv_study_gn2"], drawings["copv_study_he"]

    def burn(drawing, gas=None):
        prep = prepare(cfg, None, drawing, LayerXSettings(drawing_id=drawing.id, replay=False, pressurant=gas))
        assert prep.ok
        return run_prepared(prep, replay=False)["summary"]

    swapped, drawn = burn(gn2, "helium"), burn(he)
    for key in ("total_impulse_Ns", "burn_time_s", "copv_used_kg", "copv_end_psia"):
        assert swapped[key] == pytest.approx(drawn[key], rel=1e-9), key


def test_a_design_patch_lands_and_is_bounded():
    from backend.routers.layerx import Settings, apply_design_patch

    cfg = load_config(CFG)
    patch = {"oxidizer": {"d_jet": 0.0017018, "orifice_l_over_d": 4.795}, "fuel": {"d_jet": 0.0015113}}
    out = apply_design_patch(cfg, patch)
    assert out.injector.geometry.oxidizer.d_jet == pytest.approx(0.0017018)
    assert out.injector.geometry.fuel.d_jet == pytest.approx(0.0015113)
    assert out.discharge["oxidizer"].orifice_l_over_d == pytest.approx(4.795)
    assert cfg.injector.geometry.oxidizer.d_jet == pytest.approx(0.0016318401623160582)   # the design is not touched
    with pytest.raises(Exception):
        Settings(drawing_id="x", design_patch={"oxidizer": {"d_jet": 0.5}})
    with pytest.raises(Exception):
        Settings(drawing_id="x", design_patch={"chamber": {"d_jet": 0.001}})


@pytest.mark.parametrize("no, inch", [(51, 0.0670), (53, 0.0595)])
def test_the_nearest_drill_is_the_standard_one(no, inch):
    first = drill_candidates(inch * 25.4)[0]
    assert first["drill"] == f"#{no}" and first["area_error"] == pytest.approx(0.0, abs=1e-12)
    assert len(drill_candidates(1.6)) == 4
