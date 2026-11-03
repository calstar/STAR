"""Test-stand runs from the DAQ Run Viewer (daq-server/tools/postprocessing/webviewer).

A run is an Elodin DB that can be many GB. The viewer already does the heavy
lifting -- it exports a run to parquet once (``/index``) and downsamples every
series request with min/max buckets -- so these tools ask it questions rather
than pull data: summary, component list, a windowed series, a plot. A CSV export
is a job that streams into the file store and comes back as a link.

The viewer has no login (it is a team-wide, read-only tool), so every run is
visible to everyone; the token still says who asked, for the download log.
"""

from __future__ import annotations

import re
from typing import Any, Literal

import numpy as np
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.mcpserver.utilities.types import Image

from .. import identity
from ..data import compact
from ..files import FileStore
from ..plots import render
from . import COMPUTE, READ, Ctx

TimeSource = Literal["sensor", "db", "monotonic"]
RUN_RE = re.compile(r"^[A-Za-z0-9._-]{1,200}$")


def _run(run_id: str) -> str:
    if not RUN_RE.match(run_id):
        raise ToolError(f"Not a run id: {run_id!r} (from daq_list_runs).")
    return run_id


class _Capped:
    """A file sink that stops an export bigger than the cache can hold."""

    def __init__(self, f, limit: int) -> None:
        self.f, self.limit, self.n = f, limit, 0

    def write(self, chunk: bytes) -> None:
        self.n += len(chunk)
        if self.n > self.limit:
            raise ToolError(
                f"The export passed {self.limit // 1_000_000} MB, more than the cache keeps. "
                "Narrow it: name components and/or a start/end window."
            )
        self.f.write(chunk)


def register(server, ctx: Ctx) -> None:
    @server.tool(annotations=READ, structured_output=False)
    async def daq_list_runs(limit: int = 30, offset: int = 0, match: str | None = None) -> dict[str, Any]:
        """Recorded test-stand runs, newest first: id, start time, whether it is already indexed
        (fast to query), simulated or real. `match` filters on the id/description."""
        rows = await ctx.apps.get_json("daq-viewer", "/api/runs")
        if not isinstance(rows, list):
            rows = []
        if match:
            needle = match.lower()
            rows = [r for r in rows if needle in str(r).lower()]
        limit = max(1, min(limit, 200))
        return {"total": len(rows), "offset": offset, "runs": compact(rows[offset : offset + limit], max_list=200)}

    @server.tool(annotations=READ, structured_output=False)
    async def daq_run_summary(run_id: str) -> Any:
        """What is known about a run without exporting it: size, component count, approximate duration,
        whether it is indexed and has a config snapshot. Sub-second."""
        return await ctx.apps.get_json("daq-viewer", f"/api/runs/{_run(run_id)}/summary")

    @server.tool(annotations=READ, structured_output=False)
    async def daq_run_config(run_id: str) -> dict[str, Any]:
        """The config snapshot taken when the run started (TOML), verbatim: what actually ran."""
        r = await ctx.apps.request("daq-viewer", "GET", f"/api/runs/{_run(run_id)}/config")
        text = r.text
        if len(text) <= 40_000:
            return {"run_id": run_id, "config_toml": text}
        stored = ctx.files.put_bytes(text.encode(), f"{run_id}.toml", "text/plain")
        return {"run_id": run_id, "size": len(text), "head": text[:4000], "file": ctx.link(stored)}

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def daq_index_run(run_id: str) -> dict[str, Any]:
        """Index a run (export it to parquet once, on the viewer) so its components can be listed and
        queried. Tens of seconds on a multi-GB run, so it may come back as a job; call job_status."""
        _run(run_id)

        async def work() -> dict[str, Any]:
            index = await ctx.apps.post_json("daq-viewer", f"/api/runs/{run_id}/index", None)
            return _index_view(index, None)

        return await ctx.jobs.run(f"daq index {run_id}", work)

    @server.tool(annotations=READ, structured_output=False)
    async def daq_components(run_id: str, match: str | None = None) -> dict[str, Any]:
        """An indexed run's components (channels): name, time source, whether primary. `match`
        filters by name. Call daq_index_run first if the run is not indexed."""
        r = await ctx.apps.request("daq-viewer", "GET", f"/api/runs/{_run(run_id)}/components")
        return _index_view(r.json(), match)

    @server.tool(annotations=READ, structured_output=False)
    async def daq_series(
        run_id: str,
        components: list[str],
        start: float | None = None,
        end: float | None = None,
        max_points: int = 400,
        time_source: TimeSource = "sensor",
    ) -> dict[str, Any]:
        """Chosen components between start and end (seconds), downsampled by the viewer to about
        max_points each (continuous: min/max buckets; discrete: transitions kept), with min/max."""
        body = await _series(ctx, run_id, components, start, end, max(16, min(max_points, 2000)), time_source)
        for s in body.get("series", []):
            v = np.asarray([np.nan if x is None else x for x in s.get("v", [])], dtype=float)
            finite = v[np.isfinite(v)]
            if finite.size:
                s["min"], s["max"] = float(finite.min()), float(finite.max())
        return body

    @server.tool(annotations=READ, structured_output=False)
    async def daq_plot(
        run_id: str,
        components: list[str],
        start: float | None = None,
        end: float | None = None,
        time_source: TimeSource = "sensor",
        title: str = "",
    ) -> list[Any]:
        """Draw chosen components of a run against time as a PNG."""
        body = await _series(ctx, run_id, components, start, end, 4000, time_source)
        lines = [
            (s["name"], "", np.asarray(s["t"], float), np.asarray([np.nan if x is None else x for x in s["v"]], float))
            for s in body.get("series", [])
        ]
        if not lines:
            raise ToolError("No data for those components in that window.")
        png = render(lines, title=title or f"DAQ {run_id}")
        return [Image(data=png, format="png"), {"run_id": run_id, "components": components, "window_s": [start, end]}]

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def daq_export_csv(
        run_id: str,
        components: list[str] | None = None,
        start: float | None = None,
        end: float | None = None,
        time_source: TimeSource = "sensor",
    ) -> dict[str, Any]:
        """A run as a CSV download link. With components: a wide CSV (one column each on a shared time
        grid). Without: every primary channel, long format (time,component,value) -- this can be GB;
        prefer naming components and a window. Runs as a job; the viewer paces the stream."""
        _run(run_id)
        who = identity.current().email
        key = FileStore.memo_key(who, "daq-csv", run_id, sorted(components or []), start, end, time_source)

        async def work() -> dict[str, Any]:
            hit = ctx.files.memo_get(key)
            if hit:
                return ctx.link(hit)
            f, tmp = ctx.files.new_temp()
            try:
                with f:
                    await ctx.apps.stream_to(
                        "daq-viewer",
                        f"/api/runs/{run_id}/download",
                        _Capped(f, ctx.settings.cache_max_bytes // 2),
                        params={
                            "components": ",".join(components) if components else None,
                            "start": start,
                            "end": end,
                            "time_source": time_source,
                        },
                    )
            except BaseException:
                tmp.unlink(missing_ok=True)
                raise
            name = f"{run_id}_selection.csv" if components else f"{run_id}.csv"
            stored = ctx.files.adopt(tmp, name, "text/csv")
            ctx.files.memo_put(key, stored)
            return ctx.link(stored)

        return await ctx.jobs.run(f"daq csv {run_id}", work)


async def _series(ctx: Ctx, run_id, components, start, end, max_points, time_source) -> dict[str, Any]:
    if not components:
        raise ToolError("Name at least one component (from daq_components).")
    return await ctx.apps.get_json(
        "daq-viewer",
        f"/api/runs/{_run(run_id)}/series",
        components=",".join(components),
        start=start,
        end=end,
        max_points=max_points,
        time_source=time_source,
    )


def _index_view(index: dict[str, Any], match: str | None) -> dict[str, Any]:
    comps = index.get("components") or []
    if match:
        needle = match.lower()
        comps = [c for c in comps if needle in str(c.get("name", "")).lower()]
    head = {k: v for k, v in index.items() if k != "components"}
    return {**head, "matched": len(comps), "components": compact(comps[:500], max_list=500)}
