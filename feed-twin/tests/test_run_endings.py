"""Every burn that lit leaves a run record, and the record says how it ended.

Three ways a burn ended without one, and one way a record misled:

* a **trip** (a vessel over its MAWP) holds the frame it tripped on, still
  burning, so burnout never came: nothing was recorded and /burns said
  "Burning" until Reset threw the session away (H003);
* a **Reset**, a drawing or engine switch, or an eviction closed the session
  mid-burn and the burn went with it (H034);
* a burn the operator cut short (Engine Abort, Vent) was recorded like a
  burnout, and Compare blamed a 2 psi T-0 difference for a 111 % thrust
  change while Explain replayed it to burnout (H062).

Checked against what happened on the stand, not against the code that records
it: one record per lit burn, the cause the operator would give, the commands
that cut it short among its inputs, and a replay that repeats them.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend import runs as run_records

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
                "endings.yaml",
                CONFIG.read_bytes() + b"\n# endings\n",
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


def _fire(client: TestClient, diagram: str, engine: str, seconds: float) -> str:
    """A stand at T-0, fired through the console, burning for ``seconds``."""
    sid = _open(client, diagram, engine)
    session = main._SESSIONS[sid]
    session.prime(fill_fraction=0.5, tank_psi=550.0, copv_psi=4500.0, state="Ready")
    _tick(client, sid, 0.1)  # in Ready, at T-0
    fired = client.post(f"/api/session/{sid}/command", json={"state": "Fire"})
    assert fired.status_code == 200, fired.text
    _tick(client, sid, seconds)
    assert session.history[-1].chamber.thrust > 1000.0, "lit"
    return sid


def _records(client: TestClient) -> list[dict[str, Any]]:
    return [
        client.get(f"/api/twin/runs/{r['id']}").json()
        for r in client.get("/api/twin/runs").json()
    ]


def test_a_trip_ends_the_burn_and_records_it(
    stand: tuple[TestClient, str, str],
) -> None:
    client, diagram, engine = stand
    sid = _fire(client, diagram, engine, 0.5)
    session = main._SESSIONS[sid]
    # The fuel tank's rating, as a drawing that rated it at lockup would.
    fuel = next(s for s in session.tanks.values() if "FU" in s.id.upper())
    fuel.mawp = fuel.pressure * 0.99
    frame = _tick(client, sid, 0.2)
    assert frame["tripped"], "the stand tripped"
    (record,) = _records(client)
    assert record["outcome"]["end_cause"] == "trip"
    assert record["outcome"]["ended"] == session.tripped
    assert record["outcome"]["burning"] is False
    assert record["outcome"]["thrust_mean_N"] > 1000.0
    # Nothing was commanded after Fire: no sequence, as on every older record.
    assert "sequence" not in record["inputs"]
    # The console says it is over, and links the record.
    (burn,) = client.get(f"/api/session/{sid}/burns").json()["burns"]
    assert burn["burning"] is False and burn["run_id"] == record["id"]
    _tick(client, sid, 1.0)
    assert len(client.get("/api/twin/runs").json()) == 1, "recorded once"


def test_a_reset_mid_burn_records_the_burn_it_cut_short(
    stand: tuple[TestClient, str, str],
) -> None:
    client, diagram, engine = stand
    sid = _fire(client, diagram, engine, 1.0)
    assert client.get("/api/twin/runs").json() == []
    _open(client, diagram, engine, replaces=sid)
    (record,) = _records(client)
    assert record["outcome"]["end_cause"] == "closed"
    assert "reset" in record["outcome"]["ended"].lower()
    assert record["outcome"]["duration_s"] == pytest.approx(1.0, abs=0.1)
    assert record["outcome"]["burning"] is False


def test_an_operator_cut_says_so_and_its_replay_repeats_it(
    stand: tuple[TestClient, str, str],
) -> None:
    client, diagram, engine = stand
    sid = _fire(client, diagram, engine, 1.0)
    cut = client.post(f"/api/session/{sid}/command", json={"state": "Vent"})
    assert cut.status_code == 200, cut.text
    _tick(client, sid, 1.5)
    (record,) = _records(client)
    assert record["outcome"]["end_cause"] == "operator"
    assert "Vent" in record["outcome"]["ended"]
    (step,) = record["inputs"]["sequence"]
    assert step["command"] == {"state": "Vent"}
    assert step["t"] == pytest.approx(1.0, abs=0.06)
    assert run_records.summary(record)["end_cause"] == "operator"

    # The ladder sees the cut as an input and its rung repeats it.
    burnout = {k: v for k, v in record["inputs"].items() if k != "sequence"}
    d = run_records.diff(
        {"id": "a", "inputs": burnout}, {"id": "b", "inputs": record["inputs"]}
    )
    assert d["groups"] == ["operator sequence"]
    replayed, _ = main._replay(record["inputs"], lambda: False, horizon_s=3.0)
    recorded = record["outcome"]
    assert replayed["duration_s"] == pytest.approx(recorded["duration_s"], abs=0.1)
    assert replayed["impulse_Ns"] == pytest.approx(recorded["impulse_Ns"], rel=0.05)


def test_a_knob_turned_mid_burn_is_recorded_where_it_stood_at_fire(
    stand: tuple[TestClient, str, str],
) -> None:
    """A record's settings are read when the burn ends, and its sequence turns
    the knob again at its T+: a dome turned mid-burn was recorded at its new
    value as well, so the replay burned all of the burn at it and missed the
    record it replays. The record says where the knob stood at Fire; the
    sequence says when it moved."""
    client, diagram, engine = stand
    sid = _fire(client, diagram, engine, 0.5)
    session = main._SESSIONS[sid]
    at_fire = session.setup.dome_psi
    turned = client.post(
        f"/api/session/{sid}/command",
        json={"knob": {"id": "dome", "value": at_fire + 150.0}},
    )
    assert turned.status_code == 200, turned.text
    assert session.setup.dome_psi == at_fire + 150.0
    _tick(client, sid, 1.0)
    client.post(f"/api/session/{sid}/command", json={"state": "Vent"})
    _tick(client, sid, 1.0)
    (record,) = _records(client)
    inputs = record["inputs"]
    assert inputs["setup"]["dome"] == at_fire
    assert inputs["knobs"]["dome"] == at_fire
    assert [s["command"] for s in inputs["sequence"]] == [
        {"knob": {"id": "dome", "value": at_fire + 150.0}},
        {"state": "Vent"},
    ]
    # Within what Explain takes for a reproduction. This stand's replay lands
    # ~2 % from the console's burn either way (it primes and settles its own
    # T-0); recorded at the turned dome, it landed 15 % over.
    replayed, _ = main._replay(inputs, lambda: False, horizon_s=3.0)
    recorded = record["outcome"]
    tolerance = run_records.REPRODUCTION_TOLERANCE
    for key in ("impulse_Ns", "thrust_mean_N", "pc_mean_psi"):
        assert replayed[key] == pytest.approx(recorded[key], rel=tolerance), key


def test_a_burn_half_out_of_the_history_is_listed_once_as_recorded(
    stand: tuple[TestClient, str, str],
) -> None:
    """The history rolls: about 80 s after a burn its head is inside it, and
    the burn found there -- timed from the head, with part of its impulse --
    was listed beside the recorded one and sorted last, as "Last burn"
    (H008). The recorded one is the burn."""
    client, diagram, engine = stand
    sid = _fire(client, diagram, engine, 1.0)
    client.post(f"/api/session/{sid}/command", json={"state": "Vent"})
    _tick(client, sid, 1.5)
    (record,) = _records(client)
    session = main._SESSIONS[sid]
    start = record["clock"]["start_s"]
    rolled = [s for s in session.history if s.t > start + 0.4]
    session.history.clear()
    session.history.extend(rolled)
    (burn,) = client.get(f"/api/session/{sid}/burns").json()["burns"]
    assert burn["run_id"] == record["id"]
    assert burn["start_s"] == record["outcome"]["start_s"]
    assert burn["impulse_Ns"] == record["outcome"]["impulse_Ns"]


def test_a_burn_flown_to_burnout_says_which_tank_ran_dry(
    stand: tuple[TestClient, str, str],
) -> None:
    client, diagram, engine = stand
    sid = _open(client, diagram, engine)
    session = main._SESSIONS[sid]
    session.prime(fill_fraction=0.05, tank_psi=550.0, copv_psi=4500.0, state="Ready")
    _tick(client, sid, 0.1)
    client.post(f"/api/session/{sid}/command", json={"state": "Fire"})
    for _ in range(80):
        _tick(client, sid, 0.05)
        if client.get("/api/twin/runs").json():
            break
    (record,) = _records(client)
    assert session.state == "Vent", "burnout vented the tanks"
    assert record["outcome"]["end_cause"] == "burnout", record["outcome"]["ended"]
    assert "ran dry" in record["outcome"]["ended"]
    assert "sequence" not in record["inputs"]


def test_explain_will_not_attribute_a_burn_its_replay_does_not_reproduce() -> None:
    """A run whose replay misses it by more than the tolerance has no
    attribution: the bars would explain the replay, not the burn."""

    def replay(inputs: Any, cancelled: Any) -> tuple[dict[str, float], list[str]]:
        return {"thrust_mean_N": 6150.0, "impulse_Ns": 23700.0}, []

    a = {
        "id": "a",
        "inputs": {"t0": {}},
        "outcome": {
            "thrust_mean_N": 2913.0,
            "impulse_Ns": 14525.0,
            "end_cause": "abort",
            "ended": "Engine Abort at T+1.50 s",
        },
    }
    b = {
        "id": "b",
        "inputs": {"t0": {"x": 1}},
        "outcome": {"thrust_mean_N": 6150.0, "impulse_Ns": 23700.0},
    }
    explainer = run_records.Explainer()
    assert explainer.start(a, b, replay)
    assert explainer._thread is not None
    explainer._thread.join(10.0)
    state = explainer.state
    assert state["stage"] == "done"
    assert "attribution" not in state
    assert "does not reproduce" in state["error"]
    assert "Engine Abort at T+1.50 s" in state["error"]
    assert state["reproduction"], "the gap is still shown"

    # Reproduced, it is attributed as before.
    a["outcome"] = {"thrust_mean_N": 6150.0, "impulse_Ns": 23700.0}
    explainer = run_records.Explainer()
    assert explainer.start(a, b, replay)
    assert explainer._thread is not None
    explainer._thread.join(10.0)
    assert explainer.state["error"] == ""
    assert "attribution" in explainer.state
