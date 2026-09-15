"""The drawn chamber must actually hold the commanded L* x A_t.

Guards the convergent-volume term in chamber_length_calc. The old form used
(eps^(1/3) - 1) instead of (eps^(3/2) - 1), understating the cone by ~18x at
typical contraction ratios and padding the barrel to compensate.
"""
import math
import numpy as np
import pytest

from engine.core.chamber_geometry import (
    chamber_length_calc,
    contraction_length_horizontal_calc,
    theta_default,
)


def _tangency_radius(R_t, theta):
    """Radius where the 1.5*R_t entrance arc is tangent to a cone of half-angle theta."""
    return R_t * (1.0 + 1.5 * (1.0 - math.cos(theta)))


def _drawn_volume(L_cyl, L_con, R_c, R_t, theta, n=200001):
    """Volume of the solid of revolution ACTUALLY generated: cylinder, cone to the arc
    tangency radius, then the 1.5*R_t entrance arc down to the throat.

    This used to draw a straight cone all the way to R_t, which is not what the generator
    makes -- so it reproduced the very convention the volume arithmetic got wrong and could
    not catch the entrance-arc bug. See the real-contour tests at the bottom of this file.
    """
    r_tan = _tangency_radius(R_t, theta)
    x1 = np.linspace(0.0, L_cyl, n // 3)
    r1 = np.full_like(x1, R_c)
    x2 = np.linspace(L_cyl, L_cyl + L_con, n // 3)
    r2 = R_c + (r_tan - R_c) * (x2 - L_cyl) / L_con
    t = np.linspace(-(math.pi / 2 + theta), -math.pi / 2, n // 3)
    x3 = 1.5 * R_t * np.cos(t)
    x3 = x3 - x3[0] + (L_cyl + L_con)
    r3 = 1.5 * R_t * np.sin(t) + 2.5 * R_t
    x = np.concatenate([x1, x2, x3])
    r = np.concatenate([r1, r2, r3])
    trapz = getattr(np, "trapezoid", None) or np.trapz
    return float(trapz(math.pi * r * r, x))


@pytest.mark.parametrize("D_c,Lstar", [
    (0.127, 1.30), (0.127, 1.00), (0.127, 0.80),
    (0.1143, 1.00), (0.1397, 1.00), (0.1524, 1.20),
])
@pytest.mark.parametrize("theta", [math.radians(30.0), math.radians(45.0)])
def test_drawn_volume_matches_commanded_lstar(D_c, Lstar, theta):
    A_t = 0.0018729167346808366
    A_c = math.pi / 4 * D_c ** 2
    R_c, R_t = D_c / 2, math.sqrt(A_t / math.pi)
    V_cmd = Lstar * A_t

    L_cyl = chamber_length_calc(V_cmd, A_t, A_c / A_t, theta)
    L_con = contraction_length_horizontal_calc(A_c, _tangency_radius(R_t, theta), theta)
    assert L_cyl > 0, "degenerate case: no cylindrical section"

    V_drawn = _drawn_volume(L_cyl, L_con, R_c, R_t, theta)
    # 0.1 % covers trapezoid discretisation only
    assert V_drawn == pytest.approx(V_cmd, rel=1e-3), (
        f"drawn L* = {V_drawn / A_t:.4f} but {Lstar} was commanded"
    )


def test_old_exponent_would_fail():
    """The pre-fix formula overshoots by ~10 % -- proves this test has teeth."""
    A_t = 0.0018729167346808366
    D_c = 0.127
    A_c = math.pi / 4 * D_c ** 2
    eps = A_c / A_t
    R_t = math.sqrt(A_t / math.pi)
    V_cmd = 1.30 * A_t

    old_L_cyl = (V_cmd / A_t - (1 / 3) * R_t * (1 / math.tan(theta_default))
                 * (eps ** (1 / 3) - 1)) / eps
    L_con = contraction_length_horizontal_calc(
        A_c, _tangency_radius(R_t, theta_default), theta_default)
    V_old = _drawn_volume(old_L_cyl, L_con, D_c / 2, R_t, theta_default)
    assert V_old / V_cmd > 1.05, "old formula should overshoot volume by >5 %"


# ---------------------------------------------------------------------------------------
# The tests above integrate a SYNTHETIC contour (cylinder + straight cone to R_t). That is
# a valid guard for the eps exponent, but it reproduces the generator's old convention and
# therefore could never catch the second volume bug: the cone does not reach R_t, it reaches
# the tangency radius of the 1.5*R_t entrance arc, and the arc carries its own volume.
# Layer 1 passed R_throat as the entrance radius and chamber_length_calc credited a straight
# frustum all the way down, so chambers were drawn 3.7-10.2% over the commanded L*.
#
# These tests integrate the REAL generated contour instead. That is the only thing that can
# catch a disagreement between what the volume arithmetic assumes and what actually gets drawn.
# ---------------------------------------------------------------------------------------

from engine.core.chamber_geometry import (  # noqa: E402
    chamber_geometry_calc,
    area_throat_calc,
    entrance_arc_volume,
    force_coeffcient_default,
)

_PC, _F, _D_EXIT = 2.965e6, 8000.0, 0.1165


def _real_drawn_lstar(D_c: float, Lstar: float, theta: float) -> float:
    """L* of the contour chamber_geometry_calc ACTUALLY generates, face to throat."""
    pts, _, _ = chamber_geometry_calc(
        pc_design=_PC, thrust_design=_F, diameter_inner=D_c,
        diameter_exit=_D_EXIT, l_star=Lstar, steps=3000, theta=theta)
    p = np.asarray(pts)
    throat = int(np.argmin(p[:, 1]))
    seg = p[:throat + 1]
    trapz = getattr(np, "trapezoid", None) or np.trapz
    vol = float(trapz(math.pi * seg[:, 1] ** 2, seg[:, 0]))
    return vol / area_throat_calc(_PC, _F, force_coeffcient_default)


@pytest.mark.parametrize("Lstar", [0.85, 1.00, 1.15, 1.30])
@pytest.mark.parametrize("theta_deg", [45.0, 40.0, 35.0, 30.0])
def test_generated_contour_has_the_commanded_lstar(Lstar, theta_deg):
    """The chamber that gets DRAWN must hold the volume that was asked for."""
    drawn = _real_drawn_lstar(0.127, Lstar, math.radians(theta_deg))
    rel = abs(drawn - Lstar) / Lstar
    assert rel < 2.0e-3, (
        f"commanded L* = {Lstar} at theta = {theta_deg} deg, but the generated contour "
        f"integrates to L* = {drawn:.4f} ({rel*100:+.2f}%). The volume arithmetic in "
        f"chamber_length_calc disagrees with what chamber_geometry_calc draws."
    )


def test_entrance_arc_volume_is_not_negligible():
    """Guard the guard: if the arc term were dropped the test above must fail, not pass."""
    A_t = area_throat_calc(_PC, _F, force_coeffcient_default)
    R_t = math.sqrt(A_t / math.pi)
    V_arc = entrance_arc_volume(R_t, math.radians(45.0))
    # at L* = 1.0 the whole chamber is 1.0 * A_t; the arc is a per-cent-level slice of it
    frac = V_arc / (1.0 * A_t)
    assert 0.005 < frac < 0.10, (
        f"entrance arc is {frac*100:.2f}% of a L*=1.0 chamber - outside the range that makes "
        f"this correction meaningful; check entrance_arc_volume()"
    )


def test_tangency_radius_is_above_the_throat():
    """r_tan = R_t(1 + 1.5(1-cos theta)) must exceed R_t, or the cone would run past the arc."""
    for deg in (25.0, 30.0, 45.0):
        f = 1.0 + 1.5 * (1.0 - math.cos(math.radians(deg)))
        assert f > 1.0, f"tangency factor {f} at {deg} deg is not above the throat radius"
    assert abs((1.0 + 1.5 * (1.0 - math.cos(math.radians(45.0)))) - 1.43934) < 1e-4
