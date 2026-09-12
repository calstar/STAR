"""Importing straight out of the other design tools.

The interesting behaviour here is not "does JSON round-trip" -- it is the
handful of decisions the client makes on the caller's behalf, each of which is
invisible once it is wrong:

* the caller's **identity** must reach the design tool, or feed-twin is a hole
  in the fleet's access model;
* a **release** and a **working copy** must come from different routes and be
  recorded differently, or a run's provenance stops meaning anything;
* an **EngineDesign document** wraps its config, and handing the wrapper to the
  importer would fail in a way that reads as a bad engine rather than a bad
  unwrap.

Driven through an ``httpx.MockTransport`` standing in for the sibling app, so
the requests themselves are what is asserted on.
"""

from __future__ import annotations

import json

import httpx
import pytest
import yaml

from backend import designtools
from backend.designtools import DesignToolError, fetch, list_documents, tools

DIAGRAM = {"nodes": [{"id": "T1", "type": "TANK"}], "edges": []}
ENGINE = {"config": {"injector": {"type": "impinging"}}, "ui": {"zoom": 2}}


@pytest.fixture
def seen() -> list[httpx.Request]:
    """Every request the client made, with the stub wired in and torn down."""
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        path = request.url.path
        if path.endswith("/browse"):
            return httpx.Response(
                200,
                json=[
                    {
                        "owner": "aidan@berkeley.edu",
                        "ownerName": "Aidan",
                        "designs": [{"id": "ox-stand", "name": "Ox stand"}],
                    }
                ],
            )
        if path.endswith("/releases"):
            return httpx.Response(
                200, json=[{"label": "0.3", "savedAt": "2026-09-01T00:00:00Z"}]
            )
        if "/release/" in path:
            return httpx.Response(200, json=DIAGRAM)
        if path.endswith("/load"):
            return httpx.Response(200, json=ENGINE if "engine" in path else DIAGRAM)
        return httpx.Response(
            200, json=[{"id": "mine", "name": "My stand", "owner": "me", "mine": True}]
        )

    designtools.transport = httpx.MockTransport(handler)
    yield captured
    designtools.transport = None


# ------------------------------------------------------------------ identity


@pytest.mark.anyio
async def test_the_callers_identity_is_forwarded(seen: list[httpx.Request]) -> None:
    """Without this feed-twin reads designs as nobody, and the fleet's sharing
    rules stop applying the moment a drawing is imported."""
    await list_documents(
        tools()["pid-designer"], {"X-Auth-Email": "carlosbautista@berkeley.edu"}
    )
    assert seen
    assert all(
        r.headers.get("X-Auth-Email") == "carlosbautista@berkeley.edu" for r in seen
    )


@pytest.mark.anyio
async def test_nothing_but_identity_is_forwarded(seen: list[httpx.Request]) -> None:
    """A cookie or bearer token belonging to feed-twin is not ours to replay."""
    await list_documents(
        tools()["pid-designer"],
        {
            "X-Auth-Email": "me@x.com",
            "Cookie": "session=secret",
            "Authorization": "Bearer t",
        },
    )
    assert "cookie" not in {k.lower() for k in seen[0].headers}
    assert "authorization" not in {k.lower() for k in seen[0].headers}


# ------------------------------------------------------------------- listing


@pytest.mark.anyio
async def test_listing_merges_mine_and_everyone_elses(
    seen: list[httpx.Request],
) -> None:
    found = await list_documents(tools()["pid-designer"], {})
    ids = {d["id"] for d in found}
    assert ids == {"mine", "ox-stand"}
    assert next(d for d in found if d["id"] == "mine")["mine"] is True
    other = next(d for d in found if d["id"] == "ox-stand")
    assert other["mine"] is False
    assert other["owner_name"] == "Aidan"


# ---------------------------------------------------------------- provenance


@pytest.mark.anyio
async def test_a_release_and_a_working_copy_are_told_apart(
    seen: list[httpx.Request],
) -> None:
    """Different routes, and provenance that says which -- so "release 0.3"
    never has to be inferred from a timestamp."""
    tool = tools()["pid-designer"]

    _, working = await fetch(tool, "ox-stand", owner="aidan", headers={})
    assert seen[-1].url.path.endswith("/load")
    assert working == "pid-designer:aidan/ox-stand@working copy"

    _, released = await fetch(
        tool, "ox-stand", owner="aidan", release="0.3", headers={}
    )
    assert seen[-1].url.path.endswith("/release/0.3")
    assert released == "pid-designer:aidan/ox-stand@release 0.3"


@pytest.mark.anyio
async def test_the_owner_is_passed_through(seen: list[httpx.Request]) -> None:
    """Omitting it does not 403 -- it silently reads the caller's own folder."""
    await fetch(tools()["pid-designer"], "ox-stand", owner="aidan", headers={})
    assert seen[-1].url.params.get("owner") == "aidan"


# ------------------------------------------------------------------ payloads


@pytest.mark.anyio
async def test_a_diagram_arrives_in_the_shape_feed_twin_reads(
    seen: list[httpx.Request],
) -> None:
    data, _ = await fetch(tools()["pid-designer"], "ox-stand", headers={})
    assert json.loads(data) == {"nodes": DIAGRAM["nodes"], "edges": []}


@pytest.mark.anyio
async def test_an_engine_document_is_unwrapped_to_its_config(
    seen: list[httpx.Request],
) -> None:
    """The store wraps it as {"config": ..., "ui": ...}; the importer wants the
    config, and the editor state is not a boundary condition."""
    data, _ = await fetch(tools()["engine-design"], "ethalox", headers={})
    parsed = yaml.safe_load(data)
    assert parsed == ENGINE["config"]
    assert "ui" not in parsed


@pytest.mark.anyio
async def test_a_document_with_no_config_is_refused_by_name() -> None:
    designtools.transport = httpx.MockTransport(
        lambda r: httpx.Response(200, json={"nodes": [], "edges": []})
    )
    try:
        with pytest.raises(DesignToolError, match="not an engine design"):
            await fetch(tools()["engine-design"], "wrong", headers={})
    finally:
        designtools.transport = None


# ------------------------------------------------------------------ failures


@pytest.mark.anyio
async def test_an_unreachable_tool_names_the_variable_that_fixes_it() -> None:
    designtools.transport = httpx.MockTransport(
        lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused"))
    )
    try:
        with pytest.raises(DesignToolError, match="PID_DESIGNER_URL"):
            await list_documents(tools()["pid-designer"], {})
    finally:
        designtools.transport = None


@pytest.mark.anyio
async def test_a_403_says_it_may_not_be_shared() -> None:
    designtools.transport = httpx.MockTransport(lambda r: httpx.Response(403))
    try:
        with pytest.raises(DesignToolError, match="shared with you"):
            await fetch(tools()["pid-designer"], "someone-elses", headers={})
    finally:
        designtools.transport = None


@pytest.mark.anyio
async def test_browse_failing_does_not_stop_your_own_designs() -> None:
    """Browsing everyone else's work is a convenience. A store that will not
    answer it must not block somebody importing their own drawing."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/browse"):
            return httpx.Response(500)
        return httpx.Response(200, json=[{"id": "mine", "name": "Mine"}])

    designtools.transport = httpx.MockTransport(handler)
    try:
        found = await list_documents(tools()["pid-designer"], {})
        assert [d["id"] for d in found] == ["mine"]
    finally:
        designtools.transport = None
