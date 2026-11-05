"""EngineDesign: Layer X burns and the optimizer's latest results.

A Layer X run is a full twin burn, saved per user (EngineDesign/backend/routers/
layerx.py). Its result is large -- every signal on every step -- so:

- ``layerx_get_run`` returns an outline: the run, every small result section
  inline, the big ones (diagnostics, provenance, replay -- ~500 KB together) by
  name and size, fetched one at a time with ``section``; the whole run is a link;
- ``layerx_run_table`` turns the burn into a table (the app's own CSV export,
  ``name [unit]`` headers, engine/layerx/export.py) for table_series / table_plot;
- ``layerx_export`` hands back the app's files: csv, parquet, the FEA zip (chamber
  pressure, thrust, axial heat flux and the peak loads) and the .eng thrust curve.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from mcp.server.mcpserver.exceptions import ToolError

from .. import identity
from ..data import compact, json_safe
from ..files import FileStore, safe_filename
from ..tables import from_unit_csv
from . import COMPUTE, READ, Ctx
from .documents import INLINE_BYTES

#: A result section up to this size is inline in the outline; a bigger one is named
#: with its size and fetched with layerx_get_run(section=...).
SECTION_INLINE_BYTES = 4_000

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
    async def layerx_get_run(run_id: str, section: str | None = None) -> Any:
        """One Layer X run. Without `section`: status, settings, and every small result section
        (summary, checks, delivered, events, motor, ...) inline; the big ones (diagnostics,
        provenance, replay, limits, network, ...) listed with their sizes; the whole run as a JSON
        link. With `section` (a dotted path into the result, e.g. 'diagnostics.stability'): that
        one part. The per-step series are layerx_run_table's."""
        run = await ctx.apps.get_json("engine-design", f"/api/layerx/runs/{_run(run_id)}")
        result = run.get("result") if isinstance(run, dict) else None
        if section:
            return _section(run_id, result, section, ctx)
        if not isinstance(result, dict):
            return compact(run, max_list=40)
        inline, more = {}, {}
        for k, v in _strip_series(run)["result"].items():
            n = len(json.dumps(v, default=str))
            if n <= SECTION_INLINE_BYTES:
                inline[k] = v
            else:
                more[k] = {"bytes": n, "parts": sorted(v) if isinstance(v, dict) else None}
        stored = ctx.files.put_bytes(
            json.dumps(run, default=str).encode(), safe_filename(f"layerx-{run_id}.json"), "application/json"
        )
        return {
            **{k: v for k, v in run.items() if k != "result"},
            "result": compact(inline, max_list=40),
            "sections": compact(more, max_list=80),
            "full_run": ctx.link(stored),
            "use": "layerx_get_run(run_id, section='<name>' or '<name>.<part>') for one section.",
        }

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
        in the app). Layers 2 and 3 carry the optimized config as a YAML link and the tank-pressure
        curves as a CSV link (the app's own results.csv)."""
        body = await ctx.apps.get_json("engine-design", f"/api/optimizer/layer{layer}/results")
        results = body.get("results") if isinstance(body, dict) else body
        out: dict[str, Any] = {"layer": layer}
        if isinstance(results, dict) and isinstance(results.get("config_yaml"), str):
            stored = ctx.files.put_bytes(results["config_yaml"].encode(), f"layer{layer}-config.yaml", "text/yaml")
            out["config_yaml"] = ctx.link(stored)
            results = {k: v for k, v in results.items() if k != "config_yaml"}
        if layer in (2, 3) and isinstance(results, dict) and results.get("time_array"):
            r = await ctx.apps.request("engine-design", "GET", f"/api/optimizer/layer{layer}/results.csv")
            name = _disposition_name(r.headers.get("content-disposition")) or f"layer{layer}_results.csv"
            out["pressure_curves_csv"] = ctx.link(ctx.files.put_bytes(r.content, safe_filename(name), "text/csv"))
        out["results"] = compact(results, max_list=40)
        return out


def _section(run_id: str, result: Any, section: str, ctx: Ctx) -> Any:
    node: Any = result
    for i, part in enumerate(section.split(".")):
        if not isinstance(node, dict) or part not in node:
            where = ".".join(section.split(".")[:i]) or "result"
            have = ", ".join(sorted(node)) if isinstance(node, dict) else "nothing below it"
            raise ToolError(f"Run {run_id} has no {section!r}: {where} has {have}.")
        node = node[part]
    text = json.dumps(node, default=str)
    if len(text) <= INLINE_BYTES:
        return {"run_id": run_id, "section": section, "value": json_safe(node)}
    stored = ctx.files.put_bytes(text.encode(), safe_filename(f"layerx-{run_id}-{section}.json"), "application/json")
    out: dict[str, Any] = {"run_id": run_id, "section": section, "bytes": len(text), "link": ctx.link(stored)}
    if isinstance(node, dict):
        out["parts"] = {k: len(json.dumps(v, default=str)) for k, v in node.items()}
        out["use"] = "Ask for a part: section='" + section + ".<part>'."
    return out


def _disposition_name(header: str | None) -> str | None:
    if not header:
        return None
    m = re.search(r'filename="?([^";]+)"?', header)
    return m.group(1) if m else None
