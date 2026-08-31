"""Per-user engine-design documents: working copy + microversions + releases.

The versioned-document API (/api/engine/documents) mirrors the pid-designer
model: an autosaved working copy, throttled microversions, and immutable named
releases. Identity is X-Auth-Email with a `local` dev fallback.

Designs are shared: a design lives in its creator's folder but is editable by
anyone on its `sharedWith` list, and readable/copyable by anyone at all. So the
invariant under test is no longer "users cannot see each other" -- it is that
`?owner=` grants exactly the access the share list says it does, and nothing
else. The 403/404 matrix below is the load-bearing test: it walks the router's
own route table, so a design-scoped endpoint added without going through
`_resolve_doc` fails here rather than shipping a hole.

Driven through the endpoint coroutines directly (this backend's test env has no
HTTP client), exactly as the forwarded X-Auth-Email header would feed them.
"""

from __future__ import annotations

import asyncio
import json

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


def _find(email, doc_id):
    """One decorated record from the caller's editable list."""
    return next(r for r in _run(d.list_documents(_request(email))) if r["id"] == doc_id)


def _share(doc_id, emails, *, owner=A, by=None):
    return _run(d.share_document(_request(by or owner), doc_id,
                                 d.SharePayload(sharedWith=emails), owner=owner))


# ── CRUD + isolation ─────────────────────────────────────────────────────────


def test_create_lists_and_isolates_until_shared():
    a_id = _create(A, "Alice design")
    _create(B, "Bob design")
    a_list = _run(d.list_documents(_request(A)))
    b_list = _run(d.list_documents(_request(B)))
    assert [x["id"] for x in a_list] == [a_id]
    assert a_id not in [x["id"] for x in b_list]
    assert a_list[0]["mine"] is True and a_list[0]["owner"] == A

    _share(a_id, [B])
    b_list = _run(d.list_documents(_request(B)))
    entry = next(x for x in b_list if x["id"] == a_id)
    assert entry["owner"] == A and entry["mine"] is False


def test_rename():
    doc_id = _create(A)
    renamed = _run(d.rename_document(_request(A), doc_id, d.NamePayload(name="Renamed")))
    assert renamed["name"] == "Renamed"
    assert [x["name"] for x in _run(d.list_documents(_request(A)))] == ["Renamed"]


def test_delete_is_gone():
    """Designs are never deleted -- shared designs made it too easy to destroy
    someone else's work. Cleanup is an admin operation on the volume.

    `/{doc_id}/share/me` is the one DELETE that survives, and it removes a share
    grant, not a design.
    """
    assert not hasattr(d, "delete_document")
    deletes = {
        r.path for r in d.router.routes if "DELETE" in getattr(r, "methods", set())
    }
    assert deletes == {"/api/engine/documents/{doc_id}/share/me"}


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


def test_history_needs_a_share():
    """Bob naming Alice's design gets 404 without ?owner= (no such design of his
    own) and 403 with it (hers, not shared) -- never her data."""
    a_id = _create(A)
    _run(d.autosave_document(_request(A), a_id, d.ConfigPayload(config={"secret": 1})))

    with pytest.raises(HTTPException) as exc:
        _run(d.get_history(_request(B), a_id))
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        _run(d.get_history(_request(B), a_id, owner=A))
    assert exc.value.status_code == 403


def test_history_readable_once_shared():
    a_id = _create(A)
    _run(d.autosave_document(_request(A), a_id, d.ConfigPayload(config={"shared": 1})))
    _share(a_id, [B])
    history = _run(d.get_history(_request(B), a_id, owner=A))
    assert len(history) >= 1


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


# ── sharing ──────────────────────────────────────────────────────────────────


def test_share_grants_edit_and_writes_into_the_owners_folder(tmp_path):
    """A shared editor edits the *same* design, not a copy of it -- so the bytes
    must land in Alice's folder and Alice must see the change."""
    a_id = _create(A, "Booster")
    _share(a_id, [B])

    _run(d.autosave_document(_request(B), a_id, d.ConfigPayload(config={"by": "bob"}),
                             owner=A))
    assert (tmp_path / A / "engine" / a_id / "current.json").is_file()
    assert not (tmp_path / B / "engine" / a_id).exists()
    assert _run(d.load_document(_request(A), a_id))["config"] == {"by": "bob"}

    renamed = _run(d.rename_document(_request(B), a_id, d.NamePayload(name="Bob's edit"),
                                     owner=A))
    assert renamed["name"] == "Bob's edit"


def test_share_replaces_the_whole_list_and_drops_the_owner():
    a_id = _create(A)
    rec = _share(a_id, [B, B.upper(), "  ", A])
    # Deduped on the path slug, the owner filtered out (they are implicitly and
    # unremovably an editor), blanks dropped.
    assert rec["sharedWith"] == [B]
    assert rec["sharedUpdatedBy"] == A

    assert _share(a_id, [])["sharedWith"] == []
    with pytest.raises(HTTPException) as exc:
        _run(d.get_history(_request(B), a_id, owner=A))
    assert exc.value.status_code == 403


def test_any_editor_may_reshare():
    """No owner/editor distinction: a shared editor can change the share list,
    including removing people. Revocation is housekeeping, not a boundary."""
    a_id = _create(A)
    _share(a_id, [B])
    rec = _share(a_id, ["carol@berkeley.edu"], by=B)
    assert rec["sharedWith"] == ["carol@berkeley.edu"]
    assert rec["sharedUpdatedBy"] == B


def test_leave_removes_only_yourself():
    a_id = _create(A)
    _share(a_id, [B, "carol@berkeley.edu"])
    assert _run(d.leave_document(_request(B), a_id, owner=A)) == {"ok": True}

    rec = _find(A, a_id)
    assert rec["sharedWith"] == ["carol@berkeley.edu"]
    assert a_id not in [x["id"] for x in _run(d.list_documents(_request(B)))]


def test_owner_cannot_leave_their_own_design():
    """Otherwise the design ends up in nobody's editable list."""
    a_id = _create(A)
    with pytest.raises(HTTPException) as exc:
        _run(d.leave_document(_request(A), a_id))
    assert exc.value.status_code == 400


def test_legacy_records_without_sharedwith_still_work(tmp_path):
    """Every design created before sharing existed lacks the key. A missing
    `sharedWith` is an empty list, never an error."""
    index = tmp_path / A / "engine" / "index.json"
    index.parent.mkdir(parents=True, exist_ok=True)
    index.write_text(json.dumps([{"id": "old", "name": "Old", "createdAt": "2020-01-01",
                                 "updatedAt": "2020-01-01"}]))

    listed = _run(d.list_documents(_request(A)))
    assert [x["id"] for x in listed] == ["old"]
    assert listed[0]["sharedWith"] == []
    assert _run(d.load_document(_request(A), "old")) == {"config": {}}

    with pytest.raises(HTTPException) as exc:
        _run(d.get_history(_request(B), "old", owner=A))
    assert exc.value.status_code == 403


# ── browse + copy: anyone may look, anyone may take a copy ───────────────────


def test_browse_groups_by_owner_and_hides_what_you_can_edit():
    a_id = _create(A, "Alice design")
    shared_id = _create(A, "Shared design")
    _share(shared_id, [B])
    _create(B, "Bob design")

    tree = _run(d.browse_documents(_request(B)))
    assert [g["owner"] for g in tree] == [A]
    # Alice's unshared design only: the shared one is editable (so it is in the
    # editable list), and Bob's own never shows up in the view-only tree.
    assert [x["id"] for x in tree[0]["designs"]] == [a_id]


def test_copy_is_independent_and_needs_no_share():
    a_id = _create(A, "Booster", config={"v": 1})
    _run(d.autosave_document(_request(A), a_id, d.ConfigPayload(config={"v": 1})))

    copy = _run(d.copy_document(_request(B), d.CopyPayload(owner=A, id=a_id)))
    assert copy["name"] == f"Booster (copy of {A})"
    assert copy["sharedWith"] == []
    assert _run(d.load_document(_request(B), copy["id"]))["config"] == {"v": 1}

    # Editing the copy must not touch the original, and must not grant any
    # access back to it.
    _run(d.autosave_document(_request(B), copy["id"], d.ConfigPayload(config={"v": 2})))
    assert _run(d.load_document(_request(A), a_id))["config"] == {"v": 1}
    assert _find(A, a_id)["sharedWith"] == []
    assert _run(d.get_history(_request(B), copy["id"])) != _run(
        d.get_history(_request(A), a_id))


def test_copy_of_a_missing_design_is_404():
    with pytest.raises(HTTPException) as exc:
        _run(d.copy_document(_request(B), d.CopyPayload(owner=A, id="nope")))
    assert exc.value.status_code == 404


# ── the access matrix: the guard that must not develop a hole ────────────────


#: Every design-scoped handler, with a call that exercises it. A handler that
#: forgets `_resolve_doc` cannot pass both checks below, and one added without an
#: entry here fails `test_every_doc_scoped_route_is_listed`.
def _doc_scoped_calls(email, doc_id, owner):
    r = _request(email)
    return {
        "rename_document": lambda: d.rename_document(r, doc_id, d.NamePayload(name="x"), owner=owner),
        "share_document": lambda: d.share_document(r, doc_id, d.SharePayload(sharedWith=[]), owner=owner),
        "leave_document": lambda: d.leave_document(r, doc_id, owner=owner),
        "load_document": lambda: d.load_document(r, doc_id, owner=owner),
        "autosave_document": lambda: d.autosave_document(r, doc_id, d.ConfigPayload(config={"x": 1}), owner=owner),
        "flush_document": lambda: d.flush_document(r, doc_id, d.ConfigPayload(config={"x": 1}), owner=owner),
        "get_history": lambda: d.get_history(r, doc_id, owner=owner),
        "get_version": lambda: d.get_version(r, doc_id, "deadbeef", owner=owner),
        "create_release": lambda: d.create_release(r, doc_id, d.ReleasePayload(label="0.1"), owner=owner),
        "list_releases": lambda: d.list_releases(r, doc_id, owner=owner),
        "get_release": lambda: d.get_release(r, doc_id, "0.1", owner=owner),
    }


#: Not design-scoped: they take no doc id, or exist precisely to reach designs
#: the caller cannot edit.
_UNSCOPED = {"list_documents", "browse_documents", "create_document", "copy_document"}


def test_every_doc_scoped_route_is_listed():
    """Pins the matrix below to the real route table. Add an endpoint and this
    fails until you say which side of the access boundary it sits on -- which is
    the whole point: a new design-scoped route cannot silently skip the check."""
    handlers = {r.endpoint.__name__ for r in d.router.routes if hasattr(r, "endpoint")}
    covered = set(_doc_scoped_calls(A, "x", None)) | _UNSCOPED
    assert handlers == covered, f"unclassified endpoints: {handlers ^ covered}"


@pytest.mark.parametrize("name", sorted(_doc_scoped_calls(A, "x", None)))
def test_doc_scoped_route_forbids_an_unshared_owner(name):
    a_id = _create(A)
    with pytest.raises(HTTPException) as exc:
        _run(_doc_scoped_calls(B, a_id, A)[name]())
    assert exc.value.status_code == 403, f"{name} leaked access"


@pytest.mark.parametrize("name", sorted(_doc_scoped_calls(A, "x", None)))
def test_doc_scoped_route_404s_a_foreign_id_without_owner(tmp_path, name):
    """Dropping `?owner=` must 404, never silently create an orphan working copy
    in the caller's own folder -- a failure `/flush` (a sendBeacon) could not
    even report."""
    a_id = _create(A)
    before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))
    with pytest.raises(HTTPException) as exc:
        _run(_doc_scoped_calls(B, a_id, None)[name]())
    assert exc.value.status_code == 404, f"{name} did not 404"
    assert sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*")) == before


@pytest.mark.parametrize("owner", ["../..", ".", "", "a/b", "..", "./../etc"])
def test_owner_param_cannot_escape_the_root(tmp_path, owner):
    a_id = _create(A)
    before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))
    with pytest.raises(HTTPException) as exc:
        _run(d.load_document(_request(B), a_id, owner=owner))
    assert exc.value.status_code == 404
    # The scan and the resolve must both be read-only: no folder conjured for a
    # user who does not exist.
    assert sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*")) == before
