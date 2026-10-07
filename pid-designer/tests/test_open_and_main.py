"""pid-designer as it ships: open to all, a recent window, an admin-only main.

test_diagrams.py pins the shared router's closed model (creator plus share
list); this file is the configuration pid-designer actually runs:

* every diagram is editable by everyone -- checkouts, not ownership, stop two
  people saving at once;
* the list shows other people's diagrams from the last ``recent_days``, and
  ``/browse`` holds exactly the rest, still openable;
* an admin may choose a main diagram, which everyone can open and copy and
  only an admin may change -- not even its creator.

Admins come from :mod:`stardesign.admins`: a fixed list, plus ``STAR_ADMINS``,
which these tests use to name one.
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402
from stardesign import admins  # noqa: E402

from backend.main import app  # noqa: E402
from backend.routers import pid as documents  # noqa: E402

A = {"X-Auth-Email": "alice@berkeley.edu"}
B = {"X-Auth-Email": "bob@berkeley.edu"}
ADMIN = {"X-Auth-Email": "admin@berkeley.edu"}
OWNER_A = {"owner": "alice@berkeley.edu"}

BASE = "/api/pid/diagrams"
FEATURED = f"{BASE}/featured"


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    monkeypatch.setenv("STAR_ADMINS", "admin@berkeley.edu")
    monkeypatch.setattr(documents.store, "micro_interval", 0)
    documents.store.last_micro.clear()


@pytest.fixture
def client():
    return TestClient(app)


def _create(client, headers, name="Baseline"):
    r = client.post(BASE, headers=headers, json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _save(client, headers, doc_id, nodes, params=OWNER_A):
    r = client.post(f"{BASE}/{doc_id}/autosave", headers=headers, params=params,
                    json={"nodes": nodes, "edges": []})
    return r


def _release(client, headers, doc_id, params=OWNER_A):
    client.delete(f"{BASE}/{doc_id}/checkout", headers=headers, params=params)


def _age(tmp_path, user, doc_id, days):
    """Backdate a diagram's updatedAt, as if nobody had touched it for `days`."""
    p = tmp_path / user / "pid" / "index.json"
    index = json.loads(p.read_text())
    when = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    for r in index:
        if r["id"] == doc_id:
            r["updatedAt"] = when
    p.write_text(json.dumps(index))


def _feature(client, doc_id, owner="alice@berkeley.edu", headers=ADMIN):
    return client.put(FEATURED, headers=headers, json={"owner": owner, "id": doc_id})


def _ids(rows):
    return {(d["owner"], d["id"]) for d in rows}


def _browse_ids(rows):
    return {(g["owner"], d["id"]) for g in rows for d in g["designs"]}


# ── open to all ──────────────────────────────────────────────────────────────


def test_anyone_can_edit_anyones_diagram(client):
    a_id = _create(client, A)
    _release(client, A, a_id)
    assert client.post(f"{BASE}/{a_id}/checkout", headers=B, params=OWNER_A).status_code == 200
    assert _save(client, B, a_id, [{"id": "n1"}]).status_code == 200
    assert client.get(f"{BASE}/{a_id}/load", headers=A, params=OWNER_A).json()["nodes"] == [{"id": "n1"}]


def test_checkouts_still_stop_two_people_saving(client):
    a_id = _create(client, A)  # the creator holds it
    assert client.post(f"{BASE}/{a_id}/checkout", headers=B, params=OWNER_A).status_code == 423
    assert _save(client, B, a_id, [{"id": "x"}]).status_code == 423


# ── the recent window ────────────────────────────────────────────────────────


def test_quiet_diagrams_move_to_browse_and_still_open(client, tmp_path):
    fresh = _create(client, A, "Fresh")
    stale = _create(client, A, "Stale")
    _age(tmp_path, "alice@berkeley.edu", stale, documents.store.recent_days + 1)

    listed = _ids(client.get(BASE, headers=B).json())
    browsed = client.get(f"{BASE}/browse", headers=B).json()
    assert ("alice@berkeley.edu", fresh) in listed
    assert ("alice@berkeley.edu", stale) not in listed
    assert _browse_ids(browsed) == {("alice@berkeley.edu", stale)}
    assert browsed[0]["designs"][0]["editable"] is True
    # Out of the list is not out of reach.
    assert client.get(f"{BASE}/{stale}/load", headers=B, params=OWNER_A).status_code == 200


def test_your_own_never_age_out(client, tmp_path):
    stale = _create(client, A, "Stale")
    _age(tmp_path, "alice@berkeley.edu", stale, 400)
    assert ("alice@berkeley.edu", stale) in _ids(client.get(BASE, headers=A).json())


def test_list_and_browse_partition_everything(client, tmp_path):
    """Nothing falls between the two views and nothing is in both."""
    made = set()
    for i, who in enumerate([A, A, B, B, ADMIN]):
        doc_id = _create(client, who, f"D{i}")
        made.add((who["X-Auth-Email"], doc_id))
        if i % 2:
            _age(tmp_path, who["X-Auth-Email"], doc_id, 30)
    for viewer in (A, B, ADMIN):
        listed = _ids(client.get(BASE, headers=viewer).json())
        browsed = _browse_ids(client.get(f"{BASE}/browse", headers=viewer).json())
        assert not listed & browsed
        assert listed | browsed == made


# ── the main diagram: who may choose it ──────────────────────────────────────


def test_only_an_admin_can_choose_the_main_diagram(client):
    a_id = _create(client, A)
    assert _feature(client, a_id, headers=A).status_code == 403
    assert _feature(client, a_id, headers=B).status_code == 403
    assert client.get(FEATURED, headers=B).json() == {
        "featured": None, "isAdmin": False, "recentDays": documents.store.recent_days,
    }

    r = _feature(client, a_id)
    assert r.status_code == 200, r.text
    got = client.get(FEATURED, headers=B).json()
    assert (got["featured"]["owner"], got["featured"]["id"]) == ("alice@berkeley.edu", a_id)
    assert got["featured"]["setBy"] == "admin@berkeley.edu"
    assert client.get(FEATURED, headers=ADMIN).json()["isAdmin"] is True

    assert client.delete(FEATURED, headers=B).status_code == 403
    assert client.delete(FEATURED, headers=ADMIN).status_code == 200
    assert client.get(FEATURED, headers=B).json()["featured"] is None


def test_featuring_a_diagram_that_does_not_exist_is_404(client):
    assert _feature(client, "nope").status_code == 404


def test_without_the_dev_override_only_the_list_can_choose(client, monkeypatch):
    monkeypatch.delenv("STAR_ADMINS")
    a_id = _create(client, A)
    assert _feature(client, a_id, headers=ADMIN).status_code == 403
    listed = {"X-Auth-Email": admins.ADMIN_EMAILS[0]}
    assert _feature(client, a_id, headers=listed).status_code == 200


# ── the main diagram: who may change it ──────────────────────────────────────


#: Every diagram-scoped route, and whether a non-admin may use it on the main
#: diagram. Pinned to the route table by the test below, so a new route has to
#: say which side it is on.
_ON_MAIN = {
    "rename_document": ("PATCH", "", {"name": "x"}, False),
    "share_document": ("PUT", "/share", {"sharedWith": []}, False),
    "leave_document": ("DELETE", "/share/me", None, False),
    "take_checkout": ("POST", "/checkout", None, False),
    "release_checkout": ("DELETE", "/checkout", None, False),
    "release_checkout_beacon": ("POST", "/checkout/release", None, False),
    "beat_checkout": ("POST", "/checkout/beat", None, False),
    "get_checkout": ("GET", "/checkout", None, True),
    "load_document": ("GET", "/load", None, True),
    "autosave_document": ("POST", "/autosave", {"nodes": [], "edges": []}, False),
    "flush_document": ("POST", "/flush", {"nodes": [], "edges": []}, False),
    "get_history": ("GET", "/history", None, True),
    "get_version": ("GET", "/version/deadbeef", None, True),
    "create_release": ("POST", "/release", {"label": "0.1"}, False),
    "list_releases": ("GET", "/releases", None, True),
    "get_release": ("GET", "/release/0.1", None, True),
}
_NOT_DOC_SCOPED = {"list_documents", "browse_documents", "create_document", "copy_document",
                   "get_featured", "set_featured", "clear_featured"}


def test_every_route_says_whether_it_writes_the_main_diagram():
    handlers = {r.endpoint.__name__ for r in documents.router.routes if hasattr(r, "endpoint")}
    assert handlers == set(_ON_MAIN) | _NOT_DOC_SCOPED


@pytest.mark.parametrize("name", sorted(_ON_MAIN))
@pytest.mark.parametrize("who", [A, B], ids=["its-creator", "anyone-else"])
def test_main_diagram_is_read_only_for_non_admins(client, name, who):
    a_id = _create(client, A)
    _release(client, A, a_id)
    assert _feature(client, a_id).status_code == 200
    method, suffix, body, allowed = _ON_MAIN[name]
    r = client.request(method, f"{BASE}/{a_id}{suffix}", headers=who, params=OWNER_A, json=body)
    if allowed:
        assert r.status_code != 403, f"{name} refused a reader"
    else:
        assert r.status_code == 403, f"{name} let a non-admin change the main diagram"


def test_an_admin_can_change_the_main_diagram(client):
    a_id = _create(client, A)
    _release(client, A, a_id)
    _feature(client, a_id)
    assert client.post(f"{BASE}/{a_id}/checkout", headers=ADMIN, params=OWNER_A).status_code == 200
    assert _save(client, ADMIN, a_id, [{"id": "main"}]).status_code == 200
    rel = client.post(f"{BASE}/{a_id}/release", headers=ADMIN, params=OWNER_A, json={"label": "1.0"})
    assert rel.status_code == 200


def test_main_heads_every_list_whatever_its_age(client, tmp_path):
    a_id = _create(client, A, "Main")
    _age(tmp_path, "alice@berkeley.edu", a_id, 400)
    _create(client, B, "Newer")
    _feature(client, a_id)
    for viewer in (A, B, ADMIN):
        rows = client.get(BASE, headers=viewer).json()
        assert (rows[0]["owner"], rows[0]["id"], rows[0]["featured"]) == ("alice@berkeley.edu", a_id, True)
        assert rows[0]["editable"] is (viewer is ADMIN)
        assert all(not r["featured"] for r in rows[1:])
    assert not _browse_ids(client.get(f"{BASE}/browse", headers=B).json())


def test_a_dangling_main_pointer_locks_nothing(client, tmp_path):
    a_id = _create(client, A)
    _release(client, A, a_id)
    _feature(client, a_id)
    # The diagram vanishes from under the pointer (an admin cleaning the volume).
    (tmp_path / "alice@berkeley.edu" / "pid" / "index.json").write_text("[]")
    b_id = _create(client, B)
    assert client.get(FEATURED, headers=B).json()["featured"] is None
    assert _save(client, B, b_id, [{"id": "ok"}], params={}).status_code == 200


# ── copies of the main diagram ───────────────────────────────────────────────


def test_a_copy_remembers_where_it_came_from_and_what_it_was(client, tmp_path):
    a_id = _create(client, A, "Main")
    _save(client, A, a_id, [{"id": "n1"}])
    _release(client, A, a_id)
    _feature(client, a_id)

    r = client.post(f"{BASE}/copy", headers=B, json={"owner": "alice@berkeley.edu", "id": a_id})
    assert r.status_code == 200, r.text
    copy = r.json()
    assert copy["mine"] and copy["editable"] and not copy["featured"]
    assert copy["copiedFrom"]["owner"] == "alice@berkeley.edu"
    assert copy["copiedFrom"]["id"] == a_id

    # Main moves on; the copy's base does not.
    client.post(f"{BASE}/{a_id}/checkout", headers=ADMIN, params=OWNER_A)
    _save(client, ADMIN, a_id, [{"id": "n1"}, {"id": "n2"}])
    base = json.loads((tmp_path / "bob@berkeley.edu" / "pid" / copy["id"] / "base.json").read_text())
    assert base["nodes"] == [{"id": "n1"}]

    # And the copy is Bob's to edit.
    assert _save(client, B, copy["id"], [{"id": "mine"}], params={}).status_code == 200


# ── who is an admin ──────────────────────────────────────────────────────────


#: Spelled out here rather than read from admins.ADMIN_EMAILS: a test that loops
#: over the list it checks passes with a typo in it.
_EXPECTED_ADMINS = (
    "aahilsyed72@berkeley.edu",
    "carlosbautista@berkeley.edu",
    "aidanrickert@berkeley.edu",
)


@pytest.mark.parametrize("email", _EXPECTED_ADMINS)
def test_the_listed_admins_are_admins(client, monkeypatch, email):
    monkeypatch.delenv("STAR_ADMINS")
    assert client.get(FEATURED, headers={"X-Auth-Email": email}).json()["isAdmin"] is True


def test_admin_emails_match_case_insensitively(client, monkeypatch):
    monkeypatch.delenv("STAR_ADMINS")
    upper = {"X-Auth-Email": admins.ADMIN_EMAILS[0].upper()}
    assert client.get(FEATURED, headers=upper).json()["isAdmin"] is True


def test_anyone_else_is_not(client, monkeypatch):
    monkeypatch.delenv("STAR_ADMINS")
    for who in (A, B, ADMIN, {}):
        assert client.get(FEATURED, headers=who).json()["isAdmin"] is False
