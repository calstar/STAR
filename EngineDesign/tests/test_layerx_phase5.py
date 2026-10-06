"""Layer X phase 5: measured inputs, and which unmeasured ones move the burn.

* An override writes a stated number into the drawing before the twin reads it, with its
  provenance, so the twin's own assembly report counts it as measured.
* The uncertainty sweep varies each unmeasured input on its own. Checked against what each
  input can and cannot do, not against a stored answer:
  * nozzle efficiency changes thrust and nothing upstream of the nozzle;
  * a lower mixing E_m costs impulse;
  * a larger LOX Cd flows faster and burns out no later;
  * a measured input's stated uncertainty replaces the default range.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest


pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx import DrawingStore, LayerXSettings, prepare  # noqa: E402
from engine.layerx.measurements import MeasurementStore, Override, apply_overrides, parameter_table  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "ethalox_6500N_doublet_cad_2026-09-28.yaml"
GN2 = "copv_study_gn2"
# The GN2 drawing is a nitrogen-over-LOX hot fire, refused since 2026-10-03 unless acknowledged
# (engine/layerx/prepare.py gn2_on_lox); these tests study its burn, so their settings acknowledge it.
pytestmark = [
    pytest.mark.skipif(not (shipped_drawings_dir() / f"{GN2}.json").is_file(),
                       reason="feed-twin's shipped drawings are not next to this checkout"),
    # The sweep fixture runs every factor of the uncertainty study on four spawned
    # workers, each importing and JIT-compiling the engine cold: 32 s on a laptop with
    # warm caches, past CI's 120 s per-test guard on its runners -- and the guard's
    # thread method ends the whole run, not just this test. pytest-timeout honours
    # this; without the plugin it is an unknown mark and only warns.
    pytest.mark.timeout(600),
]


@pytest.fixture(scope="module")
def config():
    return load_config(str(FIXTURE))


@pytest.fixture(scope="module")
def drawing():
    return {d.name: d for d in DrawingStore(None).list()}[GN2]


def droop(value: float, uncertainty=None) -> Override:
    return Override(target="node:PR_D", parameter="flow_droop", value=value, unit="psi",
                    source="regulator flow test, GN2, 2026-10-05", uncertainty=uncertainty)


def test_an_override_lands_in_the_drawing_with_its_provenance(drawing):
    payload, applied, missing = apply_overrides(drawing.payload, [droop(6.0, 0.4)])
    assert not missing and applied[0]["was"]["value"] == 8.3
    node = next(n for n in payload["nodes"] if n["id"] == "PR_D")
    p = node["data"]["params"]["flow_droop"]
    assert p == {"value": 6.0, "unit": "psi", "source": "measured",
                 "reference": "regulator flow test, GN2, 2026-10-05; ±0.4 psi"}
    # The drawing itself is untouched.
    assert next(n for n in drawing.payload["nodes"] if n["id"] == "PR_D")["data"]["params"]["flow_droop"]["value"] == 8.3
    _, _, missing = apply_overrides(drawing.payload, [Override(target="node:NOPE", parameter="x", value=1, unit="",
                                                               source="s")])
    assert missing == ["node:NOPE.x"]


def test_a_restated_parameter_reaches_the_twin_as_measured(config, drawing):
    """The override is not a label: the regulator component the twin builds carries the
    restated value, with the measured provenance, and the burn plan is prepared from it."""
    from feedtwin.model.param import Provenance

    def droop_param(prep):
        built = prep.model.built
        branch = next(built.network.branches[b] for b in built.branches_of["PR_D"] if b in built.network.branches)
        return branch.component.instance.params["flow_droop"]

    base = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True))
    restated = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True), [droop(6.0, 0.4)])
    assert droop_param(base).value == pytest.approx(8.3)  # the stand's back-fit, on the drawing
    p = droop_param(restated)
    assert p.source is Provenance.MEASURED and p.value == pytest.approx(6.0)
    assert p.reference.startswith("regulator flow test, GN2, 2026-10-05")
    assert any(c.key == "overrides" for c in restated.checks)
    assert restated.derived["overrides"][0]["key"] == "node:PR_D.flow_droop"


def test_the_store_wants_a_source_and_one_value_per_parameter(tmp_path):
    with pytest.raises(ValueError, match="source"):
        Override.from_dict({"target": "node:PR_D", "parameter": "flow_droop", "value": 6, "unit": "psi", "source": " "})
    store = MeasurementStore(tmp_path)
    store.put("0123456789abcdef", [droop(6.0)])
    assert store.get("0123456789abcdef")[0].value == 6.0
    with pytest.raises(ValueError, match="same parameter"):
        store.put("0123456789abcdef", [droop(6.0), droop(7.0)])


def test_a_measured_uncertainty_replaces_the_default_range(config, drawing):
    from engine.layerx.uncertainty import factors

    prep = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True), [droop(8.3, 0.5)])
    found, _ = factors(prep, config)
    f = next(x for x in found if x.key == "node:PR_D.flow_droop")
    lo, hi = (c.overrides[0].value for c in f.cases)
    assert (lo, hi) == pytest.approx((7.8, 8.8))
    assert f.basis.startswith("measured")
    # Unrestated, the drawing's own word stands: its 8.3 psi droop says measured, with no ±, so it
    # is held exact and the note says how to sweep it. Its supply effect says estimated: swept.
    plain = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True))
    found, notes = factors(plain, config)
    assert not any(x.key == "node:PR_D.flow_droop" for x in found)
    assert any("marked measured on the drawing" in n and "droop" in n.lower() for n in notes)
    spe = next(x for x in found if x.key == "node:PR_D.supply_coefficient")
    assert [c.overrides[0].value for c in spe.cases] == pytest.approx([0.5 * spe.nominal, 1.5 * spe.nominal])


@pytest.fixture(scope="module")
def sweep(config, drawing):
    from engine.layerx.uncertainty import run_sweep

    return run_sweep(config, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True), [], workers=4)


def _case(sweep, key, side):
    f = next(x for x in sweep["factors"] if x["key"] == key)
    c = f["cases"][side]
    assert c["ok"], c.get("error")
    return c["delta"]


def test_the_sweep_runs_every_factor(sweep):
    keys = {f["key"] for f in sweep["factors"]}
    assert {"node:PR_D.supply_coefficient", "ullage_collapse", "engine.cd_O",
            "engine.cd_F", "engine.em", "engine.nozzle"} <= keys
    assert "node:PR_D.flow_droop" not in keys  # measured on the drawing, held exact
    assert sweep["band"]["total_impulse_Ns"] > 0
    # The drawing's own guesses, the switches it burns without, and the stand on the day are swept too.
    assert {"drawing.valve_cv", "drawing.line_k", "line_walls", "ullage_vapour", "op.lockup", "op.fill"} <= keys
    assert sweep["cases"] == 1 + sum(len(f["cases"]) for f in sweep["factors"])


def test_impulse_is_blind_to_the_feed_and_thrust_is_not(sweep):
    """A fixed load burnt dry gives the same impulse whatever the valves: the tornado ranked by
    impulse said "the top bar is the next measurement" while the feed was invisible to it."""
    lo = _case(sweep, "drawing.valve_cv", "low")
    assert abs(lo["mean_thrust_N"]) > 5 * abs(lo["total_impulse_Ns"]) / max(sweep["nominal"]["burn_time_s"], 1e-9)
    assert lo["mean_thrust_N"] < 0                      # half the valve Cv: less flow, less thrust


def test_the_band_is_told_each_way(sweep):
    """Mixing E_m costs far more impulse below than it adds above (0.70 vs 0.85 about 0.80):
    one symmetric ± overstated the upside."""
    lo, hi = sweep["band_low"]["total_impulse_Ns"], sweep["band_high"]["total_impulse_Ns"]
    assert lo > 0 and hi > 0 and lo != pytest.approx(hi, rel=0.05)
    assert isinstance(sweep["crossings"], list)


def test_nozzle_efficiency_moves_thrust_and_nothing_upstream(sweep):
    for side in ("low", "high"):
        d = _case(sweep, "engine.nozzle", side)
        assert d["burn_time_s"] == pytest.approx(0.0, abs=1e-9)
        assert abs(d["pc_mean_psia"]) < 0.05
        assert abs(d["total_impulse_Ns"]) > 100.0
    assert _case(sweep, "engine.nozzle", "low")["total_impulse_Ns"] < 0 < _case(sweep, "engine.nozzle", "high")["total_impulse_Ns"]


def test_worse_mixing_costs_impulse_and_more_cd_flows_faster(sweep):
    assert _case(sweep, "engine.em", "low")["total_impulse_Ns"] < 0
    assert _case(sweep, "engine.cd_O", "high")["burn_time_s"] <= 0
    assert _case(sweep, "engine.cd_O", "high")["of_mean"] > 0 > _case(sweep, "engine.cd_O", "low")["of_mean"]


def test_a_measured_engine_input_reaches_the_card(config):
    """The card samples the engine with the config's measurements applied, as the runner and the
    replay do. A measured LOX Cd 5 % above the model's has to show up as more LOX flow at the
    same line pressures; before this was fixed the card's fast path sampled the unmeasured
    config and the measurement reached the replay but not the card."""
    from engine.layerx.card import EngineSampler
    from engine.pipeline.config_schemas import MeasuredValue, MeasurementsConfig

    p = 578.0 * 6894.757293168361
    plain = EngineSampler(config, 94070.0)
    cd = plain.runner.evaluate(p, p, silent=True)["Cd_O"]
    measured = config.model_copy(deep=True)
    measured.measurements = MeasurementsConfig(cd_O=MeasuredValue(value=1.05 * cd, source="cold flow, water"))
    sampler = EngineSampler(measured, 94070.0)
    assert sampler.config.discharge["oxidizer"].Cd_inf == pytest.approx(1.05 * cd)
    a, b = plain(p, p), sampler(p, p)
    assert b["mdot_O"] > a["mdot_O"] * 1.02


def test_restatements_follow_the_drawing_through_an_edit(tmp_path, drawing):
    """Keyed by what the drawing is (its shipped file, its pid-designer document), not by its
    content: an edited drawing has a new id and keeps its restatements, and says which revision
    they were entered against. An old id-keyed file still reads."""
    import copy
    from dataclasses import replace

    store = MeasurementStore(tmp_path)
    store.put(drawing, [droop(6.0, 0.4)])
    edited = copy.deepcopy(drawing.payload)
    edited["nodes"][0].setdefault("data", {})["label"] = "renamed"
    revised = replace(drawing, payload=edited, id="fedcba9876543210", sha256="0" * 64)
    overrides, problems, revision = store.load(revised)
    assert [o.value for o in overrides] == [6.0] and not problems
    assert revision == drawing.sha256 != revised.sha256
    # Another drawing does not see them.
    other = replace(drawing, source="shipped:copv_study_he.json", id="1111111111111111")
    assert store.get(other) == []
    # The old key, the content id, still reads.
    legacy = MeasurementStore(tmp_path / "legacy")
    legacy.put("2222222222222222", [droop(7.0)])
    assert [o.value for o in legacy.get(replace(drawing, id="2222222222222222", source="upload"))] == [7.0]
    # A non-finite number is refused at the door.
    with pytest.raises(ValueError, match="finite"):
        Override.from_dict({"target": "node:PR_D", "parameter": "flow_droop", "value": float("nan"), "unit": "psi",
                            "source": "x"})
