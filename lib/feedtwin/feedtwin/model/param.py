"""A parameter is a record, not a float.

Every number that describes hardware carries where it came from::

    Cv:
      value: 1.2
      unit: Cv
      source: manufacturer
      reference: "Swagelok SS-8BK-V51 datasheet rev C, table 2"
      uncertainty: {kind: relative, value: 0.10}

The value is the least interesting field. What makes a result trustworthy is
knowing which of its inputs were measured on the bench, which came off a
datasheet, and which somebody guessed on a Tuesday -- and today the answer to
that lives in people's heads and evaporates when they graduate.

There is no default for ``source``. Omitting it is a validation error, not a
shrug, because "we don't know where this came from" is exactly the state this
type exists to make impossible. ``DEFAULT`` is available and means something
specific: the library supplied it, and nobody has looked.

Provenance survives into results. A run report can say *this answer rests on
nine measured parameters, four datasheet values and two guesses* -- which is the
difference between a number you can defend in a design review and one you
cannot.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from feedtwin.model.units import get_unit, to_si


class Provenance(Enum):
    """Where a value came from, ordered by how much weight it carries."""

    MEASURED = "measured"
    """Measured on our own hardware. Cite the test in ``reference``."""

    MANUFACTURER = "manufacturer"
    """From a datasheet. Cite the document and revision."""

    ESTIMATED = "estimated"
    """Engineering judgement, a correlation, or a similar part. Say which."""

    DEFAULT = "default"
    """Supplied by this library because nobody specified one. Always suspect."""

    @property
    def rank(self) -> int:
        """Higher is more authoritative. Drives catalog override precedence."""
        return _RANKS[self]

    @property
    def is_assumed(self) -> bool:
        """True for values nobody has actually established."""
        return self in (Provenance.ESTIMATED, Provenance.DEFAULT)


_RANKS: dict[Provenance, int] = {
    Provenance.MEASURED: 3,
    Provenance.MANUFACTURER: 2,
    Provenance.ESTIMATED: 1,
    Provenance.DEFAULT: 0,
}


@dataclass(frozen=True, slots=True)
class Uncertainty:
    """How well a value is known.

    Carried but not yet propagated -- Phase 12 fits parameters against measured
    data and needs a prior, and a sensitivity study needs a range. Recording it
    at authoring time costs nothing; reconstructing it two years later from a
    datasheet nobody kept costs a great deal.
    """

    kind: str  # "relative" | "absolute"
    value: float

    def __post_init__(self) -> None:
        if self.kind not in ("relative", "absolute"):
            raise ValueError(
                f"uncertainty kind must be 'relative' or 'absolute', got {self.kind!r}"
            )
        if self.value < 0.0:
            raise ValueError(f"uncertainty must be non-negative, got {self.value}")

    def bounds(self, si_value: float) -> tuple[float, float]:
        """Low and high bounds around a value already in canonical units."""
        delta = abs(si_value) * self.value if self.kind == "relative" else self.value
        return si_value - delta, si_value + delta

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "value": self.value}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Uncertainty:
        return cls(kind=str(data["kind"]), value=float(data["value"]))


@dataclass(frozen=True, slots=True)
class Param:
    """One authored number, with its unit and its provenance.

    The value is stored **as authored**, in the unit it was written in, and
    converted on demand through :attr:`si`. Keeping the authored form is what
    makes a config round-trip byte-identically: a file written in psi comes back
    in psi rather than as a converted float with a trail of decimals.

    Args:
        value: The number, in ``unit``.
        unit: A registered unit name -- see :mod:`feedtwin.model.units`.
        source: Where it came from. Required.
        reference: The document, test or reasoning behind it. Strongly
            encouraged; a ``MEASURED`` value with no reference is not traceable
            to anything and is only nominally better than a guess.
        uncertainty: How well it is known, if that is established.
    """

    value: float
    unit: str
    source: Provenance
    reference: str = ""
    uncertainty: Uncertainty | None = None

    def __post_init__(self) -> None:
        get_unit(self.unit)  # raises UnknownUnit if the spelling is not registered
        if not isinstance(self.source, Provenance):
            raise TypeError(
                f"source must be a Provenance, got {type(self.source).__name__}. "
                "Every parameter has to say where it came from."
            )

    @property
    def si(self) -> float:
        """The value in this package's canonical unit for its dimension."""
        return to_si(self.value, self.unit)

    @property
    def dimension(self) -> str:
        return get_unit(self.unit).dimension

    def si_bounds(self) -> tuple[float, float] | None:
        """Uncertainty bounds in canonical units, or ``None`` if not stated."""
        if self.uncertainty is None:
            return None
        return self.uncertainty.bounds(self.si)

    def replace(self, **changes: Any) -> Param:
        """A copy with fields changed -- values are immutable by design."""
        from dataclasses import replace as _replace

        return _replace(self, **changes)

    # ------------------------------------------------------------ serialisation

    def to_dict(self) -> dict[str, Any]:
        """A plain-data form that round-trips exactly.

        Empty optional fields are omitted rather than written as nulls, so a
        file stays as terse as it was authored.
        """
        data: dict[str, Any] = {
            "value": self.value,
            "unit": self.unit,
            "source": self.source.value,
        }
        if self.reference:
            data["reference"] = self.reference
        if self.uncertainty is not None:
            data["uncertainty"] = self.uncertainty.to_dict()
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any], where: str = "parameter") -> Param:
        missing = [k for k in ("value", "unit", "source") if k not in data]
        if missing:
            raise ValueError(
                f"{where}: missing required field(s) {', '.join(missing)}. "
                "Every parameter needs a value, a unit and a source -- see "
                "feedtwin.model.param.Provenance for what a source may be."
            )
        try:
            source = Provenance(str(data["source"]))
        except ValueError:
            valid = ", ".join(p.value for p in Provenance)
            raise ValueError(
                f"{where}: {data['source']!r} is not a valid source; use one of {valid}"
            ) from None

        uncertainty = data.get("uncertainty")
        return cls(
            value=float(data["value"]),
            unit=str(data["unit"]),
            source=source,
            reference=str(data.get("reference", "")),
            uncertainty=(
                Uncertainty.from_dict(uncertainty) if uncertainty is not None else None
            ),
        )

    def __str__(self) -> str:
        tail = f" ({self.reference})" if self.reference else ""
        return f"{self.value:g} {self.unit} [{self.source.value}]{tail}"


def provenance_summary(params: dict[str, Param]) -> dict[str, int]:
    """Count parameters by provenance -- the header of a run report.

    Returns a mapping keyed by provenance value, always containing every key so
    a report can render a stable table. ``{"measured": 9, "manufacturer": 4,
    "estimated": 2, "default": 0}`` says more about how much to trust a result
    than any single number in it.
    """
    counts = {p.value: 0 for p in Provenance}
    for param in params.values():
        counts[param.source.value] += 1
    return counts


def assumed_params(params: dict[str, Param]) -> list[str]:
    """Names of every parameter nobody has actually established, sorted.

    What a report should list explicitly. A result standing on twelve guesses is
    not wrong, but it is a different kind of claim from one standing on twelve
    measurements, and the difference should never be invisible.
    """
    return sorted(name for name, p in params.items() if p.source.is_assumed)
