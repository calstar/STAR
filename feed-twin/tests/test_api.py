"""The API, against the real drawing and the real engine config.

Import, assemble, run. The tests follow the same three verbs a user does, and
check the properties that make the result mean something: that the assembly
reports what it invented, that the ids in a frame are the ids on the drawing,
and that attaching an engine actually changes the physics rather than adding a
label.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)

ENGINE_CONFIG = (
    Path(__file__).resolve().parents[2]
    / "EngineDesign"
    / "configs"
    / "ethalox_doublet_7000N.yaml"
)
needs_engine = pytest.mark.skipif(
    not ENGINE_CONFIG.exists(), reason="the ethalox engine config is not present"
)


def diagram_id() -> str:
    diagrams = client.get("/api/library?kind=diagram").json()
    assert diagrams, "the shipped stand should be seeded into the library"
    shipped = [d for d in diagrams if d["source"].startswith("shipped:")]
    return (shipped or diagrams)[0]["id"]


def engine_id() -> str:
    with ENGINE_CONFIG.open("rb") as handle:
        response = client.post(
            "/api/library/engines",
            files={"file": (ENGINE_CONFIG.name, handle, "text/yaml")},
        )
    assert response.status_code == 200, response.text
    return response.json()["artifact"]["id"]


# --------------------------------------------------------------- the basics


def test_health_and_version() -> None:
    assert client.get("/api/health").json() == {"status": "healthy"}
    stack = client.get("/api/version").json()["stack"]
    assert "CoolProp" in stack and "fluids" in stack


def test_the_shipped_stand_is_seeded() -> None:
    """There is something real on screen before anybody imports anything."""
    diagrams = client.get("/api/library?kind=diagram").json()
    assert diagrams
    # Any of them, not the first: the store also holds whatever this session
    # imported, and the order is by import time.
    assert any(d["source"].startswith("shipped:") for d in diagrams)
    assert diagrams[0]["summary"]["symbols"] > 10


# --------------------------------------------------------------- importing


def test_importing_a_drawing_twice_is_idempotent() -> None:
    payload = client.get(f"/api/library").json()
    before = len(payload)
    data = b'{"nodes": [], "edges": []}'
    first = client.post(
        "/api/library/diagrams",
        files={"file": ("blank.json", data, "application/json")},
    ).json()
    second = client.post(
        "/api/library/diagrams",
        files={"file": ("blank.json", data, "application/json")},
    ).json()
    assert first["already_present"] is False
    assert second["already_present"] is True
    assert first["artifact"]["id"] == second["artifact"]["id"]
    assert len(client.get("/api/library").json()) == before + 1
    client.delete(f"/api/library/{first['artifact']['id']}")


def test_a_file_that_is_not_a_drawing_is_refused_helpfully() -> None:
    response = client.post(
        "/api/library/diagrams",
        files={"file": ("notes.json", b"not json at all", "application/json")},
    )
    assert response.status_code == 422
    assert "not a P&ID" in response.json()["detail"]


def test_json_without_nodes_is_refused() -> None:
    response = client.post(
        "/api/library/diagrams",
        files={"file": ("x.json", b'{"hello": 1}', "application/json")},
    )
    assert response.status_code == 422
    assert "no 'nodes'" in response.json()["detail"]


@needs_engine
def test_importing_an_engine_records_what_it_is() -> None:
    """The listing has to be useful without opening the blob."""
    artifact = client.get(f"/api/library/{engine_id()}") if False else None
    identifier = engine_id()
    entry = next(
        a
        for a in client.get("/api/library?kind=engine").json()
        if a["id"] == identifier
    )
    summary = entry["summary"]
    assert summary["injector"] == "impinging"
    assert summary["oxidiser"] == "oxygen" and summary["fuel"] == "ethanol"
    assert summary["mixture_ratio"] == 1.65
    assert artifact is None


def test_an_engine_that_does_not_import_is_not_kept() -> None:
    """A library entry that cannot be assembled is worse than a refusal."""
    before = {a["id"] for a in client.get("/api/library?kind=engine").json()}
    response = client.post(
        "/api/library/engines",
        files={
            "file": ("bad.yaml", b"just: a mapping\nwith: no injector", "text/yaml")
        },
    )
    assert response.status_code == 422
    after = {a["id"] for a in client.get("/api/library?kind=engine").json()}
    assert after == before


# --------------------------------------------------------------- assembling


def test_the_model_reports_what_it_read_and_invented() -> None:
    model = client.get(f"/api/model?diagram={diagram_id()}").json()
    report = model["report"]
    assert report["symbols"] > 10 and report["nodes"] > 10
    assert report["instruments"] >= 4
    assert report["coupled"] is False  # no engine attached
    assert report["assumptions"], "the drawing does not state everything"
    assert report["unchecked"] >= 1
    assert any("dome of PR-DOME" in w for w in report["warnings"])


def test_every_symbol_carries_what_the_schematic_needs() -> None:
    model = client.get(f"/api/model?diagram={diagram_id()}").json()
    for symbol in model["symbols"]:
        assert "x" in symbol and "y" in symbol
        assert symbol["role"] in {
            "tank",
            "source",
            "inline",
            "instrument",
            "sink",
            "component",
        }
    # Every solenoid and rotary on the drawing, not just the mains: the stand
    # carries press, vent and fill valves and the console has to be able to
    # drive all of them.
    tags = {a["tag"] for a in model["actuators"]}
    assert {"MV-OX", "MV-FU", "SV-LOX-PRESS", "SV-FUEL-PRESS"} <= tags
    assert all(t.startswith(("MV-", "SV-")) for t in tags)


def test_an_unknown_artifact_is_a_422_not_a_500() -> None:
    response = client.get("/api/model?diagram=deadbeef1234")
    assert response.status_code == 422
    assert "no artifact" in response.json()["detail"]


# ------------------------------------------------------- the state machine
#
# The stand is not a timeline any more, it is a state machine — the same two
# CSVs the DAQ's firmware and GUI both read. So these check the properties that
# make that real: that a state commands the valves the table says, that an
# illegal move is refused, and that an abort is never refused.


def state(diagram: str, name: str, **body: object) -> dict:
    response = client.post(
        f"/api/state?diagram={diagram}", json={"state": name, **body}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_the_machine_binds_to_the_drawings_valves() -> None:
    machine = client.get(f"/api/statemachine?diagram={diagram_id()}").json()
    assert machine["name"] == "diablo"
    assert "Fire" in machine["states"]
    # MV-OX is the LOX main however the drawing spells it. Getting this wrong
    # leaves a main valve uncommanded, and a fire opens one side only.
    assert machine["bound"]["LOX Main"] == "MVO"
    assert machine["bound"]["Fuel Main"] == "MVF"


def test_a_state_commands_exactly_what_the_table_says() -> None:
    diagram = diagram_id()
    machine = client.get(f"/api/statemachine?diagram={diagram}").json()
    for name in ("Idle", "Ready", "Fire"):
        frame = state(diagram, name)["frames"][0]
        for symbol, wanted in machine["positions"][name].items():
            assert frame["open"][symbol] is wanted, f"{name}/{symbol}"


def test_fire_opens_both_mains() -> None:
    frame = state(diagram_id(), "Fire")["frames"][0]
    assert frame["open"]["MVO"] and frame["open"]["MVF"]


def test_an_illegal_transition_is_refused_and_says_what_is_legal() -> None:
    """The API must not be a back door around the state machine the whole app
    is built on."""
    response = client.post(
        f"/api/state?diagram={diagram_id()}",
        json={"state": "Fire", "from": "Idle"},
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "Idle cannot go to Fire" in detail and "Armed" in detail


def test_an_abort_is_never_refused() -> None:
    """Asymmetric failure: a spurious abort path costs a confused moment, a
    missing one costs an abort."""
    for source in ("Idle", "Fire", "Ready"):
        response = client.post(
            f"/api/state?diagram={diagram_id()}",
            json={"state": "Emergency Abort", "from": source},
        )
        assert response.status_code == 200, source


def test_a_ragged_transition_table_is_reported_not_absorbed() -> None:
    """The DAQ's own CSV has short rows. Zipping them against the header shifts
    every column past the gap, which can silently delete an abort path."""
    machine = client.get(f"/api/statemachine?diagram={diagram_id()}").json()
    joined = " ".join(machine["warnings"])
    assert "wrong number of columns" in joined
    assert "Armed" in joined


def test_a_held_valve_beats_the_state() -> None:
    """Clicking a valve takes it by hand; changing state must not undo that."""
    result = state(diagram_id(), "Ready", forced={"MVO": 1})
    assert result["frames"][0]["open"]["MVO"] is True
    assert result["frames"][0]["open"]["MVF"] is False


def test_a_state_returns_frames_keyed_by_drawing_id() -> None:
    diagram = diagram_id()
    model = client.get(f"/api/model?diagram={diagram}").json()
    result = state(diagram, "Fire")
    assert result["converged"] is True
    assert len(result["frames"]) == 1
    ids = {s["id"] for s in model["symbols"]} | {ln["id"] for ln in model["lines"]}
    last = result["frames"][-1]
    assert set(last["node_psi"]) <= ids
    assert set(last["flow_kg_s"]) <= ids
    assert set(last["open"]) <= ids
    assert last["engine"] is None  # no engine attached


def test_turning_the_dome_control_regulator_moves_the_tanks() -> None:
    low = state(diagram_id(), "Fire", dome=350)
    high = state(diagram_id(), "Fire", dome=520)
    delta = high["frames"][-1]["node_psi"]["OXT"] - low["frames"][-1]["node_psi"]["OXT"]
    assert delta == pytest.approx(170.0, abs=20.0)


@pytest.mark.parametrize("fluid_set", ["hotfire", "cold-flow", "water-flow"])
def test_every_fluid_set_solves(fluid_set: str) -> None:
    response = client.post(
        f"/api/state?diagram={diagram_id()}&fluid_set={fluid_set}",
        json={"state": "Fire"},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["converged"] is True
    assert result["fluid_set"] == fluid_set


def test_cold_flow_differs_from_the_real_propellants() -> None:
    """LN2 is lighter than LOX and water heavier than ethanol, so the same
    hardware at the same pressure gives different flows on each leg."""

    def flow(fluid_set: str, branch: str) -> float:
        result = client.post(
            f"/api/state?diagram={diagram_id()}&fluid_set={fluid_set}",
            json={"state": "Fire"},
        ).json()
        return abs(result["frames"][-1]["flow_kg_s"][branch])

    assert flow("cold-flow", "MVO") < flow("hotfire", "MVO")
    assert flow("cold-flow", "MVF") > flow("hotfire", "MVF")


# -------------------------------------------------------------------- firing


def test_a_burn_is_as_long_as_you_ask_for() -> None:
    """There is no four-second cap. A burn is as long as the propellant lasts,
    and a UI that says otherwise is a cap somebody has to work around."""
    result = client.post(
        f"/api/fire?diagram={diagram_id()}",
        json={"duration": 30.0, "lead_in": 0.5, "sample_hz": 4},
    ).json()
    assert result["times_s"][-1] == pytest.approx(30.0, abs=0.5)
    assert result["times_s"][0] == pytest.approx(-0.5, abs=0.01)


def test_a_long_burn_drops_its_sample_rate_rather_than_its_length() -> None:
    """A shorter burn than asked for is a wrong answer; a coarser one is not."""
    result = client.post(
        f"/api/fire?diagram={diagram_id()}",
        json={"duration": 600.0, "lead_in": 0.0, "sample_hz": 50},
    ).json()
    assert result["times_s"][-1] == pytest.approx(600.0, abs=5.0)
    assert len(result["frames"]) <= 401
    assert result["controls"]["sample_hz"] < 50


def test_the_lead_in_shows_the_stand_before_ignition() -> None:
    result = client.post(
        f"/api/fire?diagram={diagram_id()}",
        json={"duration": 2.0, "lead_in": 1.0, "sample_hz": 4, "prefire": "Ready"},
    ).json()
    before = [f for f in result["frames"] if f["t"] < 0]
    after = [f for f in result["frames"] if f["t"] > 0.1]
    assert before and after
    assert all(not f["open"]["MVO"] for f in before)
    assert all(f["open"]["MVO"] for f in after)


# --------------------------------------------------------- the coupled engine


@needs_engine
def test_attaching_an_engine_couples_the_chamber() -> None:
    """Not a label: the injector face replaces a fixed pressure boundary."""
    diagram, motor = diagram_id(), engine_id()

    boundary = client.get(f"/api/model?diagram={diagram}").json()
    coupled = client.get(f"/api/model?diagram={diagram}&engine={motor}").json()
    assert boundary["report"]["coupled"] is False
    assert coupled["report"]["coupled"] is True
    # Two injector legs and a chamber node the boundary version does not have.
    assert coupled["report"]["branches"] > boundary["report"]["branches"]
    assert coupled["report"]["nodes"] > boundary["report"]["nodes"]


@needs_engine
def test_a_coupled_state_reports_the_whole_engine_state() -> None:
    result = client.post(
        f"/api/state?diagram={diagram_id()}&engine={engine_id()}",
        json={"state": "Fire"},
    ).json()
    assert result["converged"] is True
    engine = result["frames"][-1]["engine"]
    assert engine is not None
    assert 100.0 < engine["chamber_psi"] < 900.0
    assert engine["mdot_ox"] > 0.0 and engine["mdot_fuel"] > 0.0
    assert 1.0 < engine["mixture_ratio"] < 4.0
    assert 2500.0 < engine["chamber_temperature_K"] < 4000.0
    assert engine["thrust_N"] > 1000.0
    assert 150.0 < engine["isp_s"] < 350.0


@needs_engine
def test_the_chamber_sits_at_ambient_with_the_valves_shut() -> None:
    """A chamber is open to atmosphere through its own nozzle."""
    result = client.post(
        f"/api/state?diagram={diagram_id()}&engine={engine_id()}",
        json={"state": "Ready"},
    ).json()
    engine = result["frames"][0]["engine"]
    assert engine["chamber_psi"] == pytest.approx(
        0.0, abs=0.5
    )  # gauge: a cold chamber reads zero
    assert engine["thrust_N"] == 0.0


@needs_engine
def test_how_the_engine_resolved_its_own_disagreement_reaches_the_report() -> None:
    """The ethalox config carries its design point twice and they disagree.

    Intent wins on import -- see the importer -- and that is deliberately *not*
    a warning: a config being worked on disagrees with itself as a matter of
    course, and shouting about it on every healthy import is how people learn
    to skim past the warnings that matter.

    It still has to be visible. It rides on the report's assumptions, beside
    every other stated-versus-assumed number, which is where somebody goes to
    ask what this run actually used.
    """
    model = client.get(f"/api/model?diagram={diagram_id()}&engine={engine_id()}").json()
    engine_notes = {
        a["parameter"]: a
        for a in model["report"]["assumptions"]
        if a["component"] == "engine"
    }
    assert {"mixture_ratio", "design_chamber_pressure"} <= set(engine_notes)

    mr = engine_notes["mixture_ratio"]
    assert mr["value"] == pytest.approx(1.65)
    assert "2.55" in mr["reference"] and "intent wins" in mr["reference"]

    pc = engine_notes["design_chamber_pressure"]
    assert pc["value"] / 6894.757293168361 == pytest.approx(420.0, abs=0.5)
    assert "350" in pc["reference"]

    joined = " ".join(model["report"]["warnings"])
    assert "design_MR" not in joined, "the disagreement is provenance, not a warning"
