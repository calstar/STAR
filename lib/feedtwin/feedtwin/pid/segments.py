"""Read a line's segment list off a P&ID edge.

`pid-designer` writes ``data.segments`` on an edge: the run broken into
segments, each with a tube size, a bore, a developed length and a counted list
of fittings. Until this module existed the reader stopped at ``data.params``, so
an itemised line arrived at the solver as an *unstated* one and got a default
with a shrug -- while the drawing's own editor was greying out the line-level
``Length`` and ``Bore`` fields and saying "superseded by the segments below".
The field marked superseded was the only one being read.

The shapes are :mod:`feedtwin.model.segments`, which is also where the physics
of the thing is written down. This module is only the boundary: JSON in,
provenance checked, dataclasses out.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from feedtwin.model import Param, Provenance
from feedtwin.model.curve import Curve, CurveError
from feedtwin.model.segments import (
    DEFAULT_METHOD,
    LOSS_METHODS,
    Fitting,
    LineLoss,
    LineSegment,
)
from feedtwin.pid.errors import DiagramError

_PROVENANCE = {p.value: p for p in Provenance}

#: Length bases the drawing may declare. Anything else is read as ``"tube"``,
#: which is the conservative reading: it subtracts nothing, so it can only
#: over-count length, never invent tube that is not there.
_BASES = frozenset({"tube", "overall"})


def read_segments(raw: Any, where: str) -> LineLoss:
    """Read ``data.segments`` off an edge.

    Absent, empty or malformed gives an empty :class:`LineLoss`, which the
    caller reads as "this line says nothing" and falls back to the line-level
    parameters -- the behaviour every existing drawing already gets.

    Raises:
        DiagramError: a segment states a value with no recognised provenance.
            Same contract as the reader's own parameters, and for the same
            reason: a number whose source is unrecognised means the document
            came from something other than this drawing tool, and quietly
            defaulting it turns a format mismatch into a figure nobody checked.
    """
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return LineLoss()

    segments: list[LineSegment] = []
    warnings: list[str] = []
    known = _known_fittings()

    for index, entry in enumerate(raw):
        if not isinstance(entry, Mapping):
            continue
        seg_id = str(entry.get("id", "") or f"s{index + 1}")
        place = f"{where} segment {seg_id}"

        method = str(entry.get("method") or DEFAULT_METHOD)
        if method not in LOSS_METHODS:
            warnings.append(
                f"{place}: loss method {method!r} is not one of "
                f"{', '.join(LOSS_METHODS)}; read as {DEFAULT_METHOD!r}"
            )
            method = DEFAULT_METHOD

        fittings, fitting_warnings = _fittings(entry.get("fittings"), place, known)
        warnings.extend(fitting_warnings)

        basis = str(entry.get("lengthBasis") or "tube")
        segment = LineSegment(
            id=seg_id,
            method=method,
            bore=_param(entry.get("bore"), "bore", place),
            length=_param(entry.get("length"), "length", place),
            roughness=_param(entry.get("roughness"), "roughness", place),
            elevation_change=_param(
                entry.get("elevation_change"), "elevation_change", place
            ),
            K=_param(entry.get("K"), "K", place),
            length_basis=basis if basis in _BASES else "tube",
            tube_size=str(entry.get("tubeSize", "") or ""),
            standard=str(entry.get("standard", "") or ""),
            fittings=fittings,
            curve=_curve(entry.get("curve"), place, warnings),
        )
        warnings.extend(_check(segment, basis, place))
        segments.append(segment)

    return LineLoss(segments=tuple(segments), warnings=tuple(warnings))


def _check(segment: LineSegment, basis: str, place: str) -> list[str]:
    """What the drawing said that will not survive contact with the solver.

    Every one of these is a case where the segment still produces a number --
    the point is that the number is not the one the drawing appears to promise,
    so it is said out loud rather than absorbed.
    """
    out: list[str] = []
    if basis == "overall" and segment.fittings:
        if any(f.length <= 0.0 for f in segment.fittings):
            out.append(
                f"{place}: length is end-to-end but a fitting states no body "
                "length, so the tube length cannot be worked out; the stated "
                "length is used whole and those fittings are counted twice"
            )
        elif segment.tube_length() <= 0.0:
            out.append(
                f"{place}: the fitting bodies are as long as the run, leaving "
                "no tube; friction on this segment is zero and only the "
                "fittings contribute"
            )
    if segment.method == "curve" and not segment.has_curve:
        out.append(
            f"{place}: declares a measured curve but carries no usable points; "
            "it falls back down the ladder"
        )
    if segment.method == "measured_K" and segment.K is None:
        out.append(
            f"{place}: declares a measured K but states no K; it falls back "
            "down the ladder"
        )
    if segment.method == "lumped_K" and segment.K is None:
        out.append(f"{place}: declares a lumped K but states no K; it is unstated")
    if segment.method == "itemised":
        if segment.length is None:
            out.append(
                f"{place}: itemised but states no length, so it contributes "
                "its fittings and no pipe friction"
            )
        if segment.bore is None:
            out.append(
                f"{place}: itemised but states no bore, so neither its friction "
                "nor its fittings can be sized; it contributes nothing"
            )
    return out


def _curve(raw: Any, where: str, warnings: list[str]) -> Curve | None:
    """A ``{mdot, mdotUnit, dp, dpUnit}`` table, or None.

    A curve is the top of the ladder, so a malformed one is *not* silently
    dropped to a lower rung -- it is reported, and then dropped, because a run
    somebody flowed and recorded badly is a thing to go and fix rather than to
    quietly replace with a correlation.
    """
    if not isinstance(raw, Mapping):
        return None
    x, y = _floats(raw.get("mdot")), _floats(raw.get("dp"))
    if not x or not y:
        return None
    try:
        return Curve(
            x=tuple(x),
            y=tuple(y),
            x_unit=str(raw.get("mdotUnit", "kg/s") or "kg/s"),
            y_unit=str(raw.get("dpUnit", "Pa") or "Pa"),
            # A curve came off a flow bench by definition -- that is what makes
            # it a curve rather than an estimate.
            source=Provenance.MEASURED,
            reference=str(raw.get("reference", "") or ""),
        )
    except (CurveError, TypeError, ValueError) as exc:
        warnings.append(f"{where}: the measured curve cannot be read ({exc})")
        return None


def _param(entry: Any, name: str, where: str) -> Param | None:
    """One ``{value, unit, source, reference}`` block, or None if unstated."""
    if not isinstance(entry, Mapping) or entry.get("value") is None:
        return None
    source = str(entry.get("source", ""))
    if source not in _PROVENANCE:
        raise DiagramError(
            f"{where}: {name} has source {source!r}; expected one of "
            f"{', '.join(sorted(_PROVENANCE))}"
        )
    try:
        return Param(
            value=float(entry["value"]),
            unit=str(entry.get("unit", "-")),
            source=_PROVENANCE[source],
            reference=str(entry.get("reference", "")),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise DiagramError(f"{where}: {name} is malformed ({exc})")


def _fittings(
    raw: Any, where: str, known: frozenset[str]
) -> tuple[tuple[Fitting, ...], list[str]]:
    out: list[Fitting] = []
    warnings: list[str] = []
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return (), warnings
    for entry in raw:
        if not isinstance(entry, Mapping):
            continue
        kind = str(entry.get("kind", "")).strip()
        if not kind:
            continue
        count = _count(entry.get("count"))
        if kind not in known:
            warnings.append(
                f"{where}: fitting {kind!r} is not one this library can price; "
                "it is carried through but contributes no loss"
            )
        if count == 0:
            continue
        out.append(
            Fitting(
                kind=kind,
                count=count,
                # Millimetres on the wire: these are catalogue numbers, which
                # the drawing stores as plain mm rather than as provenanced
                # parameters, because they come from the part and not from
                # anyone's judgement.
                bore=_mm(entry.get("boreMm")),
                length=_mm(entry.get("lengthMm")),
                engagement=_mm(entry.get("engagementMm")),
                K=_plain(entry.get("K")),
            )
        )
    return tuple(out), warnings


def _count(value: Any) -> int:
    try:
        return max(int(value), 0) if value is not None else 1
    except (TypeError, ValueError):
        return 1


def _mm(value: Any) -> float:
    try:
        return float(value) / 1000.0 if value is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _plain(value: Any) -> float:
    if isinstance(value, Mapping):
        value = value.get("value")
    try:
        return float(value) if value is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _floats(raw: Any) -> list[float]:
    """A list of numbers, or nothing. One bad entry voids the list.

    Half a curve is not a curve -- interpolating across a hole in it would put
    a straight line through whatever the drawing failed to record.
    """
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return []
    out: list[float] = []
    for value in raw:
        try:
            out.append(float(value))
        except (TypeError, ValueError):
            return []
    return out


def _known_fittings() -> frozenset[str]:
    # Imported here rather than at module scope: feedtwin.comps pulls in
    # CoolProp, and feedtwin.pid.document is imported by tools that only want
    # to read a drawing.
    from feedtwin.comps.correlations import registered_fittings

    return frozenset(registered_fittings())
