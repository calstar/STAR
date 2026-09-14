"""Units, converted once at the boundary and never again.

Two jobs, and the second is the important one.

**Convert.** A team authors line bores in inches, pressures in psi and valve
capacities in Cv, because that is what the datasheets say. The solver works
entirely in SI. Conversion happens exactly once, when a parameter is read, and
what circulates afterwards is a plain float.

**Catch a dimension error.** Every unit declares what it measures, and every
parameter declares what it expects. A pressure written where a length belongs
fails at load with both names in the message. This is the single cheapest guard
in the package: unit confusion is the most expensive class of mistake in this
field, and it is trivially preventable at a schema boundary.

Deliberately not ``pint``. Unit-carrying objects are the right tool for
interactive analysis and the wrong one for a Newton loop -- a Jacobian assembly
that allocates a Quantity per arithmetic operation is orders of magnitude slower
than the physics it is wrapping. Converting at the boundary gets the safety
where it matters and pays nothing where it does not.

Units are data, like everything else here::

    from feedtwin.model.units import register_unit

    register_unit("furlong", "length", 201.168)
"""

from __future__ import annotations

from dataclasses import dataclass

from fluids.fittings import Kv_to_Cv

#: Cv (US gpm at 1 psi) per Kv (m3/h at 1 bar), from IEC 60534-2-1 via
#: ``fluids``. Taken from the library rather than written as 1.156 so there is
#: one definition of it in the process, and it is the one the valve correlations
#: in Phase 03 will use.
#:
#: Imported from ``fluids.fittings``, where it is defined, rather than from
#: ``fluids.control_valve``, which re-exports it: ``fluids`` ships py.typed, so
#: mypy type-checks against it and rejects an implicit re-export under strict.
_CV_PER_KV = Kv_to_Cv(1.0)

_IN = 0.0254
_PSI = 6894.757293168361
_LBM = 0.45359237
_GAL_US = 3.785411784e-3
_MIN = 60.0


@dataclass(frozen=True, slots=True)
class Unit:
    """A unit, and how to get from it to this package's canonical one.

    ``si = value * factor + offset``. The offset exists for temperature and is
    zero for everything else; keeping it in the general form is cheaper than a
    special case that someone later forgets.
    """

    name: str
    dimension: str
    factor: float
    offset: float = 0.0
    canonical: bool = False
    """Whether this is the spelling :func:`si_unit_of` reports for its
    dimension. Needed only where two units of a dimension have factor 1.0 --
    K and degC differences are the same size -- but declaring it beats
    depending on declaration order, which is not something a reader can see."""

    def to_si(self, value: float) -> float:
        return value * self.factor + self.offset

    def from_si(self, value: float) -> float:
        return (value - self.offset) / self.factor


def _u(
    name: str,
    dimension: str,
    factor: float,
    offset: float = 0.0,
    canonical: bool = False,
) -> Unit:
    return Unit(name, dimension, factor, offset, canonical)


#: Every known unit, keyed by the spelling used in a config file.
#:
#: The canonical unit of each dimension has factor 1.0. Two are not SI and say
#: so: ``Cv`` because the valve correlations take it directly, and ``-`` for
#: dimensionless quantities.
_UNITS: dict[str, Unit] = {
    u.name: u
    for u in [
        # dimensionless
        _u("-", "dimensionless", 1.0),
        _u("%", "dimensionless", 0.01),
        # pressure ratio -- pressure per pressure. Dimensionless by arithmetic
        # and emphatically not by intent: a supply-pressure effect written as a
        # bare 0.017 cannot be checked against the datasheet it came from, and
        # the reader cannot tell 17 psi/1000 psi from 1.7 psi/100 psi from a
        # typo. Its own dimension so that `-` is rejected where one belongs,
        # and so the vendor's own wording is what gets typed in.
        _u("psi/psi", "pressure_ratio", 1.0),
        _u("psi/100psi", "pressure_ratio", 1e-2),
        _u("psi/1000psi", "pressure_ratio", 1e-3),
        _u("psi/kpsi", "pressure_ratio", 1e-3),
        _u("bar/bar", "pressure_ratio", 1.0),
        # length
        _u("m", "length", 1.0),
        _u("mm", "length", 1e-3),
        _u("cm", "length", 1e-2),
        _u("in", "length", _IN),
        _u("ft", "length", 12.0 * _IN),
        # area
        _u("m^2", "area", 1.0),
        _u("mm^2", "area", 1e-6),
        _u("in^2", "area", _IN**2),
        # volume
        _u("m^3", "volume", 1.0),
        _u("L", "volume", 1e-3),
        _u("mL", "volume", 1e-6),
        _u("in^3", "volume", _IN**3),
        _u("gal", "volume", _GAL_US),
        # mass
        _u("kg", "mass", 1.0),
        _u("g", "mass", 1e-3),
        _u("lbm", "mass", _LBM),
        # pressure -- absolute. Gauge pressure is a *reference*, not a unit, and
        # is deliberately absent: "psig" in a config would silently become an
        # absolute pressure one atmosphere too low. Convert before authoring.
        _u("Pa", "pressure", 1.0),
        _u("kPa", "pressure", 1e3),
        _u("MPa", "pressure", 1e6),
        _u("bar", "pressure", 1e5),
        _u("psi", "pressure", _PSI),
        _u("atm", "pressure", 101325.0),
        # temperature
        _u("K", "temperature", 1.0),
        _u("degC", "temperature", 1.0, 273.15),
        _u("degR", "temperature", 5.0 / 9.0),
        # mass flow
        _u("kg/s", "mass_flow", 1.0),
        _u("g/s", "mass_flow", 1e-3),
        _u("lbm/s", "mass_flow", _LBM),
        # volumetric flow
        _u("m^3/s", "volume_flow", 1.0),
        _u("L/s", "volume_flow", 1e-3),
        _u("L/min", "volume_flow", 1e-3 / _MIN),
        _u("gpm", "volume_flow", _GAL_US / _MIN),
        # time
        _u("s", "time", 1.0),
        _u("ms", "time", 1e-3),
        _u("min", "time", _MIN),
        # velocity, density, viscosity
        _u("m/s", "velocity", 1.0),
        _u("ft/s", "velocity", 12.0 * _IN),
        _u("kg/m^3", "density", 1.0),
        _u("g/cm^3", "density", 1e3),
        _u("Pa.s", "viscosity", 1.0),
        _u("cP", "viscosity", 1e-3),
        # temperature *difference*, where degC and K are the same size. A
        # separate dimension so a 20 K rise cannot be written where an absolute
        # temperature belongs, or vice versa.
        # Two spellings of the same size. K_diff is marked canonical so
        # si_unit_of is deterministic; degC_diff exists so a config written in
        # Celsius reads naturally.
        _u("K_diff", "temperature_difference", 1.0, canonical=True),
        _u("degC_diff", "temperature_difference", 1.0),
        # valve capacity. Canonical is Cv, not because it is SI (it is not) but
        # because it is what IEC 60534 sizing takes as input.
        _u("Cv", "flow_coefficient", 1.0),
        _u("Kv", "flow_coefficient", _CV_PER_KV),
        # angle
        _u("rad", "angle", 1.0),
        _u("deg", "angle", 3.141592653589793 / 180.0),
        # rotational / spring
        _u("N/m", "stiffness", 1.0),
        _u("lbf/in", "stiffness", 4.4482216152605 / _IN),
        # thermal
        _u("W", "power", 1.0),
        _u("W/K", "thermal_conductance", 1.0),
        _u("W/(m.K)", "conductivity", 1.0),
        _u("J/(kg.K)", "specific_heat", 1.0),
        _u("J/kg", "specific_energy", 1.0),
    ]
}


class UnknownUnit(KeyError):
    """A unit that is not registered.

    Suggests the nearest registered spellings rather than listing all fifty.
    ``"inches"`` should point at ``"in"``, not bury it in a wall of text --
    the list is what you read when you do not know what exists, and a typo is
    the far more common case.
    """

    def __init__(self, unit: str) -> None:
        import difflib

        close = difflib.get_close_matches(unit, _UNITS, n=3, cutoff=0.4)
        hint = f" Did you mean {', '.join(repr(c) for c in close)}?" if close else ""
        super().__init__(
            f"unknown unit {unit!r}.{hint} "
            "feedtwin.model.units.registered_units() lists them all; "
            "register_unit() adds one."
        )
        self.unit = unit


class DimensionMismatch(ValueError):
    """A value was given in a unit that measures the wrong thing."""

    def __init__(self, *, expected: str, got: str, unit: str, where: str) -> None:
        super().__init__(
            f"{where}: expected a {expected} but {unit!r} is a {got}. "
            "This is a unit error, not a rounding one -- check the source."
        )
        self.expected = expected
        self.got = got


def register_unit(
    name: str,
    dimension: str,
    factor: float,
    offset: float = 0.0,
    canonical: bool = False,
) -> Unit:
    """Add a unit. ``si = value * factor + offset``.

    Replacing an existing name is allowed and deliberate: a project that means
    something specific by a spelling should be able to say so.

    Set ``canonical`` when adding the first unit of a new dimension, or the
    reverse lookup used to label output will have nothing to report.
    """
    unit = Unit(name, dimension, factor, offset, canonical)
    _UNITS[name] = unit
    return unit


def get_unit(name: str) -> Unit:
    try:
        return _UNITS[name]
    except KeyError:
        raise UnknownUnit(name) from None


def registered_units() -> list[str]:
    return sorted(_UNITS)


def dimension_of(unit: str) -> str:
    """What a unit measures: ``"pressure"``, ``"length"``, ..."""
    return get_unit(unit).dimension


def to_si(value: float, unit: str) -> float:
    """Convert into this package's canonical unit for that dimension."""
    return get_unit(unit).to_si(value)


def from_si(value: float, unit: str) -> float:
    """Convert out of canonical units, for display."""
    return get_unit(unit).from_si(value)


def si_unit_of(dimension: str) -> str:
    """The canonical unit name for a dimension, for labelling output.

    Prefers a unit explicitly marked canonical; otherwise the unscaled,
    unoffset one. Both passes are needed: most dimensions have exactly one unit
    with factor 1.0 and need no marking, while a few have two of the same size
    and would otherwise resolve by declaration order.
    """
    for name, unit in _UNITS.items():
        if unit.dimension == dimension and unit.canonical:
            return name
    for name, unit in _UNITS.items():
        if unit.dimension == dimension and unit.factor == 1.0 and unit.offset == 0.0:
            return name
    raise KeyError(
        f"no canonical unit registered for dimension {dimension!r}. Register one "
        "with register_unit(..., factor=1.0, canonical=True)."
    )


def check_dimension(unit: str, expected: str, where: str) -> None:
    """Raise :class:`DimensionMismatch` unless ``unit`` measures ``expected``."""
    actual = dimension_of(unit)
    if actual != expected:
        raise DimensionMismatch(expected=expected, got=actual, unit=unit, where=where)
