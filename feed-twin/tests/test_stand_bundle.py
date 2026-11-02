"""A stand exported as one file, and imported onto a server that has none of it.

``backend.bundle``: the bundle carries the drawing, the engine and its card, the
state table, the drawing's overrides and the hookup the stand runs on, so the
import rebuilds the same library ids and the same stand. "A server that has none
of it" is this library with every one of those removed first.
"""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from backend import bundle
from backend.assembly import card_version
from backend.library import LibraryError
from tests.design_stores import Tools, stores, who  # noqa: F401  (fixture)
from backend.main import (
    HOOKUPS,
    _drawing_key,
    _hookup_lineage,
    app,
    library,
    overrides,
)

SAMPLE = Path(__file__).resolve().parents[1] / "backend" / "sample"
client = TestClient(app)
MADE: list[str] = []
NAMES: list[str] = []


@pytest.fixture(autouse=True)
def tidy() -> Iterator[None]:
    yield
    for name in NAMES:
        overrides.put_entry(name, {})
    NAMES.clear()
    for artifact in dict.fromkeys(MADE):
        try:
            library.remove(artifact)
        except LibraryError:
            pass
    MADE.clear()


def _upload(path: Path, route: str, name: str) -> str:
    response = client.post(
        route, files={"file": (name, path.read_bytes(), "text/plain")}
    )
    assert response.status_code == 200, response.text
    artifact: str = response.json()["artifact"]["id"]
    MADE.append(artifact)
    return artifact


def _stand() -> tuple[dict[str, Any], str]:
    """A stand on the sample drawing and engine, with something in every part."""
    drawing = _upload(
        SAMPLE / "le4-stand.json", "/api/library/diagrams", "bundle LE4.json"
    )
    engine = _upload(
        SAMPLE / "ethalox-doublet.yaml", "/api/library/engines", "bundle engine.yaml"
    )
    library.attach(engine, "card", (SAMPLE / "ethalox-doublet.card.json").read_bytes())
    # What its overrides are kept under: its lineage ("name:bundle LE4").
    name = _drawing_key(drawing)
    NAMES.append(name)
    overrides.put_entry(
        name,
        {
            "params": {
                "node_1": {
                    "volume": {
                        "value": 4.6871,
                        "unit": "L",
                        "source": "measured",
                        "reference": "weighed",
                        "by": "test",
                        "at": "now",
                        "was": None,
                    }
                }
            },
            "console_hidden": {"node_63": {"by": "test", "at": "now"}},
        },
    )
    stand = {
        "diagram": drawing,
        "engine": engine,
        "fluid_set": "hotfire",
        "machine": "diablo",
        "setup": {"pressurant": "helium", "dome": 535.0},
        "hookup": {},
        "operating_point": {"knobs": {"DOME": 535.0}},
        "console": {"order": {"pts": ["node_2"]}},
        "notes": "the bundle test stand",
    }
    return stand, name


def _export(stand: dict[str, Any], name: str = "Bundle test") -> dict[str, Any]:
    response = client.post(
        "/api/twin/bundle/export", json={"name": name, "stand": stand}
    )
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


def _forget(stand: dict[str, Any], name: str) -> None:
    """This server no longer has anything the stand names."""
    library.remove(stand["engine"])
    library.remove(stand["diagram"])
    overrides.put_entry(name, {})


def test_an_export_carries_everything_the_stand_names() -> None:
    stand, name = _stand()
    out = _export(stand)
    assert out["format"] == bundle.FORMAT and out["version"] == bundle.VERSION
    # The exact bytes, so an import rebuilds the same ids.
    assert out["drawing"]["text"].encode("utf-8") == library.read(stand["diagram"])
    assert out["engine"]["text"].encode("utf-8") == library.read(stand["engine"])
    assert json.loads(out["engine"]["card"]) == json.loads(
        (SAMPLE / "ethalox-doublet.card.json").read_text()
    )
    assert out["machine"]["name"] == "diablo" and out["machine"]["table"]["states"]
    assert out["overrides"]["params"]["node_1"]["volume"]["value"] == 4.6871
    assert out["stand"]["setup"] == stand["setup"]
    assert out["stand"]["operating_point"] == stand["operating_point"]


def test_a_stand_with_no_hookup_carries_the_drawings_saved_one() -> None:
    stand, _ = _stand()
    lineage, _ = _hookup_lineage(library.get(stand["diagram"]))
    saved = {
        "schema": 1,
        "valves": {"Fuel Press": "node_5"},
        "knobs": [],
        "aliases": {},
    }
    library.put_record(HOOKUPS, lineage, {"hookup": saved})
    try:
        assert _export(stand)["stand"]["hookup"] == saved
    finally:
        library.drop_record(HOOKUPS, lineage)


def test_an_import_rebuilds_the_stand_on_a_server_that_has_none_of_it() -> None:
    stand, name = _stand()
    out = _export(stand)
    _forget(stand, name)

    response = client.post("/api/twin/bundle/import", json=out)
    assert response.status_code == 200, response.text
    got = response.json()
    # Same bytes, same ids: the stand names what it named before.
    assert got["stand"]["diagram"] == stand["diagram"]
    assert got["stand"]["engine"] == stand["engine"]
    assert library.read(stand["diagram"]) == out["drawing"]["text"].encode("utf-8")
    assert library.attachment(stand["engine"], "card") is not None
    assert overrides.entry(name)["params"]["node_1"]["volume"]["value"] == 4.6871
    for key in ("setup", "operating_point", "console", "notes", "fluid_set", "machine"):
        assert got["stand"][key] == stand[key], key
    assert got["name"] == "Bundle test"

    # And it opens.
    opened = client.post(
        "/api/session",
        params={"diagram": got["stand"]["diagram"], "engine": got["stand"]["engine"]},
        json={"state": "Idle", "pressurant": "helium"},
    )
    assert opened.status_code == 200, opened.text
    client.delete(f"/api/session/{opened.json()['id']}")


def test_a_differing_state_table_travels_as_the_stands_own() -> None:
    stand, name = _stand()
    stand["hookup"] = {"schema": 1, "valves": {}, "knobs": [], "aliases": {}}
    out = _export(stand)
    table = copy.deepcopy(out["machine"]["table"])
    table["allowed"]["Idle"] = [s for s in table["allowed"]["Idle"] if s != "Armed"]
    out["machine"]["table"] = table
    _forget(stand, name)

    got = client.post("/api/twin/bundle/import", json=out).json()
    assert got["stand"]["hookup"]["machine"] == table
    assert any("state table differs" in n for n in got["notes"])


def test_a_bundle_edited_by_hand_is_refused() -> None:
    stand, _ = _stand()
    out = _export(stand)
    out["drawing"]["text"] = out["drawing"]["text"].replace("nitrogen", "helium", 1)
    response = client.post("/api/twin/bundle/import", json=out)
    assert response.status_code == 422
    assert "changed after it was exported" in response.json()["detail"]


def test_a_newer_bundle_or_another_file_is_refused() -> None:
    stand, _ = _stand()
    out = _export(stand)
    newer = {**out, "version": bundle.VERSION + 1}
    assert (
        "newer Hotbench"
        in client.post("/api/twin/bundle/import", json=newer).json()["detail"]
    )
    other = {"nodes": [], "edges": []}
    assert (
        "not a Hotbench stand"
        in client.post("/api/twin/bundle/import", json=other).json()["detail"]
    )


_RECORD = {"value": 4.0, "unit": "L", "source": "measured", "reference": "weighed"}


@pytest.mark.parametrize(
    "part, value, words",
    [
        # Each was a 500 halfway through the import, or stored and then never
        # applied: one set_param would refuse went in as it came.
        ("overrides", "oops", "overrides"),
        ("overrides", {"params": ["x"]}, "params"),
        ("overrides", {"params": {"node_1": "oops"}}, "node_1"),
        (
            "overrides",
            {"params": {"node_1": {"volume": {**_RECORD, "source": "guess"}}}},
            "guess",
        ),
        (
            "overrides",
            {"params": {"node_1": {"volume": {**_RECORD, "value": "lots"}}}},
            "lots",
        ),
        (
            "overrides",
            {"params": {"node_2": {"dome_bias": {**_RECORD, "unit": "psig"}}}},
            "difference",
        ),
        ("overrides", {"params": {}, "console_order": ["x"]}, "console_order"),
        ("machine", ["x"], "state table"),
        ("hookup", ["x"], "hookup"),
    ],
)
def test_a_bundle_that_cannot_be_used_is_refused_before_anything_goes_in(
    part: str, value: Any, words: str
) -> None:
    stand, name = _stand()
    out = _export(stand)
    _forget(stand, name)
    if part == "hookup":
        out["stand"]["hookup"] = value
    else:
        out[part] = value
    response = client.post("/api/twin/bundle/import", json=out)
    assert response.status_code == 422, response.text
    assert words in response.json()["detail"], response.text
    with pytest.raises(LibraryError):
        library.get(stand["diagram"])
    assert overrides.entry(name)["params"] == {}


def test_overrides_new_to_this_server_are_taken_as_they_are() -> None:
    incoming = {
        "params": {"n1": {"volume": {"value": 2.0, "unit": "L"}}},
        "console_hidden": {"n2": {"by": "a", "at": "t"}},
        "console_shown": {},
        "console_order": {"pts": ["n3"]},
    }
    empty = {
        "params": {},
        "console_hidden": {},
        "console_shown": {},
        "console_order": {},
    }
    merged, notes = bundle.merge_overrides(empty, incoming)
    assert merged == incoming and notes == []


def test_a_conflict_takes_the_stands_value_and_says_whose_it_replaced() -> None:
    mine = {"value": 4.69, "unit": "L", "by": "carlos"}
    theirs = {"value": 4.6871, "unit": "L", "by": "aidan"}
    local = {
        "params": {
            "copv": {"volume": mine},
            "reg": {"bias": {"value": 50, "unit": "psi"}},
        },
        "console_hidden": {"pt9": {}},
        "console_shown": {},
        "console_order": {"tanks": ["t1"]},
    }
    incoming = {
        "params": {"copv": {"volume": theirs}},
        "console_hidden": {},
        "console_shown": {"pt9": {}},
        "console_order": {"pts": ["p1"]},
    }
    merged, notes = bundle.merge_overrides(local, incoming)
    assert merged["params"]["copv"]["volume"] == theirs
    assert (
        merged["params"]["reg"]["bias"]["value"] == 50
    )  # only this server had it: kept
    assert "pt9" in merged["console_shown"] and "pt9" not in merged["console_hidden"]
    assert merged["console_order"] == {"tanks": ["t1"], "pts": ["p1"]}
    assert len(notes) == 1 and "carlos" in notes[0] and "aidan" in notes[0]
    # The same value from both sides is not a conflict.
    assert (
        bundle.merge_overrides({"params": {"copv": {"volume": theirs}}}, incoming)[1]
        == []
    )


# ------------------------------------------------------------------- the card


def _rebuilt_card(built: str) -> bytes:
    card = json.loads((SAMPLE / "ethalox-doublet.card.json").read_text())
    card["card"]["provenance"]["built"] = built
    card["card"]["throat_area"] *= 1.05
    return json.dumps(card).encode("utf-8")


def test_an_import_onto_another_card_fires_the_stands_and_says_so() -> None:
    """This server rebuilt the engine's card since the stand was exported:
    the import kept this server's, silently, and the stand fired another
    engine (H005). The stand's card is the one it was exported on -- as with
    a conflicting override, the stand's wins, and the import says whose it
    replaced; the replaced one is kept for the runs that fired it."""
    stand, _ = _stand()
    out = _export(stand)
    exported = out["engine"]["card"].encode("utf-8")
    local = _rebuilt_card("2026-11-01T00:00:00+00:00")
    library.attach(stand["engine"], "card", local)

    got = client.post("/api/twin/bundle/import", json=out)
    assert got.status_code == 200, got.text
    assert library.attachment(stand["engine"], "card") == exported
    kept = card_version(hashlib.sha256(local).hexdigest())
    assert library.attachment(stand["engine"], kept) == local
    (note,) = [n for n in got.json()["notes"] if "card" in n]
    assert "2026-11-01T00:00:00+00:00" in note
    # EngineDesign stamps a card in epoch seconds; the note says the date.
    built = json.loads(exported)["card"]["provenance"]["built"]
    stamp = datetime.fromtimestamp(float(built), tz=timezone.utc)
    assert stamp.isoformat(timespec="minutes") in note

    # The same card again is no conflict.
    again = client.post("/api/twin/bundle/import", json=out).json()
    assert not [n for n in again["notes"] if "card" in n]


def test_a_card_edited_by_hand_is_refused() -> None:
    stand, _ = _stand()
    out = _export(stand)
    assert (
        out["engine"]["card_sha256"]
        == hashlib.sha256(out["engine"]["card"].encode("utf-8")).hexdigest()
    )
    card = json.loads(out["engine"]["card"])
    card["card"]["throat_area"] *= 1.05
    out["engine"]["card"] = json.dumps(card)
    response = client.post("/api/twin/bundle/import", json=out)
    assert response.status_code == 422
    assert "card" in response.json()["detail"]
    assert "changed after it was exported" in response.json()["detail"]
    # A bundle from before cards were hashed is taken as it is.
    del out["engine"]["card_sha256"]
    assert client.post("/api/twin/bundle/import", json=out).status_code == 200


def test_an_engine_already_here_under_another_name_is_said() -> None:
    """The stand's engine matched one in this library by its bytes, and took
    that one's name without a word: the header said 7200N for the stand's
    "6800N drilled" (H066)."""
    stand, _ = _stand()
    out = _export(stand)
    out["engine"]["name"] = "ethalox 6800N doublet drilled"
    got = client.post("/api/twin/bundle/import", json=out).json()
    here = library.get(stand["engine"]).name
    assert any(
        here in n and "ethalox 6800N doublet drilled" in n for n in got["notes"]
    ), got["notes"]


def test_an_imported_stand_is_not_named_like_one_already_yours(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Imported twice, the picker showed two identical rows (H066)."""
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    stand, _ = _stand()
    out = _export(stand, name="Twice imported")
    first = client.post("/api/twin/bundle/import", json=out).json()
    assert first["name"] == "Twice imported"
    made = client.post(
        "/api/twin/stands", json={"name": first["name"], **first["stand"]}
    )
    assert made.status_code in (200, 201), made.text
    second = client.post("/api/twin/bundle/import", json=out).json()
    assert second["name"] == "Twice imported (2)"


# --------------------------------------------- provenance from another server


def test_a_pull_on_the_exporting_server_is_not_tracked_against_this_ones(
    stores: Tools,
) -> None:
    """An export from a stand on pulled artifacts says where they were pulled
    from: ``pid-designer:local/le4-3@working copy``, on *that* server. Every
    dev install's user is ``local`` and an id is its name's slug, so stored
    as it came, freshness here compared this server's own le4-3 -- another
    drawing -- and offered to refresh the stand onto it (R012)."""
    stand, name = _stand()
    out = _export(stand)
    _forget(stand, name)
    pulled = "pid-designer:local/le4-3@working copy"
    out["drawing"]["source"] = pulled
    # This server's local/le4-3 is somebody's other drawing.
    me = who("local")
    stores.pid.post("/api/pid/diagrams", json={"name": "le4-3"}, headers=me)
    other = json.loads(out["drawing"]["text"])
    other["nodes"] = other["nodes"][:3]
    other["edges"] = []
    stores.pid.post("/api/pid/diagrams/le4-3/autosave", json=other, headers=me)

    got = client.post("/api/twin/bundle/import", json=out)
    assert got.status_code == 200, got.text
    drawing = library.get(got.json()["stand"]["diagram"])
    assert drawing.source == f"bundle:{pulled}"
    assert pulled in drawing.notes
    assert any(pulled in n for n in got.json()["notes"])
    fresh = client.get(f"/api/library/{drawing.id}/freshness").json()
    assert fresh["tracked"] is False, fresh
    refresh = client.post(f"/api/library/{drawing.id}/refresh")
    assert refresh.status_code == 400, refresh.text


def test_a_pull_this_server_holds_as_those_bytes_stays_tracked(
    stores: Tools,
) -> None:
    """The other half: where this server's tool does hold that document as
    the bundle's drawing, the provenance is kept, and freshness follows it."""
    stand, name = _stand()
    out = _export(stand)
    _forget(stand, name)
    pulled = "pid-designer:local/le4-3@working copy"
    out["drawing"]["source"] = pulled
    me = who("local")
    stores.pid.post("/api/pid/diagrams", json={"name": "le4-3"}, headers=me)
    stores.pid.post(
        "/api/pid/diagrams/le4-3/autosave",
        json=json.loads(out["drawing"]["text"]),
        headers=me,
    )

    got = client.post("/api/twin/bundle/import", json=out).json()
    drawing = library.get(got["stand"]["diagram"])
    assert drawing.source == pulled
    fresh = client.get(f"/api/library/{drawing.id}/freshness").json()
    assert fresh["tracked"] is True and fresh["current"] is True, fresh
