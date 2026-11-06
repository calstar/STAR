"""Deleting from the library what a stand or a run still names.

A run record names the drawing and engine it burned by content hash, to be
"read a year on"; a stand names them the same way. Library delete removed the
bytes whatever named them, and the next Explain failed with "no artifact" and
the stand would not reopen (H039). An artifact something still names leaves
the library's lists and keeps its bytes; one nothing names is removed, as
before.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend import runs as run_records
from backend.library import LibraryError

SAMPLE = Path(__file__).resolve().parents[1] / "backend" / "sample"
client = TestClient(main.app)


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))


@pytest.fixture
def artifacts() -> Iterator[tuple[str, str]]:
    payload = json.loads((SAMPLE / "le4-stand.json").read_text())
    payload["name"] = "delete me LE4"
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": ("delete me.json", json.dumps(payload).encode(), "text/plain")},
    ).json()["artifact"]["id"]
    engine = client.post(
        "/api/library/engines",
        files={
            "file": (
                "delete me.yaml",
                b"# delete me\n" + (SAMPLE / "ethalox-doublet.yaml").read_bytes(),
                "text/plain",
            )
        },
    ).json()["artifact"]["id"]
    try:
        yield str(diagram), str(engine)
    finally:
        for artifact in (diagram, engine):
            try:
                main.library.remove(artifact)
            except LibraryError:
                pass


def _listed(artifact_id: str) -> bool:
    return any(a["id"] == artifact_id for a in client.get("/api/library").json())


def test_an_artifact_a_run_names_leaves_the_list_and_keeps_its_bytes(
    artifacts: tuple[str, str],
) -> None:
    diagram, engine = artifacts
    run_records.store.save(
        "local",
        {
            "id": run_records.new_id(),
            "inputs": {"diagram": diagram, "engine": engine},
            "outcome": {},
        },
    )
    gone = client.delete(f"/api/library/{engine}")
    assert gone.status_code == 200, gone.text
    assert "1 run record" in gone.json()["kept"]
    assert not _listed(engine)
    # The run still has what it burned on.
    assert main.library.read(engine)
    # Imported again, it is back.
    again = client.post(
        "/api/library/engines",
        files={
            "file": (
                "again.yaml",
                b"# delete me\n" + (SAMPLE / "ethalox-doublet.yaml").read_bytes(),
                "text/plain",
            )
        },
    )
    assert again.json()["artifact"]["id"] == engine and _listed(engine)


def test_an_artifact_a_stand_names_is_kept_and_the_stand_said(
    artifacts: tuple[str, str],
) -> None:
    diagram, _ = artifacts
    made = client.post(
        "/api/twin/stands", json={"name": "keeps its drawing", "diagram": diagram}
    )
    assert made.status_code in (200, 201), made.text
    gone = client.delete(f"/api/library/{diagram}").json()
    assert "keeps its drawing" in gone["kept"]
    assert not _listed(diagram)
    assert main.library.get(diagram).id == diagram


def test_an_artifact_nothing_names_is_removed(artifacts: tuple[str, str]) -> None:
    _, engine = artifacts
    gone = client.delete(f"/api/library/{engine}").json()
    assert gone == {"removed": engine}
    with pytest.raises(LibraryError):
        main.library.get(engine)
