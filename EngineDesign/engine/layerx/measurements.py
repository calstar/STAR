"""Phase 5: what has been measured, put where the assumption used to be.

A drawing carries every number the twin needs, each with a provenance:
* measured;
* manufacturer;
* estimated;
* default.

Most of the numbers that move a burn are the last two, for example the dome
regulator's supply-pressure effect, its droop, the tank walls and the line
fittings. They are not wrong to have, but they are not known.

An **override** replaces one drawing parameter with a stated value and its provenance. That
value is usually measured, with the test named and an uncertainty. It goes into the drawing's
JSON before the twin reads it, so the twin's own assembly report sees a measured number where
an estimate used to be. Nothing downstream knows overrides exist.

Overrides belong to a person and a drawing (by content id). They live in that person's data
directory, never in the drawing itself, because the drawing is the shared hardware record
(ADR-0002). A measurement that should be permanent belongs on the drawing in pid-designer,
with its source.

Engine-side measurements are different: a cold-flow Cd, a patternated E_m, a nozzle
efficiency. They belong to the engine and live in the engine config's ``measurements`` block
(engine/pipeline/measurements.py). The engine card is built from the config with them
applied, so Layer X picks them up without duplicating them here.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

PROVENANCES = ("measured", "manufacturer", "estimated")


@dataclass(frozen=True)
class Override:
    """One drawing parameter, restated."""

    target: str
    """``node:<symbol id>`` or ``edge:<line id>``."""
    parameter: str
    value: float
    unit: str
    source: str
    """Who measured it and how: 'GN2 regulator flow test, 0.1 kg/s steps, 2026-10-04'."""
    provenance: str = "measured"
    uncertainty: Optional[float] = None
    """One standard uncertainty, in ``unit``."""
    date: Optional[str] = None

    def key(self) -> str:
        return f"{self.target}.{self.parameter}"

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Override":
        target = str(raw["target"])
        if not re.fullmatch(r"(node|edge):[^\s]+", target):
            raise ValueError(f"override target {target!r} is not node:<id> or edge:<id>")
        provenance = str(raw.get("provenance") or "measured")
        if provenance not in PROVENANCES:
            raise ValueError(f"provenance {provenance!r}; expected one of {', '.join(PROVENANCES)}")
        source = str(raw.get("source") or "").strip()
        if not source:
            raise ValueError(f"{target}.{raw.get('parameter')}: a restated number needs its source")
        uncertainty = raw.get("uncertainty")
        value = float(raw["value"])
        parameter = str(raw["parameter"])
        if not math.isfinite(value) or (uncertainty not in (None, "") and not math.isfinite(float(uncertainty))):
            raise ValueError(f"{target}.{parameter}: a restated number must be finite")
        # Volumes, lengths, bores, flow coefficients and ratings are not negative; a height is.
        if value < 0 and parameter not in SIGNED_PARAMETERS:
            raise ValueError(f"{target}.{parameter}: {value:g} is negative")
        for name, text, cap in (("parameter", parameter, 60), ("source", source, 300),
                                ("unit", str(raw.get("unit") or ""), 24), ("date", str(raw.get("date") or ""), 40)):
            if len(text) > cap:
                raise ValueError(f"{target}.{parameter}: {name} is longer than {cap} characters")
        return cls(target=target, parameter=parameter, value=value,
                   unit=str(raw.get("unit") or ""), source=source, provenance=provenance,
                   uncertainty=None if uncertainty in (None, "") else abs(float(uncertainty)),
                   date=(str(raw["date"]) if raw.get("date") else None))


#: Parameters that may be negative: a line that climbs from the tank to the injector.
SIGNED_PARAMETERS = frozenset({"elevation_change"})


def _element(payload: Dict[str, Any], target: str) -> Optional[Dict[str, Any]]:
    kind, ident = target.split(":", 1)
    for item in payload.get("nodes" if kind == "node" else "edges") or []:
        if isinstance(item, dict) and str(item.get("id")) == ident:
            return item
    return None


def apply_overrides(payload: Mapping[str, Any], overrides: List[Override]) -> Tuple[Dict[str, Any], List[Dict[str, Any]], List[str]]:
    """A copy of ``payload`` with ``overrides`` written into its parameters.

    Returns ``(payload, applied, missing)``: what was written, as the report shows it, and the
    keys whose element the drawing no longer has (a drawing edited since the measurement was
    entered). Those are reported, not dropped silently.
    """
    out = copy.deepcopy(dict(payload))
    applied: List[Dict[str, Any]] = []
    missing: List[str] = []
    for o in overrides:
        element = _element(out, o.target)
        if element is None:
            missing.append(o.key())
            continue
        data = element.setdefault("data", {})
        params = data.setdefault("params", {})
        before = params.get(o.parameter)
        reference = o.source + (f" ({o.date})" if o.date else "")
        if o.uncertainty is not None:
            reference += f"; ±{o.uncertainty:g} {o.unit}".rstrip()
        params[o.parameter] = {"value": o.value, "unit": o.unit, "source": o.provenance, "reference": reference}
        applied.append({**asdict(o), "key": o.key(),
                        "was": ({"value": before.get("value"), "unit": before.get("unit"),
                                 "source": before.get("source")} if isinstance(before, dict) else None)})
    return out, applied, missing


def parameter_table(payload: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Every parameter on the drawing, as the drawing states it: what a person reviews before
    deciding what to measure next."""
    rows: List[Dict[str, Any]] = []
    for kind, items in (("node", payload.get("nodes") or []), ("edge", payload.get("edges") or [])):
        for item in items:
            if not isinstance(item, dict):
                continue
            data = item.get("data") if isinstance(item.get("data"), dict) else {}
            params = data.get("params") or {}
            if not isinstance(params, dict):
                continue
            label = data.get("label") or item.get("id")
            ctype = data.get("componentType") or item.get("type") or kind
            for name, p in params.items():
                if not isinstance(p, dict) or "value" not in p:
                    continue
                try:
                    value = float(p["value"])
                except (TypeError, ValueError):
                    continue
                rows.append({"target": f"{kind}:{item.get('id')}", "label": label, "type": ctype,
                             "parameter": name, "value": value, "unit": p.get("unit", ""),
                             "source": p.get("source", ""), "reference": p.get("reference", "")})
    return rows


def lineage(drawing: Any) -> str:
    """What stays the same when a drawing is edited: the shipped file or the pid-designer document
    (without its release). An upload has no identity beyond its content: two different files
    uploaded under one name must not share restatements, so an upload's lineage is its content id."""
    source = str(getattr(drawing, "source", "") or "")
    if source.startswith("pid-designer:"):
        return source.split("@", 1)[0]
    if source.startswith("shipped:"):
        return source
    return f"upload:{getattr(drawing, 'id', '')}"


class MeasurementStore:
    """One person's overrides, per drawing, in ``<user dir>/layerx/measurements/<key>.json``.

    Keyed by the drawing's lineage (:func:`lineage`), so restatements carry over when the drawing
    is edited; each file records the revision they were entered against, and an element the new
    revision no longer has is reported by :func:`apply_overrides`, not dropped. A bare content id
    (the old key) is still read."""

    def __init__(self, user_dir: Optional[Path]) -> None:
        self.dir = (user_dir / "layerx" / "measurements") if user_dir is not None else None

    @staticmethod
    def _key(drawing: Any) -> str:
        if isinstance(drawing, str):
            return drawing
        return hashlib.sha256(lineage(drawing).encode("utf-8")).hexdigest()[:16]

    def _path(self, key: str) -> Optional[Path]:
        if self.dir is None or not re.fullmatch(r"[0-9a-f]{16}", key):
            return None
        return self.dir / f"{key}.json"

    def _read(self, drawing: Any) -> Tuple[Optional[Dict[str, Any]], List[str]]:
        keys = [self._key(drawing)]
        if not isinstance(drawing, str):
            keys.append(str(drawing.id))
        for key in keys:
            path = self._path(key)
            if path is None or not path.is_file():
                continue
            try:
                return json.loads(path.read_text()), []
            except (OSError, json.JSONDecodeError) as exc:
                return None, [f"{path.name} could not be read ({type(exc).__name__}); its restatements are not applied"]
        return None, []

    def get(self, drawing: Any) -> List[Override]:
        """``drawing`` is a :class:`~engine.layerx.sources.Drawing` (or, for old callers, its id)."""
        return self.load(drawing)[0]

    def load(self, drawing: Any) -> Tuple[List[Override], List[str], Optional[str]]:
        """``(overrides, problems, revision)``: what is restated, what could not be read, and the
        sha256 of the drawing they were entered against."""
        raw, problems = self._read(drawing)
        if raw is None:
            return [], problems, None
        out = []
        for item in raw.get("overrides", []):
            try:
                out.append(Override.from_dict(item))
            except (KeyError, TypeError, ValueError) as exc:
                problems.append(f"{item.get('target')}.{item.get('parameter')}: {exc}; not applied")
        return out, problems, raw.get("drawing_sha256")

    def put(self, drawing: Any, overrides: List[Override]) -> None:
        path = self._path(self._key(drawing))
        if path is None:
            raise ValueError("no place to keep measurements for this drawing")
        path.parent.mkdir(parents=True, exist_ok=True)
        keys = [o.key() for o in overrides]
        if len(keys) != len(set(keys)):
            raise ValueError("two overrides for the same parameter")
        record: Dict[str, Any] = {"updated": time.time(), "overrides": [asdict(o) for o in overrides]}
        if not isinstance(drawing, str):
            record.update({"lineage": lineage(drawing), "drawing_id": drawing.id, "drawing_sha256": drawing.sha256})
        path.write_text(json.dumps(record, indent=1))
