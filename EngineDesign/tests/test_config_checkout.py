"""The live-config routes refuse a write from someone who does not hold the design.

The checkout already gated /api/engine/documents/{id}/autosave, which protects
the *stored* design. It did not gate /api/config, which is what the UI actually
edits -- so a read-only viewer's changes landed in their own session, the screen
updated, and the edit then evaporated at the next reload with nothing said.
These tests pin the refusal at the point of the edit.

See backend/checkout.py for why /api/config/load is deliberately NOT gated: it
is how the design bar opens a design you may only view.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.checkout import DesignCheckout  # noqa: E402
from backend.routers import documents  # noqa: E402

A = {"X-Auth-Email": "alice@berkeley.edu"}
B = {"X-Auth-Email": "bob@berkeley.edu"}
BASE = "/api/engine/documents"


# A stand-in for the real config routes. Mounting backend.main here would drag
# in the engine kernel and the optimizer; what is under test is the dependency,
# and this exercises exactly the same one the real routes declare.
app = FastAPI()
app.include_router(documents.router)


@app.post("/probe/header")
async def probe_header(_: None = DesignCheckout):
    return {"ok": True}


@app.get("/probe/query")
async def probe_query(_: None = DesignCheckout):
    return {"ok": True}


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    documents.store.last_micro.clear()


@pytest.fixture
def client():
    return TestClient(app)


def _create(client, headers, name="Baseline"):
    r = client.post(BASE, headers=headers, json={"name": name, "config": {"combustion": {}}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _take(client, doc_id, headers, params=None):
    r = client.post(f"{BASE}/{doc_id}/checkout", headers=headers, params=params or {})
    assert r.status_code == 200, r.text


def _release(client, doc_id, headers, params=None):
    r = client.delete(f"{BASE}/{doc_id}/checkout", headers=headers, params=params or {})
    assert r.status_code == 200, r.text


def test_no_design_named_is_allowed(client):
    """The config routes predate designs; scripted and file-upload callers still
    use them with nothing open, and must keep working."""
    assert client.post("/probe/header", headers=A).status_code == 200


def test_holder_may_write(client):
    doc_id = _create(client, A)
    _take(client, doc_id, A)
    r = client.post("/probe/header", headers={**A, "X-Design-Id": doc_id})
    assert r.status_code == 200, r.text


def test_write_without_the_checkout_is_refused(client):
    """Creating a design checks it out to you, so release it first: this is the
    'my checkout lapsed and I kept typing' case."""
    doc_id = _create(client, A)
    _release(client, doc_id, A)
    r = client.post("/probe/header", headers={**A, "X-Design-Id": doc_id})
    assert r.status_code == 423, r.text
    assert "Take" in r.json()["detail"]


def test_write_while_someone_else_holds_it_is_refused(client):
    doc_id = _create(client, A)
    _take(client, doc_id, A)
    client.put(f"{BASE}/{doc_id}/share", headers=A, json={"sharedWith": [B["X-Auth-Email"]]})

    owner = {"owner": A["X-Auth-Email"]}
    r = client.post(
        "/probe/header",
        headers={**B, "X-Design-Id": doc_id, "X-Design-Owner": A["X-Auth-Email"]},
        params=owner,
    )
    assert r.status_code == 423, r.text
    assert "checked out by" in r.json()["detail"]


def test_query_params_work_too(client):
    """The optimizer layers stream over EventSource, which cannot set headers."""
    doc_id = _create(client, A)
    _release(client, doc_id, A)
    r = client.get("/probe/query", headers=A, params={"design_id": doc_id})
    assert r.status_code == 423, r.text

    _take(client, doc_id, A)
    assert client.get("/probe/query", headers=A, params={"design_id": doc_id}).status_code == 200


def test_unknown_design_is_allowed(client):
    """A stale id in localStorage must not brick every config write."""
    r = client.post("/probe/header", headers={**A, "X-Design-Id": "no-such-design"})
    assert r.status_code == 200, r.text


def test_a_lapsed_checkout_is_refused(client, monkeypatch):
    doc_id = _create(client, A)
    _take(client, doc_id, A)
    monkeypatch.setattr(documents.store, "lock_ttl", 0)  # every checkout reads as expired
    r = client.post("/probe/header", headers={**A, "X-Design-Id": doc_id})
    assert r.status_code == 423, r.text
