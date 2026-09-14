"""The stand's state machine, read from the DAQ's own tables.

The properties worth holding are the ones whose failure is silent. A valve that
binds to the wrong symbol, a short CSV row that shifts every transition past the
gap, an abort path that quietly disappears -- none of those look wrong in a
result, and all three are one careless zip() away.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.statemachine import bind, load_machine


def test_the_shipped_machine_is_the_daq_table() -> None:
    machine = load_machine()
    assert "Fire" in machine.states
    assert "LOX Main" in machine.actuators
    # Fire opens the mains and the press valves and nothing else.
    assert machine.open_actuators("Fire") == frozenset(
        {"LOX Main", "Fuel Main", "LOX Press", "Fuel Press"}
    )


def test_ready_holds_everything_shut() -> None:
    assert load_machine().open_actuators("Ready") == frozenset()


# ----------------------------------------------------------------- binding


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("MV-OX", "LOX Main"),
        ("MVO", "LOX Main"),
        ("MV-FU", "Fuel Main"),
        ("SV-OX-VENT", "LOX Vent"),
        ("GN2 Vent", "GN2 Vent"),
    ],
)
def test_a_drawings_valve_names_bind_to_the_crews(label: str, expected: str) -> None:
    """MV means *main valve* on a P&ID. Treating the prefix as noise leaves the
    mains unbound, which is silent and is exactly what FIRE opens."""
    machine = load_machine()
    binding = bind(machine, {"V1": label})
    assert binding.to_symbol.get(expected) == "V1"


def test_a_fluid_disagreement_is_disqualifying() -> None:
    """ "LOX Vent" must never bind to a fuel valve just because both are vents."""
    machine = load_machine()
    binding = bind(machine, {"V1": "SV-FUEL-VENT"})
    assert binding.to_symbol.get("LOX Vent") is None
    assert binding.to_symbol.get("Fuel Vent") == "V1"


def test_one_symbol_is_claimed_once() -> None:
    machine = load_machine()
    binding = bind(machine, {"A": "MV-OX", "B": "MV-FU"})
    assert sorted(binding.to_symbol.values()) == ["A", "B"]


def test_binding_does_not_depend_on_dict_order() -> None:
    """A binding that changed between two runs of the same drawing would be the
    worst bug available here."""
    machine = load_machine()
    valves = {"MVO": "MV-OX", "MVF": "MV-FU", "V3": "SV-OX-VENT"}
    first = bind(machine, valves)
    second = bind(machine, dict(reversed(list(valves.items()))))
    assert first.to_symbol == second.to_symbol


def test_uncommanded_valves_are_listed() -> None:
    machine = load_machine()
    binding = bind(machine, {"MVO": "MV-OX", "PR": "PR-DOME"})
    assert "PR" in binding.uncommanded


# ------------------------------------------------------------- transitions


def test_idle_cannot_reach_fire_directly() -> None:
    machine = load_machine()
    assert not machine.can_go("Idle", "Fire")
    assert machine.can_go("Idle", "Armed")


def test_an_abort_is_reachable_from_anywhere() -> None:
    """A rule about stands, not an inference about this file. The failure is
    asymmetric: a spurious abort path costs a confused moment, a missing one
    costs an abort."""
    machine = load_machine()
    for source in machine.states:
        assert machine.can_go(source, "Emergency Abort"), source
        assert machine.can_go(source, "Engine Abort"), source


def test_a_ragged_row_is_read_as_the_daq_reads_it() -> None:
    """The DAQ's own transitions CSV has ten rows one cell short, and the DAQ's
    own parser reads them left-aligned: row[j] goes to headers[j-1] and the
    row simply never speaks about its last column. The twin reads them the
    same way, so a rehearsal on it meets the same open and shut doors as the
    stand -- and says so."""
    machine = load_machine()
    joined = " ".join(machine.warnings)
    assert "wrong number of columns" in joined
    assert "left-aligned" in joined
    assert "Armed" in machine.allowed, "a short row is read, not dropped"
    # Left-aligned, Armed's row says: Idle, Armed, Fuel Fill, Ox Fill, Press Standby.
    assert machine.can_go("Armed", "Ox Fill")
    assert machine.can_go("Armed", "Press Standby")
    assert not machine.can_go("Armed", "Fire")


def test_a_well_formed_table_constrains_normally(tmp_path: Path) -> None:
    actuators = tmp_path / "t_actuators.csv"
    actuators.write_text(",Idle,Fire\nLOX Main,CLOSE,OPEN\n", encoding="utf-8")
    transitions = tmp_path / "t_transitions.csv"
    transitions.write_text(",Idle,Fire\nIdle,1,0\nFire,1,1\n", encoding="utf-8")

    machine = load_machine(actuators=actuators, transitions=transitions)
    assert machine.warnings == ()
    assert not machine.can_go("Idle", "Fire")
    assert machine.can_go("Fire", "Idle")


def test_the_stands_own_ignition_bypass_is_reproduced_and_flagged() -> None:
    """Read left-aligned, seven press and vent rows put a 1 under Fire. That is
    what the stand enforces today, so the twin permits it -- an operator who
    finds the door shut here and open on the pad has been lied to -- and it
    shouts about every such path in its warnings so somebody fixes the CSV."""
    machine = load_machine()
    bypass = [
        s
        for s in machine.states
        if s not in ("Ready", "Calibrate", "Fire")
        and "Fire" in machine.allowed.get(s, ())
    ]
    # Press Standby's row was rewritten with 21 cells at the operator's
    # direction (NEEDS-REPAIR.md, "Twin-side edits"); the other six ragged
    # rows still carry the stand's bypass.
    assert "Press Standby" not in bypass
    assert "GN2 Low Press" in bypass
    for state in bypass:
        assert machine.can_go(state, "Fire")
        assert any(
            f"{state} -> Fire" in w for w in machine.warnings
        ), f"{state} -> Fire is permitted and nobody was told"


def test_a_state_with_no_row_at_all_still_fails_closed(tmp_path: Path) -> None:
    """Short rows are read; *absent* rows are not invented."""
    actuators = tmp_path / "t_actuators.csv"
    actuators.write_text(
        ",Idle,Armed,Fire\nLOX Main,CLOSE,CLOSE,OPEN\n", encoding="utf-8"
    )
    transitions = tmp_path / "t_transitions.csv"
    transitions.write_text(
        ",Idle,Armed,Fire\nIdle,1,1,0\nFire,1,0,1\n", encoding="utf-8"
    )
    machine = load_machine(actuators=actuators, transitions=transitions)
    assert "Armed" not in machine.allowed
    assert not machine.can_go("Armed", "Fire")
    assert not machine.can_go("Armed", "Idle")
    assert machine.can_go("Armed", "Fire") is False


def test_aborts_stay_reachable_from_every_state() -> None:
    """Whatever the table says, an abort is never refused."""
    machine = load_machine()
    aborts = [t for t in machine.states if t.endswith("Abort")]
    assert aborts
    for state in machine.states:
        for abort in aborts:
            assert machine.can_go(state, abort), f"{state} cannot abort to {abort}"


def test_idle_cannot_reach_fire_in_two_moves() -> None:
    """The specific sequence the fail-open behaviour allowed."""
    machine = load_machine()
    assert not machine.can_go("Idle", "Fire")
    for mid in machine.targets("Idle"):
        if mid.endswith("Abort"):
            continue
        assert not machine.can_go(
            mid, "Fire"
        ), f"Idle -> {mid} -> Fire is a two-move path to ignition"


def test_the_actuator_tables_impossible_positions_are_flagged() -> None:
    """Idle opens a main valve and a press solenoid; the aborts open both
    mains. The twin does as the table says and says so."""
    warnings = "\n".join(load_machine().warnings)
    assert "Idle commands Fuel Main, LOX Press OPEN" in warnings
    assert "Engine Abort commands Fuel Main, LOX Main OPEN" in warnings
    assert "Emergency Abort commands Fuel Main, LOX Main OPEN" in warnings


def test_idle_holds_everything_shut_whatever_the_table_says() -> None:
    """The de-energised state. The table's Idle column opens LOX Press and
    Fuel Main; read literally, a full bottle pressed the LOX tank to 550 psig
    before anybody armed anything."""
    machine = load_machine()
    assert machine.open_actuators("Idle") == frozenset()
    assert "Idle commands Fuel Main, LOX Press OPEN" in "\n".join(machine.warnings)


def test_a_helium_stand_names_its_pressurant_valves_he() -> None:
    """The table's "GN2 Vent" is the pressurant vent. On a drawing pressed
    with helium it is drawn "SV-HE-VENT", and it must still be commanded."""
    binding = bind(
        load_machine(),
        {"SVHV": "SV-HE-VENT", "SVOV": "SV-LOX-VENT", "SVFV": "SV-FU-VENT"},
    )
    assert binding.to_symbol["GN2 Vent"] == "SVHV"
    assert binding.to_symbol["LOX Vent"] == "SVOV"
    assert binding.to_symbol["Fuel Vent"] == "SVFV"


def test_the_operators_ignition_path_standby_ready_calibrate_fire_vent() -> None:
    """Press Standby -> Ready -> Calibrate -> Fire -> Vent, as the operator
    runs the stand (2026-09-11). Fire ends in Vent so the tanks dump."""
    machine = load_machine()
    assert machine.can_go("Press Standby", "Ready")
    assert machine.can_go("Ready", "Calibrate")
    assert machine.can_go("Calibrate", "Fire")
    assert machine.can_go("Fire", "Vent")
    assert not machine.can_go("Press Standby", "Fire")
