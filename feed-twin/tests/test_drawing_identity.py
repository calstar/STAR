"""What makes two drawings the same drawing, and two lineages the same one.

A drawing in the library is addressed by its bytes, and matched by what the
twin builds from (``main.drawing_digest``, D-52). These guard the edges of
that: the canvas's view state is not the drawing (R004).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.library import Library
from tests.design_stores import Tools, stores, who  # noqa: F401  (fixture)

SAMPLE_DRAWING = Path(main.__file__).parent / "sample" / "le4-stand.json"

client = TestClient(main.app)


@pytest.fixture
def lib(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Library]:
    """A fresh, empty library behind the API."""
    fresh = Library(tmp_path / "library")
    monkeypatch.setattr(main, "library", fresh)
    monkeypatch.setattr(main, "_UNBUILDABLE", {})
    yield fresh


def _exported(drawing: dict[str, Any]) -> dict[str, Any]:
    """The drawing as pid-designer's Export JSON writes it: React Flow's view
    state still on (the uploaded LE4 (3) carries ``measured`` on 36 of its
    126 nodes, ``hidden`` on 32, ``width``/``height``/``resizing`` on 7)."""
    nodes = [
        {
            **n,
            "measured": {"width": 60, "height": 40},
            "selected": i == 0,
            "hidden": i % 2 == 1,
            "dragging": False,
        }
        for i, n in enumerate(drawing["nodes"])
    ]
    edges = [
        {**e, "selected": False, "reconnectable": "target"} for e in drawing["edges"]
    ]
    return {"nodes": nodes, "edges": edges}


def _stored(drawing: dict[str, Any]) -> dict[str, Any]:
    """pid-designer's ``toStored``: what every save writes."""
    return {
        "nodes": [
            {
                k: v
                for k, v in n.items()
                if k not in ("selected", "dragging", "measured")
            }
            for n in drawing["nodes"]
        ],
        "edges": [
            {k: v for k, v in e.items() if k not in ("selected", "reconnectable")}
            for e in drawing["edges"]
        ],
    }


# ------------------------------------------------------------------ R004


def test_view_state_is_not_the_drawing() -> None:
    drawing = json.loads(SAMPLE_DRAWING.read_text("utf-8"))
    exported = _exported(drawing)
    assert main.drawing_digest(exported) == main.drawing_digest(drawing)
    assert main.drawing_digest(_stored(exported)) == main.drawing_digest(drawing)
    # What *is* the drawing still counts: a moved symbol, a changed number.
    moved = json.loads(SAMPLE_DRAWING.read_text("utf-8"))
    moved["nodes"][0]["position"] = {"x": -999, "y": -999}
    assert main.drawing_digest(moved) != main.drawing_digest(drawing)


def test_an_export_and_a_pull_of_one_drawing_are_one_artifact(
    lib: Library, stores: Tools
) -> None:
    """R004 (a): the LE4 (3) export, uploaded, and the same drawing pulled
    from pid-designer (saved through ``toStored``) were two "LE4 (3)"s, each
    with its own hookup lineage."""
    drawing = json.loads(SAMPLE_DRAWING.read_text("utf-8"))
    exported = _exported(drawing)
    upload = client.post(
        "/api/library/diagrams",
        files={"file": ("LE4 (3).json", json.dumps(exported), "application/json")},
    )
    assert upload.status_code == 200, upload.text

    me = who("local")
    made = stores.pid.post("/api/pid/diagrams", json={"name": "le4-3"}, headers=me)
    assert made.status_code == 200, made.text
    stores.pid.post(
        "/api/pid/diagrams/le4-3/autosave", json=_stored(exported), headers=me
    )
    pulled = client.post(
        "/api/sources/pid-designer/import",
        json={"doc_id": "le4-3", "owner": "local", "name": "le4-3"},
    )
    assert pulled.status_code == 200, pulled.text
    assert pulled.json()["already_present"] is True
    assert pulled.json()["artifact"]["id"] == upload.json()["artifact"]["id"]
    assert len(lib.list("diagram")) == 1


def test_an_editor_save_that_changes_no_symbol_keeps_a_pull_current(
    lib: Library, stores: Tools
) -> None:
    """R004 (b): a pid doc seeded with the library's bytes (``measured``
    included), pulled, then saved by the editor -- a click, or a move and an
    undo -- read "changed since this was pulled"."""
    drawing = json.loads(SAMPLE_DRAWING.read_text("utf-8"))
    exported = _exported(drawing)
    me = who("local")
    stores.pid.post("/api/pid/diagrams", json={"name": "seed"}, headers=me)
    stores.pid.post("/api/pid/diagrams/seed/autosave", json=exported, headers=me)
    pulled = client.post(
        "/api/sources/pid-designer/import",
        json={"doc_id": "seed", "owner": "local", "name": "seed"},
    ).json()["artifact"]

    stores.pid.post(
        "/api/pid/diagrams/seed/autosave", json=_stored(exported), headers=me
    )
    fresh = client.get(f"/api/library/{pulled['id']}/freshness").json()
    assert fresh["current"] is True, fresh
