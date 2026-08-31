"""Per-user engine designs: working copy + microversions + releases.

The versioned-document API (/api/engine/documents) mirrors the pid-designer
model: an autosaved working copy, throttled microversions, and immutable named
releases. Identity is X-Auth-Email with a `local` dev fallback.

Designs are shared: one lives in its creator's folder but is editable by anyone
on its `sharedWith` list, and readable/copyable by anyone at all. So the
invariant under test is no longer "users cannot see each other" -- it is that
`?owner=` grants exactly the access the share list says it does. The 403/404
matrix below walks the router's own route table, so an endpoint added without
going through `_resolve_doc` fails here rather than shipping a hole.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.routers import documents  # noqa: E402

# Just the documents router, not backend.main: importing the whole app drags in
# the native engine kernel and the optimizer, which this suite has no use for.
# It is the same router the app mounts, so the request path under test is real.
app = FastAPI()
app.include_router(documents.router)

A = {"X-Auth-Email": "alice@berkeley.edu"}
B = {"X-Auth-Email": "bob@berkeley.edu"}


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Fresh data root per test; force a microversion on every autosave (no
    throttle) and clear the in-process throttle clock so tests don't interfere."""
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    monkeypatch.setattr(documents.store, "micro_interval", 0)
    documents.store.last_micro.clear()


@pytest.fixture
def client():
    return TestClient(app)


#: `?owner=alice`, for a request acting on one of Alice's configs.
OWNER_A = {"owner": A["X-Auth-Email"]}

BASE = "/api/engine/documents"


def _create(client, headers, name="Baseline", config=None):
    r = client.post(BASE, headers=headers,
                    json={"name": name, "config": config or {"combustion": {}}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _share(client, doc_id, emails, *, headers=A, params=None):
    r = client.put(f"{BASE}/{doc_id}/share", headers=headers,
                   params=params if params is not None else {}, json={"sharedWith": emails})
    assert r.status_code == 200, r.text
    return r.json()


def _find(client, headers, doc_id):
    return next(d for d in client.get(BASE, headers=headers).json() if d["id"] == doc_id)


# ── CRUD + isolation ─────────────────────────────────────────────────────────


def test_create_lists_and_isolates_until_shared(client):
    a_id = _create(client, A, "Alice design")
    _create(client, B, "Bob design")

    a_list = client.get("/api/engine/documents", headers=A).json()
    b_list = client.get("/api/engine/documents", headers=B).json()
    assert [d["id"] for d in a_list] == [a_id]
    assert a_id not in [d["id"] for d in b_list]  # B never sees A's doc
    assert a_list[0]["mine"] is True and a_list[0]["owner"] == A["X-Auth-Email"]

    _share(client, a_id, [B["X-Auth-Email"]])
    b_list = client.get("/api/engine/documents", headers=B).json()
    entry = next(d for d in b_list if d["id"] == a_id)
    assert entry["owner"] == A["X-Auth-Email"] and entry["mine"] is False


def test_rename(client):
    doc_id = _create(client, A)
    r = client.patch(f"/api/engine/documents/{doc_id}", headers=A, json={"name": "Renamed"})
    assert r.status_code == 200 and r.json()["name"] == "Renamed"
    assert [c["name"] for c in client.get("/api/engine/documents", headers=A).json()] == ["Renamed"]


def test_delete_is_gone(client):
    """Configs are never deleted -- shared configs made it too easy to destroy
    someone else's work. Cleanup is an admin operation on the volume.

    `/{id}/share/me` is the one DELETE that survives, and it drops a share
    grant, not a config."""
    doc_id = _create(client, A)
    assert client.delete(f"/api/engine/documents/{doc_id}", headers=A).status_code == 405
    deletes = {r.path for r in documents.router.routes
               if "DELETE" in getattr(r, "methods", set())}
    assert deletes == {"/api/engine/documents/{doc_id}/share/me"}


# ── working copy + microversions ─────────────────────────────────────────────


def test_autosave_load_and_history(client):
    doc_id = _create(client, A)
    cfg = {"combustion": {"efficiency": {"c_star": 0.95}}, "note": "v1"}
    assert client.post(f"/api/engine/documents/{doc_id}/autosave",
                       headers=A, json={"config": cfg}).json()["micro"] is True

    # /load returns the freshest working copy.
    assert client.get(f"/api/engine/documents/{doc_id}/load", headers=A).json()["config"] == cfg

    # The autosave recorded a microversion; fetch it back verbatim.
    history = client.get(f"/api/engine/documents/{doc_id}/history", headers=A).json()
    assert len(history) >= 1
    vid = history[0]["versionId"]
    snap = client.get(f"/api/engine/documents/{doc_id}/version/{vid}", headers=A).json()
    assert snap["config"] == cfg


def test_history_needs_a_share(client):
    """Bob naming Alice's config gets 404 without ?owner= (no such config of his
    own) and 403 with it (hers, not shared) -- never her data."""
    a_id = _create(client, A)
    client.post(f"/api/engine/documents/{a_id}/autosave", headers=A,
                json={"config": {"secret": 1}})
    assert client.get(f"/api/engine/documents/{a_id}/history", headers=B).status_code == 404
    assert client.get(f"/api/engine/documents/{a_id}/history",
                      headers=B, params=OWNER_A).status_code == 403


def test_history_readable_once_shared(client):
    a_id = _create(client, A)
    client.post(f"/api/engine/documents/{a_id}/autosave", headers=A,
                json={"config": {"shared": 1}})
    _share(client, a_id, [B["X-Auth-Email"]])
    history = client.get(f"/api/engine/documents/{a_id}/history",
                         headers=B, params=OWNER_A).json()
    assert len(history) >= 1


# ── releases ─────────────────────────────────────────────────────────────────


def test_release_is_immutable_and_listed(client):
    doc_id = _create(client, A)
    cfg = {"combustion": {}, "v": 1}
    r = client.post(f"/api/engine/documents/{doc_id}/release",
                    headers=A, json={"label": "0.1", "config": cfg})
    assert r.status_code == 200 and r.json()["label"] == "0.1"

    # Re-releasing the same label is a conflict -- releases are immutable.
    dup = client.post(f"/api/engine/documents/{doc_id}/release",
                      headers=A, json={"label": "0.1", "config": {"v": 2}})
    assert dup.status_code == 409

    assert "0.1" in [r["label"] for r in
                     client.get(f"/api/engine/documents/{doc_id}/releases", headers=A).json()]
    got = client.get(f"/api/engine/documents/{doc_id}/release/0.1", headers=A).json()
    assert got["config"] == cfg  # the original, not the rejected v:2


def test_restore_returns_older_state(client):
    """The safety net: an autosaved mistake is recoverable from an earlier
    microversion."""
    doc_id = _create(client, A)
    good = {"combustion": {}, "thrust": 1000}
    client.post(f"/api/engine/documents/{doc_id}/autosave", headers=A, json={"config": good})
    client.post(f"/api/engine/documents/{doc_id}/autosave", headers=A,
                json={"config": {"combustion": {}, "thrust": 0}})  # the "mistake"

    history = client.get(f"/api/engine/documents/{doc_id}/history", headers=A).json()
    assert len(history) >= 2
    # The oldest snapshot still holds the good state.
    oldest = client.get(
        f"/api/engine/documents/{doc_id}/version/{history[-1]['versionId']}", headers=A
    ).json()
    assert oldest["config"] == good


# ── sharing ──────────────────────────────────────────────────────────────────


def test_share_grants_edit_and_writes_into_the_owners_folder(client, tmp_path):
    """A shared editor edits the *same* config, not a copy -- so the bytes must
    land in Alice's folder and Alice must see the change."""
    a_id = _create(client, A, "Booster")
    _share(client, a_id, [B["X-Auth-Email"]])

    r = client.post(f"{BASE}/{a_id}/autosave", headers=B, params=OWNER_A,
                    json={"config": {"by": "bob"}})
    assert r.status_code == 200
    assert (tmp_path / "alice@berkeley.edu" / "engine" / a_id / "current.json").is_file()
    assert not (tmp_path / "bob@berkeley.edu" / "engine" / a_id).exists()
    assert client.get(f"{BASE}/{a_id}/load", headers=A).json()["config"] == {"by": "bob"}

    r = client.patch(f"{BASE}/{a_id}", headers=B, params=OWNER_A, json={"name": "Bob's edit"})
    assert r.status_code == 200 and r.json()["name"] == "Bob's edit"


def test_share_replaces_the_whole_list_and_drops_the_owner(client):
    a_id = _create(client, A)
    bob = B["X-Auth-Email"]
    rec = _share(client, a_id, [bob, bob.upper(), "  ", A["X-Auth-Email"]])
    # Deduped on the path slug, the owner filtered out (they are implicitly and
    # unremovably an editor), blanks dropped.
    assert rec["sharedWith"] == [bob]
    assert rec["sharedUpdatedBy"] == A["X-Auth-Email"]

    assert _share(client, a_id, [])["sharedWith"] == []
    assert client.get(f"{BASE}/{a_id}/history", headers=B, params=OWNER_A).status_code == 403


def test_any_editor_may_reshare(client):
    """No owner/editor distinction: a shared editor can change the share list,
    including removing people. Revocation is housekeeping, not a boundary."""
    a_id = _create(client, A)
    _share(client, a_id, [B["X-Auth-Email"]])
    rec = _share(client, a_id, ["carol@berkeley.edu"], headers=B, params=OWNER_A)
    assert rec["sharedWith"] == ["carol@berkeley.edu"]
    assert rec["sharedUpdatedBy"] == B["X-Auth-Email"]


def test_leave_removes_only_yourself(client):
    a_id = _create(client, A)
    _share(client, a_id, [B["X-Auth-Email"], "carol@berkeley.edu"])
    assert client.delete(f"{BASE}/{a_id}/share/me", headers=B, params=OWNER_A).status_code == 200
    assert _find(client, A, a_id)["sharedWith"] == ["carol@berkeley.edu"]
    assert a_id not in [d["id"] for d in client.get(BASE, headers=B).json()]


def test_owner_cannot_leave_their_own_config(client):
    """Otherwise the config ends up in nobody's editable list."""
    a_id = _create(client, A)
    assert client.delete(f"{BASE}/{a_id}/share/me", headers=A).status_code == 400


def test_legacy_records_without_sharedwith_still_work(client, tmp_path):
    """Every config created before sharing existed lacks the key. A missing
    `sharedWith` is an empty list, never an error."""
    index = tmp_path / "alice@berkeley.edu" / "engine" / "index.json"
    index.parent.mkdir(parents=True, exist_ok=True)
    index.write_text(json.dumps([{"id": "old", "name": "Old", "createdAt": "2020-01-01",
                                 "updatedAt": "2020-01-01"}]))

    listed = client.get(BASE, headers=A).json()
    assert [d["id"] for d in listed] == ["old"]
    assert listed[0]["sharedWith"] == []
    assert client.get(f"{BASE}/old/load", headers=A).json() == {"config": {}}
    assert client.get(f"{BASE}/old/history", headers=B, params=OWNER_A).status_code == 403


# ── browse + copy: anyone may look, anyone may take a copy ───────────────────


def test_browse_groups_by_owner_and_hides_what_you_can_edit(client):
    a_id = _create(client, A, "Alice design")
    shared_id = _create(client, A, "Shared design")
    _share(client, shared_id, [B["X-Auth-Email"]])
    _create(client, B, "Bob design")

    tree = client.get(f"{BASE}/browse", headers=B).json()
    assert [g["owner"] for g in tree] == [A["X-Auth-Email"]]
    # Alice's unshared config only: the shared one is editable (so it is in the
    # editable list), and Bob's own never shows up in the view-only tree.
    assert [d["id"] for d in tree[0]["designs"]] == [a_id]


def test_copy_is_independent_and_needs_no_share(client):
    a_id = _create(client, A, "Booster", config={"v": 1})
    client.post(f"{BASE}/{a_id}/autosave", headers=A, json={"config": {"v": 1}})

    copy = client.post(f"{BASE}/copy", headers=B,
                       json={"owner": A["X-Auth-Email"], "id": a_id}).json()
    assert copy["name"] == f"Booster (copy of {A['X-Auth-Email']})"
    assert copy["sharedWith"] == []
    assert client.get(f"{BASE}/{copy['id']}/load", headers=B).json()["config"] == {"v": 1}

    # Editing the copy must not touch the original, nor grant access back to it.
    client.post(f"{BASE}/{copy['id']}/autosave", headers=B, json={"config": {"v": 2}})
    assert client.get(f"{BASE}/{a_id}/load", headers=A).json()["config"] == {"v": 1}
    assert _find(client, A, a_id)["sharedWith"] == []


def test_copy_of_a_missing_config_is_404(client):
    r = client.post(f"{BASE}/copy", headers=B, json={"owner": A["X-Auth-Email"], "id": "nope"})
    assert r.status_code == 404


# ── the access matrix: the guard that must not develop a hole ────────────────


#: Every design-scoped route, as (method, path-suffix, json body). A route added
#: without an entry fails test_every_doc_scoped_route_is_listed below.
_DOC_SCOPED = {
    "rename_document": ("PATCH", "", {"name": "x"}),
    "share_document": ("PUT", "/share", {"sharedWith": []}),
    "leave_document": ("DELETE", "/share/me", None),
    "load_document": ("GET", "/load", None),
    "autosave_document": ("POST", "/autosave", {"config": {"x": 1}}),
    "flush_document": ("POST", "/flush", {"config": {"x": 1}}),
    "get_history": ("GET", "/history", None),
    "get_version": ("GET", "/version/deadbeef", None),
    "create_release": ("POST", "/release", {"label": "0.1"}),
    "list_releases": ("GET", "/releases", None),
    "get_release": ("GET", "/release/0.1", None),
}

#: Not design-scoped: no doc id, or exists precisely to reach configs you cannot edit.
_UNSCOPED = {"list_documents", "browse_documents", "create_document", "copy_document"}


def _call(client, name, doc_id, headers, params):
    method, suffix, body = _DOC_SCOPED[name]
    return client.request(method, f"{BASE}/{doc_id}{suffix}",
                          headers=headers, params=params, json=body)


def test_every_doc_scoped_route_is_listed():
    """Pins the matrix to the real route table. Add an endpoint and this fails
    until you say which side of the access boundary it sits on."""
    handlers = {r.endpoint.__name__ for r in documents.router.routes if hasattr(r, "endpoint")}
    covered = set(_DOC_SCOPED) | _UNSCOPED
    assert handlers == covered, f"unclassified endpoints: {handlers ^ covered}"


@pytest.mark.parametrize("name", sorted(_DOC_SCOPED))
def test_doc_scoped_route_forbids_an_unshared_owner(client, name):
    a_id = _create(client, A)
    assert _call(client, name, a_id, B, OWNER_A).status_code == 403, f"{name} leaked access"


@pytest.mark.parametrize("name", sorted(_DOC_SCOPED))
def test_doc_scoped_route_404s_a_foreign_id_without_owner(client, tmp_path, name):
    """Dropping `?owner=` must 404, never silently create an orphan working copy
    in the caller's own folder -- a failure `/flush` (a sendBeacon) could not
    even report."""
    a_id = _create(client, A)
    before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))
    assert _call(client, name, a_id, B, {}).status_code == 404, f"{name} did not 404"
    assert sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*")) == before


@pytest.mark.parametrize("owner", ["../..", ".", "", "a/b", "..", "./../etc"])
def test_owner_param_cannot_escape_the_root(client, tmp_path, owner):
    a_id = _create(client, A)
    before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))
    assert client.get(f"{BASE}/{a_id}/load", headers=B, params={"owner": owner}).status_code == 404
    # Both the scan and the resolve must be read-only: no folder conjured for a
    # user who does not exist.
    assert sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*")) == before
