"""FastAPI app: browse past Elodin runs, list sensors, plot, and export CSV.

Run (dev):   uvicorn backend.main:app --reload --port 8000
Prod-ish:    build the frontend to frontend/dist and this process serves it too.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config, export_cache, run_config, runs, series

app = FastAPI(title="Elodin Past-Run Viewer")

# Dev convenience: the Vite dev server (5173) may call us cross-origin. In the
# single-process prod setup the frontend is same-origin so this is a no-op.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _parse_components(components: str | None) -> list[str]:
    if not components:
        return []
    return [c for c in components.split(",") if c]


@app.get("/api/runs")
def api_runs():
    return runs.list_runs()


@app.get("/api/runs/{run_id}/components")
def api_components(run_id: str):
    if not config.RUN_RE.match(run_id):
        raise HTTPException(400, "invalid run id")
    try:
        return export_cache.get_index(run_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@app.get("/api/runs/{run_id}/config", response_class=PlainTextResponse)
def api_config(run_id: str):
    """The config snapshot taken beside this run's DB when the session started.

    Served verbatim: it is the record of what actually ran, so it is never reformatted
    or re-serialised. Runs recorded before the snapshot existed simply have no file.
    """
    if not config.RUN_RE.match(run_id):
        raise HTTPException(400, "invalid run id")
    path = run_config.snapshot_path(run_id)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        raise HTTPException(404, "no config snapshot for this run")
    return PlainTextResponse(
        text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'inline; filename="{run_id}.toml"'},
    )


@app.get("/api/runs/{run_id}/series")
def api_series(
    run_id: str,
    components: str = Query(...),
    start: float | None = None,
    end: float | None = None,
    max_points: int = 4000,
):
    if not config.RUN_RE.match(run_id):
        raise HTTPException(400, "invalid run id")
    comps = _parse_components(components)
    if not comps:
        raise HTTPException(400, "no components requested")
    export_cache.ensure_exported(run_id)
    try:
        return series.series_json(run_id, comps, start, end, max(4, min(max_points, 50000)))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.get("/api/runs/{run_id}/download")
def api_download(
    run_id: str,
    components: str | None = None,
    start: float | None = None,
    end: float | None = None,
):
    """CSV export.

    - With `components` (a plot selection): a **wide** CSV — one column per
      channel aligned on a shared time grid. Bounded by the selection, ideal for
      analysis of a few channels.
    - Without `components` (whole run): a **long/tidy** CSV (`time,component,
      value`) over every primary channel. Streams at constant memory; a wide
      whole-run frame would blow up to millions of rows × hundreds of columns.
    """
    if not config.RUN_RE.match(run_id):
        raise HTTPException(400, "invalid run id")
    index = export_cache.get_index(run_id)
    comps = _parse_components(components)
    if comps:
        rows = series.wide_csv_rows(run_id, comps, start, end)
        fname = f"{run_id}_selection.csv"
    else:
        comps = [c["name"] for c in index["components"] if c["primary"]]
        if not comps:
            raise HTTPException(404, "no exportable channels")
        rows = series.long_csv_rows(run_id, comps, start, end)
        fname = f"{run_id}.csv"
    # Rate-limit the stream so a large export can't saturate the host uplink.
    rows = series.throttle(rows, config.MAX_DOWNLOAD_BYTES_PER_SEC)
    return StreamingResponse(
        rows,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# Serve the built frontend if present (single-process deployment). Mounted last
# so it never shadows /api routes.
_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="static")
