"""Unit tests for the data-shaping logic (no elodin-db / real run needed).

Run: cd webviewer && .venv/bin/python -m pytest backend/test_series.py -q
"""

import numpy as np
import pandas as pd
import pytest

from . import config, export_cache, series
from .naming import classify


def test_decimate_preserves_spikes_and_bounds():
    t = np.arange(10000, dtype=float)
    v = np.zeros(10000)
    v[1234] = 999.0  # spike up
    v[8765] = -999.0  # spike down
    dt, dv = series.decimate_minmax(t, v, 200)
    assert len(dt) <= 200
    # Extremes survive decimation (stride sampling would drop them).
    assert dv.max() == 999.0
    assert dv.min() == -999.0
    # Time order preserved.
    assert np.all(np.diff(dt) >= 0)


def test_decimate_discrete_keeps_only_transitions():
    # 100k samples of a state that changes 3 times → compress to the transitions.
    t = np.arange(100000, dtype=float)
    v = np.zeros(100000)
    v[25000:] = 1
    v[50000:] = 2
    v[75000:] = 1
    dt, dv = series.decimate_discrete(t, v, 4000)
    # Endpoints + 3 change points → 5 kept, exact step reconstruction.
    assert dt.tolist() == [0.0, 25000.0, 50000.0, 75000.0, 99999.0]
    assert dv.tolist() == [0.0, 1.0, 2.0, 1.0, 1.0]


def test_decimate_discrete_caps_pathological():
    # Value changes every sample (worst case) → must still cap to max_points.
    t = np.arange(20000, dtype=float)
    v = (t % 2).astype(float)
    dt, _ = series.decimate_discrete(t, v, 1000)
    assert len(dt) <= 1000


def test_decimate_noop_when_small():
    t = np.arange(50, dtype=float)
    v = t * 2
    dt, dv = series.decimate_minmax(t, v, 4000)
    assert np.array_equal(dt, t) and np.array_equal(dv, v)


def test_slice_inclusive_bounds():
    t = np.arange(0, 100, dtype=float)
    v = t.copy()
    st, sv = series._slice(t, v, 10.0, 20.0)
    assert st[0] == 10.0 and st[-1] == 20.0  # both ends included


def test_classify_families_and_kinds():
    c = classify("PT_Cal.Ox_Upstream.pressure_psi")
    assert c.family == "PT_Cal" and c.field == "pressure_psi"
    assert c.unit == "psi" and not c.discrete and c.primary

    d = classify("ACT.Fuel_Fill_Press.actuator_state")
    assert d.discrete and d.family == "ACT"

    h = classify("1399096562196883797")
    assert h.family == "Other" and not h.primary


def test_wide_csv_union_and_ffill(monkeypatch):
    # Two channels on different timebases: continuous (NaN gaps) + discrete (ffill).
    def fake_load(_run, name, _src="sensor"):
        if name == "cont":
            return np.array([0.0, 2.0]), np.array([10.0, 20.0])
        return np.array([1.0]), np.array([1.0])  # discrete, single sample at t=1

    monkeypatch.setattr(series, "load_series", fake_load)
    monkeypatch.setattr(
        series, "classify",
        lambda n: type("C", (), {"discrete": n == "disc", "entity": n})(),
    )
    text = "".join(series.wide_csv_rows("r", ["cont", "disc"], None, None))
    lines = text.strip().split("\n")
    assert lines[0] == "time,cont,disc"
    assert lines[1] == ",,"  # role row: this fake run has no config snapshot
    body = [ln.split(",") for ln in lines[2:]]
    times = [float(r[0]) for r in body]
    assert times == [0.0, 1.0, 2.0]  # union of {0,2} and {1}
    # discrete forward-fills from t=1 onward; empty before it.
    disc_col = [r[2] for r in body]
    assert disc_col[0] == "" and disc_col[1] == "1" and disc_col[2] == "1"


def test_wide_csv_role_row_aligns_with_the_columns(monkeypatch, tmp_path):
    """The second header row names what each column IS. The component name stays the
    column key (analyze_run.py and every analysis script key on it); the role rides
    underneath, blank where the run's config names nothing."""
    monkeypatch.setattr(config, "ELODIN_DIR", tmp_path)
    (tmp_path / "daq_20260902_120000.toml").write_text(
        '[boards.pt_board]\ntype = "PT"\nboard_id = 21\n'
        '\n[sensor_roles_pt_board]\n"Ox Upstream" = 5\n'
    )
    monkeypatch.setattr(
        series, "load_series", lambda _r, _n, _s="sensor": (np.array([0.0]), np.array([1.0]))
    )
    text = "".join(
        series.wide_csv_rows(
            "daq_20260902_120000",
            ["PT1.CH5.pressure_psi", "PT1.CH9.pressure_psi"],
            None,
            None,
        )
    )
    header, roles = text.split("\n")[:2]
    assert header == "time,PT1.CH5.pressure_psi,PT1.CH9.pressure_psi"
    assert roles == ",Ox Upstream,"  # CH9 has no role; the column still holds its place
    assert header.count(",") == roles.count(",")


# ── x-axis clock selection ───────────────────────────────────────────────────


@pytest.fixture
def clock_run(tmp_path, monkeypatch):
    """A one-entity run on disk, with both clocks. Caches cleared so each test's fixture
    data is actually read (load_series/sensor_clock memoise on run id)."""
    monkeypatch.setattr(export_cache, "cache_dir", lambda run_id: tmp_path)
    series.load_series.cache_clear()
    series.sensor_clock.cache_clear()
    return tmp_path


def _write(dir_, name, db_times, values):
    """One flattened-export parquet: the DB's write time plus one value column."""
    pd.DataFrame(
        {
            "time": pd.to_datetime(np.asarray(db_times) * 1e9, unit="ns"),
            name.rsplit(".", 1)[-1]: values,
        }
    ).to_parquet(dir_ / f"{name}.parquet")


# The DB stamps a whole UDP packet of samples microseconds apart, then nothing for
# ~100 ms; the rows' own timestamp_ns says they were 10 ms apart, which they were.
BURSTY_DB = [1000.0, 1000.00004, 1000.00008, 1000.1, 1000.10004, 1000.10008]
EVEN_SENSOR = [1000.0, 1000.01, 1000.02, 1000.1, 1000.11, 1000.12]


def test_sensor_clock_replaces_the_bursty_db_write_time(clock_run):
    _write(clock_run, "PT1.CH1.raw_adc_counts", BURSTY_DB, [1, 2, 3, 4, 5, 6])
    _write(clock_run, "PT1.CH1.timestamp_ns", BURSTY_DB, [t * 1e9 for t in EVEN_SENSOR])

    t, v = series.load_series("r", "PT1.CH1.raw_adc_counts", "sensor")
    assert t.tolist() == pytest.approx(EVEN_SENSOR)
    assert v.tolist() == [1, 2, 3, 4, 5, 6]  # values stay paired with their own rows

    t_db, _ = series.load_series("r", "PT1.CH1.raw_adc_counts", "db")
    assert t_db.tolist() == pytest.approx(BURSTY_DB)


def test_boot_relative_clock_is_reanchored_not_discarded(clock_run):
    """The sequencer and heartbeat router stamp steady_clock — nanoseconds since boot,
    not since 1970. Taken literally that lands them 56 years off; but the clock itself is
    good, so it is shifted onto the epoch by the median write latency. That keeps their
    precise relative timing instead of falling back to the jittery DB write time."""
    boot = (12.0, 12.01, 12.02, 12.1, 12.11, 12.12)
    _write(clock_run, "ACT_CMD.B2.CH1.actuator_state", BURSTY_DB, [0, 1, 0, 1, 0, 1])
    _write(clock_run, "ACT_CMD.B2.CH1.timestamp_ns", BURSTY_DB, [t * 1e9 for t in boot])

    arr, kind = series.sensor_clock("r", "ACT_CMD.B2.CH1")
    assert kind == series.SOURCE_MONOTONIC

    t, _ = series.load_series("r", "ACT_CMD.B2.CH1.actuator_state", "sensor")
    # Lands in the run's wall clock, not 1970 …
    assert t[0] == pytest.approx(BURSTY_DB[0], abs=0.2)
    # … keeping the even 10 ms spacing its own clock recorded, rather than inheriting the
    # DB's 40 µs-then-100 ms burst pattern.
    assert np.diff(t).tolist() == pytest.approx(np.diff(boot).tolist())


def test_reanchored_rows_never_land_after_their_own_db_write(clock_run):
    """Write delay is one-sided — the DB cannot write a row before it was stamped — so the
    offset estimate is the floor of the observed delays, and every re-anchored row must
    end up at or before its own write time. A median estimate breaks this for about half
    the rows, which then read as though the DB wrote them before they happened."""
    boot = (12.0, 12.01, 12.02, 12.03, 12.04)
    # Writes land 5, 40, 6, 30 and 5 ms after their stamp: floor is 5 ms.
    db = [1000.005, 1000.050, 1000.026, 1000.060, 1000.045]
    _write(clock_run, "ACT_CMD.B2.CH9.actuator_state", db, [0, 1, 0, 1, 0])
    _write(clock_run, "ACT_CMD.B2.CH9.timestamp_ns", db, [t * 1e9 for t in boot])

    t, _ = series.load_series("r", "ACT_CMD.B2.CH9.actuator_state", "sensor")
    assert np.all(t <= np.sort(db) + 1e-9)
    assert np.diff(t).tolist() == pytest.approx(np.diff(boot).tolist())


def test_reanchoring_a_single_row_degrades_to_the_db_time(clock_run):
    # With one row the median offset IS that row's write latency, so the result is the DB
    # time exactly — no worse than the fallback it replaces.
    _write(clock_run, "SEQUENCER.state.current_state", [1000.0], [1])
    _write(clock_run, "SEQUENCER.state.timestamp_ns", [1000.0], [8.0 * 1e9])
    t, _ = series.load_series("r", "SEQUENCER.state.current_state", "sensor")
    assert t.tolist() == pytest.approx([1000.0])


def test_an_epoch_clock_is_not_shifted(clock_run):
    # Re-anchoring an already-epoch clock would erase the genuine lead a sample time has
    # over its write — which is real information, not error.
    _write(clock_run, "PT1.CH9.raw_adc_counts", BURSTY_DB, [1, 2, 3, 4, 5, 6])
    _write(clock_run, "PT1.CH9.timestamp_ns", BURSTY_DB, [t * 1e9 for t in EVEN_SENSOR])
    arr, kind = series.sensor_clock("r", "PT1.CH9")
    assert kind == series.SOURCE_SENSOR
    assert arr.tolist() == pytest.approx(EVEN_SENSOR)


def test_missing_sibling_falls_back_to_db_time(clock_run):
    _write(clock_run, "PT_Cal.Ox_Upstream.pressure_psi", BURSTY_DB, [1, 2, 3, 4, 5, 6])
    t, _ = series.load_series("r", "PT_Cal.Ox_Upstream.pressure_psi", "sensor")
    assert t.tolist() == pytest.approx(BURSTY_DB)


def test_row_count_mismatch_falls_back_rather_than_mispairing(clock_run):
    # The swap is positional, so different row counts mean the two files are not the same
    # rows — taking it anyway would pair each sample with somebody else's timestamp.
    _write(clock_run, "PT1.CH2.raw_adc_counts", BURSTY_DB, [1, 2, 3, 4, 5, 6])
    _write(clock_run, "PT1.CH2.timestamp_ns", BURSTY_DB[:4], [t * 1e9 for t in EVEN_SENSOR[:4]])
    t, _ = series.load_series("r", "PT1.CH2.raw_adc_counts", "sensor")
    assert t.tolist() == pytest.approx(BURSTY_DB)


def test_series_are_sorted_by_whichever_clock_is_in_use(clock_run):
    # Rows arrive in DB order; the sensor clock may disagree, and the output must be
    # monotonic on the axis actually being drawn.
    _write(clock_run, "PT1.CH3.raw_adc_counts", [1000.0, 1000.1, 1000.2], [10, 20, 30])
    _write(clock_run, "PT1.CH3.timestamp_ns", [1000.0, 1000.1, 1000.2],
           [1000.2e9, 1000.0e9, 1000.1e9])
    t, v = series.load_series("r", "PT1.CH3.raw_adc_counts", "sensor")
    assert np.all(np.diff(t) >= 0)
    assert v.tolist() == [20, 30, 10]  # values follow their own timestamps


def test_index_extent_covers_channels_on_both_clocks(clock_run, monkeypatch):
    """The run extent is a union across entities, each on its own clock. Command and
    heartbeat channels start at boot, ~3.7 s before the first sensor packet on a real
    run; measuring only the sensor-clocked ones clipped the start of every one of them."""
    monkeypatch.setattr(export_cache, "_db_size_bytes", lambda _r: None)
    # A sensor channel covering 1010..1012, and a boot-relative one covering 1000..1002.
    _write(clock_run, "PT1.CH1.raw_adc_counts", [1010.0, 1012.0], [1, 2])
    _write(clock_run, "PT1.CH1.timestamp_ns", [1010.0, 1012.0], [1010.0e9, 1012.0e9])
    _write(clock_run, "ACT_CMD.B2.CH1.actuator_state", [1000.0, 1002.0], [0, 1])
    _write(clock_run, "ACT_CMD.B2.CH1.timestamp_ns", [1000.0, 1002.0], [5.0e9, 7.0e9])

    idx = export_cache.build_index("r")
    kinds = {c["entity"]: c["time_source"] for c in idx["components"]}
    assert kinds["PT1.CH1"] == "sensor" and kinds["ACT_CMD.B2.CH1"] == "monotonic"
    assert idx["n_reanchored"] == 2 and idx["n_db_only"] == 0
    # The window must reach back to the command channel's start, not begin at the sensor's.
    assert idx["sensor_t_min"] == pytest.approx(1000.0)
    assert idx["sensor_t_max"] == pytest.approx(1012.0)


def test_throttle_paces_throughput():
    import time as _t

    chunks = ["x" * 100_000 for _ in range(5)]  # 500 KB total
    t0 = _t.monotonic()
    got = "".join(series.throttle(chunks, 1_000_000))  # 1 MB/s → ~0.5 s
    dt = _t.monotonic() - t0
    assert len(got) == 500_000
    assert dt >= 0.35  # paced (unthrottled would be ~0 s)


def test_throttle_disabled_is_passthrough():
    chunks = ["a", "b", "c"]
    assert list(series.throttle(chunks, 0)) == chunks
