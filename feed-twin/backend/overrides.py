"""Operator overrides on an imported drawing, and what the console shows.

A drawing comes from pid-designer and is stored by the hash of its bytes, so it
cannot be edited here without becoming a different drawing. But the person at
the stand often knows a number the drawing does not -- the bottle was weighed,
the regulator was re-set -- and making them round-trip through pid-designer to
try it is the five-step loop the import panel exists to remove.

So an override is a **layer**, not an edit. It sits beside the library, is
applied to the drawing at assembly, and is reported on the assembly as what it
is: a value somebody typed, with the provenance they gave it, their name and
the time. The drawing's own value is kept beside it, so

* reverting is deleting the override, and
* a re-import that changed a value somebody had overridden is visible -- the
  override records what the drawing said when it was made (``was``), and the
  drawing view flags it when the drawing now says something else.

Overrides are keyed by the drawing's **name**, not its artifact id. A re-import
of the same drawing is new bytes and a new id; tying overrides to the id would
lose them every time somebody pulled the working copy, which is constantly.

The same store keeps which symbols the console hides. That is shared too: the
console is what the stand team looks at, and "who hid PT-FUEL-2" should have
one answer for everyone, not one per browser.

No overrides means the drawing is returned unchanged -- the same object -- so
everything downstream is exactly what it was before this module existed.
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from feedtwin.model.param import Param, Provenance
from feedtwin.model.units import get_unit
from feedtwin.pid import Diagram

#: Provenances an operator may give an override. ``default`` is refused: it
#: means "the library supplied this because nobody did", and a typed number is
#: by definition somebody.
OVERRIDE_SOURCES = ("measured", "manufacturer", "estimated")

#: Line parameters an itemised run replaces. Overriding one on a line that has
#: segments would be silently ignored by the build, so it is refused instead.
SUPERSEDED_BY_SEGMENTS = frozenset({"length", "bore", "K_minor"})


class OverrideError(ValueError):
    """The override could not be stored, naming why."""


@dataclass(frozen=True, slots=True)
class Applied:
    """One override that took effect on an assembly."""

    element: str
    parameter: str
    value: float
    unit: str
    source: str
    reference: str
    by: str
    at: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class OverrideStore:
    """A JSON file of per-drawing overrides and console visibility.

    Shape::

        {"<drawing name>": {
            "params": {"<element id>": {"<param>": {
                "value", "unit", "source", "reference", "by", "at",
                "was": {"value", "unit", "source"} | null}}},
            "console_hidden": {"<element id>": {"by", "at"}}}}
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    # ------------------------------------------------------------- the file

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise OverrideError(
                f"the override store at {self.path} is not readable ({exc}). "
                "It is plain JSON; fix or delete it -- deleting reverts every "
                "drawing to what it says."
            ) from exc
        return raw if isinstance(raw, dict) else {}

    def _write(self, data: Mapping[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(data, indent=1, sort_keys=True), "utf-8")
        temporary.replace(self.path)

    def entry(self, drawing: str) -> dict[str, Any]:
        found = self._read().get(drawing) or {}
        return {
            "params": dict(found.get("params") or {}),
            "console_hidden": dict(found.get("console_hidden") or {}),
        }

    def _update(self, drawing: str, change: Any) -> dict[str, Any]:
        with self._lock:
            data = self._read()
            entry = self.entry(drawing)
            change(entry)
            # An emptied entry is removed, so a drawing with nothing overridden
            # reads exactly as one that never had anything.
            entry = {k: v for k, v in entry.items() if v}
            if entry:
                data[drawing] = entry
            else:
                data.pop(drawing, None)
            self._write(data)
            return self.entry(drawing)

    # --------------------------------------------------------------- params

    def set_param(
        self,
        drawing: str,
        element: str,
        parameter: str,
        *,
        value: float,
        unit: str,
        source: str,
        reference: str,
        by: str,
        was: Param | None,
    ) -> dict[str, Any]:
        if source not in OVERRIDE_SOURCES:
            raise OverrideError(
                f"source must be one of {', '.join(OVERRIDE_SOURCES)}, not "
                f"{source!r}. Say where the number came from."
            )
        if not reference.strip():
            raise OverrideError(
                "an override needs a reference -- the gauge, the datasheet, the "
                "reasoning. A number with no reference is a guess nobody can "
                "check later."
            )
        try:
            get_unit(unit)
        except Exception as exc:  # UnknownUnit, but the message is the point
            raise OverrideError(f"unit {unit!r} is not a known unit ({exc})") from exc
        if not isinstance(value, (int, float)) or value != value:
            raise OverrideError(f"value must be a number, got {value!r}")

        record = {
            "value": float(value),
            "unit": unit,
            "source": source,
            "reference": reference.strip(),
            "by": by,
            "at": _now(),
            "was": (
                {"value": was.value, "unit": was.unit, "source": was.source.value}
                if was is not None
                else None
            ),
        }

        def change(entry: dict[str, Any]) -> None:
            entry["params"].setdefault(element, {})[parameter] = record

        return self._update(drawing, change)

    def clear_param(self, drawing: str, element: str, parameter: str) -> dict[str, Any]:
        def change(entry: dict[str, Any]) -> None:
            own = entry["params"].get(element) or {}
            own.pop(parameter, None)
            if own:
                entry["params"][element] = own
            else:
                entry["params"].pop(element, None)

        return self._update(drawing, change)

    # -------------------------------------------------------------- console

    def set_console_hidden(
        self, drawing: str, element: str, hidden: bool, *, by: str
    ) -> dict[str, Any]:
        def change(entry: dict[str, Any]) -> None:
            if hidden:
                entry["console_hidden"][element] = {"by": by, "at": _now()}
            else:
                entry["console_hidden"].pop(element, None)

        return self._update(drawing, change)


# ---------------------------------------------------------------- applying


def apply_overrides(
    diagram: Diagram, entry: Mapping[str, Any]
) -> tuple[Diagram, tuple[Applied, ...]]:
    """The drawing with its overrides in, and the list of what went in.

    An override naming a symbol or line the drawing no longer has is skipped,
    not an error: the drawing was re-imported without it, and the drawing view
    lists it as orphaned so somebody can clear it.

    Returns the *same* diagram object when nothing applies.
    """
    params = entry.get("params") or {}
    if not params:
        return diagram, ()

    applied: list[Applied] = []

    def overlay(element: str, current: Mapping[str, Param]) -> Mapping[str, Param]:
        own = params.get(element) or {}
        if not own:
            return current
        merged = dict(current)
        for name, o in sorted(own.items()):
            merged[name] = Param(
                float(o["value"]),
                str(o["unit"]),
                Provenance(o["source"]),
                f"override by {o.get('by') or 'unknown'} at {o.get('at', '')}: "
                f"{o.get('reference', '')}",
            )
            applied.append(
                Applied(
                    element=element,
                    parameter=name,
                    value=float(o["value"]),
                    unit=str(o["unit"]),
                    source=str(o["source"]),
                    reference=str(o.get("reference", "")),
                    by=str(o.get("by", "")),
                    at=str(o.get("at", "")),
                )
            )
        return merged

    nodes = tuple(
        replace(n, params=overlay(n.id, n.params)) if n.id in params else n
        for n in diagram.nodes
    )
    edges = tuple(
        (
            replace(e, params=overlay(e.id, e.params))
            if e.id in params
            and not (e.segments.segments and SUPERSEDED_BY_SEGMENTS & set(params[e.id]))
            else e
        )
        for e in diagram.edges
    )
    if not applied:
        return diagram, ()
    return replace(diagram, nodes=nodes, edges=edges), tuple(applied)


def fingerprint(applied: tuple[Applied, ...]) -> str:
    """A short hash of what took effect, so a stand can say it is out of date.

    Who and when are left out: the same numbers re-entered by somebody else
    build the same stand.
    """
    if not applied:
        return ""
    key = json.dumps(
        sorted((a.element, a.parameter, a.value, a.unit, a.source) for a in applied)
    )
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
