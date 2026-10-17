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
    # Gauge on the wire, psia to read (ADR 0007): 3000 + 14.696.
    assert describe(BASE, case) == [
        "COPV 3,014.7 psia",
        "dome 464.7 psia",
        "aux 264.7 psia",
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
        # A knob typed 10 psia went on the wire as -4.7 psig and into the run.
        ({"knobs": {"DOME": -4.7}}, "DOME"),
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


def test_a_tank_too_small_for_its_fire_load_is_said(stand: str) -> None:
    """The engine's fuel fire load (7.00 kg) does not fit the stand's 8.67 L
    fuel tank at a 95 % fill. A load stops at the full fraction, so every fire
    is loaded short -- the stand says so when it opens, with what it does
    load, which follows the full fraction."""

    def opened(fraction: float) -> dict[str, Any]:
        return dict(
            client.post(
                "/api/session",
                params={"diagram": stand, "engine": _engine()},
                json={"full_fraction": fraction},
            ).json()
        )

    full = opened(0.95)
    short = [n for n in full["notes"] if "fire load" in n]
    assert len(short) == 1, full["notes"]
    fuel = next(t for t in full["tanks"] if t["fire_load_kg"] == pytest.approx(7.0))
    assert fuel["label"] in short[0] and fuel["load_kg"] < 7.0
    assert f"holds {fuel['load_kg']:.2f} kg at its 95% fill" in short[0]
    half = opened(0.5)
    (note,) = [n for n in half["notes"] if "fire load" in n]
    assert f"holds {fuel['load_kg'] * 0.5 / 0.95:.2f} kg at its 50% fill" in note


LE4 = (
    Path(__file__).resolve().parents[2]
    / "lib"
    / "feedtwin"
    / "tests"
    / "fixtures"
    / "le4_rocket_and_gse.json"
)


@pytest.mark.skipif(not LE4.is_file(), reason="no LE4 drawing")
def test_a_study_on_a_stand_with_a_cart_reports_the_vehicle_tanks() -> None:
    """LE4 (6) has a cart: a LOX dewar and a fuel transfer tank. They sat in
    every case's traces at atmosphere, so "Tank low" was a flat zero for every
    case, the legend doubled, and the loads listed the cart's propellant
    (D-19). The vehicle's tanks are what a burn is about."""
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": ("le4 study.json", LE4.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        sid = _session(str(diagram))
        started = client.post(
            "/api/study",
            json={"session": sid, "horizon_s": 0.5, "cases": [{"label": "as set"}]},
        )
        assert started.status_code == 200, started.text
        body = _finish()
        (case,) = body["cases"]
        assert case["error"] == "", case["error"]
        assert set(case["tanks"]) == {"Eth-Tank", "LOX-Tank"}, set(case["tanks"])
        assert set(case["t0"]["loads_kg"]) <= {"Eth-Tank", "LOX-Tank"}
        assert set(case["bottles"]) == {"COPV"}, set(case["bottles"])
        assert min(min(v) for v in case["tanks"].values()) > 100.0
        listed = {t["label"] for t in case["outcome"].get("tanks", [])}
        assert listed <= {"Eth-Tank", "LOX-Tank"}, listed
    finally:
        library.remove(diagram)


def test_the_study_and_the_console_end_a_burn_in_the_same_place(stand: str) -> None:
    """One end of burn: a tank empty. The Study stopped at BurnPlan's 60 g
    design residual while the console burned to empty, so the same stand read
    0.6 % less impulse on the Study than on the console (D-80). The Study now
    burns its load to empty. What is left between them (~0.3 %) is the
    console's own last step: cut at the dry instant, its sample reads the
    tank dry and the report does not count it."""
    from backend import main

    sid = _session(stand)
    assert client.post(f"/api/session/{sid}/t0").status_code == 200
    session = main._SESSIONS[sid]
    loads = session.fire_loads()
    session.command_state("Fire")
    for _ in range(400):
        client.post(f"/api/session/{sid}/tick", json={"dt": 0.05})
        if session.state != "Fire":
            break
    burns = client.get(f"/api/session/{sid}/burns").json()["burns"]
    assert burns, "the console burned"
    console = burns[-1]
    started = client.post(
        "/api/study",
        json={"session": sid, "horizon_s": 14.0, "cases": [{"label": "as set"}]},
    )
    assert started.status_code == 200, started.text
    (case,) = _finish()["cases"]
    assert case["error"] == "", case["error"]
    study = case["outcome"]
    burned = study["oxidiser_kg"] + study["fuel_kg"]
    # To empty: the first tank to run dry runs to DRY_MASS, not to 60 g.
    assert (
        min(
            loads[t]
            - (
                study["oxidiser_kg"]
                if "lox" in t.lower() or "ox" in t.lower()
                else study["fuel_kg"]
            )
            for t in loads
        )
        < 0.01
    ), (loads, study["oxidiser_kg"], study["fuel_kg"])
    assert burned > console["oxidiser_kg"] + console["fuel_kg"] - 0.005
    assert study["impulse_Ns"] == pytest.approx(console["impulse_Ns"], rel=5e-3)


def test_a_study_is_its_owners_on_its_stand(stand: str) -> None:
    """One study per server let every viewer watch and cancel another's, and
    refused anyone else's with a 409 (D-51). Studies are kept per person and
    per stand: a second person runs theirs, sees only theirs, and cannot
    cancel the first."""
    alice = {"X-Auth-Email": "alice@example.com"}
    bob = {"X-Auth-Email": "bob@example.com"}

    def opened(headers: dict[str, str]) -> str:
        response = client.post(
            "/api/session",
            params={"diagram": stand, "engine": _engine()},
            json={},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        return str(response.json()["id"])

    a, b = opened(alice), opened(bob)
    body = {"horizon_s": 1.0, "cases": [{"label": "one"}, {"label": "two"}]}
    first = client.post("/api/study", json={**body, "session": a}, headers=alice)
    assert first.status_code == 200, first.text
    second = client.post("/api/study", json={**body, "session": b}, headers=bob)
    assert second.status_code == 200, second.text
    # Someone else's cancel, even with Alice's session, touches only their own;
    # Bob's stops Bob's, and Alice's runs on.
    client.post(f"/api/study/cancel?session={a}", headers={"X-Auth-Email": "eve@x.org"})
    client.post(f"/api/study/cancel?session={b}", headers=bob)
    for _ in range(1800):
        mine = client.get(f"/api/study?session={a}", headers=alice).json()
        theirs = client.get(f"/api/study?session={b}", headers=bob).json()
        if not mine["running"] and not theirs["running"]:
            break
        time.sleep(0.1)
    assert mine["stage"] == "done" and len(mine["cases"]) == 2, mine["stage"]
    assert theirs["stage"] == "cancelled", theirs["stage"]
    # A third viewer sees neither.
    assert (
        client.get("/api/study", headers={"X-Auth-Email": "eve@x.org"}).json()["cases"]
        == []
    )


def test_studies_burn_one_at_a_time_across_the_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One study per user and stand (D-51) put no bound on how many burned at
    once, each sharing the interpreter with every live console. The second
    waits its turn, and a queued one cancels without ever burning."""
    import threading

    from backend import study as study_mod
    from backend.study import StudyRequest, StudyRunner

    release = threading.Event()
    burning: list[int] = []
    most: list[int] = [0]

    def fake_run(*_: Any, **__: Any) -> None:
        burning.append(1)
        most[0] = max(most[0], len(burning))
        release.wait(5.0)
        burning.pop()

    monkeypatch.setattr(study_mod, "run_study", fake_run)
    request = StudyRequest(base={}, cases=[StudyCase(label="x")])
    first, second, third = StudyRunner(), StudyRunner(), StudyRunner()
    assert first.start(request, None, None)  # type: ignore[arg-type]
    deadline = time.monotonic() + 5.0
    while not burning and time.monotonic() < deadline:
        time.sleep(0.01)
    assert second.start(request, None, None)  # type: ignore[arg-type]
    assert third.start(request, None, None)  # type: ignore[arg-type]
    time.sleep(0.3)
    assert second.stage.startswith("queued") and third.stage.startswith("queued")
    third.cancel()
    third.wait(2.0)
    assert third.stage == "cancelled" and not third.running
    release.set()
    first.wait(5.0)
    second.wait(5.0)
    assert most[0] == 1
    assert first.stage == "done" and second.stage == "done"
