"""The cockpit fires EngineDesign's engine, and says what it fired.

Fired through the same LE4 drawing, feedtwin's simplified engine and
EngineDesign's disagreed by ~5 % in thrust and ~11 % in impulse, and the
cockpit -- flying the simplified one, from a three-week-old copy of the design
-- could never agree with Layer X. Now an engine imported from EngineDesign
brings its engine card, the stand fires it, and the page says which engine it
is and whether EngineDesign has moved on since.

EngineDesign is a stub transport here (``backend.designtools.transport``): what
is asserted is what feed-twin asks for and what it does with the answer.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
import yaml
from fastapi.testclient import TestClient

from backend import designtools
from backend.assembly import SIMPLIFIED_ENGINE
from backend.main import _SESSIONS, app, library
from feedtwin.engine import ChamberCard, EngineCard, InjectorCard, Table2D
from feedtwin.engine.importer import engine_from_config
from feedtwin.session.burn import find_probes
from feedtwin.session.report import burns

client = TestClient(app)
CONFIG = (
    Path(__file__).resolve().parents[2]
    / "EngineDesign"
    / "configs"
    / "ethalox_doublet_7000N.yaml"
)
STAND = (
    Path(__file__).resolve().parents[1] / "backend" / "diagrams" / "ethalox_stand.json"
)

pytestmark = pytest.mark.skipif(
    not CONFIG.exists(), reason="EngineDesign configs absent"
)


def _flat(value: float, x: tuple[float, float], y: tuple[float, float]) -> Table2D:
    return Table2D(
        x[0], x[1] - x[0], 2, y[0], y[1] - y[0], 2, ((value, value), (value, value))
    )


def a_card(throat: float) -> EngineCard:
    """Constant tables: c* 1520 m/s, v_vac 2550 m/s, phi 1.6e-3 a side."""
    box = ((0.0, 0.0), (100.0, 0.0), (100.0, 1e8), (0.0, 1e8))
    inj = InjectorCard(_flat(1.6e-3, (0.0, 5.0), (1e5, 1e7)), hull=box)
    chamber = ChamberCard(
        _flat(1520.0, (0.5, 3.0), (0.1, 6.0)),
        _flat(2550.0, (0.5, 3.0), (0.1, 6.0)),
        hull=((0.5, 0.1), (3.0, 0.1), (3.0, 6.0), (0.5, 6.0)),
    )
    return EngineCard(
        "stub",
        throat,
        8.7e-3,
        inj,
        replace(inj),
        chamber,
        provenance={"ambient_pa_sampled": 94070.0, "built": 1.0},
    )


def config_bytes(tag: str) -> bytes:
    """The 7000N config under a tag of its own: different bytes, so a different
    artifact, so a card attached here never leaks into another test's engine."""
    return f"# {tag}\n".encode() + CONFIG.read_bytes()


@pytest.fixture
def engine_design() -> list[httpx.Request]:
    """A reachable EngineDesign: builds a card on request, serves its documents."""
    seen: list[httpx.Request] = []
    throat = engine_from_config(
        yaml.safe_load(CONFIG.read_text()), name="x"
    ).throat_area
    current = {"config": yaml.safe_load(CONFIG.read_text())}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/layerx/engine-card":
            return httpx.Response(
                200,
                json={
                    "card": a_card(throat).to_dict(),
                    "config_sha256": "stub",
                    "center_psia": 578.0,
                    "ambient_pa": 94070.0,
                    "within_tolerance": True,
                    "envelope_worst": 7e-4,
                },
            )
        if request.url.path.endswith("/load"):
            return httpx.Response(200, json=current)
        return httpx.Response(404)

    designtools.transport = httpx.MockTransport(handler)
    yield seen
    designtools.transport = None


def upload(tag: str) -> dict:
    response = client.post(
        "/api/library/engines",
        files={"file": (f"{tag}.yaml", config_bytes(tag), "application/x-yaml")},
    )
    assert response.status_code == 200, response.text
    return response.json()


def stand() -> str:
    response = client.post(
        "/api/library/diagrams",
        files={"file": (STAND.name, STAND.read_bytes(), "application/json")},
    )
    return response.json()["artifact"]["id"]


def model(engine: str, fluid_set: str = "hotfire") -> dict:
    response = client.get(
        "/api/model",
        params={"diagram": stand(), "engine": engine, "fluid_set": fluid_set},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_an_engine_imported_with_enginedesign_reachable_fires_its_card(
    engine_design: list[httpx.Request],
) -> None:
    imported = upload("card")
    engine = imported["artifact"]["id"]
    try:
        assert imported["card_error"] == ""
        assert [r.url.path for r in engine_design] == ["/api/layerx/engine-card"]
        sent = json.loads(engine_design[0].read())["yaml"].encode()
        assert sent == config_bytes(
            "card"
        ), "EngineDesign is sent the engine's own bytes"
        assert imported["artifact"]["card"]["card_within_tolerance"] is True

        view = model(engine)
        assert view["engine"]["engine_model"] == "card"
        assert SIMPLIFIED_ENGINE not in view["report"]["warnings"]

        # A cold flow burns nothing: a card is the engine burning, so it is not fired.
        cold = model(engine, "cold-flow")
        assert cold["engine"]["engine_model"] == "simplified"
        assert SIMPLIFIED_ENGINE not in cold["report"]["warnings"]
    finally:
        library.remove(engine)


def test_without_enginedesign_the_engine_is_the_simplified_one_and_says_so() -> None:
    imported = upload("nocard")
    engine = imported["artifact"]["id"]
    try:
        assert "EngineDesign" in imported["card_error"]
        assert imported["artifact"]["card"] == {}
        view = model(engine)
        assert view["engine"]["engine_model"] == "simplified"
        assert SIMPLIFIED_ENGINE in view["report"]["warnings"]
    finally:
        library.remove(engine)


def test_a_stored_card_that_cannot_be_read_is_not_reported_as_no_card() -> None:
    """A broken attachment sends whoever reads the report to it, not off to build
    a card the engine already has."""
    imported = upload("brokencard")
    engine = imported["artifact"]["id"]
    try:
        library.attach(engine, "card", b'{"card": {"truncated')
        view = model(engine)
        assert view["engine"]["engine_model"] == "simplified"
        assert view["engine"]["why"] == "card unreadable"
        warnings = view["report"]["warnings"]
        assert SIMPLIFIED_ENGINE not in warnings
        assert any("could not be read" in w for w in warnings), warnings
    finally:
        library.remove(engine)


def test_a_pulled_engine_knows_when_enginedesign_has_moved_on(
    engine_design: list[httpx.Request],
) -> None:
    stale = config_bytes("last month")
    old, _ = library.add(
        stale,
        kind="engine",
        name="Doublet",
        suffix=".yaml",
        source="engine-design:local/doublet@working copy",
    )
    fresh = None
    try:
        answer = client.get(f"/api/library/{old.id}/freshness").json()
        assert answer["tracked"] is True and answer["current"] is False

        refreshed = client.post(f"/api/library/{old.id}/refresh").json()
        fresh = refreshed["artifact"]["id"]
        assert fresh != old.id, "a refresh is a new artifact; the old one stays"
        assert library.get(old.id)
        assert refreshed["artifact"]["card"], "and it comes with its card"
        assert client.get(f"/api/library/{fresh}/freshness").json()["current"] is True
    finally:
        library.remove(old.id)
        if fresh:
            library.remove(fresh)


def test_an_uploaded_engine_has_nothing_to_be_fresh_against() -> None:
    imported = upload("uploaded")
    try:
        answer = client.get(
            f"/api/library/{imported['artifact']['id']}/freshness"
        ).json()
        assert answer["tracked"] is False
    finally:
        library.remove(imported["artifact"]["id"])


def test_sources_parse_back_to_what_was_fetched() -> None:
    assert designtools.parse_source("engine-design:local/doublet@working copy") == (
        "engine-design",
        "local",
        "doublet",
        "",
    )
    assert designtools.parse_source(
        "pid-designer:aidan@x.edu/ox-stand@release 0.3"
    ) == ("pid-designer", "aidan@x.edu", "ox-stand", "0.3")
    assert designtools.parse_source("upload") is None
    assert designtools.parse_source("shipped:ethalox_stand.json") is None


def test_a_burn_is_totalled_and_the_engine_is_plotted(
    engine_design: list[httpx.Request],
) -> None:
    """Fire, and the burn comes back totalled -- the library's arithmetic on the
    session's own samples -- with the engine's channels on the history."""
    engine = upload("burn")["artifact"]["id"]
    try:
        opened = client.post(
            "/api/session",
            params={"diagram": stand(), "engine": engine},
            json={"state": "Idle"},
        ).json()
        session = _SESSIONS[opened["id"]]
        session.prime(
            tank_psi=550.0,
            copv_psi=4500.0,
            state="Ready",
            loads={"OXT": 6.0, "FUT": 4.0},
        )
        client.post(
            f"/api/session/{session.id}/tick", json={"dt": 0.1}
        )  # Ready, at T-0
        client.post(f"/api/session/{session.id}/command", json={"state": "Fire"})
        for _ in range(15):
            client.post(f"/api/session/{session.id}/tick", json={"dt": 0.02})

        answer = client.get(f"/api/session/{session.id}/burns").json()
        assert answer["engine_model"] == "card"
        (burn,) = answer["burns"]
        assert burn["burning"] and burn["impulse_Ns"] > 0.0
        (own,) = burns(list(session.history), find_probes(session).injector_inlet)
        assert burn["impulse_Ns"] == pytest.approx(own.impulse_Ns, abs=0.1)
        assert burn["stiffness_oxidiser_min"] > 0.0
        loads = {"TK-LOX": 6.0, "TK-FUEL": 4.0}
        for tank in burn["tanks"]:
            assert tank["start_kg"] == pytest.approx(loads[tank["label"]], abs=0.01)
            assert tank["end_kg"] < tank["start_kg"]
            assert 400.0 < tank["min_psi"] <= tank["start_psi"] + 1.0

        history = client.get(f"/api/session/{session.id}/history").json()
        engine_channels = {
            c["tag"]: c for c in history["channels"] if c["id"].startswith("engine.")
        }
        assert set(engine_channels) == {"PC", "Thrust", "O/F", "LOX flow", "Fuel flow"}
        assert max(engine_channels["Thrust"]["values"]) == pytest.approx(
            burn["thrust_peak_N"], abs=0.1
        )
        assert all(
            len(c["values"]) == len(history["times_s"])
            for c in engine_channels.values()
        )
    finally:
        library.remove(engine)
