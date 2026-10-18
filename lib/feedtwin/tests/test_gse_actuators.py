"""The GSE side of a bottle the drawing does not fill.

Its charge and dump are the state table's own actuators, `GSE High Press
Control` and `GSE High Press Vent`: the one place the session names an actuator
itself, because that side has no valve on the drawing for the hookup to bind.
Renamed or dropped from the CSV, the built-in charge and dump stopped without a
word; now the notes say which row is missing and what no state can do.
"""

from __future__ import annotations

from dataclasses import replace

from test_press_path_coupling import _helium_stand


def _without(session, *names):  # type: ignore[no-untyped-def]
    machine = session.machine
    kept = tuple(a for a in machine.actuators if a not in names)
    session.machine = replace(machine, actuators=kept)


def test_a_table_with_both_rows_says_nothing() -> None:
    session = _helium_stand()
    assert not any("no state can" in n for n in session._notes())


def test_a_table_that_cannot_charge_an_undrawn_bottle_says_so() -> None:
    session = _helium_stand()
    _without(session, "GSE High Press Control")
    (said,) = [n for n in session._notes() if "no state can" in n]
    assert "'GSE High Press Control'" in said and said.endswith("can charge it.")


def test_and_one_that_can_neither_charge_nor_dump_it_says_both() -> None:
    session = _helium_stand()
    _without(session, "GSE High Press Control", "GSE High Press Vent")
    (said,) = [n for n in session._notes() if "no state can" in n]
    assert "'GSE High Press Vent'" in said and said.endswith("charge or dump it.")
