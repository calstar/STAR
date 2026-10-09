"""Load-cell tares recorded during a run, and the tared series derived from them.

Elodin records ABSOLUTE force, always and forever — `LC<n>_Cal.CH<c>.force_kg` means the same
thing in every run ever archived, and this feature did not change that. A tare is display state:
the backend subtracts it on the way to the browser and appends what it did to
`<run_dir>/lc_tare.jsonl`, so what the operator was looking at stays reconstructible afterwards.

This module replays that record. It exposes the reconstruction as a synthetic component,
`…force_kg_tared`, rather than as a toggle on the real one. A toggle would be a query parameter
threaded through three independent read paths (series_json, long_csv_rows, wide_csv_rows), and
missing one means the exported CSV disagrees with the plot the operator was looking at. As a
component name there is a single choke point in load_series, and series, both CSV shapes and the
download all follow for free.

The sidecar is append-only, one JSON object per line:

    {"entity":"LC2_Cal.CH1","uid":4201,"event":"set","offsetKg":20.13,
     "adcAtTare":8412331,"setAtMs":...,"appliedAtMs":1757800123456}

`appliedAtMs` is the instant the published stream changed, not when a button was pressed — the
backend writes the line from the same code that changes the subtraction. `event` is "set" (a new
tare), "recal" (a re-fit moved the offset with no operator action) or "clear". A recal line is
load-bearing: ignore it and every reconstruction is wrong from the re-fit onward.

There is no terminal line at session stop, so a tare with no following "clear" was in effect to
the end of the run.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import config

#: The component this module synthesises, and the real one it derives from.
TARED_SUFFIX = ".force_kg_tared"
GROSS_FIELD = "force_kg"


def sidecar_path(run_id: str) -> Path:
    """Inside the run dir, beside the DB — not a sibling like <run_id>.toml.

    That file is a sibling only because it is written before elodin-db creates the directory.
    This one is written mid-run when the directory certainly exists, and living inside it means
    the run's own deletion takes it too, with no orphan class to clean up.
    """
    return config.ELODIN_DIR / run_id / "lc_tare.jsonl"


def load(run_id: str) -> dict[str, list[tuple[float, float]]]:
    """entity -> [(applied_at_seconds, offset_kg), ...] ascending.

    Missing or malformed → {}. A viewer must never fail to open a run over its metadata, and a
    partially-written last line is expected: the file is appended to while the run is live.
    """
    p = sidecar_path(run_id)
    try:
        text = p.read_text()
    except OSError:
        return {}

    events: dict[str, list[tuple[float, float]]] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            # A torn final line is normal mid-run; earlier lines stay usable.
            continue
        entity = rec.get("entity")
        applied = rec.get("appliedAtMs")
        if not isinstance(entity, str) or not isinstance(applied, (int, float)):
            continue
        offset = 0.0 if rec.get("event") == "clear" else rec.get("offsetKg")
        if not isinstance(offset, (int, float)) or not np.isfinite(float(offset)):
            continue
        events.setdefault(entity, []).append((float(applied) / 1000.0, float(offset)))

    for ev in events.values():
        ev.sort(key=lambda e: e[0])
    return events


def tared_components(run_id: str, components: list[dict]) -> list[dict]:
    """The synthetic component entries to add to an index, one per tared LC channel.

    Only channels the sidecar actually names get one. Synthesising a tared twin for every load
    cell would make an untared run indistinguishable from a tared one whose offsets happened to
    be zero — the toggle would be lying about whether a tare existed.
    """
    events = load(run_id)
    if not events:
        return []
    out = []
    for comp in components:
        if comp.get("field") != GROSS_FIELD:
            continue
        entity = comp.get("entity", "")
        if entity not in events:
            continue
        d = dict(comp)
        d["name"] = f"{entity}{TARED_SUFFIX}"
        d["field"] = "force_kg_tared"
        out.append(d)
    return out


def apply(run_id: str, entity: str, t: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Subtract the offset that was in effect at each sample time.

    A step function, not one offset across the whole array: a tare set partway through a run must
    leave everything before it absolute, or the pre-tare portion of every run reads wrong.
    """
    events = load(run_id).get(entity)
    if not events or len(t) == 0:
        return v
    times = np.array([e[0] for e in events], dtype=float)
    offsets = np.array([e[1] for e in events], dtype=float)
    # side="right": a sample exactly at the applied instant already carried the new offset.
    idx = np.searchsorted(times, t, side="right") - 1
    applied = np.where(idx >= 0, offsets[np.clip(idx, 0, len(offsets) - 1)], 0.0)
    return v - applied
