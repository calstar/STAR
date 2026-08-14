"""Versioned-design store: the full CRUD + history + release lifecycle.

Offline (in-process TestClient, LocalBackend under a temp USERDATA_DIR). Asserts the
S3 backend stays dormant without a bucket env, so this never touches AWS.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.main as main_module
from backend import storage

B = "/api/documents"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # LocalBackend reads USERDATA_DIR per call, so pointing it at a tmp dir isolates the test.
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    return TestClient(main_module.app)


def test_s3_backend_is_dormant_without_bucket():
    assert storage.IS_S3 is False


def test_document_crud_history_release(client):
    # create
    doc = client.post(B, json={"name": "Rocket A", "config": {"railLength": 1.2}}).json()
    did = doc["id"]
    assert doc["name"] == "Rocket A"
    assert client.get(B).json()[0]["id"] == did

    # autosave writes the working copy; /load returns it
    assert client.post(f"{B}/{did}/autosave", json={"config": {"railLength": 2.5}}).json()["ok"]
    assert client.get(f"{B}/{did}/load").json() == {"config": {"railLength": 2.5}}

    # flush forces a microversion; history + round-trip
    assert client.post(f"{B}/{did}/flush", json={"config": {"railLength": 3.0}}).json()["ok"]
    history = client.get(f"{B}/{did}/history").json()
    assert len(history) >= 1
    vid = history[0]["versionId"]
    assert client.get(f"{B}/{did}/version/{vid}").json() == {"config": {"railLength": 3.0}}

    # release is immutable
    assert client.post(f"{B}/{did}/release", json={"label": "0.1"}).json()["label"] == "0.1"
    assert client.post(f"{B}/{did}/release", json={"label": "0.1"}).status_code == 409
    assert [r["label"] for r in client.get(f"{B}/{did}/releases").json()] == ["0.1"]
    assert client.get(f"{B}/{did}/release/0.1").json() == {"config": {"railLength": 3.0}}

    # rename keeps the id; delete removes it
    assert client.patch(f"{B}/{did}", json={"name": "Rocket A v2"}).json()["name"] == "Rocket A v2"
    assert client.delete(f"{B}/{did}").json()["ok"]
    assert client.get(B).json() == []


def test_unknown_document_404(client):
    assert client.get(f"{B}/does-not-exist/version/whatever").status_code == 404
    assert client.get(f"{B}/does-not-exist/release/0.1").status_code == 404
