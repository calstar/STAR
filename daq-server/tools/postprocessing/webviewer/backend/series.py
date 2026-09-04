"""Load cached parquet series: time-slice, min/max decimate, and wide CSV export.

Times are normalized to epoch seconds (float64) — uPlot's native x unit.
"""

from __future__ import annotations

import time
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Iterator

import numpy as np
import pandas as pd

from . import export_cache, run_config
from .naming import classify


def throttle(chunks: Iterable[str], bytes_per_sec: int) -> Iterator[str]:
    """Pace an iterable of text chunks to at most `bytes_per_sec` cumulative
    throughput. Sleeps between chunks so total bytes / elapsed ≈ the target rate;
    with coarse chunks (~100 KB) the sleeps are few and cheap. This runs inside
    Starlette's threadpool (sync generator), so the sleep never blocks the event
    loop. <=0 disables throttling."""
    if bytes_per_sec <= 0:
        yield from chunks
        return
    start = time.monotonic()
    sent = 0
    for ch in chunks:
        sent += len(ch)  # CSV is ASCII → len == byte count
        expected = sent / bytes_per_sec
        elapsed = time.monotonic() - start
        if expected > elapsed:
            time.sleep(expected - elapsed)
        yield ch


def _parquet_path(run_id: str, component: str) -> Path:
    p = export_cache.cache_dir(run_id) / f"{component}.parquet"
    if not p.exists():
        raise FileNotFoundError(f"component not in run: {component}")
    return p


@lru_cache(maxsize=256)
def load_series(run_id: str, component: str) -> tuple[np.ndarray, np.ndarray]:
    """Return (t_seconds, values) sorted by time. Cached in-process (immutable runs)."""
    df = pd.read_parquet(_parquet_path(run_id, component))
    value_col = next(c for c in df.columns if c != "time")
    # Parquet `time` is an arrow timestamp (µs). Force ns then → epoch seconds so
    # the conversion is correct regardless of the stored resolution.
    ts = pd.to_datetime(df["time"]).to_numpy(dtype="datetime64[ns]")
    t = ts.astype("int64").astype(float) / 1e9
    v = pd.to_numeric(df[value_col], errors="coerce").to_numpy(dtype=float)
    order = np.argsort(t, kind="stable")
    return t[order], v[order]


def _slice(t: np.ndarray, v: np.ndarray, start, end) -> tuple[np.ndarray, np.ndarray]:
    lo = 0 if start is None else int(np.searchsorted(t, start, "left"))
    hi = len(t) if end is None else int(np.searchsorted(t, end, "right"))
    return t[lo:hi], v[lo:hi]


def decimate_minmax(
    t: np.ndarray, v: np.ndarray, max_points: int
) -> tuple[np.ndarray, np.ndarray]:
    """Bucket into ~max_points/2 windows, keep each window's min & max in time
    order. Preserves spikes (unlike stride sampling), which matters for pressure
    transients. Returns <= max_points points."""
    n = len(t)
    if n <= max_points or max_points < 4:
        return t, v
    n_buckets = max(1, max_points // 2)
    edges = np.linspace(0, n, n_buckets + 1).astype(int)
    out_t = np.empty(n_buckets * 2, dtype=float)
    out_v = np.empty(n_buckets * 2, dtype=float)
    k = 0
    for b in range(n_buckets):
        a, z = edges[b], edges[b + 1]
        if z <= a:
            continue
        seg = v[a:z]
        finite = np.isfinite(seg)
        if not finite.any():
            imin = imax = 0
        else:
            idx = np.where(finite)[0]
            imin = idx[np.argmin(seg[idx])]
            imax = idx[np.argmax(seg[idx])]
        i0, i1 = (imin, imax) if imin <= imax else (imax, imin)
        out_t[k], out_v[k] = t[a + i0], v[a + i0]
        k += 1
        if i1 != i0:
            out_t[k], out_v[k] = t[a + i1], v[a + i1]
            k += 1
    return out_t[:k], out_v[:k]


def decimate_discrete(
    t: np.ndarray, v: np.ndarray, max_points: int
) -> tuple[np.ndarray, np.ndarray]:
    """Run-length compress a step series: keep only value-change points plus the
    endpoints. Lossless for step rendering (repeated values are redundant when
    step-drawn), and collapses a state/actuator channel from 100k+ samples to
    the handful of transitions. If a channel is pathologically noisy and still
    exceeds max_points, stride down as a last resort."""
    n = len(t)
    if n <= 2:
        return t, v
    change = np.empty(n, dtype=bool)
    change[0] = True
    change[1:] = v[1:] != v[:-1]  # NaN vs NaN compares True → kept (fine, rare)
    change[-1] = True
    idx = np.flatnonzero(change)
    if len(idx) > max_points >= 2:
        sel = np.linspace(0, len(idx) - 1, max_points).astype(int)
        idx = np.unique(idx[sel])
    return t[idx], v[idx]


def series_json(
    run_id: str, components: list[str], start, end, max_points: int
) -> dict:
    """Per-component sliced + decimated arrays for plotting. Every series is
    capped to ~max_points: continuous via min/max (keeps spikes), discrete via
    run-length compression (keeps transitions). Without this cap, a long run's
    uncapped discrete channels return millions of points and crash the browser."""
    out = []
    for name in components:
        t, v = load_series(run_id, name)
        t, v = _slice(t, v, start, end)
        discrete = classify(name).discrete
        if discrete:
            t, v = decimate_discrete(t, v, max_points)
        else:
            t, v = decimate_minmax(t, v, max_points)
        out.append(
            {
                "name": name,
                "discrete": discrete,
                "n": int(len(t)),
                "t": t.tolist(),
                "v": [None if not np.isfinite(x) else x for x in v.tolist()],
            }
        )
    return {"run_id": run_id, "series": out}


def long_csv_rows(run_id: str, components: list[str], start, end):
    """Yield a tidy/long CSV: `time,component,value`, one component at a time.

    Streams at constant memory — the right shape for a whole-run dump over many
    channels, where a wide aligned frame would explode to millions of rows ×
    hundreds of mostly-NaN columns."""
    yield "time,component,value\n"
    for name in components:
        try:
            t, v = load_series(run_id, name)
        except FileNotFoundError:
            continue
        t, v = _slice(t, v, start, end)
        buf = []
        for i in range(len(t)):
            val = v[i]
            if val == val:  # skip NaN
                buf.append(f"{t[i]:.6f},{name},{val:.9g}\n")
            if len(buf) >= 10000:
                yield "".join(buf)
                buf = []
        if buf:
            yield "".join(buf)


def _csv_cell(text: str) -> str:
    """Quote a header cell only if it needs it. Role names are plain words today, but
    they are operator-typed config strings, so a comma must not shift the columns."""
    if any(c in text for c in ',"\n'):
        return '"' + text.replace('"', '""') + '"'
    return text


def wide_csv_rows(run_id: str, components: list[str], start, end):
    """Yield CSV text rows: a 'time' column (epoch seconds) plus one column per
    component, aligned on the union of timestamps. Discrete series are
    forward-filled; continuous series are left as sampled (NaN between samples).

    Two header rows: the component name, then the role it played in this run
    (from the run's config snapshot; blank where config names nothing). The
    component name stays the column KEY -- analysis scripts and analyze_run.py
    key on it -- and the role rides underneath as the legend, so a spreadsheet
    says "Ox Upstream" without the file losing its stable identifiers."""
    frames = []
    entities = []
    for name in components:
        t, v = load_series(run_id, name)
        t, v = _slice(t, v, start, end)
        s = pd.Series(v, index=pd.Index(t, name="time"), name=name)
        s = s[~s.index.duplicated(keep="last")]
        comp = classify(name)
        entities.append(comp.entity)
        frames.append((name, comp.discrete, s))

    if not frames:
        yield "time\n"
        return

    union = frames[0][2].index
    for _, _, s in frames[1:]:
        union = union.union(s.index)
    union = union.sort_values()

    cols = {}
    for name, discrete, s in frames:
        aligned = s.reindex(union)
        if discrete:
            aligned = aligned.ffill()
        cols[name] = aligned
    df = pd.DataFrame(cols, index=union)
    df.index.name = "time"

    labels = run_config.entity_labels(run_config.load(run_id))
    yield "time," + ",".join(_csv_cell(c) for c in components) + "\n"
    yield "," + ",".join(
        _csv_cell(run_config.label_for(e, labels)) for e in entities
    ) + "\n"
    buf = []
    for ts, row in zip(df.index.to_numpy(), df.to_numpy()):
        cells = ["" if (x != x) else f"{float(x):.9g}" for x in row]
        buf.append(f"{float(ts):.6f}," + ",".join(cells) + "\n")
        if len(buf) >= 10000:
            yield "".join(buf)
            buf = []
    if buf:
        yield "".join(buf)
