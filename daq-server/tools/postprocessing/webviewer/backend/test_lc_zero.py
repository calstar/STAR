"""Load-cell re-zero: the viewer half.

Run with:  cd webviewer && .venv/bin/python -m pytest backend/test_lc_zero.py -q

The premise here is the opposite of test_lc_tare.py's, and that is the point. A tare leaves
`force_kg` absolute and is replayed as a subtraction. A zero is applied INSIDE the conversion by
the calibration service, so `force_kg` on a zeroed channel is already shifted and no subtraction
gets back. The only route to the un-zeroed scale is re-evaluating the run's own snapshotted
calibration at the raw codes the archive already stores.

So these cases are all about whether an archived run stays reconstructible: that the snapshot is
read, that a run without one is untouched, and that the absolute twin is offered exactly when it
can actually be computed — never as a plausible NaN.

The curve used throughout is the one from the C++ suite: codes 500k-600k -> 0-50 kg with a cubic
term the size a narrow-window least-squares fit picks up from noise.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from . import config, export_cache, lc_zero, run_config, series

CAL_ZERO = 500_000.0
KG_PER_COUNT = 5.0e-4
CUBIC = 5.0e-16


def curve(adc):
    d = np.asarray(adc, dtype=float) - CAL_ZERO
    return d * KG_PER_COUNT + CUBIC * d**3


@pytest.fixture
def run(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    cache.mkdir()
    elodin = tmp_path / "elodin"
    (elodin / "daq_20260920_120000").mkdir(parents=True)
    monkeypatch.setattr(config, "ELODIN_DIR", elodin)
    monkeypatch.setattr(export_cache, "cache_dir", lambda run_id: cache)
    series.load_series.cache_clear()
    series.sensor_clock.cache_clear()
    return {"id": "daq_20260920_120000", "cache": cache, "elodin": elodin}


def write_raw(run, entity="LC2_Cal.CH1", times=(100.0, 200.0, 300.0), codes=(-300_000, -280_000, -260_000)):
    """The raw ADC trace. This is what a reconstruction is built from."""
    pd.DataFrame({
        "time": pd.to_datetime(np.array(times) * 1e9, unit="ns"),
        "value": list(codes),
    }).to_parquet(run["cache"] / f"{entity}.raw_adc.parquet")


def write_zeroed_force(run, entity="LC2_Cal.CH1", times=(100.0, 200.0, 300.0),
                       codes=(-300_000, -280_000, -260_000), shift=-800_000.0):
    """What the service published: curve(raw - shift), the zero already inside it."""
    pd.DataFrame({
        "time": pd.to_datetime(np.array(times) * 1e9, unit="ns"),
        "value": list(curve(np.array(codes, dtype=float) - shift)),
    }).to_parquet(run["cache"] / f"{entity}.force_kg.parquet")


def write_calibration(run, uid=4201, coeffs=None):
    """<run_id>.calibration.json — the cubic store as the run read it."""
    a = CUBIC
    b = -3 * CUBIC * CAL_ZERO
    c = 3 * CUBIC * CAL_ZERO**2 + KG_PER_COUNT
    d = -CUBIC * CAL_ZERO**3 - KG_PER_COUNT * CAL_ZERO
    (run["elodin"] / f"{run['id']}.calibration.json").write_text(json.dumps({
        "cubic_state": {
            str(uid): {
                "uid": uid, "active_model": "cubic", "polyCoeffs": [],
                "adcNormMin": 0.0, "adcNormScale": 1.0,
                "coeffs": coeffs or {"A": a, "B": b, "C": c, "D": d},
            }
        }
    }))


def write_zero_snapshot(run, entity="LC2_Cal.CH1", uid=4201, shift=-800_000.0):
    """<run_id>.lc_zero.json — the zeros standing when the run began."""
    (run["elodin"] / f"{run['id']}.lc_zero.json").write_text(json.dumps({
        "version": 1,
        "zeros": [{
            "uid": uid, "entity": entity, "adc_at_zero": CAL_ZERO + shift,
            "cal_zero_adc": CAL_ZERO, "shift_codes": shift,
            "domain_min": 500_000, "domain_max": 600_000,
            "set_at_ms": 1_757_800_000_000, "basis_fp": 7,
        }],
    }))


def write_sidecar(run, lines):
    (run["elodin"] / run["id"] / "lc_zero.jsonl").write_text(
        "".join(json.dumps(l) + "\n" for l in lines)
    )


def full_run(run, shift=-800_000.0):
    write_raw(run)
    write_zeroed_force(run, shift=shift)
    write_calibration(run)
    write_zero_snapshot(run, shift=shift)


# ── reconstruction ──────────────────────────────────────────────────────────

def test_the_absolute_twin_is_what_the_channel_would_have_read_unzeroed(run):
    # The reason this exists at all: a run taken after a re-zero and one taken before it are on
    # different scales, and this is the only thing that puts them back on one.
    full_run(run)
    _, v = series.load_series(run["id"], "LC2_Cal.CH1.force_kg_absolute")
    assert v == pytest.approx(curve([-300_000, -280_000, -260_000]))
    # And that really is the wild reading the drift produced — an EMPTY cell at -656 kg.
    assert v[0] < -100


def test_the_zeroed_series_recorded_in_the_run_is_left_alone(run):
    # force_kg carries the zero, by design. Nothing here re-applies or removes it.
    full_run(run)
    _, v = series.load_series(run["id"], "LC2_Cal.CH1.force_kg")
    assert v[0] == pytest.approx(0.0, abs=1e-6)  # an empty cell, correctly zeroed
    assert v[1] == pytest.approx(10.0, abs=0.01)


def test_the_two_series_round_trip_through_the_snapshot(run):
    # The whole reconstructibility claim in one assertion: raw codes + the snapshotted curve +
    # the recorded shift reproduce exactly what the service published.
    full_run(run)
    _, absolute = series.load_series(run["id"], "LC2_Cal.CH1.force_kg_absolute")
    _, zeroed = series.load_series(run["id"], "LC2_Cal.CH1.force_kg")
    t, raw = series.load_series(run["id"], "LC2_Cal.CH1.raw_adc")
    shift = lc_zero.shift_at(run["id"], "LC2_Cal.CH1", t)
    assert shift == pytest.approx([-800_000.0] * 3)
    rebuilt = curve(raw - shift)
    assert rebuilt == pytest.approx(zeroed)
    assert absolute != pytest.approx(zeroed)  # they are genuinely different scales


def test_raw_adc_is_never_touched(run):
    full_run(run)
    _, v = series.load_series(run["id"], "LC2_Cal.CH1.raw_adc")
    assert list(v) == [-300_000, -280_000, -260_000]


def test_absolute_and_raw_do_not_share_a_cache_entry(run):
    # Both are read from the same parquet file; a shared cache key would serve one as the other.
    full_run(run)
    _, raw = series.load_series(run["id"], "LC2_Cal.CH1.raw_adc")
    _, absolute = series.load_series(run["id"], "LC2_Cal.CH1.force_kg_absolute")
    assert list(raw) != list(absolute)


# ── when the twin is, and is not, offered ───────────────────────────────────

def components(entity="LC2_Cal.CH1"):
    return [
        {"entity": entity, "field": "force_kg", "name": f"{entity}.force_kg"},
        {"entity": entity, "field": "raw_adc", "name": f"{entity}.raw_adc"},
    ]


def test_a_run_with_no_zero_gets_no_twin(run):
    # Synthesising one for every load cell would make an un-zeroed run indistinguishable from a
    # zeroed one whose shift happened to be 0.
    write_raw(run)
    write_calibration(run)
    assert lc_zero.absolute_components(run["id"], components()) == []


def test_a_run_with_no_calibration_snapshot_gets_no_twin(run):
    # A run archived before the snapshot existed has no curve anywhere. Offering a component that
    # can only evaluate to NaN is worse than not offering it.
    write_raw(run)
    write_zero_snapshot(run)
    assert lc_zero.absolute_components(run["id"], components()) == []


def test_a_channel_with_no_raw_trace_gets_no_twin(run):
    write_zeroed_force(run)
    write_calibration(run)
    write_zero_snapshot(run)
    comps = [{"entity": "LC2_Cal.CH1", "field": "force_kg", "name": "LC2_Cal.CH1.force_kg"}]
    assert lc_zero.absolute_components(run["id"], comps) == []


def test_an_uncalibrated_channel_gets_no_twin(run):
    write_raw(run)
    write_zero_snapshot(run)
    write_calibration(run, coeffs={"A": 0.0, "B": 0.0, "C": 0.0, "D": 0.0})
    assert lc_zero.absolute_components(run["id"], components()) == []


def test_the_twin_is_offered_when_it_can_actually_be_computed(run):
    full_run(run)
    out = lc_zero.absolute_components(run["id"], components())
    assert [c["name"] for c in out] == ["LC2_Cal.CH1.force_kg_absolute"]
    assert out[0]["field"] == "force_kg_absolute"


def test_requesting_a_twin_that_does_not_exist_raises(run):
    write_raw(run)
    write_calibration(run)
    with pytest.raises(FileNotFoundError):
        series.load_series(run["id"], "LC2_Cal.CH1.force_kg_absolute")


# ── the shift record ────────────────────────────────────────────────────────

def test_a_mid_run_rezero_moves_the_shift_as_a_step(run):
    # An operator who re-zeroes mid-run makes the same ADC code mean two weights inside one
    # archive. Only the timestamped sidecar says where the boundary was.
    full_run(run)
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "uid": 4201, "event": "set",
         "shiftCodes": -800_000.0, "appliedAtMs": 50_000},
        {"entity": "LC2_Cal.CH1", "uid": 4201, "event": "set",
         "shiftCodes": -790_000.0, "appliedAtMs": 250_000},
    ])
    t = np.array([100.0, 200.0, 300.0])
    assert lc_zero.shift_at(run["id"], "LC2_Cal.CH1", t) == pytest.approx(
        [-800_000.0, -800_000.0, -790_000.0]
    )


def test_a_clear_returns_the_shift_to_zero(run):
    full_run(run)
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "uid": 4201, "event": "set",
         "shiftCodes": -800_000.0, "appliedAtMs": 50_000},
        {"entity": "LC2_Cal.CH1", "uid": 4201, "event": "clear",
         "shiftCodes": 0.0, "appliedAtMs": 250_000},
    ])
    t = np.array([100.0, 200.0, 300.0])
    assert lc_zero.shift_at(run["id"], "LC2_Cal.CH1", t) == pytest.approx(
        [-800_000.0, -800_000.0, 0.0]
    )


def test_the_snapshot_covers_samples_before_the_first_sidecar_line(run):
    # The backend writes its `set` lines at its first poll after the run starts, so there is a
    # short window at the head of every run that only the snapshot accounts for. Without the
    # seed those samples would be attributed a shift of 0 and read on the wrong scale.
    full_run(run)
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "uid": 4201, "event": "set",
         "shiftCodes": -800_000.0, "appliedAtMs": 250_000},
    ])
    t = np.array([100.0, 300.0])
    assert lc_zero.shift_at(run["id"], "LC2_Cal.CH1", t) == pytest.approx([-800_000.0, -800_000.0])


def test_a_torn_final_line_does_not_lose_the_earlier_ones(run):
    # Expected: the file is appended to while the run is live.
    full_run(run)
    p = run["elodin"] / run["id"] / "lc_zero.jsonl"
    p.write_text(
        json.dumps({"entity": "LC2_Cal.CH1", "uid": 4201, "event": "set",
                    "shiftCodes": -790_000.0, "appliedAtMs": 150_000}) + "\n"
        + '{"entity": "LC2_Cal.CH1", "shiftCo'
    )
    t = np.array([100.0, 300.0])
    assert lc_zero.shift_at(run["id"], "LC2_Cal.CH1", t) == pytest.approx(
        [-800_000.0, -790_000.0]
    )


def test_a_torn_line_in_the_middle_does_not_lose_what_follows(run):
    # A crash mid-append leaves a partial line; if the service comes back inside the same run it
    # keeps appending after it. Stopping at the first unparseable line would silently read the
    # rest of the run on a stale shift — the same wrong-and-plausible number the whole feature
    # exists to avoid. Skipping the bad line is the only safe reading.
    full_run(run)
    p = run["elodin"] / run["id"] / "lc_zero.jsonl"
    p.write_text(
        json.dumps({"entity": "LC2_Cal.CH1", "uid": 4201, "event": "set",
                    "shiftCodes": -800_000.0, "appliedAtMs": 50_000}) + "\n"
        + '{"entity": "LC2_Cal.CH1", "shiftCo' + "\n"
        + json.dumps({"entity": "LC2_Cal.CH1", "uid": 4201, "event": "set",
                      "shiftCodes": -790_000.0, "appliedAtMs": 250_000}) + "\n"
    )
    t = np.array([100.0, 300.0])
    assert lc_zero.shift_at(run["id"], "LC2_Cal.CH1", t) == pytest.approx(
        [-800_000.0, -790_000.0]
    )


def test_a_missing_sidecar_is_empty_not_an_error(run):
    write_raw(run)
    write_calibration(run)
    assert lc_zero.load(run["id"]) == {}


def test_a_non_finite_shift_is_skipped(run):
    full_run(run)
    write_sidecar(run, [
        {"entity": "LC2_Cal.CH1", "uid": 4201, "event": "set",
         "shiftCodes": None, "appliedAtMs": 150_000},
    ])
    t = np.array([300.0])
    assert lc_zero.shift_at(run["id"], "LC2_Cal.CH1", t) == pytest.approx([-800_000.0])


# ── the index ───────────────────────────────────────────────────────────────

def test_index_version_did_not_move(run):
    # The twin is synthesised at serve time, not baked into the cached export, so a run exported
    # before its snapshot was written still shows it on the next open. Bumping INDEX_VERSION
    # would invalidate every cached export on the box for nothing.
    assert export_cache.INDEX_VERSION == 3


def test_the_unit_matches_its_zeroed_twin(run):
    # Different units put the two traces on different y-axes, so the absolute and zeroed lines
    # for one load cell would not be comparable on the same chart — which is the only reason the
    # absolute twin exists.
    from .naming import classify
    assert classify("LC2_Cal.CH1.force_kg_absolute").unit == classify("LC2_Cal.CH1.force_kg").unit
