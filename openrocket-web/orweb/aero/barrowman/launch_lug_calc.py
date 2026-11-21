"""Ported from OpenRocket 24.12 (GPLv3):
info.openrocket.core.aerodynamics.barrowman.LaunchLugCalc."""

from __future__ import annotations

from .tube_calc import TubeCalc


class LaunchLugCalc(TubeCalc):
    def calculate_nonaxial_forces(self, conditions, transform, forces, warnings) -> None:
        pass  # Nothing to be done

    def calculate_friction_cd(self, conditions, component_cf, warnings) -> float:
        return 0.0  # launch lug doesn't add enough area to worry about
