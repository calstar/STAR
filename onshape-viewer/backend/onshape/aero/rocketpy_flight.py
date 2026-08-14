"""6-DOF ascent flight via RocketPy, driven by the CAD-derived rocket.

RocketPy owns the trajectory integration (validated against real flights); we feed
it the geometry, mass and motor the CAD/Barrowman pipeline already produces. Scope
here is **ascent only** -- ``terminate_on_apogee=True`` -- descent/recovery is the
recovery-calculator's job (merging in soon).

Aero uses RocketPy's **native** nose + fins (not our injected CP): the trajectory is
identical either way (drag-dominated -- verified), and native surfaces keep RocketPy's
own stability-margin readout meaningful. The ours-vs-RocketPy CP comparison is then a
**margin overlay** -- RocketPy's ``stability_margin(t)`` against our ``cp_axial_at_mach``
over the same Mach(t) -- computed on one physically-correct flight.

Approximations (see FUTURE_IMPROVEMENTS.md): inertia is a rod/cylinder estimate (CAD
has no inertia tensor yet); drag is a stub Cd(Mach) curve. Neither affects the
stability outputs; they gate the apogee/max-Q performance numbers, which the UI flags.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from ...motors.motor import Motor
from ..geometry_store import GeometryStore
from .axis import Axis
from .stability import (
    MotorPlacement,
    aero_core,
    compute_cg,
    cp_axial_at_mach,
    place_motor,
)

#: Sea-level ISA speed of sound, matching flight.py (Mach for our-margin overlay).
A_SOUND = 340.29
#: Number of evenly spaced samples returned to the client.
_N_SAMPLES = 300
# Friends of Amateur Rocketry (FAR), Mojave -- the fixed launch site. Mirrors the
# recovery calculator's physics/site.py; kept here until that module merges in.
FAR_ELEV_M = 630.0
FAR_LAT = 35.353333
FAR_LON = -117.807167
#: Stub drag Cd(Mach): subsonic ~0.45 with a transonic bump. See FUTURE_IMPROVEMENTS.md.
_STUB_DRAG = [[0.0, 0.45], [0.6, 0.48], [0.9, 0.55], [1.0, 0.62], [1.2, 0.58], [2.0, 0.48], [5.0, 0.40]]


@dataclass
class RocketGeom:
    """Resolved rocket geometry for RocketPy, in a nose(0)->tail frame (metres, kg)."""

    radius: float
    nose_length: float
    nose_kind: str
    body_length: float
    mass_without_motor: float
    cg_from_nose: float
    #: Fins, or None. (n, root_chord, tip_chord, span, sweep_length, position_from_nose)
    fins: tuple[int, float, float, float, float, float] | None


@dataclass
class FlightDynamicsResult:
    """Ascent time series + summary. SI units; angles in degrees where noted."""

    # series (length _N_SAMPLES)
    times: list[float]
    altitude: list[float]           # m AGL
    speed: list[float]              # m/s
    mach: list[float]
    acceleration: list[float]       # m/s^2
    dynamic_pressure: list[float]   # Pa
    angle_of_attack: list[float | None]    # deg; None where airspeed too low to define
    stability_margin_rocketpy: list[float]  # cal (RocketPy's CP)
    stability_margin_ours: list[float | None]  # cal (our CP(M))
    drift_x: list[float]            # m east of pad
    drift_y: list[float]            # m north of pad
    bending_moment: list[float]     # N·m (aerodynamic)
    omega_pitch: list[float]        # rad/s (w2)
    # attitude frequency response (FFT of attitude angle)
    fft_frequency: list[float]      # Hz
    fft_amplitude: list[float]
    # summary scalars
    apogee: float
    apogee_time: float
    max_speed: float
    max_mach: float
    max_acceleration: float
    max_dynamic_pressure: float
    max_dynamic_pressure_time: float
    out_of_rail_velocity: float
    out_of_rail_stability_margin: float
    min_stability_margin: float
    min_stability_margin_time: float
    min_stability_margin_ours: float | None
    max_angle_of_attack: float      # deg, over the meaningful (fast) window
    max_bending_moment: float
    drift_distance: float           # m, pad to apogee ground point
    drift_bearing: float            # deg, compass bearing pad->apogee point
    launch_stable: bool
    approximations: list[str] = field(default_factory=list)


def _generic_motor(motor: Motor):
    """A RocketPy GenericMotor from our thrust-curve Motor (thrust + mass, no grain model)."""
    from rocketpy import GenericMotor

    thrust = list(zip(motor.time, motor.thrust))
    radius = max(motor.diameter / 2.0, 1e-3)
    length = max(motor.length, 1e-3)
    prop = max(motor.propellant_mass, 1e-6)
    dry = max(motor.burnout_mass, 1e-6)
    # Motor inertia is dominated by the propellant grain; approximate as a solid cylinder.
    dry_i_long = (1 / 12) * dry * length**2
    dry_i_roll = 0.5 * dry * radius**2
    return GenericMotor(
        thrust_source=thrust,
        burn_time=motor.burn_time,
        chamber_radius=radius,
        chamber_height=length,
        chamber_position=0.0,
        propellant_initial_mass=prop,
        nozzle_radius=0.8 * radius,
        dry_mass=dry,
        center_of_dry_mass_position=0.0,
        dry_inertia=(dry_i_long, dry_i_long, dry_i_roll),
        coordinate_system_orientation="nozzle_to_combustion_chamber",
    )


def _approx_inertia(mass: float, length: float, radius: float) -> tuple[float, float, float]:
    """Rod (transverse) + thin cylinder (roll) inertia estimate. See FUTURE_IMPROVEMENTS.md #1."""
    i_long = (1 / 12) * mass * length**2
    i_roll = 0.5 * mass * radius**2
    return i_long, i_long, i_roll


def _wind_uv(speed: float, direction_from_deg: float) -> tuple[float, float]:
    """(u_east, v_north) m/s from wind speed and the bearing it blows *from* (met. convention)."""
    r = math.radians(direction_from_deg)
    return -speed * math.sin(r), -speed * math.cos(r)


def run_flight(
    geom: RocketGeom,
    motor: Motor,
    *,
    motor_position_from_nose: float,
    rail_length: float = 1.0,
    inclination: float = 85.0,
    heading: float = 0.0,
    wind_speed: float = 0.0,
    wind_direction: float = 0.0,
    elevation: float = FAR_ELEV_M,
    latitude: float = FAR_LAT,
    longitude: float = FAR_LON,
    drag_curve: list | None = None,
    our_margin_fn: Callable[[float, float], float | None] | None = None,
) -> FlightDynamicsResult:
    """Assemble RocketPy Environment + Rocket + Motor from ``geom`` and run to apogee.

    ``our_margin_fn(t, mach)`` supplies our-CP static margin per sample for the overlay;
    when None the ``stability_margin_ours`` series is all None.
    """
    from rocketpy import Environment, Flight, Rocket

    env = Environment(latitude=latitude, longitude=longitude, elevation=elevation)
    u, v = _wind_uv(wind_speed, wind_direction)
    top = 30000.0
    env.set_atmospheric_model(
        type="custom_atmosphere",
        wind_u=[[0, u], [top, u]],
        wind_v=[[0, v], [top, v]],
    )

    drag = drag_curve if drag_curve is not None else _STUB_DRAG
    rocket = Rocket(
        radius=geom.radius,
        mass=geom.mass_without_motor,
        inertia=_approx_inertia(geom.mass_without_motor, geom.body_length, geom.radius),
        power_off_drag=drag,
        power_on_drag=drag,
        center_of_mass_without_motor=geom.cg_from_nose,
        coordinate_system_orientation="nose_to_tail",
    )
    rocket.add_nose(length=geom.nose_length, kind=geom.nose_kind, position=0.0)
    if geom.fins is not None:
        n, root, tip, span, sweep, pos = geom.fins
        rocket.add_trapezoidal_fins(
            n=n, root_chord=root, tip_chord=tip, span=span, position=pos, sweep_length=sweep
        )
    rocket.add_motor(_generic_motor(motor), position=motor_position_from_nose)

    launch_stable = True
    try:
        launch_stable = float(rocket.static_margin(0)) > 0
    except Exception:
        pass

    flight = Flight(
        rocket=rocket,
        environment=env,
        rail_length=rail_length,
        inclination=inclination,
        heading=heading,
        terminate_on_apogee=True,
        verbose=False,
    )

    return _sample(flight, env, elevation, our_margin_fn, launch_stable, geom)


def _safe(fn, t: float, default: float = 0.0) -> float:
    try:
        return float(fn(t))
    except Exception:
        return default


def _sample(flight, env, elevation, our_margin_fn, launch_stable, geom) -> FlightDynamicsResult:
    t_end = float(flight.apogee_time)
    ts = np.linspace(0.0, t_end, _N_SAMPLES)

    # Angle of attack is only physical while there is meaningful airspeed; below this
    # free-stream speed it is numerically singular (near apogee), so we null it out.
    _AOA_MIN_AIRSPEED = 15.0  # m/s

    altitude, speed, mach, accel, q, aoa = [], [], [], [], [], []
    marg_rp, marg_ours, dx, dy, bend, wpitch = [], [], [], [], [], []
    for t in ts:
        m = _safe(flight.mach_number, t)
        altitude.append(_safe(flight.altitude, t) - 0.0)  # RocketPy altitude() is already AGL
        speed.append(_safe(flight.speed, t))
        mach.append(m)
        accel.append(_safe(flight.acceleration, t))
        q.append(_safe(flight.dynamic_pressure, t))
        if _safe(flight.free_stream_speed, t) >= _AOA_MIN_AIRSPEED:
            aoa.append(min(180.0, math.degrees(abs(_safe(flight.angle_of_attack, t)))))
        else:
            aoa.append(None)
        marg_rp.append(_safe(flight.stability_margin, t))
        marg_ours.append(our_margin_fn(float(t), m) if our_margin_fn else None)
        dx.append(_safe(flight.x, t))
        dy.append(_safe(flight.y, t))
        bend.append(_safe(flight.aerodynamic_bending_moment, t))
        wpitch.append(_safe(flight.w2, t))

    # Attitude frequency response (FFT) -- dynamic-stability readout.
    fft_f, fft_a = [], []
    try:
        fr = flight.attitude_frequency_response
        src = np.asarray(fr.source)
        fft_f = src[:, 0].tolist()
        fft_a = src[:, 1].tolist()
    except Exception:
        pass

    # Max AoA over the physical (non-null) window.
    max_aoa = max((a for a in aoa if a is not None), default=0.0)

    ours_defined = [m for m in marg_ours if m is not None]
    min_ours = min(ours_defined) if ours_defined else None

    dist = math.hypot(dx[-1], dy[-1])
    bearing = (math.degrees(math.atan2(dx[-1], dy[-1])) + 360.0) % 360.0  # x=E, y=N

    return FlightDynamicsResult(
        times=ts.tolist(),
        altitude=altitude,
        speed=speed,
        mach=mach,
        acceleration=accel,
        dynamic_pressure=q,
        angle_of_attack=aoa,
        stability_margin_rocketpy=marg_rp,
        stability_margin_ours=marg_ours,
        drift_x=dx,
        drift_y=dy,
        bending_moment=bend,
        omega_pitch=wpitch,
        fft_frequency=fft_f,
        fft_amplitude=fft_a,
        apogee=_safe(flight.altitude, t_end),
        apogee_time=t_end,
        max_speed=float(flight.max_speed),
        max_mach=float(flight.max_mach_number),
        max_acceleration=float(flight.max_acceleration),
        max_dynamic_pressure=float(flight.max_dynamic_pressure),
        max_dynamic_pressure_time=float(flight.max_dynamic_pressure_time),
        out_of_rail_velocity=float(flight.out_of_rail_velocity),
        out_of_rail_stability_margin=float(flight.out_of_rail_stability_margin),
        min_stability_margin=float(flight.min_stability_margin),
        min_stability_margin_time=float(flight.min_stability_margin_time),
        min_stability_margin_ours=min_ours,
        max_angle_of_attack=max_aoa,
        max_bending_moment=max((abs(b) for b in bend), default=0.0),
        drift_distance=dist,
        drift_bearing=bearing,
        launch_stable=launch_stable,
        approximations=[
            "inertia: rod/cylinder estimate (no CAD inertia tensor)",
            "airframe drag: stub Cd(Mach) curve",
            "nose: approximated as an ogive from the CAD profile",
        ],
    )


def _nose_from_profile(profile) -> tuple[float, str]:
    """Nose length (tip to full radius) and kind from the CAD radius profile."""
    r = np.asarray(profile.r_grid)
    s = np.asarray(profile.s_grid)
    full = np.where(r >= 0.99 * profile.r_max)[0]
    nose_len = float(s[full[0]] - profile.x_fore) if len(full) else float(profile.x_aft - profile.x_fore)
    return max(nose_len, 1e-3), "ogive"


def simulate_flight_dynamics(
    store: GeometryStore,
    manifest_parts: list[dict],
    outer_faces: list[tuple[str, str]],
    motor: Motor,
    placement: MotorPlacement,
    *,
    axis: Axis | None = None,
    overrides: dict[str, float] | None = None,
    fin_faces: list[tuple[str, str]] | None = None,
    n_fins: int | None = None,
    rail_length: float = 1.0,
    inclination: float = 85.0,
    heading: float = 0.0,
    wind_speed: float = 0.0,
    wind_direction: float = 0.0,
    elevation: float = FAR_ELEV_M,
    latitude: float = FAR_LAT,
    longitude: float = FAR_LON,
) -> FlightDynamicsResult:
    """Extract the rocket from CAD + Barrowman, then run the RocketPy ascent."""
    core = aero_core(store, outer_faces, axis, fin_faces, n_fins, include_fins=True)
    profile = core.profile
    x_fore = profile.x_fore
    ref_diameter = 2.0 * profile.r_max

    placed = place_motor(store, profile, core.axis, placement)
    fore_axial = placed.fore_axial
    cg_cad_world, mass_cad = compute_cg(manifest_parts, overrides)
    cg_cad_axial = (
        float((cg_cad_world - core.axis.origin) @ core.axis.direction)
        if mass_cad > 0
        else x_fore
    )

    nose_len, nose_kind = _nose_from_profile(profile)
    fins = None
    if core.fin_pf is not None:
        pf = core.fin_pf
        fins = (
            pf.n_fins,
            float(pf.root_chord),
            float(pf.tip_chord),
            float(pf.span),
            float(pf.sweep),
            float(pf.chord_lead[0] - x_fore),
        )

    geom = RocketGeom(
        radius=profile.r_max,
        nose_length=nose_len,
        nose_kind=nose_kind,
        body_length=profile.x_aft - x_fore,
        mass_without_motor=mass_cad,
        cg_from_nose=cg_cad_axial - x_fore,
        fins=fins,
    )

    burn = motor.burn_time

    def our_margin(t: float, mach: float) -> float | None:
        tm = min(max(t, 0.0), burn)
        m_motor = motor.get_total_mass(tm)
        total = mass_cad + m_motor
        if total <= 0 or ref_diameter <= 0:
            return None
        cg_motor_axial = fore_axial + motor.get_cmx(tm)
        cg_total = (cg_cad_axial * mass_cad + cg_motor_axial * m_motor) / total
        return (cp_axial_at_mach(core, mach) - cg_total) / ref_diameter

    return run_flight(
        geom,
        motor,
        motor_position_from_nose=placed.cg_axial - x_fore,
        rail_length=rail_length,
        inclination=inclination,
        heading=heading,
        wind_speed=wind_speed,
        wind_direction=wind_direction,
        elevation=elevation,
        latitude=latitude,
        longitude=longitude,
        our_margin_fn=our_margin,
    )
