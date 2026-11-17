"""orweb.aero against closed forms, on hand-built stand-in components.

These do not need the component model: each stand-in carries just the
accessors a calc reads. The expectations are textbook results the port must
reduce to (Barrowman's cone and fin CNa, the turbulent skin-friction formula),
computed here independently of the port's code paths -- plus OpenRocket's own
constants where there is no textbook value. The golden comparison
(test_aero_golden.py) is the real check; these localise a failure.
"""

from __future__ import annotations

import math

import pytest

from orweb.aero import FlightConditions
from orweb.aero.barrowman import FinSetCalc, SymmetricComponentCalc
from orweb.aero.barrowman_calculator import BarrowmanCalculator, calculate_axial_cd
from orweb.aero.coordinate import IDENTITY, Coordinate, Transformation
from orweb.aero.forces import AerodynamicForces
from orweb.aero.interpolators import LinearInterpolator, PolyInterpolator

REL = 1e-9


class Transition:  # stand-in; class name is what the calc type-tests
    def __init__(self, length, r0, r1):
        self.L, self.r0, self.r1 = length, r0, r1

    def get_length(self): return self.L
    def get_fore_radius(self): return self.r0
    def get_aft_radius(self): return self.r1
    def get_radius(self, x): return self.r0 + (self.r1 - self.r0) * x / self.L

    def get_full_volume(self):
        return math.pi * self.L / 3 * (self.r0 ** 2 + self.r0 * self.r1 + self.r1 ** 2)

    def get_component_planform_area(self): return self.L * (self.r0 + self.r1)

    def get_component_planform_center(self):
        a, b = self.r0, self.r1
        return self.L * (a + 2 * b) / (3 * (a + b))

    def get_component_wet_area(self):
        return math.pi * (self.r0 + self.r1) * math.hypot(self.L, self.r1 - self.r0)

    def get_shape_type(self): return "CONICAL"
    def get_shape_parameter(self): return 0.0


class BodyTube:
    def __init__(self, x, length, r, fins=()):
        self.x, self.L, self.r, self.children = x, length, r, list(fins)

    def get_component_locations(self): return [Coordinate(self.x, 0, 0)]
    def get_children(self): return self.children


class TrapezoidFinSet:
    def __init__(self, parent, n, root, tip, sweep, span, thickness=0.003):
        self.parent, self.n = parent, n
        self.root, self.tip, self.sweep, self.span, self.t = root, tip, sweep, span, thickness
        parent.children.append(self)

    def get_thickness(self): return self.t
    def get_body_radius(self): return self.parent.r
    def get_fin_count(self): return self.n
    def get_cant_angle(self): return 0.0
    def get_span(self): return self.span
    def get_planform_area(self): return (self.root + self.tip) / 2 * self.span
    def get_cross_section(self): return "SQUARE"
    def get_length(self): return self.root
    def get_parent(self): return self.parent

    def get_fin_points(self):
        return [Coordinate(0, 0), Coordinate(self.sweep, self.span),
                Coordinate(self.sweep + self.tip, self.span), Coordinate(self.root, 0)]

    def get_fin_points_with_root(self):
        return self.get_fin_points() + [Coordinate(0, 0)]

    def get_fin_front(self): return Coordinate(0, self.parent.r)
    def get_component_locations(self): return [Coordinate(self.parent.x + self.parent.L - self.root, 0, 0)]


def conditions(mach, aoa, ref_length):
    fc = FlightConditions()
    fc.set_ref_length(ref_length)
    fc.set_mach(mach)
    fc.set_aoa(aoa)
    return fc


def test_cone_cna_is_two_and_cp_two_thirds():
    """Barrowman: a cone's CNa is 2 (on its base area) and its CP is 2/3 of its length."""
    L, R = 0.12, 0.02
    calc = SymmetricComponentCalc(Transition(L, 0.0, R))
    f = AerodynamicForces().zero()
    calc.calculate_nonaxial_forces(conditions(0.3, 0.0, 2 * R), IDENTITY, f, [])
    cp = f.get_cp()
    assert cp.weight == pytest.approx(2.0, rel=REL)
    assert cp.x == pytest.approx(2 * L / 3, rel=REL)


def test_frustum_cp_closed_form():
    """Barrowman's transition CP: x = L/3 (1 + (1 - r0/r1) / (1 - (r0/r1)^2))."""
    L, r0, r1 = 0.05, 0.01, 0.02
    calc = SymmetricComponentCalc(Transition(L, r0, r1))
    f = AerodynamicForces().zero()
    calc.calculate_nonaxial_forces(conditions(0.3, 0.0, 2 * r1), IDENTITY, f, [])
    q = r0 / r1
    assert f.get_cp().x == pytest.approx(L / 3 * (1 + (1 - q) / (1 - q * q)), rel=REL)
    assert f.get_cp().weight == pytest.approx(2 * (1 - q * q), rel=REL)


def test_body_lift_is_galejs():
    """Body lift: K * A_planform / A_ref * sin^2(aoa) / aoa, at the planform centroid."""
    L, R, aoa = 0.3, 0.02, math.radians(6)
    calc = SymmetricComponentCalc(Transition(L, R, R))
    f = AerodynamicForces().zero()
    calc.calculate_nonaxial_forces(conditions(0.3, aoa, 2 * R), IDENTITY, f, [])
    assert f.get_cp().weight == pytest.approx(1.1 * (2 * R * L) / (math.pi * R * R) * math.sin(aoa) ** 2 / aoa,
                                              rel=REL)
    assert f.get_cp().x == pytest.approx(L / 2, rel=REL)


@pytest.mark.parametrize("n", [3, 4])
def test_fins_reduce_to_barrowman_at_mach_zero(n):
    """Diederich at M=0 summed over n fins at sin^2 weights is Barrowman's
    (1 + R/(s+R)) 4n(s/d)^2 / (1 + sqrt(1 + (2 l/(a+b))^2)), CP at the MAC quarter chord."""
    R, root, tip, sweep, span = 0.025, 0.08, 0.04, 0.03, 0.06
    body = BodyTube(0.2, 0.3, R)
    fins = TrapezoidFinSet(body, n, root, tip, sweep, span)
    calc = FinSetCalc(fins)
    fc = conditions(0.0, 0.0, 2 * R)
    total = AerodynamicForces().zero()
    for i in range(n):
        f = AerodynamicForces().zero()
        calc.calculate_nonaxial_forces(fc, Transformation.rotate_x(2 * math.pi * i / n), f, [])
        total.merge(f)
    lm = math.hypot(sweep + tip / 2 - root / 2, span)
    d = 2 * R
    expect = (1 + R / (span + R)) * 4 * n * (span / d) ** 2 / (1 + math.sqrt(1 + (2 * lm / (root + tip)) ** 2))
    assert total.get_cp().weight == pytest.approx(expect, rel=REL)
    # MAC leading edge and length of a trapezoid
    mac = 2 / 3 * (root + tip - root * tip / (root + tip))
    xmac = sweep * (root + 2 * tip) / (3 * (root + tip))
    # OpenRocket sums 48 strips end-points included (a rectangle rule), not the integral:
    # its MAC is ~0.2% off the analytic one, so only the CNa is held at 1e-9 here.
    assert total.get_cp().x == pytest.approx(xmac + 0.25 * mac, rel=5e-3)


def test_turbulent_skin_friction_formula():
    """Cf = 1/(1.5 ln Re - 5.6)^2, times (1 - 0.1 M^2) subsonic."""
    class Rocket:
        def is_perfect_finish(self): return False

    class Cfg:
        def get_rocket(self): return Rocket()

    re, m = 2.0e6, 0.5
    cf = BarrowmanCalculator.calculate_friction_coefficient(Cfg(), m, re)
    assert cf == pytest.approx((1 - 0.1 * m * m) / (1.5 * math.log(re) - 5.6) ** 2, rel=REL)


def test_axial_drag_multiplier_hits_its_knots():
    fc = conditions(0.3, 0.0, 1.0)
    assert calculate_axial_cd(fc, 0.5) == pytest.approx(0.5, rel=REL)
    fc.set_aoa(17 * math.pi / 180)
    assert calculate_axial_cd(fc, 0.5) == pytest.approx(0.65, rel=REL)
    fc.set_aoa(math.pi / 2)
    assert abs(calculate_axial_cd(fc, 0.5)) < 1e-12


def test_poly_interpolator_is_hermite():
    poly = PolyInterpolator([0.0, 1.0], [0.0, 1.0]).interpolator(1.0, 3.0, 0.5, -2.0)
    p = lambda x: PolyInterpolator.eval(x, poly)  # noqa: E731
    h = 1e-6
    assert p(0.0) == pytest.approx(1.0) and p(1.0) == pytest.approx(3.0)
    assert (p(h) - p(-h)) / (2 * h) == pytest.approx(0.5, rel=1e-6)
    assert (p(1 + h) - p(1 - h)) / (2 * h) == pytest.approx(-2.0, rel=1e-6)


def test_linear_interpolator_clamps_and_interpolates():
    li = LinearInterpolator([1.0, 2.0, 4.0], [10.0, 20.0, 0.0])
    assert li.get_value(0.0) == 10.0
    assert li.get_value(9.0) == 0.0
    assert li.get_value(3.0) == pytest.approx(10.0)
    assert li.get_value(2.0) == 20.0


def test_default_atmosphere_is_openrockets():
    """FlightConditions' default air: 293.15 K, 101325 Pa, a = 165.77 + 0.606 T."""
    fc = FlightConditions()
    fc.set_mach(1.0)
    assert fc.get_velocity() == pytest.approx(165.77 + 0.606 * 293.15, rel=REL)
