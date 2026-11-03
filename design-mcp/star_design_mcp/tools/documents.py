"""Saved designs in the three design tools, through their shared document store.

EngineDesign, pid-designer and star-openrocket all mount
``stardesign.documents.make_router`` (lib/stardesign), so one set of tools reads
all three. The store's own ``_resolve_doc`` decides what the caller may view; a
design shared with you, or the team's main design, needs ``owner`` (from
list_designs) to say whose folder it is in.
"""

from __future__ import annotations

import json
from typing import Any, Literal
from urllib.parse import urlencode

from mcp.server.mcpserver.exceptions import ToolError

from ..data import compact
from ..files import safe_filename
from . import COMPUTE, READ, Ctx

DesignApp = Literal["engine-design", "pid-designer", "openrocket"]

#: Where each app mounts the document router (its make_router prefix + sub).
ROUTES: dict[str, str] = {
    "engine-design": "/api/engine/documents",
    "pid-designer": "/api/pid/diagrams",
    "openrocket": "/api/documents",
}

#: A design up to this size comes back inline; a bigger one as a summary plus a link.
INLINE_BYTES = 48_000


def _route(app: str) -> str:
    try:
        return ROUTES[app]
    except KeyError:
        raise ToolError(f"app is one of {', '.join(ROUTES)}") from None


def _shape(data: Any) -> dict[str, Any]:
    """What a design holds, without its contents: top-level keys and sizes."""
    if isinstance(data, dict):
        return {
            k: (
                f"list of {len(v)}"
                if isinstance(v, list)
                else f"object with {len(v)} keys" if isinstance(v, dict) else type(v).__name__
            )
            for k, v in data.items()
        }
    return {"type": type(data).__name__}


def register(server, ctx: Ctx) -> None:
    @server.tool(annotations=READ, structured_output=False)
    async def list_designs(app: DesignApp) -> Any:
        """Designs you can open in one design tool: your own, those shared with you, and the team's
        main/STAR designs. Each row's `id` and `owner` are what get_design takes."""
        rows = await ctx.apps.get_json(app, _route(app))
        return compact(rows, max_list=200)

    @server.tool(annotations=READ, structured_output=False)
    async def get_design(
        app: DesignApp,
        design_id: str,
        owner: str | None = None,
        version: str | None = None,
        release: str | None = None,
    ) -> dict[str, Any]:
        """One saved design: the working copy, or a microversion (version, from design_history) or a
        release (release label, from design_releases). This is the design file itself -- the P&ID graph,
        the engine config, the rocket + recovery config. Small ones come back inline; large ones as a
        shape summary and a download link."""
        if version and release:
            raise ToolError("Pass version or release, not both.")
        base = f"{_route(app)}/{design_id}"
        path = f"{base}/version/{version}" if version else f"{base}/release/{release}" if release else f"{base}/load"
        data = await ctx.apps.get_json(app, path, owner=owner)
        text = json.dumps(data, separators=(",", ":"))
        which = {"version": version} if version else {"release": release} if release else {"working_copy": True}
        if len(text) <= INLINE_BYTES:
            return {"app": app, "design_id": design_id, **which, "design": data}
        name = safe_filename(f"{app}-{design_id}-{version or release or 'working'}.json")
        stored = ctx.files.put_bytes(text.encode(), name, "application/json")
        return {
            "app": app,
            "design_id": design_id,
            **which,
            "size_bytes": len(text),
            "shape": _shape(data),
            "preview": compact(data, max_list=8),
            "file": ctx.link(stored),
        }

    @server.tool(annotations=READ, structured_output=False)
    async def design_history(app: DesignApp, design_id: str, owner: str | None = None) -> Any:
        """A design's automatic microversions, newest first (ids for get_design's `version`)."""
        return compact(await ctx.apps.get_json(app, f"{_route(app)}/{design_id}/history", owner=owner), max_list=100)

    @server.tool(annotations=READ, structured_output=False)
    async def design_releases(app: DesignApp, design_id: str, owner: str | None = None) -> Any:
        """A design's named releases, newest first (labels for get_design's `release`)."""
        return compact(await ctx.apps.get_json(app, f"{_route(app)}/{design_id}/releases", owner=owner), max_list=100)

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def download_design(
        app: DesignApp,
        design_id: str,
        owner: str | None = None,
        version: str | None = None,
        release: str | None = None,
    ) -> dict[str, Any]:
        """The design file as a JSON download link, whatever its size (the same file the app's own
        export saves for a P&ID)."""
        if version and release:
            raise ToolError("Pass version or release, not both.")
        base = f"{_route(app)}/{design_id}"
        path = f"{base}/version/{version}" if version else f"{base}/release/{release}" if release else f"{base}/load"
        data = await ctx.apps.get_json(app, path, owner=owner)
        name = safe_filename(f"{app}-{design_id}-{version or release or 'working'}.json")
        stored = ctx.files.put_bytes(json.dumps(data, indent=1).encode(), name, "application/json")
        return ctx.link(stored)

    @server.tool(annotations=READ, structured_output=False)
    async def pid_image_link(design_id: str, owner: str | None = None) -> dict[str, Any]:
        """How to get a P&ID as a PNG or SVG. The image is drawn by pid-designer itself in a
        browser (the symbols are its React components, so nothing else draws them the same), so
        this returns a link that opens the diagram and the clicks to export it. Needs a browser
        signed in to STAR (e.g. Claude in Chrome on the person's own browser). For the drawing's
        contents without a browser, use get_design / download_design."""
        base = ctx.settings.pid_designer_public_url
        if not base:
            raise ToolError("pid-designer's public address is not configured on this server (PID_DESIGNER_PUBLIC_URL).")
        # Make sure the caller can see it before handing out a link that would open nothing.
        await ctx.apps.get_json("pid-designer", f"{ROUTES['pid-designer']}/{design_id}/load", owner=owner)
        query = {"diagram": design_id, **({"owner": owner} if owner else {})}
        return {
            "url": f"{base}/?{urlencode(query)}",
            "steps": [
                "Open the url in a browser signed in to STAR (the link opens that diagram).",
                "Pick the page (sheet) to export in the page bar, if the drawing has several.",
                "Click Export in the toolbar, then 'PNG image', 'PNG for print' (white paper) or 'SVG'.",
                "The file downloads named '<diagram> - <page>.png' / '.svg'.",
            ],
            "without_a_browser": "get_design / download_design give the drawing as JSON (every component, line and setting).",
        }
