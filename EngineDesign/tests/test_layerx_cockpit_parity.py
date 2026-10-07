"""Layer X and the feed-twin cockpit fire the same engine, and get the same burn.

On 2026-10-06 the two gave "entirely different thrust curves" on LE4: the cockpit 7,193 N at
O/F 1.92, Layer X 6,205 N at O/F 1.59. Their solver agreed to a newton given the same inputs;
the inputs had drifted apart:

* the cockpit fired a three-week-old copy of the design (a different plate and throat), +1,606 N;
* through feedtwin's simplified engine, not EngineDesign's: -5 % thrust, +11 % impulse;
* from the operator's T-0 (dome, bottle, a 95 % fill), not Layer X's: a different burn, rightly.

The cockpit now fires EngineDesign's engine card, built from the engine's own config by the
endpoint it calls (``engine.layerx.card.card_for_config_text``), sent as JSON and installed the
one way a card goes on an engine (``EngineCard.install``). This checks the contract that buys:
put at the same T-0, the cockpit's way of firing (command Fire, tick at the console's step,
total the burn from the session's samples) reproduces Layer X's burn. And that the check can
fail: the simplified engine, on the same path, does not.
"""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

import pytest

feedtwin = pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed (pip install -e ../lib/feedtwin)")

import yaml  # noqa: E402

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.layerx import DrawingStore, LayerXSettings, prepare  # noqa: E402
from engine.layerx.card import card_for_config_text  # noqa: E402
from engine.layerx.sources import cea_table_path, machines_dir, shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "ethalox_6500N_doublet_cad_2026-09-28.yaml"
GN2 = "copv_study_gn2"

pytestmark = pytest.mark.skipif(
    not (shipped_drawings_dir() / f"{GN2}.json").is_file(),
    reason="feed-twin's shipped drawings are not next to this checkout",
)

#: How close the cockpit has to land on Layer X. The two cards differ only in where they were
#: centred (each fits EngineDesign to ~0.1 %), and the cockpit steps at 20 ms against Layer X's
#: 50 ms. Measured on LE4 (3): thrust +0.02 %, O/F +0.04 %. The simplified engine is 5 % off.
AGREE = 3e-3


@pytest.fixture(scope="module")
def config():
    return load_config(str(FIXTURE))


@pytest.fixture(scope="module")
def prepared(config):
    drawing = {d.name: d for d in DrawingStore(None).list()}[GN2]
    prep = prepare(config, PintleEngineRunner(copy.deepcopy(config)), drawing,
                   LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, flight=False, replay=False))
    assert prep.ok, [(c.label, c.detail) for c in prep.checks if c.status == "fail"]
    return prep


def _totals(trace):
    from feedtwin.session.report import summarise

    firing = [i for i, f in enumerate(trace.firing) if f]
    ch = trace.chamber
    return summarise([trace.t[i] for i in firing], [ch["thrust_N"][i] for i in firing],
                     [ch["pressure_Pa"][i] for i in firing], [ch["mdot_oxidiser"][i] for i in firing],
                     [ch["mdot_fuel"][i] for i in firing], before=trace.t[firing[0] - 1])


@pytest.fixture(scope="module")
def layer_x(prepared):
    """Layer X's own pass: its model, its setup, its plan."""
    from feedtwin.session import load_machine
    from feedtwin.session.burn import open_session, run_burn

    session = open_session(prepared.assembler(), load_machine(tables=machines_dir()), setup=prepared.setup)
    return _totals(run_burn(session, prepared.plan))


def _cockpit(prepared, config, *, card: bool):
    """The cockpit's way: the engine from its YAML, the card as JSON off the wire, the cockpit's
    own Setup, put at Layer X's T-0, Fire commanded, ticked at the console's step."""
    from feedtwin.engine import EngineCard
    from feedtwin.engine.importer import engine_from_config
    from feedtwin.pid import read_diagram
    from feedtwin.session import Session, Setup, assemble_model, bind, load_machine
    from feedtwin.session.burn import find_probes, prime_at_t0
    from feedtwin.session.core import LIVE_STEP
    from feedtwin.session.report import burns

    text = yaml.safe_dump(config.model_dump(mode="json"), sort_keys=False)
    engine = engine_from_config(yaml.safe_load(text), name="engine")
    chamber = None
    if card:
        wire = json.loads(json.dumps(card_for_config_text(text)))
        engine, chamber = EngineCard.from_dict(wire["card"]).install(engine)
    cea = cea_table_path(config)
    model = assemble_model(read_diagram(prepared.drawing.payload, name=GN2), diagram_id=GN2, engine=engine,
                           chamber=chamber, cea_cache=str(cea) if cea else "")
    machine = load_machine(tables=machines_dir())
    labels = {n.id: n.label or n.id for n in model.diagram.nodes if n.id in model.built.actuators}
    session = Session(model, machine, bind(machine, labels, roles=model.built.valve_roles),
                      setup=replace(Setup(), dome_psi=prepared.setup.dome_psi, auto_vent=False))
    plan = prepared.plan
    assert prime_at_t0(session, plan)
    for _ in range(round(plan.lead_in_s / plan.dt)):
        session.step(plan.dt)
    session.command_state(plan.fire_state)
    while session.t < 30.0 and min(t.state.liquid_mass for t in session.tanks.values()) >= plan.dry_kg:
        session.step(LIVE_STEP)
    (burn,) = burns(list(session.history), find_probes(session).injector_inlet)
    return burn


def test_the_cockpit_firing_enginedesigns_card_is_layer_xs_burn(prepared, config, layer_x):
    cockpit = _cockpit(prepared, config, card=True)
    for name in ("thrust_mean_N", "pc_mean_Pa", "of_mean", "isp_s"):
        assert getattr(cockpit, name) == pytest.approx(getattr(layer_x, name), rel=AGREE), name
    # Layer X ends on the step that empties a tank; the cockpit on the tick after it.
    assert cockpit.duration_s == pytest.approx(layer_x.duration_s, abs=prepared.plan.dt + 0.02)


def test_and_the_simplified_engine_on_the_same_path_is_not(prepared, config, layer_x):
    """The check can fail: it is the card that makes the cockpit agree, not the path."""
    simplified = _cockpit(prepared, config, card=False)
    assert abs(simplified.thrust_mean_N / layer_x.thrust_mean_N - 1.0) > 0.02
    assert abs(simplified.isp_s / layer_x.isp_s - 1.0) > 0.05


def test_layer_x_totals_its_own_burn_as_the_report_does(prepared, layer_x):
    """Layer X keeps its own summary (engine/layerx/analysis.py); the totals in it are the same
    arithmetic as feedtwin.session.report's -- right-endpoint impulse, O/F and Isp from what was
    burned -- so a number quoted by either tool is the same number."""
    from engine.layerx import run_prepared

    s = run_prepared(prepared, replay=False)["summary"]
    assert s["total_impulse_Ns"] == pytest.approx(layer_x.impulse_Ns, rel=1e-6)
    assert s["mean_thrust_N"] == pytest.approx(layer_x.thrust_mean_N, rel=1e-6)
    # Layer X takes O/F and Isp from the tanks, the report from the chamber's flows: equal to the
    # propellant bookkeeping, which is conserved step by step.
    assert s["of_mean"] == pytest.approx(layer_x.of_mean, rel=1e-3)
    assert s["isp_mean_s"] == pytest.approx(layer_x.isp_s, rel=1e-3)
