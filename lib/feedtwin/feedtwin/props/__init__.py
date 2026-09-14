"""Real-gas thermophysical properties, fast enough to sit inside a solver.

Everything above this package asks a :class:`Fluid` for numbers and never
touches an equation-of-state library::

    from feedtwin.props import Fluid

    n2 = Fluid("nitrogen")
    n2.get("rho", p=3.1e7, T=293.0)      # 44.5 kg/m3, ~0.13 us
    n2.get("Z", p=3.1e7, T=293.0)        # 1.150 -- a COPV is not an ideal gas
    n2.state(p=5e5, q=0.5).phase         # Phase.TWO_PHASE

Three ideas carry the whole package:

**A chain, not a branch.** A fluid holds an ordered list of backends. Tabulated
interpolation answers ordinary states in ~0.13 us; the Helmholtz equation of
state behind it answers everything the tables refuse. Put measured data at the
front and it wins wherever it has coverage. Nobody writes the routing.

**Refuse, never extrapolate.** A backend outside its envelope raises
:class:`OutOfRange` and the chain moves on. No backend in this package will
return a plausible number for a state point it cannot actually reach.

**Fluids are data.** Species live in ``species.toml``. Adding a propellant is a
data edit, and :func:`register_species` adds one at runtime without touching
this package at all.

SI throughout: Pa, K, kg/m3, Pa.s, J/kg, J/(kg.K), W/(m.K), m/s.
"""

from __future__ import annotations

from feedtwin.props.backend import (
    PropertyBackend,
    StatePair,
    register_backend,
    registered_backends,
)
from feedtwin.props.backends.coolprop import CoolPropBackend, warm_tables
from feedtwin.props.backends.tabulated import TabulatedProperties
from feedtwin.props.errors import (
    OutOfRange,
    PropertyError,
    UnknownFluid,
    UnsupportedProperty,
)
from feedtwin.props.fluid import Fluid
from feedtwin.props.species import (
    DEFAULT_CHAIN,
    SpeciesSpec,
    get_species,
    load_species_file,
    register_species,
    registered_species,
)
from feedtwin.props.state import (
    PROPERTIES,
    Phase,
    PropertySpec,
    ThermoState,
    register_property,
)


def warmup(fluids: list[str] | None = None) -> dict[str, float]:
    """Build interpolation tables now rather than inside the first solve.

    Returns seconds spent per fluid. Costs 2-3 s and ~17 MB each the first time
    on a machine; afterwards CoolProp loads them from its own cache.

    Call this when a process starts if it is going to do physics -- a pool
    worker, an API container. The reason is the same one EngineDesign's
    accelerator front-loads its JIT for: paid lazily, the cost lands inside
    whichever call happens to come first, which is usually one somebody is
    timing.

    Args:
        fluids: Names or aliases to warm. Defaults to every declared species.
    """
    names = fluids if fluids is not None else registered_species()
    return {name: warm_tables(get_species(name)) for name in names}


__all__ = [
    "DEFAULT_CHAIN",
    "PROPERTIES",
    "CoolPropBackend",
    "Fluid",
    "OutOfRange",
    "Phase",
    "PropertyBackend",
    "PropertyError",
    "PropertySpec",
    "SpeciesSpec",
    "StatePair",
    "TabulatedProperties",
    "ThermoState",
    "UnknownFluid",
    "UnsupportedProperty",
    "get_species",
    "load_species_file",
    "register_backend",
    "register_property",
    "register_species",
    "registered_backends",
    "registered_species",
    "warm_tables",
    "warmup",
]
