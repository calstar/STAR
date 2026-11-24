"""Lazy, cached parquet export of a past Elodin run + a component index.

Key mechanic (verified against real runs): the parquet exporter only resolves
human component names when given a `--pattern`; `--pattern '*'` names every
named component and keeps the ~few genuinely-unnamed ones as hashes.

A run is exported once and the copy reused -- but only while it still matches the DB.
The `_done` marker records the DB's fingerprint at export time (see `db_fingerprint`),
and a later visit that finds the DB has moved on re-exports it. Without that, a run
opened while it was still recording kept its first few minutes forever: on 2026-11-23
daq_20261123_181135 was indexed 415 s into a 1975 s run, and the viewer showed every
channel stopping at 7 minutes and no state-machine lane at all, with nothing to say the
copy was short.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

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
# 3: per-component time_source + the sensor-clock time bounds.
INDEX_VERSION = 3


# A DB whose newest write is this recent is still being recorded. Exporting it again
# would be stale within seconds and costs a full read of a DB the stand is writing to, so
# the copy already made is served (flagged partial) until the run has been quiet this long.
RECORDING_QUIET_S = 30.0

# How often one run's DB is re-fingerprinted. Every series request passes through
# ensure_exported; a fingerprint is ~5 ms on a 760-stream run, so this only stops a
# burst of chart requests from repeating it.
CHECK_INTERVAL_S = 5.0

_checked: dict[str, tuple[float, bool]] = {}

# Called after a run is re-exported, so in-memory copies of its old data are dropped.
# series.py registers its lru caches here (it imports this module, not the reverse).
_on_reexport: list[Callable[[], None]] = []


def on_reexport(fn: Callable[[], None]) -> None:
    _on_reexport.append(fn)


def db_fingerprint(run_id: str) -> dict | None:
    """What the run's DB holds right now: how many component dirs, and the newest write
    to any of their `data` files. Cheap -- one stat per component, no read.

    The run dir's own `db_state` is left out on purpose: elodin-db rewrites it whenever
    the DB is *opened*, so the export itself would make every run look changed."""
    db = config.ELODIN_DIR / run_id
    n = 0
    newest = 0
    try:
        with os.scandir(db) as it:
            for e in it:
                if not e.is_dir():
                    continue
                n += 1
                try:
                    newest = max(newest, os.stat(os.path.join(e.path, "data")).st_mtime_ns)
                except OSError:
                    pass
    except OSError:
        return None
    return {"n_components": n, "newest_write_ns": newest}


def _is_recording(fp: dict | None) -> bool:
    if not fp or not fp["newest_write_ns"]:
        return False
    return time.time() - fp["newest_write_ns"] / 1e9 < RECORDING_QUIET_S


def _marker_matches(cdir: Path, fp: dict | None) -> bool:
    """Whether the export in `cdir` is of the DB as it is now."""
    marker = cdir / _DONE
    try:
        text = marker.read_text()
    except OSError:
        return False
    if fp is None:
        return True  # DB unreadable: nothing to compare against, keep what we have
    if text.strip():
        try:
            return json.loads(text) == fp
        except ValueError:
            return False
    # An empty marker predates fingerprints. It is a complete copy exactly when the DB's
    # last write came before the marker was written; adopt the fingerprint so the next
    # visit compares directly. Otherwise the run kept recording after it was exported.
    if fp["newest_write_ns"] <= marker.stat().st_mtime_ns:
        marker.write_text(json.dumps(fp))
        return True
    return False


def export_status(run_id: str) -> dict:
    """Whether the cached copy is the whole run, for the index. Uncached (read time)."""
    fp = db_fingerprint(run_id)
    return {
        "partial": not _marker_matches(cache_dir(run_id), fp),
        "recording": _is_recording(fp),
    }


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


def _value_bounds(parquet_path: Path) -> tuple[float, float] | None:
    """[min, max] of the (single) value column from row-group stats — no data read.

    Used on a `*.timestamp_ns` parquet to get the sensor clock's extent, which is what
    the x-axis actually spans when that clock is in use."""
    try:
        md = pq.ParquetFile(parquet_path).metadata
        names = md.schema.names
        vi = next(i for i in range(len(names)) if names[i] != "time")
    except (StopIteration, Exception):
        return None
    lo = hi = None
    for rg in range(md.num_row_groups):
        st = md.row_group(rg).column(vi).statistics
        if st is None or not st.has_min_max:
            return None
        lo = st.min if lo is None else min(lo, st.min)
        hi = st.max if hi is None else max(hi, st.max)
    if lo is None or hi is None:
        return None
    return (float(lo), float(hi))


def _entity_clocks(cdir: Path) -> tuple[dict[str, str], float | None, float | None]:
    """Per-entity clock kind, and the run's extent on the clocks actually drawn.

    The extent has to be a union across every entity, each measured on its OWN clock,
    because they do not cover the same interval: the heartbeat and command channels start
    at boot, ~3.7 s before the first sensor packet on a real run. Taking only the
    sensor-clocked entities' extent clipped the start of every one of those traces.

    Classification mirrors series.sensor_clock and shares its tolerance so the two always
    agree, but works off row-group statistics — no data read. min-vs-min stands in for
    that function's median: the two differ by milliseconds, which decides nothing here
    and shifts a window bound by nothing that matters.
    """
    from .series import (
        SENSOR_CLOCK_TOLERANCE_S,
        SOURCE_MONOTONIC,
        SOURCE_SENSOR,
    )

    kinds: dict[str, str] = {}
    t_min = t_max = None
    for f in sorted(cdir.glob("*.timestamp_ns.parquet")):
        entity = f.name[: -len(".timestamp_ns.parquet")]
        vb = _value_bounds(f)
        tb = _time_bounds(f)
        if vb is None or tb is None:
            continue
        lo, hi = vb[0] / 1e9, vb[1] / 1e9
        if abs(lo - tb[0]) <= SENSOR_CLOCK_TOLERANCE_S:
            kinds[entity] = SOURCE_SENSOR
        else:
            # Re-anchored by (db − stamp), so its extent lands back on its DB extent to
            # within the write latency. Use that rather than re-deriving the shift.
            kinds[entity] = SOURCE_MONOTONIC
            lo, hi = tb
        t_min = lo if t_min is None else min(t_min, lo)
        t_max = hi if t_max is None else max(t_max, hi)
    return kinds, t_min, t_max


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


def build_index(run_id: str, cdir: Path | None = None) -> dict:
    """Scan cached parquet → component index with families and time bounds."""
    from .series import SOURCE_DB

    cdir = cache_dir(run_id) if cdir is None else cdir
    entity_clocks, s_min, s_max = _entity_clocks(cdir)
    comps = []
    t_min = t_max = None
    for f in sorted(cdir.glob("*.parquet")):
        comp = classify(f.stem)
        d = comp.as_dict()
        # Which clock this channel is actually drawn on, so a per-channel difference is
        # never silent: its own stamp, its own stamp re-anchored, or the DB's write time.
        d["time_source"] = entity_clocks.get(comp.entity, SOURCE_DB)
        bounds = _time_bounds(f)
        if bounds:
            d["t_min"], d["t_max"] = bounds
            t_min = bounds[0] if t_min is None else min(t_min, bounds[0])
            t_max = bounds[1] if t_max is None else max(t_max, bounds[1])
        comps.append(d)
    # The window spans whichever clock is in use, so both extents are indexed. A run
    # where nothing carries a wall clock falls back to the DB's.
    sensor_min = s_min if s_min is not None else t_min
    sensor_max = s_max if s_max is not None else t_max
    index = {
        "index_version": INDEX_VERSION,
        "run_id": run_id,
        "t_min": t_min,
        "t_max": t_max,
        "duration_s": (t_max - t_min) if (t_min is not None and t_max is not None) else None,
        "sensor_t_min": sensor_min,
        "sensor_t_max": sensor_max,
        "sensor_duration_s": (
            (sensor_max - sensor_min)
            if (sensor_min is not None and sensor_max is not None)
            else None
        ),
        # Their relative timing is exact; their absolute position carries the median
        # write latency as a few-ms bias, which is worth being able to say out loud.
        "n_reanchored": sum(1 for c in comps if c["time_source"] == "monotonic"),
        "n_db_only": sum(1 for c in comps if c["time_source"] == SOURCE_DB),
        "n_components": len(comps),
        "size_bytes": _db_size_bytes(run_id),
        "components": comps,
    }
    (cdir / _INDEX).write_text(json.dumps(index))
    return index


def _export_into(run_id: str, db: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    cmd = [
        config.find_elodin_db(),
        "export",
        str(db),
        "-o",
        str(out),
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


def ensure_exported(run_id: str, refresh: bool = False) -> Path:
    """Export the run to parquet unless a copy of the DB as it is now is cached.

    A copy the DB has outgrown is replaced -- once the run has stopped recording. While it
    is still being written the copy already made is served (get_index flags it partial).
    The new export is built beside the old one and swapped in, so a request reading the
    old files meanwhile never sees a half-written directory. Returns the cache dir."""
    db = config.ELODIN_DIR / run_id
    if not db.is_dir():
        raise FileNotFoundError(f"run not found: {db}")
    cdir = cache_dir(run_id)
    with _lock_for(run_id):
        have = (cdir / _DONE).exists()
        if have and not refresh:
            seen = _checked.get(run_id)
            if seen and seen[1] and time.monotonic() - seen[0] < CHECK_INTERVAL_S:
                return cdir
            fp = db_fingerprint(run_id)
            fresh = _marker_matches(cdir, fp)
            if fresh or _is_recording(fp):
                _checked[run_id] = (time.monotonic(), fresh)
                return cdir
        # Fingerprint BEFORE exporting: anything written during the export makes the copy
        # stale, and the next visit replaces it rather than trusting it.
        fp = db_fingerprint(run_id)
        tmp = cdir.parent / f".{run_id}.exporting"
        old = cdir.parent / f".{run_id}.replaced"
        for d in (tmp, old):
            shutil.rmtree(d, ignore_errors=True)
        try:
            _export_into(run_id, db, tmp)
            build_index(run_id, tmp)
            (tmp / _DONE).write_text(json.dumps(fp) if fp else "")
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        if cdir.exists():
            cdir.rename(old)
        tmp.rename(cdir)
        shutil.rmtree(old, ignore_errors=True)
        _checked.pop(run_id, None)
        if have:
            for fn in _on_reexport:
                fn()
        return cdir


def get_index(run_id: str) -> dict:
    """Return the component index, exporting/rebuilding lazily if needed.

    Config-derived names (run_config.annotate) are layered on at read time rather than
    cached with the index — the snapshot is a separate file from the parquet, so one
    added or corrected later takes effect without discarding the export.
    """
    ensure_exported(run_id)
    idx = cache_dir(run_id) / _INDEX
    data = None
    if idx.exists():
        data = json.loads(idx.read_text())
        if data.get("index_version") != INDEX_VERSION:
            data = None  # Stale index from an older classification — rebuild from the parquet.
    if data is None:
        data = build_index(run_id)
    # Read-time, like the annotation: whether this copy is the whole run is a fact about
    # the DB now, not about the export.
    data.update(export_status(run_id))
    return run_config.annotate(data, run_id)
