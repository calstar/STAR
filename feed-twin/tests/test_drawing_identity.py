"""What makes two drawings the same drawing, and two lineages the same one.

A drawing in the library is addressed by its bytes, and matched by what the
twin builds from (``main.drawing_digest``, D-52). These guard the edges of
that: the canvas's view state is not the drawing (R004); drawings whose
names differ by a browser's " (n)" are not one lineage (R005); a drawing's
overrides follow its lineage, not its name (R006).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.library import Library
from backend.overrides import OverrideStore
from tests.design_stores import Tools, stores, who  # noqa: F401  (fixture)

SAMPLE_DRAWING = Path(main.__file__).parent / "sample" / "le4-stand.json"
SHIPPED = Path(main.__file__).parent / "diagrams" / "ethalox_stand.json"

client = TestClient(main.app)


@pytest.fixture
def lib(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Library]:
    """A fresh, empty library behind the API, with its own override store."""
    fresh = Library(tmp_path / "library")
    monkeypatch.setattr(main, "library", fresh)
    monkeypatch.setattr(main, "overrides", OverrideStore(fresh.root / "overrides.json"))
    monkeypatch.setattr(main, "_UNBUILDABLE", {})
    yield fresh


def _upload(filename: str, payload: dict[str, Any]) -> str:
    answer = client.post(
        "/api/library/diagrams",
        files={"file": (filename, json.dumps(payload), "application/json")},
    )
    assert answer.status_code == 200, answer.text
    artifact: str = answer.json()["artifact"]["id"]
    return artifact


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


# ------------------------------------------------------------------ R011


def test_freshness_asks_the_newest_working_copy_pull(
    lib: Library, stores: Tools
) -> None:
    """A drawing first pulled as release 0.4, then pulled again as the
    working copy (the same drawing, so the same artifact with an alias), said
    "Release 0.4: a release never changes" after the working copy moved on:
    freshness asked the first pull, not the newest (R011)."""
    drawing = json.loads(SAMPLE_DRAWING.read_text("utf-8"))
    me = who("local")
    stores.pid.post("/api/pid/diagrams", json={"name": "le4-3"}, headers=me)
    stores.pid.post("/api/pid/diagrams/le4-3/autosave", json=drawing, headers=me)
    released = stores.pid.post(
        "/api/pid/diagrams/le4-3/release", json={"label": "0.4"}, headers=me
    )
    assert released.status_code == 200, released.text
    first = client.post(
        "/api/sources/pid-designer/import",
        json={"doc_id": "le4-3", "owner": "local", "release": "0.4", "name": "LE4"},
    ).json()["artifact"]
    again = client.post(
        "/api/sources/pid-designer/import",
        json={"doc_id": "le4-3", "owner": "local", "name": "LE4"},
    ).json()
    assert again["artifact"]["id"] == first["id"]

    moved = {**drawing, "nodes": drawing["nodes"][:-1]}
    stores.pid.post("/api/pid/diagrams/le4-3/autosave", json=moved, headers=me)
    fresh = client.get(f"/api/library/{first['id']}/freshness").json()
    assert fresh["current"] is False, fresh
    assert "local/le4-3" in fresh["detail"]


# ------------------------------------------------------------------ R005


def _named(hookup: dict[str, Any], pc: str) -> dict[str, Any]:
    """A hookup with the chamber channel renamed: something to tell it by."""
    return {**hookup, "aliases": {"engine.pc": pc}}


def test_uploads_a_browsers_suffix_apart_keep_their_own_hookups(lib: Library) -> None:
    """'LE4 (3)' (126 symbols) and 'LE4 (1)' (32) are different drawings in
    the team's library, but ' (n)' was stripped from an upload's lineage:
    both were 'name:LE4', the 32-symbol one ran the other's wiring, and a
    save on either rewired both (R005)."""
    three = _upload("LE4 (3).json", json.loads(SAMPLE_DRAWING.read_text("utf-8")))
    one = _upload("LE4 (1).json", json.loads(SHIPPED.read_text("utf-8")))

    suggested = client.get("/api/hookup", params={"diagram": three}).json()
    saved = client.put(
        "/api/hookup",
        params={"diagram": three},
        json=_named(suggested["hookup"], "LE4 (3) Pc"),
    )
    assert saved.status_code == 200, saved.text
    other = client.get("/api/hookup", params={"diagram": one}).json()
    assert other["saved"] is False, other["lineage"]

    mine = client.get("/api/hookup", params={"diagram": one}).json()["hookup"]
    client.put("/api/hookup", params={"diagram": one}, json=_named(mine, "LE4 (1) Pc"))
    kept = client.get("/api/hookup", params={"diagram": three}).json()
    assert kept["saved"] is True
    assert kept["hookup"]["aliases"] == {"engine.pc": "LE4 (3) Pc"}


def test_a_hookup_saved_under_the_stripped_name_is_read_only_where_it_fits(
    lib: Library,
) -> None:
    """Every upload's hookup was saved under its name less ' (n)'. It is
    still read -- by the drawing whose symbols it wires -- and left alone by
    one it does not fit, which runs the suggestion and says why. Saving or
    resetting either never touches it: it is every same-named upload's."""
    three = _upload("LE4 (3).json", json.loads(SAMPLE_DRAWING.read_text("utf-8")))
    one = _upload("LE4 (1).json", json.loads(SHIPPED.read_text("utf-8")))
    hookup = client.get("/api/hookup", params={"diagram": three}).json()["hookup"]
    old = _named(hookup, "saved before")
    lib.put_record(main.HOOKUPS, "name:LE4", {"hookup": old, "diagram": three})

    fits = client.get("/api/hookup", params={"diagram": three}).json()
    assert fits["saved"] is True and fits["lineage"] == "name:LE4"
    assert fits["hookup"]["aliases"] == {"engine.pc": "saved before"}

    other = client.get("/api/hookup", params={"diagram": one}).json()
    assert other["saved"] is False
    opened = client.post("/api/session", params={"diagram": one}, json={})
    assert opened.status_code == 200, opened.text
    assert any("name:LE4" in n for n in opened.json()["notes"]), opened.json()
    main._SESSIONS.pop(opened.json()["id"], None)

    mine = _named(other["hookup"], "LE4 (1) Pc")
    client.put("/api/hookup", params={"diagram": one}, json=mine)
    reset = client.delete("/api/hookup", params={"diagram": three}).json()
    assert reset["saved"] is False
    assert lib.record(main.HOOKUPS, "name:LE4") == {
        "key": "name:LE4",
        "hookup": old,
        "diagram": three,
    }


# ------------------------------------------------------------------ R006


def _moved(drawing: dict[str, Any], x: float) -> dict[str, Any]:
    """The drawing with its first symbol moved: another artifact."""
    first = {**drawing["nodes"][0], "position": {"x": x, "y": x}}
    return {**drawing, "nodes": [first, *drawing["nodes"][1:]]}


def _override(diagram: str, value: float) -> None:
    answer = client.put(
        "/api/drawing/override",
        json={
            "diagram": diagram,
            "element": "node_1",
            "parameter": "volume",
            "value": value,
            "unit": "L",
            "source": "measured",
            "reference": "water fill 2026-11-01",
        },
    )
    assert answer.status_code == 200, answer.text


def _overridden(diagram: str) -> list[tuple[str, str, float]]:
    report = client.get("/api/model", params={"diagram": diagram}).json()["report"]
    return [(o["component"], o["parameter"], o["value"]) for o in report["overrides"]]


def test_an_override_follows_the_document_into_a_release_pull(
    lib: Library, stores: Tools
) -> None:
    """A pull is named after its release ("LE4 (3) (0.4)") and overrides
    were kept by name: the measured COPV volume set on the working copy was
    gone from the release, while the hookup carried over -- and an unrelated
    upload that happened to be called "LE4 (3)" got it (R006)."""
    drawing = json.loads(SAMPLE_DRAWING.read_text("utf-8"))
    me = who("local")
    stores.pid.post("/api/pid/diagrams", json={"name": "le4-3"}, headers=me)
    stores.pid.post("/api/pid/diagrams/le4-3/autosave", json=drawing, headers=me)
    working = client.post(
        "/api/sources/pid-designer/import",
        json={"doc_id": "le4-3", "owner": "local", "name": "LE4 (3)"},
    ).json()["artifact"]["id"]
    _override(working, 5.5)

    edited = _moved(drawing, 40)
    stores.pid.post("/api/pid/diagrams/le4-3/autosave", json=edited, headers=me)
    stores.pid.post(
        "/api/pid/diagrams/le4-3/release", json={"label": "0.4"}, headers=me
    )
    release = client.post(
        "/api/sources/pid-designer/import",
        json={"doc_id": "le4-3", "owner": "local", "release": "0.4", "name": "LE4 (3)"},
    ).json()["artifact"]
    assert release["name"] == "LE4 (3) (0.4)" and release["id"] != working
    assert _overridden(release["id"]) == [("node_1", "volume", 5.5)]

    stranger = _upload("LE4 (3).json", _moved(drawing, 80))
    assert _overridden(stranger) == []


def test_an_override_kept_under_the_name_is_read_until_the_lineage_has_its_own(
    lib: Library,
) -> None:
    """The store held entries by name before R006. Such an entry is still
    what its drawing reads; a change starts the lineage's entry from it, and
    clearing that does not bring the name's back."""
    drawing = _upload("Legacy LE4.json", json.loads(SAMPLE_DRAWING.read_text("utf-8")))
    record = {"value": 4.0, "unit": "L", "source": "measured", "reference": "weighed"}
    main.overrides.put_entry("Legacy LE4", {"params": {"node_1": {"volume": record}}})
    assert _overridden(drawing) == [("node_1", "volume", 4.0)]

    _override(drawing, 4.2)
    assert _overridden(drawing) == [("node_1", "volume", 4.2)]
    gone = client.delete(
        "/api/drawing/override",
        params={"diagram": drawing, "element": "node_1", "parameter": "volume"},
    )
    assert gone.status_code == 200, gone.text
    assert _overridden(drawing) == []
    # The name's entry is left for whatever else still reads it.
    assert main.overrides.entry("Legacy LE4")["params"]["node_1"]["volume"] == record
