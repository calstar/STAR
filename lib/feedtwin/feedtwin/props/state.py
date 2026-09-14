"""What a property query returns, and the registry of what can be asked for.

Two things live here, and they are deliberately the same concept seen twice:

* :data:`PROPERTIES` -- the registry of every quantity the layer can produce.
  Adding one is a single entry here plus a line in whichever backends can
  compute it. Nothing else in the codebase enumerates properties.
* :class:`ThermoState` -- an eager, immutable snapshot at one state point.

**Everything is SI.** Pa, K, kg/m3, Pa.s, J/kg, J/(kg.K), W/(m.K), m/s. There is
no unit handling inside the solver; conversion happens once at the schema
boundary (Phase 02). A number that reaches this module is already SI.

Why the snapshot is eager
-------------------------
The obvious cheaper design is lazy: hold the backend and fetch properties on
demand. It is a trap. Backend handles are mutable and reused -- a second query
re-points the same handle -- so a lazily-evaluated state would silently answer
with a *later* state point's numbers. Every field is therefore read before the
snapshot is returned.

That costs about eight backend reads where the solver's hot path needs one, so
the hot path does not use snapshots at all: :meth:`Fluid.get` fetches a single
property. :meth:`Fluid.state` is for reporting, diagnostics and frames.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Phase(Enum):
    """Fluid phase, independent of any backend's integer encoding.

    Backends map their own constants onto this so that nothing above the
    property layer imports a CoolProp enum -- the point of ADR-0001's boundary
    is that swapping an equation-of-state library is a change inside
    ``props/backends/``, not a change everywhere ``phase == 6`` was written.
    """

    LIQUID = "liquid"
    GAS = "gas"
    TWO_PHASE = "two_phase"
    SUPERCRITICAL = "supercritical"
    SUPERCRITICAL_GAS = "supercritical_gas"
    SUPERCRITICAL_LIQUID = "supercritical_liquid"
    CRITICAL_POINT = "critical_point"
    UNKNOWN = "unknown"

    @property
    def is_two_phase(self) -> bool:
        return self is Phase.TWO_PHASE

    @property
    def is_liquid_like(self) -> bool:
        """Liquid or supercritical-liquid: dense, effectively incompressible.

        Used to pick correlations -- single-phase liquid pressure drop applies
        to a supercritical liquid too, and asking ``phase is Phase.LIQUID``
        alone would silently route a supercritical LOX line down the gas path.
        """
        return self in (Phase.LIQUID, Phase.SUPERCRITICAL_LIQUID)


@dataclass(frozen=True, slots=True)
class PropertySpec:
    """One queryable quantity: its SI unit and what it means."""

    name: str
    unit: str
    description: str


def _spec(name: str, unit: str, description: str) -> tuple[str, PropertySpec]:
    return name, PropertySpec(name, unit, description)


#: Every quantity the property layer can produce, keyed by name.
#:
#: This registry is the extension point: a backend advertises which of these it
#: implements, and :meth:`Fluid.get` accepts any name in here. Adding a property
#: means adding an entry plus its getter in the backends that can supply it --
#: no signature anywhere else changes.
PROPERTIES: dict[str, PropertySpec] = dict(
    [
        _spec("p", "Pa", "Pressure"),
        _spec("T", "K", "Temperature"),
        _spec("rho", "kg/m^3", "Mass density"),
        _spec("h", "J/kg", "Specific enthalpy"),
        _spec("s", "J/(kg.K)", "Specific entropy"),
        _spec("u", "J/kg", "Specific internal energy"),
        _spec("cp", "J/(kg.K)", "Specific heat at constant pressure"),
        _spec("cv", "J/(kg.K)", "Specific heat at constant volume"),
        _spec("mu", "Pa.s", "Dynamic viscosity"),
        _spec("k", "W/(m.K)", "Thermal conductivity"),
        _spec("a", "m/s", "Speed of sound"),
        _spec("Z", "-", "Compressibility factor, p/(rho.R_specific.T)"),
        _spec("gamma", "-", "Heat capacity ratio cp/cv"),
        _spec("molar_mass", "kg/mol", "Molar mass"),
    ]
)


def register_property(name: str, unit: str, description: str) -> PropertySpec:
    """Add a property to the registry at runtime.

    For quantities a project needs that this package does not ship -- a
    surface tension correlation, a user-supplied fouling factor. Backends that
    cannot compute it simply do not advertise it, and the fluid's chain falls
    through to one that can.
    """
    if name in PROPERTIES:
        raise ValueError(f"property {name!r} is already registered")
    spec = PropertySpec(name, unit, description)
    PROPERTIES[name] = spec
    return spec


@dataclass(frozen=True, slots=True)
class ThermoState:
    """An immutable snapshot of one fluid at one state point. All SI.

    ``quality`` is ``None`` outside the two-phase dome rather than a sentinel.
    Backends signal "not applicable" with out-of-band numbers -- CoolProp uses
    -1 in one situation and -1000 in another -- and letting either escape into
    a mass balance as a vapour fraction is the kind of bug that produces a
    plausible-looking wrong answer rather than a crash.
    """

    fluid: str
    backend: str

    p: float
    T: float
    rho: float
    h: float
    s: float
    u: float
    cp: float
    cv: float
    mu: float
    k: float
    a: float
    Z: float
    phase: Phase
    quality: float | None

    @property
    def gamma(self) -> float:
        """Heat capacity ratio cp/cv."""
        return self.cp / self.cv

    @property
    def nu(self) -> float:
        """Kinematic viscosity [m^2/s]."""
        return self.mu / self.rho

    def __str__(self) -> str:
        q = "-" if self.quality is None else f"{self.quality:.3f}"
        return (
            f"{self.fluid} @ {self.p / 1e5:.2f} bar, {self.T:.2f} K "
            f"[{self.phase.value}, x={q}] rho={self.rho:.4g} mu={self.mu:.4g}"
        )
