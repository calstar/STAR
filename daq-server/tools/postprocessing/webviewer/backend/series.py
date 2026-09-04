"""Load cached parquet series: time-slice, min/max decimate, and wide CSV export.

Times are normalized to epoch seconds (float64) — uPlot's native x unit.

Which clock is the x-axis
-------------------------
Every row carries two. The parquet `time` column is elodin-db's own write time, stamped
as the bridge's TCP flush lands — and the boards ship ~9 samples per UDP packet, so a
whole packet's worth of samples gets written microseconds apart and then nothing for
~100 ms. Plotted on that, a steady 90 Hz channel becomes bursts of 9 points separated by
gaps. The row's `timestamp_ns` field is the real sample time, reconstructed by
BoardClockSync, and it is evenly spaced. `elodin-db` never learns this because
DatabaseConfig.cpp declares that field as an ordinary data column rather than wrapping it
in db.hpp's `builder::timestamp(...)` op, so the DB indexes on arrival.

So the default x-axis is the sensor clock, taken positionally from the sibling
`<entity>.timestamp_ns` parquet — the flattened export writes one file per field from the
same rows, so row i is row i in both.

Reconciling the two, and the publishers that stamp neither
----------------------------------------------------------
Both clocks are the same wall clock: the sample time is anchored to daq_bridge's
`system_clock` receive, and the DB time is elodin-db writing those same rows. They differ
only by write latency — measured at ~1 ms for raw channels, and growing to ~29 ms over a
run for calibrated ones, where the calibration service adds a republish hop. So mixing
them on one axis is coherent; it is the DB clock that drifts, which is the case for the
sensor clock being the default rather than an argument against it.

The sequencer (ACT_CMD, SEQUENCER.state) and the heartbeat router (BOARD.HB_*) stamp
`steady_clock` instead — monotonic since boot, ~0 rather than ~1.79e9. Taken literally
that lands them in 1970. But it is still a good clock, and CLOCK_MONOTONIC is
system-wide, so it differs from CLOCK_REALTIME by a constant over a run: recover that
constant as the median of (db time − stamp) and the channel gets its true emission time.
That is worth doing rather than falling back, because it is exactly the comparison people
care about — when a valve was commanded versus when chamber pressure moved — and the DB
write time it would otherwise use carries 12 ms of jitter (p99 55 ms) on ACT_CMD.

So each entity's clock is classified once:

    offset = median(db_time − stamp)
    |offset| small  → already epoch          → use the stamp as-is        ("sensor")
    |offset| large  → monotonic, or a board  → use stamp + offset         ("monotonic")
                      whose clock is unset
    no stamp column at all                   → use the DB write time      ("db")

A re-anchored channel's *relative* timing is exact; its *absolute* position inherits the
median write latency as a few-ms bias. Worth knowing, not worth refusing to draw.
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


# Below this, a row's own timestamp is taken to be a wall clock already; above it, the
# clock is sound but its origin is not the epoch, so it gets re-anchored. Generous on
# purpose: real write latency is milliseconds, and what this separates is off by decades.
SENSOR_CLOCK_TOLERANCE_S = 60.0

# x-axis choices, as the API takes them. "sensor" means "each row's own time", including
# the re-anchored ones; "db" is elodin-db's write order, kept because it is what every run
# so far was read on and it is the only way to see the raw arrival pattern.
TIME_SOURCES = ("sensor", "db")

# What a single channel ended up plotted on. Reported per component in the index.
SOURCE_SENSOR = "sensor"      # its own stamp, already epoch
SOURCE_MONOTONIC = "monotonic"  # its own stamp, re-anchored to the DB epoch
SOURCE_DB = "db"              # no stamp column — elodin-db's write time


def _epoch_seconds(col) -> np.ndarray:
    """Parquet arrow timestamps → epoch seconds. Forced through ns so the result is
    right whatever resolution the column was stored at."""
    ts = pd.to_datetime(col).to_numpy(dtype="datetime64[ns]")
    return ts.astype("int64").astype(float) / 1e9


@lru_cache(maxsize=256)
def sensor_clock(run_id: str, entity: str) -> tuple[np.ndarray, str] | None:
    """The entity's own per-row time in epoch seconds and which kind of clock it was, or
    None when it has no timestamp column at all. Cached — immutable runs."""
    p = export_cache.cache_dir(run_id) / f"{entity}.timestamp_ns.parquet"
    if not p.exists():
        return None
    df = pd.read_parquet(p)
    col = next((c for c in df.columns if c != "time"), None)
    if col is None or df.empty:
        return None
    v = pd.to_numeric(df[col], errors="coerce").to_numpy(dtype=float) / 1e9
    if not np.isfinite(v).all():
        return None
    delay = _epoch_seconds(df["time"]) - v
    # The MINIMUM, not the mean or median — the same argument BoardClockSync.hpp makes for
    # its own offset estimate. Write delay is one-sided noise: the DB cannot write a row
    # before it was stamped, so the observed delays scatter strictly ABOVE the true offset
    # and the floor is the best estimate. A median sits ~0.3 ms above it, which puts half
    # the rows *after* their own write — a nonsense ordering to then reason about.
    offset = float(np.min(delay))
    if abs(offset) <= SENSOR_CLOCK_TOLERANCE_S:
        return v, SOURCE_SENSOR
    # Monotonic (or a board whose clock was never set). Adding the floor of the write
    # delay puts it on the epoch. This assumes CLOCK_MONOTONIC and CLOCK_REALTIME stay a
    # fixed distance apart for the run — they share the oscillator, so they only diverge
    # if NTP steps or slews REALTIME. (BoardClockSync needs a *sliding* window because it
    # compares two different oscillators, a board crystal against the server, which drift
    # continuously. Same estimator, weaker assumption here.) Measured drift of this floor
    # across a run: 0.13 ms.
    return v + offset, SOURCE_MONOTONIC


def _parquet_path(run_id: str, component: str) -> Path:
    p = export_cache.cache_dir(run_id) / f"{component}.parquet"
    if not p.exists():
        raise FileNotFoundError(f"component not in run: {component}")
    return p


@lru_cache(maxsize=512)
def load_series(
    run_id: str, component: str, time_source: str = "sensor"
) -> tuple[np.ndarray, np.ndarray]:
    """Return (t_seconds, values) sorted by time. Cached in-process (immutable runs).

    With time_source="sensor" the x-axis is the row's own sample time where the publisher
    stamps a real clock, falling back to the DB's write time where it does not."""
    df = pd.read_parquet(_parquet_path(run_id, component))
    value_col = next(c for c in df.columns if c != "time")
    t = _epoch_seconds(df["time"])
    v = pd.to_numeric(df[value_col], errors="coerce").to_numpy(dtype=float)
    if time_source == "sensor":
        own = sensor_clock(run_id, classify(component).entity)
        # Positional swap, so it must be the same rows. A length mismatch would mean the
        # export wrote the fields of one entity from different row sets — take the DB
        # clock rather than silently pairing the wrong times to the wrong samples.
        if own is not None and len(own[0]) == len(t):
            t = own[0]
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
    run_id: str, components: list[str], start, end, max_points: int,
    time_source: str = "sensor",
) -> dict:
    """Per-component sliced + decimated arrays for plotting. Every series is
    capped to ~max_points: continuous via min/max (keeps spikes), discrete via
    run-length compression (keeps transitions). Without this cap, a long run's
    uncapped discrete channels return millions of points and crash the browser."""
    out = []
    for name in components:
        t, v = load_series(run_id, name, time_source)
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


def long_csv_rows(run_id: str, components: list[str], start, end, time_source: str = "sensor"):
    """Yield a tidy/long CSV: `time,component,value`, one component at a time.

    Streams at constant memory — the right shape for a whole-run dump over many
    channels, where a wide aligned frame would explode to millions of rows ×
    hundreds of mostly-NaN columns."""
    yield "time,component,value\n"
    for name in components:
        try:
            t, v = load_series(run_id, name, time_source)
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


def wide_csv_rows(run_id: str, components: list[str], start, end, time_source: str = "sensor"):
    """Yield CSV text rows: a 'time' column (epoch seconds) plus one column per
    component, aligned on the union of timestamps. Discrete series are
    forward-filled; continuous series are left as sampled (NaN between samples).

    Two header rows: the component name, then the role it played in this run
    (from the run's config snapshot; blank where config names nothing). The
    component name stays the column KEY — analysis scripts and analyze_run.py
    key on it — and the role rides underneath as the legend, so a spreadsheet
    says "Ox Upstream" without the file losing its stable identifiers."""
    frames = []
    entities = []
    for name in components:
        t, v = load_series(run_id, name, time_source)
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
