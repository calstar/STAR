"""Discover past Elodin runs (timestamped daq_[sim_]YYYYMMDD_HHMMSS dirs only)."""

from __future__ import annotations

from datetime import datetime

from . import config, descriptions, export_cache


def list_runs() -> list[dict]:
    """List timestamped runs, newest first. Intentionally cheap: no per-run `du`
    (that would stat thousands of DB subdirs across every run). Size/duration are
    filled in by the per-run index once a run is opened."""
    runs = []
    if not config.ELODIN_DIR.is_dir():
        return runs
    # One read for the whole listing, not one per run.
    texts = descriptions.all_texts()
    for entry in config.ELODIN_DIR.iterdir():
        if not entry.is_dir():
            continue
        m = config.RUN_RE.match(entry.name)
        if not m:
            continue
        try:
            started = datetime.strptime(m.group("date") + m.group("time"), "%Y%m%d%H%M%S")
        except ValueError:
            continue
        runs.append(
            {
                "id": entry.name,
                "name": entry.name,
                "started": started.isoformat(),
                "cached": export_cache.is_cached(entry.name),
                # Synthetic data from a sim session. Surfaced so the UI can badge
                # it — weeks later the directory prefix is the only thing that
                # distinguishes it from real test-stand data.
                "simulated": m.group("sim") is not None,
                # Shared, operator-written one-liner saying what this run was. "" when
                # nobody has labelled it yet. See backend/descriptions.py.
                "description": texts.get(entry.name, ""),
            }
        )
    runs.sort(key=lambda r: r["started"], reverse=True)
    return runs
