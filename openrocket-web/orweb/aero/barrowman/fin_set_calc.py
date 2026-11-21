"""Ported from OpenRocket 24.12 (GPLv3):
info.openrocket.core.aerodynamics.barrowman.FinSetCalc.

One fin of a fin set (BarrowmanCalculator iterates the instances): CNa of a
single fin (subsonic Diederich, supersonic Busemann second-order K1..K3,
transonic polynomial bridge), fin-fin and body-fin interference, CP along the
MAC (quarter chord below M 0.5, empirical above M 2, quintic in between),
roll forcing from cant and roll damping, friction with thickness correction,
and pressure drag by cross-section.
"""

from __future__ import annotations

import math

from .. import _compat as compat
from .. import mathutil as mu
from ..coordinate import Coordinate
from ..interpolators import LinearInterpolator, PolyInterpolator
from .rocket_component_calc import RocketComponentCalc

pow2 = mu.pow2

STALL_ANGLE = 20 * math.pi / 180
DIVISIONS = 48

CNA_SUBSONIC = 0.9
CNA_SUPERSONIC = 1.5
CNA_SUPERSONIC_B = math.pow(pow2(CNA_SUPERSONIC) - 1, 1.5)
GAMMA = 1.4


def _build_k():
    n = int((5.0 - CNA_SUPERSONIC) * 10)
    x, k1, k2, k3 = [], [], [], []
    for i in range(n):
        m = CNA_SUPERSONIC + i * 0.1
        beta = mu.safe_sqrt(m * m - 1)
        x.append(m)
        k1.append(2.0 / beta)
        k2.append(((GAMMA + 1) * math.pow(m, 4) - 4 * pow2(beta)) / (4 * math.pow(beta, 4)))
        k3.append(((GAMMA + 1) * math.pow(m, 8) + (2 * pow2(GAMMA) - 7 * GAMMA - 5) * math.pow(m, 6)
                   + 10 * (GAMMA + 1) * math.pow(m, 4) + 8) / (6 * math.pow(beta, 7)))
    return LinearInterpolator(x, k1), LinearInterpolator(x, k2), LinearInterpolator(x, k3)


K1, K2, K3 = _build_k()
CNA_INTERPOLATOR = PolyInterpolator([CNA_SUBSONIC, CNA_SUPERSONIC], [CNA_SUBSONIC, CNA_SUPERSONIC], [CNA_SUBSONIC])


def calculate_cp_poly(ar: float) -> list[float]:
    """FinSetCalc.calculatePoly: quintic CP position between M 0.5 and M 2."""
    denom = pow2(1 - 3.4641 * ar)
    poly = [0.0] * 6
    poly[5] = mu.jdiv(-1.58025 * (-0.728769 + ar) * (-0.192105 + ar), denom)
    poly[4] = mu.jdiv(12.8395 * (-0.725688 + ar) * (-0.19292 + ar), denom)
    poly[3] = mu.jdiv(-39.5062 * (-0.72074 + ar) * (-0.194245 + ar), denom)
    poly[2] = mu.jdiv(55.3086 * (-0.711482 + ar) * (-0.196772 + ar), denom)
    poly[1] = mu.jdiv(-31.6049 * (-0.705375 + ar) * (-0.198476 + ar), denom)
    poly[0] = mu.jdiv(9.16049 * (-0.588838 + ar) * (-0.20624 + ar), denom)
    return poly


def calculate_cp_pos(cond, ar: float, poly) -> float:
    """FinSetCalc.calculateCPPos (and TubeFinSetCalc's copy)."""
    m = cond.get_mach()
    if m <= 0.5:
        return 0.25
    if m >= 2:
        beta = cond.get_beta()
        return mu.jdiv(ar * beta - 0.67, 2 * ar * beta - 1)
    x = 1.0
    val = 0.0
    for v in poly:
        val += v * x
        x *= m
    return val


class FinSetCalc(RocketComponentCalc):
    def __init__(self, component):
        super().__init__(component)
        self.mac_length = math.nan
        self.mac_lead = math.nan
        self.mac_span = math.nan
        self.ar = math.nan
        self.cos_gamma = math.nan
        self.cos_gamma_lead = math.nan
        self.roll_sum = math.nan
        self.interference_fin_count = -1
        self.chord_lead = [0.0] * DIVISIONS
        self.chord_trail = [0.0] * DIVISIONS
        self.chord_length = [0.0] * DIVISIONS
        self.geometry_warnings: list = []

        self.thickness = component.get_thickness()
        self.body_radius = component.get_body_radius()
        self.fin_count = int(component.get_fin_count())
        self.cant_angle = component.get_cant_angle()
        self.span = component.get_span()
        self.fin_area = component.get_planform_area()
        self.cross_section = compat.cross_section(component)
        self.calculate_fin_geometry(component)
        self.poly = calculate_cp_poly(self.ar)
        self.calculate_interference_fin_count(component)

    # ---------------------------------------------------------- non-axial
    def calculate_nonaxial_forces(self, conditions, transform, forces, warnings) -> None:
        if warnings is not None:
            warnings.extend(self.geometry_warnings)

        if self.fin_area < mu.EPSILON or self.mac_span < mu.EPSILON:
            forces.set_cm(0.0)
            forces.set_cn(0.0)
            forces.set_cp(Coordinate.ZERO)  # type: ignore[attr-defined]
            forces.set_croll(0.0)
            forces.set_croll_damp(0.0)
            forces.set_croll_force(0.0)
            forces.set_cside(0.0)
            forces.set_cyaw(0.0)
            return

        # one fin without interference (sub- and supersonic)
        cna1 = self.calculate_fin_cna1(conditions)

        theta = conditions.get_theta()
        angle = transform.get_xrotation()
        cna = cna1 * pow2(math.sin(theta - angle))

        # fin-fin interference
        n = self.interference_fin_count
        if n in (1, 2, 3, 4):
            pass
        elif n == 5:
            cna *= 0.948
        elif n == 6:
            cna *= 0.913
        elif n == 7:
            cna *= 0.854
        elif n == 8:
            cna *= 0.81
        else:
            cna *= 0.75  # assume 75% efficiency
            if warnings is not None:
                warnings.append("PARALLEL_FINS")

        # body-fin interference (classical Barrowman)
        r = self.body_radius
        tau = mu.jdiv(r, self.span + r)
        if math.isnan(tau) or math.isinf(tau):
            tau = 0.0
        cna *= 1 + tau

        # CP position
        x = self.mac_lead + self.calculate_cp_pos(conditions) * self.mac_length

        # roll forcing, reduced above stall
        forces.set_croll_force((self.mac_span + r) * cna1 * (1 + tau) * self.cant_angle / conditions.get_ref_length())
        if conditions.get_aoa() > STALL_ANGLE:
            forces.set_croll_force(forces.get_croll_force() * mu.clamp(
                1 - (conditions.get_aoa() - STALL_ANGLE) / (STALL_ANGLE / 2), 0, 1))
        forces.set_croll_damp(self.calculate_damping_moment(conditions))
        forces.set_croll(forces.get_croll_force() - forces.get_croll_damp())

        forces.set_cn(cna * mu.min_(conditions.get_aoa(), STALL_ANGLE))
        forces.set_cp(Coordinate(x, 0, 0, cna))
        forces.set_cm(forces.get_cn() * x / conditions.get_ref_length())

        # side force and yaw moment are not computed (OpenRocket TODO)
        forces.set_cside(0.0)
        forces.set_cyaw(0.0)

    def get_mac_length(self) -> float:
        return self.mac_length

    def get_midchord_pos(self) -> float:
        return self.mac_lead + 0.5 * self.mac_length

    # ----------------------------------------------------------- geometry
    def calculate_fin_geometry(self, component) -> None:
        span = self.span = component.get_span()
        self.fin_area = component.get_planform_area()
        if self.fin_area < mu.EPSILON:
            self.geometry_warnings.append("ZERO_AREA_FIN")
            self.ar = 0.0
        else:
            self.ar = 2 * pow2(span) / self.fin_area

        # geometry warnings (points along the root not considered)
        points = compat.fin_points(component)
        self.geometry_warnings.clear()
        down = False
        for i in range(1, len(points)):
            if points[i].y > points[i - 1].y + 0.001 and down:
                self.geometry_warnings.append("JAGGED_EDGED_FIN")
                break
            if points[i].y < points[i - 1].y - 0.001:
                down = True
        if self.body_radius > 0 and self.thickness > self.body_radius / 2:
            self.geometry_warnings.append("THICK_FIN")

        # chord lead/trail positions and lengths, root included
        points = compat.fin_points(component, with_root=True)
        chord_lead = self.chord_lead
        chord_trail = self.chord_trail
        chord_length = self.chord_length
        for i in range(DIVISIONS):
            chord_lead[i] = math.inf
            chord_trail[i] = -math.inf
            chord_length[i] = 0.0

        for point in range(1, len(points)):
            x1 = points[point - 1].x
            y1 = points[point - 1].y
            x2 = points[point].x
            y2 = points[point].y

            # not the default EPSILON: too small, numerically unstable below
            if mu.equals(y1, y2, 0.001):
                continue

            i1 = _java_int(mu.jdiv(y1 * 1.0001, span) * (DIVISIONS - 1))
            i2 = _java_int(mu.jdiv(y2 * 1.0001, span) * (DIVISIONS - 1))
            i1 = mu.clamp(i1, 0, DIVISIONS - 1)
            i2 = mu.clamp(i2, 0, DIVISIONS - 1)
            if i1 > i2:
                i1, i2 = i2, i1

            for i in range(i1, i2 + 1):
                y = i * span / (DIVISIONS - 1)
                x = mu.clamp((y - y2) / (y1 - y2) * x1 + (y1 - y) / (y1 - y2) * x2,
                             min(x1, x2), max(x1, x2))
                if x < chord_lead[i]:
                    chord_lead[i] = x
                if x > chord_trail[i]:
                    chord_trail[i] = x
                if y1 < y2:
                    chord_length[i] -= x
                else:
                    chord_length[i] += x

        for i in range(DIVISIONS):
            if (math.isinf(chord_lead[i]) or math.isinf(chord_trail[i])
                    or math.isnan(chord_lead[i]) or math.isnan(chord_trail[i])):
                chord_lead[i] = 0.0
                chord_trail[i] = 0.0
            if chord_length[i] < 0 or math.isnan(chord_length[i]):
                chord_length[i] = 0.0
            if chord_length[i] > chord_trail[i] - chord_lead[i]:
                chord_length[i] = chord_trail[i] - chord_lead[i]

        mac_length = mac_lead = mac_span = 0.0
        cos_gamma = cos_gamma_lead = 0.0
        roll_sum = 0.0
        area = 0.0
        radius = compat.as_coordinate(component.get_fin_front()).y
        dy = span / (DIVISIONS - 1)
        for i in range(DIVISIONS):
            length = chord_trail[i] - chord_lead[i]
            y = i * dy
            mac_length += length * length
            mac_span += y * length
            mac_lead += chord_lead[i] * length
            area += length
            roll_sum += chord_length[i] * pow2(radius + y)
            if i > 0:
                dx = (chord_trail[i] + chord_lead[i]) / 2 - (chord_trail[i - 1] + chord_lead[i - 1]) / 2
                hyp = mu.hypot(dx, dy)
                if hyp != 0:
                    cos_gamma += dy / hyp
                dx = chord_lead[i] - chord_lead[i - 1]
                hyp = mu.hypot(dx, dy)
                if hyp != 0:
                    cos_gamma_lead += dy / hyp

        mac_length *= dy
        mac_span *= dy
        mac_lead *= dy
        area *= dy
        roll_sum *= dy
        if area > mu.EPSILON:
            mac_length /= area
            mac_span /= area
            mac_lead /= area
        else:
            mac_length = mac_span = mac_lead = 0.0
        cos_gamma /= DIVISIONS - 1
        cos_gamma_lead /= DIVISIONS - 1

        self.mac_length, self.mac_lead, self.mac_span = mac_length, mac_lead, mac_span
        self.cos_gamma, self.cos_gamma_lead, self.roll_sum = cos_gamma, cos_gamma_lead, roll_sum

    # --------------------------------------------------------------- CNa1
    def calculate_fin_cna1(self, conditions) -> float:
        mach = conditions.get_mach()
        ref = conditions.get_ref_area()
        alpha = mu.min_(conditions.get_aoa(), math.pi - conditions.get_aoa(), STALL_ANGLE)
        span, fin_area, cos_gamma = self.span, self.fin_area, self.cos_gamma

        if fin_area < mu.EPSILON or span < mu.EPSILON or cos_gamma < mu.EPSILON:
            return 0.0

        if mach <= CNA_SUBSONIC:
            return 2 * math.pi * pow2(span) / (1 + mu.safe_sqrt(1 + (1 - pow2(mach))
                                                                * pow2(pow2(span) / (fin_area * cos_gamma)))) / ref

        if mach >= CNA_SUPERSONIC:
            return fin_area * (K1.get_value(mach) + K2.get_value(mach) * alpha
                               + K3.get_value(mach) * pow2(alpha)) / ref

        # transonic: interpolate
        sq = mu.safe_sqrt(1 + (1 - pow2(CNA_SUBSONIC)) * pow2(span * span / (fin_area * cos_gamma)))
        sub_v = 2 * math.pi * pow2(span) / ref / (1 + sq)
        sub_d = 2 * mach * math.pi * math.pow(span, 6) / (pow2(fin_area * cos_gamma) * ref * sq * pow2(1 + sq))
        super_v = fin_area * (K1.get_value(CNA_SUPERSONIC) + K2.get_value(CNA_SUPERSONIC) * alpha
                              + K3.get_value(CNA_SUPERSONIC) * pow2(alpha)) / ref
        super_d = -fin_area / ref * 2 * CNA_SUPERSONIC / CNA_SUPERSONIC_B
        return CNA_INTERPOLATOR.interpolate(mach, sub_v, super_v, sub_d, super_d, 0)

    # -------------------------------------------------------- roll damping
    def calculate_damping_moment(self, conditions) -> float:
        roll_rate = conditions.get_roll_rate()
        if abs(roll_rate) < 0.1:
            return 0.0
        mach = conditions.get_mach()
        abs_rate = abs(roll_rate)
        span, body_radius = self.span, self.body_radius
        velocity = conditions.get_velocity()

        # fin tips well above stall (near apogee): sum the chords separately
        if mu.jdiv(abs_rate * (body_radius + span), velocity) > 15 * math.pi / 180:
            s = 0.0
            for i in range(DIVISIONS):
                dist = body_radius + span * i / DIVISIONS
                aoa = _jmin(mu.jdiv(abs_rate * dist, velocity), 15 * math.pi / 180)
                s += self.chord_length[i] * dist * aoa
            s = s * (span / DIVISIONS) * 2 * math.pi / conditions.get_beta() / (
                conditions.get_ref_area() * conditions.get_ref_length())
            return mu.sign(roll_rate) * s

        if mach <= CNA_SUBSONIC:
            return mu.jdiv(2 * math.pi * roll_rate * self.roll_sum,
                           conditions.get_ref_area() * conditions.get_ref_length() * velocity * conditions.get_beta())

        if mach >= CNA_SUPERSONIC:
            k1 = K1.get_value(mach)
            k2 = K2.get_value(mach)
            k3 = K3.get_value(mach)
            s = 0.0
            for i in range(DIVISIONS):
                y = i * span / (DIVISIONS - 1)
                angle = mu.jdiv(roll_rate * (body_radius + y), velocity)
                s += (k1 * angle + k2 * angle * angle + k3 * angle * angle * angle) * self.chord_length[i] * (
                    body_radius + y)
            return s * span / (DIVISIONS - 1) / (conditions.get_ref_area() * conditions.get_ref_length())

        # transonic: linear interpolation
        cond = conditions.clone()
        cond.set_mach(CNA_SUBSONIC - 0.01)
        subsonic = self.calculate_damping_moment(cond)
        cond.set_mach(CNA_SUPERSONIC + 0.01)
        supersonic = self.calculate_damping_moment(cond)
        return (subsonic * (CNA_SUPERSONIC - mach) / (CNA_SUPERSONIC - CNA_SUBSONIC)
                + supersonic * (mach - CNA_SUBSONIC) / (CNA_SUPERSONIC - CNA_SUBSONIC))

    def calculate_cp_pos(self, cond) -> float:
        return calculate_cp_pos(cond, self.ar, self.poly)

    # ---------------------------------------------------------------- drag
    def calculate_friction_cd(self, conditions, component_cf, warnings) -> float:
        if self.fin_area < mu.EPSILON or self.mac_length < mu.EPSILON:
            return 0.0
        return component_cf * (1 + 2 * self.thickness / self.mac_length) * 2 * self.fin_area / conditions.get_ref_area()

    def calculate_pressure_cd(self, conditions, stagnation_cd, base_cd, warnings) -> float:
        if self.fin_area < mu.EPSILON:
            return 0.0
        mach = conditions.get_mach()
        xs = self.cross_section
        # pressure fore-drag
        if xs in ("AIRFOIL", "ROUNDED"):
            if mach < 0.9:
                cd = mu.jpow(1 - pow2(mach), -0.417) - 1
            elif mach < 1:
                cd = 1 - 1.785 * (mach - 0.9)
            else:
                cd = 1.214 - 0.502 / pow2(mach) + 0.1095 / pow2(pow2(mach))
        elif xs == "SQUARE":
            cd = stagnation_cd
        else:
            raise NotImplementedError(f"Unsupported fin profile: {xs}")

        cd *= pow2(self.cos_gamma_lead)  # slanted leading edge

        # trailing edge drag (airfoil assumed to have none)
        if xs == "SQUARE":
            cd += base_cd
        elif xs == "ROUNDED":
            cd += base_cd / 2

        cd *= self.span * self.thickness / conditions.get_ref_area()
        return cd

    # -------------------------------------------------------- interference
    def calculate_interference_fin_count(self, component) -> None:
        parent = compat.get_parent(component)
        if parent is None:
            raise RuntimeError("fin set without parent component")
        lead = compat.to_relative_x(component, Coordinate.NUL, parent)  # type: ignore[attr-defined]
        trail = compat.to_relative_x(component, Coordinate(component.get_length()), parent)

        # counting fails for a very small root chord; assume only this fin set
        if trail - lead < 0.007:
            self.interference_fin_count = self.fin_count
        else:
            self.interference_fin_count = 0
            for c in compat.get_children(parent):
                if compat.is_a(c, "FinSet"):
                    fin_lead = compat.to_relative_x(c, Coordinate.NUL, parent)  # type: ignore[attr-defined]
                    fin_trail = compat.to_relative_x(c, Coordinate(c.get_length()), parent)
                    if fin_lead < trail - 0.005 and fin_trail > lead + 0.005:
                        self.interference_fin_count += int(c.get_fin_count())

        if self.interference_fin_count < self.fin_count:
            raise RuntimeError(f"Counted {self.interference_fin_count} parallel fins, when component itself "
                               f"has {self.fin_count}")


def _java_int(v: float) -> int:
    """(int) cast: truncation toward zero, NaN -> 0, saturating."""
    if math.isnan(v):
        return 0
    if math.isinf(v):
        return 2**31 - 1 if v > 0 else -(2**31)
    return int(v)


def _jmin(a: float, b: float) -> float:
    """Math.min: NaN if either is NaN."""
    if math.isnan(a) or math.isnan(b):
        return math.nan
    return a if a <= b else b
