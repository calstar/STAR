"""The atmosphere FlightConditions carries by default.

Ported from OpenRocket 24.12 (GPLv3):
info.openrocket.core.models.atmosphere.AtmosphericConditions.

FlightConditions' default is ``new AtmosphericConditions()``: 293.15 K and
101325 Pa -- *not* the ISA sea level (288.15 K). Speed of sound and kinematic
viscosity are OpenRocket's linear fits, not ideal-gas formulas.
"""

from __future__ import annotations

R = 287.053
GAMMA = 1.4
STANDARD_PRESSURE = 101325.0
STANDARD_TEMPERATURE = 293.15


class AtmosphericConditions:
    def __init__(self, temperature: float = STANDARD_TEMPERATURE, pressure: float = STANDARD_PRESSURE):
        if temperature <= 0:
            raise ValueError("Temperature must be positive (Kelvin)")
        if pressure <= 0:
            raise ValueError("Pressure must be positive (Pascals)")
        self.temperature = float(temperature)
        self.pressure = float(pressure)

    def get_pressure(self) -> float:
        return self.pressure

    def get_temperature(self) -> float:
        return self.temperature

    def get_density(self) -> float:
        return self.get_pressure() / (R * self.get_temperature())

    def get_mach_speed(self) -> float:
        return 165.77 + 0.606 * self.get_temperature()

    def get_kinematic_viscosity(self) -> float:
        v = 3.7291e-06 + 4.9944e-08 * self.get_temperature()
        return v / self.get_density()

    def clone(self) -> "AtmosphericConditions":
        return AtmosphericConditions(self.temperature, self.pressure)
