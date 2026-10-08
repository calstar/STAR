"""pid-designer as it ships: the curated STAR collection and approved editors.

* Admins choose the STAR diagrams, which everyone sees; the main one is always
  among them and is what a new tab opens on.
* Everyone else sees their own diagrams and those shared with them. Admins see
  everything, and may edit everything.
* A diagram is edited by its creator, its share list, and admins. Only the
  creator or an admin may change the share list.
* Anyone who can see a diagram may ask to edit it; the creator or an admin
  approves (the asker joins the share list) or denies.

test_open_and_main.py and test_diagrams.py switch the store back to the open and
closed modes they guard.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402
from backend.routers import pid as documents  # noqa: E402

A = {"X-Auth-Email": "alice@berkeley.edu"}
B = {"X-Auth-Email": "bob@berkeley.edu"}
C = {"X-Auth-Email": "carol@berkeley.edu"}
ADMIN = {"X-Auth-Email": "admin@berkeley.edu"}
OWNER_A = {"owner": "alice@berkeley.edu"}

BASE = "/api/pid/diagrams"
FEATURED = f"{BASE}/featured"

#: The routes only curated mode offers. The other two test files import this to
#: keep their route tables complete.
CURATED_ROUTES = {
    "star_document", "unstar_document",
    "request_access", "withdraw_access_request", "approve_access", "deny_access",
    "list_access_requests",
}


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    monkeypatch.setenv("STAR_ADMINS", "admin@berkeley.edu")
    monkeypatch.setattr(documents.store, "micro_interval", 0)
    documents.store.last_micro.clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_pid_ships_curated():
    """The configuration under test is the one in backend/routers/pid.py, not
    one a fixture conjured."""
    s = documents.store
    assert (s.curated, s.featured, s.open_to_all, s.main_admin_only) == (True, True, False, False)


def test_every_route_is_classified():
    handlers = {r.endpoint.__name__ for r in documents.router.routes if hasattr(r, "endpoint")}
    assert CURATED_ROUTES <= handlers


# ── helpers ──────────────────────────────────────────────────────────────────


def _create(client, headers, name="Baseline"):
    r = client.post(BASE, headers=headers, json={"name": name})
    assert r.status_code == 200, r.text
    doc_id = r.json()["id"]
    client.delete(f"{BASE}/{doc_id}/checkout", headers=headers)
    return doc_id


def _star(client, doc_id, headers=ADMIN, params=OWNER_A):
    return client.put(f"{BASE}/{doc_id}/star", headers=headers, params=params)


def _ids(rows):
    return {(d["owner"], d["id"]) for d in rows}


def _row(client, headers, doc_id, owner="alice@berkeley.edu"):
    rows = client.get(BASE, headers=headers).json()
    return next((d for d in rows if (d["owner"], d["id"]) == (owner, doc_id)), None)


def _edit(client, headers, doc_id, params=OWNER_A):
    """Take and save: the whole of 'can this person change it'."""
    take = client.post(f"{BASE}/{doc_id}/checkout", headers=headers, params=params)
    if take.status_code != 200:
        return take.status_code
    r = client.post(f"{BASE}/{doc_id}/autosave", headers=headers, params=params,
                    json={"nodes": [{"id": "x"}], "edges": []})
    client.delete(f"{BASE}/{doc_id}/checkout", headers=headers, params=params)
    return r.status_code


# ── who sees what ────────────────────────────────────────────────────────────


def test_a_new_diagram_is_private_to_its_creator(client):
    a_id = _create(client, A)
    assert ("alice@berkeley.edu", a_id) in _ids(client.get(BASE, headers=A).json())
    assert ("alice@berkeley.edu", a_id) not in _ids(client.get(BASE, headers=B).json())
    assert client.get(f"{BASE}/{a_id}/load", headers=B, params=OWNER_A).status_code == 403
    copy = client.post(f"{BASE}/copy", headers=B, json={"owner": "alice@berkeley.edu", "id": a_id})
    assert copy.status_code == 403
    # Nor does browse leak it: curated, the list is everything you may see.
    assert client.get(f"{BASE}/browse", headers=B).json() == []


def test_an_admin_sees_and_edits_everything(client):
    a_id = _create(client, A)
    b_id = _create(client, B)
    listed = _ids(client.get(BASE, headers=ADMIN).json())
    assert {("alice@berkeley.edu", a_id), ("bob@berkeley.edu", b_id)} <= listed
    assert _edit(client, ADMIN, a_id) == 200
    assert _row(client, ADMIN, a_id)["canManage"] is True


def test_a_star_diagram_is_seen_by_everyone_and_edited_by_its_editors(client):
    a_id = _create(client, A)
    assert _star(client, a_id).status_code == 200
    row = _row(client, B, a_id)
    assert row is not None and row["star"] is True
    assert row["editable"] is False and row["canManage"] is False
    assert client.get(f"{BASE}/{a_id}/load", headers=B, params=OWNER_A).status_code == 200
    assert _edit(client, B, a_id) == 403
    assert _edit(client, A, a_id) == 200
    # Seeing it is enough to take a copy.
    copy = client.post(f"{BASE}/copy", headers=B, json={"owner": "alice@berkeley.edu", "id": a_id})
    assert copy.status_code == 200


def test_star_diagrams_head_the_list_after_main(client):
    plain = _create(client, A, "Plain")
    starred = _create(client, A, "Starred")
    main = _create(client, A, "Main")
    _star(client, starred)
    client.put(FEATURED, headers=ADMIN, json={"owner": "alice@berkeley.edu", "id": main})
    _create(client, A, "Newest")  # newest, so it would lead on recency alone
    order = [d["id"] for d in client.get(BASE, headers=A).json()]
    assert order[0] == main
    assert order[1] == starred
    assert order.index(plain) > 1


# ── the STAR set ─────────────────────────────────────────────────────────────


def test_only_an_admin_chooses_star(client):
    a_id = _create(client, A)
    assert _star(client, a_id, headers=A).status_code == 403
    assert _star(client, a_id, headers=B).status_code == 403
    assert _star(client, a_id).status_code == 200
    assert client.delete(f"{BASE}/{a_id}/star", headers=A, params=OWNER_A).status_code == 403
    assert client.delete(f"{BASE}/{a_id}/star", headers=ADMIN, params=OWNER_A).status_code == 200
    assert _row(client, B, a_id) is None


def test_main_is_star_and_unsetting_main_keeps_it_there(client):
    a_id = _create(client, A)
    assert client.put(FEATURED, headers=ADMIN,
                      json={"owner": "alice@berkeley.edu", "id": a_id}).status_code == 200
    assert _row(client, B, a_id)["star"] is True
    assert client.delete(FEATURED, headers=ADMIN).status_code == 200
    row = _row(client, B, a_id)
    assert row["star"] is True and row["featured"] is False


def test_taking_main_out_of_star_stops_it_being_main(client):
    a_id = _create(client, A)
    client.put(FEATURED, headers=ADMIN, json={"owner": "alice@berkeley.edu", "id": a_id})
    assert client.delete(f"{BASE}/{a_id}/star", headers=ADMIN, params=OWNER_A).status_code == 200
    assert client.get(FEATURED, headers=B).json()["featured"] is None
    assert _row(client, B, a_id) is None


def test_main_is_edited_by_its_creator_not_only_admins(client):
    a_id = _create(client, A)
    client.put(FEATURED, headers=ADMIN, json={"owner": "alice@berkeley.edu", "id": a_id})
    assert _edit(client, A, a_id) == 200
    assert _edit(client, B, a_id) == 403
    assert _edit(client, ADMIN, a_id) == 200


def test_a_dangling_star_entry_shows_nothing(client, tmp_path):
    a_id = _create(client, A)
    _star(client, a_id)
    (tmp_path / "alice@berkeley.edu" / "pid" / "index.json").write_text("[]")
    assert client.get(BASE, headers=B).json() == []


def test_featured_reports_curated(client):
    got = client.get(FEATURED, headers=B).json()
    assert got["curated"] is True and got["isAdmin"] is False and got["recentDays"] is None


# ── sharing: the creator or an admin ─────────────────────────────────────────


def _share(client, headers, doc_id, emails, params=OWNER_A):
    return client.put(f"{BASE}/{doc_id}/share", headers=headers, params=params,
                      json={"sharedWith": emails})


def test_sharing_grants_edit_and_only_creator_or_admin_may_share(client):
    a_id = _create(client, A)
    assert _share(client, A, a_id, ["bob@berkeley.edu"]).status_code == 200
    assert _edit(client, B, a_id) == 200
    row = _row(client, B, a_id)
    assert row["editable"] is True and row["canManage"] is False
    # An approved editor edits; they do not decide who else does.
    assert _share(client, B, a_id, ["bob@berkeley.edu", "carol@berkeley.edu"]).status_code == 403
    assert _share(client, ADMIN, a_id, ["carol@berkeley.edu"]).status_code == 200
    assert _edit(client, C, a_id) == 200
    assert _edit(client, B, a_id) == 403


# ── asking to edit ───────────────────────────────────────────────────────────


def _ask(client, headers, doc_id, params=OWNER_A):
    return client.post(f"{BASE}/{doc_id}/access", headers=headers, params=params)


def _answer(client, headers, doc_id, email, verb, params=OWNER_A):
    return client.post(f"{BASE}/{doc_id}/access/{verb}", headers=headers, params=params,
                       json={"email": email})


def test_ask_then_creator_approves(client):
    a_id = _create(client, A)
    _star(client, a_id)
    r = _ask(client, B, a_id)
    assert r.status_code == 200, r.text
    assert r.json()["requestedByMe"] is True
    # The asker learns they asked, not who else did.
    assert r.json()["accessRequests"] == []

    pending = client.get(f"{BASE}/requests", headers=A).json()
    assert [(p["id"], p["email"]) for p in pending] == [(a_id, "bob@berkeley.edu")]
    assert _row(client, A, a_id)["accessRequests"][0]["email"] == "bob@berkeley.edu"

    r = _answer(client, A, a_id, "bob@berkeley.edu", "approve")
    assert r.status_code == 200, r.text
    assert "bob@berkeley.edu" in r.json()["sharedWith"]
    assert r.json()["accessRequests"] == []
    assert _edit(client, B, a_id) == 200
    assert client.get(f"{BASE}/requests", headers=A).json() == []


def test_an_admin_may_answer_and_sees_every_request(client):
    a_id = _create(client, A)
    _star(client, a_id)
    _ask(client, B, a_id)
    assert [p["email"] for p in client.get(f"{BASE}/requests", headers=ADMIN).json()] == ["bob@berkeley.edu"]
    assert _answer(client, ADMIN, a_id, "bob@berkeley.edu", "approve").status_code == 200
    assert _edit(client, B, a_id) == 200


def test_deny_removes_the_request_and_grants_nothing(client):
    a_id = _create(client, A)
    _star(client, a_id)
    _ask(client, B, a_id)
    r = _answer(client, A, a_id, "bob@berkeley.edu", "deny")
    assert r.status_code == 200
    assert r.json()["accessRequests"] == []
    assert _edit(client, B, a_id) == 403
    assert _row(client, B, a_id)["requestedByMe"] is False
    # They may ask again.
    assert _ask(client, B, a_id).status_code == 200


def test_nobody_else_may_answer_or_see_who_asked(client):
    a_id = _create(client, A)
    _star(client, a_id)
    _share(client, A, a_id, ["carol@berkeley.edu"])  # an editor, not a manager
    _ask(client, B, a_id)
    for who in (B, C):
        assert _answer(client, who, a_id, "bob@berkeley.edu", "approve").status_code == 403
        assert _answer(client, who, a_id, "bob@berkeley.edu", "deny").status_code == 403
        assert client.get(f"{BASE}/requests", headers=who).json() == []
        assert _row(client, who, a_id)["accessRequests"] == []
    # And the raw record field does not ride along on the list either.
    assert _edit(client, B, a_id) == 403


def test_cannot_ask_for_what_you_cannot_see_or_already_have(client):
    a_id = _create(client, A)
    assert _ask(client, B, a_id).status_code == 403
    assert _ask(client, A, a_id).status_code == 400
    assert _ask(client, ADMIN, a_id).status_code == 400


def test_asking_twice_is_one_request_and_withdraw_takes_it_back(client):
    a_id = _create(client, A)
    _star(client, a_id)
    _ask(client, B, a_id)
    _ask(client, B, a_id)
    assert len(client.get(f"{BASE}/requests", headers=A).json()) == 1
    r = client.delete(f"{BASE}/{a_id}/access", headers=B, params=OWNER_A)
    assert r.status_code == 200 and r.json()["requestedByMe"] is False
    assert client.get(f"{BASE}/requests", headers=A).json() == []


def test_answering_a_request_nobody_made_is_404(client):
    a_id = _create(client, A)
    assert _answer(client, A, a_id, "bob@berkeley.edu", "approve").status_code == 404
    assert _edit(client, B, a_id) == 403


def test_sharing_with_someone_who_asked_answers_them(client):
    a_id = _create(client, A)
    _star(client, a_id)
    _ask(client, B, a_id)
    _share(client, A, a_id, ["bob@berkeley.edu"])
    assert client.get(f"{BASE}/requests", headers=A).json() == []


def test_admin_requests_can_be_seen_on_diagrams_admins_cannot_otherwise_share(client):
    """An admin answers on anyone's diagram, including one whose creator has
    shared it with nobody."""
    b_id = _create(client, B)
    _star(client, b_id, params={"owner": "bob@berkeley.edu"})
    _ask(client, C, b_id, params={"owner": "bob@berkeley.edu"})
    assert _answer(client, ADMIN, b_id, "carol@berkeley.edu", "approve",
                   params={"owner": "bob@berkeley.edu"}).status_code == 200
    assert _edit(client, C, b_id, params={"owner": "bob@berkeley.edu"}) == 200


def test_someone_unshared_mid_edit_can_still_rescue_their_edits(client):
    """Unshared from a private diagram, they lose sight of it as well as edit
    rights -- and what they typed must still be theirs to keep."""
    a_id = _create(client, A)
    _share(client, A, a_id, ["bob@berkeley.edu"])
    _share(client, A, a_id, [])
    assert client.get(f"{BASE}/{a_id}/load", headers=B, params=OWNER_A).status_code == 403
    r = client.post(f"{BASE}/{a_id}/rescue", headers=B, params=OWNER_A,
                    json={"nodes": [{"id": "typed"}], "edges": []})
    assert r.status_code == 200, r.text
    assert r.json()["mine"] is True
    assert client.get(f"{BASE}/{r.json()['id']}/load", headers=B).json()["nodes"] == [{"id": "typed"}]
