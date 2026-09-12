"""Drift: zero-wind, the near-identity under constant wind, altitude weighting.

Wind now rides on the config and the descent integrates the horizontal track
directly (`solver`), so a vehicle *relaxes* toward the wind over the drag time
rather than matching it instantly. Drift is therefore a hair *under* the old
`speed * descent_time` identity (the vehicle lags the wind before it catches up),
which is the physically correct, slightly-less-conservative direction.
"""

from physics.drift import compute_drift
from physics.schema import (
    Config, ConstantWind, Device, ProfileWind, Site, Trigger, TriggerKind, Vehicle,
)
from physics.solver import integrate
from physics.site import FAR_ELEV_M

# ISA temperature at the FAR pad, keeping the eq (7) re-fit the identity.
FAR_ISA_T = 284.1854


def _run(h_a=3000.0, wind=None):
    """A drogue-then-main descent from `h_a` under `wind` (on the config), so
    there is a fast high-altitude phase and a slow low-altitude one."""
    cfg = Config(
        vehicle=Vehicle(m=5.67, h_a=h_a, d_body=0.1016, l_body=1.44),
        site=Site(T_pad=FAR_ISA_T),
        devices=[
            Device(name="drogue", CdS=0.3, D0=0.6, m_c=0.05,
                   trigger=Trigger(kind=TriggerKind.TIME, value=1.0)),
            Device(name="main", CdS=6.0, D0=2.4, m_c=0.3,
                   trigger=Trigger(kind=TriggerKind.ALTITUDE, value=300.0)),
        ],
        wind=wind,
    )
    return integrate(cfg, "axial")


def test_zero_wind_gives_zero_drift():
    run = _run()
    d = compute_drift(run)
    assert d.distance == 0.0
    assert abs(d.x[-1]) < 1e-12 and abs(d.y[-1]) < 1e-12


def test_constant_wind_drift_is_just_under_speed_times_descent_time():
    speed, direction = 7.0, 270.0  # a westerly, blowing toward the east
    run = _run(wind=ConstantWind(speed=speed, direction=direction))
    d = compute_drift(run)
    ideal = speed * run.t_ground
    # The vehicle relaxes to the wind rather than matching it instantly, so the
    # track is a little short of the equilibrium identity -- but close, because
    # the drag time is short relative to the descent.
    assert 0.90 * ideal < d.distance < ideal
    assert abs(d.bearing_deg - 90.0) < 1e-6      # heads east, the way the wind blows
    assert d.x[-1] > 0.0
    assert abs(d.y[-1]) < 1e-6


def test_low_altitude_wind_drifts_more_than_high_altitude_wind():
    # Same speed placed in the bottom 300 m (under the slow main) vs the top,
    # zero elsewhere. The main dwells low, and the vehicle has time to relax to
    # that low wind, so the low placement wins.
    low = ProfileWind(
        heights_msl=[FAR_ELEV_M, FAR_ELEV_M + 300.0, FAR_ELEV_M + 400.0],
        u=[5.0, 5.0, 0.0], v=[0.0, 0.0, 0.0])
    high = ProfileWind(
        heights_msl=[FAR_ELEV_M + 2600.0, FAR_ELEV_M + 2700.0, FAR_ELEV_M + 3000.0],
        u=[0.0, 5.0, 5.0], v=[0.0, 0.0, 0.0])
    d_low = compute_drift(_run(wind=low))
    d_high = compute_drift(_run(wind=high))
    assert d_low.distance > d_high.distance


def test_track_starts_at_pad_and_matches_trajectory_length():
    run = _run(wind=ConstantWind(speed=5.0, direction=180.0))
    d = compute_drift(run)
    assert d.x[0] == 0.0 and d.y[0] == 0.0
    assert len(d.x) == len(run.traj.t) == len(d.z)
