"""orweb.aero -- OpenRocket 24.12's aerodynamics, ported to Python (GPLv3).

Entry point for the API: ``analyze(rocket_or_config, mach, aoa_rad, roll_rate=0.0, theta=0.0)``.
The port proper is ``BarrowmanCalculator`` and the calcs in ``orweb.aero.barrowman``.
"""

from .analyze import analyze, flight_conditions, resolve_configuration
from .barrowman_calculator import BarrowmanCalculator, calculate_axial_cd, calculate_base_cd
from .barrowman.symmetric_component_calc import calculate_stagnation_cd
from .flight_conditions import FlightConditions
from .forces import AerodynamicForces
from .atmosphere import AtmosphericConditions

__all__ = [
    "analyze", "flight_conditions", "resolve_configuration", "BarrowmanCalculator", "FlightConditions",
    "AerodynamicForces", "AtmosphericConditions", "calculate_axial_cd", "calculate_base_cd",
    "calculate_stagnation_cd",
]
