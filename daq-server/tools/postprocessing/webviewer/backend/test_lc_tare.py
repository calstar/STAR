"""Load-cell tare reconstruction in the viewer.

Run: cd webviewer && .venv/bin/python -m pytest backend/test_lc_tare.py -q

Hermetic — no elodin-db and no real run. Elodin archives ABSOLUTE force forever; the tare is
display state the backend recorded beside the run, and these tests pin the replay of it.

Every case names the wrong number it prevents:
  * a step applied across the whole array makes the PRE-tare part of every run read wrong;
  * a missed 'recal' line makes everything after a re-fit read wrong;
  * synthesising a tared twin unconditionally makes an untared run look tared;
  * synthesising in build_index instead of at serve time means a run exported before its sidecar
    landed never shows its tare, with the cached index quietly winning.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from . import config, export_cache, lc_tare, run_config, series


@pytest.fixture
def run(tmp_path, monkeypatch):
    """A scratch run: parquet cache and ELODIN_DIR both under tmp_path."""
    cache = tmp_path / "cache"
    cache.mkdir()
    elodin = tmp_path / "elodin"
    (elodin / "daq_20260914_120000").mkdir(parents=True)
    monkeypatch.setattr(config, "ELODIN_DIR", elodin)
    monkeypatch.setattr(export_cache, "cache_dir", lambda run_id: cache)
    # Mandatory for anything touching load_series: both caches are keyed on (run_id, component)
    # and would serve a previous test's arrays.
    series.load_series.cache_clear()
    series.sensor_clock.cache_clear()
    return {"id": "daq_20260914_120000", "cache": cache, "elodin": elodin}


def write_gross(run, entity="LC2_Cal.CH1", times=(100.0, 200.0, 300.0), values=(50.0, 51.0, 52.0)):
    df = pd.DataFrame({
        "time": pd.to_datetime(np.array(times) * 1e9, unit="ns"),
        "value": list(values),
    })
    df.to_parquet(run["cache"] / f"{entity}.force_kg.parquet")


def write_sidecar(run, lines):
    p = run["elodin"] / run["id"] / "lc_tare.jsonl"
    p.write_text("".join(json.dumps(l) + "\n" for l in lines))


# ── the step function ───────────────────────────────────────────────────────

def test_offset_applies_only_after_the_tare_was_set(run):
    # Subtracting the final offset across the whole array would make every sample before the
    # operator pressed Tare read 20 kg light — the pre-tare part of the run, silently wrong.
    write_gross(run)
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "uid": 4201, "event": "set",
         "offsetKg": 20.0, "adcAtTare": 1000, "appliedAtMs": 250_000},
    ])
    t, v = series.load_series(run["id"], "LC2_Cal.CH1.force_kg_tared")
    assert list(t) == [100.0, 200.0, 300.0]
    assert v == pytest.approx([50.0, 51.0, 32.0])


def test_a_recal_line_moves_the_offset_again(run):
    # A re-fit rewrites the offset with NO operator action. Reading only the first line leaves
    # everything after the re-cal wrong by the difference.
    write_gross(run)
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "event": "set", "offsetKg": 20.0, "appliedAtMs": 150_000},
        {"entity": "LC2_Cal.CH1", "event": "recal", "offsetKg": 22.0, "appliedAtMs": 250_000},
    ])
    _, v = series.load_series(run["id"], "LC2_Cal.CH1.force_kg_tared")
    assert v == pytest.approx([50.0, 31.0, 30.0])


def test_a_clear_returns_the_trace_to_absolute(run):
    write_gross(run)
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "event": "set", "offsetKg": 20.0, "appliedAtMs": 150_000},
        {"entity": "LC2_Cal.CH1", "event": "clear", "offsetKg": 0.0, "appliedAtMs": 250_000},
    ])
    _, v = series.load_series(run["id"], "LC2_Cal.CH1.force_kg_tared")
    assert v == pytest.approx([50.0, 31.0, 52.0])


def test_the_absolute_series_is_never_touched(run):
    # The whole premise: force_kg means the same thing in every run ever archived.
    write_gross(run)
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "event": "set", "offsetKg": 20.0, "appliedAtMs": 150_000},
    ])
    _, gross = series.load_series(run["id"], "LC2_Cal.CH1.force_kg")
    assert gross == pytest.approx([50.0, 51.0, 52.0])


def test_gross_and_tared_do_not_share_a_cache_entry(run):
    # Both go through one lru_cache keyed on (run_id, component, time_source). Stripping the
    # suffix before the lookup would make the tared request return the absolute arrays.
    write_gross(run)
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "event": "set", "offsetKg": 20.0, "appliedAtMs": 150_000},
    ])
    _, gross = series.load_series(run["id"], "LC2_Cal.CH1.force_kg")
    _, tared = series.load_series(run["id"], "LC2_Cal.CH1.force_kg_tared")
    assert list(gross) != list(tared)


# ── existence ───────────────────────────────────────────────────────────────

def test_no_sidecar_means_no_tared_component(run):
    # Synthesising one anyway would render identically to gross and lie about whether a tare ever
    # existed on this run.
    write_gross(run)
    with pytest.raises(FileNotFoundError):
        series.load_series(run["id"], "LC2_Cal.CH1.force_kg_tared")
    idx = run_config.annotate({"components": [
        {"name": "LC2_Cal.CH1.force_kg", "entity": "LC2_Cal.CH1", "field": "force_kg"},
    ]}, run["id"])
    assert [c["name"] for c in idx["components"]] == ["LC2_Cal.CH1.force_kg"]


def test_a_channel_with_no_tare_gets_no_twin(run):
    # Two load cells, one tared. The untared one must not grow a tared component.
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "event": "set", "offsetKg": 20.0, "appliedAtMs": 150_000},
    ])
    idx = run_config.annotate({"components": [
        {"name": "LC2_Cal.CH1.force_kg", "entity": "LC2_Cal.CH1", "field": "force_kg"},
        {"name": "LC2_Cal.CH2.force_kg", "entity": "LC2_Cal.CH2", "field": "force_kg"},
    ]}, run["id"])
    names = [c["name"] for c in idx["components"]]
    assert "LC2_Cal.CH1.force_kg_tared" in names
    assert "LC2_Cal.CH2.force_kg_tared" not in names


def test_a_sidecar_dropped_in_later_takes_effect_without_a_re_export(run):
    # The reason synthesis lives in annotate() and not build_index(): a run indexed before its
    # tare record was written must still show its tared traces on the next open. If this moved
    # into build_index the cached index would win and the tare would never appear.
    comps = [{"name": "LC2_Cal.CH1.force_kg", "entity": "LC2_Cal.CH1", "field": "force_kg"}]
    before = run_config.annotate({"components": list(comps)}, run["id"])
    assert "LC2_Cal.CH1.force_kg_tared" not in [c["name"] for c in before["components"]]

    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "event": "set", "offsetKg": 20.0, "appliedAtMs": 150_000},
    ])
    after = run_config.annotate({"components": list(comps)}, run["id"])
    assert "LC2_Cal.CH1.force_kg_tared" in [c["name"] for c in after["components"]]


def test_index_version_did_not_move(run):
    # Bumping it would invalidate every cached export on the postprocessing box, for a feature
    # that is layered on at read time and needs no re-export at all.
    assert export_cache.INDEX_VERSION == 3


# ── degradation ─────────────────────────────────────────────────────────────

def test_a_torn_final_line_does_not_lose_the_earlier_ones(run):
    # The backend appends to this file while the run is live, so a reader can catch it mid-write.
    p = run["elodin"] / run["id"] / "lc_tare.jsonl"
    p.write_text(
        json.dumps({"entity": "LC2_Cal.CH1", "event": "set",
                    "offsetKg": 20.0, "appliedAtMs": 150_000}) + "\n"
        + '{"entity":"LC2_Cal.CH1","event":"rec'
    )
    assert lc_tare.load(run["id"]) == {"LC2_Cal.CH1": [(150.0, 20.0)]}


def test_a_missing_sidecar_is_empty_not_an_error(run):
    assert lc_tare.load(run["id"]) == {}


def test_a_non_finite_offset_is_skipped(run):
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "event": "set", "offsetKg": None, "appliedAtMs": 150_000},
    ])
    assert lc_tare.load(run["id"]) == {}


def test_the_unit_matches_its_absolute_twin(run):
    # Different units put the two traces on different y-axes, so the tared and absolute lines for
    # one load cell would not be comparable on the same chart.
    from .naming import classify
    assert classify("LC2_Cal.CH1.force_kg_tared").unit == classify("LC2_Cal.CH1.force_kg").unit
