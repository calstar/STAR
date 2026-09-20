"""Load-cell zeros, and the absolute series reconstructed from them.

A ZERO is not a tare, and this is not lc_tare.py with the nouns changed. The difference decides
the whole shape of this module.

A tare is subtracted AFTER the curve, in kilograms, so Elodin keeps recording absolute force and
`lc_tare.py` replays the subtraction. A zero shifts the curve's INPUT, in ADC codes, and
``model(adc - shift)`` is not ``model(adc) - k``. It cannot be applied or undone downstream of the
conversion, so the calibration service applies it inside the conversion and publishes the result.

That means the thing lc_tare.py's docstring promises — "Elodin records ABSOLUTE force, always and
forever" — stops being true of `force_kg` on a zeroed channel, on purpose. The same ADC code maps
to different weights in runs with different zeros; that is what a re-zero IS. What keeps a run
readable is that `raw_adc` is recorded alongside, and the backend snapshots the calibration and
the zero beside the run at session start:

    <run_id>.calibration.json   the cubic store as the run read it
    <run_id>.lc_zero.json       the zeros standing when the run began
    <run_id>/lc_zero.jsonl      every change of shift during the run, append-only

With those, a run is fully reconstructible from its raw codes: the absolute series this module
synthesises, the zeroed series the run actually recorded, or any hypothetical zero.

The synthesised component is `…force_kg_absolute` — the reading the channel WOULD have shown with
no zero applied. It exists because that is the only scale on which a zeroed run and a run from
before the re-zero can be compared, which is the entire point of taking the zero: `adc_at_zero`
logged over days against a fixed calibration is the drift measurement.

A run with no snapshot behaves exactly as runs did before any of this existed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import numpy as np

from . import config

#: The component this module synthesises, and the two real ones it derives from.
ABSOLUTE_SUFFIX = ".force_kg_absolute"
ZEROED_FIELD = "force_kg"
RAW_FIELD = "raw_adc"


def snapshot_path(run_id: str) -> Path:
    """The zeros standing when the run began.

    A sibling of the run dir, not a file inside it, for the same reason `<run_id>.toml` is one:
    this is written before elodin-db has created the directory.
    """
    return config.ELODIN_DIR / f"{run_id}.lc_zero.json"


def calibration_path(run_id: str) -> Path:
    """The cubic store as the run read it. Without this an archived run's raw codes cannot be
    turned back into kilograms at all — the curve lives nowhere else once it is re-fitted."""
    return config.ELODIN_DIR / f"{run_id}.calibration.json"


def sidecar_path(run_id: str) -> Path:
    """Changes of shift during the run. Inside the run dir, so the run's own deletion takes it."""
    return config.ELODIN_DIR / run_id / "lc_zero.jsonl"


def _read_json(p: Path) -> dict:
    """Missing or malformed -> {}. A viewer must never fail to open a run over its metadata."""
    try:
        with p.open("rb") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def load(run_id: str) -> dict[str, list[tuple[float, float, int]]]:
    """entity -> [(applied_at_seconds, shift_codes, uid), ...] ascending.

    Seeded from the start-of-run snapshot at -inf so samples before the first recorded change are
    still attributed correctly, then extended by the sidecar. In practice the backend writes a
    `set` line for every standing zero at the first poll of a new run — its in-memory map is reset
    at session stop — so the two usually agree; the seed is what covers the gap between the run
    starting and that first poll, and a run whose sidecar never got written at all.
    """
    events: dict[str, list[tuple[float, float, int]]] = {}

    snap = _read_json(snapshot_path(run_id))
    for z in snap.get("zeros", []) or []:
        entity = z.get("entity")
        shift = z.get("shift_codes")
        if not isinstance(entity, str) or not entity:
            continue
        if not isinstance(shift, (int, float)) or not np.isfinite(shift):
            continue
        events.setdefault(entity, []).append((float("-inf"), float(shift), int(z.get("uid") or 0)))

    p = sidecar_path(run_id)
    try:
        text = p.read_text()
    except OSError:
        text = ""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            # A partially-written last line is expected: the file is appended to while the run is
            # live. Everything before it still counts.
            continue
        entity = rec.get("entity")
        shift = rec.get("shiftCodes")
        at = rec.get("appliedAtMs")
        if not isinstance(entity, str) or not entity:
            continue
        if not isinstance(at, (int, float)) or not isinstance(shift, (int, float)):
            continue
        if not np.isfinite(shift):
            continue
        events.setdefault(entity, []).append(
            (float(at) / 1000.0, 0.0 if rec.get("event") == "clear" else float(shift),
             int(rec.get("uid") or 0))
        )

    for entity in events:
        events[entity].sort(key=lambda e: e[0])
    return events


def _uid_for(run_id: str, entity: str) -> int | None:
    """The calibration store is keyed by uid (board_id*100 + connector); the entity string is not.

    They are NOT interchangeable and must never be derived from each other here: the number in
    "LC2_Cal.CH1" is the Elodin slot (board_id % 10), so PT board 22 and LC board 42 both read as
    slot 2. The uid is carried explicitly in the record for exactly this reason.
    """
    for _, _, uid in load(run_id).get(entity, []):
        if uid:
            return uid
    return None


def _curve(run_id: str, uid: int) -> Callable[[np.ndarray], np.ndarray] | None:
    """adc -> kg through the run's own snapshotted calibration, with NO shift applied.

    Mirrors PolynomialCalibration in the calibration service, which is what produced the archived
    kilograms: the normalized polynomial when the store wrote one, else A/B/C/D against the RAW
    code. (The TS evaluator in backend/src/calibration.ts normalizes the input before applying
    A/B/C/D too; that path only matters when polyCoeffs is absent AND a norm is present, which
    the store does not write. Following the service here, because the service is what the numbers
    in the archive came from.)

    None when the run has no snapshot, or the channel has no usable curve — in which case no
    absolute twin is offered rather than a wrong one.
    """
    state = (_read_json(calibration_path(run_id)).get("cubic_state") or {}).get(str(uid))
    if not isinstance(state, dict):
        return None

    poly = state.get("polyCoeffs") or []
    nmin = state.get("adcNormMin")
    nscale = state.get("adcNormScale")
    if poly and isinstance(nscale, (int, float)) and nscale > 0 and isinstance(nmin, (int, float)):
        coeffs = [float(c) for c in poly]

        def _norm(adc: np.ndarray) -> np.ndarray:
            x = (adc - float(nmin)) / float(nscale)
            out = np.zeros_like(x, dtype=float)
            for i, c in enumerate(coeffs):
                out += c * x**i
            return out

        return _norm

    c = state.get("coeffs") or {}
    try:
        a, b, cc, d = (float(c["A"]), float(c["B"]), float(c["C"]), float(c["D"]))
    except (KeyError, TypeError, ValueError):
        return None
    if a == 0.0 and b == 0.0 and cc == 0.0 and d == 0.0:
        return None  # an uncalibrated channel's zeroed curve; nothing to reconstruct

    def _raw(adc: np.ndarray) -> np.ndarray:
        return a * adc**3 + b * adc**2 + cc * adc + d

    return _raw


def absolute_components(run_id: str, components: list[dict]) -> list[dict]:
    """The synthetic component entries to add to an index, one per zeroed load-cell channel.

    Only channels that actually carried a zero during this run get one, and only when the run has
    both a raw_adc trace and a usable snapshotted curve. Offering the twin everywhere would make a
    run with no zero indistinguishable from a zeroed one whose shift happened to be 0, and
    offering it without a curve would mean offering a series that cannot be computed.
    """
    events = load(run_id)
    if not events:
        return []
    have_raw = {
        c.get("entity") for c in components if c.get("field") == RAW_FIELD
    }
    out = []
    for comp in components:
        if comp.get("field") != ZEROED_FIELD:
            continue
        entity = comp.get("entity", "")
        if entity not in events or entity not in have_raw:
            continue
        uid = _uid_for(run_id, entity)
        if uid is None or _curve(run_id, uid) is None:
            continue
        d = dict(comp)
        d["name"] = f"{entity}{ABSOLUTE_SUFFIX}"
        d["field"] = "force_kg_absolute"
        out.append(d)
    return out


def apply_absolute(run_id: str, entity: str, raw: np.ndarray) -> np.ndarray:
    """Raw ADC codes -> the kilograms the channel would have read with no zero applied.

    No step function and no time axis: the shift does not enter at all. `force_kg` in the archive
    is curve(raw - shift); the absolute twin is curve(raw), and the curve is fixed for the run
    because a re-zero never edits the calibration. That invariant is what makes this a one-liner
    instead of a replay.
    """
    uid = _uid_for(run_id, entity)
    if uid is None:
        return np.full(len(raw), np.nan)
    curve = _curve(run_id, uid)
    if curve is None:
        return np.full(len(raw), np.nan)
    return curve(np.asarray(raw, dtype=float))


def shift_at(run_id: str, entity: str, t: np.ndarray) -> np.ndarray:
    """The shift in effect at each sample time, as a step function.

    Not needed to build the absolute series, and deliberately kept anyway: this is the drift
    record. Plotted over a campaign it is the number the re-zero was taken to measure.
    """
    events = load(run_id).get(entity)
    if not events or len(t) == 0:
        return np.zeros(len(t))
    times = np.array([e[0] for e in events], dtype=float)
    shifts = np.array([e[1] for e in events], dtype=float)
    # side="right": a sample exactly at the applied instant already carried the new shift.
    idx = np.searchsorted(times, t, side="right") - 1
    return np.where(idx >= 0, shifts[np.clip(idx, 0, len(shifts) - 1)], 0.0)
