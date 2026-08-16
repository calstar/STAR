"""RocketPy ascent assembly: a stable rocket produces a sane 6-DOF flight.

Skipped without rocketpy (optional dep). Tests ``run_flight`` with explicit geometry
so no Onshape store/fixtures are needed. Not a physics-accuracy check (drag/inertia are
stubs) -- it guards that the assembly runs and the outputs are well-formed and bounded.
"""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("rocketpy")

from backend.motors.motor import Motor  # noqa: E402
from backend.onshape.aero.rocketpy_flight import RocketGeom, run_flight  # noqa: E402
from physics.atmosphere import Atmosphere  # noqa: E402
from physics.wind import WindProfile  # noqa: E402

#: The pad elevation `_run` launches from; the shared-env objects live on the same grid.
_ELEV = 1400.0


def _motor() -> Motor:
    t = list(np.linspace(0, 2.0, 20))
    thrust = [600.0 if x < 1.8 else 0.0 for x in t]
    mass = [0.5 - 0.3 * (x / 1.8) if x < 1.8 else 0.2 for x in t]
    cg = [0.15] * len(t)
    return Motor(
        manufacturer="X", designation="K600", diameter=0.038, length=0.3, delays=[],
        motor_type="SINGLE", time=t, thrust=thrust, cg_x=cg, mass=mass, digest="d",
    )


def _stable_geom() -> RocketGeom:
    # CG well forward of the fins -> statically stable.
    return RocketGeom(
        radius=0.05, nose_length=0.3, nose_kind="ogive", body_length=1.6,
        mass_without_motor=4.0, cg_from_nose=0.8, fins=(4, 0.12, 0.06, 0.06, 0.06, 1.5),
    )


def _run(**kw):
    return run_flight(
        _stable_geom(), _motor(), motor_position_from_nose=1.5, rail_length=3.0,
        inclination=88, heading=0, elevation=_ELEV, our_margin_fn=lambda t, m: 2.0, **kw,
    )


def _wind(speed: float, direction: float = 270.0) -> WindProfile:
    return WindProfile.constant(speed, direction, site_elev=_ELEV)


def test_stable_flight_is_well_formed():
    res = _run(wind_profile=_wind(6.0))
    assert res.launch_stable is True
    assert res.apogee > 100.0
    assert 0.0 < res.max_mach < 5.0
    assert res.out_of_rail_velocity > 0.0
    assert res.min_stability_margin > 0.0  # stable throughout
    assert res.max_dynamic_pressure > 0.0
    # series are all the same length and margins overlay is populated.
    n = len(res.times)
    assert n == len(res.stability_margin_rocketpy) == len(res.stability_margin_ours) == len(res.mach)
    assert all(m == 2.0 for m in res.stability_margin_ours)
    # angle of attack stays physical (guarded) -- never exceeds 180 deg.
    assert all(a is None or 0.0 <= a <= 180.0 for a in res.angle_of_attack)


def test_wind_drives_downwind_drift():
    calm = _run(wind_profile=_wind(0.0))
    windy = _run(wind_profile=_wind(8.0))
    assert windy.drift_distance > calm.drift_distance  # wind moves the apogee point


def test_shared_atmosphere_couples_to_apogee():
    """The ascent flies through the same Atmosphere the descent uses, so a warmer
    (thinner) pad column -> less drag -> a measurably higher apogee. This is the
    coupling the Environment tab exists to make real."""
    cold = _run(atmosphere=Atmosphere(_ELEV, T_pad=250.0))
    hot = _run(atmosphere=Atmosphere(_ELEV, T_pad=320.0))
    assert cold.apogee > 100.0 and hot.apogee > 100.0
    assert hot.apogee > cold.apogee
