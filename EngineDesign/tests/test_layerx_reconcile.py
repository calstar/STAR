"""The injector reconciler: holes resized so the design point holds through the drawing's feed.

Checked against things the reconciler does not compute itself:
  * the orifice law. At restored flows, m = Cd A sqrt(2 rho dp) on each side, so the new area over
    the old is (Cd_old / Cd_new) sqrt(dp_old / dp_new), with Cd and dp from EngineDesign's solve;
  * the design's own feed asks for no change (the opt-in rule: nothing to do, nothing done);
  * drill diameters are ASME B94.11M's, in inches;
  * on the 6.8 kN engine and the stand drawing, the burn after reconciling sees its injector at the
    pressure Forward mode sized it for (the feed fit's manifold gap closes), and the burn's mean
    thrust rises toward the design point it fell short of.
"""

from __future__ import annotations

import copy
import math
from pathlib import Path

import pytest


#: The study drawings' lockup these tests were written at [psia] (scripts/layerx_baseline.py).
STUDY_LOCKUP_PSIA = 564.7

from engine.core.runner import PintleEngineRunner
from engine.layerx import reconcile as R
from engine.pipeline.io import load_config

CFG = Path(__file__).parent.parent / "configs" / "ethalox_6800N.yaml"
PSI = 6894.757293168361
P_TANK = 578.0 * PSI
AMBIENT = 94070.0
SIDES = ("oxidizer", "fuel")


@pytest.fixture(autouse=True)
def _python_physics(monkeypatch):
    monkeypatch.setenv("ED_ACCEL", "off")


@pytest.fixture(scope="module")
def config():
    return load_config(str(CFG))


def _feed(config, K0):
    cfg = copy.deepcopy(config)
    for side, k in zip(SIDES, K0):
        cfg.feed_system[side] = cfg.feed_system[side].model_copy(update={"K0": k})
    return cfg


def _lengths(config):
    return {s: R._passage_length(config, s) for s in SIDES}


def test_the_designs_own_feed_needs_no_change(config):
    design = R._forward(config, P_TANK, AMBIENT)
    d, point, _ = R._solve_holes(config, _lengths(config), (design["thrust_N"], design["of"]), P_TANK, AMBIENT)
    for side in SIDES:
        assert d[side] == pytest.approx(getattr(config.injector.geometry, side).d_jet, rel=1e-5)


def test_a_lossier_feed_opens_the_holes_by_the_orifice_law(config):
    lengths = _lengths(config)
    design = R._forward(config, P_TANK, AMBIENT)
    lossy = _feed(config, (1.27, 2.86))              # the stand drawing's fitted K0, 2026-10-01
    before = R._forward(lossy, P_TANK, AMBIENT)
    assert before["thrust_N"] < design["thrust_N"] - 100.0
    d, point, _ = R._solve_holes(lossy, lengths, (design["thrust_N"], design["of"]), P_TANK, AMBIENT)
    assert point["thrust_N"] == pytest.approx(design["thrust_N"], rel=1e-3)
    assert point["of"] == pytest.approx(design["of"], rel=1e-3)

    old = PintleEngineRunner(copy.deepcopy(config)).evaluate(P_TANK, P_TANK, P_ambient=AMBIENT, silent=True)
    new = PintleEngineRunner(R._with_holes(lossy, d, lengths)).evaluate(P_TANK, P_TANK, P_ambient=AMBIENT, silent=True)
    for side, k in (("oxidizer", "O"), ("fuel", "F")):
        assert new[f"mdot_{k}"] == pytest.approx(old[f"mdot_{k}"], rel=2e-3)
        dp_old = old["injector_pressure"][f"delta_p_injector_{k}"]
        dp_new = new["injector_pressure"][f"delta_p_injector_{k}"]
        expected = (new[f"mdot_{k}"] / old[f"mdot_{k}"]) * (old[f"Cd_{k}"] / new[f"Cd_{k}"]) * math.sqrt(dp_old / dp_new)
        got = (d[side] / getattr(config.injector.geometry, side).d_jet) ** 2
        assert got == pytest.approx(expected, rel=5e-3), side
        # the passage keeps its drilled length; only its L/d moves
        assert new_lod(lossy, d, lengths, side) * d[side] == pytest.approx(lengths[side], rel=1e-9)


def new_lod(config, d, lengths, side):
    return R._with_holes(config, d, lengths).discharge[side].orifice_l_over_d


def test_a_lighter_feed_shrinks_the_holes_and_says_it_needs_a_new_plate(config):
    lengths = _lengths(config)
    design = R._forward(config, P_TANK, AMBIENT)
    light = _feed(config, (0.2, 1.0))
    d, _, _ = R._solve_holes(light, lengths, (design["thrust_N"], design["of"]), P_TANK, AMBIENT)
    rows = R._changes(config, R._with_holes(light, d, lengths), lengths)
    holes = [r for r in rows if r["item"].endswith("orifice diameter")]
    assert all(r["to"] < r["from"] for r in holes)
    assert all(r["fabrication"].startswith("new plate") for r in holes)


@pytest.mark.parametrize("no, inch", [(51, 0.0670), (53, 0.0595), (60, 0.0400)])
def test_drills_are_the_standard_sizes(no, inch):
    out = R.drills(inch * 25.4)
    assert out["number"]["drill"] == f"#{no}"
    assert out["number"]["d_mm"] == pytest.approx(inch * 25.4)
    assert out["number"]["area_error"] == pytest.approx(0.0, abs=1e-12)


# ------------------------------------------------------------------ the whole loop, on the drawing


feedtwin = pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")
from engine.layerx import DrawingStore, LayerXSettings  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402

GN2 = "copv_study_gn2"
# The GN2 drawing is a nitrogen-over-LOX hot fire, refused since 2026-10-03 unless acknowledged
# (engine/layerx/prepare.py gn2_on_lox); these tests study its burn, so their settings acknowledge it.


@pytest.mark.skipif(not (shipped_drawings_dir() / f"{GN2}.json").is_file(),
                    reason="feed-twin's shipped drawings are not next to this checkout")
def test_reconciling_closes_the_gap_on_the_stand(config):
    drawing = {d.name: d for d in DrawingStore(None).list()}[GN2]
    settings = LayerXSettings(drawing_id=drawing.id, tank_pressure_psia=STUDY_LOCKUP_PSIA, ack_gn2_condensation=True, replay=False)
    res = R.run_reconcile(config, drawing, settings, [], R.ReconcileRequest(max_passes=4))
    assert res["converged"]
    target = res["design"]["thrust_N"]
    # Checked on the burn itself, not on a fit or on Forward mode: the twin's mean thrust (no replay
    # here, so the throat is as built) against the design point. The holes are sized to the
    # burn-mean feed, so the burn mean is what they must hit.
    assert res["before_burn"]["mean_thrust_N"] < 0.985 * target       # the drawn design under-feeds
    assert res["after_burn"]["mean_thrust_N"] == pytest.approx(target, rel=3e-3)
    assert res["after"]["thrust_N"] == pytest.approx(target, rel=1e-3)
    assert abs(res["after_burn"]["of_mean"] - res["design"]["of"]) < abs(res["before_burn"]["of_mean"] - res["design"]["of"])
    upd = res["design_update"]
    assert set(upd) >= {"injector", "feed_system", "discharge"}
    assert upd["feed_system"]["oxidizer"]["derived_from"]["by"] == "Layer X injector reconcile"
