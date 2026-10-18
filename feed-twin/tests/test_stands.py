"""Stands: the whole test set-up as one shared, versioned document.

The store is pid-designer's (lib/stardesign), tested there for the general
sharing matrix; what is checked here is the binding. Every stand key
round-trips, a release is a frozen copy a later edit does not reach, an
empty flush does not wipe a stand, and someone it was not shared with can read
but not write it.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import stands

A = {"X-Auth-Email": "alice@berkeley.edu"}
B = {"X-Auth-Email": "bob@berkeley.edu"}
OWNER_A = {"owner": A["X-Auth-Email"]}
BASE = "/api/twin/stands"

STAND: dict[str, Any] = {
    "diagram": "sha256:" + "a" * 64,
    "engine": "sha256:" + "b" * 64,
    "fluid_set": "hotfire",
    "machine": "diablo",
    "setup": {"vapour": True, "wall_htc_film": 100.0},
    "hookup": {
        "pins": {"PV-OX": "OX Main"},
        "knobs": {"lox": ["PR-OX"]},
        "aliases": {"engine.pc": "Chamber pressure"},
    },
    "operating_point": {"tank_psi": 550.0, "copv_psi": 4500.0},
    "console": {
        "hidden": {"pts": ["PT-6K"], "tanks": ["TK-CART"], "actuators": ["SV-CART"]},
        "order": {"pts": ["PT-OX", "PT-FU"], "tanks": ["TK-FU", "TK-OX"]},
    },
    "notes": "TRR configuration",
}


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    monkeypatch.setattr(stands.store, "micro_interval", 0)
    stands.store.last_micro.clear()


@pytest.fixture
def client() -> Iterator[TestClient]:
    yield TestClient(app)


def _create(client: TestClient, headers: dict[str, str] = A) -> str:
    r = client.post(BASE, headers=headers, json={"name": "LE4 hot fire"})
    assert r.status_code == 200, r.text
    doc_id: str = r.json()["id"]
    assert client.post(f"{BASE}/{doc_id}/checkout", headers=headers).status_code == 200
    return doc_id


def test_a_stand_round_trips_every_key(client: TestClient) -> None:
    doc_id = _create(client)
    assert (
        client.post(f"{BASE}/{doc_id}/autosave", headers=A, json=STAND).status_code
        == 200
    )
    assert client.get(f"{BASE}/{doc_id}/load", headers=A).json() == STAND


def test_a_release_is_frozen(client: TestClient) -> None:
    doc_id = _create(client)
    client.post(f"{BASE}/{doc_id}/autosave", headers=A, json=STAND)
    r = client.post(f"{BASE}/{doc_id}/release", headers=A, json={"label": "TRR rev B"})
    assert r.status_code == 200, r.text
    later = {**STAND, "operating_point": {"tank_psi": 600.0}}
    client.post(f"{BASE}/{doc_id}/autosave", headers=A, json=later)
    frozen = client.get(f"{BASE}/{doc_id}/release/TRR rev B", headers=A).json()
    assert frozen["operating_point"] == {"tank_psi": 550.0, "copv_psi": 4500.0}
    again = client.post(
        f"{BASE}/{doc_id}/release", headers=A, json={"label": "TRR rev B"}
    )
    assert again.status_code == 409


def test_an_empty_flush_keeps_the_stand(client: TestClient) -> None:
    doc_id = _create(client)
    client.post(f"{BASE}/{doc_id}/autosave", headers=A, json=STAND)
    assert client.post(f"{BASE}/{doc_id}/flush", headers=A, json={}).status_code == 200
    assert client.get(f"{BASE}/{doc_id}/load", headers=A).json() == STAND


def test_unshared_is_read_only_and_shared_is_editable(client: TestClient) -> None:
    doc_id = _create(client)
    client.post(f"{BASE}/{doc_id}/autosave", headers=A, json=STAND)
    client.delete(f"{BASE}/{doc_id}/checkout", headers=A)
    took = client.post(f"{BASE}/{doc_id}/checkout", headers=B, params=OWNER_A)
    assert took.status_code == 403
    r = client.put(
        f"{BASE}/{doc_id}/share",
        headers=A,
        json={"sharedWith": [B["X-Auth-Email"]]},
    )
    assert r.status_code == 200, r.text
    took = client.post(f"{BASE}/{doc_id}/checkout", headers=B, params=OWNER_A)
    assert took.status_code == 200, took.text
    bob = {**STAND, "notes": "bob was here"}
    saved = client.post(
        f"{BASE}/{doc_id}/autosave", headers=B, params=OWNER_A, json=bob
    )
    assert saved.status_code == 200
    assert (
        client.get(f"{BASE}/{doc_id}/load", headers=A).json()["notes"] == "bob was here"
    )


def test_a_hookup_made_for_another_drawing_does_not_stop_the_stand(
    client: TestClient,
) -> None:
    """A stand saved on one drawing, opened on another: its hookup names a
    regulator this drawing does not have. The session opens on the drawing's
    own hookup and says why, rather than refusing (which left the cockpit
    showing nothing)."""
    from backend import main

    stand_file = (
        Path(main.__file__).resolve().parent / "diagrams" / "ethalox_stand.json"
    )
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": (stand_file.name, stand_file.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        foreign = {
            "valves": {},
            "knobs": [
                {
                    "id": "dome",
                    "label": "Dome",
                    "psig": 500.0,
                    "regulators": ["PR_NOT_ON_THIS_DRAWING"],
                }
            ],
        }
        r = client.post(
            "/api/session",
            params={"diagram": diagram},
            json={"state": "Idle", "hookup": foreign},
        )
        assert r.status_code == 200, r.text
        session = main._SESSIONS[r.json()["id"]]
        assert any("another drawing" in a for a in session.assumptions)
        assert all(
            "PR_NOT_ON_THIS_DRAWING" not in k.regulators
            for k in (session.hookup.knobs if session.hookup else [])
        )
    finally:
        main.library.remove(diagram)
