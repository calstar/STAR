"""Who am I, what is reachable, and the jobs I started."""

from __future__ import annotations

import asyncio
from typing import Any

from .. import identity
from . import READ, Ctx

#: A cheap GET per app that answers without side effects.
HEALTH_PATHS = {
    "engine-design": "/api/engine/documents",
    "pid-designer": "/api/pid/users",
    "openrocket": "/api/health",
    "feed-twin": "/api/twin/runs",
    "daq-viewer": "/api/runs",
}


def register(server, ctx: Ctx) -> None:
    @server.tool(annotations=READ, structured_output=False)
    async def whoami() -> dict[str, Any]:
        """The STAR account this token acts as. Every app shows you exactly what it shows that person."""
        who = identity.current()
        return {"email": who.email, "name": who.name}

    @server.tool(annotations=READ, structured_output=False)
    async def list_apps() -> dict[str, Any]:
        """Which STAR apps this server can reach right now, and their tool prefixes."""
        prefixes = {
            "engine-design": "layerx_*, list_designs(app='engine-design')",
            "pid-designer": "list_designs(app='pid-designer')",
            "openrocket": "openrocket_*, list_designs(app='openrocket')",
            "feed-twin": "feedtwin_*",
            "daq-viewer": "daq_*",
        }

        async def probe(app: str) -> tuple[str, str]:
            try:
                await ctx.apps.request(app, "GET", HEALTH_PATHS[app], timeout=5.0)
                return app, "up"
            except Exception as exc:  # noqa: BLE001 -- reported, per app
                return app, f"down: {exc}"[:200]

        configured = ctx.apps.configured()
        results = dict(await asyncio.gather(*(probe(a) for a in configured if a in HEALTH_PATHS)))
        return {app: {"status": results.get(app, "not configured"), "tools": prefixes[app]} for app in prefixes}

    @server.tool(annotations=READ, structured_output=False)
    async def job_status(job_id: str, wait_s: float = 20.0) -> dict[str, Any]:
        """A job's state, waiting up to wait_s (max 25) for it to finish. A finished job carries its result."""
        return await ctx.jobs.wait(job_id, max(0.0, min(wait_s, 25.0)))

    @server.tool(annotations=READ, structured_output=False)
    async def list_jobs() -> list[dict[str, Any]]:
        """Your jobs from the last hour, newest first (without results; job_status has those)."""
        return ctx.jobs.mine()
