"""Ported from OpenRocket 24.12 (GPLv3):
info.openrocket.core.aerodynamics.barrowman.RailButtonCalc.

Cylinder drag (Gowen & Perkins, NACA TN 2960 fig. 7) at the mean speed across
the boundary layer at each button, referred back to the rocket's speed.
"""

from __future__ import annotations

from .. import _compat as compat
from .. import mathutil as mu
from .rocket_component_calc import RocketComponentCalc

CD_DOMAIN = [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.6, 2.0, 2.8, 100.0]
CD_RANGE = [1.2, 1.22, 1.25, 1.3, 1.4, 1.5, 1.6, 2.1, 1.5, 1.45, 1.33, 1.33]


class RailButtonCalc(RocketComponentCalc):
    def __init__(self, component):
        super().__init__(component)
        self.button = component

    def calculate_friction_cd(self, conditions, component_cf, warnings) -> float:
        return 0.0  # very small relative surface area, and slick

    def calculate_nonaxial_forces(self, conditions, transform, forces, warnings) -> None:
        pass  # Nothing to be done

    def calculate_pressure_cd(self, conditions, stagnation_cd, base_cd, warnings) -> float:
        button = self.button
        instance_count = compat.get_instance_count(button)
        instance_offsets = compat.get_instance_offsets(button)

        button_ht = button.get_total_height()
        outer_area = button_ht * button.get_outer_diameter()
        notch_area = (button.get_outer_diameter() - button.get_inner_diameter()) * button.get_inner_height()
        ref_area = outer_area - notch_area

        cd_mul = 0.0
        if conditions.get_mach() > mu.EPSILON:
            for i in range(instance_count):
                x = compat.to_absolute_x(button, instance_offsets[i])  # location of button
                rex = self.calculate_reynolds_number(x, conditions)
                dl = mu.jdiv(0.37 * x, mu.jpow(rex, 0.2))  # boundary layer thickness
                if button_ht > dl:
                    mach = (button_ht - 0.5 * dl) * conditions.get_mach() / button_ht
                else:
                    mach = mu.map_(button_ht / 2.0, 0, dl, 0, conditions.get_mach())
                cd = mu.interpolate(CD_DOMAIN, CD_RANGE, mach)
                cd = cd * mu.pow2(mach) / mu.pow2(conditions.get_mach())
                cd_mul += cd
            cd_mul /= instance_count
        else:
            cd_mul = 8.786395072609939E-4  # value at velocity of MathUtil.EPSILON
        return cd_mul * stagnation_cd * ref_area / conditions.get_ref_area()
