"""Measured data as a property source.

The point of this backend is that it sits *in front of* an equation of state and
covers only the region you actually measured. Inside that region your numbers
win; outside it, it raises :class:`OutOfRange` and the fluid's chain falls
through to the equation of state. Nobody writes the "do we have data here?"
branch, because the chain already is that branch::

    tab = TabulatedProperties(
        p=[...], T=[...], values={"rho": rho_grid}, source="CF-2026-03"
    )
    n2 = Fluid("nitrogen", chain=[tab, "bicubic", "heos"])

This is the property-layer half of a principle that runs through the whole
project (Decision 02 in the plan): anything modelled can be replaced by
something measured, with the provenance recorded. It is here in Phase 01 rather
than bolted on at Phase 12 because a seam added after the fact is a seam every
existing call site has to be audited against.

A blended fluid -- a real ullage of pressurant over propellant vapour -- is a
mixture, not a table, and belongs to a mixture backend rather than to this one.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Mapping, Sequence

import threading

import numpy as np
from scipy.interpolate import RegularGridInterpolator

from feedtwin.props.backend import StatePair
from feedtwin.props.errors import OutOfRange, UnsupportedProperty
from feedtwin.props.state import PROPERTIES, Phase

if TYPE_CHECKING:  # pragma: no cover - types only
    from feedtwin.props.species import SpeciesSpec


class TabulatedProperties:
    """Properties read from a measured grid over pressure and temperature.

    Args:
        p: Strictly increasing pressures [Pa].
        T: Strictly increasing temperatures [K].
        values: Property name to a ``(len(p), len(T))`` array of values, in the
            SI units :data:`feedtwin.props.state.PROPERTIES` declares.
        source: Where the numbers came from -- a test campaign, a datasheet
            revision. Carried into every :class:`ThermoState` this produces, so
            a result can always be traced to the measurement behind it.
        name: Backend identifier; defaults to ``"measured"``.

    Only ``StatePair.PT`` is addressable. Any other pair raises
    :class:`OutOfRange`, which the chain answers by trying the next backend --
    the same path as a state point outside the grid.
    """

    def __init__(
        self,
        p: Sequence[float],
        T: Sequence[float],
        values: Mapping[str, Any],
        *,
        source: str,
        name: str = "measured",
    ) -> None:
        self._p = np.asarray(p, dtype=float)
        self._T = np.asarray(T, dtype=float)
        self._name = name
        self.source = source

        _require_increasing(self._p, "p")
        _require_increasing(self._T, "T")

        unknown = sorted(set(values) - set(PROPERTIES))
        if unknown:
            raise ValueError(
                f"{unknown} are not registered properties. Register them with "
                "feedtwin.props.register_property() first, so their units are "
                "declared somewhere."
            )

        shape = (self._p.size, self._T.size)
        self._interp: dict[str, RegularGridInterpolator] = {}
        for prop, grid in values.items():
            array = np.asarray(grid, dtype=float)
            if array.shape != shape:
                raise ValueError(
                    f"{prop!r} has shape {array.shape}, expected {shape} "
                    "= (len(p), len(T))"
                )
            # bounds_error: outside the measured box we must *refuse*, not
            # extrapolate. Extrapolated measurements are the worst of both --
            # they carry a measurement's authority and a guess's accuracy.
            self._interp[prop] = RegularGridInterpolator(
                (self._p, self._T), array, bounds_error=True
            )

        # Thread-local cursor. Unlike the CoolProp backends, one instance of
        # this is shared across threads -- a Fluid cannot rebuild it per thread
        # because it is parameterised by megabytes of measured data rather than
        # by a species name. The grids are read-only after construction, so
        # confining just the cursor is enough to make sharing safe.
        self._cursor = threading.local()

    @property
    def name(self) -> str:
        return self._name

    def supports(self, prop: str) -> bool:
        return prop in self._interp

    def update(self, pair: StatePair, v1: float, v2: float) -> None:
        if pair is not StatePair.PT:
            raise OutOfRange(
                self._name,
                "tabulated",
                f"only PT is addressable, got {pair.value}",
            )
        if not (self._p[0] <= v1 <= self._p[-1] and self._T[0] <= v2 <= self._T[-1]):
            raise OutOfRange(
                self._name,
                "tabulated",
                f"p={v1:.6g} Pa, T={v2:.6g} K outside the measured grid "
                f"({self._p[0]:.4g}-{self._p[-1]:.4g} Pa, "
                f"{self._T[0]:.4g}-{self._T[-1]:.4g} K)",
            )
        self._cursor.point = (v1, v2)

    def value(self, prop: str) -> float:
        point: tuple[float, float] | None = getattr(self._cursor, "point", None)
        if point is None:
            raise RuntimeError("update() must be called before value() in this thread")
        interp = self._interp.get(prop)
        if interp is None:
            raise UnsupportedProperty(self._name, prop)
        if prop == "p":
            return point[0]
        if prop == "T":
            return point[1]
        return float(interp(np.asarray([point]))[0])

    def phase(self) -> Phase:
        """Unknown: a measured grid does not carry phase information.

        Reported honestly rather than guessed. A caller that needs the phase
        gets it from an equation-of-state backend, which is what the chain is
        for.
        """
        return Phase.UNKNOWN

    def quality(self) -> float | None:
        return None


def _require_increasing(values: Any, label: str) -> None:
    if values.ndim != 1 or values.size < 2:
        raise ValueError(f"{label} must be a 1-D array of at least two values")
    if not bool(np.all(np.diff(values) > 0)):
        raise ValueError(f"{label} must be strictly increasing")


def tabulated_from_spec(species: SpeciesSpec) -> TabulatedProperties:
    """Build a tabulated backend from ``[species.options.measured]`` in TOML.

    Lets a species declare its measured data in the species table rather than
    only in code::

        [nitrogen.options.measured]
        path = "data/n2_coldflow.npz"
        source = "CF-2026-03"

    The ``.npz`` must hold ``p`` and ``T`` arrays plus one array per property.
    """
    options = species.options.get("measured")
    if not isinstance(options, dict) or "path" not in options:
        raise UnsupportedProperty(
            "measured", f"species {species.name!r} declares no measured data"
        )

    with np.load(str(options["path"])) as data:
        arrays = {k: data[k] for k in data.files}

    p = arrays.pop("p")
    T = arrays.pop("T")
    return TabulatedProperties(
        p, T, arrays, source=str(options.get("source", options["path"]))
    )
