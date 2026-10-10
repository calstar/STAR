"""Pressing with helium or GN2 (``Setup.pressurant``) on the cockpit.

The team presses with helium for hot fire and nitrogen for water flows; a
stand of either drawing can be opened on the other gas to compare the two
(the Study tab's pressurant swap, on the console). Built in, so a change
opens a fresh stand; the setup says which gas the stand was built with.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import pytest

from fastapi.testclient import TestClient

from backend.library import LibraryError
from backend.main import _SESSIONS, app, library

DRAWING = (
    Path(__file__).resolve().parents[2]
    / "lib"
    / "feedtwin"
    / "tests"
    / "fixtures"
    / "le4_rocket_and_gse.json"
)
client = TestClient(app)
UPLOADED: list[str] = []
OPENED: list[str] = []


@pytest.fixture(autouse=True)
def tidy() -> Iterator[None]:
    yield
    for sid in OPENED:
        client.delete(f"/api/session/{sid}")
    OPENED.clear()
    for artifact in dict.fromkeys(UPLOADED):
        try:
            library.remove(artifact)
        except LibraryError:
            pass
    UPLOADED.clear()


def _upload() -> str:
    response = client.post(
        "/api/library/diagrams",
        files={
            "file": ("pressurant LE4.json", DRAWING.read_bytes(), "application/json")
        },
    )
    assert response.status_code == 200, response.text
    artifact: str = response.json()["artifact"]["id"]
    UPLOADED.append(artifact)
    return artifact


def _open(diagram: str, **body: object) -> dict:
    response = client.post(
        "/api/session", params={"diagram": diagram}, json={"state": "Idle", **body}
    )
    assert response.status_code == 200, response.text
    out: dict = response.json()
    OPENED.append(out["id"])
    return out


def _gases(sid: str) -> set[str]:
    """The fluids of every bottle the stand was built with."""
    model = _SESSIONS[sid].model
    return {n.fluid for n in model.diagram.nodes if n.type == "KBOTTLE"}


def test_the_choice_is_on_the_configuration_tab() -> None:
    rows = {t["key"]: t for t in client.get("/api/tunables").json()}
    row = rows["pressurant"]
    assert row["kind"] == "choice" and row["applies"] == "reset"
    assert row["default"] == ""
    assert [c["value"] for c in row["choices"]] == ["", "nitrogen", "helium"]


@pytest.mark.skipif(not DRAWING.exists(), reason="LE4 (6) fixture absent")
def test_a_stand_opens_on_helium_and_says_so() -> None:
    """LE4 (6) draws GN2. Opened on helium, every bottle holds helium and the
    setup says so; the default is the drawing's gas, exactly as before."""
    diagram = _upload()
    drawn = _open(diagram)
    assert drawn["setup"]["pressurant"] == ""
    assert _gases(drawn["id"]) == {"nitrogen"}
    helium = _open(diagram, pressurant="helium")
    assert helium["setup"]["pressurant"] == "helium"
    assert _gases(helium["id"]) == {"helium"}
    gn2 = _open(diagram, pressurant="nitrogen")
    assert _gases(gn2["id"]) == {"nitrogen"}


@pytest.mark.skipif(not DRAWING.exists(), reason="LE4 (6) fixture absent")
def test_a_running_stand_keeps_the_gas_it_was_built_with() -> None:
    """The gas is in the network: a command cannot change it on a running
    stand (the cockpit opens a fresh one), and the setup keeps saying what the
    stand holds."""
    diagram = _upload()
    stand = _open(diagram, pressurant="helium")
    out = client.post(
        f"/api/session/{stand['id']}/command",
        json={"setup": {"pressurant": "nitrogen"}},
    )
    assert out.status_code == 200, out.text
    assert out.json()["setup"]["pressurant"] == "helium"
    assert _gases(stand["id"]) == {"helium"}


def test_an_unknown_gas_is_ignored() -> None:
    from backend.tunables import parse_setup

    assert parse_setup({"pressurant": "argon"}).pressurant == ""
    assert parse_setup({"pressurant": "helium"}).pressurant == "helium"


@pytest.mark.skipif(not DRAWING.exists(), reason="LE4 (6) fixture absent")
def test_a_study_helium_case_is_helium_and_no_cold_flow() -> None:
    """A Study case's pressurant used to go through the cold-flow swap, which
    swaps tank contents only (the bottles kept their nitrogen) and fires the
    simplified engine. It is a gas swap now, and so is a replay of a run made
    on helium."""
    from backend.main import _session_from_inputs

    diagram = _upload()
    inputs = {"diagram": diagram, "setup": {}}
    case = _session_from_inputs(inputs, "helium")
    assert {n.fluid for n in case.model.diagram.nodes if n.type == "KBOTTLE"} == {
        "helium"
    }
    assert case.model.meta.get("why") != "cold flow"
    replay = _session_from_inputs({**inputs, "setup": {"pressurant": "helium"}})
    assert {n.fluid for n in replay.model.diagram.nodes if n.type == "KBOTTLE"} == {
        "helium"
    }
