"""The backend seam: what a property source must provide, and how to add one.

A backend answers "given two independent state variables, what is this
property". That is the entire contract. CoolProp's Helmholtz equations of state
are one implementation; its bicubic tables are a second; a table of numbers
measured on a flow bench is a third, and the layer above cannot tell them apart.

Keeping this seam narrow is what lets Phase 12 drop measured data in front of an
equation of state without touching a solver, and what would let REFPROP or a
Modelica media model in later without touching anything else.

Backends are registered by name, so a project can add one without editing this
package::

    from feedtwin.props.backend import register_backend

    register_backend("my_eos", lambda species: MyBackend(species))

and then name it in a fluid's chain.
"""

from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING, Callable, Protocol, runtime_checkable

from feedtwin.props.state import Phase

if TYPE_CHECKING:  # pragma: no cover - import cycle guard, types only
    from feedtwin.props.species import SpeciesSpec


class StatePair(Enum):
    """Which two independent variables a state point is specified by.

    Backend-neutral on purpose: CoolProp spells these as integer constants,
    another library would spell them differently, and the translation belongs
    inside the backend rather than at every call site.

    Two variables fix the state of a single-component fluid. ``PQ`` and ``TQ``
    address the saturation dome, where pressure and temperature are not
    independent and quality is the second variable instead.
    """

    PT = "PT"
    PH = "PH"
    PS = "PS"
    PQ = "PQ"
    TQ = "TQ"
    PD = "PD"
    HS = "HS"
    DT = "DT"
    """Density and temperature. What a vessel of known mass and volume has."""
    DU = "DU"
    """Density and specific internal energy -- the exact state variables of a
    closed volume. A vessel's energy balance is written in ``u``, so tracking
    ``(rho, u)`` keeps it exact for a real gas rather than approximating it
    through a heat capacity."""


@runtime_checkable
class PropertyBackend(Protocol):
    """A source of thermophysical properties for one species.

    Implementations are **stateful and single-threaded**: :meth:`update` moves
    the backend to a state point and :meth:`value` reads from wherever it was
    last moved. That is CoolProp's model and it is fast for exactly the reason
    it is dangerous -- one object, reused. :class:`~feedtwin.props.fluid.Fluid`
    owns the thread-confinement that makes it safe; do not share an instance.
    """

    @property
    def name(self) -> str:
        """Short identifier, e.g. ``"bicubic"``. Appears in ThermoState."""
        ...

    def supports(self, prop: str) -> bool:
        """Whether this backend can compute ``prop`` at all.

        A property of the backend, not of the state, so callers can answer it
        once and route around a gap rather than probing per state point.
        """
        ...

    def update(self, pair: StatePair, v1: float, v2: float) -> None:
        """Move to a state point.

        Raises:
            OutOfRange: the point is outside this backend's envelope. Routine --
                the caller's chain tries the next backend.
        """
        ...

    def value(self, prop: str) -> float:
        """Read a property at the current state point.

        Raises:
            UnsupportedProperty: this backend cannot compute it.
        """
        ...

    def phase(self) -> Phase:
        """Phase at the current state point."""
        ...

    def quality(self) -> float | None:
        """Vapour mass fraction, or ``None`` outside the two-phase dome."""
        ...


#: Builds a backend for one species. Registered under a name and named in a
#: fluid's chain; taking the whole SpeciesSpec (not just a fluid name) is what
#: lets a backend read its own settings out of the species table.
BackendFactory = Callable[["SpeciesSpec"], PropertyBackend]

_BACKENDS: dict[str, BackendFactory] = {}


def register_backend(name: str, factory: BackendFactory) -> None:
    """Register a backend factory under ``name``.

    Re-registering the same name replaces it, which is deliberate: a project
    overriding a shipped backend should not have to remove it first.
    """
    _BACKENDS[name] = factory


def get_backend_factory(name: str) -> BackendFactory:
    if name not in _BACKENDS:
        raise KeyError(
            f"unknown property backend {name!r}; registered: "
            f"{', '.join(sorted(_BACKENDS))}"
        )
    return _BACKENDS[name]


def registered_backends() -> list[str]:
    return sorted(_BACKENDS)
