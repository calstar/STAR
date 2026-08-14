"""Drift: zero-wind, the constant-wind identity, and altitude weighting."""

from physics.drift import compute_drift
from physics.schema import Config, Device, Site, Trigger, TriggerKind, Vehicle
from physics.solver import integrate
from physics.site import FAR_ELEV_M
from physics.wind import WindProfile

# ISA temperature at the FAR pad, keeping the eq (7) re-fit the identity.
FAR_ISA_T = 284.1854


def _run(h_a=3000.0):
    """A drogue-then-main descent from `h_a`, so there is a fast high-altitude
    phase and a slow low-altitude one -- which is what the weighting test needs.
    """
    cfg = Config(
        vehicle=Vehicle(m=5.67, h_a=h_a, d_body=0.1016, l_body=1.44),
        site=Site(T_pad=FAR_ISA_T),
        devices=[
            Device(name="drogue", CdS=0.3, D0=0.6, m_c=0.05,
                   trigger=Trigger(kind=TriggerKind.TIME, value=1.0)),
            Device(name="main", CdS=6.0, D0=2.4, m_c=0.3,
                   trigger=Trigger(kind=TriggerKind.ALTITUDE, value=300.0)),
        ],
    )
    return integrate(cfg, "axial")


def test_zero_wind_gives_zero_drift():
    run = _run()
    d = compute_drift(run, WindProfile.constant(0.0, 0.0))
    assert d.distance == 0.0
    assert abs(d.x[-1]) < 1e-12 and abs(d.y[-1]) < 1e-12


def test_constant_wind_drift_equals_speed_times_descent_time():
    run = _run()
    speed, direction = 7.0, 270.0  # a westerly, blowing toward the east
    d = compute_drift(run, WindProfile.constant(speed, direction))
    # With a uniform wind the integral collapses to speed * descent_time, and
    # the canopy heads the way the wind blows (east, bearing 90).
    assert abs(d.distance - speed * run.t_ground) < 1e-6
    assert abs(d.bearing_deg - 90.0) < 1e-6
    # Drift is due east: +x, ~zero y.
    assert d.x[-1] > 0.0
    assert abs(d.y[-1]) < 1e-6


def test_low_altitude_wind_drifts_more_than_high_altitude_wind():
    run = _run()
    # Same speed, placed in the bottom 300 m (under the slow main) vs the top,
    # both zero elsewhere. The main dwells low, so the low wind wins.
    low = WindProfile.from_grid(
        [FAR_ELEV_M, FAR_ELEV_M + 300.0, FAR_ELEV_M + 400.0],
        [5.0, 5.0, 0.0], [0.0, 0.0, 0.0])
    high = WindProfile.from_grid(
        [FAR_ELEV_M + 2600.0, FAR_ELEV_M + 2700.0, FAR_ELEV_M + 3000.0],
        [0.0, 5.0, 5.0], [0.0, 0.0, 0.0])
    d_low = compute_drift(run, low)
    d_high = compute_drift(run, high)
    assert d_low.distance > d_high.distance


def test_track_starts_at_pad_and_matches_trajectory_length():
    run = _run()
    d = compute_drift(run, WindProfile.constant(5.0, 180.0))
    assert d.x[0] == 0.0 and d.y[0] == 0.0
    assert len(d.x) == len(run.traj.t) == len(d.z)
