"""Ported from OpenRocket 24.12 (GPLv3):
info.openrocket.core.aerodynamics.barrowman.TubeFinSetCalc.

One tube of a tube-fin set: ring-airfoil CNa (Ribner 1947), the interstice
between tube and body as extra pressure drag, wetted area less the masked body.

Faithful to 24.12 including its quirks: ``calculatePoly`` is never called in
the Java constructor, so the CP polynomial is all zeros and the CP sits at the
tube's leading edge for 0.5 < M < 2; cant is fixed at 0.
"""

from __future__ import annotations

import math

from .. import mathutil as mu
from ..coordinate import Coordinate
from .fin_set_calc import calculate_cp_pos
from .tube_calc import TubeCalc

STALL_ANGLE = 20 * math.pi / 180


class TubeFinSetCalc(TubeCalc):
    def __init__(self, component):
        super().__init__(component)
        tubes = component
        self.tubes = tubes
        self.geometry_warnings: list = []
        if int(tubes.get_fin_count()) == 1:
            self.geometry_warnings.append("TUBE_ISOLATED")
        elif tubes.get_tube_separation() > mu.EPSILON:
            self.geometry_warnings.append("TUBE_SEPARATION")
        elif tubes.get_tube_separation() < -mu.EPSILON:
            self.geometry_warnings.append("TUBE_OVERLAP")

        self.body_radius = body_radius = tubes.get_body_radius()
        self.chord = chord = tubes.get_length()
        self.inner_radius = inner_radius = tubes.get_inner_radius()
        self.outer_radius = outer_radius = tubes.get_outer_radius()
        self.tube_count = int(tubes.get_fin_count())
        self.base_rotation = tubes.get_base_rotation()
        self.cant_angle = 0.0  # tube cant can only be 0 in 24.12

        self.ar = 2 * inner_radius / chord
        d = math.sqrt(mu.pow2(body_radius + outer_radius) - mu.pow2(outer_radius))
        a = d * outer_radius
        theta1 = math.acos(outer_radius / (outer_radius + body_radius))
        a1 = mu.pow2(outer_radius) * theta1
        theta2 = math.pi / 2.0 - theta1
        a2 = mu.pow2(body_radius) * theta2
        self.interstice_area = a - a1 - a2
        outer_area = chord * 2.0 * (math.pi - theta1) * outer_radius
        masked_area = chord * 2.0 * theta2 * body_radius
        self.wetted_area = outer_area - masked_area

        arprime = 2 * self.ar / math.pi
        self.cnaconst = 2 * (arprime / (1 + arprime)) * math.pi * math.pi * inner_radius * chord

        # Java leaves poly[] at zeros: calculatePoly() exists but is never called.
        self.poly = [0.0] * 6

    def calculate_nonaxial_forces(self, conditions, transform, forces, warnings) -> None:
        if warnings is not None:
            warnings.extend(self.geometry_warnings)
        if self.outer_radius < 0.001:
            forces.set_cm(0.0)
            forces.set_cn(0.0)
            forces.set_cp(Coordinate.ZERO)  # type: ignore[attr-defined]
            forces.set_croll(0.0)
            forces.set_croll_damp(0.0)
            forces.set_croll_force(0.0)
            forces.set_cside(0.0)
            forces.set_cyaw(0.0)
            return

        cna = self.cnaconst / conditions.get_ref_area()
        x = calculate_cp_pos(conditions, self.ar, self.poly) * self.chord

        forces.set_croll_force((self.body_radius + self.outer_radius) * cna * self.cant_angle
                               / conditions.get_ref_length())
        if conditions.get_aoa() > STALL_ANGLE:
            forces.set_croll_force(forces.get_croll_force() * mu.clamp(
                1 - (conditions.get_aoa() - STALL_ANGLE) / (STALL_ANGLE / 2), 0, 1))
        forces.set_croll_damp(mu.jdiv((self.body_radius + self.outer_radius) * conditions.get_roll_rate(),
                                      conditions.get_velocity()) * cna / conditions.get_ref_length())
        forces.set_croll(forces.get_croll_force() - forces.get_croll_damp())

        forces.set_cn(cna * mu.min_(conditions.get_aoa(), STALL_ANGLE))
        forces.set_cp(Coordinate(x, 0, 0, cna))
        forces.set_cm(forces.get_cn() * x / conditions.get_ref_length())
        forces.set_cside(0.0)
        forces.set_cyaw(0.0)

    def calculate_friction_cd(self, conditions, component_cf, warnings) -> float:
        return component_cf * self.wetted_area / conditions.get_ref_area()

    def calculate_pressure_cd(self, conditions, stagnation_cd, base_cd, warnings) -> float:
        if warnings is not None:
            warnings.extend(self.geometry_warnings)
        return (super().calculate_pressure_cd(conditions, stagnation_cd, base_cd, warnings)
                + (stagnation_cd + base_cd) * self.interstice_area / conditions.get_ref_area())
