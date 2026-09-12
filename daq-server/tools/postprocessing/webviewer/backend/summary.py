"""What can be said about a run without exporting it.

Opening a run used to trigger the parquet export — tens of seconds and a few hundred MB
of cache for a big one, spent whether or not you meant to plot anything. So the export is
now an explicit action, and this module answers "what am I about to open?" from the run
directory alone, in well under a second.

Everything here comes from filesystem metadata, deliberately. elodin-db's on-disk layout
(a directory per component, each with sparse `data`/`index` files and a `metadata` blob)
is undocumented and version-specific: an early attempt to read component names and row
counts straight out of it decoded a plausible-looking row count that was wrong for every
component — 2536 where the parquet had 314. Sizes, counts and mtimes cannot lie in that
way, so that is all this reads.

The one number that is an estimate is the duration, and it is marked as one.
"""

from __future__ import annotations

import subprocess

from . import config, export_cache, run_config


def _size_bytes(run_id: str) -> int | None:
    """On-disk size. `du` block counts, not apparent size — every component's data and
    index file is a sparse 8 GiB, so `st_size` would report the run as ~8 TB."""
    db = config.ELODIN_DIR / run_id
    try:
        out = subprocess.run(
            ["du", "-sk", str(db)], capture_output=True, text=True, timeout=60
        )
        if out.returncode == 0:
            return int(out.stdout.split()[0]) * 1024
    except (ValueError, OSError, subprocess.SubprocessError):
        pass
    return None


def _components_and_span(run_id: str) -> tuple[int, float | None]:
    """Component count, and the wall time between the first and last write.

    One stat per component. The span is when data was *written*, which trails the sample
    times the plot is drawn on by the write latency at each end — measured 0.3-0.7 s low
    on 20-35 s runs, i.e. within a percent. Good enough to answer "how long was this run"
    before committing to an export; the exact figure replaces it once indexed.
    """
    db = config.ELODIN_DIR / run_id
    oldest = newest = None
    n = 0
    try:
        entries = list(db.iterdir())
    except OSError:
        return 0, None
    for entry in entries:
        # Component directories are named by a numeric id; `db_state` and `msgs` are not.
        if not entry.name.isdigit():
            continue
        n += 1
        try:
            mt = (entry / "data").stat().st_mtime
        except OSError:
            continue
        oldest = mt if oldest is None else min(oldest, mt)
        newest = mt if newest is None else max(newest, mt)
    span = (newest - oldest) if (oldest is not None and newest is not None) else None
    return n, span


def summarize(run_id: str) -> dict:
    """Cheap facts about a run, whether or not it has ever been indexed."""
    n_components, span = _components_and_span(run_id)
    return {
        "run_id": run_id,
        "cached": export_cache.is_cached(run_id),
        "size_bytes": _size_bytes(run_id),
        # Every component the DB holds. Indexing reports a smaller number: the export
        # only resolves components it can name, and the rest stay bare numeric hashes.
        "n_components": n_components,
        "duration_s": span,
        # Never presented as exact; see _components_and_span.
        "duration_approx": True,
        # Whether <run_id>.toml exists, so the client can skip asking for a config that
        # runs predating the snapshot never had, rather than eating a 404 per selection.
        "has_config": run_config.snapshot_path(run_id).exists(),
    }
