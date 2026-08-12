"""Unit tests for the data-shaping logic (no elodin-db / real run needed).

Run: cd webviewer && .venv/bin/python -m pytest backend/test_series.py -q
"""

import numpy as np

from . import series
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
    def fake_load(_run, name):
        if name == "cont":
            return np.array([0.0, 2.0]), np.array([10.0, 20.0])
        return np.array([1.0]), np.array([1.0])  # discrete, single sample at t=1

    monkeypatch.setattr(series, "load_series", fake_load)
    monkeypatch.setattr(
        series, "classify",
        lambda n: type("C", (), {"discrete": n == "disc"})(),
    )
    text = "".join(series.wide_csv_rows("r", ["cont", "disc"], None, None))
    lines = text.strip().split("\n")
    assert lines[0] == "time,cont,disc"
    body = [ln.split(",") for ln in lines[1:]]
    times = [float(r[0]) for r in body]
    assert times == [0.0, 1.0, 2.0]  # union of {0,2} and {1}
    # discrete forward-fills from t=1 onward; empty before it.
    disc_col = [r[2] for r in body]
    assert disc_col[0] == "" and disc_col[1] == "1" and disc_col[2] == "1"


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
