"""The hookup over the API: suggest, save, survive a re-import, bind, turn, reset.

A person links an imported drawing's valves and regulators to the stand's
controls once. That has to hold when the drawing is saved again (a new artifact
by content), reach the stand that opens next, and be undone in one call.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import pytest

from fastapi.testclient import TestClient

from backend.library import LibraryError
from backend.main import _SESSIONS, HOOKUPS, _lineage, app, library

client = TestClient(app)
STAND = (
    Path(__file__).resolve().parents[1] / "backend" / "diagrams" / "ethalox_stand.json"
)


#: What these tests put in the shared test library, taken out again after each:
#: other tests open "the newest drawing", and a stand left here would become it.
UPLOADED: list[str] = []


def upload(payload: dict, name: str) -> str:
    response = client.post(
        "/api/library/diagrams",
        files={"file": (name, json.dumps(payload).encode(), "application/json")},
    )
    assert response.status_code == 200, response.text
    artifact = response.json()["artifact"]["id"]
    UPLOADED.append(artifact)
    return artifact


@pytest.fixture(autouse=True)
def tidy() -> Iterator[None]:
    yield
    for artifact in dict.fromkeys(UPLOADED):
        try:
            library.drop_record(HOOKUPS, _lineage(library.get(artifact)))
            library.remove(artifact)
        except LibraryError:
            pass
    UPLOADED.clear()


def test_a_hookup_is_suggested_saved_kept_across_versions_bound_and_reset() -> None:
    payload = json.loads(STAND.read_text())
    diagram = upload(payload, "hookup stand.json")
    first = client.get("/api/hookup", params={"diagram": diagram}).json()
    assert first["saved"] is False
    assert first["hookup"] == first["suggested"]
    assert any(k["id"] == "dome" for k in first["suggested"]["knobs"])
    assert first["lineage"] == "name:hookup stand"

    # Pin one actuator to a different valve, and move the control regulator off
    # the stand's dome knob onto a knob of its own.
    actuator, auto = sorted(first["bound"].items())[0]
    other = next(v["id"] for v in first["valves"] if v["id"] != auto)
    (control,) = [r["id"] for r in first["regulators"] if r["kind"] == "loader"]
    knobs = [
        {
            "id": "cart",
            "label": "Cart",
            "regulators": [control],
            "psig": 300,
            "low": 0,
            "high": 600,
        }
    ]
    body = {"valves": {actuator: other}, "knobs": knobs}
    saved = client.put("/api/hookup", params={"diagram": diagram}, json=body).json()
    assert saved["saved"] is True
    assert saved["bound"][actuator] == other and actuator in saved["by_user"]

    # Saved again by the browser as "(2)", with a node moved: a new artifact, same lineage.
    payload["nodes"][0]["position"] = {"x": 1234, "y": 5}
    again = upload(payload, "hookup stand (2).json")
    assert again != diagram
    kept = client.get("/api/hookup", params={"diagram": again}).json()
    assert kept["saved"] is True and kept["bound"][actuator] == other

    # The stand that opens next is bound and knobbed that way, and the knob turns it.
    sm = client.get("/api/statemachine", params={"diagram": again}).json()
    assert sm["bound"][actuator] == other
    opened = client.post(
        "/api/session", params={"diagram": again}, json={"state": "Idle"}
    ).json()
    assert [k["id"] for k in opened["knobs"]] == ["cart"]
    session = _SESSIONS[opened["id"]]
    (signal,) = [l.signal for l in session.model.built.dome_loaders.values()]
    low = session.signals()[signal]
    turned = client.post(
        f"/api/session/{opened['id']}/command",
        json={"knob": {"id": "cart", "value": 9999}},
    ).json()
    assert (
        next(k for k in turned["knobs"] if k["id"] == "cart")["psig"] == 600
    ), "clamped"
    assert (
        session.signals()[signal] > low + 250 * 6894.757
    ), "the dome followed the knob"
    # The stand's dome setting no longer reaches it: no knob of that name now.
    missing = client.post(
        f"/api/session/{opened['id']}/command",
        json={"knob": {"id": "dome", "value": 420}},
    )
    assert missing.status_code == 404

    reset = client.delete("/api/hookup", params={"diagram": again}).json()
    assert reset["saved"] is False and reset["bound"][actuator] == auto


def test_a_hookup_naming_what_the_drawing_lacks_is_refused() -> None:
    diagram = upload(json.loads(STAND.read_text()), "refuse stand.json")
    bad = {"valves": {}, "knobs": [{"id": "k", "label": "k", "regulators": ["NOPE"]}]}
    response = client.put("/api/hookup", params={"diagram": diagram}, json=bad)
    assert response.status_code == 422 and "NOPE" in response.text
    regs = client.get("/api/hookup", params={"diagram": diagram}).json()["regulators"]
    if regs:
        twice = {
            "valves": {},
            "knobs": [
                {"id": "a", "label": "a", "regulators": [regs[0]["id"]]},
                {"id": "b", "label": "b", "regulators": [regs[0]["id"]]},
            ],
        }
        response = client.put("/api/hookup", params={"diagram": diagram}, json=twice)
        assert response.status_code == 422 and "two knobs" in response.text


def test_a_saved_hookup_that_cannot_be_read_is_said_on_the_console() -> None:
    """It falls back to the suggestion, as a drawing never linked does -- and
    used to be indistinguishable from one: the stand ran on other wiring and
    nothing said so."""
    diagram = upload(json.loads(STAND.read_text()), "unreadable_hookup.json")
    library.put_record(
        HOOKUPS, _lineage(library.get(diagram)), {"hookup": {"schema": 999}}
    )
    opened = client.post("/api/session", params={"diagram": diagram}, json={})
    assert opened.status_code == 200, opened.text
    said = "saved hookup could not be read"
    assert any(said in n for n in opened.json()["notes"]), opened.json()["notes"]
    ticked = client.post(f"/api/session/{opened.json()['id']}/tick", json={"dt": 0.05})
    assert any(said in n for n in ticked.json()["notes"])
    assert (
        client.get("/api/hookup", params={"diagram": diagram}).json()["saved"] is False
    )


def test_aliases_are_saved_with_the_hookup_and_reach_a_running_stand() -> None:
    """A console name is kept with the drawing's hookup, comes back on the next
    stand, and a running stand takes a rename without reopening."""
    diagram = upload(json.loads(STAND.read_text()), "alias stand.json")
    first = client.get("/api/hookup", params={"diagram": diagram}).json()
    body = {**first["hookup"], "aliases": {"engine.pc": "Chamber pressure", "x": " "}}
    saved = client.put("/api/hookup", params={"diagram": diagram}, json=body).json()
    assert saved["hookup"]["aliases"] == {"engine.pc": "Chamber pressure"}

    opened = client.post("/api/session", params={"diagram": diagram}, json={}).json()
    assert opened["aliases"]["engine.pc"] == "Chamber pressure"
    # Saved from the panel, the hookup is wired: what is on the DAQ box goes
    # by its connector's name -- a main valve by the row that opens it.
    assert opened["aliases"]["MVO"] == "LOX Main"
    renamed = client.post(
        f"/api/session/{opened['id']}/command",
        json={"aliases": {"engine.pc": "Pc"}},
    ).json()
    assert renamed["aliases"]["engine.pc"] == "Pc"
    assert renamed["t"] >= opened["t"], "the same stand, not a new one"
    _SESSIONS.pop(opened["id"], None)
