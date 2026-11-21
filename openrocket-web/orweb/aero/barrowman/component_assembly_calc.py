"""Ported from OpenRocket 24.12 (GPLv3):
info.openrocket.core.aerodynamics.barrowman.ComponentAssemblyCalc."""

from __future__ import annotations

from .rocket_component_calc import RocketComponentCalc


class ComponentAssemblyCalc(RocketComponentCalc):
    def calculate_nonaxial_forces(self, conditions, transform, forces, warnings) -> None:
        pass  # empty

    def calculate_friction_cd(self, conditions, component_cf, warnings) -> float:
        return 0.0

    def calculate_pressure_cd(self, conditions, stagnation_cd, base_cd, warnings) -> float:
        return 0.0
