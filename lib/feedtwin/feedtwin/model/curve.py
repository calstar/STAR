"""Tabulated data: the parameters that are not single numbers.

A :class:`Param` covers a scalar. Real hardware also comes with curves --
a valve's Cv against stem position, a pump's head against flow, and above all a
measured pressure drop against mass flow, which is what a cold-flow test
produces and what supersedes every correlation in this package.

Same rules as a scalar: units are declared and converted once, provenance is
mandatory, and interpolation **refuses outside the measured range** rather than
extrapolating. An extrapolated measurement carries a measurement's authority and
a guess's accuracy, which is the worst of both.

Discovered in Phase 03 rather than designed in Phase 02: the need only became
concrete once components had to accept a measured Δp table. It is a small,
additive extension -- :class:`ComponentInstance` grew a ``curves`` field
alongside ``params`` -- and nothing that existed had to change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

from feedtwin.model.param import Provenance
from feedtwin.model.units import check_dimension, dimension_of, si_unit_of, to_si


class CurveError(ValueError):
    """A curve is malformed, or was asked for a point it does not cover."""


@dataclass(frozen=True, slots=True)
class Curve:
    """One tabulated relationship, stored as authored and evaluated in SI.

    Args:
        x: Independent values, strictly increasing, in ``x_unit``.
        y: Dependent values, same length, in ``y_unit``.
        x_unit, y_unit: Registered unit names.
        source: Where the curve came from. Required, like any parameter.
        reference: The test or document behind it.
        extrapolate: Whether to hold the end values outside the range instead of
            raising. Off by default and rarely right; a valve curve that stops at
            90% travel genuinely does not say what happens at 100%.
    """

    x: tuple[float, ...]
    y: tuple[float, ...]
    x_unit: str
    y_unit: str
    source: Provenance
    reference: str = ""
    extrapolate: bool = False

    def __post_init__(self) -> None:
        if len(self.x) != len(self.y):
            raise CurveError(
                f"x has {len(self.x)} points and y has {len(self.y)}; they must match"
            )
        if len(self.x) < 2:
            raise CurveError("a curve needs at least two points")
        if not all(b > a for a, b in zip(self.x, self.x[1:])):
            raise CurveError("x must be strictly increasing")
        if not isinstance(self.source, Provenance):
            raise TypeError("a curve must say where it came from, like any parameter")
        dimension_of(self.x_unit)
        dimension_of(self.y_unit)

    @property
    def x_si(self) -> tuple[float, ...]:
        return tuple(to_si(v, self.x_unit) for v in self.x)

    @property
    def y_si(self) -> tuple[float, ...]:
        return tuple(to_si(v, self.y_unit) for v in self.y)

    @property
    def x_range_si(self) -> tuple[float, float]:
        xs = self.x_si
        return xs[0], xs[-1]

    def __call__(self, x_si: float) -> float:
        """Interpolate at a point given in canonical units.

        Linear between points. Higher-order interpolation of sparse measured
        data invents structure that was never measured, which matters more here
        than smoothness does.
        """
        low, high = self.x_range_si
        if not low <= x_si <= high:
            if not self.extrapolate:
                raise CurveError(
                    f"{x_si:.6g} {si_unit_of(dimension_of(self.x_unit))} is outside "
                    f"the curve's range ({low:.6g} to {high:.6g}). It was measured "
                    "over that interval and says nothing beyond it."
                )
            x_si = min(max(x_si, low), high)
        return float(np.interp(x_si, self.x_si, self.y_si))

    def check_dimensions(self, x_dimension: str, y_dimension: str, where: str) -> None:
        """Raise unless the axes measure what a component expects."""
        check_dimension(self.x_unit, x_dimension, f"{where} (x axis)")
        check_dimension(self.y_unit, y_dimension, f"{where} (y axis)")

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "x": list(self.x),
            "y": list(self.y),
            "x_unit": self.x_unit,
            "y_unit": self.y_unit,
            "source": self.source.value,
        }
        if self.reference:
            data["reference"] = self.reference
        if self.extrapolate:
            data["extrapolate"] = True
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any], where: str = "curve") -> Curve:
        missing = [k for k in ("x", "y", "x_unit", "y_unit", "source") if k not in data]
        if missing:
            raise CurveError(f"{where}: missing {', '.join(missing)}")
        try:
            source = Provenance(str(data["source"]))
        except ValueError:
            valid = ", ".join(p.value for p in Provenance)
            raise CurveError(
                f"{where}: {data['source']!r} is not a valid source; use one of {valid}"
            ) from None
        return cls(
            x=tuple(float(v) for v in data["x"]),
            y=tuple(float(v) for v in data["y"]),
            x_unit=str(data["x_unit"]),
            y_unit=str(data["y_unit"]),
            source=source,
            reference=str(data.get("reference", "")),
            extrapolate=bool(data.get("extrapolate", False)),
        )


@dataclass(frozen=True, slots=True)
class CurveSpec:
    """A curve a component accepts, declared alongside its parameters."""

    name: str
    x_dimension: str
    y_dimension: str
    description: str
    required: bool = False
    models: tuple[str, ...] = ()

    def applies_to(self, model: str) -> bool:
        return not self.models or model in self.models


def curve_from_points(
    x: Sequence[float],
    y: Sequence[float],
    *,
    x_unit: str,
    y_unit: str,
    reference: str,
    source: Provenance = Provenance.MEASURED,
) -> Curve:
    """Build a measured curve. What a test-data reader produces."""
    return Curve(
        x=tuple(float(v) for v in x),
        y=tuple(float(v) for v in y),
        x_unit=x_unit,
        y_unit=y_unit,
        source=source,
        reference=reference,
    )
