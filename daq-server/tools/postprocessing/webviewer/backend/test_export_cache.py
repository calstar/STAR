"""A cached export is reused only while it is a copy of the DB as it is now.

The bug these guard: a run opened while it was still recording kept that first export
forever (`_done` was never compared with the DB), and the series lru caches kept the short
arrays even after a fresh export. daq_20261123_181135 showed 7 minutes of a 33-minute run.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from . import config, export_cache, series

RUN = "daq_20261123_181135"
COMP = "PT1.CH9.raw_adc_counts"


class FakeRun:
    """An elodin-db run dir whose 'contents' are a row count, plus an exporter for it."""

    def __init__(self, root: Path):
        self.db = root / "elodin" / RUN
        self.db.mkdir(parents=True)
        (self.db / "db_state").write_bytes(b"state")
        self.rows = 0
        self.exports = 0
        self.add_component("a")

    def add_component(self, name: str) -> None:
        (self.db / name).mkdir()
        (self.db / name / "data").write_bytes(b"")

    def record(self, rows: int, written_s_ago: float) -> None:
        """The DB gains rows; its newest write was `written_s_ago` seconds ago."""
        self.rows = rows
        data = self.db / "a" / "data"
        data.write_bytes(b"x" * rows)
        t = time.time() - written_s_ago
        os.utime(data, (t, t))

    def export_into(self, _run_id: str, _db: Path, out: Path) -> None:
        self.exports += 1
        out.mkdir(parents=True, exist_ok=True)
        t0 = np.datetime64("2026-11-24T02:11:40", "ns")
        times = t0 + np.arange(self.rows).astype("timedelta64[s]")
        pd.DataFrame({"time": times, "v": np.arange(self.rows, dtype=float)}).to_parquet(
            out / f"{COMP}.parquet"
        )


@pytest.fixture
def run(tmp_path, monkeypatch):
    fake = FakeRun(tmp_path)
    monkeypatch.setattr(config, "ELODIN_DIR", fake.db.parent)
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(export_cache, "_export_into", fake.export_into)
    monkeypatch.setattr(export_cache, "_db_size_bytes", lambda _r: None)
    monkeypatch.setattr(export_cache, "CHECK_INTERVAL_S", 0.0)
    monkeypatch.setattr(export_cache.run_config, "annotate", lambda data, _r: data)
    export_cache._checked.clear()
    series.load_series.cache_clear()
    series.sensor_clock.cache_clear()
    return fake


def _rows_served() -> int:
    t, _ = series.load_series(RUN, COMP, "db")
    return len(t)


def test_a_run_exported_mid_recording_is_re_exported_once_it_stops(run):
    run.record(rows=415, written_s_ago=0)  # still recording when first opened
    idx = export_cache.get_index(RUN)
    assert _rows_served() == 415

    run.record(rows=1975, written_s_ago=120)  # it went on, then stopped
    idx = export_cache.get_index(RUN)
    assert run.exports == 2
    assert idx["duration_s"] == pytest.approx(1974)
    assert idx["partial"] is False and idx["recording"] is False
    # And the in-memory series cache does not keep serving the 415-row copy.
    assert _rows_served() == 1975


def test_a_run_still_recording_keeps_its_copy_and_says_it_is_partial(run):
    run.record(rows=415, written_s_ago=0)
    export_cache.get_index(RUN)
    run.record(rows=600, written_s_ago=0)  # still being written

    idx = export_cache.get_index(RUN)
    export_cache.ensure_exported(RUN)
    assert run.exports == 1  # no full export against a DB the stand is writing to
    assert idx["partial"] is True and idx["recording"] is True
    assert _rows_served() == 415


def test_an_unchanged_run_is_never_exported_again(run):
    run.record(rows=500, written_s_ago=300)
    export_cache.get_index(RUN)
    # Opening the DB rewrites db_state; that must not read as the run changing.
    (run.db / "db_state").write_bytes(b"reopened")
    for _ in range(3):
        idx = export_cache.get_index(RUN)
        export_cache.ensure_exported(RUN)
    assert run.exports == 1
    assert idx["partial"] is False


def test_a_new_component_dir_counts_as_a_change(run):
    run.record(rows=500, written_s_ago=300)
    export_cache.get_index(RUN)
    run.add_component("b")
    os.utime(run.db / "b" / "data", (time.time() - 200,) * 2)
    export_cache.ensure_exported(RUN)
    assert run.exports == 2


def test_a_legacy_empty_marker_is_trusted_only_if_the_db_stopped_before_it(run):
    run.record(rows=500, written_s_ago=300)
    export_cache.ensure_exported(RUN)
    marker = export_cache.cache_dir(RUN) / "_done"

    # Exported after the run finished: keep it, and upgrade the marker.
    marker.write_text("")
    export_cache.ensure_exported(RUN)
    assert run.exports == 1
    assert marker.read_text().strip() != ""

    # Exported before the run's last write: the frozen case. Replace it.
    marker.write_text("")
    past = time.time() - 600
    os.utime(marker, (past, past))
    export_cache.ensure_exported(RUN)
    assert run.exports == 2


def test_a_failed_re_export_leaves_the_old_copy_in_place(run, monkeypatch):
    run.record(rows=415, written_s_ago=200)
    export_cache.ensure_exported(RUN)
    run.record(rows=900, written_s_ago=100)

    def boom(*_a):
        raise RuntimeError("elodin-db export failed")

    monkeypatch.setattr(export_cache, "_export_into", boom)
    with pytest.raises(RuntimeError):
        export_cache.ensure_exported(RUN)
    assert (export_cache.cache_dir(RUN) / "_done").exists()
    assert _rows_served() == 415
