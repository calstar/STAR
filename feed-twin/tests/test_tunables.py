"""The Configuration tab's rows: every assumed number has one, and each says
what the twin does with it.

CLAUDE.md: a row is what puts the number on the Configuration tab and, through
``wire_setup``, in every run record's inputs -- a field without one changes a burn
where neither the operator nor the Explain ladder can see it. A row's help is the
only place a person learns what a number does; one that says "this changes
nothing here" about a number the next T-0 reads, or names a dewar pressure the row
cannot show, is a wrong instrument label.
"""

from __future__ import annotations

from dataclasses import fields, replace
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import _SESSIONS, app, library
from backend.session import Setup
from backend.tunables import TUNABLES, describe, parse_setup, wire_setup

client = TestClient(app)

STAND = (
    Path(__file__).resolve().parents[1] / "backend" / "diagrams" / "ethalox_stand.json"
)


def _row(key: str) -> dict[str, object]:
    return next(r for r in describe() if r["key"] == key)


def test_the_lox_upper_wall_is_read_at_the_next_t0_and_says_so() -> None:
    """Its help said the console's walls follow the sequence 'and this changes
    nothing here; the Study tab ... does not read it', on a reset row. Both the
    console's Jump to T-0 and every Study case prime the wall at it, read from
    the setup as it is then: no Reset."""
    row = _row("cryogen_ullage_wall_T0_K")
    text = str(row["explains"])
    assert row["applies"] == "live", row["applies"]
    assert "changes nothing" not in text and "does not read it" not in text
    assert "Jump to T-0" in text and "Study" in text

    diagram = client.post(
        "/api/library/diagrams",
        files={"file": (STAND.name, STAND.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        sid = client.post("/api/session", params={"diagram": diagram}, json={}).json()[
            "id"
        ]
        set_live = client.post(
            f"/api/session/{sid}/command",
            json={"setup": {"cryogen_ullage_wall_T0_K": 150.0}},
        )
        assert set_live.status_code == 200, set_live.text
        assert client.post(f"/api/session/{sid}/t0", json={}).status_code == 200
        said = _SESSIONS[sid].assumptions
        assert any("upper wall at T-0: 150.0 K" in a for a in said), said
    finally:
        library.remove(diagram)


def test_the_chill_and_load_times_name_the_dewar_as_it_reads() -> None:
    """'Only with the dewar pressure at 0': the dewar row reads psia and
    bottoms out at 14.7 psia, vented (ADR 0007)."""
    for key in ("load_chill_s", "tank_fill_s"):
        text = str(_row(key)["explains"])
        assert "pressure at 0" not in text, key
        assert "vented (14.7 psia" in text, (key, text)
    assert _row("dewar_psi")["low"] == 0.0 and _row("dewar_psi")["gauge_wire"]


def test_the_bottle_wall_row_says_which_bottles_take_it() -> None:
    """It said only a drawing without its own wall used it, after 'the shipped
    COPV declares its own 3.5 kg' -- the uploaded LE4 (3) COPV declares none,
    and every Study case on it notes the 6.40 kg this row gives."""
    text = str(_row("bottle_wall_kg_per_L")["explains"])
    assert "wall_mass" in text and "LE4 (3)" in text, text


def test_the_cart_press_time_is_a_row() -> None:
    """Setup.supply_press_s is an assumed number (a press line nobody drew)
    with no row: CLAUDE.md, every assumed number is a Setup field with a row."""
    row = _row("supply_press_s")
    assert row["default"] == Setup().supply_press_s == 3.0
    assert row["unit"] == "s" and row["applies"] == "live"
    assert parse_setup({"supply_press_s": 10.0}).supply_press_s == 10.0
    low = next(t.low for t in TUNABLES if t.key == "supply_press_s")
    assert parse_setup({"supply_press_s": 0.0}).supply_press_s == low > 0.0

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
