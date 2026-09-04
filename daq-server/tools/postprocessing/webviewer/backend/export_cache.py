"""Lazy, cached parquet export of a past Elodin run + a component index.

Key mechanic (verified against real runs): the parquet exporter only resolves
human component names when given a `--pattern`; `--pattern '*'` names every
named component and keeps the ~few genuinely-unnamed ones as hashes. Past-run
dirs are immutable, so we export once and reuse the cache forever.
"""

from __future__ import annotations

import json
import subprocess
import threading
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from . import config, run_config
from .naming import classify


def _dt_to_epoch_s(dt) -> float:
    """Naive datetime/np.datetime64 → epoch seconds, treating the wall value as
    UTC (matches series.load_series so index bounds and series times align)."""
    return np.datetime64(dt).astype("datetime64[ns]").astype("int64") / 1e9

# One lock per run id so concurrent requests can't launch duplicate exports.
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()

_DONE = "_done"
_INDEX = "_index.json"

# Bump when the component index schema or classification (naming.py units /
# families / discrete) changes, so cached indexes for already-exported runs are
# rebuilt instead of serving stale metadata. The parquet export itself is
# unaffected (it stays valid), only the derived index is recomputed.
INDEX_VERSION = 2


def _lock_for(run_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(run_id, threading.Lock())


def cache_dir(run_id: str) -> Path:
    return config.CACHE_DIR / run_id


def is_cached(run_id: str) -> bool:
    return (cache_dir(run_id) / _DONE).exists()


def _time_bounds(parquet_path: Path) -> tuple[float, float] | None:
    """Cheap [t_min, t_max] in epoch seconds from row-group stats (no full read)."""
    try:
        md = pq.ParquetFile(parquet_path).metadata
        ti = next(
            i
            for i in range(md.schema.names.__len__())
            if md.schema.names[i] == "time"
        )
    except (StopIteration, Exception):
        return None
    lo = hi = None
    for rg in range(md.num_row_groups):
        st = md.row_group(rg).column(ti).statistics
        if st is None or not st.has_min_max:
            return None
        # pyarrow returns naive python datetimes for timestamp stats. Convert via
        # numpy datetime64 (treats the wall value as UTC) so these bounds match
        # series.load_series exactly — using .timestamp() would apply local tz.
        smn = _dt_to_epoch_s(st.min)
        smx = _dt_to_epoch_s(st.max)
        lo = smn if lo is None else min(lo, smn)
        hi = smx if hi is None else max(hi, smx)
    if lo is None or hi is None:
        return None
    return (lo, hi)


def _db_size_bytes(run_id: str) -> int | None:
    """Real on-disk size of the source DB dir (its data/index files are sparse,
    so `du -sk` block counts are used). One-time cost at export."""
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


def build_index(run_id: str) -> dict:
    """Scan cached parquet → component index with families and time bounds."""
    cdir = cache_dir(run_id)
    comps = []
    t_min = t_max = None
    for f in sorted(cdir.glob("*.parquet")):
        comp = classify(f.stem)
        d = comp.as_dict()
        bounds = _time_bounds(f)
        if bounds:
            d["t_min"], d["t_max"] = bounds
            t_min = bounds[0] if t_min is None else min(t_min, bounds[0])
            t_max = bounds[1] if t_max is None else max(t_max, bounds[1])
        comps.append(d)
    index = {
        "index_version": INDEX_VERSION,
        "run_id": run_id,
        "t_min": t_min,
        "t_max": t_max,
        "duration_s": (t_max - t_min) if (t_min is not None and t_max is not None) else None,
        "n_components": len(comps),
        "size_bytes": _db_size_bytes(run_id),
        "components": comps,
    }
    (cdir / _INDEX).write_text(json.dumps(index))
    return index


def ensure_exported(run_id: str, refresh: bool = False) -> Path:
    """Export the run to parquet if not already cached. Returns the cache dir."""
    db = config.ELODIN_DIR / run_id
    if not db.is_dir():
        raise FileNotFoundError(f"run not found: {db}")
    cdir = cache_dir(run_id)
    with _lock_for(run_id):
        if refresh and cdir.exists():
            for p in cdir.iterdir():
                p.unlink()
        if (cdir / _DONE).exists():
            return cdir
        cdir.mkdir(parents=True, exist_ok=True)
        cmd = [
            config.find_elodin_db(),
            "export",
            str(db),
            "-o",
            str(cdir),
            "--format",
            "parquet",
            "--flatten",
            "--pattern",
            "*",  # REQUIRED: makes the exporter resolve human component names.
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(
                f"elodin-db export failed ({proc.returncode}): {proc.stderr.strip()[:500]}"
            )
        build_index(run_id)
        (cdir / _DONE).write_text("")
        return cdir


def get_index(run_id: str) -> dict:
    """Return the component index, exporting/rebuilding lazily if needed.

    Config-derived names (run_config.annotate) are layered on at read time rather than
    cached with the index -- the snapshot is a separate file from the parquet, so one
    added or corrected later takes effect without discarding the export.
    """
    ensure_exported(run_id)
    idx = cache_dir(run_id) / _INDEX
    if idx.exists():
        data = json.loads(idx.read_text())
        if data.get("index_version") == INDEX_VERSION:
            return run_config.annotate(data, run_id)
        # Stale index from an older classification — rebuild from the parquet.
    return run_config.annotate(build_index(run_id), run_id)
