"""Ascent flight simulation: thrust interpolation, ballistic apogee, and margin-over-time."""

from __future__ import annotations

import pytest

from backend.motors.motor import Motor
from backend.onshape.aero.flight import G0, simulate_ascent, simulate_flight
from backend.onshape.aero.stability import MotorPlacement, compute_stability
from test_aero_stability import StubStore, cone_tube_faces


def make_motor(time, thrust, mass, cg_x, length=0.2, diameter=0.05) -> Motor:
    return Motor(
        manufacturer="Test",
        designation="T1",
        diameter=diameter,
        length=length,
        delays=[],
        motor_type="SINGLE",
        time=list(time),
        thrust=list(thrust),
        cg_x=list(cg_x),
        mass=list(mass),
        digest="",
    )


def test_get_thrust_interpolates_and_zeros_outside_burn():
    m = make_motor([0.0, 1.0, 2.0], [0.0, 10.0, 0.0], [0.1, 0.08, 0.06], [0.1, 0.1, 0.1])
    assert m.get_thrust(0.0) == 0.0
    assert m.get_thrust(0.5) == pytest.approx(5.0)
    assert m.get_thrust(1.0) == pytest.approx(10.0)
    assert m.get_thrust(1.5) == pytest.approx(5.0)
    assert m.get_thrust(2.0) == pytest.approx(0.0)
    assert m.get_thrust(-0.1) == 0.0  # before ignition
    assert m.get_thrust(2.5) == 0.0  # after burnout


def test_ballistic_apogee_invariant():
    # A brisk motor (thrust tapering to 0 at burnout) on a light rocket. After burnout there is
    # no thrust and no drag, so the coast is pure ballistic:
    #   apogee = burnout_altitude + v_burnout^2 / (2g).
    motor = make_motor([0.0, 1.0, 2.0], [0.0, 60.0, 0.0], [0.12, 0.09, 0.06], [0.1, 0.1, 0.1])
    asc = simulate_ascent(motor, mass_cad=0.2)

    assert asc.liftoff is True
    assert asc.apogee > asc.burnout_altitude > 0
    assert asc.burnout_velocity > 0
    predicted = asc.burnout_altitude + asc.burnout_velocity**2 / (2 * G0)
    assert asc.apogee == pytest.approx(predicted, rel=5e-3)
    # No drag, so peak speed is at/after the thrust-weight crossover and >= the burnout speed.
    assert asc.max_velocity >= asc.burnout_velocity > 0


def test_off_rail_velocity_matches_altitude_crossing():
    motor = make_motor([0.0, 1.0, 2.0], [0.0, 60.0, 0.0], [0.12, 0.09, 0.06], [0.1, 0.1, 0.1])
    asc = simulate_ascent(motor, mass_cad=0.2, rail_length=2.0)

    assert asc.rail_cleared is True
    assert asc.rail_exit_time is not None and asc.rail_length == 2.0
    # The reported off-rail velocity is the velocity at altitude == rail length; it is below the
    # burnout velocity (rail is cleared early, before the motor finishes).
    assert 0 < asc.rail_exit_velocity < asc.burnout_velocity
    # Cross-check against the sim's own arrays: v where altitude first reaches the rail length.
    i = next(k for k, h in enumerate(asc.altitude) if h >= 2.0)
    lo = i - 1
    f = (2.0 - asc.altitude[lo]) / (asc.altitude[i] - asc.altitude[lo])
    expected_v = asc.velocity[lo] + (asc.velocity[i] - asc.velocity[lo]) * f
    assert asc.rail_exit_velocity == pytest.approx(expected_v, rel=1e-6)


def test_off_rail_not_cleared_when_apogee_below_rail():
    # A rail taller than the whole flight -> never "off the rail".
    motor = make_motor([0.0, 1.0, 2.0], [0.0, 60.0, 0.0], [0.12, 0.09, 0.06], [0.1, 0.1, 0.1])
    asc = simulate_ascent(motor, mass_cad=0.2, rail_length=1e9)
    assert asc.rail_cleared is False
    assert asc.rail_exit_velocity is None


def test_weak_motor_never_leaves_the_pad():
    motor = make_motor([0.0, 1.0], [1.0, 1.0], [0.05, 0.03], [0.1, 0.1])
    asc = simulate_ascent(motor, mass_cad=5.0)  # ~49 N weight vs 1 N thrust
    assert asc.liftoff is False
    assert asc.apogee == pytest.approx(0.0)
    assert asc.thrust_to_weight < 1.0


def test_static_margin_walks_from_wet_to_dry():
    face, L_nose, L_tube, R = cone_tube_faces()
    store = StubStore([face])
    parts = [{"key": "nose", "mass": 0.5, "centroidWorld": [0, 0, 0.1]}]
    outer = [("occ:body", "F_outer")]

    # Motor with distinct wet/dry mass and CG.
    motor = make_motor([0.0, 2.0], [40.0, 40.0], [0.5, 0.2], [0.15, 0.10])

    # The static snapshot at each end of the burn, via the stability path.
    wet = compute_stability(store, parts, outer, motor=MotorPlacement(0.5, 0.2, 0.15, diameter=0.05))
    dry = compute_stability(store, parts, outer, motor=MotorPlacement(0.2, 0.2, 0.10, diameter=0.05))

    flight = simulate_flight(
        store, parts, outer, motor=motor, placement=MotorPlacement(0.5, 0.2, 0.15, diameter=0.05)
    )

    assert flight.static_margin[0] == pytest.approx(wet.static_margin, rel=1e-6)
    assert flight.static_margin[-1] == pytest.approx(dry.static_margin, rel=1e-6)
