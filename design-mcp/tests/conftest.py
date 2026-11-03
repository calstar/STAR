"""A real server over fake apps: the ASGI app end to end, with httpx.MockTransport
standing in for every STAR app and a dict standing in for STARProject's token check."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

import httpx
import pytest

from star_design_mcp import settings as settings_mod
from star_design_mcp.apps import Apps
from star_design_mcp.identity import Identity
from star_design_mcp.server import build
from star_design_mcp.tokens import Refusal

ALICE = "sp_alice_token_0123456789abcdef"
BOB = "sp_bob_token_0123456789abcdefghij"
NO_SCOPE = "sp_starproject_only_0123456789ab"

HOST = "http://127.0.0.1:8010"


class FakeVerifier:
    def __init__(self) -> None:
        self.down = False
        self.known = {
            ALICE: Identity("alice@berkeley.edu", "Alice", "tokA"),
            BOB: Identity("bob@berkeley.edu", "Bob", "tokB"),
        }

    async def check(self, token):
        if self.down:
            return Refusal("unavailable")
        if not token:
            return Refusal("missing")
        if token == NO_SCOPE:
            return Refusal("scope")
        return self.known.get(token) or Refusal("unknown")


class FakeApps:
    """Routes keyed by (app host, method, path) -> handler(request) -> httpx.Response."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str, str], Callable[[httpx.Request], httpx.Response]] = {}
        self.seen: list[httpx.Request] = []

    def on(self, app: str, method: str, path: str, handler) -> None:
        self.routes[(app, method, path)] = handler

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        key = (request.url.host, request.method, request.url.path)
        if key not in self.routes:
            return httpx.Response(404, json={"detail": f"no fake for {key}"})
        return self.routes[key](request)


@pytest.fixture
def env(tmp_path) -> dict[str, str]:
    return {
        "DESIGN_MCP_PUBLIC_URL": HOST,
        "DESIGN_MCP_VERIFY_URL": "http://starproject.test/api/mcp/verify",
        "DESIGN_MCP_VERIFY_SECRET": "s" * 32,
        "DESIGN_MCP_FILE_KEY": "k" * 40,
        "DESIGN_MCP_CACHE_DIR": str(tmp_path / "cache"),
        "DESIGN_MCP_JOB_INLINE_WAIT_S": "5",
        "ENGINE_DESIGN_URL": "http://engine-design",
        "PID_DESIGNER_URL": "http://pid-designer",
        "OPENROCKET_URL": "http://openrocket",
        "FEED_TWIN_URL": "http://feed-twin",
        "DAQ_VIEWER_URL": "http://daq-viewer",
    }


class Harness:
    def __init__(self, app, fake_apps: FakeApps, verifier: FakeVerifier, client: httpx.AsyncClient) -> None:
        self.app, self.fake, self.verifier, self.client = app, fake_apps, verifier, client
        self._id = 0

    async def rpc(self, method: str, params: dict[str, Any] | None = None, token: str | None = ALICE, **headers):
        self._id += 1
        h = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json", **headers}
        if token:
            h["Authorization"] = f"Bearer {token}"
        return await self.client.post(
            "/mcp", json={"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}, headers=h
        )

    async def call(self, tool: str, args: dict[str, Any] | None = None, token: str = ALICE, **headers) -> dict:
        r = await self.rpc("tools/call", {"name": tool, "arguments": args or {}}, token=token, **headers)
        assert r.status_code == 200, r.text
        return r.json()["result"]

    async def call_json(self, tool: str, args: dict[str, Any] | None = None, token: str = ALICE) -> Any:
        result = await self.call(tool, args, token=token)
        assert not result["isError"], result["content"]
        texts = [c["text"] for c in result["content"] if c["type"] == "text"]
        return json.loads(texts[-1])


@pytest.fixture
async def harness(env):
    fake = FakeApps()
    verifier = FakeVerifier()
    s = settings_mod.load(env)
    apps = Apps(s.app_urls, transport=httpx.MockTransport(fake.handle))
    app = build(s, apps=apps, verifier=verifier)
    # The SDK's lifespan holds an anyio task group, which must be left from the
    # task that entered it; a fixture's teardown runs in another. So it gets a task.
    started, stop = asyncio.Event(), asyncio.Event()

    async def run_lifespan() -> None:
        async with app.router.lifespan_context(app):
            started.set()
            await stop.wait()

    task = asyncio.create_task(run_lifespan())
    await started.wait()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=HOST) as client:
            yield Harness(app, fake, verifier, client)
    finally:
        stop.set()
        await task
