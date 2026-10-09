"""The drawing's feed written into the design the injector is sized with.

EngineDesign sizes the injector at lockup less one K per side. The drawing's tank does not hold
lockup while firing (regulator droop, the press line), and its lines are not the design's K. The
fit expresses both in the design's own form; checked against the twin, not against itself:

* the design as it stands misses the twin's manifold pressure by more than 7 psi on each side;
* with the fitted K0, EngineDesign's own forward solve at lockup lands on the twin's burn: its
  flows within 1.5 %, its O/F within 0.5 %;
* writing the fit into the design does not move Layer X's burn, which never used the design's K0.
"""

from __future__ import annotations

from pathlib import Path

import pytest


#: The study drawings' lockup these tests were written at [psia] (scripts/layerx_baseline.py).
STUDY_LOCKUP_PSIA = 564.7

pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx import DrawingStore, LayerXSettings, prepare, run_prepared  # noqa: E402
from engine.layerx.feedfit import design_update  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "ethalox_6500N_doublet_cad_2026-09-28.yaml"
GN2 = "copv_study_gn2"
# The GN2 drawing is a nitrogen-over-LOX hot fire, refused since 2026-10-03 unless acknowledged
# (engine/layerx/prepare.py gn2_on_lox); these tests study its burn, so their settings acknowledge it.
PSI = 6894.757293168361
pytestmark = pytest.mark.skipif(not (shipped_drawings_dir() / f"{GN2}.json").is_file(),
                                reason="feed-twin's shipped drawings are not next to this checkout")


@pytest.fixture(scope="module")
def config():
    return load_config(str(FIXTURE))


@pytest.fixture(scope="module")
def drawing():
    return {d.name: d for d in DrawingStore(None).list()}[GN2]


@pytest.fixture(scope="module")
def burned(config, drawing):
    # No replay: the twin's engine is the card at the as-built throat, the same engine EngineDesign's
    # forward solve runs, so what is left between them is the feed.
    prep = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, tank_pressure_psia=STUDY_LOCKUP_PSIA, ack_gn2_condensation=True, replay=False))
    return run_prepared(prep, replay=False, config=config)


def _with(config, update):
    from engine.pipeline.config_schemas import PintleEngineConfig

    raw = config.model_dump()
    for side, u in update["feed_system"].items():
        raw["feed_system"][side].update(u)
    return PintleEngineConfig(**raw)


def test_the_design_misses_the_drawings_manifold(burned):
    fit = burned["feed_fit"]
    assert fit["available"]
    for side in ("oxidizer", "fuel"):
        s = fit["sides"][side]
        # 9.6-15 psi on the 6.5 kN and 6.8 kN designs: ~7-11 % of a ~135 psi injector drop.
        assert s["manifold_gap_psi"] < -7.0, (side, s["manifold_gap_psi"])
        assert s["supply_deficit_psi"] > 5.0  # the tank does not hold lockup while firing
        assert s["K_line"] > 0.0 and s["K_supply"] > 0.0
        assert s["K0"] == pytest.approx(s["K_line"] + s["K_supply"])
        # By construction the fitted K0 lands the design on the twin's mean manifold.
        assert s["manifold_fitted_psia"] == pytest.approx(s["manifold_psia"], abs=0.05)


def test_with_the_fit_enginedesign_lands_on_the_burn(burned, config):
    from engine.core.runner import PintleEngineRunner

    fit = burned["feed_fit"]
    lockup = fit["sides"]["oxidizer"]["lockup_psia"] * PSI

    def solve(cfg):
        return PintleEngineRunner(cfg).evaluate(lockup, lockup, silent=True)

    today, fitted = solve(config), solve(_with(config, fit["design_update"]))
    twin = {"mdot_O": fit["sides"]["oxidizer"]["mdot_kg_s"], "mdot_F": fit["sides"]["fuel"]["mdot_kg_s"]}
    twin_of = twin["mdot_O"] / twin["mdot_F"]
    for key in ("mdot_O", "mdot_F"):
        assert fitted[key] == pytest.approx(twin[key], rel=0.015), key
        # and the design as it stands is further off than the fit
        assert abs(today[key] / twin[key] - 1.0) > abs(fitted[key] / twin[key] - 1.0), key
    assert fitted["MR"] == pytest.approx(twin_of, rel=0.005)


def test_the_update_is_the_lumped_path_with_its_record(burned):
    upd = burned["feed_fit"]["design_update"]["feed_system"]
    for side in ("oxidizer", "fuel"):
        u = upd[side]
        assert u["roughness_m"] is None and u["fittings"] == [] and u["phi_type"] == "none" and u["K1"] == 0.0
        rec = u["derived_from"]
        assert rec["by"] == "Layer X feed fit" and rec["drawing"] == GN2 and len(rec["drawing_sha256"]) == 64
        assert rec["K_line"] + rec["K_supply"] == pytest.approx(u["K0"], abs=2e-4)
        assert rec["condition"] == "on the pad"


def test_writing_the_fit_does_not_move_layer_x(burned, config, drawing):
    """Layer X burns through the drawing's lines and samples EngineDesign with its feed zeroed, so
    the design's K0 is not in its burn: written in, the burn is the same burn."""
    upd = design_update(burned["feed_fit"], run_id="t")
    prep = prepare(_with(config, upd), None, drawing, LayerXSettings(drawing_id=drawing.id, tank_pressure_psia=STUDY_LOCKUP_PSIA, ack_gn2_condensation=True, replay=False))
    again = run_prepared(prep, replay=False)
    assert again["summary"]["total_impulse_Ns"] == pytest.approx(burned["summary"]["total_impulse_Ns"], rel=1e-9)
