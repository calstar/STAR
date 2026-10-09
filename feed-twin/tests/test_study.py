"""The Study tab's study: the stand the cockpit has open, burned once per case.

What it must never do again is burn a stand of its own. The study used to fly
two fixed drawings at a fixed 550 psig off a fixed 4,500 psig bottle whatever
the cockpit was set to, so a COPV target or a dome knob changed on the stand
changed nothing in the study. Here a case starts from the session's own
settings, and a blank case is the stand as set.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from backend.main import app, library
from backend.study import StudyCase, case_inputs, describe

client = TestClient(app)

STAND = (
    Path(__file__).resolve().parents[1] / "backend" / "diagrams" / "ethalox_stand.json"
)
ENGINE_CONFIG = (
    Path(__file__).resolve().parents[2]
    / "EngineDesign"
    / "configs"
    / "ethalox_doublet_7000N.yaml"
)

BASE: dict[str, Any] = {
    "diagram": "d",
    "engine": "e",
    "setup": {"copv_target": 4500.0, "dome": 500.0, "full_fraction": 0.95},
    "knobs": {"aux": 300.0},
}


# --------------------------------------------------------------- a case's inputs


def test_a_blank_case_is_the_stand_as_set() -> None:
    inputs = case_inputs(BASE, StudyCase(label="as set"))
    assert inputs["setup"] == BASE["setup"]
    assert inputs["knobs"] == BASE["knobs"]
    assert describe(BASE, StudyCase(label="as set")) == ["the stand as set"]


def test_a_case_changes_only_what_it_says() -> None:
    case = StudyCase(
        label="c",
        copv_psi=3000.0,
        knobs={"dome": 450.0, "aux": 250.0},
        fill_fraction=0.8,
        setup={"line_walls": False},
    )
    inputs = case_inputs(BASE, case)
    # The charge is the bottle at T-0 and the datum the regulators are set at.
    assert inputs["setup"]["copv_target"] == 3000.0
    # The dome knob is the Configuration's dome, as on the GSE page.
    assert inputs["setup"]["dome"] == 450.0
    assert inputs["knobs"] == {"aux": 250.0}
    assert inputs["setup"]["full_fraction"] == 0.8
    assert inputs["setup"]["line_walls"] is False
    assert BASE["setup"]["copv_target"] == 4500.0, "the stand is not touched"
    assert describe(BASE, case) == [
        "COPV 3000 psig",
        "dome 450 psig",
        "aux 250 psig",
        "fill 80 %",
        "line_walls = False",
    ]


@pytest.mark.parametrize(
    "raw, message",
    [
        ({"pressurant": "argon"}, "pressurant"),
        ({"copv_psi": -5}, "COPV"),
        ({"bottle_litres": 0}, "bottle"),
        ({"fill_fraction": 1.5}, "fill"),
        ({"copv_psi": "lots"}, "convert"),
    ],
)
def test_a_bad_case_is_refused_with_what_is_wrong(
    raw: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        StudyCase.parse({"label": "x", **raw}, 0)


# ------------------------------------------------------------------- the API


def _engine() -> str:
    found = next((a for a in library.list("engine") if a.source == "shipped"), None)
    if found is None:
        if not ENGINE_CONFIG.is_file():
            pytest.skip("no engine to fire")
        found, _ = library.add(
            ENGINE_CONFIG.read_bytes(),
            kind="engine",
            name="ethalox doublet 7000N",
            source="shipped",
            suffix=".yaml",
        )
    return found.id


@pytest.fixture(scope="module")
def stand() -> Iterator[str]:
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": (STAND.name, STAND.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    yield str(diagram)
    library.remove(diagram)


def _session(diagram: str, **setup: float) -> str:
    response = client.post(
        "/api/session", params={"diagram": diagram, "engine": _engine()}, json=setup
    )
    assert response.status_code == 200, response.text
    return str(response.json()["id"])


def _finish() -> dict[str, Any]:
    for _ in range(1800):
        body: dict[str, Any] = client.get("/api/study").json()
        if not body["running"]:
            return body
        time.sleep(0.1)
    client.post("/api/study/cancel")
    raise AssertionError("the study did not finish")


@pytest.mark.parametrize(
    "body, status, words",
    [
        ({}, 422, "Open a stand"),
        ({"session": "nope", "cases": [{"label": "a"}]}, 404, ""),
    ],
)
def test_without_a_stand_it_is_refused(
    body: dict[str, Any], status: int, words: str
) -> None:
    response = client.post("/api/study", json=body)
    assert response.status_code == status, response.text
    assert words in str(response.json()["detail"])


def test_nothing_to_run_and_unknown_names_are_refused(stand: str) -> None:
    sid = _session(stand)
    empty = client.post("/api/study", json={"session": sid, "cases": []})
    assert empty.status_code == 422
    knob = client.post(
        "/api/study",
        json={"session": sid, "cases": [{"label": "a", "knobs": {"PR-9": 300}}]},
    )
    assert knob.status_code == 422 and "PR-9" in knob.json()["detail"]
    row = client.post(
        "/api/study",
        json={"session": sid, "cases": [{"label": "a", "setup": {"warp_drive": 1}}]},
    )
    assert row.status_code == 422 and "warp_drive" in row.json()["detail"]


def test_the_study_burns_the_stand_as_the_cockpit_has_it(stand: str) -> None:
    """The stand at a 4,000 psig COPV target and a 450 psig dome: the blank
    case starts there, not at the old study's fixed 4,500 / 550. A case that
    turns the dome up 50 psi starts 50 psi higher, because the stand's own
    regulator law (dome + bias) decides T-0."""
    sid = _session(stand, copv_target=4000.0, dome=450.0)
    started = client.post(
        "/api/study",
        json={
            "session": sid,
            "horizon_s": 1.0,
            "cases": [
                {"label": "as set"},
                {"label": "dome up", "knobs": {"dome": 500}},
            ],
        },
    )
    assert started.status_code == 200, started.text
    body = _finish()
    assert body["error"] == "", body["error"]
    as_set, up = body["cases"]
    assert as_set["error"] == "" and up["error"] == "", (as_set["error"], up["error"])
    assert as_set["t0"]["copv_psi"] == pytest.approx(4000.0)
    assert body["stand"] and body["engine_name"]
    bottle = next(iter(as_set["bottles"].values()))
    assert bottle[0] == pytest.approx(4000.0, abs=15.0), "the stand's COPV target"
    rise = up["t0"]["tank_psi"] - as_set["t0"]["tank_psi"]
    assert rise == pytest.approx(50.0, abs=1.0)
    assert as_set["outcome"].get("impulse_Ns", 0.0) > 0.0, "it fired"
    assert len(as_set["t"]) == len(as_set["thrust_n"]) == len(as_set["converged"])
    # Loaded as the cockpit's T-0 loads it: the engine's fire load (6.75 kg of
    # LOX in a 15 L tank), not the tank's fill fraction (~16 kg). The burn's
    # own prime used to reload to the fill fraction.
    loads = as_set["t0"]["loads_kg"]
    assert any(abs(kg - 6.75) < 0.02 for kg in loads.values()), loads
    assert all(kg < 10.0 for kg in loads.values()), loads
