"""The API, against the real drawing and the real engine config.

Import, assemble, run. The tests follow the same three verbs a user does, and
check the properties that make the result mean something: that the assembly
reports what it invented, that the ids in a frame are the ids on the drawing,
and that attaching an engine actually changes the physics rather than adding a
label.
"""

from __future__ import annotations

import json
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


def test_the_schematic_is_handed_the_drawing_as_saved() -> None:
    """Not a projection of it: pid-designer's canvas draws the document, and
    every presentation field it needs -- ports, rotation, routed corners -- is
    only there if nothing on the way dropped it."""
    from backend.main import library

    diagram = diagram_id()
    served = client.get(f"/api/diagram?diagram={diagram}").json()
    saved = json.loads(library.read(diagram))
    assert served == {"nodes": saved["nodes"], "edges": saved["edges"]}


def test_the_drawing_of_nothing_is_a_404() -> None:
    assert client.get("/api/diagram?diagram=deadbeef1234").status_code == 404


@needs_engine
def test_an_engine_is_not_a_drawing() -> None:
    assert client.get(f"/api/diagram?diagram={engine_id()}").status_code == 422


def test_the_model_names_every_valve_the_console_drives() -> None:
    model = client.get(f"/api/model?diagram={diagram_id()}").json()
    # Every solenoid and rotary on the drawing, not just the mains: the stand
    # carries press, vent and fill valves and the console has to be able to
    # drive all of them.
    tags = {a["tag"] for a in model["actuators"]}
    assert {"MV-OX", "MV-FU", "SV-LOX-PRESS", "SV-FUEL-PRESS"} <= tags
    assert all(t.startswith(("MV-", "SV-")) for t in tags)


def test_the_model_says_which_sheet_everything_is_on() -> None:
    """The console splits its panels by sheet, so the model has to say."""
    shipped = client.get(f"/api/model?diagram={diagram_id()}").json()
    # A one-sheet drawing: everything on Main.
    assert set(shipped["pages"].values()) == {"Main"}

    # The same stand drawn as Rocket and GSE.
    blob = client.get(f"/api/diagram?diagram={diagram_id()}").json()
    for n in blob["nodes"]:
        n.setdefault("data", {})["page"] = "GSE" if n["id"] == "KB1" else "Rocket"
    made = client.post(
        "/api/library/diagrams",
        files={
            "file": ("two-sheet.json", json.dumps(blob).encode(), "application/json")
        },
    ).json()["artifact"]["id"]
    try:
        pages = client.get(f"/api/model?diagram={made}").json()["pages"]
        assert pages["KB1"] == "GSE"
        assert pages["SV_LOX_PRESS"] == "Rocket"
        # The engine's own chamber channel is not drawn; it goes with the engine.
        assert pages["engine.pc"] == pages["ENG"] == "Rocket"
    finally:
        client.delete(f"/api/library/{made}")


def test_an_unknown_artifact_is_a_422_not_a_500() -> None:
    response = client.get("/api/model?diagram=deadbeef1234")
    assert response.status_code == 422
    assert "no artifact" in response.json()["detail"]


# ------------------------------------------------------- the state machine
#
# The stand is not a timeline any more, it is a state machine -- the same two
# CSVs the DAQ's firmware and GUI both read. It runs on a session, as the
# console runs it: an illegal move refused and an abort never refused are the
# session's (tests/test_session_api.py, tests/test_statemachine.py), and every
# valve where the table says, the operator walks' (tests/test_operator_walks.py).


def test_the_machine_binds_to_the_drawings_valves() -> None:
    machine = client.get(f"/api/statemachine?diagram={diagram_id()}").json()
    assert machine["name"] == "diablo"
    assert "Fire" in machine["states"]
    # MV-OX is the LOX main however the drawing spells it. Getting this wrong
    # leaves a main valve uncommanded, and a fire opens one side only.
    assert machine["bound"]["LOX Main"] == "MVO"
    assert machine["bound"]["Fuel Main"] == "MVF"


def test_a_ragged_transition_table_is_reported_not_absorbed() -> None:
    """The DAQ's own CSV has short rows. Zipping them against the header shifts
    every column past the gap, which can silently delete an abort path."""
    machine = client.get(f"/api/statemachine?diagram={diagram_id()}").json()
    joined = " ".join(machine["warnings"])
    assert "wrong number of columns" in joined
    assert "Armed" in joined


# -------------------------------------------------------------------- firing
#
# On a session, from T-0, the way the console fires. Until 2026-10-08 these ran
# on a frozen-stand endpoint (``POST /api/state``, ``/api/fire``) that nothing
# else called, and that held the tanks at dome + bias.


def session(diagram: str, engine: str = "", fluid_set: str = "hotfire") -> str:
    """A session at T-0: loaded, charged, at lockup, in Ready."""
    opened = client.post(
        "/api/session",
        params={"diagram": diagram, "engine": engine, "fluid_set": fluid_set},
        json={"state": "Idle"},
    )
    assert opened.status_code == 200, opened.text
    sid: str = opened.json()["id"]
    t0 = client.post(f"/api/session/{sid}/t0")
    assert t0.status_code == 200, t0.text
    return sid


def fire(sid: str, seconds: float = 0.5) -> dict:
    """Fire, and the frame ``seconds`` into it."""
    response = client.post(f"/api/session/{sid}/command", json={"state": "Fire"})
    assert response.status_code == 200, response.text
    frame: dict = response.json()
    for _ in range(round(seconds / 0.1)):
        frame = client.post(f"/api/session/{sid}/tick", json={"dt": 0.1}).json()
    return frame


def test_a_frame_is_keyed_by_drawing_id() -> None:
    diagram = diagram_id()
    drawing = client.get(f"/api/diagram?diagram={diagram}").json()
    frame = fire(session(diagram))
    assert frame["converged"] is True
    ids = {n["id"] for n in drawing["nodes"]} | {e["id"] for e in drawing["edges"]}
    assert set(frame["node_psi"]) <= ids
    assert set(frame["flow_kg_s"]) <= ids
    assert set(frame["open"]) <= ids
    assert frame["open"]["MVO"] and frame["open"]["MVF"], "Fire opens both mains"
    assert frame["engine"] is None  # no engine attached


def mains_flow(fluid_set: str) -> tuple[float, float]:
    frame = fire(session(diagram_id(), fluid_set=fluid_set))
    assert frame["converged"] is True
    return abs(frame["flow_kg_s"]["MVO"]), abs(frame["flow_kg_s"]["MVF"])


@pytest.mark.parametrize("fluid_set", ["hotfire", "cold-flow", "water-flow"])
def test_every_fluid_set_fires(fluid_set: str) -> None:
    lox, fuel = mains_flow(fluid_set)
    assert lox > 0.0 and fuel > 0.0


def test_cold_flow_differs_from_the_real_propellants() -> None:
    """LN2 is lighter than LOX and water heavier than ethanol, so the same
    hardware at the same pressure gives different flows on each leg."""
    hot, cold = mains_flow("hotfire"), mains_flow("cold-flow")
    assert cold[0] < hot[0]
    assert cold[1] > hot[1]


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
def test_a_shut_engine_reads_ambient_and_a_lit_one_reads_sane() -> None:
    """A chamber is open to atmosphere through its own nozzle until propellant
    arrives; lit, every reading on the engine card is in a sane range."""
    sid = session(diagram_id(), engine_id())
    ready = client.post(f"/api/session/{sid}/tick", json={"dt": 0.1}).json()
    shut = ready["engine"]
    assert shut["chamber_psi"] == pytest.approx(0.0, abs=0.5)  # gauge: cold is 0
    assert shut["thrust_N"] == 0.0

    lit = fire(sid)
    assert lit["converged"] is True
    engine = lit["engine"]
    assert 100.0 < engine["chamber_psi"] < 900.0
    assert engine["mdot_ox"] > 0.0 and engine["mdot_fuel"] > 0.0
    assert 1.0 < engine["mixture_ratio"] < 4.0
    assert 2500.0 < engine["chamber_temperature_K"] < 4000.0
    assert engine["thrust_N"] > 1000.0
    assert 150.0 < engine["isp_s"] < 350.0


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
