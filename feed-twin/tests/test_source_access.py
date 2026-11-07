"""Pulling from the design tools as two people, against the real stores.

What these guard is the line in designtools' docstring: feed-twin forwards
the caller's identity "rather than being a hole in the fleet's access
model". The stores are :mod:`stardesign.documents` itself
(tests/design_stores.py), so who may open what is their decision, and
feed-twin is checked against it rather than against a stub's idea of it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from backend import designtools, main
from backend.library import Library
from backend.main import app
from backend.overrides import OverrideStore
from tests.design_stores import Tools, stores, who  # noqa: F401  (fixture)

ALICE = who("alice@team.org")
BOB = who("bob@team.org")
SHIPPED = Path(main.__file__).parent / "diagrams" / "ethalox_stand.json"

client = TestClient(app)


@pytest.fixture
def lib(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Library]:
    """A library of its own, and no design tool's answer remembered."""
    fresh = Library(tmp_path / "library")
    monkeypatch.setattr(main, "library", fresh)
    monkeypatch.setattr(main, "overrides", OverrideStore(fresh.root / "o.json"))
    monkeypatch.setattr(main, "_UNBUILDABLE", {})
    monkeypatch.setattr(main, "_ACCESS_SEEN", {}, raising=False)
    yield fresh


def _secret() -> dict[str, Any]:
    """A drawing of Alice's own: the shipped stand with a tank renamed."""
    drawing = json.loads(SHIPPED.read_text("utf-8"))
    drawing["nodes"][0]["position"] = {"x": 777, "y": 7}
    drawing["nodes"][0].setdefault("data", {})["label"] = "ALICE-SECRET-TANK"
    return drawing


def _alice_pulls(stores: Tools) -> str:
    """Alice makes a private diagram in pid-designer and pulls it."""
    made = stores.pid.post(
        "/api/pid/diagrams", json={"name": "Alice private rig"}, headers=ALICE
    )
    assert made.status_code == 200, made.text
    stores.pid.post(
        "/api/pid/diagrams/alice-private-rig/autosave", json=_secret(), headers=ALICE
    )
    refused = stores.pid.get(
        "/api/pid/diagrams/alice-private-rig/load",
        params={"owner": "alice@team.org"},
        headers=BOB,
    )
    assert refused.status_code == 403, "pid-designer does not show it to Bob"
    pulled = client.post(
        "/api/sources/pid-designer/import",
        json={"doc_id": "alice-private-rig", "owner": "alice@team.org"},
        headers=ALICE,
    )
    assert pulled.status_code == 200, pulled.text
    artifact: str = pulled.json()["artifact"]["id"]
    return artifact


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


# ------------------------------------------------------------------ R002


def _ids(who: dict[str, str]) -> set[str]:
    return {a["id"] for a in client.get("/api/library", headers=who).json()}


def test_a_pull_is_read_only_by_whom_its_design_tool_lets_open_it(
    lib: Library, stores: Tools
) -> None:
    """Alice pulled her private diagram; Bob, whom pid-designer answers 403,
    found it in his library and read it whole -- and Layer X listed it (R002)."""
    secret = _alice_pulls(stores)
    assert secret in _ids(ALICE)
    assert secret not in _ids(BOB)

    asks = [
        ("GET", "/api/diagram", {"diagram": secret}, None),
        ("GET", "/api/model", {"diagram": secret}, None),
        ("GET", "/api/drawing", {"diagram": secret}, None),
        ("GET", "/api/hookup", {"diagram": secret}, None),
        ("GET", "/api/statemachine", {"diagram": secret}, None),
        ("GET", "/api/drawing/console", {"diagram": secret}, None),
        ("GET", f"/api/library/{secret}/freshness", {}, None),
        ("POST", "/api/session", {"diagram": secret}, {"state": "Idle"}),
        ("POST", "/api/twin/bundle/export", {}, {"stand": {"diagram": secret}}),
        (
            "PUT",
            "/api/drawing/console",
            {},
            {"diagram": secret, "element": "KB1", "hidden": True},
        ),
        ("DELETE", f"/api/library/{secret}", {}, None),
    ]
    for method, path, params, body in asks:
        answer = client.request(method, path, params=params, json=body, headers=BOB)
        assert answer.status_code == 403, (path, answer.status_code, answer.text)
        assert "ALICE-SECRET-TANK" not in answer.text
        assert "does not share it with you" in answer.json()["detail"]

    mine = client.get("/api/diagram", params={"diagram": secret}, headers=ALICE)
    assert mine.status_code == 200 and "ALICE-SECRET-TANK" in mine.text

    # Shared with him in pid-designer, it is his to read here too.
    shared = stores.pid.put(
        "/api/pid/diagrams/alice-private-rig/share",
        params={"owner": "alice@team.org"},
        json={"sharedWith": ["bob@team.org"]},
        headers=ALICE,
    )
    assert shared.status_code == 200, shared.text
    main._ACCESS_SEEN.clear()
    assert secret in _ids(BOB)
    read = client.get("/api/diagram", params={"diagram": secret}, headers=BOB)
    assert read.status_code == 200 and "ALICE-SECRET-TANK" in read.text


def test_when_the_design_tool_cannot_be_asked_only_who_pulled_it_reads_it(
    lib: Library, stores: Tools
) -> None:
    """pid-designer down: nobody can be checked, so the pull stays with the
    people who pulled it -- the tool let them then -- and nobody else."""
    secret = _alice_pulls(stores)
    designtools.transport = httpx.MockTransport(
        lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused"))
    )
    main._ACCESS_SEEN.clear()
    assert secret in _ids(ALICE)
    assert secret not in _ids(BOB)
    answer = client.get("/api/diagram", params={"diagram": secret}, headers=BOB)
    assert answer.status_code == 403
    assert "could not be asked" in answer.json()["detail"]


def test_an_upload_of_the_same_drawing_is_everyones(
    lib: Library, stores: Tools
) -> None:
    """The other half: bytes Bob uploads are his to give. The same drawing is
    the same artifact (D-52), so his upload publishes it -- he had it anyway."""
    secret = _alice_pulls(stores)
    upload = client.post(
        "/api/library/diagrams",
        files={"file": ("mine.json", json.dumps(_secret()), "application/json")},
        headers=BOB,
    )
    assert upload.status_code == 200, upload.text
    assert upload.json()["artifact"]["id"] == secret
    assert secret in _ids(who("carol@team.org"))


def test_every_route_that_names_an_artifact_asks_first() -> None:
    """A route that serves, runs or changes an artifact named by ``diagram``,
    ``engine`` or ``artifact_id`` -- in its path, query or body -- depends on
    main.READABLE. A new one without it is a new hole."""
    names = {"diagram", "engine", "artifact_id"}
    exempt = {
        # Creates artifacts; a bundle's ids are another server's.
        "/api/twin/bundle/import",
    }
    missing = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or route.path in exempt:
            continue
        d = route.dependant
        named = {p.name for p in (*d.query_params, *d.path_params, *d.body_params)}
        if route.path == "/api/twin/bundle/export":
            named.add("diagram")  # in the body's stand
        gated = any(dep.call is main._readable for dep in d.dependencies)
        if named & names and not gated:
            missing.append(f"{sorted(route.methods)} {route.path}")
    assert missing == []
