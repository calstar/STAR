"""A stand exported as one file, and imported onto a server that has none of it.

``backend.bundle``: the bundle carries the drawing, the engine and its card, the
state table, the drawing's overrides and the hookup the stand runs on, so the
import rebuilds the same library ids and the same stand. "A server that has none
of it" is this library with every one of those removed first.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from backend import bundle
from backend.library import LibraryError
from backend.main import HOOKUPS, _hookup_lineage, app, library, overrides

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
    name = library.get(drawing).name
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
