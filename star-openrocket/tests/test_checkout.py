"""Design checkouts: at most one holder, ever.

Concurrent editing is not resolved here, it is prevented. The property that
matters is the one a single-threaded test cannot show: two people pressing Take
at the same instant must not both succeed. That is what
`test_only_one_of_many_simultaneous_takes_wins` exists for -- it races real
processes through the real `flock`, because a mocked lock proves nothing about a
lock.

Everything else follows from that: only the holder may save, a checkout lapses
if nobody saves for `lock_ttl`, and none of it touches the operations that are
not concurrent editing (rename, share, copy).
"""

import fcntl
import json
import os
import sys
import multiprocessing

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402
from backend.routers import documents  # noqa: E402

A = {"X-Auth-Email": "alice@berkeley.edu"}
B = {"X-Auth-Email": "bob@berkeley.edu"}
OWNER_A = {"owner": A["X-Auth-Email"]}
BASE = "/api/documents"
#: The <app> path segment this tool stores under.
APP_SEGMENT = "openrocket"


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    monkeypatch.setattr(documents.store, "micro_interval", 0)
    documents.store.last_micro.clear()


@pytest.fixture
def client():
    return TestClient(app)


def _create(client, headers=A, name="Feed system"):
    r = client.post(BASE, headers=headers, json={"name": name, "config": {}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _free(client, doc_id, headers=A, params=None):
    """Release a freshly created design, since creating one now checks it out.

    Several tests below need a design nobody holds; this is what makes that
    explicit rather than an assumption about what `_create` leaves behind.
    """
    r = client.delete(f"{BASE}/{doc_id}/checkout", headers=headers,
                      params=params if params is not None else {})
    assert r.status_code == 200, r.text


def _share(client, doc_id, emails):
    assert client.put(f"{BASE}/{doc_id}/share", headers=A,
                      json={"sharedWith": emails}).status_code == 200


def _save(client, doc_id, headers, params=None, config=None):
    return client.post(f"{BASE}/{doc_id}/autosave", headers=headers,
                       params=params if params is not None else {},
                       json={"config": config or {"v": 1}})


# ── the guarantee ────────────────────────────────────────────────────────────


def _race_take(barrier, results, root, doc_id, email, base, owner_param):
    """One contender, in its own process.

    Threads would not prove anything: `flock` is held per open file description,
    so the contention that matters is between processes, exactly as it is
    between the API's workers.

    The barrier is the point. Without it the pool tends to run these one after
    another -- each finishes before the next starts, nobody actually races, and
    the test passes even with the locking removed. Every process parks here
    until all of them are ready, so they go for the design together.
    """
    os.environ["USERDATA_DIR"] = root
    try:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient as TC

        # `documents` is already imported at module scope; the fork inherits it,
        # so there is nothing to re-import (and the module is named differently
        # in each app).
        fresh = FastAPI()
        fresh.include_router(documents.router)
        with TC(fresh) as c:
            barrier.wait(timeout=30)
            r = c.post(f"{base}/{doc_id}/checkout",
                       headers={"X-Auth-Email": email}, params=owner_param)
            results.put(r.status_code)
    except Exception as exc:  # a crashed contender must not look like a loser
        results.put(f"error: {exc!r}")


@pytest.mark.parametrize("attempt", range(5))
def test_only_one_of_many_simultaneous_takes_wins(client, tmp_path, attempt):
    """The whole feature in one assertion, repeated -- a race that passes once
    has proved nothing."""
    doc_id = _create(client)
    contenders = [f"user{i}@berkeley.edu" for i in range(8)]
    _share(client, doc_id, contenders)
    _free(client, doc_id)  # creating it checked it out to Alice

    ctx = multiprocessing.get_context("fork")  # inherit the imported app
    barrier = ctx.Barrier(len(contenders))
    results = ctx.Queue()
    procs = [
        ctx.Process(target=_race_take,
                    args=(barrier, results, str(tmp_path), doc_id, e, BASE, OWNER_A))
        for e in contenders
    ]
    for p in procs:
        p.start()
    for p in procs:
        p.join(timeout=60)

    codes = [results.get(timeout=5) for _ in contenders]
    assert all(isinstance(c, int) for c in codes), f"a contender crashed: {codes}"
    assert codes.count(200) == 1, f"expected exactly one winner, got {codes}"
    assert codes.count(423) == len(contenders) - 1, codes

    # And the index agrees with whoever won -- one holder, not a torn record.
    index = json.loads((tmp_path / "alice@berkeley.edu" / APP_SEGMENT / "index.json").read_text())
    record = next(r for r in index if r["id"] == doc_id)
    assert record["lockedBy"] in contenders


# ── only the holder may save ────────────────────────────────────────────────


def test_holder_may_save_and_others_may_not(client):
    doc_id = _create(client)
    _share(client, doc_id, [B["X-Auth-Email"]])

    assert client.post(f"{BASE}/{doc_id}/checkout", headers=A).status_code == 200
    assert _save(client, doc_id, A).status_code == 200
    r = _save(client, doc_id, B, params=OWNER_A)
    assert r.status_code == 423
    assert "checked out by" in r.json()["detail"]


def test_saving_without_taking_it_is_refused(client):
    """Opening a design does not take it, so a save without the checkout must
    fail rather than quietly claiming the design.

    Creating one *does* check it out, so this releases first to get at the state
    a second person opening the design would be in.
    """
    doc_id = _create(client)
    _free(client, doc_id)
    r = _save(client, doc_id, A)
    assert r.status_code == 423
    assert "Take" in r.json()["detail"]


@pytest.mark.parametrize("path,method,body", [
    ("/autosave", "POST", {"config": {}}),
    ("/flush", "POST", {"config": {}}),
    ("/release", "POST", {"label": "0.1"}),
])
def test_every_content_write_needs_the_checkout(client, path, method, body):
    doc_id = _create(client)
    _share(client, doc_id, [B["X-Auth-Email"]])
    assert client.post(f"{BASE}/{doc_id}/checkout", headers=A).status_code == 200
    r = client.request(method, f"{BASE}/{doc_id}{path}", headers=B, params=OWNER_A, json=body)
    assert r.status_code == 423, f"{path} was writable by a non-holder"


@pytest.mark.parametrize("name,method,path,body", [
    ("rename", "PATCH", "", {"name": "Renamed"}),
    ("share", "PUT", "/share", {"sharedWith": []}),
])
def test_housekeeping_is_not_blocked_by_someone_elses_checkout(client, name, method, path, body):
    """A checkout guards the design's *content*. Renaming or re-sharing is not
    concurrent editing, and blocking it would let a stale checkout freeze a
    design nobody can tidy."""
    doc_id = _create(client)
    _share(client, doc_id, [B["X-Auth-Email"]])
    assert client.post(f"{BASE}/{doc_id}/checkout", headers=A).status_code == 200
    r = client.request(method, f"{BASE}/{doc_id}{path}", headers=B, params=OWNER_A, json=body)
    assert r.status_code == 200, f"{name} was blocked by a checkout"


def test_copying_is_not_blocked_by_a_checkout(client):
    doc_id = _create(client)
    assert client.post(f"{BASE}/{doc_id}/checkout", headers=A).status_code == 200
    r = client.post(f"{BASE}/copy", headers=B, json={"owner": A["X-Auth-Email"], "id": doc_id})
    assert r.status_code == 200


# ── lapsing ─────────────────────────────────────────────────────────────────


def test_a_checkout_lapses_and_the_next_person_can_take_it(client, monkeypatch):
    doc_id = _create(client)
    _share(client, doc_id, [B["X-Auth-Email"]])
    assert client.post(f"{BASE}/{doc_id}/checkout", headers=A).status_code == 200
    assert client.post(f"{BASE}/{doc_id}/checkout", headers=B, params=OWNER_A).status_code == 423

    monkeypatch.setattr(documents.store, "lock_ttl", 0)  # everything is stale now
    assert client.post(f"{BASE}/{doc_id}/checkout", headers=B, params=OWNER_A).status_code == 200


def test_the_previous_holder_is_refused_rather_than_silently_overwriting(client, monkeypatch):
    """The dangerous case: A's checkout lapses, B takes it, and A's tab is still
    autosaving. A must be refused, not allowed to overwrite B."""
    doc_id = _create(client)
    _share(client, doc_id, [B["X-Auth-Email"]])
    client.post(f"{BASE}/{doc_id}/checkout", headers=A)
    monkeypatch.setattr(documents.store, "lock_ttl", 0)
    client.post(f"{BASE}/{doc_id}/checkout", headers=B, params=OWNER_A)
    monkeypatch.setattr(documents.store, "lock_ttl", 900)

    assert _save(client, doc_id, A, config={"v": "stale"}).status_code == 423
    assert _save(client, doc_id, B, params=OWNER_A, config={"v": "fresh"}).status_code == 200
    assert client.get(f"{BASE}/{doc_id}/load", headers=A).json()["config"] == {"v": "fresh"}


def test_saving_keeps_the_checkout_alive(client):
    """`lock_ttl` measures time since the last *save*, so someone actively
    editing never loses the design out from under themselves."""
    doc_id = _create(client)
    client.post(f"{BASE}/{doc_id}/checkout", headers=A)
    first = client.get(f"{BASE}/{doc_id}/checkout", headers=A).json()["lockExpiresAt"]
    _save(client, doc_id, A, config={"v": "later"})
    assert client.get(f"{BASE}/{doc_id}/checkout", headers=A).json()["lockExpiresAt"] >= first


# ── releasing, and reporting ────────────────────────────────────────────────


def test_release_is_idempotent_and_holder_only(client):
    doc_id = _create(client)
    _share(client, doc_id, [B["X-Auth-Email"]])
    client.post(f"{BASE}/{doc_id}/checkout", headers=A)

    # Not the holder: a no-op, not a theft.
    assert client.delete(f"{BASE}/{doc_id}/checkout", headers=B, params=OWNER_A).status_code == 200
    assert client.get(f"{BASE}/{doc_id}/checkout", headers=A).json()["lockedByMe"] is True

    assert client.delete(f"{BASE}/{doc_id}/checkout", headers=A).status_code == 200
    assert client.delete(f"{BASE}/{doc_id}/checkout", headers=A).status_code == 200
    assert client.get(f"{BASE}/{doc_id}/checkout", headers=A).json()["lockedBy"] is None


def test_the_list_reports_the_checkout_without_an_extra_call(client):
    doc_id = _create(client)
    _share(client, doc_id, [B["X-Auth-Email"]])
    client.post(f"{BASE}/{doc_id}/checkout", headers=A)

    mine = next(d for d in client.get(BASE, headers=A).json() if d["id"] == doc_id)
    assert mine["lockedByMe"] is True and mine["lockedBy"] == A["X-Auth-Email"]

    theirs = next(d for d in client.get(BASE, headers=B).json() if d["id"] == doc_id)
    assert theirs["lockedByMe"] is False and theirs["lockedBy"] == A["X-Auth-Email"]


def test_designs_predating_checkouts_read_as_free(client, tmp_path):
    """Every existing design has no lock fields at all."""
    index = tmp_path / "alice@berkeley.edu" / APP_SEGMENT / "index.json"
    index.parent.mkdir(parents=True, exist_ok=True)
    index.write_text(json.dumps([{"id": "old", "name": "Old",
                                  "createdAt": "2020-01-01", "updatedAt": "2020-01-01"}]))
    assert client.get(f"{BASE}/old/checkout", headers=A).json()["lockedBy"] is None
    assert client.post(f"{BASE}/old/checkout", headers=A).status_code == 200

def _take_in_child(results, root, doc_id, base, owner_param, email):
    """A single take, in its own process, reporting its status code."""
    os.environ["USERDATA_DIR"] = root
    try:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient as TC

        fresh = FastAPI()
        fresh.include_router(documents.router)
        with TC(fresh) as c:
            r = c.post(f"{base}/{doc_id}/checkout",
                       headers={"X-Auth-Email": email}, params=owner_param)
            results.put(r.status_code)
    except Exception as exc:
        results.put(f"error: {exc!r}")


def test_take_cannot_proceed_while_the_index_lock_is_held(client, tmp_path):
    """Deterministic proof that the compare-and-set is genuinely serialised.

    The race above is probabilistic: the critical section is sub-millisecond, so
    contenders often fail to interleave and it can pass even with the locking
    removed. This one cannot. It grabs the very same `flock` the take path uses,
    then asserts a take *blocks* until it is released -- which is exactly the
    property that makes two simultaneous holders impossible.
    """
    doc_id = _create(client)
    lock_path = tmp_path / "alice@berkeley.edu" / APP_SEGMENT / ".index.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    ctx = multiprocessing.get_context("fork")
    results = ctx.Queue()
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
    proc = ctx.Process(target=_take_in_child,
                       args=(results, str(tmp_path), doc_id, BASE, OWNER_A,
                             "bob@berkeley.edu"))
    # Share BEFORE taking the lock. `_share` goes through the API, which needs
    # the same flock -- doing it inside would deadlock this process against
    # itself, and flock gives no warning when it does.
    _share(client, doc_id, ["bob@berkeley.edu"])
    _free(client, doc_id)  # creating it checked it out to Alice

    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        proc.start()
        proc.join(timeout=3)
        assert proc.is_alive(), (
            "a checkout completed while the index lock was held -- the "
            "compare-and-set is not serialised, so two people can hold one design"
        )
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)

    proc.join(timeout=30)
    assert not proc.is_alive(), "the take never completed after the lock was released"
    assert results.get(timeout=5) == 200


def test_creating_a_design_checks_it_out_to_you(client):
    """You made it a moment ago; nobody else can possibly hold it.

    Without this you create a design, start editing, and every save is refused
    until you notice a button you had no reason to look at -- which reads as
    "the thing I just made keeps losing my work".
    """
    doc_id = _create(client)
    state = client.get(f"{BASE}/{doc_id}/checkout", headers=A).json()
    assert state["lockedByMe"] is True
    # ...and that is not cosmetic: an edit right after creating must persist.
    assert _save(client, doc_id, A).status_code == 200


def test_copying_a_design_checks_the_copy_out_to_you(client):
    """Same reasoning: you take a copy in order to work on it."""
    a_id = _create(client)
    copy = client.post(f"{BASE}/copy", headers=B,
                       json={"owner": A["X-Auth-Email"], "id": a_id}).json()
    state = client.get(f"{BASE}/{copy['id']}/checkout", headers=B).json()
    assert state["lockedByMe"] is True
    assert _save(client, copy["id"], B).status_code == 200


def test_creating_does_not_touch_anyone_elses_checkout(client):
    """A new design carries its own checkout; it must not disturb a design
    someone else is holding."""
    a_id = _create(client)
    _share(client, a_id, [B["X-Auth-Email"]])
    _create(client, B, "Bob's own")
    assert client.get(f"{BASE}/{a_id}/checkout", headers=A).json()["lockedByMe"] is True


# ── the shape every returned record must have ────────────────────────────────


#: Fields the design bar reads off a record. A response missing `mine` is not a
#: cosmetic problem: the bar reads its absence as "someone else's design" and
#: captions your own design "<name> - undefined".
DECORATED = {"owner", "ownerName", "mine", "sharedWith", "lockedByMe"}


def test_every_endpoint_that_returns_a_record_returns_a_decorated_one(client):
    doc_id = _create(client)

    listed = client.get(BASE, headers=A).json()[0]
    assert DECORATED <= set(listed), f"list: missing {DECORATED - set(listed)}"

    created = client.post(BASE, headers=A, json={"name": "Shaped", "config": {}}).json()
    assert DECORATED <= set(created), f"create: missing {DECORATED - set(created)}"

    renamed = client.patch(f"{BASE}/{doc_id}", headers=A, json={"name": "Renamed"}).json()
    assert DECORATED <= set(renamed), f"rename: missing {DECORATED - set(renamed)}"

    shared = client.put(f"{BASE}/{doc_id}/share", headers=A,
                        json={"sharedWith": [B["X-Auth-Email"]]}).json()
    assert DECORATED <= set(shared), f"share: missing {DECORATED - set(shared)}"

    copied = client.post(f"{BASE}/copy", headers=B,
                         json={"owner": A["X-Auth-Email"], "id": doc_id}).json()
    assert DECORATED <= set(copied), f"copy: missing {DECORATED - set(copied)}"


def test_a_returned_record_says_the_design_is_yours(client):
    """The specific failure: `mine` absent reads as false, and the bar then shows
    your own design as belonging to an undefined owner."""
    doc_id = _create(client)
    for label, resp in [
        ("create", client.post(BASE, headers=A, json={"name": "Shaped", "config": {}})),
        ("rename", client.patch(f"{BASE}/{doc_id}", headers=A, json={"name": "Still mine"})),
    ]:
        body = resp.json()
        assert body["mine"] is True, f"{label} did not report the design as yours"
        assert body["ownerName"], f"{label} returned an empty ownerName"
