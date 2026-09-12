"""Vertical ascent simulation: altitude/velocity/acceleration and static margin over time.

A deliberately simple 1-DOF model for the flight-profile popup. Forces are **thrust minus
weight only** -- drag is *not* modelled yet (see the marked hook in ``_integrate``), so the
apogee this returns is an upper bound. Air density / drag arrive when star-openrocket and the
recovery-calculator merge and share one atmosphere. The sim runs from ignition to apogee;
recovery/descent is the recovery-calculator's job.

The static-margin curve reuses the same CoP and motor placement the static stability uses
(``aero_core`` / ``place_motor`` in ``stability.py``): as the motor burns, its mass and CG
(``Motor.get_total_mass`` / ``Motor.get_cmx``) shift, walking the loaded CG -- and thus the
margin -- from the wet value to the dry value over the burn.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ...motors.motor import Motor
from ..geometry_store import GeometryStore
from .axis import Axis
from .stability import MotorPlacement, aero_core, compute_cg, cp_axial_at_mach, place_motor

G0 = 9.80665  # m/s^2, standard gravity
# Speed of sound placeholder: constant sea-level ISA. flight.py has no atmosphere
# yet, so Mach = v / A_SOUND here; swap for ISA a(h)=sqrt(gamma*R*T(h)) when the
# shared atmosphere lands (same merge that adds ascent drag).  ← atmosphere hook
A_SOUND = 340.29  # m/s
_DT = 0.005  # s, integration step
_MAX_T = 300.0  # s, safety cap
_MAX_SAMPLES = 400  # points sent to the client (downsampled)
_DEFAULT_RAIL = 1.0  # m, guided rail length


@dataclass
class _Ascent:
    times: list[float]
    altitude: list[float]
    velocity: list[float]
    acceleration: list[float]
    thrust: list[float]
    mass: list[float]
    apogee: float
    apogee_time: float
    max_velocity: float
    max_acceleration: float
    burnout_time: float
    burnout_altitude: float
    burnout_velocity: float
    liftoff_mass: float
    thrust_to_weight: float
    liftoff: bool
    rail_length: float
    #: Velocity/time when the rocket has travelled the rail length; None if it never gets there.
    rail_exit_velocity: float | None
    rail_exit_time: float | None
    rail_cleared: bool


@dataclass
class FlightResult:
    """Ascent time series plus summary scalars. Masses kg, lengths m, times s."""

    times: list[float]
    altitude: list[float]
    velocity: list[float]
    acceleration: list[float]
    thrust: list[float]
    mass: list[float]
    static_margin: list[float | None]
    #: Mach at each sample (v / A_SOUND), so the client can plot margin vs Mach.
    mach: list[float]
    apogee: float
    apogee_time: float
    max_velocity: float
    max_acceleration: float
    burnout_time: float
    burnout_altitude: float
    burnout_velocity: float
    liftoff_mass: float
    thrust_to_weight: float
    liftoff: bool
    rail_length: float
    rail_exit_velocity: float | None
    rail_exit_time: float | None
    rail_cleared: bool
    #: Minimum static margin over the flight and where it occurs -- the transonic
    #: dip. None when no fins / margin is undefined throughout.
    min_static_margin: float | None = None
    min_margin_time: float | None = None
    min_margin_mach: float | None = None


def _interp(xs: list[float], ys: list[float], x: float) -> float:
    """Linear interpolation of ys at x over ascending xs (clamped at the ends)."""
    if not xs:
        return 0.0
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    i = np.searchsorted(xs, x)
    x0, x1 = xs[i - 1], xs[i]
    y0, y1 = ys[i - 1], ys[i]
    f = (x - x0) / (x1 - x0) if x1 != x0 else 0.0
    return y0 + (y1 - y0) * f


def simulate_ascent(
    motor: Motor,
    mass_cad: float,
    rail_length: float = _DEFAULT_RAIL,
    g: float = G0,
    dt: float = _DT,
    max_t: float = _MAX_T,
) -> _Ascent:
    """Integrate 1-DOF vertical ascent (thrust - weight, no drag) to apogee.

    ``mass_cad`` is the dry-rocket (CAD) mass; the motor's total mass over time is added on
    top. Records the state at each step and stops at the first velocity zero-crossing after
    burnout (apogee). Returns flat, on-pad results with ``liftoff=False`` when the motor never
    develops enough thrust to leave the rail.

    ``rail_length`` is the guided travel distance; the velocity when the rocket has climbed
    that far is the off-rail velocity. Since the flight is vertical, travel distance == altitude.
    """
    burn = motor.burn_time
    ts: list[float] = []
    hs: list[float] = []
    vs: list[float] = []
    accs: list[float] = []
    thrusts: list[float] = []
    masses: list[float] = []

    t, v, h = 0.0, 0.0, 0.0
    lifted = False
    apogee_time = 0.0

    while t <= max_t:
        m = mass_cad + motor.get_total_mass(min(t, burn))
        thrust = motor.get_thrust(t)
        a = (thrust / m - g) if m > 0 else -g
        # On the pad: the rail/ground holds the rocket, so a downward net force is reacted
        # out (no fall-through-the-floor) until thrust overcomes weight.  ← drag term would
        # be added to `a` here later: -0.5*rho(h)*Cd*A*v*abs(v)/m, currently 0 (no atmosphere).
        if not lifted and h <= 0.0 and a <= 0.0:
            a = 0.0
        else:
            lifted = True

        ts.append(t)
        hs.append(h)
        vs.append(v)
        accs.append(a)
        thrusts.append(thrust)
        masses.append(m)

        # Motor burnt out and it never left the pad -- it never will.
        if not lifted and t > burn:
            break

        v_next = v + a * dt
        h_next = h + v_next * dt

        # Apogee: after burnout, velocity crosses from + to <= 0 between t and t+dt.
        if lifted and t >= burn and v > 0.0 and v_next <= 0.0:
            frac = v / (v - v_next) if v != v_next else 0.0
            apogee_time = t + frac * dt
            h_apogee = h + v * frac * dt
            ts.append(apogee_time)
            hs.append(h_apogee)
            vs.append(0.0)
            accs.append(-g)
            thrusts.append(0.0)
            masses.append(mass_cad + motor.burnout_mass)
            break

        t += dt
        v = v_next
        h = h_next
    else:
        apogee_time = ts[int(np.argmax(hs))] if hs else 0.0

    liftoff = lifted and (max(hs) if hs else 0.0) > 0.0
    apogee = max(hs) if hs else 0.0
    if apogee_time == 0.0 and hs:
        apogee_time = ts[int(np.argmax(hs))]

    liftoff_mass = mass_cad + motor.launch_mass
    peak_thrust = max(motor.thrust) if motor.thrust else 0.0
    twr = peak_thrust / (liftoff_mass * g) if liftoff_mass > 0 else 0.0

    # Off-rail velocity: interpolate v (and t) at altitude == rail_length. Altitude climbs
    # monotonically to apogee, so it is a valid interpolation key. Not reached if apogee falls
    # short of the rail (a rocket that barely lifts) or it never left the pad.
    rail_cleared = liftoff and apogee >= rail_length > 0
    rail_exit_velocity = _interp(hs, vs, rail_length) if rail_cleared else None
    rail_exit_time = _interp(hs, ts, rail_length) if rail_cleared else None

    return _Ascent(
        times=ts,
        altitude=hs,
        velocity=vs,
        acceleration=accs,
        thrust=thrusts,
        mass=masses,
        apogee=apogee,
        apogee_time=apogee_time,
        max_velocity=max(vs) if vs else 0.0,
        max_acceleration=max(accs) if accs else 0.0,
        burnout_time=burn,
        burnout_altitude=_interp(ts, hs, burn),
        burnout_velocity=_interp(ts, vs, burn),
        liftoff_mass=liftoff_mass,
        thrust_to_weight=twr,
        liftoff=liftoff,
        rail_length=rail_length,
        rail_exit_velocity=rail_exit_velocity,
        rail_exit_time=rail_exit_time,
        rail_cleared=rail_cleared,
    )


def _downsample(n: int, target: int) -> list[int]:
    """Indices into an n-length series, at most ``target`` of them, endpoints kept."""
    if n <= target:
        return list(range(n))
    step = (n - 1) / (target - 1)
    idx = sorted({int(round(i * step)) for i in range(target)})
    if idx[-1] != n - 1:
        idx.append(n - 1)
    return idx


def simulate_flight(
    store: GeometryStore,
    manifest_parts: list[dict],
    outer_faces: list[tuple[str, str]],
    motor: Motor,
    placement: MotorPlacement,
    axis: Axis | None = None,
    overrides: dict[str, float] | None = None,
    fin_faces: list[tuple[str, str]] | None = None,
    n_fins: int | None = None,
    rail_length: float = _DEFAULT_RAIL,
) -> FlightResult:
    """Full flight profile: ascent trajectory plus static margin over time.

    ``motor`` carries the thrust/mass/CG curves; ``placement`` fixes where it sits on the
    axis (its ``cmx`` is irrelevant here -- the fore-end position does not depend on it, and
    the margin uses ``motor.get_cmx(t)`` directly). ``rail_length`` is the guided travel to
    full departure (rear lug clearing the rail), for the off-rail velocity.
    """
    core = aero_core(store, outer_faces, axis, fin_faces, n_fins, include_fins=True)
    profile, axis = core.profile, core.axis
    ref_diameter = 2.0 * profile.r_max

    placed = place_motor(store, profile, axis, placement)
    fore_axial = placed.fore_axial

    # CAD-only CG (no motor), projected onto the axis -- the fixed part of the loaded CG.
    cg_cad_world, mass_cad = compute_cg(manifest_parts, overrides)
    cg_cad_axial = (
        float((cg_cad_world - axis.origin) @ axis.direction) if mass_cad > 0 else profile.x_fore
    )

    asc = simulate_ascent(motor, mass_cad, rail_length=rail_length)
    idx = _downsample(len(asc.times), _MAX_SAMPLES)
    burn = motor.burn_time

    def margin_at(t: float, velocity: float) -> float | None:
        tm = min(max(t, 0.0), burn)
        m_motor = motor.get_total_mass(tm)
        cg_motor_axial = fore_axial + motor.get_cmx(tm)
        total = mass_cad + m_motor
        if total <= 0 or ref_diameter <= 0:
            return None
        cg_total = (cg_cad_axial * mass_cad + cg_motor_axial * m_motor) / total
        # CP migrates with Mach; recompute the fin contribution at this sample's Mach.
        cp_axial = cp_axial_at_mach(core, abs(velocity) / A_SOUND)
        return (cp_axial - cg_total) / ref_diameter

    sample_mach = [abs(asc.velocity[i]) / A_SOUND for i in idx]
    sample_margin = [margin_at(asc.times[i], asc.velocity[i]) for i in idx]

    # Minimum margin over the flight -- the transonic dip is the point of the exercise.
    min_static_margin = min_margin_time = min_margin_mach = None
    defined = [
        (m, asc.times[i], mc)
        for m, i, mc in zip(sample_margin, idx, sample_mach)
        if m is not None
    ]
    if defined:
        min_static_margin, min_margin_time, min_margin_mach = min(defined, key=lambda r: r[0])

    return FlightResult(
        times=[asc.times[i] for i in idx],
        altitude=[asc.altitude[i] for i in idx],
        velocity=[asc.velocity[i] for i in idx],
        acceleration=[asc.acceleration[i] for i in idx],
        thrust=[asc.thrust[i] for i in idx],
        mass=[asc.mass[i] for i in idx],
        static_margin=sample_margin,
        mach=sample_mach,
        apogee=asc.apogee,
        apogee_time=asc.apogee_time,
        max_velocity=asc.max_velocity,
        max_acceleration=asc.max_acceleration,
        burnout_time=asc.burnout_time,
        burnout_altitude=asc.burnout_altitude,
        burnout_velocity=asc.burnout_velocity,
        liftoff_mass=asc.liftoff_mass,
        thrust_to_weight=asc.thrust_to_weight,
        liftoff=asc.liftoff,
        rail_length=asc.rail_length,
        rail_exit_velocity=asc.rail_exit_velocity,
        rail_exit_time=asc.rail_exit_time,
        rail_cleared=asc.rail_cleared,
        min_static_margin=min_static_margin,
        min_margin_time=min_margin_time,
        min_margin_mach=min_margin_mach,
    )
