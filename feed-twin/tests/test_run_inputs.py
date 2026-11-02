"""A run record names everything its burn depended on.

CLAUDE.md: "A new input that changes a burn belongs in ``_inputs`` or the diff
and the Explain ladder cannot see it." Two inputs were outside it:

* the drawing's **operator overrides** (the Drawing tab), applied at assembly:
  a regulator's droop overridden between two burns moved thrust by 1 kN and
  the diff said nothing changed, and Explain replayed the older run on the
  override made after it;
* the **engine card**, rebuilt in place under the same engine id: a card
  rebuilt between two burns moved thrust by 300 N, the diff was empty, and a
  replay fired whatever card is stored now.

Checked against the store and the card bytes, not against the code that
records them: the record says what was in force, a replay builds on what the
record says (not on what the store holds today), and a record of a stand with
neither diffs clean against one written before either was recorded.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import designtools, main
from backend import runs as run_records
from backend.assembly import card_version
from backend.library import LibraryError

SAMPLE = Path(__file__).resolve().parents[1] / "backend" / "sample"
client = TestClient(main.app)


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))


@pytest.fixture
def le4() -> Iterator[tuple[str, str, str]]:
    """The sample LE4 drawing and engine, with the sample's card, under bytes
    of their own (so nothing here touches another test's artifacts)."""
    drawing = (SAMPLE / "le4-stand.json").read_bytes()
    payload = json.loads(drawing)
    payload["name"] = "run inputs LE4"
    up = client.post(
        "/api/library/diagrams",
        files={
            "file": ("run inputs LE4.json", json.dumps(payload).encode(), "text/plain")
        },
    )
    assert up.status_code == 200, up.text
    diagram = str(up.json()["artifact"]["id"])
    engine_bytes = b"# run inputs\n" + (SAMPLE / "ethalox-doublet.yaml").read_bytes()
    up = client.post(
        "/api/library/engines",
        files={"file": ("run inputs engine.yaml", engine_bytes, "text/plain")},
    )
    assert up.status_code == 200, up.text
    engine = str(up.json()["artifact"]["id"])
    main.library.attach(
        engine, "card", (SAMPLE / "ethalox-doublet.card.json").read_bytes()
    )
    name = main.library.get(diagram).name
    try:
        yield diagram, engine, name
    finally:
        main.overrides.put_entry(name, {})
        for artifact in (engine, diagram):
            try:
                main.library.remove(artifact)
            except LibraryError:
                pass


def _open(diagram: str, engine: str) -> str:
    opened = client.post(
        "/api/session",
        params={"diagram": diagram, "engine": engine},
        json={"state": "Idle"},
    )
    assert opened.status_code == 200, opened.text
    return str(opened.json()["id"])


def _recorded(sid: str) -> dict[str, Any]:
    session = main._SESSIONS[sid]
    return main._inputs(session, main._OPENED[sid], session.history[-1])


def _override(name: str, value: float) -> None:
    main.overrides.put_entry(
        name,
        {
            "params": {
                "node_1": {
                    "volume": {
                        "value": value,
                        "unit": "L",
                        "source": "measured",
                        "reference": "weighed",
                        "by": "test",
                        "at": "now",
                    }
                }
            }
        },
    )


def _volume(session: Any) -> float | None:
    for applied in main._applied(session.model):
        if (applied.element, applied.parameter) == ("node_1", "volume"):
            return float(applied.value)
    return None


# ------------------------------------------------------------------ overrides


def test_a_record_names_the_overrides_its_burn_was_built_on(
    le4: tuple[str, str, str],
) -> None:
    diagram, engine, name = le4
    _override(name, 4.0)
    inputs = _recorded(_open(diagram, engine))
    assert inputs["overrides"] == {
        "node_1": {"volume": {"value": 4.0, "unit": "L", "source": "measured"}}
    }

    # Changed since: the replay builds the stand the record names, not today's.
    _override(name, 3.0)
    assert _volume(main._session_from_inputs(inputs)) == 4.0
    main.overrides.put_entry(name, {})
    assert _volume(main._session_from_inputs(inputs)) == 4.0

    # A record of a stand with none replays with none, whatever is set now.
    _override(name, 3.0)
    bare = {**inputs, "overrides": {}}
    assert _volume(main._session_from_inputs(bare)) is None


def test_no_overrides_records_nothing_a_diff_can_see(
    le4: tuple[str, str, str],
) -> None:
    """Nothing overridden is the old record exactly: it diffs clean against a
    record written before overrides were recorded."""
    diagram, engine, _ = le4
    inputs = _recorded(_open(diagram, engine))
    assert inputs["overrides"] == {}
    older = {k: v for k, v in inputs.items() if k != "overrides"}
    record = {"id": "a", "inputs": inputs, "outcome": {}}
    old = {"id": "b", "inputs": older, "outcome": {}}
    assert run_records.diff(record, old)["inputs"] == []
    assert run_records.swaps(inputs, older) == []


def test_an_override_between_two_runs_is_in_the_diff_and_on_the_ladder() -> None:
    a = {"diagram": "d", "overrides": {}, "setup": {}}
    b = {
        "diagram": "d",
        "overrides": {
            "node_2": {
                "flow_droop": {"value": 80.0, "unit": "psi", "source": "measured"}
            }
        },
        "setup": {},
    }
    d = run_records.diff({"id": "a", "inputs": a}, {"id": "b", "inputs": b})
    assert [c["key"] for c in d["inputs"]] == [
        "overrides.node_2.flow_droop.source",
        "overrides.node_2.flow_droop.unit",
        "overrides.node_2.flow_droop.value",
    ]
    assert d["groups"] == ["drawing overrides"]
    rungs = dict(run_records.swaps(a, b))
    assert rungs == {"drawing overrides": ("overrides",)}
    assert run_records.with_swapped(a, b, rungs["drawing overrides"]) == b


# ---------------------------------------------------------------------- knobs


def test_a_record_never_contradicts_itself_about_the_dome(
    le4: tuple[str, str, str],
) -> None:
    """The dome knob is ``setup.dome`` (a turn of it sets that); the record's
    ``knobs.dome`` was the value the session opened with, so a burn at dome
    500 recorded dome 535 beside ``setup.dome = 500`` (H009)."""
    diagram, engine, _ = le4
    sid = _open(diagram, engine)
    assert "dome" in main._SESSIONS[sid].knobs
    turned = client.post(
        f"/api/session/{sid}/command", json={"knob": {"id": "dome", "value": 480.0}}
    )
    assert turned.status_code == 200, turned.text
    inputs = _recorded(sid)
    assert inputs["setup"]["dome"] == 480.0
    assert inputs["knobs"]["dome"] == 480.0


# ------------------------------------------------------------------ settings


def test_a_setting_that_waits_for_reset_is_recorded_as_built(
    le4: tuple[str, str, str],
) -> None:
    """A Configuration row that applies on Reset, changed on a running stand,
    is not what the stand burns on -- its vessels were built from the old
    value. The record said the new one, so a replay of the run rebuilt a
    stand that never burned, and tripped it (H019, H033). It records what
    was built, and the change it is waiting to make."""
    from backend.tunables import TUNABLES

    diagram, engine, _ = le4
    waits = {t.key for t in TUNABLES if t.applies == "reset"}
    assert "burst_safety_factor" in waits and "ullage_vapour" not in waits
    sid = _open(diagram, engine)
    built = _recorded(sid)["setup"]
    changed = client.post(
        f"/api/session/{sid}/command",
        json={
            "setup": {
                "burst_safety_factor": 3.0,
                "ullage_vapour": not built["ullage_vapour"],
            }
        },
    )
    assert changed.status_code == 200, changed.text
    inputs = _recorded(sid)
    assert inputs["setup"]["burst_safety_factor"] == built["burst_safety_factor"]
    assert inputs["setup"]["ullage_vapour"] is (
        not built["ullage_vapour"]
    ), "live is live"
    pending = main._pending_setup(main._SESSIONS[sid], main._OPENED[sid])
    assert pending == {"burst_safety_factor": 3.0}


# ---------------------------------------------------------------- the traces


def test_a_recorded_chamber_reads_the_chamber_outside_the_burn(
    le4: tuple[str, str, str],
) -> None:
    """The live Pc reads the chamber with the engine out (IDLE_READS: 13.6 psia
    on a card with site ambient); the record's trace wrote a literal 0 psig
    there, which the Runs and Engine tabs plot as 14.7 psia (H013). Thrust
    and O/F stay 0 outside it."""
    from feedtwin.session.gauge import psig

    diagram, engine, _ = le4
    sid = _open(diagram, engine)
    for _ in range(5):
        client.post(f"/api/session/{sid}/tick", json={"dt": 0.1})
    session = main._SESSIONS[sid]
    history = list(session.history)
    idle = [s for s in history if s.chamber is not None]
    assert idle, "the chamber is read at rest"
    at_rest = psig(idle[-1].chamber.pressure)
    assert abs(at_rest) > 0.5, "a site ambient, not standard: else this proves nothing"
    t = history[-1].t
    series = main._burn_series(session, history, t, t)
    assert series["pc_psig"][-1] == pytest.approx(at_rest, abs=0.01)
    assert set(series["thrust_N"]) == {0.0} and set(series["of"]) == {0.0}


# --------------------------------------------------------------- the replay

LE4 = (
    Path(__file__).resolve().parents[2]
    / "lib"
    / "feedtwin"
    / "tests"
    / "fixtures"
    / "le4_rocket_and_gse.json"
)


@pytest.mark.skipif(not LE4.is_file(), reason="no LE4 drawing")
def test_a_replay_charges_the_vehicles_bottle_on_the_cockpits_grid() -> None:
    """T-0 records every bottle, the cart's too, in drawing order: a cart
    K-bottle drawn first charged the replay's COPV to 6,000 psig (H040). And
    a replay steps on the run's own live step, not BurnPlan's 0.05 s (H045)."""
    up = client.post(
        "/api/library/diagrams",
        files={"file": ("replay LE4.json", LE4.read_bytes(), "application/json")},
    )
    diagram = str(up.json()["artifact"]["id"])
    try:
        session = main._session_from_inputs(
            {"diagram": diagram, "setup": {"ignore_gse": False}}
        )
        assert "node_63" in session.ground and "node_1" not in session.ground
        t0 = {
            "bottles": {
                "node_63": {"label": "6K-GN2", "psig": 6000.0},
                "node_1": {"label": "COPV", "psig": 3750.0},
                "node_66": {"label": "2K-GN2", "psig": 2000.0},
            }
        }
        plan = main._replay_plan(session, {"t0": t0}, 5.0)
        assert plan.copv_psi == 3750.0
        assert plan.dt == session.setup.live_step
    finally:
        main.library.remove(diagram)


# ----------------------------------------------------------------------- card


def test_a_record_names_the_card_it_fired_and_a_replay_fires_that_card(
    le4: tuple[str, str, str],
) -> None:
    diagram, engine, _ = le4
    first = main.library.attachment(engine, "card")
    assert first is not None
    inputs = _recorded(_open(diagram, engine))
    built = json.loads(first)["card"]["provenance"]["built"]
    assert inputs["card"] == {
        "sha256": hashlib.sha256(first).hexdigest(),
        "built": built,
    }

    # Rebuilt in place, as the Engine page's "Build EngineDesign card" does.
    rebuilt = json.loads(first)
    rebuilt["card"]["provenance"]["built"] = "2026-11-02T00:00:00+00:00"
    main._keep_card(engine, json.dumps(rebuilt).encode("utf-8"))
    now = _recorded(_open(diagram, engine))
    assert now["card"]["built"] == "2026-11-02T00:00:00+00:00"
    d = run_records.diff({"id": "a", "inputs": inputs}, {"id": "b", "inputs": now})
    assert d["groups"] == ["engine"]
    assert {c["key"] for c in d["inputs"]} == {"card.sha256", "card.built"}

    # The older run replays on the card it fired, not the one stored now.
    replay = main._session_from_inputs(inputs)
    assert replay.model.meta["card_sha256"] == inputs["card"]["sha256"]
    assert main._session_from_inputs(now).model.meta["card_sha256"] == (
        now["card"]["sha256"]
    )
    # A record of the simplified engine replays the simplified engine.
    simplified = main._session_from_inputs({**inputs, "card": {}})
    assert simplified.model.meta["engine_model"] == "simplified"


def test_rebuilding_a_card_keeps_the_one_it_replaces(
    le4: tuple[str, str, str],
) -> None:
    """The Engine page's "Build EngineDesign card" replaces the card in place:
    the runs that fired the old one still replay on it."""
    _, engine, _ = le4
    first = main.library.attachment(engine, "card")
    assert first is not None
    rebuilt = json.loads(first)
    rebuilt["card"]["provenance"]["built"] = "rebuilt"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=rebuilt)

    designtools.transport = httpx.MockTransport(handler)
    try:
        answer = client.post(f"/api/library/{engine}/card")
    finally:
        designtools.transport = None
    assert answer.status_code == 200, answer.text
    now = main.library.attachment(engine, "card")
    assert now is not None and json.loads(now) == rebuilt
    kept = main.library.attachment(
        engine, card_version(hashlib.sha256(first).hexdigest())
    )
    assert kept == first


def test_a_card_that_is_gone_is_said_not_swapped_silently(
    le4: tuple[str, str, str],
) -> None:
    diagram, engine, _ = le4
    inputs = _recorded(_open(diagram, engine))
    lost = {**inputs, "card": {"sha256": "0" * 64, "built": "long ago"}}
    replay = main._session_from_inputs(lost)
    assert replay.model.meta["card_missing"] == "0" * 64
    assert any(
        "no longer stored" in w for w in replay.model.report.warnings
    ), replay.model.report.warnings
