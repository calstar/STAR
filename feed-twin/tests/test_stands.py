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
    "machine": "engine",
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


@pytest.fixture
def drawing(client: TestClient) -> Iterator[str]:
    """The shipped ethalox stand's drawing, in the library for one test."""
    from backend import main

    stand_file = (
        Path(main.__file__).resolve().parent / "diagrams" / "ethalox_stand.json"
    )
    diagram: str = client.post(
        "/api/library/diagrams",
        files={"file": (stand_file.name, stand_file.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        yield diagram
    finally:
        main.library.remove(diagram)


def _open(
    client: TestClient, diagram: str, ref: dict[str, str], headers: dict[str, str]
) -> Any:
    return client.post(
        "/api/session",
        params={"diagram": diagram},
        headers=headers,
        json={"state": "Idle", "stand": ref},
    )


def test_anyone_may_run_the_featured_stand(client: TestClient, drawing: str) -> None:
    """A fresh browser lands on the featured stand and opens a session on it
    (stand.tsx landOnStand -> reopen). The store lets everyone view it; the
    session open allowed only the owner and the share list, so behind Caddy
    every other person's console came up 'failed'. Its runs still
    file under the stand's owner."""
    from backend import main

    doc_id = _create(client)
    ref = {"id": doc_id, "owner": A["X-Auth-Email"]}
    carol = {"X-Auth-Email": "carol@berkeley.edu"}
    # Not featured, not shared: refused, as before.
    assert _open(client, drawing, ref, carol).status_code == 403
    # What scripts/demo.sh does, and what an admin's PUT writes.
    stands.store.write_featured({"owner": A["X-Auth-Email"], "id": doc_id})
    assert client.get(f"{BASE}/{doc_id}/load", headers=B, params=OWNER_A).is_success
    r = _open(client, drawing, ref, B)
    assert r.status_code == 200, r.text
    opened = main._OPENED[r.json()["id"]]
    assert opened.user == "bob@berkeley.edu"
    assert opened.stand is not None
    assert opened.stand["owner"] == "alice@berkeley.edu"
    # Featuring another stand takes it away again.
    other = _create(client)
    stands.store.write_featured({"owner": A["X-Auth-Email"], "id": other})
    assert _open(client, drawing, ref, B).status_code == 403


def test_a_refused_stand_leaves_the_server_as_it_was(
    client: TestClient, drawing: str
) -> None:
    """The stand was checked after the session was built, seated and
    registered: every refused retry held a seat with no run record behind it,
    and could close someone else's idle stand to make room."""
    from backend import main

    doc_id = _create(client)
    before = (set(main._SESSIONS), set(main._TOUCHED), set(main._OPENED))
    refused = _open(client, drawing, {"id": doc_id, "owner": A["X-Auth-Email"]}, B)
    assert refused.status_code == 403
    missing = _open(client, drawing, {"id": "no-such-stand"}, A)
    assert missing.status_code == 404
    assert (set(main._SESSIONS), set(main._TOUCHED), set(main._OPENED)) == before


def test_an_admin_chooses_the_featured_stand(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nobody could choose it: no ``is_admin`` was wired into the store, so
    the PUT was 403 for every caller, the team's admins included. Admins are
    stardesign's list plus ``STAR_ADMINS`` -- ``local`` on an install with no
    sign-in."""
    monkeypatch.setenv("STAR_ADMINS", "carol@berkeley.edu")
    carol = {"X-Auth-Email": "carol@berkeley.edu"}
    doc_id = _create(client)
    choose = {"owner": A["X-Auth-Email"], "id": doc_id}
    assert client.put(f"{BASE}/featured", headers=B, json=choose).status_code == 403
    assert client.get(f"{BASE}/featured", headers=carol).json()["isAdmin"] is True
    r = client.put(f"{BASE}/featured", headers=carol, json=choose)
    assert r.status_code == 200, r.text
    featured = client.get(f"{BASE}/featured", headers=B).json()["featured"]
    assert featured["id"] == doc_id
    assert client.delete(f"{BASE}/featured", headers=B).status_code == 403
    assert client.delete(f"{BASE}/featured", headers=carol).status_code == 200
    monkeypatch.setenv("STAR_ADMINS", "local")
    assert client.get(f"{BASE}/featured").json()["isAdmin"] is True
