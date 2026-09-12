"""Coupled descent: lateral velocity at apogee and wind feed the loads + track.

The descent is now a wind-aware coupled point mass. A sideways velocity at apogee
(or a wind) raises the AIR-RELATIVE airspeed at deployment, so the opening load
rises -- most for the drogue, which fires near apogee where the vertical speed is
~0 and the sideways airspeed dominates. And with no wind and no lateral velocity
the run is the old 1-D vertical descent exactly.
"""

from physics.drift import compute_drift
from physics.schema import (
    Config, ConstantWind, Device, Site, Trigger, TriggerKind, Vehicle,
)
from physics.solver import integrate

FAR_ISA_T = 284.1854


def _cfg(v_lat=None, v_lat_dir=None, wind=None, drogue_time=0.5):
    """A drogue-just-after-apogee + main descent, so the drogue sees ~all of the
    sideways airspeed (vertical speed is still small that soon after apogee)."""
    return Config(
        vehicle=Vehicle(m=5.67, h_a=3000.0, d_body=0.1016, l_body=1.44,
                        v_lat=v_lat, v_lat_dir=v_lat_dir),
        site=Site(T_pad=FAR_ISA_T),
        devices=[
            Device(name="drogue", CdS=0.3, D0=0.6, m_c=0.05,
                   trigger=Trigger(kind=TriggerKind.TIME, value=drogue_time)),
            Device(name="main", CdS=6.0, D0=2.4, m_c=0.3,
                   trigger=Trigger(kind=TriggerKind.ALTITUDE, value=300.0)),
        ],
        wind=wind,
    )


def _drogue_v_s(run):
    return run.state_of("drogue").v_s


def test_calm_no_lateral_is_the_1d_descent():
    run = integrate(_cfg(), "axial")
    # No horizontal motion at all, and the drogue deployment airspeed is purely
    # the vertical speed (as in the windless model).
    assert abs(run.traj.x[-1]) < 1e-9 and abs(run.traj.y[-1]) < 1e-9
    assert compute_drift(run).distance == 0.0


def test_lateral_velocity_raises_the_drogue_opening_load():
    calm = integrate(_cfg(v_lat=0.0), "axial")
    fast = integrate(_cfg(v_lat=30.0, v_lat_dir=90.0), "axial")
    # The drogue fires just after apogee, so its airspeed jumps from ~vertical to
    # the resultant of vertical + ~30 m/s sideways: strictly, and a lot, larger.
    assert _drogue_v_s(fast) > _drogue_v_s(calm) + 20.0
    # F_inf ~ 0.5 rho v_s^2, so the opening load scales with v_s^2.


def test_lateral_velocity_shifts_the_landing_downrange():
    east = integrate(_cfg(v_lat=25.0, v_lat_dir=90.0), "axial")   # toward the east
    d = compute_drift(east)
    assert d.x[-1] > 0.0          # carried east
    assert abs(d.y[-1]) < 1.0     # ~no north component
    assert d.distance > 0.0


def test_wind_raises_the_first_opening_load_too():
    calm = integrate(_cfg(wind=None), "axial")
    windy = integrate(_cfg(wind=ConstantWind(speed=20.0, direction=270.0)), "axial")
    # A stationary rocket at apogee sees the wind as air-relative sideways speed,
    # so the drogue opens against it -- the coupled analogue of the mastersheet's
    # "wind added to the first opening speed".
    assert _drogue_v_s(windy) > _drogue_v_s(calm)
