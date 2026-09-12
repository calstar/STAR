"""Vessels: COPVs, tank ullages, manifold plenums.

All the same object at different sizes -- a closed volume of gas whose pressure
is what the rest of the system sees::

    from feedtwin.props import Fluid
    from feedtwin.vessels import GasVolume

    copv = GasVolume(Fluid("nitrogen"), volume=0.009,
                     wall_mass=6.0, wall_capacity=900.0, wall_conductance=12.0)
    state = copv.initial_state(pressure=310e5, temperature=293.15)
    copv.pressure(state)          # Pa, real gas

State is ``(mass, internal energy)`` rather than ``(mass, temperature)``, which
keeps a real gas's energy balance exact. See :mod:`feedtwin.vessels.volume` for
why that distinction is worth the trouble, and why a vessel wall is not an
optional refinement.
"""

from __future__ import annotations

from feedtwin.vessels.collapse import (
    CollapseModel,
    ConductionCollapse,
    LiquidThermal,
    NoCollapse,
    build_collapse_model,
    register_collapse_model,
    registered_collapse_models,
)
from feedtwin.vessels.geometry import (
    CylindricalTank,
    Head,
    TabulatedGeometry,
    TankGeometry,
    build_geometry,
    level_of_volume,
    register_geometry,
    registered_geometries,
)
from feedtwin.vessels.tank import Tank, TankRates, TankState, UllageCondensed
from feedtwin.vessels.volume import GRAVITY, GasVolume, Rates, VesselState

__all__ = [
    "GRAVITY",
    "CollapseModel",
    "ConductionCollapse",
    "CylindricalTank",
    "GasVolume",
    "Head",
    "LiquidThermal",
    "NoCollapse",
    "Rates",
    "TabulatedGeometry",
    "Tank",
    "TankGeometry",
    "TankRates",
    "TankState",
    "UllageCondensed",
    "VesselState",
    "build_collapse_model",
    "build_geometry",
    "level_of_volume",
    "register_collapse_model",
    "register_geometry",
    "registered_collapse_models",
    "registered_geometries",
]
