"""Unit tests for run discovery (no elodin-db / real run needed).

Run: cd webviewer && .venv/bin/python -m pytest backend/test_runs.py -q
"""

import pytest

from . import config, export_cache, runs


@pytest.fixture
def elodin_dir(tmp_path, monkeypatch):
    """Point the backend at an empty fake ELODIN_DIR with the cache stubbed out."""
    monkeypatch.setattr(config, "ELODIN_DIR", tmp_path)
    monkeypatch.setattr(export_cache, "is_cached", lambda run_id: False)
    return tmp_path


def test_lists_real_and_simulated_runs(elodin_dir):
    # The sim prefix comes from session-manager's timestampName(); it must not
    # make a run invisible (it silently did before the pattern allowed `sim_`).
    (elodin_dir / "daq_20260811_120000").mkdir()
    (elodin_dir / "daq_sim_20260827_204900").mkdir()

    found = {r["id"]: r for r in runs.list_runs()}
    assert set(found) == {"daq_20260811_120000", "daq_sim_20260827_204900"}
    assert found["daq_20260811_120000"]["simulated"] is False
    assert found["daq_sim_20260827_204900"]["simulated"] is True
    # The timestamp is read past the prefix, not off the raw name.
    assert found["daq_sim_20260827_204900"]["started"] == "2026-08-27T20:49:00"


def test_ignores_ad_hoc_and_hand_named_dirs(elodin_dir):
    for name in (
        "daq_live",
        "calibration",
        "daq_sim",
        "daq_sim_live",
        "daq_hotfire_test",
        "daq_2026081_120000",  # short date
        "daq_20260811_12000",  # short time
        "xdaq_20260811_120000",
        "daq_20260811_120000_old",
    ):
        (elodin_dir / name).mkdir()
    # A file matching the pattern is not a run either.
    (elodin_dir / "daq_20260811_120000").write_text("not a directory")

    assert runs.list_runs() == []


def test_sorted_newest_first(elodin_dir):
    for name in (
        "daq_20260811_120000",
        "daq_sim_20260827_204900",
        "daq_20260901_000000",
    ):
        (elodin_dir / name).mkdir()

    assert [r["id"] for r in runs.list_runs()] == [
        "daq_20260901_000000",
        "daq_sim_20260827_204900",
        "daq_20260811_120000",
    ]


def test_run_id_pattern_rejects_path_traversal():
    # RUN_RE also guards the {run_id} path params in main.py.
    for bad in ("../etc", "daq_20260811_120000/..", "daq_sim_20260827_204900/x", ""):
        assert config.RUN_RE.match(bad) is None
