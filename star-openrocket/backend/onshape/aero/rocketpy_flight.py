"""6-DOF ascent flight via RocketPy, flying the same airframe the stability panel analyses.

RocketPy owns the trajectory integration; everything it integrates comes from the
app's own pipeline, so the 6-DOF and the static margin describe one rocket:

* **Aerodynamics** are the app's Barrowman components (``stability.aero_components``):
  the body split at its radius changes (nose, boattail, any shoulder) and the fin
  set, each a RocketPy surface at its own CP with its own CNa (the fins' with Mach).
  RocketPy computes each surface's lift from the airflow *at that surface* --
  including the rocket's rotation -- so pitch damping falls out of the same
  components that set the static margin, boattail included. RocketPy's own
  ``stability_margin`` therefore equals the panel's at the panel's Mach.
* **Mass** is the panel's: the parts, the viewer's overrides, the motor placement,
  and the airframe's rigid-body inertia from the parts' tensors
  (``stability.rigid_body_inertia``), not a uniform-rod estimate -- the rod put
  LE4 SD at 160 kg m^2 against a real 74.
* **Jet damping** uses the real nozzle: the motor is placed by its aft end.

Scope is **ascent only** (``terminate_on_apogee=True``); descent is the recovery
calculator's. Drag is still a stub Cd(Mach) curve (FUTURE_IMPROVEMENTS.md #2): it
moves apogee and max-q, not the stability outputs.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from ...motors.motor import Motor
from ..geometry_store import GeometryStore
from .axis import Axis
from .stability import (
    MotorPlacement,
    aero_components,
    aero_core,
    compute_cg,
    cp_axial_at_mach,
    place_motor,
    rigid_body_inertia,
)

# Friends of Amateur Rocketry (FAR), Mojave -- the fixed launch site. Now shared
# with the recovery calculator via physics/site.py (single source of truth), so
# the ascent and the descent agree on where they fly.
from physics.site import FAR_ELEV_M, FAR_LAT, FAR_LON  # noqa: E402

if TYPE_CHECKING:  # hints only -- the env is duck-typed off .to_rocketpy()/.T()/.p()
    from physics.atmosphere import Atmosphere
    from physics.wind import WindProfile

#: Sea-level ISA speed of sound, matching flight.py (Mach for our-margin overlay).
A_SOUND = 340.29
#: Number of evenly spaced samples returned to the client.
#: Bounds on the 6-DOF solve. See the Flight(...) call for why these exist.
_MAX_FLIGHT_TIME = 600.0   # s of simulated flight
_MAX_FLIGHT_STEP = 0.5     # s; keeps the adaptive solver from grinding
_MIN_APOGEE_TIME = 0.1     # s; below this, no apogee was found at all

_N_SAMPLES = 300
#: Stub drag Cd(Mach): subsonic ~0.45 with a transonic bump. See FUTURE_IMPROVEMENTS.md.
_STUB_DRAG = [[0.0, 0.45], [0.6, 0.48], [0.9, 0.55], [1.0, 0.62], [1.2, 0.58], [2.0, 0.48], [5.0, 0.40]]


@dataclass
class RocketGeom:
    """The rocket RocketPy flies, in a nose(0)->tail frame (metres, kg)."""

    radius: float  # reference radius (r_max)
    body_length: float
    mass_without_motor: float
    cg_from_nose: float
    #: Lifting components: (name, CNa(Mach) on pi r^2, CP from the nose).
    surfaces: list[tuple[str, Callable[[float], float], float]]
    #: Dry (I_transverse, I_transverse, I_axial) about ``cg_from_nose``, kg m^2. None
    #: falls back to the uniform-rod estimate, and the result says so.
    inertia: tuple[float, float, float] | None = None
    #: How ``inertia`` was obtained, for the approximations line.
    inertia_source: str = "parts"


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
    wind_speed: list[float]         # m/s; ambient horizontal wind at the rocket's altitude
    angle_of_attack: list[float | None]    # deg; None where airspeed too low to define
    angle_from_vertical: list[float]       # deg; rocket axis tilt off straight-up
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
    burnout_time: float             # s from ignition (motor burn duration; ignition at t=0)
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
    max_angle_of_attack: float      # deg, after rail exit while airspeed >= 25 % of max
    out_of_rail_angle_of_attack: float | None  # deg, the moment the rocket leaves the rail
    max_bending_moment: float
    drift_distance: float           # m, pad to apogee ground point
    drift_bearing: float            # deg, compass bearing pad->apogee point
    lateral_velocity_at_apogee: float   # m/s, horizontal GROUND speed at apogee
    lateral_bearing_at_apogee: float    # deg, compass bearing it points TOWARD
    # At motor burnout: thrust stops at peak drag, which is what pulls a
    # separation joint apart (the recovery tab's shear pin sizing).
    burnout_mass: float | None      # kg, whole vehicle; None if RocketPy could not say
    burnout_drag: float | None      # N, whole-vehicle aerodynamic drag
    launch_stable: bool
    approximations: list[str] = field(default_factory=list)
    #: Dry pitch inertia the flight used (kg m^2) and where it came from.
    inertia_transverse: float | None = None
    inertia_source: str | None = None


def _generic_motor(motor: Motor):
    """A RocketPy GenericMotor from our thrust-curve Motor (thrust + mass, no grain model).

    Its origin is the **nozzle exit** (the motor's aft end), so the rocket adds it by its
    aft position and RocketPy's jet damping -- mass flow times the nozzle-to-CG distance
    squared -- has the real arm. (It used to sit at the motor's CG, which on LE4 SD put
    the nozzle 0.6 m too far forward and halved the jet damping.) Propellant sits at the
    chamber centre; the casing's CG is the datafile's burnout CG.
    """
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
        chamber_position=length / 2.0,
        propellant_initial_mass=prop,
        nozzle_radius=0.8 * radius,
        nozzle_position=0.0,
        dry_mass=dry,
        # cg_x is from the fore end; this frame measures from the nozzle, forward.
        center_of_dry_mass_position=length - motor.burnout_cgx,
        dry_inertia=(dry_i_long, dry_i_long, dry_i_roll),
        coordinate_system_orientation="nozzle_to_combustion_chamber",
    )


def _barrowman_surface(name: str, cna: Callable[[float], float], radius: float):
    """One app Barrowman component as a RocketPy aerodynamic surface.

    A subclass of RocketPy's ``AeroSurface``, so ``Flight`` treats it like its own
    nose or fins: lift ``CNa(M) * alpha`` from the local airflow at the surface, which
    includes the rocket's rotation (that is the pitch damping), and it counts in
    ``Rocket.cp_position`` / ``static_margin``. The CP is the surface's position;
    locally it sits at its own origin.
    """
    from rocketpy.mathutils import Function
    from rocketpy.rocket.aero_surface.aero_surface import AeroSurface

    class BarrowmanSurface(AeroSurface):
        def __init__(self) -> None:
            super().__init__(name, math.pi * radius**2, 2 * radius)
            # Referenced to the rocket's own area, so RocketPy's ref_factor is 1.
            self.rocket_radius = radius
            self.evaluate_geometrical_parameters()
            self.evaluate_lift_coefficient()
            self.evaluate_center_of_pressure()

        def evaluate_geometrical_parameters(self) -> None:
            return None

        def evaluate_lift_coefficient(self) -> None:
            self.clalpha = Function(lambda mach: cna(mach), "Mach", f"Lift coefficient derivative for {name}")
            self.cl = Function(lambda alpha, mach: cna(mach) * alpha, ["Alpha (rad)", "Mach"], "Cl")

        def evaluate_center_of_pressure(self) -> None:
            self.cpx = self.cpy = self.cpz = 0.0
            self.cp = (0.0, 0.0, 0.0)

        def info(self) -> None:
            return None

        def all_info(self) -> None:
            return None

    return BarrowmanSurface()


def _approx_inertia(mass: float, length: float, radius: float) -> tuple[float, float, float]:
    """Rod (transverse) + thin cylinder (roll) estimate: the fallback for a model whose
    parts carry no inertia tensor (builds that predate it). A uniform rod spreads the
    mass evenly, so it overstates a ballasted rocket's pitch inertia -- 2x on LE4 SD."""
    i_long = (1 / 12) * mass * length**2
    i_roll = 0.5 * mass * radius**2
    return i_long, i_long, i_roll


#: Top of the ascent atmosphere column, m MSL -- above any apogee we simulate.
_ATMOS_TOP_MSL = 30000.0


def run_flight(
    geom: RocketGeom,
    motor: Motor,
    *,
    nozzle_position_from_nose: float,
    rail_length: float = 1.0,
    inclination: float = 85.0,
    heading: float = 0.0,
    wind_profile: "WindProfile | None" = None,
    atmosphere: "Atmosphere | None" = None,
    elevation: float = FAR_ELEV_M,
    latitude: float = FAR_LAT,
    longitude: float = FAR_LON,
    drag_curve: list | None = None,
    our_margin_fn: Callable[[float, float], float | None] | None = None,
) -> FlightDynamicsResult:
    """Assemble RocketPy Environment + Rocket + Motor from ``geom`` and run to apogee.

    ``wind_profile`` and ``atmosphere`` are the SAME shared-environment objects the
    descent integrates (``physics.wind.WindProfile`` / ``physics.atmosphere.Atmosphere``),
    so the ascent flies through identical air. Both default to None -- a calm ISA column
    referenced to ``elevation`` -- for callers that do not supply an environment.

    ``our_margin_fn(t, mach)`` supplies our-CP static margin per sample for the overlay;
    when None the ``stability_margin_ours`` series is all None.
    """
    from rocketpy import Environment, Flight, Rocket

    env = Environment(latitude=latitude, longitude=longitude, elevation=elevation)
    top = _ATMOS_TOP_MSL
    # One MSL grid shared by wind and the temperature/pressure column, so both are
    # monotonic and span the whole flight regardless of a climatology profile's own
    # (possibly single-level, possibly short) grid.
    levels = np.linspace(elevation, top, 60)
    if wind_profile is not None:
        wind_u = [[float(h), float(wind_profile.u(h - elevation))] for h in levels]
        wind_v = [[float(h), float(wind_profile.v(h - elevation))] for h in levels]
    else:
        wind_u = [[elevation, 0.0], [top, 0.0]]
        wind_v = [[elevation, 0.0], [top, 0.0]]

    atmos_model: dict = {"type": "custom_atmosphere", "wind_u": wind_u, "wind_v": wind_v}
    if atmosphere is not None:
        # RocketPy derives density from (p, T); a fraction-of-a-percent gas-constant
        # difference vs Atmosphere.rho is acceptable -- it is the same column the
        # descent uses, sampled onto the MSL grid.
        atmos_model["temperature"] = [
            [float(h), float(atmosphere.T(h - elevation))] for h in levels
        ]
        atmos_model["pressure"] = [
            [float(h), float(atmosphere.p(h - elevation))] for h in levels
        ]
    env.set_atmospheric_model(**atmos_model)

    drag = drag_curve if drag_curve is not None else _STUB_DRAG
    inertia = geom.inertia or _approx_inertia(geom.mass_without_motor, geom.body_length, geom.radius)
    rocket = Rocket(
        radius=geom.radius,
        mass=geom.mass_without_motor,
        inertia=inertia,
        power_off_drag=drag,
        power_on_drag=drag,
        center_of_mass_without_motor=geom.cg_from_nose,
        coordinate_system_orientation="nose_to_tail",
    )
    if not geom.surfaces:
        raise ValueError("the rocket has no lifting surfaces to fly")
    rocket.add_surfaces(
        [_barrowman_surface(name, cna, geom.radius) for name, cna, _ in geom.surfaces],
        [cp for _, _, cp in geom.surfaces],
    )
    rocket.add_motor(_generic_motor(motor), position=nozzle_position_from_nose)

    launch_stable = True
    try:
        launch_stable = float(rocket.static_margin(0)) > 0
    except Exception:
        pass

    # `terminate_on_apogee` bounds this only if apogee is ever REACHED. A
    # rocket that never leaves the rail, or one given a degenerate thrust
    # curve, never gets there -- and RocketPy's adaptive solver answers a
    # badly-conditioned rocket by taking smaller steps, without limit. This
    # route is the one piece of physics in the app that a compute budget
    # cannot interrupt: `Flight(...)` is a single opaque call, so its bound has
    # to be an argument rather than a checkpoint.
    #
    # 600 s of flight time is minutes of powered ascent, far past any amateur
    # trajectory; `max_time_step` keeps the solver from grinding arbitrarily
    # fine between steps.
    flight = Flight(
        rocket=rocket,
        environment=env,
        rail_length=rail_length,
        inclination=inclination,
        heading=heading,
        terminate_on_apogee=True,
        max_time=_MAX_FLIGHT_TIME,
        max_time_step=_MAX_FLIGHT_STEP,
        verbose=False,
    )

    return _sample(flight, env, elevation, our_margin_fn, launch_stable, geom,
                   float(motor.burn_time), inertia)


def _safe(fn, t: float, default: float | None = 0.0) -> float | None:
    try:
        return float(fn(t))
    except Exception:
        return default


def _sample(flight, env, elevation, our_margin_fn, launch_stable, geom,
            burnout_time, inertia) -> FlightDynamicsResult:
    t_end = float(flight.apogee_time)
    # A flight that hit `max_time` without an apogee reports one at (or very
    # near) zero. Sampling that gives `linspace(0, 0, N)` -- a full result
    # object, every column flat, presented as a successful analysis. Refusing
    # is the honest answer: this rocket did not fly.
    if not np.isfinite(t_end) or t_end <= _MIN_APOGEE_TIME:
        raise ValueError(
            "this rocket never reached apogee within %g s of flight -- it is "
            "most likely too heavy for its motor, or unstable off the rail. "
            "Check the motor selection, the dry mass and the fin geometry."
            % _MAX_FLIGHT_TIME
        )
    ts = np.linspace(0.0, t_end, _N_SAMPLES)

    # Angle of attack is only physical while there is meaningful airspeed; below this
    # free-stream speed it is numerically singular (near apogee), so we null it out.
    _AOA_MIN_AIRSPEED = 15.0  # m/s

    altitude, speed, mach, accel, q, aoa, wind = [], [], [], [], [], [], []
    marg_rp, marg_ours, dx, dy, bend, wpitch, avert = [], [], [], [], [], [], []
    for t in ts:
        m = _safe(flight.mach_number, t)
        alt = _safe(flight.altitude, t)  # RocketPy altitude() is already AGL
        altitude.append(alt)
        speed.append(_safe(flight.speed, t))
        mach.append(m)
        accel.append(_safe(flight.acceleration, t))
        q.append(_safe(flight.dynamic_pressure, t))
        # Ambient horizontal wind the rocket flies through at this instant -- read from
        # the same environment column the ascent used, sampled at the rocket's altitude
        # (env wind functions take height ASL). Constant wind reads flat; a climatology
        # profile varies with height as the rocket climbs through the shear.
        z_asl = alt + elevation
        wind.append(math.hypot(_safe(env.wind_velocity_x, z_asl),
                               _safe(env.wind_velocity_y, z_asl)))
        if _safe(flight.free_stream_speed, t) >= _AOA_MIN_AIRSPEED:
            # RocketPy's angle_of_attack is already in degrees (rad2deg(arccos(...)),
            # bounded [0, 180]) — do NOT re-convert. abs() guards any sign edge case.
            aoa.append(abs(_safe(flight.angle_of_attack, t)))
        else:
            aoa.append(None)
        # attitude_angle is the axis angle above horizontal (deg); vertical tilt is its
        # complement — a defined-everywhere reference the AoA can be read against.
        avert.append(90.0 - _safe(flight.attitude_angle, t))
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

    # Max AoA in flight: after the rail lets go, and while the rocket is fast enough
    # for the angle to mean anything. On the rail it is held; near apogee (and on any
    # flight's slow end) the airspeed collapses and the angle balloons with it --
    # LE4 SD read 36 deg there in a 15 ft/s wind, against 7 deg at rail exit.
    t_rail = _safe(lambda _t: flight.out_of_rail_time, 0.0)
    v_floor = max(_AOA_MIN_AIRSPEED, 0.25 * float(flight.max_speed))
    in_flight = [
        a for t, a, v in zip(ts, aoa, speed)
        if a is not None and t >= t_rail and v is not None and v >= v_floor
    ]
    max_aoa = max(in_flight, default=0.0)
    rail_aoa = _safe(flight.angle_of_attack, t_rail, None)

    ours_defined = [m for m in marg_ours if m is not None]
    min_ours = min(ours_defined) if ours_defined else None

    dist = math.hypot(dx[-1], dy[-1])
    bearing = (math.degrees(math.atan2(dx[-1], dy[-1])) + 360.0) % 360.0  # x=E, y=N

    # Ground velocity vector at apogee (the last sample IS apogee; vertical speed
    # ~0 there). Fed to the recovery calculator as the descent's initial lateral
    # ground velocity -- a weathercocked rocket arrives at apogee moving sideways.
    vx_ap = _safe(flight.vx, t_end)
    vy_ap = _safe(flight.vy, t_end)
    lat_v_apogee = math.hypot(vx_ap, vy_ap)
    lat_bearing_apogee = (
        (math.degrees(math.atan2(vx_ap, vy_ap)) + 360.0) % 360.0  # x=E, y=N, TOWARD
    )

    return FlightDynamicsResult(
        times=ts.tolist(),
        altitude=altitude,
        speed=speed,
        mach=mach,
        acceleration=accel,
        dynamic_pressure=q,
        wind_speed=wind,
        angle_of_attack=aoa,
        angle_from_vertical=avert,
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
        burnout_time=burnout_time,
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
        out_of_rail_angle_of_attack=None if rail_aoa is None else abs(rail_aoa),
        max_bending_moment=max((abs(b) for b in bend), default=0.0),
        drift_distance=dist,
        drift_bearing=bearing,
        lateral_velocity_at_apogee=lat_v_apogee,
        lateral_bearing_at_apogee=lat_bearing_apogee,
        burnout_mass=_safe(flight.rocket.total_mass, burnout_time, None),
        burnout_drag=_safe(flight.aerodynamic_drag, burnout_time, None),
        launch_stable=launch_stable,
        approximations=[
            *(["inertia: uniform-rod estimate (the parts carry no inertia tensors)"]
              if geom.inertia is None else
              [f"inertia: {geom.inertia_source}"] if geom.inertia_source != "parts" else []),
            "airframe drag: stub Cd(Mach) curve",
            "fin CP held at its Mach 0.3 position (CNa follows Mach)",
        ],
        inertia_transverse=float(inertia[0]),
        inertia_source="uniform rod" if geom.inertia is None else geom.inertia_source,
    )


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
    wind_profile: "WindProfile | None" = None,
    atmosphere: "Atmosphere | None" = None,
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

    components = aero_components(core)
    body = rigid_body_inertia(manifest_parts, core.axis, overrides)
    inertia, source = None, "parts"
    if body is not None and body.tensor_fraction > 0:
        inertia = (body.i_transverse, body.i_transverse, body.i_axial)
        if body.tensor_fraction < 0.99:
            source = (f"parts ({body.tensor_fraction:.0%} of the mass with its own tensor; "
                      "the rest as point masses)")

    geom = RocketGeom(
        radius=profile.r_max,
        body_length=profile.x_aft - x_fore,
        mass_without_motor=mass_cad,
        cg_from_nose=cg_cad_axial - x_fore,
        surfaces=[(c.name, c.cna_at, c.cp_axial - x_fore) for c in components],
        inertia=inertia,
        inertia_source=source,
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
        nozzle_position_from_nose=placed.aft_axial - x_fore,
        rail_length=rail_length,
        inclination=inclination,
        heading=heading,
        wind_profile=wind_profile,
        atmosphere=atmosphere,
        elevation=elevation,
        latitude=latitude,
        longitude=longitude,
        our_margin_fn=our_margin,
    )
