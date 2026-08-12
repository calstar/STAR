"""Discover past Elodin runs (timestamped daq_YYYYMMDD_HHMMSS dirs only)."""

from __future__ import annotations

from datetime import datetime

from . import config, export_cache


def list_runs() -> list[dict]:
    """List timestamped runs, newest first. Intentionally cheap: no per-run `du`
    (that would stat thousands of DB subdirs across every run). Size/duration are
    filled in by the per-run index once a run is opened."""
    runs = []
    if not config.ELODIN_DIR.is_dir():
        return runs
    for entry in config.ELODIN_DIR.iterdir():
        if not entry.is_dir():
            continue
        m = config.RUN_RE.match(entry.name)
        if not m:
            continue
        try:
            started = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
        except ValueError:
            continue
        runs.append(
            {
                "id": entry.name,
                "name": entry.name,
                "started": started.isoformat(),
                "cached": export_cache.is_cached(entry.name),
            }
        )
    runs.sort(key=lambda r: r["started"], reverse=True)
    return runs
