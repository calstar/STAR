"""A first run, the library's housekeeping, and how the API says no.

The sample stand (backend/sample/) is what an empty library opens on, and it
is featured wherever its drawing and engine are, under any name (D-08,
D-15, D-46). A removed shipped drawing stays removed (D-78). The same drawing
pulled and uploaded is one artifact (D-52). A drawing that cannot be built is
said plainly and leaves nothing half built on the server (D-14). Every
refusal is one sentence (C3).

Each test runs on a library of its own: the sample's engine, once in the
shared test library, would be the "first engine" every session test fires.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import designtools, main
from backend.library import Library

SHIPPED = Path(main.__file__).parent / "diagrams" / "ethalox_stand.json"
SAMPLE_DRAWING = Path(main.__file__).parent / "sample" / "le4-stand.json"


@pytest.fixture
def lib(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Library]:
    """A fresh, empty library behind the API, with startup's warm-up off."""
    fresh = Library(tmp_path / "library")
    monkeypatch.setattr(main, "library", fresh)
    monkeypatch.setattr(main, "_warm", lambda: None)
    monkeypatch.setattr(main, "_FIRST_RUN", False)
    monkeypatch.setattr(main, "_UNBUILDABLE", {})
    yield fresh


client = TestClient(main.app)


def _names(rows: list[dict]) -> set[str]:
    return {r["name"] for r in rows}


# ------------------------------------------------------------------ sample


def test_an_empty_library_gets_the_sample_stand_at_startup(lib: Library) -> None:
    """D-15: a library with no drawing used to hang the console forever."""
    assert lib.list("diagram") == []
    with TestClient(main.app) as started:
        rows = started.get("/api/library").json()
    featured = [r for r in rows if r["featured"]]
    assert {(r["kind"], r["name"]) for r in featured} == {
        ("diagram", "LE4 stand"),
        ("engine", "Ethalox 7200N Doublet"),
    }
    engine = next(r for r in featured if r["kind"] == "engine")
    # D-46: the engine arrives with EngineDesign's card, not the simplified one.
    assert engine["card"], "the sample engine should carry its EngineDesign card"
    # Provenance travels with it.
    assert all("artifact" in r["notes"] for r in featured)


def test_a_library_with_drawings_is_not_seeded_at_startup(lib: Library) -> None:
    main._seed(revive=True)
    with TestClient(main.app) as started:
        rows = started.get("/api/library").json()
    assert not any(r["source"].startswith("sample:") for r in rows)


def test_loading_the_sample_is_idempotent(lib: Library) -> None:
    first = client.post("/api/library/sample")
    assert first.status_code == 200, first.text
    again = client.post("/api/library/sample").json()
    assert sorted(r["id"] for r in first.json()) == sorted(r["id"] for r in again)
    assert len(lib.list()) == 2


def test_the_sample_is_featured_under_any_name(lib: Library) -> None:
    """D-08: the team's own copy, uploaded as "LE4 (6)", is the featured
    stand, so a fresh browser opens on it rather than on the newest import."""
    upload = client.post(
        "/api/library/diagrams",
        files={
            "file": ("LE4 (6).json", SAMPLE_DRAWING.read_bytes(), "application/json")
        },
    ).json()["artifact"]
    other = client.post(
        "/api/library/diagrams",
        files={
            "file": ("Imported Stand.json", SHIPPED.read_bytes(), "application/json")
        },
    ).json()["artifact"]
    rows = {r["id"]: r for r in client.get("/api/library").json()}
    assert rows[upload["id"]]["featured"] is True
    assert rows[other["id"]]["featured"] is False
    # Loading the sample on top makes no second copy of the drawing.
    client.post("/api/library/sample")
    drawings = [r for r in client.get("/api/library?kind=diagram").json()]
    assert [r["id"] for r in drawings if r["featured"]] == [upload["id"]]


# -------------------------------------------------------------- tombstones


def test_a_removed_shipped_drawing_stays_removed(lib: Library) -> None:
    """D-78: every restart put the removed shipped drawings back."""
    main._seed(revive=True)
    stand = next(a for a in lib.list("diagram") if a.name == "Ethalox Stand")
    assert client.delete(f"/api/library/{stand.id}").status_code == 200
    main._seed()  # what the next start runs
    assert "Ethalox Stand" not in {a.name for a in lib.list("diagram")}
    main._seed(revive=True)
    assert "Ethalox Stand" in {a.name for a in lib.list("diagram")}


def test_a_removed_sample_is_not_seeded_again_until_asked(lib: Library) -> None:
    client.post("/api/library/sample")
    for artifact in lib.list():
        client.delete(f"/api/library/{artifact.id}")
    with TestClient(main.app) as started:  # a restart on the emptied library
        assert started.get("/api/library").json() == []
        # Asking for it is the one thing that brings it back.
        rows = started.post("/api/library/sample").json()
    assert _names(rows) == {"LE4 stand", "Ethalox 7200N Doublet"}


# ------------------------------------------------------------ one drawing


@pytest.fixture
def pid_designer() -> Iterator[dict]:
    """pid-designer, stubbed: serves ``doc["drawing"]`` as document le4-stand."""
    doc = {"drawing": json.loads(SAMPLE_DRAWING.read_bytes())}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/load"):
            return httpx.Response(200, json=doc["drawing"])
        return httpx.Response(200, json=[])

    designtools.transport = httpx.MockTransport(handler)
    yield doc
    designtools.transport = None


def test_the_same_drawing_pulled_is_the_one_already_uploaded(
    lib: Library, pid_designer: dict
) -> None:
    """D-52: a pull is re-serialised, so it used to land beside the upload as
    a second artifact with the same drawing and another name."""
    upload = client.post(
        "/api/library/diagrams",
        files={
            "file": ("LE4 (6).json", SAMPLE_DRAWING.read_bytes(), "application/json")
        },
    ).json()["artifact"]
    pulled = client.post(
        "/api/sources/pid-designer/import",
        json={"doc_id": "le4-stand", "owner": "local", "name": "LE4 Stand"},
    )
    assert pulled.status_code == 200, pulled.text
    assert pulled.json()["already_present"] is True
    assert pulled.json()["artifact"]["id"] == upload["id"]
    assert pulled.json()["artifact"]["name"] == "LE4 (6)"
    assert len(lib.list("diagram")) == 1
    # The pull is remembered, and the upload's freshness is now the pull's.
    row = client.get("/api/library").json()[0]
    assert row["aliases"] == ["pid-designer:local/le4-stand@working copy"]
    fresh = client.get(f"/api/library/{upload['id']}/freshness").json()
    assert fresh["tracked"] is True and fresh["current"] is True
    # Moved in pid-designer: no longer current.
    pid_designer["drawing"]["nodes"] = pid_designer["drawing"]["nodes"][:-1]
    fresh = client.get(f"/api/library/{upload['id']}/freshness").json()
    assert fresh["current"] is False


def test_an_upload_with_other_formatting_is_the_same_drawing(lib: Library) -> None:
    first = client.post(
        "/api/library/diagrams",
        files={"file": ("a.json", SAMPLE_DRAWING.read_bytes(), "application/json")},
    ).json()
    compact = json.dumps(json.loads(SAMPLE_DRAWING.read_bytes())).encode()
    second = client.post(
        "/api/library/diagrams",
        files={"file": ("b.json", compact, "application/json")},
    ).json()
    assert second["already_present"] is True
    assert second["artifact"]["id"] == first["artifact"]["id"]


# ------------------------------------------------- a drawing that cannot run


#: What the September "LE4" sketch's open answers: a COPV drawn as a TANK.
WARM_NITROGEN = (
    "TK-1 holds nitrogen at 293 K, above its critical temperature (126 K), so "
    "it cannot be a liquid and a TANK has nothing to start from."
)


def test_a_drawing_that_cannot_run_says_so_and_leaves_nothing_behind(
    lib: Library, monkeypatch: pytest.MonkeyPatch
) -> None:
    """D-14: the console kept the last drawing up, RUNNING, after a 422."""
    main._seed(revive=True)
    stand = next(a for a in lib.list("diagram") if a.name == "Ethalox Stand")

    def cannot_start(*args: object, **kwargs: object) -> None:
        raise main.AssemblyError("tank", WARM_NITROGEN)

    monkeypatch.setattr(main, "Session", cannot_start)
    before = set(main._SESSIONS)
    opened = client.post(f"/api/session?diagram={stand.id}", json={"state": "Idle"})
    assert opened.status_code == 422
    detail = opened.json()["detail"]
    assert isinstance(detail, str) and "critical temperature" in detail
    assert set(main._SESSIONS) == before
    # The Library badges it for whoever looks next (D-47).
    row = next(r for r in client.get("/api/library").json() if r["id"] == stand.id)
    assert "critical temperature" in row["problem"]


def test_a_stand_whose_first_frame_fails_is_not_kept(
    lib: Library, monkeypatch: pytest.MonkeyPatch
) -> None:
    main._seed(revive=True)
    stand = next(a for a in lib.list("diagram") if a.name == "Ethalox Stand")

    def broken(self: object, dt: float) -> None:
        raise ValueError("the first frame did not solve")

    monkeypatch.setattr(main.Session, "step", broken)
    before = set(main._SESSIONS)
    quiet = TestClient(main.app, raise_server_exceptions=False)
    opened = quiet.post(f"/api/session?diagram={stand.id}", json={"state": "Idle"})
    assert opened.status_code == 500
    assert opened.json() == {
        "detail": "The twin could not finish that: the first frame did not solve."
    }
    assert set(main._SESSIONS) == before


# --------------------------------------------------------------- refusals


def test_a_request_that_cannot_be_read_is_one_sentence() -> None:
    """C3: FastAPI's [{loc, msg, type}] list showed as [object Object]."""
    answer = client.post("/api/session")
    assert answer.status_code == 422
    assert answer.json() == {
        "detail": "That request could not be read: diagram is missing."
    }
    wrong = client.get("/api/session/x/history?seconds=lots")
    assert isinstance(wrong.json()["detail"], str)
    assert wrong.json()["detail"].startswith(
        "That request could not be read: seconds should"
    )


def test_every_refusal_is_a_sentence() -> None:
    assert client.get("/api/nowhere").json() == {"detail": "Nothing at /api/nowhere."}
    assert client.get("/api/library?kind=x").json() == {
        "detail": "Kind is 'diagram' or 'engine'."
    }


def test_details_of_any_shape_flatten_to_one_sentence() -> None:
    from backend.errors import flatten

    assert flatten(
        [
            {
                "loc": ["body", "dome"],
                "msg": "Input should be a valid number",
                "type": "x",
            }
        ]
    ) == ("Dome should be a valid number.")
    assert flatten({"detail": "no such stand"}) == "No such stand."
    assert flatten("node_12 is shut") == "node_12 is shut."
    assert flatten("OV-MOT is not wired.") == "OV-MOT is not wired."
