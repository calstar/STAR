"""Ethanol/LOX concentric-tank freezing model.

Implements the transient Stefan moving-boundary simulation specified in
``EngineDesign/ethanol_lox_heat_flux_guide (1).md``: liquid ethanol convects
heat to a freeze front pinned at its melting point; that heat conducts out
through the growing ice layer and aluminum wall into boiling LOX; the
imbalance freezes more liquid.
"""

from .model import (
    DEFAULTS,
    TankFreezeInputs,
    TankFreezeResult,
    run_tank_freeze,
    run_tank_freeze_bounds,
    equilibrium_front_radius,
    convection,
    cold_path,
)
from .properties import (
    FLUIDS,
    chf_zuber,
    fluid_label,
    get_ethanol_table,
    get_liquid_table,
    oxygen_Tsat,
    oxygen_chf_zuber,
    sat_temperature,
    solid_constants,
)

__all__ = [
    "DEFAULTS",
    "FLUIDS",
    "TankFreezeInputs",
    "TankFreezeResult",
    "run_tank_freeze",
    "run_tank_freeze_bounds",
    "equilibrium_front_radius",
    "convection",
    "cold_path",
    "chf_zuber",
    "fluid_label",
    "get_ethanol_table",
    "get_liquid_table",
    "oxygen_Tsat",
    "oxygen_chf_zuber",
    "sat_temperature",
    "solid_constants",
]
