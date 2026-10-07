"""LE4 with its ground support drawn: a Rocket page and a GSE page, joined at
paired disconnects (``fixtures/le4_rocket_and_gse.json``, the team's drawing of
2026-10-07).

Read page-blind, the cart was more vehicle: its fuel transfer tank took the
tanker load alongside the flight tank, its K-bottles started empty, its hand
vents were open for good, its dome-control line was plumbed into the press
manifold, and only the dome regulator had a knob. Each check here is one of
those, against what the stand does.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from feedtwin.pid import build_network, read_diagram

HERE = Path(__file__).resolve().parent
DRAWING = HERE / "fixtures" / "le4_rocket_and_gse.json"
STAR = HERE.parents[2]
ENGINE = STAR / "EngineDesign" / "configs" / "ethalox_6800N.yaml"
CEA = STAR / "EngineDesign" / "output" / "cache" / "cea_cache_LOX_Ethanol_3D.npz"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"


def _payload() -> Any:
    return json.loads(DRAWING.read_text())


def _ids() -> dict[str, str]:
    return {n["data"]["label"]: n["id"] for n in _payload()["nodes"]}


@pytest.fixture(scope="module")
def built() -> Any:
    return build_network(read_diagram(_payload(), name="LE4 (6)"))


def test_the_vehicle_is_what_is_joined_to_the_engine(built: Any) -> None:
    ids = _ids()
    assert built.vehicle is not None
    for label in ("COPV", "Eth-Tank", "LOX-Tank", "DPR_HP", "QD-FFB"):
        assert ids[label] in built.vehicle, label
    for label in ("Fuel Transfer Tank", "6K-GN2", "PR-1", "QD-FFA", "HPC_SOL"):
        assert ids[label] not in built.vehicle, label


def test_the_transfer_tank_supplies_the_flight_fuel_tank(built: Any) -> None:
    ids = _ids()
    assert built.supplies == {ids["Fuel Transfer Tank"]: frozenset({ids["Eth-Tank"]})}


def test_hand_vents_rest_shut_and_inline_hand_valves_open(built: Any) -> None:
    ids = _ids()
    for vent in ("FV-MAN", "FF-MAN-Vent", "DR-MV", "HP-Down-MAN"):
        assert ids[vent] in built.hand_valves
        assert built.rest[ids[vent]] == 0.0, vent
    assert built.rest[ids["FF-MAN-Output"]] == 1.0


def test_a_motorised_valve_is_a_commanded_valve(built: Any) -> None:
    ids = _ids()
    mov = ids["OF-MOT-Dump"]
    assert mov in built.network.branches
    assert built.actuators[mov] == "OF-MOT-Dump.command"
    assert mov not in built.hand_valves


def test_the_dome_line_loads_the_dome_and_carries_no_feed(built: Any) -> None:
    """DR-REG-G reaches DPR_HP's dome through DR-CTRL-G, the mated DR QDs and
    DR-CTRL-R. It is the loader, and nothing joins the dome line to the
    regulator's body."""
    ids = _ids()
    assert ids["DR-REG-G"] in built.dome_loaders
    assert built.dome_loaders[ids["DR-REG-G"]].signal == "DPR_HP.dome"
    body = {f"{ids['DPR_HP']}.in", f"{ids['DPR_HP']}.out"}
    dome_side = built.node_of.get(ids["DR-CTRL-R"])
    for branch in built.network.branches.values():
        if branch.id == ids["DPR_HP"]:
            continue
        ends = {branch.upstream, branch.downstream}
        assert not (ends & body and dome_side in ends), branch.id


def _model() -> Any:
    from feedtwin.session import assemble_model

    return assemble_model(read_diagram(_payload(), name="LE4 (6)"), diagram_id="le4")


def test_every_hand_loaded_regulator_gets_a_knob() -> None:
    from feedtwin.session.hookup import CHARGE, DOME, suggest

    ids = _ids()
    knobs = {k.id: k for k in suggest(_model(), 500.0, 4500.0).knobs}
    assert knobs[DOME].regulators == (ids["DR-REG-G"],)
    assert knobs[CHARGE].regulators == (ids["PR-1"],)
    assert knobs[CHARGE].label == "COPV fill (PR-1)"
    assert knobs[CHARGE].psig == 4500.0
    assert knobs[ids["LP-PR"]].regulators == (ids["LP-PR"],)


@pytest.mark.skipif(not TABLES.is_dir(), reason="no state machine tables")
def test_the_gse_valves_bind_to_the_table() -> None:
    from feedtwin.session import load_machine
    from feedtwin.session.hookup import binding

    ids = _ids()
    bound = binding(_model(), load_machine(tables=TABLES), None).to_symbol
    assert bound["Fuel Vent"] == ids["FV-SOL"]
    assert bound["Fuel Fill Vent"] == ids["FF-SOL-Vent"]
    assert bound["GSE High Press Control"] == ids["HPC_SOL"]
    assert bound["LOX Dump"] == ids["OF-MOT-Dump"]
    # The OV disconnects are not paired on this drawing, so the cart's LOX vent
    # goes nowhere; the tank-top half is still the vent that works.
    assert bound["LOX Vent"] == ids["QD-OV-B"]
    assert ids["FF-MAN-Output"] not in bound.values(), "hand valves are the crew's"


@pytest.mark.skipif(
    not (ENGINE.exists() and CEA.exists() and TABLES.is_dir()),
    reason="engine, CEA table or state machine tables absent",
)
def test_the_pad_charges_the_copv_and_loads_fuel_through_the_drawing() -> None:
    """GN2 High Press charges the COPV through PR-1 at the COPV fill knob; Fuel
    Fill presses the transfer tank to its drawn 150 psig and pushes fuel across
    the QD pair until the flight tank holds its load. Nothing moves before, no
    propellant appears from nowhere, and the stand keeps its mass."""
    import yaml

    from feedtwin.engine.importer import engine_from_config
    from feedtwin.session import assemble_model, load_machine
    from feedtwin.session.burn import open_session
    from feedtwin.session.gauge import psig
    from feedtwin.session.hookup import suggest

    ids = _ids()
    design = engine_from_config(yaml.safe_load(ENGINE.read_text()), name="6800N")
    model = assemble_model(
        read_diagram(_payload(), name="LE4 (6)"),
        diagram_id="le4",
        engine=design,
        cea_cache=str(CEA),
    )
    session = open_session(
        model, load_machine(tables=TABLES), hookup=suggest(model, 500.0, 4000.0)
    )
    session.setup = replace(session.setup, copv_target_psi=4000.0)
    fuel, cart = (
        session.tanks[ids["Eth-Tank"]],
        session.tanks[ids["Fuel Transfer Tank"]],
    )
    copv = session.bottles[ids["COPV"]]
    start_cart = cart.state.liquid_mass
    assert start_cart > 10.0 and fuel.state.liquid_mass == 0.0

    session.state = "GN2 High Press"
    for _ in range(40):
        session.step(0.5)
    assert psig(copv.pressure) == pytest.approx(4000.0, abs=40.0)
    assert fuel.state.liquid_mass == 0.0, "nothing moves before Fuel Fill"

    session.state = "Fuel Fill"
    for _ in range(80):
        session.step(0.5)
    load = fuel.state.liquid_mass
    assert load == pytest.approx(fuel._wanted(), rel=0.02)
    # Less a little ethanol that evaporates into the vented ullage; the strict
    # check is the balance below.
    assert start_cart - cart.state.liquid_mass == pytest.approx(load, abs=5e-3)
    assert psig(cart.pressure) == pytest.approx(150.0, abs=2.0)
    last = session.solver_log[-1]
    assert abs(last.mass_error_kg - last.guard_kg) < 1e-3
