"""Unit tests for the shared per-run description store.

Run: cd webviewer && .venv/bin/python -m pytest backend/test_descriptions.py -q
"""

import json

import pytest

from . import config, descriptions, export_cache, runs


@pytest.fixture
def elodin_dir(tmp_path, monkeypatch):
    """A fake ELODIN_DIR with the store beside the runs, as in the real layout."""
    monkeypatch.setattr(config, "ELODIN_DIR", tmp_path)
    monkeypatch.setattr(config, "DESCRIPTIONS_PATH", tmp_path / "run_descriptions.json")
    monkeypatch.setattr(export_cache, "is_cached", lambda run_id: False)
    (tmp_path / "daq_20260811_120000").mkdir()
    return tmp_path


def test_set_get_and_clear(elodin_dir):
    descriptions.set_text("daq_20260811_120000", "hotfire 3, ox lead 200 ms")
    assert descriptions.get("daq_20260811_120000") == "hotfire 3, ox lead 200 ms"
    # Empty text is how you remove a label, not how you store an empty one.
    descriptions.set_text("daq_20260811_120000", "")
    assert descriptions.get("daq_20260811_120000") == ""
    assert "daq_20260811_120000" not in descriptions.all_texts()


def test_normalise_forces_one_line(elodin_dir):
    stored = descriptions.set_text("daq_20260811_120000", "  two\nlines   and\t gaps  ")
    assert stored["text"] == "two lines and gaps"


def test_normalise_truncates_to_max_len(elodin_dir):
    stored = descriptions.set_text("daq_20260811_120000", "x" * 500)
    assert len(stored["text"]) == descriptions.MAX_LEN


def test_anyone_can_overwrite_anyone(elodin_dir):
    # No ownership by design — there is no login on this viewer.
    descriptions.set_text("daq_20260811_120000", "first")
    descriptions.set_text("daq_20260811_120000", "second")
    assert descriptions.get("daq_20260811_120000") == "second"


def test_orphans_are_pruned_on_write(elodin_dir):
    # A discarded session removes its DB dir and config snapshot but knows nothing about
    # this file, so entries for runs that no longer exist must not accumulate.
    config.DESCRIPTIONS_PATH.write_text(
        json.dumps({"version": 1, "runs": {"daq_20200101_000000": {"text": "gone"}}})
    )
    descriptions.set_text("daq_20260811_120000", "still here")
    stored = json.loads(config.DESCRIPTIONS_PATH.read_text())["runs"]
    assert set(stored) == {"daq_20260811_120000"}


def test_unreadable_store_degrades_to_no_descriptions(elodin_dir):
    config.DESCRIPTIONS_PATH.write_text("{ not json")
    assert descriptions.all_texts() == {}
    assert descriptions.get("daq_20260811_120000") == ""


def test_write_is_atomic_and_leaves_no_temp_files(elodin_dir):
    descriptions.set_text("daq_20260811_120000", "a run")
    leftovers = [p.name for p in elodin_dir.iterdir() if p.name.startswith(".descriptions-")]
    assert leftovers == []


def test_listing_carries_descriptions(elodin_dir):
    (elodin_dir / "daq_sim_20260827_204900").mkdir()
    descriptions.set_text("daq_20260811_120000", "cold flow")
    found = {r["id"]: r["description"] for r in runs.list_runs()}
    assert found["daq_20260811_120000"] == "cold flow"
    assert found["daq_sim_20260827_204900"] == ""  # unlabelled runs still list
