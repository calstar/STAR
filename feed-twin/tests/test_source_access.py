"""Pulling from the design tools as two people, against the real stores.

What these guard is the line in designtools' docstring: feed-twin forwards
the caller's identity "rather than being a hole in the fleet's access
model". The stores are :mod:`stardesign.documents` itself
(tests/design_stores.py), so who may open what is their decision, and
feed-twin is checked against it rather than against a stub's idea of it.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.main import app
from tests.design_stores import Tools, stores, who  # noqa: F401  (fixture)

ALICE = who("alice@team.org")
BOB = who("bob@team.org")

client = TestClient(app)


# ------------------------------------------------------------------ R001


def test_another_persons_unshared_design_does_not_fail_the_list(
    stores: Tools,
) -> None:
    """EngineDesign's /browse lists everyone's designs, copy-only; its /load
    (a pull) and /releases refuse them. The picker asked for releases of
    every listed design and the first 403 made the whole panel a 502, so
    Bob could not reach even his own engine (R001)."""
    assert (
        stores.engine.post(
            "/api/engine/documents", json={"name": "Alice engine"}, headers=ALICE
        ).status_code
        == 200
    )
    stores.engine.post(
        "/api/engine/documents", json={"name": "Bob engine"}, headers=BOB
    )

    listed = client.get(
        "/api/sources/engine-design/documents?with_releases=true", headers=BOB
    )
    assert listed.status_code == 200, listed.text
    ids = [d["id"] for d in listed.json()]
    assert "bob-engine" in ids
    # Not offered: a pull of it can only be refused.
    assert "alice-engine" not in ids


def test_a_shared_design_is_offered_and_pulls(stores: Tools) -> None:
    """The other half: what the store lets Bob open stays on offer."""
    stores.engine.post(
        "/api/engine/documents", json={"name": "Shared engine"}, headers=ALICE
    )
    shared = stores.engine.put(
        "/api/engine/documents/shared-engine/share",
        json={"sharedWith": ["bob@team.org"]},
        headers=ALICE,
    )
    assert shared.status_code == 200, shared.text

    listed = client.get(
        "/api/sources/engine-design/documents?with_releases=true", headers=BOB
    ).json()
    assert [(d["id"], d["owner"]) for d in listed] == [
        ("shared-engine", "alice@team.org")
    ]


def test_one_documents_releases_failing_leaves_the_rest(stores: Tools) -> None:
    """A release lookup that fails for one design (gone between the list and
    the lookup, or refused) leaves that design without releases, not the
    panel without designs."""
    import httpx

    from backend import designtools

    stores.engine.post(
        "/api/engine/documents", json={"name": "Kept engine"}, headers=BOB
    )
    inner = stores.transport

    class Refusing(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/releases"):
                return httpx.Response(403, json={"detail": "not shared"})
            return await inner.handle_async_request(request)

    designtools.transport = Refusing()
    listed = client.get(
        "/api/sources/engine-design/documents?with_releases=true", headers=BOB
    )
    assert listed.status_code == 200, listed.text
    assert [(d["id"], d["releases"]) for d in listed.json()] == [("kept-engine", [])]


# ------------------------------------------------------------------ R013


def test_the_picker_lists_newest_first_as_the_store_does(stores: Tools) -> None:
    """The store lists newest first (its main design and STAR set on top);
    the picker sorted oldest first, so last week's copy headed it (R013)."""
    import time

    stores.pid.post("/api/pid/diagrams", json={"name": "Older"}, headers=ALICE)
    time.sleep(0.01)
    stores.pid.post("/api/pid/diagrams", json={"name": "Newer"}, headers=ALICE)

    store_order = [
        d["id"] for d in stores.pid.get("/api/pid/diagrams", headers=ALICE).json()
    ]
    assert store_order == ["newer", "older"]
    listed = client.get("/api/sources/pid-designer/documents", headers=ALICE).json()
    assert [d["id"] for d in listed] == store_order
