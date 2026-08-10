"""Per-user config documents: working copy + microversions + releases.

The versioned-document API (/api/recovery/documents) mirrors the pid-designer
model: an autosaved working copy, throttled microversions, and immutable named
releases. Identity is X-Auth-Email with a `local` dev fallback; one user's
documents and history must never be visible to another.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402
from backend.routers import documents  # noqa: E402

A = {"X-Auth-Email": "alice@berkeley.edu"}
B = {"X-Auth-Email": "bob@berkeley.edu"}


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Fresh data root per test; force a microversion on every autosave (no
    throttle) and clear the in-process throttle clock so tests don't interfere."""
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    monkeypatch.setattr(documents, "MICRO_INTERVAL", 0)
    documents._last_micro.clear()


@pytest.fixture
def client():
    return TestClient(app)


def _create(client, headers, name="Baseline", config=None):
    r = client.post("/api/recovery/documents", headers=headers,
                    json={"name": name, "config": config or {"devices": [{"uid": "d1"}]}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ── CRUD + isolation ─────────────────────────────────────────────────────────


def test_create_lists_and_isolates_per_user(client):
    a_id = _create(client, A, "Alice design")
    _create(client, B, "Bob design")

    a_list = client.get("/api/recovery/documents", headers=A).json()
    b_list = client.get("/api/recovery/documents", headers=B).json()
    assert [d["id"] for d in a_list] == [a_id]
    assert a_id not in [d["id"] for d in b_list]  # B never sees A's doc


def test_rename_and_delete(client):
    doc_id = _create(client, A)
    r = client.patch(f"/api/recovery/documents/{doc_id}", headers=A, json={"name": "Renamed"})
    assert r.status_code == 200 and r.json()["name"] == "Renamed"

    assert client.delete(f"/api/recovery/documents/{doc_id}", headers=A).status_code == 200
    assert client.get("/api/recovery/documents", headers=A).json() == []


# ── working copy + microversions ─────────────────────────────────────────────


def test_autosave_load_and_history(client):
    doc_id = _create(client, A)
    cfg = {"devices": [{"uid": "d1", "cd": 1.4}], "site": {"lat": 37.0}}
    assert client.post(f"/api/recovery/documents/{doc_id}/autosave",
                       headers=A, json={"config": cfg}).json()["micro"] is True

    # /load returns the freshest working copy.
    assert client.get(f"/api/recovery/documents/{doc_id}/load", headers=A).json()["config"] == cfg

    # The autosave recorded a microversion; fetch it back verbatim.
    history = client.get(f"/api/recovery/documents/{doc_id}/history", headers=A).json()
    assert len(history) >= 1
    vid = history[0]["versionId"]
    snap = client.get(f"/api/recovery/documents/{doc_id}/version/{vid}", headers=A).json()
    assert snap["config"] == cfg


def test_history_isolated_between_users(client):
    a_id = _create(client, A)
    client.post(f"/api/recovery/documents/{a_id}/autosave", headers=A,
                json={"config": {"secret": 1}})
    # Bob asking for Alice's doc id sees his own (empty) history, never her data.
    assert client.get(f"/api/recovery/documents/{a_id}/history", headers=B).json() == []


# ── releases ─────────────────────────────────────────────────────────────────


def test_release_is_immutable_and_listed(client):
    doc_id = _create(client, A)
    cfg = {"devices": [{"uid": "d1"}], "v": 1}
    r = client.post(f"/api/recovery/documents/{doc_id}/release",
                    headers=A, json={"label": "0.1", "config": cfg})
    assert r.status_code == 200 and r.json()["label"] == "0.1"

    # Re-releasing the same label is a conflict -- releases are immutable.
    dup = client.post(f"/api/recovery/documents/{doc_id}/release",
                      headers=A, json={"label": "0.1", "config": {"v": 2}})
    assert dup.status_code == 409

    assert "0.1" in [r["label"] for r in
                     client.get(f"/api/recovery/documents/{doc_id}/releases", headers=A).json()]
    got = client.get(f"/api/recovery/documents/{doc_id}/release/0.1", headers=A).json()
    assert got["config"] == cfg  # the original, not the rejected v:2


def test_restore_returns_older_state(client):
    """The safety net: an autosaved mistake is recoverable from an earlier
    microversion."""
    doc_id = _create(client, A)
    good = {"devices": [{"uid": "d1"}], "thrust": 1000}
    client.post(f"/api/recovery/documents/{doc_id}/autosave", headers=A, json={"config": good})
    client.post(f"/api/recovery/documents/{doc_id}/autosave", headers=A,
                json={"config": {"devices": [], "thrust": 0}})  # the "mistake"

    history = client.get(f"/api/recovery/documents/{doc_id}/history", headers=A).json()
    assert len(history) >= 2
    # The oldest snapshot still holds the good state.
    oldest = client.get(
        f"/api/recovery/documents/{doc_id}/version/{history[-1]['versionId']}", headers=A
    ).json()
    assert oldest["config"] == good
