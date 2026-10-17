"""A burn is an engine making thrust, and a stand someone is watching stays open.

Three defects from the 2026-10-17 dry run, each checked against what the stand
must do rather than against the code that does it:

* A Fire off unpressed tanks pushes both propellants through the engine at a
  few psi and no thrust. That is a cold flow: the console says so, the Engine
  tab lists no burn and nothing is recorded (D-10). It ran as "Burning" until
  Reset.
* An Engine Abort whose table row leaves the mains open trickles both
  propellants for as long as the stand sits there; each trickle was recorded
  as a 0 N burn, nineteen in thirty seconds (D-01). The console says the row
  leaves the mains open and where to fix it (D-18).
* The server closed the first stand opened when it was full, whoever was
  watching it (D-17): it closes the one idle longest, says so to its console,
  and a Reset frees its old seat at once.
"""

from __future__ import annotations

import time
from dataclasses import replace
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from backend import main

STAR = Path(__file__).resolve().parents[2]
CONFIG = STAR / "EngineDesign" / "configs" / "ethalox_doublet_7000N.yaml"
STAND = (
    Path(__file__).resolve().parents[1] / "backend" / "diagrams" / "ethalox_stand.json"
)


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))


@pytest.fixture(scope="module")
def stand() -> Iterator[tuple[TestClient, str, str]]:
    if not CONFIG.exists():
        pytest.skip("EngineDesign configs absent")
    client = TestClient(main.app)
    engine = client.post(
        "/api/library/engines",
        files={
            "file": (
                "unlit.yaml",
                CONFIG.read_bytes() + b"\n# unlit\n",
                "application/x-yaml",
            )
        },
    ).json()["artifact"]["id"]
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": (STAND.name, STAND.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        yield client, diagram, engine
    finally:
        main.library.remove(engine)
        main.library.remove(diagram)


def _open(client: TestClient, diagram: str, engine: str, **body: Any) -> str:
    opened = client.post(
        "/api/session", params={"diagram": diagram, "engine": engine}, json=body
    )
    assert opened.status_code == 200, opened.text
    return str(opened.json()["id"])


def _tick(client: TestClient, sid: str, seconds: float) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for _ in range(round(seconds / 0.05)):
        ticked = client.post(f"/api/session/{sid}/tick", json={"dt": 0.05})
        assert ticked.status_code == 200, ticked.text
        out = ticked.json()
    return out


def _card_like(session: Any, monkeypatch: pytest.MonkeyPatch, floor_pa: float) -> None:
    """An engine card makes no thrust at a low chamber pressure (its nozzle is
    over-expanded there: LE4 read 24-34 psia and 0 N); this stand's simplified
    engine still makes a little, so give it a card's floor."""
    chamber = session.model.chamber
    evaluate = chamber.evaluate

    def card_like(mdot_oxidiser: float, mdot_fuel: float) -> Any:
        out = evaluate(mdot_oxidiser, mdot_fuel)
        if out.pressure < floor_pa:
            return replace(out, thrust=0.0, specific_impulse=0.0)
        return out

    monkeypatch.setattr(chamber, "evaluate", card_like)


def test_fire_off_unpressed_tanks_is_a_cold_flow_not_a_burn(
    stand: tuple[TestClient, str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, diagram, engine = stand
    sid = _open(client, diagram, engine)
    session = main._SESSIONS[sid]
    _card_like(session, monkeypatch, 3.0e5)
    session.prime(fill_fraction=0.5, tank_psi=8.0, copv_psi=0.0, state="Ready")
    session.command_state("Fire")
    frame = _tick(client, sid, 1.5)
    chamber = session.history[-1].chamber
    assert chamber is not None and chamber.mdot_total > 0.0, "propellant flows"
    assert chamber.thrust == 0.0, "and nothing burns"
    assert any(n.startswith("Not lit: cold flow") for n in frame["notes"])
    assert client.get(f"/api/session/{sid}/burns").json()["burns"] == []
    session.command_state("Engine Abort")
    _tick(client, sid, 1.0)
    assert client.get("/api/twin/runs").json() == []


def test_an_abort_that_leaves_the_mains_open_records_one_lit_burn(
    stand: tuple[TestClient, str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, diagram, engine = stand
    sid = _open(client, diagram, engine)
    session = main._SESSIONS[sid]
    # The engine burns on through the abort as the open mains feed it, and
    # goes out (no thrust) while they still trickle.
    _card_like(session, monkeypatch, 8.0e5)
    assert any(
        "main" in a.lower() and session.machine.positions["Engine Abort"].get(a)
        for a in session.machine.actuators
    ), "the shipped table's Engine Abort row opens a main (NEEDS-REPAIR.md)"
    session.prime(fill_fraction=0.5, tank_psi=550.0, copv_psi=4500.0, state="Ready")
    session.command_state("Fire")
    _tick(client, sid, 1.0)
    assert session.history[-1].chamber.thrust > 1000.0
    session.command_state("Engine Abort")
    frame = _tick(client, sid, 6.0)
    assert any(
        n.startswith("Engine Abort leaves") and "State machine tab" in n
        for n in frame["notes"]
    ), frame["notes"]
    assert session.history[-1].chamber.mdot_total > 0.0, "still trickling"
    assert session.history[-1].chamber.thrust == 0.0, "with the engine out"
    runs = client.get("/api/twin/runs").json()
    assert len(runs) == 1, [r["outcome"] for r in runs]
    record = client.get(f"/api/twin/runs/{runs[0]['id']}").json()
    assert record["outcome"]["thrust_peak_N"] > 1000.0
    assert record["notes"][0].startswith("The engine burned on")
    # It ends where the thrust did, not with the trickle after it.
    ended = record["clock"]["end_s"]
    last_lit = max(s.t for s in session.history if s.chamber and s.chamber.thrust > 0)
    assert ended == pytest.approx(last_lit, abs=1e-6)
    _tick(client, sid, 3.0)
    assert len(client.get("/api/twin/runs").json()) == 1, "no phantom burns"
    burns = client.get(f"/api/session/{sid}/burns").json()["burns"]
    assert len(burns) == 1 and burns[0]["thrust_peak_N"] > 0.0


def test_a_full_server_closes_the_idlest_stand_not_the_one_watched(
    stand: tuple[TestClient, str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, diagram, engine = stand
    monkeypatch.setattr(main, "_SESSION_LIMIT", 3)
    for sid in list(main._SESSIONS):
        main._close_session(sid, "cleared for the test")
    first, second, third = (_open(client, diagram, engine) for _ in range(3))
    # The first one opened is the one being watched; the second sat idle.
    main._TOUCHED[second] = time.monotonic() - 600.0
    main._TOUCHED[third] = time.monotonic() - 300.0
    _tick(client, first, 0.05)
    fourth = _open(client, diagram, engine)
    assert first in main._SESSIONS and fourth in main._SESSIONS
    assert second not in main._SESSIONS
    gone = client.post(f"/api/session/{second}/tick", json={"dt": 0.05})
    assert gone.status_code == 404
    assert "closed to make room" in gone.json()["detail"]
    # Its console reopens on a fresh stand that says what happened.
    fifth = _open(client, diagram, engine, replaces=second)
    assert any("closed on the server" in n for n in main._notices(fifth))
    # However busy the server, the console being ticked is the last closed.
    for sid in main._SESSIONS:
        main._TOUCHED[sid] = time.monotonic()
    _tick(client, fifth, 0.05)
    _open(client, diagram, engine)
    assert fifth in main._SESSIONS
    # A Reset frees its old seat at once.
    sixth = _open(client, diagram, engine, replaces=first)
    assert first not in main._SESSIONS and sixth in main._SESSIONS


LE4 = STAR / "lib" / "feedtwin" / "tests" / "fixtures" / "le4_rocket_and_gse.json"


@pytest.mark.skipif(not LE4.is_file(), reason="no LE4 drawing")
def test_t0_refuses_a_dome_that_primes_a_tank_over_its_mawp() -> None:
    """A dome knob turned to 965 primed both tanks at 963.5 psia against a
    764.7 psia MAWP and tripped the stand on its first frame (D-33). T-0 says
    so and leaves the stand as it was; turned back down, it primes."""
    client = TestClient(main.app)
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": ("le4 t0.json", LE4.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        sid = _open(client, diagram, "")
        session = main._SESSIONS[sid]
        turned = client.post(
            f"/api/session/{sid}/command", json={"knob": {"id": "dome", "value": 965}}
        )
        assert turned.status_code == 200, turned.text
        refused = client.post(f"/api/session/{sid}/t0")
        assert refused.status_code == 422
        assert "MAWP" in refused.json()["detail"], refused.json()
        assert session.tripped is None and session.state == "Idle"
        client.post(
            f"/api/session/{sid}/command", json={"knob": {"id": "dome", "value": 535}}
        )
        primed = client.post(f"/api/session/{sid}/t0")
        assert primed.status_code == 200, primed.text
        assert session.tripped is None
    finally:
        main.library.remove(diagram)


@pytest.mark.skipif(not LE4.is_file(), reason="no LE4 drawing")
def test_a_burn_on_an_assumed_droop_says_so() -> None:
    """LE4 (6) draws no flow droop on DPR_HP, so every burn runs on the build's
    20 psi at 0.05 kg/s -- and that number sets most of the He-vs-GN2 gap
    (D-22). The run record says so; drawn, it says nothing."""
    import json

    from feedtwin.pid import read_diagram
    from feedtwin.session import assemble_model, load_machine
    from feedtwin.session.burn import open_session

    tables = Path(main.__file__).resolve().parent / "statemachines"

    def droop_note(payload: dict[str, Any]) -> str:
        model = assemble_model(read_diagram(payload, name="LE4"), diagram_id="le4")
        return main._assumed_droop(open_session(model, load_machine(tables=tables)))

    payload = json.loads(LE4.read_text())
    note = droop_note(payload)
    assert note.startswith("Regulator droop assumed") and "DPR_HP" in note, note
    for node in payload["nodes"]:
        if node["data"].get("label") == "DPR_HP":
            node["data"]["params"]["flow_droop"] = {
                "value": 60,
                "unit": "psi",
                "source": "measured",
                "reference": "test",
            }
    assert droop_note(payload) == ""


@pytest.mark.skipif(not LE4.is_file(), reason="no LE4 drawing")
def test_a_regulator_with_its_dome_unloaded_has_no_lockup() -> None:
    """LE4 (6) in Idle: the dome line is shut, so the dome regulator holds only
    its spring bias less its supply effect -- "-1.4 psia" with a full COPV --
    and the pad guide called 15 and 34 psia tanks pressed (D-09). Unloaded,
    there is no lockup to press to; loaded (T-0), there is, and it is where
    the tanks were primed."""
    client = TestClient(main.app)
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": ("le4 dome.json", LE4.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        sid = _open(client, diagram, "")
        session = main._SESSIONS[sid]
        flight = set(session.vehicle_tanks)
        idle = client.post(f"/api/session/{sid}/tick", json={"dt": 0.02}).json()
        run = [t for t in idle["tanks"] if t["id"] in flight]
        assert run and all(t["lockup_psi"] is None for t in run), run
        assert all(t["lockup_range_psi"] for t in run), "the knob's range stands"
        primed = client.post(f"/api/session/{sid}/t0").json()
        for tank in (t for t in primed["tanks"] if t["id"] in flight):
            assert tank["lockup_psi"] == pytest.approx(tank["pressure_psi"], abs=3.0)
    finally:
        main.library.remove(diagram)
