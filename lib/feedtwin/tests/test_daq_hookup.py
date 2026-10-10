"""The DAQ box in the hookup, and the stand's own state table.

A hookup with ``channels`` is *wired*: each connector is one cable from one
board to one symbol, under the name the DAQ gives it, and the state table opens
names. So a row drives the valve on the connector of its name and nothing else
-- never a valve the twin's name matching would have picked behind the
person's back. A hookup without channels is the old kind and must read, write
and bind exactly as it did.

The state table can be edited (``StateMachine.to_dict`` / ``machine_from_dict``)
and has to come back as the CSV machine it was: the same states, rows, moves,
panel and aborts, Idle still held shut.

Each check is against what the old behaviour would have done instead, so it
fails if the new behaviour were not there.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from feedtwin.pid import read_diagram
from feedtwin.session import Session, assemble_model, bind, load_machine
from feedtwin.session.hookup import (
    Channel,
    Hookup,
    Knob,
    binding,
    on_vehicle,
    suggest,
)
from feedtwin.session.statemachine import StateMachine, machine_from_dict

HERE = Path(__file__).resolve().parent
STAR = HERE.parents[2]
STAND = STAR / "feed-twin" / "backend" / "diagrams" / "ethalox_stand.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"
LE4 = HERE / "fixtures" / "le4_rocket_and_gse.json"

needs_stand = pytest.mark.skipif(
    not (STAND.exists() and TABLES.is_dir()), reason="stand drawing or tables absent"
)
needs_tables = pytest.mark.skipif(not TABLES.is_dir(), reason="no state tables")

ABORTS = frozenset({"Engine Abort", "GSE Abort", "Emergency Abort"})


def _stand() -> Any:
    return assemble_model(
        read_diagram(json.loads(STAND.read_text()), name="s"), diagram_id="s"
    )


def _machine() -> StateMachine:
    return load_machine(tables=TABLES)


def _valve_labels(model: Any) -> dict[str, str]:
    """What :func:`binding` matches names against on a one-page drawing."""
    built = model.built
    return {
        n.id: n.label or n.id
        for n in model.diagram.nodes
        if n.id in built.actuators
        and not built.actuators[n.id].endswith(".dome")
        and n.id not in built.hand_valves
    }


# ----------------------------------------------------------- a wired hookup


@needs_stand
def test_a_wired_hookup_binds_exactly_its_connectors() -> None:
    """One valve connector, one row cabled to a transducer, one plain PT. Matched
    by name the stand binds eight rows; wired it binds the one."""
    model, machine = _stand(), _machine()
    by_name = binding(model, machine, None).to_symbol
    assert by_name["LOX Main"] == "MVO" and by_name["Fuel Main"] == "MVF"
    assert len(by_name) > 2, "the name match binds more than the box does"

    wired = Hookup(
        channels=(
            Channel("sol12", 1, "LOX Main", "MVO"),
            # A row's name on a transducer's connector: a PT is not a valve.
            Channel("pt_low", 1, "Fuel Main", "PT_FUU"),
            Channel("pt_high", 1, "Bottle", "PT_HI"),
        )
    )
    assert wired.wired
    b = binding(model, machine, wired)
    assert dict(b.to_symbol) == {"LOX Main": "MVO"}
    assert b.unmatched == tuple(a for a in machine.actuators if a != "LOX Main")
    assert "Fuel Main" in b.unmatched, "a PT on the row's connector drives nothing"
    assert b.by_role == ()

    none = binding(model, machine, Hookup(channels=()))
    assert dict(none.to_symbol) == {}
    assert none.unmatched == machine.actuators
    assert sorted(none.uncommanded) == sorted(_valve_labels(model))


@needs_stand
def test_a_session_on_a_wired_hookup_opens_only_the_wired_valve() -> None:
    """Fire opens both mains and both press valves by name; wired with only
    "LOX Main" on a connector it opens the LOX main and nothing else."""
    machine = _machine()
    hookup = Hookup(channels=(Channel("sol12", 1, "LOX Main", "MVO"),))

    def opened_in_fire(h: Hookup | None) -> set[str]:
        model = _stand()
        session = Session(model, machine, binding(model, machine, h), hookup=h)
        assert machine.can_go("Ready", "Fire")
        session.state = "Ready"
        session.command_state("Fire")
        signals = session.signals()
        built = model.built
        return {
            sid
            for sid, signal in built.actuators.items()
            if not signal.endswith(".dome") and signals[signal] > 0.5
        }

    session_binding = binding(_stand(), machine, hookup)
    assert session_binding.positions_for(machine, "Fire") == {"MVO": 1.0}
    by_name = opened_in_fire(None)
    assert {"MVO", "MVF"} <= by_name, "the name match opens both mains"
    assert opened_in_fire(hookup) == {"MVO"}


# ------------------------------------------------------- the old kind of hookup


@needs_stand
def test_a_hookup_without_a_box_is_written_and_bound_as_before() -> None:
    model, machine = _stand(), _machine()
    raw = {
        "schema": 1,
        "valves": {"Fuel Vent": "SV_GN2_VENT", "LOX Fill": ""},
        "knobs": [
            {
                "id": "dome",
                "label": "Dome",
                "regulators": ["PR1"],
                "psig": 450.0,
                "low": 0.0,
                "high": 1000.0,
            }
        ],
        "aliases": {"PT_HI": "Bottle"},
    }
    hookup = Hookup.from_dict(raw)
    assert not hookup.wired and hookup.channels is None and hookup.machine is None
    assert hookup.to_dict() == raw, "exactly the schema-1 dict, nothing added"
    assert list(hookup.to_dict()) == ["schema", "valves", "knobs", "aliases"]
    assert Hookup(knobs=(Knob("dome", "Dome"),)).to_dict()["schema"] == 1

    b = binding(model, machine, hookup)
    before = bind(
        machine,
        _valve_labels(model),
        roles=model.built.valve_roles,
        overrides=raw["valves"],
    )
    assert b == before, "the pins and the name match, as the old hookup bound"
    assert b.to_symbol["Fuel Vent"] == "SV_GN2_VENT" and "LOX Fill" in b.unmatched
    assert b.to_symbol["LOX Main"] == "MVO", "everything else matched by name"

    with pytest.raises(ValueError, match="schema"):
        Hookup.from_dict({**raw, "schema": 3})


@needs_stand
def test_a_wired_hookup_with_its_own_table_round_trips() -> None:
    model = _stand()
    table = _machine().to_dict()
    table["states"].append({"name": "Purge", "row": 6, "col": 0, "abort": False})
    table["open"]["Purge"] = ["Fuel Vent"]
    table["allowed"]["Idle"].append("Purge")
    table["allowed"]["Purge"] = ["Idle"]
    machine = machine_from_dict(table)
    hookup = Hookup(
        knobs=(Knob("dome", "Dome", (), 420.0),),
        aliases={"engine.pc": "Chamber pressure"},
        channels=(
            Channel("sol12", 1, "LOX Main", "MVO"),
            Channel("sol12", 2, "Fuel Vent", "SV_FUEL_VENT"),
            Channel("pt_low", 3, "Fuel tank", "PT_FUU"),
        ),
        rows={"sol12": 3, "pt_low": 2},
        machine=machine,
    )
    stored = hookup.to_dict()
    assert stored["schema"] == 2
    back = Hookup.from_dict(json.loads(json.dumps(stored)))
    assert back == hookup
    assert back.to_dict() == stored
    assert back.machine is not None and "Purge" in back.machine.states
    assert binding(model, back.machine, back) == binding(model, machine, hookup)
    assert dict(binding(model, machine, back).to_symbol) == {
        "LOX Main": "MVO",
        "Fuel Vent": "SV_FUEL_VENT",
    }


@pytest.mark.parametrize(
    "channels, said",
    [
        (
            [("sol12", 1, "LOX Main", "MVO"), ("sol12", 1, "Fuel Main", "MVF")],
            "two cables in one connector",
        ),
        (
            [("sol12", 1, "LOX Main", "MVO"), ("sol24", 1, "Spare", "MVO")],
            "one symbol on two connectors",
        ),
        (
            [("sol12", 1, "LOX Main", "MVO"), ("sol12", 2, "lox main", "MVF")],
            "two connectors are named",
        ),
        ([("sol12", 1, "  ", "MVO")], "no name"),
        ([("sol12", 0, "LOX Main", "MVO")], "numbered from 1"),
    ],
)
def test_a_box_that_cannot_be_is_refused(
    channels: list[tuple[str, int, str, str]], said: str
) -> None:
    raw = {
        "channels": [
            {"board": b, "slot": s, "name": n, "symbol": sym}
            for b, s, n, sym in channels
        ]
    }
    with pytest.raises(ValueError, match=said):
        Hookup.from_dict(raw)


def test_the_same_box_without_the_fault_is_accepted() -> None:
    """The refusals above are of the fault, not of the box."""
    ok = Hookup.from_dict(
        {
            "channels": [
                {"board": "sol12", "slot": 1, "name": "LOX Main", "symbol": "MVO"},
                {"board": "sol12", "slot": 2, "name": "Fuel Main", "symbol": "MVF"},
                {"board": "sol24", "slot": 1, "name": "Spare", "symbol": "SV"},
            ]
        }
    )
    assert ok.wired and len(ok.channels or ()) == 3


# ------------------------------------------------------------- the state table


@needs_tables
def test_an_edited_table_reads_back_as_the_csv_machine() -> None:
    csv = _machine()
    assert csv.table is not None
    edited = machine_from_dict(csv.to_dict())
    assert edited.states == csv.states
    assert edited.actuators == csv.actuators
    assert edited.positions == csv.positions
    assert edited.table == csv.table
    assert edited.allowed == csv.allowed
    assert edited.layout == csv.layout
    assert edited.aborts == csv.aborts
    for here in csv.states:
        assert edited.targets(here) == csv.targets(here), here

    # Idle as the table writes it (LOX Press and Fuel Main OPEN), held shut.
    written = csv.to_dict()["open"]["Idle"]
    assert set(written) == {"Fuel Main", "LOX Press"}
    assert csv.open_actuators("Idle") == frozenset()
    assert edited.open_actuators("Idle") == frozenset()
    assert edited.to_dict()["open"]["Idle"] == written, "the cells survive the hold"
    assert any("Idle commands" in w for w in edited.warnings)


@needs_tables
@pytest.mark.parametrize(
    "spoil, said",
    [
        (lambda t: t["states"].append(dict(t["states"][0])), "two states"),
        (lambda t: t["open"].__setitem__("Nowhere", []), "not a state"),
        (lambda t: t["allowed"].__setitem__("Nowhere", ["Idle"]), "not a state"),
        (lambda t: t["allowed"]["Idle"].append("Nowhere"), "not states"),
        (lambda t: t["open"]["Fire"].append("Spare Valve"), "no row"),
    ],
)
def test_a_table_that_contradicts_itself_is_refused(spoil: Any, said: str) -> None:
    table = _machine().to_dict()
    machine_from_dict(table)  # whole, it reads
    spoil(table)
    with pytest.raises(ValueError, match=said):
        machine_from_dict(table)


@needs_tables
def test_a_state_flagged_abort_is_reachable_and_the_name_no_longer_decides() -> None:
    table = _machine().to_dict()
    table["actuators"].append("Purge Valve")
    table["states"] += [
        {"name": "Purge", "row": None, "col": None, "abort": True},
        {"name": "Fake Abort", "row": None, "col": None, "abort": False},
    ]
    table["open"]["Purge"] = ["Purge Valve"]
    edited = machine_from_dict(table)
    assert edited.aborts == ABORTS | {"Purge"}
    for here in ("Idle", "Ready", "Fire", "Engine Abort"):
        assert edited.can_go(here, "Purge"), here
        assert not edited.can_go(here, "Fake Abort"), here
    assert "Fake Abort" not in edited.targets("Idle")

    table["allowed"]["Idle"].append("Fake Abort")
    allowed = machine_from_dict(table)
    assert allowed.can_go("Idle", "Fake Abort")
    assert not allowed.can_go("Ready", "Fake Abort")


@needs_tables
def test_without_flags_an_abort_is_whatever_says_abort(tmp_path: Path) -> None:
    """No ``<name>_states.csv``: the twin's old rule, by name."""
    for table in ("actuators", "transitions"):
        shutil.copy(TABLES / f"diablo_{table}.csv", tmp_path / f"diablo_{table}.csv")
    bare = load_machine(tables=tmp_path)
    assert bare.aborts is None and bare.layout == {}
    assert {s for s in bare.states if bare.is_abort(s)} == ABORTS
    # Idle -> Engine Abort is 0 in the transition table; abort is always open.
    assert "Engine Abort" not in bare.allowed["Idle"]
    assert bare.can_go("Idle", "Engine Abort")

    named = replace(
        bare,
        states=(*bare.states, "Fake Abort"),
        positions={**bare.positions, "Fake Abort": {}},
    )
    assert named.can_go("Idle", "Fake Abort"), "by name, with no flags"


@needs_tables
def test_the_shipped_panel_places_the_states_and_flags_the_aborts() -> None:
    machine = load_machine("diablo", tables=TABLES)
    assert machine.layout["Idle"] == (0, 0)
    assert machine.layout["Press Standby"] == (2, 0)
    assert machine.layout["Fire"] == (5, 0)
    assert machine.aborts == ABORTS
    assert {s for s in machine.states if "abort" in s.lower()} == ABORTS
    assert not ABORTS & set(machine.layout), "the aborts are the console's to place"
    assert set(machine.layout) == set(machine.states) - ABORTS


# ------------------------------------------------------- the rocket alone


def _le4(cut: bool) -> Any:
    return assemble_model(
        read_diagram(json.loads(LE4.read_text()), name="LE4 (6)"),
        diagram_id="le4",
        vehicle_only=cut,
    )


@needs_tables
@pytest.mark.skipif(not LE4.exists(), reason="LE4 (6) fixture absent")
def test_on_the_vehicle_the_box_keeps_the_rocket_and_frees_the_cut_rows() -> None:
    """The box cables Fuel Vent to the cart's FV-SOL and GSE High Press Control
    to HPC_SOL; the rocket alone has neither. Those rows go back to being
    matched (Fuel Vent finds the fuel tank's capped top disconnect); LOX Main
    keeps its connector; LOX Vent, which the name match would bind to the LOX
    tank's disconnect, has no connector and stays unbound."""
    ids = {n["data"]["label"]: n["id"] for n in json.loads(LE4.read_text())["nodes"]}
    whole, cut = _le4(False), _le4(True)
    machine = _machine()
    saved = Hookup(
        channels=(
            Channel("sol12", 1, "LOX Main", ids["OM-R"]),
            Channel("sol12", 2, "Fuel Vent", ids["FV-SOL"]),
            Channel("sol24", 3, "GSE High Press Control", ids["HPC_SOL"]),
            Channel("pt_low", 1, "Fuel tank", ids["FU-PT-R"]),
        ),
        rows={"sol12": 2},
    )
    assert dict(binding(whole, machine, saved).to_symbol) == {
        "LOX Main": ids["OM-R"],
        "Fuel Vent": ids["FV-SOL"],
        "GSE High Press Control": ids["HPC_SOL"],
    }

    rocket = on_vehicle(saved, cut)
    assert rocket.channels == (
        Channel("sol12", 1, "LOX Main", ids["OM-R"]),
        Channel("pt_low", 1, "Fuel tank", ids["FU-PT-R"]),
    )
    assert rocket.auto == {"Fuel Vent", "GSE High Press Control"}
    assert rocket.rows == saved.rows and rocket.wired

    b = binding(cut, machine, rocket)
    assert dict(b.to_symbol) == {
        "LOX Main": ids["OM-R"],
        "Fuel Vent": ids["FV-QD-B"],
    }
    assert "LOX Vent" in b.unmatched and "GSE High Press Control" in b.unmatched
    by_name = binding(cut, machine, on_vehicle(suggest(whole), cut)).to_symbol
    assert by_name["LOX Vent"] == ids["QD-OV-B"], "the name match would bind it"
    assert by_name["Fuel Vent"] == ids["FV-QD-B"]


@needs_stand
def test_a_connector_joins_its_row_as_a_person_reads_the_name() -> None:
    """ "Lox Main" on the box is the table's "LOX Main": typed the way a
    person types it, the main valve must still open in Fire. Read exactly,
    it bound nothing and the main was never commanded."""
    model, machine = _stand(), _machine()
    wired = Hookup(channels=(Channel("sol12", 1, "Lox Main", "MVO"),))
    assert dict(binding(model, machine, wired).to_symbol) == {"LOX Main": "MVO"}


@needs_tables
@pytest.mark.parametrize("written", ["0", "false", "no", "", 0, None, False])
def test_an_abort_flag_written_as_no_is_no(written: Any) -> None:
    """An abort is reachable from anywhere, so a flag read loosely is an
    unguarded path: "0" read as a yes made Fire an abort, and Idle -> Fire
    legal."""
    raw = _machine().to_dict()
    for state in raw["states"]:
        if state["name"] == "Fire":
            state["abort"] = written
    table = machine_from_dict(raw)
    assert not table.is_abort("Fire")
    assert not table.can_go("Idle", "Fire")


@needs_tables
def test_two_rows_one_name_apart_from_case_are_refused() -> None:
    raw = _machine().to_dict()
    raw["actuators"] = [*raw["actuators"], "lox main"]
    with pytest.raises(ValueError):
        machine_from_dict(raw)
