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


def test_every_hand_valve_rests_shut(built: Any) -> None:
    """Vents, bleeds and inline isolation alike: shut until a hand opens it."""
    ids = _ids()
    for valve in ("FV-MAN", "FF-MAN-Vent", "DR-MV", "HP-Down-MAN", "FF-MAN-Output"):
        assert ids[valve] in built.hand_valves
        assert built.rest[ids[valve]] == 0.0, valve


def test_a_hand_valve_drawn_normally_open_rests_open() -> None:
    payload = _payload()
    for node in payload["nodes"]:
        if node["data"]["label"] == "FF-MAN-Output":
            node["data"].setdefault("options", {})["normalPosition"] = "open"
    built = build_network(read_diagram(payload, name="LE4 (6)"))
    assert built.rest[_ids()["FF-MAN-Output"]] == 1.0


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


# ----------------------------------------------------------------- the dome line


def _session(payload: Any | None = None) -> Any:
    from feedtwin.session import assemble_model, load_machine
    from feedtwin.session.burn import open_session
    from feedtwin.session.hookup import suggest

    model = assemble_model(
        read_diagram(payload or _payload(), name="LE4 (6)"), diagram_id="le4"
    )
    return open_session(
        model, load_machine(tables=TABLES), hookup=suggest(model, 500.0, 4500.0)
    )


def test_the_dome_line_is_gated_by_its_valves(built: Any) -> None:
    ids = _ids()
    line = built.dome_lines[ids["DPR_HP"]]
    assert line.loader == ids["DR-REG-G"]
    assert line.valves == frozenset(
        ids[v] for v in ("DR-CTRL-G", "DR-CTRL-R", "DR-MV", "DR-Vent")
    )
    assert line.vents == frozenset({ids["DR-MV"], ids["DR-Vent"]})
    assert built.valve_roles[ids["DR-CTRL-G"]] == frozenset(
        {"gse", "med", "press", "control"}
    )


@pytest.mark.skipif(not TABLES.is_dir(), reason="no state machine tables")
def test_the_dome_loads_on_the_pad_and_holds_when_its_valve_shuts() -> None:
    """Unloaded, the 1092 holds its 50 psi spring bias less its supply effect --
    with the COPV charged, less than nothing, so the tank does not press. GN2 Low Press
    opens DR-CTRL-G ("GSE Med Press Control") and the dome follows DR-REG-G; the
    next state shuts it and the dome keeps what is in it, as the stand keeps it
    through the burn with the GSE disconnected. The dome PT reads it."""
    from feedtwin.session.gauge import psig

    ids = _ids()
    session = _session()
    assert session.binding.to_symbol["GSE Med Press Control"] == ids["DR-CTRL-G"]
    session.state = "GN2 High Press"
    for _ in range(40):
        session.step(0.5)
    session.state = "Fuel Press"
    for _ in range(20):
        session.step(0.5)
    fuel = session.tanks[ids["Eth-Tank"]]
    copv = session.bottles[ids["COPV"]]
    # dome + bias - S x inlet, S 14.7 psi per 1000 on the drawing (zero inlet).
    supply = 14.7e-3 * psig(copv.pressure)
    assert supply > 50.0, "a charged COPV outweighs the spring bias"
    assert psig(fuel.pressure) == pytest.approx(0.0, abs=2.0), "unloaded: shut"

    session.state = "GN2 Low Press"
    for _ in range(4):
        session.step(0.5)
    session.state = "Fuel Press"
    for _ in range(30):
        session.step(0.5)
    lockup = 500.0 + 50.0 - 14.7e-3 * psig(copv.pressure)
    assert psig(fuel.pressure) == pytest.approx(
        lockup, abs=8.0
    ), "dome + bias - S x COPV"
    dome_pt = next(i for i in session.model.built.instruments if i.id == ids["DP-PT-R"])
    assert psig(session.history[-1].pressures[dome_pt.node]) == pytest.approx(500.0)
    assert ids["DR-CTRL-G"] not in session.forced
    assert psig(session._dome_held[ids["DPR_HP"]]) == pytest.approx(500.0)


# ------------------------------------------------------- the dewar is a supply


def _with_lox_fill_drawn() -> Any:
    """LE4 (6) with its LOX fill line finished, as ADR 0006 asks of the drawing:
    the fill valve's junction to the fill manifold, the manifold to OF-QDA, and
    the LOX vent disconnects paired."""
    payload = _payload()

    def line(i: str, s: str, sh: str, t: str, th: str) -> dict[str, Any]:
        return {
            "id": i,
            "source": s,
            "sourceHandle": sh,
            "target": t,
            "targetHandle": th,
            "type": "smoothstep",
            "data": {},
        }

    ids = _ids()
    payload["edges"] += [
        line("fix-1", "junc_85", "r", "junc_86", "r"),
        line("fix-2", ids["OF-Manifold"], "in", ids["OF-QDA"], "r"),
    ]
    for node in payload["nodes"]:
        if node["data"]["label"] == "OV-QD-A":
            node["data"].setdefault("options", {})["pairedWith"] = ids["QD-OV-B"]
    return payload


def test_a_liquid_dewar_is_a_supply_tank() -> None:
    built = build_network(read_diagram(_with_lox_fill_drawn(), name="LE4 (6)"))
    ids = _ids()
    assert ids["LOX-DW-350 PSI"] in built.tanks
    assert built.supplies[ids["LOX-DW-350 PSI"]] == frozenset({ids["LOX-Tank"]})


@pytest.mark.skipif(not TABLES.is_dir(), reason="no state machine tables")
def test_ox_fill_loads_the_flight_lox_tank_from_the_dewar() -> None:
    from feedtwin.session.gauge import psig

    ids = _ids()
    session = _session(_with_lox_fill_drawn())
    dewar, lox = session.tanks[ids["LOX-DW-350 PSI"]], session.tanks[ids["LOX-Tank"]]
    assert psig(dewar.pressure) == pytest.approx(50.0, abs=0.5)
    start = dewar.state.liquid_mass
    session.state = "Ox Fill"
    for _ in range(40):
        session.step(0.5)
    assert lox.state.liquid_mass == pytest.approx(lox._wanted(), rel=0.03)
    assert start - dewar.state.liquid_mass >= lox.state.liquid_mass
    session.state = "Armed"
    for _ in range(40):
        session.step(0.5)
    assert psig(dewar.pressure) == pytest.approx(50.0, abs=5.0), "its own circuit"
    last = session.solver_log[-1]
    assert abs(last.mass_error_kg - last.guard_kg) < 1e-3


# ------------------------------------------------------------ the cart rests


def _fired(rests: bool) -> Any:
    """LE4 (6) at T-0 with the engine on, then 0.3 s into Fire."""
    import yaml

    from feedtwin.engine.importer import engine_from_config
    from feedtwin.session import assemble_model, load_machine
    from feedtwin.session.burn import jump_to_t0, open_session
    from feedtwin.session.hookup import suggest

    design = engine_from_config(yaml.safe_load(ENGINE.read_text()), name="6800N")
    model = assemble_model(
        read_diagram(_payload(), name="LE4 (6)"),
        diagram_id="le4",
        engine=design,
        cea_cache=str(CEA),
    )
    session = open_session(
        model, load_machine(tables=TABLES), hookup=suggest(model, 500.0, 4500.0)
    )
    session.setup = replace(session.setup, ground_rests=rests)
    jump_to_t0(session, copv_psi=4500.0, fill_fraction=0.95)
    session.command_state("Fire")
    most = 0.0
    for _ in range(15):  # the first 0.3 s, a study step at a time
        session.step(0.02)
        most = max(most, session.solver_log[-1].couplings)
    return session, most


@pytest.mark.skipif(
    not (ENGINE.exists() and CEA.exists() and TABLES.is_dir()),
    reason="engine, CEA table or state machine tables absent",
)
def test_while_the_engine_burns_the_cart_rests_and_the_burn_is_the_same() -> None:
    """Fire on LE4 (6) with the cart drawn: every cart vessel is cut off from the
    vehicle by shut valves, so none is integrated and its lines leave the solve,
    and the burn is the one the whole stand integrated every step gives."""
    ids = _ids()
    rested, _ = _fired(True)
    worked, _ = _fired(False)
    cart = {
        ids[label]
        for label in ("Fuel Transfer Tank", "LOX-DW-350 PSI", "6K-GN2")
        if ids[label] in rested.tanks or ids[label] in rested.bottles
    }
    branches, vessels = rested._resting
    assert cart and cart <= vessels
    assert branches, "the cart's lines are out of the solve"
    assert not vessels & set(rested.vehicle_tanks)
    held = {k: rested.tanks[k].state for k in vessels if k in rested.tanks}
    rested.step(0.1)
    for k, state in held.items():
        assert rested.tanks[k].state is state, "a resting vessel is not integrated"
    worked.step(0.1)
    for a, b in zip(rested.history, worked.history):
        assert a.chamber is not None and b.chamber is not None
        assert a.chamber.thrust == pytest.approx(b.chamber.thrust, rel=1e-9, abs=1e-6)


@pytest.mark.skipif(
    not (ENGINE.exists() and CEA.exists() and TABLES.is_dir()),
    reason="engine, CEA table or state machine tables absent",
)
def test_ignition_is_not_stepped_on_a_capped_port() -> None:
    """The fuel tank's top QD hangs a wide fitting off its ullage that ends at a
    cap. It carries nothing, so it is no press path: priced as one at the drain
    flow, it asked the first steps of Fire for 0.07 ms couplings -- 64 in a 20 ms
    step here, ~300 on the cockpit's first tick, most of a second before the
    first frame of the burn."""
    session, most = _fired(True)
    assert session.history[-1].chamber.thrust > 5000.0
    assert most < 20, f"{most} coupling steps in one 20 ms step"


@pytest.mark.skipif(
    not (ENGINE.exists() and CEA.exists() and TABLES.is_dir()),
    reason="engine, CEA table or state machine tables absent",
)
def test_t0_loads_the_fire_load_not_the_tank() -> None:
    """The vehicle carries what the competition allows (the engine config's
    lox_tank.mass and fuel_tank.mass), not 95 % of the tanks drawn: LE4 (6)
    draws both at 8.19 L, a third more LOX than a fire is loaded with."""
    import yaml

    from feedtwin.engine.importer import engine_from_config
    from feedtwin.session import assemble_model, load_machine
    from feedtwin.session.burn import jump_to_t0, open_session
    from feedtwin.session.hookup import suggest

    config = yaml.safe_load(ENGINE.read_text())
    design = engine_from_config(config, name="6800N")
    assert design.fire_load == {
        "lox": pytest.approx(config["lox_tank"]["mass"]),
        "fuel": pytest.approx(config["fuel_tank"]["mass"]),
    }
    model = assemble_model(
        read_diagram(_payload(), name="LE4 (6)"),
        diagram_id="le4",
        engine=design,
        cea_cache=str(CEA),
    )
    session = open_session(
        model, load_machine(tables=TABLES), hookup=suggest(model, 500.0, 4500.0)
    )
    jump_to_t0(session, copv_psi=4500.0, fill_fraction=0.95)
    ids = _ids()
    lox, fuel = session.tanks[ids["LOX-Tank"]], session.tanks[ids["Eth-Tank"]]
    assert lox.state.liquid_mass == pytest.approx(config["lox_tank"]["mass"])
    assert fuel.state.liquid_mass == pytest.approx(config["fuel_tank"]["mass"])
    # A pad load stops there too (the session hands it over each tick).
    session.step(0.02)
    assert lox._wanted() == pytest.approx(config["lox_tank"]["mass"])
