"""Ported from OpenRocket 24.12 (GPLv3):
info.openrocket.core.aerodynamics.barrowman.TubeCalc.

Pressure drag of an open tube (launch lug, tube fin): Darcy-Weisbach on the
bore with the Swamee-Jain friction factor, plus stagnation and base drag on the
annulus at 0.7 efficiency.
"""

from __future__ import annotations

import math

from .. import _compat as compat
from .. import mathutil as mu
from .rocket_component_calc import RocketComponentCalc


class TubeCalc(RocketComponentCalc):
    def __init__(self, component):
        super().__init__(component)
        tube = component
        self.tube = tube
        self.length = tube.get_length()
        self.diameter = 2 * tube.get_inner_radius()
        self.inner_area = math.pi * mu.pow2(tube.get_inner_radius())
        self.total_area = math.pi * mu.pow2(tube.get_outer_radius())
        self.frontal_area = self.total_area - self.inner_area
        self.epsilon = compat.finish_roughness(tube)

    def calculate_pressure_cd(self, conditions, stagnation_cd, base_cd, warnings) -> float:
        v = conditions.get_velocity()
        if v < mu.EPSILON:
            return 0.0
        tube_cd = 0.0
        if self.inner_area > mu.EPSILON:
            atmos = conditions.get_atmospheric_conditions()
            rho = atmos.get_density()
            re = v * self.diameter / atmos.get_kinematic_viscosity()
            f = 0.25 / mu.pow2(mu.jlog10((self.epsilon / (3.7 * self.diameter) + 5.74 / mu.jpow(re, 0.9))))
            deltap = f * (self.length * rho * mu.pow2(v)) / (2 * self.diameter)
            tube_cd = 2 * (deltap * self.inner_area) / (rho * mu.pow2(v) * self.inner_area)
        return (tube_cd * self.inner_area + 0.7 * (stagnation_cd + base_cd) * self.frontal_area) / conditions.get_ref_area()
