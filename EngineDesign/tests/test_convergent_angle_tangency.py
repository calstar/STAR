"""The convergent cone must meet the 1.5-Rt entrance arc tangentially at ANY angle.

The entrance arc used to be hardcoded ``linspace(-135 deg, -90 deg)``. Its wall slope at
parameter t is -cot(t), so -135 deg is tangency with a 45 deg cone and only a 45 deg cone.
Any other convergent angle met the arc at a corner -- 15 deg of it at theta = 30 -- right
where the gas accelerates hardest into the throat.

``layer1_contraction_half_angle_deg`` made that angle configurable in Layer 1's arithmetic
while the built contour stayed at 45 deg, so the optimiser was scoring a chamber nobody
would build. These tests pin both halves: the default is unchanged, and a non-default angle
produces a tangent wall.
"""
from __future__ import annotations

import numpy as np
import pytest

from engine.core.chamber_geometry import (
    area_exit_calc,
    area_throat_calc,
    chamber_geometry_calc,
    force_coeffcient_default,
    theta_default,
)
from engine.core.nozzle_solver import rao

PC, THRUST, D_EXIT = 2.965e6, 8000.0, 0.1165
ANGLES_DEG = [45.0, 40.0, 35.0, 30.0, 25.0]


def _arc_start_slope_deg(theta_rad: float) -> float:
    """Wall angle of the entrance arc's first segment, in degrees (negative = converging)."""
    a_t = area_throat_calc(PC, THRUST, force_coeffcient_default)
    pts, _, _ = rao(a_t, area_exit_calc(D_EXIT), method="top", do_plot=False,
                    steps=3000, convergent_half_angle_rad=theta_rad)
    p = np.asarray(pts)
    d = p[1] - p[0]
    return float(np.degrees(np.arctan2(d[1], d[0])))


@pytest.mark.parametrize("deg", ANGLES_DEG)
def test_cone_meets_entrance_arc_tangentially(deg):
    """No corner in the wall at the cone -> arc junction, for any convergent angle."""
    kink = abs(_arc_start_slope_deg(np.deg2rad(deg)) - (-deg))
    assert kink < 0.05, f"{deg} deg cone meets the arc with a {kink:.2f} deg corner"


def test_old_hardcoded_arc_would_fail():
    """Guard the guard: pinning the arc at 45 deg must reintroduce the corner.

    Without this, the tangency test above would still pass if someone re-hardcoded the
    arc and every caller happened to ask for 45 deg.
    """
    kink = abs(_arc_start_slope_deg(np.pi / 4.0) - (-30.0))
    assert kink > 14.0, (
        "a 45 deg arc against a 30 deg cone should show ~15 deg of corner; "
        f"got {kink:.2f} deg -- the tangency test is no longer discriminating"
    )


@pytest.mark.parametrize("deg", ANGLES_DEG)
def test_contour_uses_the_requested_angle(deg):
    """The straight convergent section is actually drawn at the requested half-angle."""
    theta = np.deg2rad(deg)
    pts, _, _ = chamber_geometry_calc(
        pc_design=PC, thrust_design=THRUST, diameter_inner=0.1651,
        diameter_exit=D_EXIT, l_star=0.85, steps=600, theta=theta)
    p = np.asarray(pts)
    throat = int(np.argmin(p[:, 1]))
    d = np.diff(p[:throat + 1], axis=0)
    keep = np.abs(d[:, 0]) > 1e-12
    slopes = d[keep, 1] / d[keep, 0]
    # The cone is the longest run of constant negative slope before the arc.
    target = -np.tan(theta)
    on_cone = np.abs(slopes - target) < 1e-6
    assert on_cone.sum() > 10, f"no straight {deg} deg convergent run found in the contour"


def test_default_angle_is_45_degrees():
    """theta_default is load-bearing: it is the value every existing config inherits."""
    assert theta_default == pytest.approx(np.pi / 4.0)


def test_default_call_matches_explicit_45():
    """Omitting theta must be identical to passing 45 deg -- no silent behaviour change."""
    kw = dict(pc_design=PC, thrust_design=THRUST, diameter_inner=0.1651,
              diameter_exit=D_EXIT, l_star=0.85, steps=200)
    a, _, la = chamber_geometry_calc(**kw)
    b, _, lb = chamber_geometry_calc(**kw, theta=np.pi / 4.0)
    assert np.array_equal(np.asarray(a), np.asarray(b))
    assert la == lb
