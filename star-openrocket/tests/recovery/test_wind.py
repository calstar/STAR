"""WindProfile: the meteorological convention, interpolation, RocketPy shape."""

import math

from physics.site import FAR_ELEV_M
from physics.wind import WindProfile, uv_from_speed_dir


# --- meteorological convention: direction is where wind blows FROM ----------


def test_wind_from_north_blows_south():
    # A northerly (from 0 deg) pushes toward the south: v negative, u zero.
    u, v = uv_from_speed_dir(10.0, 0.0)
    assert abs(u) < 1e-12
    assert v == -10.0


def test_wind_from_west_blows_east():
    # A westerly (from 270) pushes toward the east: u positive, v zero.
    u, v = uv_from_speed_dir(10.0, 270.0)
    assert u == 10.0
    assert abs(v) < 1e-12


def test_wind_from_east_blows_west():
    u, v = uv_from_speed_dir(10.0, 90.0)
    assert u == -10.0
    assert abs(v) < 1e-12


# --- constant profile -------------------------------------------------------


def test_constant_is_uniform_with_altitude():
    w = WindProfile.constant(8.0, 270.0)
    for z in (0.0, 500.0, 3000.0):
        assert w.u(z) == 8.0
        assert abs(w.v(z)) < 1e-12
        assert w.speed(z) == 8.0


def test_constant_heading_is_direction_wind_travels():
    # From the west -> travels toward the east -> heading 90 deg.
    w = WindProfile.constant(8.0, 270.0)
    assert abs(w.heading(0.0) - 90.0) < 1e-9


def test_calm_heading_is_zero_not_nan():
    w = WindProfile.constant(0.0, 123.0)
    assert w.speed(0.0) == 0.0
    assert w.heading(0.0) == 0.0


# --- tabulated profile: interpolation and clamping --------------------------


def test_from_grid_interpolates_linearly_in_agl():
    # Heights are MSL; site_elev default is FAR (630 m), so AGL 0 and 1000 map
    # to MSL 630 and 1630. u climbs 0 -> 10, v is flat.
    w = WindProfile.from_grid([FAR_ELEV_M, FAR_ELEV_M + 1000.0],
                              [0.0, 10.0], [0.0, 0.0])
    assert abs(w.u(0.0) - 0.0) < 1e-9
    assert abs(w.u(500.0) - 5.0) < 1e-9
    assert abs(w.u(1000.0) - 10.0) < 1e-9


def test_from_grid_holds_flat_outside_the_band():
    w = WindProfile.from_grid([FAR_ELEV_M, FAR_ELEV_M + 1000.0],
                              [2.0, 10.0], [0.0, 0.0])
    # Below the lowest level and above the highest: held, never extrapolated.
    assert w.u(-100.0) == 2.0
    assert w.u(5000.0) == 10.0


def test_unsorted_grid_is_accepted():
    w = WindProfile.from_grid([FAR_ELEV_M + 1000.0, FAR_ELEV_M],
                              [10.0, 0.0], [0.0, 0.0])
    assert abs(w.u(500.0) - 5.0) < 1e-9


# --- RocketPy handoff -------------------------------------------------------


def test_to_rocketpy_emits_height_value_points_in_msl():
    w = WindProfile.from_grid([FAR_ELEV_M + 1000.0, FAR_ELEV_M],
                              [10.0, 3.0], [-2.0, 1.0])
    wind_u, wind_v = w.to_rocketpy()
    # Ascending MSL height, [height, value] pairs -- the custom_atmosphere form.
    assert wind_u[0] == [FAR_ELEV_M, 3.0]
    assert wind_u[1] == [FAR_ELEV_M + 1000.0, 10.0]
    assert wind_v[0] == [FAR_ELEV_M, 1.0]
    assert wind_v[1] == [FAR_ELEV_M + 1000.0, -2.0]


def test_speed_is_component_magnitude():
    w = WindProfile.from_grid([FAR_ELEV_M], [3.0], [4.0])
    assert abs(w.speed(0.0) - 5.0) < 1e-12
