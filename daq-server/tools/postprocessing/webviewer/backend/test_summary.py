"""Unit tests for the pre-index run summary, and the contract that opening a run is cheap.

The point of this module is that selecting a run must not trigger a parquet export, so
the tests assert the absence of work as much as the presence of numbers.

Run: cd webviewer && .venv/bin/python -m pytest backend/test_summary.py -q
"""

import os

import pytest
from fastapi.testclient import TestClient

from . import config, export_cache, summary
from .main import app


@pytest.fixture
def run_dir(tmp_path, monkeypatch):
    """A fake run laid out the way elodin-db lays one out: a numeric directory per
    component, each holding data/index/metadata/schema, plus non-component siblings."""
    monkeypatch.setattr(config, "ELODIN_DIR", tmp_path)
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "_cache")
    run = tmp_path / "daq_20260811_120000"
    run.mkdir()
    for i, age in enumerate([30.0, 20.0, 0.0]):  # newest last: a 30 s span
        d = run / str(1000 + i)
        d.mkdir()
        (d / "data").write_bytes(b"x")
        os.utime(d / "data", (1_000_000 - age, 1_000_000 - age))
    (run / "db_state").write_bytes(b"")  # not a component
    (run / "msgs").mkdir()  # not a component either
    return run


def test_reports_component_count_ignoring_non_component_entries(run_dir):
    s = summary.summarize("daq_20260811_120000")
    assert s["n_components"] == 3  # db_state and msgs are not components


def test_duration_is_the_write_span_and_is_flagged_approximate(run_dir):
    s = summary.summarize("daq_20260811_120000")
    assert s["duration_s"] == pytest.approx(30.0)
    # Never presented as exact: it is when data was written, not when it was sampled.
    assert s["duration_approx"] is True


def test_reports_size_and_cached_state(run_dir):
    s = summary.summarize("daq_20260811_120000")
    assert s["size_bytes"] and s["size_bytes"] > 0
    assert s["cached"] is False


def test_summarize_does_not_export(run_dir, monkeypatch):
    # The whole point: opening a run costs a few stats, not a multi-second export.
    monkeypatch.setattr(
        export_cache, "ensure_exported",
        lambda *a, **k: pytest.fail("summarize() must never trigger an export"),
    )
    summary.summarize("daq_20260811_120000")
    assert not (config.CACHE_DIR / "daq_20260811_120000").exists()


def test_reports_whether_a_config_snapshot_exists(run_dir):
    # Lets the client skip asking for a config that a pre-snapshot run never had, rather
    # than taking a 404 on every selection.
    assert summary.summarize("daq_20260811_120000")["has_config"] is False
    (run_dir.parent / "daq_20260811_120000.toml").write_text("[network]\n")
    assert summary.summarize("daq_20260811_120000")["has_config"] is True


def test_a_run_with_no_components_still_summarizes(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ELODIN_DIR", tmp_path)
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "_cache")
    (tmp_path / "daq_20260811_120000").mkdir()
    s = summary.summarize("daq_20260811_120000")
    assert s["n_components"] == 0 and s["duration_s"] is None


# ── the API contract ─────────────────────────────────────────────────────────


def test_components_refuses_an_unindexed_run_rather_than_exporting(run_dir, monkeypatch):
    """GET /components used to export on demand, which made merely clicking a run in the
    list cost tens of seconds. It now refuses; POST /index is the way to pay that."""
    monkeypatch.setattr(
        export_cache, "ensure_exported",
        lambda *a, **k: pytest.fail("GET /components must not trigger an export"),
    )
    r = TestClient(app).get("/api/runs/daq_20260811_120000/components")
    assert r.status_code == 409
    assert "not indexed" in r.json()["detail"]


def test_summary_route_rejects_a_bad_run_id_and_a_missing_run(run_dir):
    client = TestClient(app)
    # RUN_RE is the path-traversal guard on every {run_id} route.
    assert client.get("/api/runs/not-a-run/summary").status_code in (400, 404)
    assert client.get("/api/runs/daq_19990101_000000/summary").status_code == 404
