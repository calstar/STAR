"""Ported from OpenRocket 24.12 (GPLv3):
info.openrocket.core.aerodynamics.barrowman.RocketComponentCalc."""

from __future__ import annotations


class RocketComponentCalc:
    def __init__(self, component):
        self.component = component

    def calculate_nonaxial_forces(self, conditions, transform, forces, warnings) -> None:
        raise NotImplementedError

    def calculate_friction_cd(self, conditions, component_cf: float, warnings) -> float:
        raise NotImplementedError

    def calculate_pressure_cd(self, conditions, stagnation_cd: float, base_cd: float, warnings) -> float:
        raise NotImplementedError

    def calculate_reynolds_number(self, length: float, conditions) -> float:
        return conditions.get_velocity() * length / conditions.get_atmospheric_conditions().get_kinematic_viscosity()
