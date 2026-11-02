"""Every assumed number is a Setup field with a row in ``backend/tunables.py``.

CLAUDE.md: a row is what puts the number on the Configuration tab and, through
``wire_setup``, in every run record's inputs -- a field without one changes a burn
where neither the operator nor the Explain ladder can see it.
"""

from __future__ import annotations

from dataclasses import fields, replace

from backend.session import Setup
from backend.tunables import TUNABLES, parse_setup, wire_setup

#: Setup fields that carry no row, each for a reason.
NO_ROW = {
    # Numerics, effectively off everywhere since the console took the Study's
    # numerics (docs/PHYSICS-BENCHMARK.md 3.10); nothing an operator dials.
    "tick_budget",
    # A per-tank map has no row; `cryogen_ullage_wall_T0_K` is its dial.
    "ullage_wall_T0_K",
}


def test_every_setup_field_has_a_row() -> None:
    rowless = {f.name for f in fields(Setup)} - {t.field for t in TUNABLES}
    assert rowless == NO_ROW


def test_the_cart_press_time_is_dialled_and_recorded() -> None:
    """``supply_press_s`` (how fast an undrawn cart press line brings a transfer
    tank to its drawn pressure) had no row: off the Configuration tab and out of
    the run record."""
    (row,) = [t for t in TUNABLES if t.field == "supply_press_s"]
    assert row.key in wire_setup(Setup())
    assert wire_setup(Setup())[row.key] == Setup().supply_press_s
    changed = parse_setup({row.key: 7.5}, Setup())
    assert changed == replace(Setup(), supply_press_s=7.5)
