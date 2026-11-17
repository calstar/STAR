"""Ported from OpenRocket 24.12 (GPLv3):
info.openrocket.core.aerodynamics.barrowman.SymmetricComponentCalc.

Body components (nose cones, transitions, body tubes): Barrowman CNa and CP
for the change of cross-section, Galejs body lift (K = 1.1) on the planform,
wetted-area friction, and pressure drag -- boattails from base drag, nose cones
and shoulders from NASA TR-R-100 fineness-3 data extrapolated to the actual
fineness ratio (conical/ogive computed directly).
"""

from __future__ import annotations

import math

from .. import _compat as compat
from .. import mathutil as mu
from ..atmosphere import GAMMA
from ..coordinate import Coordinate
from ..interpolators import LinearInterpolator, PolyInterpolator
from .rocket_component_calc import RocketComponentCalc

pow2 = mu.pow2

BODY_LIFT_K = 1.1


def calculate_stagnation_cd(m: float) -> float:
    """BarrowmanCalculator.calculateStagnationCD."""
    if m <= 1:
        pressure = 1 + pow2(m) / 4 + pow2(pow2(m)) / 40
    else:
        pressure = 1.84 - 0.76 / pow2(m) + 0.166 / pow2(pow2(m)) + 0.035 / pow2(m * m * m)
    return 0.8500001 * pressure


class SymmetricComponentCalc(RocketComponentCalc):
    def __init__(self, c):
        super().__init__(c)
        if not compat.is_a(c, "SymmetricComponent"):
            raise ValueError(f"Illegal component type {c!r}")
        component = c
        self.length = component.get_length()
        if self.length > 0:
            self.fore_radius = component.get_fore_radius()
            self.aft_radius = component.get_aft_radius()
        else:
            # zero length: a disk, so match the fore and aft diameter
            r = max(component.get_fore_radius(), component.get_aft_radius())
            self.fore_radius = self.aft_radius = r

        self.fineness = mu.jdiv(self.length, (2 * abs(self.aft_radius - self.fore_radius)))
        self.full_volume = component.get_full_volume()
        self.planform_area = component.get_component_planform_area()
        self.planform_center = component.get_component_planform_center()
        self.wet_area = component.get_component_wet_area()

        if compat.is_a(component, "BodyTube"):
            self.shape = None
            self.param = 0.0
            self.frontal_area = 0.0
            self.sinphi = 0.0
        elif compat.is_a(component, "Transition"):
            self.shape = compat.shape_type(component)
            self.param = component.get_shape_parameter()
            self.frontal_area = abs(math.pi * (self.fore_radius * self.fore_radius - self.aft_radius * self.aft_radius))
            r = component.get_radius(0.99 * self.length)
            self.sinphi = mu.jdiv(self.aft_radius - r, mu.hypot(self.aft_radius - r, 0.01 * self.length))
        else:
            raise NotImplementedError(f"Unknown component type {c!r}")

        self.is_tube = False
        self.cna_cache = math.nan
        self.cp_cache = math.nan
        self.interpolator: LinearInterpolator | None = None

    # ---------------------------------------------------------- non-axial
    def calculate_nonaxial_forces(self, conditions, transform, forces, warnings) -> None:
        if math.isnan(self.cna_cache):
            r0 = self.fore_radius
            r1 = self.aft_radius
            if mu.equals(r0, r1):
                self.is_tube = True
                self.cna_cache = 0.0
            else:
                self.is_tube = False
                a0 = math.pi * pow2(r0)
                a1 = math.pi * pow2(r1)
                self.cna_cache = 2 * (a1 - a0)
                self.cp_cache = (self.length * a1 - self.full_volume) / (a1 - a0)

        if self.is_tube:
            cp = self.get_lift_cp(conditions, warnings)
        else:
            cp = Coordinate(self.cp_cache, 0, 0, self.cna_cache * conditions.get_sinc_aoa()
                            / conditions.get_ref_area()).average(self.get_lift_cp(conditions, warnings))

        forces.set_cp(cp)
        forces.set_cn(forces.get_cp().weight * conditions.get_aoa())
        forces.set_cm(forces.get_cn() * cp.x / conditions.get_ref_length())
        forces.set_croll(0.0)
        forces.set_croll_damp(0.0)
        forces.set_croll_force(0.0)
        forces.set_cside(0.0)
        forces.set_cyaw(0.0)

        if conditions.get_mach() > 1.1 and warnings is not None:
            warnings.append("SUPERSONIC")

    def get_lift_cp(self, conditions, warnings) -> Coordinate:
        """Body lift according to Galejs."""
        mul = 1.0
        if conditions.get_mach() < 0.05 and conditions.get_aoa() > math.pi / 4:
            mul = pow2(conditions.get_mach() / 0.05)
        return Coordinate(self.planform_center, 0, 0, mul * BODY_LIFT_K * self.planform_area
                          / conditions.get_ref_area() * conditions.get_sin_aoa() * conditions.get_sinc_aoa())

    # ---------------------------------------------------------------- drag
    def calculate_friction_cd(self, conditions, component_cf, warnings) -> float:
        return component_cf * self.wet_area / conditions.get_ref_area()

    def calculate_pressure_cd(self, conditions, stagnation_cd, base_cd, warnings) -> float:
        if mu.equals(self.fore_radius, self.aft_radius):
            return 0.0
        if self.length < 0.001:
            if self.fore_radius < self.aft_radius:
                return stagnation_cd * self.frontal_area / conditions.get_ref_area()
            return base_cd * self.frontal_area / conditions.get_ref_area()

        # boattail drag computed directly from base drag
        if self.aft_radius < self.fore_radius:
            if self.fineness >= 3:
                return 0.0
            cd = base_cd * self.frontal_area / conditions.get_ref_area()
            if self.fineness <= 1:
                return cd
            return cd * (3 - self.fineness) / 2

        # all nose cones and shoulders from pre-calculated and interpolating
        if self.interpolator is None:
            self.calculate_nose_interpolator()
        return self.interpolator.get_value(conditions.get_mach()) * self.frontal_area / conditions.get_ref_area()

    def calculate_nose_interpolator(self) -> None:
        int1 = int2 = None
        p = 0.0
        param, sinphi, fineness = self.param, self.sinphi, self.fineness
        self.interpolator = LinearInterpolator()
        shape = self.shape
        if shape == "CONICAL":
            self.interpolator = calculate_ogive_nose_interpolator(0, sinphi)  # param==0 -> conical
        elif shape == "OGIVE":
            self.interpolator = calculate_ogive_nose_interpolator(param, sinphi)
        elif shape == "ELLIPSOID":
            int1 = ELLIPSOID_INTERPOLATOR
        elif shape == "POWER":
            if param <= 0.25:
                int1, int2, p = BLUNT_INTERPOLATOR, X14_INTERPOLATOR, param * 4
            elif param <= 0.5:
                int1, int2, p = X14_INTERPOLATOR, X12_INTERPOLATOR, (param - 0.25) * 4
            elif param <= 0.75:
                int1, int2, p = X12_INTERPOLATOR, X34_INTERPOLATOR, (param - 0.5) * 4
            else:
                int1 = X34_INTERPOLATOR
                int2 = calculate_ogive_nose_interpolator(0, 1 / mu.safe_sqrt(1 + 4 * pow2(fineness)))
                p = (param - 0.75) * 4
        elif shape == "PARABOLIC":
            if param <= 0.5:
                int1 = calculate_ogive_nose_interpolator(0, 1 / mu.safe_sqrt(1 + 4 * pow2(fineness)))
                int2 = PARABOLIC12_INTERPOLATOR
                p = param * 2
            elif param <= 0.75:
                int1, int2, p = PARABOLIC12_INTERPOLATOR, PARABOLIC34_INTERPOLATOR, (param - 0.5) * 4
            else:
                int1, int2, p = PARABOLIC34_INTERPOLATOR, PARABOLIC_INTERPOLATOR, (param - 0.75) * 4
        elif shape == "HAACK":
            int1, int2, p = VON_KARMAN_INTERPOLATOR, LV_HAACK_INTERPOLATOR, param * 3
        else:
            raise NotImplementedError(f"Unknown transition shape: {shape}")

        if p < 0 or p > 1.00001:
            raise RuntimeError(f"Inconsistent parameter value p={p} shape={shape}")

        # parameterized shape: interpolate between the bounding shapes
        if int2 is not None:
            int3 = LinearInterpolator()
            for m in int1.get_x_points():
                int3.add_point(m, p * int2.get_value(m) + (1 - p) * int1.get_value(m))
            for m in int2.get_x_points():
                int3.add_point(m, p * int2.get_value(m) + (1 - p) * int1.get_value(m))
            int1 = int3

        # extrapolate for fineness ratio
        if int1 is not None:
            log4 = math.log(fineness + 1) / math.log(4)
            for m in int1.get_x_points():
                stag = BLUNT_INTERPOLATOR.get_value(m)
                self.interpolator.add_point(m, stag * mu.jpow(int1.get_value(m) / stag, log4))

        # the transonic/supersonic region is done; fill in the subsonic one if non-zero
        mn = self.interpolator.get_x_points()[0]
        min_value = self.interpolator.get_value(mn)
        if min_value < 0.001:
            return
        cd_mach0 = 0.8 * pow2(sinphi)
        min_deriv = (self.interpolator.get_value(mn + 0.01) - min_value) / 0.01
        if cd_mach0 >= min_value - 0.01 or min_deriv <= 0.01:
            return
        # Cd = a*M^b + cdMach0
        b = mn * min_deriv / (min_value - cd_mach0)
        a = (min_value - cd_mach0) / mu.jpow(mn, b)
        m = 0.0
        while m < mn:
            self.interpolator.add_point(m, a * mu.jpow(m, b) + cd_mach0)
            m += 0.05


# Experimental pressure drag of fineness-3 noses, NASA TR-R-100 p. 16
ELLIPSOID_INTERPOLATOR = LinearInterpolator(
    [1.2, 1.25, 1.3, 1.4, 1.6, 2.0, 2.4],
    [0.110, 0.128, 0.140, 0.148, 0.152, 0.159, 0.162])
X14_INTERPOLATOR = LinearInterpolator(
    [1.2, 1.3, 1.4, 1.6, 1.8, 2.2, 2.6, 3.0, 3.6],
    [0.140, 0.156, 0.169, 0.192, 0.206, 0.227, 0.241, 0.249, 0.252])
X12_INTERPOLATOR = LinearInterpolator(
    [0.925, 0.95, 1.0, 1.05, 1.1, 1.2, 1.3, 1.7, 2.0],
    [0, 0.014, 0.050, 0.060, 0.059, 0.081, 0.084, 0.085, 0.078])
X34_INTERPOLATOR = LinearInterpolator(
    [0.8, 0.9, 1.0, 1.06, 1.2, 1.4, 1.6, 2.0, 2.8, 3.4],
    [0, 0.015, 0.078, 0.121, 0.110, 0.098, 0.090, 0.084, 0.078, 0.074])
VON_KARMAN_INTERPOLATOR = LinearInterpolator(
    [0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 2.0, 3.0],
    [0, 0.010, 0.027, 0.055, 0.070, 0.081, 0.095, 0.097, 0.091, 0.083])
LV_HAACK_INTERPOLATOR = LinearInterpolator(
    [0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 2.0],
    [0, 0.010, 0.024, 0.066, 0.084, 0.100, 0.114, 0.117, 0.113])
PARABOLIC_INTERPOLATOR = LinearInterpolator(
    [0.95, 0.975, 1.0, 1.05, 1.1, 1.2, 1.4, 1.7],
    [0, 0.016, 0.041, 0.092, 0.109, 0.119, 0.113, 0.108])
PARABOLIC12_INTERPOLATOR = LinearInterpolator(
    [0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.3, 1.5, 1.8],
    [0, 0.016, 0.042, 0.100, 0.126, 0.125, 0.100, 0.090, 0.088])
PARABOLIC34_INTERPOLATOR = LinearInterpolator(
    [0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.7],
    [0, 0.023, 0.073, 0.098, 0.107, 0.106, 0.089, 0.082])
BLUNT_INTERPOLATOR = LinearInterpolator()
_m = 0.0
while _m < 3:
    BLUNT_INTERPOLATOR.add_point(_m, calculate_stagnation_cd(_m))
    _m += 0.05
del _m

CONICAL_POLY_INTERPOLATOR = PolyInterpolator([1.0, 1.3], [1.0, 1.3])


def calculate_ogive_nose_interpolator(param: float, sinphi: float) -> LinearInterpolator:
    interpolator = LinearInterpolator()
    # M = 1 ... 1.3: polynomial approximation
    cd_mach1 = sinphi
    cd_mach1_3 = 2.1 * pow2(sinphi) + 0.6019 * sinphi
    poly = CONICAL_POLY_INTERPOLATOR.interpolator(
        cd_mach1, cd_mach1_3, 4 / (GAMMA + 1) * (1 - 0.5 * cd_mach1), -1.1341 * sinphi)
    mul = 0.72 * pow2(param - 0.5) + 0.82  # shape parameter multiplier
    m = 1.0
    while m < 1.3001:
        interpolator.add_point(m, mul * PolyInterpolator.eval(m, poly))
        m += 0.02
    # above M = 1.3: direct formula
    m = 1.32
    while m < 4:
        interpolator.add_point(m, mul * (2.1 * pow2(sinphi) + 0.5 * sinphi / mu.safe_sqrt(m * m - 1)))
        m += 0.02
    return interpolator
