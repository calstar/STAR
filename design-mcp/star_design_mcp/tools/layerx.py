"""EngineDesign: Layer X burns and the optimizer's latest results.

A Layer X run is a full twin burn, saved per user (EngineDesign/backend/routers/
layerx.py). Its result is large -- every signal on every step -- so:

- ``layerx_get_run`` returns the run with its series replaced by a signal count;
- ``layerx_run_table`` turns the burn into a table (the app's own CSV export,
  ``name [unit]`` headers, engine/layerx/export.py) for table_series / table_plot;
- ``layerx_export`` hands back the app's files: csv, parquet, the FEA zip (chamber
  pressure, thrust, axial heat flux and the peak loads) and the .eng thrust curve.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from mcp.server.mcpserver.exceptions import ToolError

from .. import identity
from ..data import compact
from ..files import FileStore, safe_filename
from ..tables import from_unit_csv
from . import COMPUTE, READ, Ctx

RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

#: fmt -> (path under /runs/{id}, mime, suffix)
EXPORTS: dict[str, tuple[str, str, str]] = {
    "csv": ("/export/csv", "text/csv", "csv"),
    "parquet": ("/export/parquet", "application/vnd.apache.parquet", "parquet"),
    "fea": ("/export/fea", "application/zip", "zip"),
    "eng": ("/eng", "text/plain", "eng"),
}


def _run(run_id: str) -> str:
    if not RUN_ID.match(run_id):
        raise ToolError(f"Not a run id: {run_id!r} (from layerx_list_runs).")
    return run_id


def _strip_series(run: dict[str, Any]) -> dict[str, Any]:
    result = run.get("result")
    if isinstance(result, dict) and isinstance(result.get("series"), dict):
        series = result["series"]
        n = len(series.get("t") or [])
        result = {**result, "series": {"_omitted": f"{n} steps; use layerx_run_table for the signals"}}
        run = {**run, "result": result}
    return run


def register(server, ctx: Ctx) -> None:
    @server.tool(annotations=READ, structured_output=False)
    async def layerx_list_runs(limit: int = 30) -> dict[str, Any]:
        """Your Layer X runs (EngineDesign), newest first: id, kind, status, name/note, and the
        headline summary (impulse, apogee, any vessel trip)."""
        rows = await ctx.apps.get_json("engine-design", "/api/layerx/runs")
        rows = rows if isinstance(rows, list) else []
        limit = max(1, min(limit, 200))
        return {"total": len(rows), "runs": compact(rows[:limit], max_list=200)}

    @server.tool(annotations=READ, structured_output=False)
    async def layerx_get_run(run_id: str) -> Any:
        """One Layer X run: status, inputs, provenance, summary, flight, trips -- everything except the
        per-step series (layerx_run_table has those). Long arrays inside are summarized."""
        run = await ctx.apps.get_json("engine-design", f"/api/layerx/runs/{_run(run_id)}")
        return compact(_strip_series(run), max_list=40)

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def layerx_run_table(run_id: str) -> dict[str, Any]:
        """A finished burn as a table: every per-step signal with its unit and min/max. Then use
        table_series / table_plot / table_export with the returned table_id."""
        _run(run_id)
        table_id = ctx.tables.table_id("layerx", run_id)
        known = ctx.tables.known(table_id)
        if known:
            return known

        async def work() -> dict[str, Any]:
            r = await ctx.apps.request("engine-design", "GET", f"/api/layerx/runs/{run_id}/export/csv")
            table = from_unit_csv(r.text)
            return ctx.tables.save(
                table_id,
                table,
                source={"app": "engine-design", "kind": "layerx-run", "run_id": run_id, "label": f"Layer X {run_id}"},
                filename=f"layerx-{run_id}.parquet",
            )

        return await ctx.jobs.run(f"layerx table {run_id}", work)

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def layerx_export(
        run_id: str,
        fmt: Literal["csv", "parquet", "fea", "eng"],
        diameter_mm: float | None = None,
        length_mm: float | None = None,
        dry_kg: float | None = None,
    ) -> dict[str, Any]:
        """A finished burn as the app's own file, via a download link: csv | parquet (every signal),
        fea (zip: chamber pressure, thrust, axial heat flux vs time, and the peak loads), eng (RASP
        thrust curve for OpenRocket; diameter_mm/length_mm/dry_kg size the motor header when the run
        did not record them)."""
        _run(run_id)
        path, mime, suffix = EXPORTS[fmt]
        params = {"diameter_mm": diameter_mm, "length_mm": length_mm, "dry_kg": dry_kg} if fmt == "eng" else {}
        key = FileStore.memo_key(identity.current().email, "layerx", run_id, fmt, params)

        async def work() -> dict[str, Any]:
            hit = ctx.files.memo_get(key)
            if hit:
                return ctx.link(hit)
            f, tmp = ctx.files.new_temp()
            try:
                with f:
                    headers = await ctx.apps.stream_to(
                        "engine-design", f"/api/layerx/runs/{run_id}{path}", f, params=params
                    )
            except BaseException:
                tmp.unlink(missing_ok=True)
                raise
            name = _disposition_name(headers.get("content-disposition")) or f"layerx-{run_id}.{suffix}"
            stored = ctx.files.adopt(tmp, safe_filename(name), mime)
            ctx.files.memo_put(key, stored)
            return ctx.link(stored)

        return await ctx.jobs.run(f"layerx {fmt} {run_id}", work)

    @server.tool(annotations=READ, structured_output=False)
    async def engine_optimizer_results(layer: Literal[1, 2, 3]) -> dict[str, Any]:
        """The latest Layer 1/2/3 optimizer results in your EngineDesign session (whatever you last ran
        in the app). Layers 2 and 3 carry the optimized config, returned as a YAML download link."""
        body = await ctx.apps.get_json("engine-design", f"/api/optimizer/layer{layer}/results")
        results = body.get("results") if isinstance(body, dict) else body
        out: dict[str, Any] = {"layer": layer}
        if isinstance(results, dict) and isinstance(results.get("config_yaml"), str):
            stored = ctx.files.put_bytes(results["config_yaml"].encode(), f"layer{layer}-config.yaml", "text/yaml")
            out["config_yaml"] = ctx.link(stored)
            results = {k: v for k, v in results.items() if k != "config_yaml"}
        out["results"] = compact(results, max_list=40)
        return out


def _disposition_name(header: str | None) -> str | None:
    if not header:
        return None
    m = re.search(r'filename="?([^";]+)"?', header)
    return m.group(1) if m else None
