"""Per-user engine-design documents: working copy + microversions + releases.

The versioned-document API (/api/engine/documents) mirrors the pid-designer
model: an autosaved working copy, throttled microversions, and immutable named
releases. Identity is X-Auth-Email with a `local` dev fallback; one user's
documents and history must never be visible to another.

Driven through the endpoint coroutines directly (this backend's test env has no
HTTP client), exactly as the forwarded X-Auth-Email header would feed them.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from backend.routers import documents as d


def _request(email: str | None) -> Request:
    headers = [(b"x-auth-email", email.encode())] if email else []
    return Request({"type": "http", "method": "GET", "path": "/",
                    "query_string": b"", "headers": headers})


def _run(coro):
    return asyncio.run(coro)


A = "alice@berkeley.edu"
B = "bob@berkeley.edu"


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Fresh data root per test; force a microversion on every autosave (no
    throttle) and clear the in-process throttle clock."""
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    monkeypatch.setattr(d, "MICRO_INTERVAL", 0)
    d._last_micro.clear()


def _create(email, name="Baseline", config=None):
    meta = _run(d.create_document(_request(email),
                d.CreatePayload(name=name, config=config or {"combustion": {}})))
    return meta["id"]


# ── CRUD + isolation ─────────────────────────────────────────────────────────


def test_create_lists_and_isolates_per_user():
    a_id = _create(A, "Alice design")
    _create(B, "Bob design")
    a_list = _run(d.list_documents(_request(A)))
    b_list = _run(d.list_documents(_request(B)))
    assert [x["id"] for x in a_list] == [a_id]
    assert a_id not in [x["id"] for x in b_list]


def test_rename_and_delete():
    doc_id = _create(A)
    renamed = _run(d.rename_document(_request(A), doc_id, d.NamePayload(name="Renamed")))
    assert renamed["name"] == "Renamed"
    assert _run(d.delete_document(_request(A), doc_id)) == {"ok": True}
    assert _run(d.list_documents(_request(A))) == []


# ── working copy + microversions ─────────────────────────────────────────────


def test_autosave_load_and_history():
    doc_id = _create(A)
    cfg = {"combustion": {"efficiency": {"c_star": 0.95}}, "note": "v1"}
    res = _run(d.autosave_document(_request(A), doc_id, d.ConfigPayload(config=cfg)))
    assert res["micro"] is True

    assert _run(d.load_document(_request(A), doc_id))["config"] == cfg

    history = _run(d.get_history(_request(A), doc_id))
    assert len(history) >= 1
    snap = _run(d.get_version(_request(A), doc_id, history[0]["versionId"]))
    assert snap["config"] == cfg


def test_history_isolated_between_users():
    a_id = _create(A)
    _run(d.autosave_document(_request(A), a_id, d.ConfigPayload(config={"secret": 1})))
    # Bob asking for Alice's id sees his own (empty) history, never her data.
    assert _run(d.get_history(_request(B), a_id)) == []


def test_missing_version_is_404():
    doc_id = _create(A)
    with pytest.raises(HTTPException) as exc:
        _run(d.get_version(_request(A), doc_id, "deadbeef"))
    assert exc.value.status_code == 404


# ── releases ─────────────────────────────────────────────────────────────────


def test_release_is_immutable_and_listed():
    doc_id = _create(A)
    cfg = {"combustion": {}, "v": 1}
    meta = _run(d.create_release(_request(A), doc_id, d.ReleasePayload(label="0.1", config=cfg)))
    assert meta["label"] == "0.1"

    with pytest.raises(HTTPException) as exc:
        _run(d.create_release(_request(A), doc_id, d.ReleasePayload(label="0.1", config={"v": 2})))
    assert exc.value.status_code == 409

    labels = [r["label"] for r in _run(d.list_releases(_request(A), doc_id))]
    assert "0.1" in labels
    got = _run(d.get_release(_request(A), doc_id, "0.1"))
    assert got["config"] == cfg  # original, not the rejected v:2


def test_restore_returns_older_state():
    doc_id = _create(A)
    good = {"combustion": {}, "thrust": 1000}
    _run(d.autosave_document(_request(A), doc_id, d.ConfigPayload(config=good)))
    _run(d.autosave_document(_request(A), doc_id, d.ConfigPayload(config={"thrust": 0})))  # mistake

    history = _run(d.get_history(_request(A), doc_id))
    assert len(history) >= 2
    # The good state is recoverable from an earlier microversion. (Ordering of
    # sub-second snapshots is by mtime and can tie under this synthetic 0-throttle
    # test, so assert recoverability by membership, not by position.)
    snaps = [_run(d.get_version(_request(A), doc_id, h["versionId"]))["config"] for h in history]
    assert good in snaps
