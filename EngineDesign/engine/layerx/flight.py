"""Phase 6: the burn, flown, and the flight fed back into the burn.

On the stand every liquid column feels one g. In the vehicle it feels the proper acceleration
along the axis (the specific force: thrust less drag over mass, no gravity in it): 8.0-8.25 g at
liftoff and 8.7-9.2 g at burnout on LE4, as flown on 2026-10-02 (docs/layerx/AUDIT.md 9.3). The
tank heads grow with it, and so would the column in each feed line between its tank and the
injector -- but only by the height the drawing gives that line, and no drawing gives any line a
height yet. Flown today, only the tanks' own liquid feels it: +1.1 to +1.6 psi at the injector
inlets. The team's vehicle lines (fuel 4.5 ft, LOX 1 ft) taken as vertical, an upper bound that is
on no drawing, would add +10.7 / +4.1 psi and move O/F 1.518 -> 1.485 (AUDIT 9.3, 7.2).

The coupling is closed by iteration, the same way the throat history is (replay.py):

1. burn on the pad (1 g) until the eroding throat settles: this is the ordinary Layer X result;
2. fly the delivered curve in EngineDesign's flight simulation (RocketPy, ``ui.flight_sim``), and
   read the proper acceleration along the axis at every firing step;
3. burn again with that acceleration applied to every liquid column at each step
   (``Setup.body_acceleration``), fly again, until neither the acceleration history nor the
   throat history moves.

**The feed lines.** The drawing is the feed system: every line's length, bore, fittings and
height come from it, and the feed twin computes the losses from them. Flight adds one thing, the
acceleration on each liquid column, and a line's column is its ``elevation_change`` as drawn (or
as the person restated it). Layer X never writes geometry into the drawing. :func:`line_paths`
reports each tank-to-injector path, its drawn length and the height it states; a path that states
none carries no line head in flight, and the preflight says so.

**The vehicle's tanks.** These come from the drawing. When the drawing and the config disagree
on tank volume, preflight already says so. The drawing's volumes are measured, and the
config's are sized to the load, so the measured ones are used for the feed system. The flight
simulation keeps the config's tanks for the mass and inertia it flies.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

G0 = 9.80665

#: The acceleration history has settled when no firing step moves by more than this, relative.
#: 0.5 % of the largest head flight adds at an injector inlet (+10.7 psi, the team's 4.5 ft fuel
#: line taken as vertical: an upper bound, on no drawing) is 0.05 psi on a ~140 psi injector drop,
#: under 0.02 % of the flow. Measured on LE4 (AUDIT 5.1): pass 3 moved the acceleration 0.48 %,
#: pass 4 0.003 %.
ACCEL_TOLERANCE = 5e-3

#: Flown passes after the pad's burn has settled. Two is typical: the first flight's
#: acceleration moves the burn a percent, the second confirms it.
MAX_FLIGHT_PASSES = 4

#: Points kept from the flight for the trajectory plots (the burn's acceleration is sampled at
#: every firing step instead).
TRAJECTORY_POINTS = 240


# ---------------------------------------------------------------------- vehicle layout


_TO_M = {"m": 1.0, "mm": 1e-3, "cm": 1e-2, "in": 0.0254, "ft": 0.3048}


def _drawn_length_m(edge: Dict[str, Any]) -> Optional[float]:
    """A drawn line's length [m] from its ``length`` parameter, or None if it states none."""
    p = ((edge.get("data") or {}).get("params") or {}).get("length")
    if not isinstance(p, dict):
        return None
    try:
        return float(p["value"]) * _TO_M[str(p.get("unit", "m")).strip()]
    except (KeyError, TypeError, ValueError):
        return None


def _path_to_tank(model: Any, inlet: str, tank: str) -> List[str]:
    """Branch ids from the tank down to the injector inlet: a breadth-first walk upstream, so a
    fill line or vent tee that also meets the path is not mistaken for the feed."""
    net = model.built.network
    parent: Dict[str, Tuple[str, str]] = {}
    frontier, seen = [inlet], {inlet}
    # The lines leave the tank at its ports ("OXT.out"), not at the tank node itself.
    def is_tank(node: str) -> bool:
        return node == tank or node.split(".", 1)[0] == tank

    reached = None
    while frontier and reached is None:
        here = frontier.pop(0)
        for bid, br in net.branches.items():
            if br.downstream == here and br.upstream not in seen:
                seen.add(br.upstream)
                parent[br.upstream] = (here, bid)
                if is_tank(br.upstream):
                    reached = br.upstream
                    break
                frontier.append(br.upstream)
    if reached is None:
        return []
    out, node = [], reached
    while node != inlet:
        node, bid = parent[node]
        out.append(bid)
    return out


def _elevation_m(edge: Dict[str, Any]) -> Optional[float]:
    """The height a drawn line climbs in its drawn direction [m], or None if it states none."""
    data = edge.get("data") or {}
    total, stated = 0.0, False
    p = (data.get("params") or {}).get("elevation_change")
    if isinstance(p, dict) and p.get("value") is not None:
        total += float(p["value"]) * _TO_M.get(str(p.get("unit", "m")).strip(), 1.0)
        stated = True
    for seg in data.get("segments") or []:
        if isinstance(seg, dict) and seg.get("elevation_change") is not None:
            total += float(seg["elevation_change"])
            stated = True
    return total if stated else None


def line_paths(payload: Dict[str, Any], model: Any, inlets: Dict[str, str], tanks: Dict[str, str],
               restated: Sequence[str]) -> List[Dict[str, Any]]:
    """Per side, the drawing's path from the tank to the injector: its lines, their drawn length
    and the height they state. Read only: the drawing is the feed system."""
    edges = {str(e.get("id")): e for e in payload.get("edges") or [] if isinstance(e, dict)}
    rows: List[Dict[str, Any]] = []
    for side in ("oxidiser", "fuel"):
        path = _path_to_tank(model, inlets.get(side, ""), tanks.get(side, ""))
        lines = [b for b in path if b in edges]
        length = sum(_drawn_length_m(edges[b]) or 0.0 for b in lines)
        rises = {b: _elevation_m(edges[b]) for b in lines}
        stated = [b for b, v in rises.items() if v is not None]
        too_steep = [b for b in stated if (_drawn_length_m(edges[b]) or 0.0) + 1e-9 < abs(rises[b] or 0.0)]
        rows.append({
            "side": side, "lines": lines, "length_m": length,
            # Positive: the tank sits above the injector, so the column adds pressure under thrust.
            "drop_m": -sum(v for v in rises.values() if v is not None),
            "used": ("restated" if any(f"edge:{b}.elevation_change" in restated for b in stated)
                     else "drawing" if stated else "none"),
            "too_steep": too_steep,
        })
    return rows


# ---------------------------------------------------------------------- the flight


def coolprop_gas(name: Optional[str]) -> Optional[str]:
    """CoolProp's own name for a drawing's fluid (``"helium"`` -> ``"Helium"``); ``None`` for none.
    A name CoolProp does not know is passed through, and the flight's density call says so."""
    if not name:
        return None
    import CoolProp.CoolProp as CP

    try:
        return str(CP.get_fluid_param_string(str(name), "name"))
    except Exception:  # noqa: BLE001 - unknown to CoolProp: the flight's own PropsSI raises with the name
        return str(name)


def _flight_config(config: Any, timeseries: Optional[Dict[str, Any]], loads: Dict[str, float], ambient_pa: float,
                   pressurant_kg: Optional[float], copv_volume_L: Optional[float], notes: List[str],
                   pressurant_gas: Optional[str] = None) -> Any:
    from engine.pipeline.config_schemas import PintleEngineConfig

    raw = config.model_dump()
    raw["lox_tank"]["mass"] = float(loads["oxidiser"])
    raw["fuel_tank"]["mass"] = float(loads["fuel"])
    species = coolprop_gas(pressurant_gas)
    if species is not None:
        # THE GAS IS THE DRAWING'S, NOT THE CONFIG'S (AUDIT 5.2, D2). The flight sizes the T-0
        # ullage and the COPV's refill of it with the tanks' ullage_gas. The config says Nitrogen;
        # the hot-fire drawing's bottle holds helium. Priced as N2 (46-48 kg/m3 at tank pressure)
        # the refill was 0.521 kg against a 0.208 kg He bottle and the flight was refused; as
        # helium (6.4 kg/m3) it is 0.073 kg.
        was = {raw[k].get("ullage_gas") for k in ("lox_tank", "fuel_tank") if raw.get(k)}
        for key in ("lox_tank", "fuel_tank"):
            if raw.get(key) is not None:
                raw[key]["ullage_gas"] = species
        stated = {coolprop_gas(w) for w in was if w}
        if stated and stated != {species}:
            notes.append(f"Ullage and COPV gas flown as {species}, the drawing's pressurant "
                         f"(the config's tanks say {', '.join(sorted(str(w) for w in was))}).")
    press = raw.get("press_tank")
    if press is not None:
        if pressurant_kg is not None and pressurant_kg > 0:
            # The bottle the twin primed, not the config's sizing estimate. The gas it pushes into the
            # ullage stays aboard, so the bottle's T-0 mass is the vehicle's pressurant mass.
            was = press.get("initial_gas_mass") or press.get("mass")
            press["initial_gas_mass"] = float(pressurant_kg)
            press["mass"] = None
            if was and abs(float(was) - pressurant_kg) > 0.01:
                notes.append(f"Pressurant flown at the twin's T-0 bottle mass, {pressurant_kg:.3f} kg "
                             f"(the config's sizing says {float(was):.3f} kg).")
        cfg_L = press.get("free_volume_L")
        if copv_volume_L and cfg_L and abs(copv_volume_L / float(cfg_L) - 1.0) > 0.01:
            # A different bottle: same construction, so its structure scales with its volume.
            scale = copv_volume_L / float(cfg_L)
            press["free_volume_L"] = float(copv_volume_L)
            rocket = raw.get("rocket") or {}
            if rocket.get("copv_dry_mass"):
                rocket["copv_dry_mass"] = float(rocket["copv_dry_mass"]) * scale
                notes.append(f"COPV of {copv_volume_L:.2f} L flown with its structure scaled by volume from the "
                             f"config's {float(cfg_L):.2f} L: {rocket['copv_dry_mass']:.2f} kg (estimate).")
    raw.setdefault("thrust", {})
    raw["thrust"] = dict(raw["thrust"] or {})
    burn = None
    if timeseries is not None:
        t = np.asarray(timeseries["data"]["time"], dtype=float)
        burn = float(t[-1] - t[0])
        raw["thrust"]["burn_time"] = burn
    # The curve was computed against the site's ambient; the flight corrects it with altitude.
    raw["thrust"]["reference_pressure_pa"] = float(ambient_pa)
    cfg = PintleEngineConfig(**raw)
    if burn is not None:
        # Set again after construction: the model's validator syncs thrust.burn_time back to the
        # design requirement (3.99 s on the 6.8 kN design), and the flight must stop where this
        # burn stops.
        cfg.thrust.burn_time = burn
    return cfg


def config_dry_kg(config: Any) -> Optional[float]:
    """The vehicle empty, as the config states it and ui.flight_sim books it: airframe plus engine,
    tank structures and COPV. ``None`` when the config states no vehicle."""
    r = getattr(config, "rocket", None)
    if r is None:
        return None
    if r.airframe_mass is not None and r.engine_mass is not None:
        return float(r.airframe_mass + r.engine_mass + (r.lox_tank_structure_mass or 0.0)
                     + (r.fuel_tank_structure_mass or 0.0) + (r.copv_dry_mass or 0.0))
    if r.airframe_mass is not None and r.propulsion_dry_mass is not None:
        return float(r.airframe_mass + r.propulsion_dry_mass)
    if r.mass is not None and r.motor is not None:
        return float(r.mass + r.motor.dry_mass)
    return None


def _ceiling(config: Any, apogee_agl: float, elevation: float) -> Optional[Dict[str, Any]]:
    req = getattr(config, "design_requirements", None)
    cap = getattr(req, "max_apogee_m", None) if req is not None else None
    if cap is None:
        return None
    datum = getattr(req, "max_apogee_datum", None) or "AGL"
    cap_agl = float(cap) - (elevation if datum == "MSL" else 0.0)
    return {"limit_m": float(cap), "datum": datum, "limit_agl_m": cap_agl, "margin_m": cap_agl - apogee_agl,
            "passed": apogee_agl <= cap_agl}


def axial_acceleration(flight: Any, t: float) -> float:
    """Proper acceleration along the vehicle axis at ``t`` [m/s^2]: what an accelerometer on it
    reads, and what a liquid column feels. The specific force along the axis: net thrust (the
    motor's, corrected from its reference pressure to the ambient at the vehicle's altitude) plus
    the axial aerodynamic force, over the vehicle's mass. Gravity is not in it, by definition.

    Read this way rather than by differentiating the trajectory. The two agree to 0.01 % through
    the burn on the 6.8 kN vehicle, but at the thrust cutoff the interpolated trajectory reads a
    spurious 14.8 g. That spike landed on the burn's last step through the feedback. RocketPy's
    own ``net_thrust`` reads zero at t = 0, so the motor's is used.

    Two conditions follow RocketPy's own equations of motion (``rocketpy/simulation/flight.py``
    1.11, ``u_dot_rail1`` and ``u_dot_generalized``):

    * **The pressure thrust stops with the motor.** RocketPy adds ``(p_ref - p(z)) A_e`` only while
      ``burn_start_time < t < burn_out_time``. Added in the coast as well, it read +0.34 g at
      apogee where the vehicle is weightless (AUDIT 5.1, 9.3): 251 N of thrust from a cold nozzle.
      Inside the burn (both ends included, so liftoff reads as before) nothing changes.
    * **A vehicle held on the rail reads the rail's reaction.** On the rail RocketPy clamps the
      axial acceleration to zero while thrust and drag are below the weight's component along it;
      the rail then carries the difference, so the specific force is ``g0 sin(inclination)``: one
      g0 on a vertical rail, the pad's own value (``Setup.body_acceleration`` default). LE4 lifts
      off at T/W 8, so this never acts on it; a curve with a start ramp would read T/m < 1 g.
    """
    motor = flight.rocket.motor
    area = math.pi * float(motor.nozzle_radius) ** 2
    reference = float(getattr(motor, "reference_pressure", None) or 0.0)
    burning = float(getattr(motor, "burn_start_time", 0.0)) <= t <= float(motor.burn_out_time)
    if reference and burning:
        pressure = float(flight.env.pressure(flight.z(t)))
        thrust = float(motor.thrust(t)) + (reference - pressure) * area
    else:
        thrust = float(motor.thrust(t))
    specific = (thrust + float(flight.R3(t))) / float(flight.rocket.total_mass(t))
    if t < float(flight.out_of_rail_time):
        held = G0 * math.sin(math.radians(float(flight.inclination)))
        if specific < held:
            return held
    return specific


# ---------------------------------------------------------------------- inputs with provenance


def _cfg_input(section: Any, field: str, unit: str, where: str) -> Dict[str, Any]:
    """A config value for a ``model`` block: ``{value, unit, provenance}``. A value equal to its
    schema default says so, with the schema's own description of that default: "the config says
    3.35 m" and "nobody measured the rail" are different statements."""
    value = getattr(section, field, None) if section is not None else None
    provenance = f"config {where}.{field}"
    fields = getattr(type(section), "model_fields", {}) if section is not None else {}
    info = fields.get(field)
    if info is not None and value is not None and info.default is not None:
        try:
            same = float(value) == float(info.default)
        except (TypeError, ValueError):
            same = value == info.default
        if same:
            provenance += f" = the schema default ({info.description or 'no source given'})"
    if isinstance(value, (list, tuple)):
        value = [float(v) for v in value]
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        value = float(value)
    return {"value": value, "unit": unit, "provenance": provenance}


# ---------------------------------------------------------------------- vehicle stability


#: Barrowman's centre of pressure, the static margin's basis, and RocketPy's implementation of it.
STABILITY_SOURCE = (
    "Barrowman, J. S., 'The Practical Calculation of the Aerodynamic Characteristics of Slender Finned "
    "Vehicles', M.S. thesis, Catholic University of America, 1967 (CP of nose and fins); as implemented in "
    "RocketPy 1.11 (Ceotto et al., 'RocketPy: Six Degree-of-Freedom Rocket Trajectory Simulator', J. Aerospace "
    "Engineering 34(6), 2021): Rocket.static_margin, Rocket.center_of_mass, Rocket.cp_position, "
    "Flight.max_dynamic_pressure, Flight.out_of_rail_velocity"
)


def vehicle_stability(flight: Any, config: Any, clock: Sequence[float]) -> Dict[str, Any]:
    """The vehicle's static stability over the burn, its max-Q and its rail exit, read off the
    RocketPy flight (DATA-CONTRACT 4, ``result.flight.stability``).

    ``clock`` is the burn's own clock, one value per sample, Fire first (flight time is
    ``clock - clock[0]``); every time this function returns is on that clock (the ``*_time_s``
    scalars :func:`_stability_or_failure` keeps from ``flight_report`` are flight time; Layer X
    puts Fire at clock 0, so the two agree there). Positions are from the tail
    (RocketPy ``tail_to_nose``), so ``static_margin_cal = (cg_m - cp_m) / diameter``. ``cp_m`` is
    Barrowman's CP at Mach 0, the static margin's own basis; the flight-Mach margin RocketPy
    tracks to apogee is ``min_stability_margin_cal``.

    The CG is the config's vehicle: tank positions and cylinders from ``lox_tank``/``fuel_tank``,
    not the drawing's tanks, which the flight does not lay out (AUDIT 9.3, 3)."""
    rocket = flight.rocket
    clock = np.asarray(clock, dtype=float)
    t_flight = clock - clock[0]
    diameter = 2.0 * float(rocket.radius)
    cp0 = float(rocket.cp_position(0.0))
    cg = [float(rocket.center_of_mass(float(x))) for x in t_flight]
    margin = [float(rocket.static_margin(float(x))) for x in t_flight]
    i_min = int(np.argmin(margin))
    t_q = float(flight.max_dynamic_pressure_time)
    elevation = float(getattr(config.environment, "elevation", 0.0) or 0.0)
    t_rail = float(flight.out_of_rail_time)
    req = getattr(config, "design_requirements", None)
    rk, env = config.rocket, config.environment
    fins = getattr(rk, "fins", None)
    inputs = {
        "rail_length_m": _cfg_input(env, "rail_length_m", "m", "environment"),
        "launch_inclination_deg": _cfg_input(env, "launch_inclination_deg", "deg", "environment"),
        "body_radius_m": _cfg_input(rk, "radius", "m", "rocket"),
        "cm_wo_motor_m": _cfg_input(rk, "cm_wo_motor", "m", "rocket"),
        "motor_position_m": _cfg_input(rk, "motor_position", "m", "rocket"),
        "ox_tank_pos_m": _cfg_input(config.lox_tank, "ox_tank_pos", "m", "lox_tank"),
        "fuel_tank_pos_m": _cfg_input(config.fuel_tank, "fuel_tank_pos", "m", "fuel_tank"),
        "avionics_payload_length_m": _cfg_input(rk, "avionics_payload_length_m", "m", "rocket"),
        # The nose sets half the CP (normal-force slope 2 at 0.5 L from its tip); the finish sets the
        # drag, hence the speed at max-Q and at rail exit.
        "nose_kind": _cfg_input(rk, "nose_kind", "", "rocket"),
        "nose_fineness_ratio": _cfg_input(rk, "nose_fineness_ratio", "", "rocket"),
        "nose_length_m": _cfg_input(rk, "nose_length", "m", "rocket"),
        "surface_roughness_m": _cfg_input(rk, "surface_roughness_m", "m", "rocket"),
        "liftoff_mass_kg": {"value": float(rocket.total_mass(0.0)), "unit": "kg",
                            "provenance": "the flight's own mass budget (flight.mass_budget)"},
    }
    if getattr(config, "press_tank", None) is not None:
        inputs["pres_tank_pos_m"] = _cfg_input(config.press_tank, "pres_tank_pos", "m", "press_tank")
    if fins is not None:
        for key, unit in (("no_fins", ""), ("root_chord", "m"), ("tip_chord", "m"), ("fin_span", "m"),
                          ("fin_position", "m")):
            inputs[f"fin_{key}" if not key.startswith("fin") else key] = _cfg_input(fins, key, unit, "rocket.fins")
    buttons = getattr(rk, "rail_button_upper_pos_m", None) is not None and \
        getattr(rk, "rail_button_lower_pos_m", None) is not None
    return {
        "t": clock.tolist(),
        "static_margin_cal": margin,
        "cg_m": cg,
        "cp_m": [cp0] * len(cg),
        "diameter_m": diameter,
        "datum": "from the tail (RocketPy tail_to_nose)",
        "liftoff_static_margin_cal": margin[0],
        "min_static_margin_cal": margin[i_min],
        "min_static_margin_t": float(clock[i_min]),
        "max_q_pa": float(flight.max_dynamic_pressure),
        "max_q_t": t_q + float(clock[0]),
        "max_q_mach": float(flight.mach_number(t_q)),
        "max_q_speed_m_s": float(flight.free_stream_speed(t_q)),
        "max_q_altitude_agl_m": float(flight.z(t_q)) - elevation,
        "rail_exit_m_s": float(flight.out_of_rail_velocity),
        "rail_exit_t": t_rail + float(clock[0]),
        "rail_exit_required_m_s": (float(req.min_rail_exit_velocity_m_s)
                                   if req is not None and getattr(req, "min_rail_exit_velocity_m_s", None) else None),
        "rail_exit_static_margin_cal": float(rocket.static_margin(t_rail)),
        "min_stability_margin_cal": float(flight.min_stability_margin),
        "min_stability_margin_t": float(flight.min_stability_margin_time) + float(clock[0]),
        "model": {
            "name": "rocketpy_barrowman_static_margin",
            "source": STABILITY_SOURCE,
            "assumptions": [
                "static margin = (CG - CP at Mach 0) / body diameter; CP from the nose (normal-force slope 2, "
                "at 0.5 of its length from the tip for a von Karman nose) and the fins (Barrowman's fin CP; "
                "at Mach 0 RocketPy's Diederich fin slope times the fin-body interference factor "
                "1 + r/(s + r) equals Barrowman's 4N(s/d)^2 form); body lift and any tail not counted, as RocketPy",
                "CG from the config's vehicle layout (tank positions and cylinders), not the drawing's tanks",
                "propellant leaves at the delivered mdot; pressurant moves from the COPV into the ullages and "
                "stays aboard",
                "max-Q over RocketPy's solution points; no wind; the config's atmosphere model",
                "rail exit: " + ("between the declared rail buttons" if buttons else
                                 "no rail buttons declared, so the full rail length is flown (an upper bound)"),
            ],
            "inputs": inputs,
        },
    }


def _stability_or_failure(flight: Any, config: Any, clock: Sequence[float],
                          scalars: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The contract block, merged over ``flight_report``'s scalar margins (liftoff, rail exit,
    burnout), which the Flight tab reads. A block that cannot be computed says why; the flight
    stands."""
    base = dict(scalars or {})
    try:
        base.update(vehicle_stability(flight, config, clock))
        base["available"] = True
    except Exception as exc:  # noqa: BLE001 - DATA-CONTRACT: a failed block never fails the run
        base.update({"available": False, "error": f"{type(exc).__name__}: {exc}"})
    return base


# ---------------------------------------------------------------------- inline 1-DOF ascent


#: Where the inline ascent's equations come from.
INLINE_SOURCE = (
    "Vertical point-mass ascent as engine/pipeline/flight_1dof.py: dv/dt = (F + (p_ref - p(z)) A_e - D)/m - g0, "
    "dm/dt = -mdot (Sutton & Biblarz, Rocket Propulsion Elements, 9th ed., 2017, ch. 4); drag D = 1/2 rho v|v| "
    "Cd(M) A from engine/pipeline/vehicle_drag (Niskanen, OpenRocket technical documentation, 2013, sec. 3.4); "
    "atmosphere: U.S. Standard Atmosphere, 1976; the specific force (T + pressure thrust - D)/m is what an "
    "accelerometer on the axis reads (Titterton & Weston, Strapdown Inertial Navigation Technology, 2nd ed., "
    "2004); the held vehicle follows RocketPy 1.11's rail clamp (u_dot_rail1)"
)


class InlineAscent:
    """A vertical 1-DOF ascent advanced sample by sample, for a burn pass to read the specific force
    a liquid column feels at each step without flying the whole burn first (D5-C).

    Same equations, drag and atmosphere as ``engine.pipeline.flight_1dof`` (which matches RocketPy's
    specific force to 0.002 % on LE4, AUDIT 9.3, 5). Thrust and mass flow are linear between the
    samples given to :meth:`advance`; the state is integrated by RK4 in substeps of at most
    ``dt_max``. Mass leaves only as propellant: the pressurant moves from the COPV into the ullages
    and stays aboard.

    **Held.** At rest on the pad (z = 0, v = 0) with thrust, pressure thrust and drag below the
    weight, the stand (or rail) carries the rest and the vehicle does not move. Its specific force
    is then exactly ``G0``: the pad's one g, ``Setup.body_acceleration``'s default. Pressure thrust
    acts only while the thrust sample is positive, so a lead-in sample with no thrust is held.
    """

    def __init__(self, *, mass_kg: float, reference_area_m2: float, nozzle_exit_area_m2: float,
                 elevation_m: float, reference_pressure_pa: Optional[float], drag: Any = None,
                 dt_max: float = 0.01) -> None:
        if not mass_kg > 0.0:
            raise ValueError(f"InlineAscent: the vehicle's mass must be positive, not {mass_kg!r}")
        if not dt_max > 0.0:
            raise ValueError("InlineAscent: dt_max must be positive")
        self.A_ref = float(reference_area_m2)
        self.A_e = float(nozzle_exit_area_m2)
        self.elevation = float(elevation_m)
        self.p_ref = None if reference_pressure_pa is None else float(reference_pressure_pa)
        self.dt_max = float(dt_max)
        self.drag = drag
        from engine.pipeline.vehicle_drag import isa_troposphere

        self._isa = isa_troposphere
        if drag is not None:
            self._mach = np.asarray(drag.mach, dtype=float)
            self._cd_on = np.asarray(drag.cd_power_on, dtype=float)
            self._cd_off = np.asarray(drag.cd_power_off, dtype=float)
        self.t: Optional[float] = None
        self.z = 0.0
        self.v = 0.0
        self.m = float(mass_kg)
        self.thrust = 0.0
        self.mdot = 0.0
        self.liftoff_time_s: Optional[float] = None

    @classmethod
    def from_config(cls, config: Any, liftoff_mass_kg: float, ambient_pa: float, *, drag: Any = None,
                    dt_max: float = 0.01) -> "InlineAscent":
        """The vehicle the RocketPy flight flies: body radius, nozzle exit, pad elevation and drag
        from ``config``; ``ambient_pa`` is the pressure the thrust curve was computed against (the
        site's, as Layer X burns it)."""
        a_e, a_ref, elevation, drag = _vehicle_terms(config, drag)
        return cls(mass_kg=liftoff_mass_kg, reference_area_m2=a_ref, nozzle_exit_area_m2=a_e,
                   elevation_m=elevation, reference_pressure_pa=ambient_pa, drag=drag, dt_max=dt_max)

    def _specific(self, z: float, v: float, m: float, thrust: float) -> Tuple[float, bool]:
        """(the specific force the motor and the air give [m/s^2], held) at this state."""
        thrusting = thrust > 0.0
        force = thrust
        drag = 0.0
        need_air = (thrusting and self.p_ref is not None and self.A_e > 0.0) or \
            (self.drag is not None and self.A_ref > 0.0 and v != 0.0)
        if need_air:
            _, p, rho, a, _ = self._isa(self.elevation + max(z, 0.0))
            if thrusting and self.p_ref is not None:
                force += (self.p_ref - p) * self.A_e
            if self.drag is not None and v != 0.0:
                cd = float(np.interp(abs(v) / a, self._mach, self._cd_on if thrusting else self._cd_off))
                drag = 0.5 * rho * v * abs(v) * cd * self.A_ref
        specific = (force - drag) / m
        held = z <= 0.0 and v <= 0.0 and specific <= G0
        return specific, held

    def _rhs(self, z: float, v: float, m: float, thrust: float, mdot: float) -> Tuple[float, float, float]:
        specific, held = self._specific(z, v, m, thrust)
        return v, (0.0 if held else specific - G0), -mdot

    def specific_force(self) -> float:
        """The axial specific force at the current sample [m/s^2]: exactly ``G0`` while held."""
        specific, held = self._specific(self.z, self.v, self.m, self.thrust)
        return G0 if held else specific

    @property
    def held(self) -> bool:
        return self._specific(self.z, self.v, self.m, self.thrust)[1]

    def advance(self, t: float, thrust_N: float, mdot_kg_s: float) -> float:
        """Move the ascent to ``t`` with the thrust and total propellant flow sampled there, linear
        from the previous sample, and return the specific force at ``t`` [m/s^2]. The first call
        only places the vehicle on the pad at ``t``."""
        t, f1, md1 = float(t), float(thrust_N), float(mdot_kg_s)
        if self.t is not None:
            span = t - self.t
            if span < -1e-12:
                raise ValueError(f"InlineAscent: time runs backwards ({self.t} -> {t})")
            if span > 0.0:
                self._integrate(self.t, t, self.thrust, f1, self.mdot, md1)
        self.t, self.thrust, self.mdot = t, f1, md1
        if self.liftoff_time_s is None and not self.held:
            self.liftoff_time_s = t  # released at this sample (thrust over weight at rest)
        return self.specific_force()

    def _integrate(self, t0: float, t1: float, f0: float, f1: float, md0: float, md1: float) -> None:
        span = t1 - t0
        n = max(1, int(math.ceil(span / self.dt_max - 1e-9)))
        h = span / n
        z, v, m = self.z, self.v, self.m

        def at(tau: float) -> Tuple[float, float]:
            frac = (tau - t0) / span
            return f0 + (f1 - f0) * frac, md0 + (md1 - md0) * frac

        for i in range(n):
            ta = t0 + i * h
            k1 = self._rhs(z, v, m, *at(ta))
            k2 = self._rhs(z + h / 2 * k1[0], v + h / 2 * k1[1], m + h / 2 * k1[2], *at(ta + h / 2))
            k3 = self._rhs(z + h / 2 * k2[0], v + h / 2 * k2[1], m + h / 2 * k2[2], *at(ta + h / 2))
            k4 = self._rhs(z + h * k3[0], v + h * k3[1], m + h * k3[2], *at(ta + h))
            was_resting = z <= 0.0 and v <= 0.0
            z += h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])
            v += h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
            m += h / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])
            if was_resting and v > 0.0 and self.liftoff_time_s is None:
                self.liftoff_time_s = ta  # to the substep: the vehicle was at rest at its start
        if m <= 0.0:
            raise ValueError(f"InlineAscent: the propellant flows have burned the vehicle's whole mass by t = {t1}")
        self.z, self.v, self.m = z, v, m


def _vehicle_terms(config: Any, drag: Any = None) -> Tuple[float, float, float, Any]:
    """(nozzle exit area [m^2], body reference area [m^2], pad elevation [m], Cd(M)) of the vehicle
    ``ui.flight_sim.setup_flight`` builds from ``config``: the same functions, so the inline ascent
    and RocketPy fly one vehicle."""
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    from engine.pipeline.vehicle_drag import built_stack, resolve_drag_curves

    a_e = float(ensure_chamber_geometry(config).A_exit)
    a_ref = math.pi * float(config.rocket.radius) ** 2
    elevation = float(config.environment.elevation)
    if drag is None:
        drag = resolve_drag_curves(config, a_e, built_stack(config))
    return a_e, a_ref, elevation, drag


def inline_specific_force(config: Any, thrust_N: Sequence[float], mdot_total: Sequence[float], t: Sequence[float],
                          liftoff_mass_kg: float, ambient_pa: float, *, drag: Any = None,
                          dt_max: float = 0.01) -> Dict[str, Any]:
    """The axial specific force at each of the burn's samples, from a vertical 1-DOF ascent on
    this thrust and total propellant flow (D5-C, ``settings.flight_coupling = 'inline'``).

    ``t`` is the burn's clock (any origin; samples before Fire carry zero thrust and read 1 g0);
    ``thrust_N`` and ``mdot_total`` are sampled at ``t`` and taken linear in between;
    ``liftoff_mass_kg`` is the vehicle at ``t[0]`` (:func:`liftoff_mass`); ``ambient_pa`` is the
    pressure the thrust was computed against. The vehicle (body, nozzle exit, drag, pad) is
    ``config``'s, as the RocketPy flight builds it; ``drag`` overrides its Cd(M).

    Returns ``{t, accel_m_s2, ...}``: ``{t, accel_m_s2}`` is the shape :func:`fly`'s ``schedule``
    has, so it drops into the burn loop unchanged. Causal: the value at ``t[k]`` uses samples up to
    ``t[k]`` only, so a burn pass can also drive :class:`InlineAscent` one step at a time."""
    t_arr = np.asarray(t, dtype=float)
    f_arr = np.asarray(thrust_N, dtype=float)
    md_arr = np.asarray(mdot_total, dtype=float)
    if not (t_arr.shape == f_arr.shape == md_arr.shape) or t_arr.ndim != 1 or len(t_arr) == 0:
        raise ValueError("inline_specific_force: t, thrust_N and mdot_total must be 1-D and of one length")
    if np.any(np.diff(t_arr) < 0.0):
        raise ValueError("inline_specific_force: t must not decrease")
    a_e, a_ref, elevation, drag = _vehicle_terms(config, drag)
    ascent = InlineAscent(mass_kg=liftoff_mass_kg, reference_area_m2=a_ref, nozzle_exit_area_m2=a_e,
                          elevation_m=elevation, reference_pressure_pa=ambient_pa, drag=drag, dt_max=dt_max)
    accel, z, v, m, held = [], [], [], [], []
    for tk, fk, mk in zip(t_arr, f_arr, md_arr):
        accel.append(ascent.advance(float(tk), float(fk), float(mk)))
        z.append(ascent.z)
        v.append(ascent.v)
        m.append(ascent.m)
        held.append(bool(ascent.held))
    env = config.environment
    inclination = float(getattr(env, "launch_inclination_deg", 90.0) or 90.0)
    notes = []
    if abs(inclination - 90.0) > 1e-9:
        notes.append(f"The rail is inclined {inclination:g} deg; the inline ascent flies vertical.")
    return {
        "t": t_arr.tolist(),
        "accel_m_s2": accel,
        "accel_g": [a / G0 for a in accel],
        "altitude_m": z,
        "velocity_m_s": v,
        "mass_kg": m,
        "held": held,
        "liftoff_time_s": ascent.liftoff_time_s,
        "notes": notes,
        "model": {
            "name": "inline_vertical_1dof",
            "source": INLINE_SOURCE,
            "assumptions": [
                "vertical flight from the pad: the rail's inclination, wind and attitude are ignored",
                "standard gravity g0 = 9.80665 m/s^2 throughout (Somigliana at the site is ~0.11 % less)",
                "a vehicle at rest whose thrust, pressure thrust and drag are below its weight is held and "
                "reads exactly 1 g0",
                "thrust and propellant flow linear between the given samples; RK4 in substeps of at most "
                f"{dt_max * 1e3:g} ms",
                "pressure thrust (p_ref - p(z)) A_e only while the thrust sample is positive; power-on Cd while "
                "thrusting, power-off otherwise",
                "mass leaves as propellant only; the pressurant stays aboard",
            ],
            "inputs": {
                "liftoff_mass_kg": {"value": float(liftoff_mass_kg), "unit": "kg",
                                    "provenance": "caller (weighed, or liftoff_mass() from the config and the twin)"},
                "reference_pressure_pa": {"value": float(ambient_pa), "unit": "Pa",
                                          "provenance": "caller: the ambient the thrust curve was computed at"},
                "nozzle_exit_area_m2": {"value": a_e, "unit": "m^2", "provenance": "config chamber geometry (A_exit)"},
                "reference_area_m2": {"value": a_ref, "unit": "m^2", "provenance": "config rocket.radius"},
                "elevation_m": _cfg_input(env, "elevation", "m", "environment"),
                "launch_inclination_deg": _cfg_input(env, "launch_inclination_deg", "deg", "environment"),
                "surface_roughness_m": _cfg_input(config.rocket, "surface_roughness_m", "m", "rocket"),
                "drag_model": {"value": getattr(drag, "model", None), "unit": "",
                               "provenance": getattr(drag, "source", "caller")},
                "dt_max_s": {"value": float(dt_max), "unit": "s", "provenance": "numerical setting"},
            },
        },
    }


def liftoff_mass(config: Any, loads: Dict[str, float], *, ambient_pa: float = 101325.0,
                 pressurant_kg: Optional[float] = None, copv_volume_L: Optional[float] = None,
                 ullage_gas_kg: Optional[float] = None, pressurant_gas: Optional[str] = None,
                 weighed_kg: Optional[float] = None) -> Dict[str, Any]:
    """The vehicle's mass at Fire [kg], booked as ``ui.flight_sim.setup_flight`` books it, without
    building the RocketPy flight: for :func:`inline_specific_force` inside a burn pass.

    ``weighed_kg`` (the vehicle on the rail) wins when given. Otherwise: the config's airframe and
    motor dry mass (the COPV structure scaled to the twin's bottle as :func:`fly` scales it), the
    loads (capped to what the config's tanks hold, as the flight caps them), the bottle's gas, and
    the T-0 ullage gas (``ullage_gas_kg``, the drawing's; else the config tanks' own at
    ``initial_pressure_psi``). Returns ``{value, source, parts, notes}``."""
    from ui.flight_sim import ullage_gas_density
    from engine.pipeline.tank_capacity import resolve_fuel_tank_limits, resolve_lox_tank_limits
    from engine.pipeline.vehicle_drag import built_stack

    notes: List[str] = []
    if weighed_kg is not None:
        return {"value": float(weighed_kg), "source": "weighed (settings.liftoff_mass_kg)", "parts": {}, "notes": notes}
    cfg = _flight_config(config, None, loads, ambient_pa, pressurant_kg, copv_volume_L, notes,
                         pressurant_gas=pressurant_gas)
    dry = config_dry_kg(cfg)
    if dry is None:
        raise ValueError("liftoff_mass: the config states no vehicle (rocket airframe and motor masses)")
    rho_o, rho_f = float(cfg.fluids["oxidizer"].density), float(cfg.fluids["fuel"].density)
    cap_o = resolve_lox_tank_limits(cfg, rho_o)[0]
    cap_f = resolve_fuel_tank_limits(cfg, rho_f)[0]
    m_o = min(float(loads["oxidiser"]), float(cap_o))
    m_f = min(float(loads["fuel"]), float(cap_f))
    for side, load, cap in (("LOX", loads["oxidiser"], cap_o), ("fuel", loads["fuel"], cap_f)):
        if float(load) > float(cap):
            notes.append(f"{side} load {float(load):.3f} kg capped to the config tank's {float(cap):.3f} kg, as the flight caps it.")
    press = getattr(cfg, "press_tank", None)
    m_p = float((getattr(press, "initial_gas_mass", None) or 0.0) if press is not None else 0.0)
    if ullage_gas_kg is not None:
        m_u = float(ullage_gas_kg)
        u_source = "caller (the drawing's tanks at Fire)"
    else:
        stack = built_stack(cfg)
        m_u = 0.0
        for section, m_liq, rho_liq, h, r in ((cfg.lox_tank, m_o, rho_o, stack["lox_h"], cfg.lox_tank.lox_radius),
                                              (cfg.fuel_tank, m_f, rho_f, stack["fuel_h"], cfg.fuel_tank.rp1_radius)):
            v_ull = math.pi * float(r) ** 2 * float(h) - m_liq / rho_liq
            m_u += 0.999 * max(v_ull, 0.0) * ullage_gas_density(section)[0]
        u_source = "the config's tanks at initial_pressure_psi, CoolProp"
    total = dry + m_o + m_f + m_p + m_u
    return {
        "value": float(total),
        "source": "config airframe + motor dry mass, loads, bottle gas and T-0 ullage gas",
        "parts": {"dry_kg": float(dry), "oxidizer_kg": m_o, "fuel_kg": m_f, "pressurant_kg": m_p,
                  "ullage_gas_kg": m_u, "ullage_gas_source": u_source,
                  "pressurant_gas": str(cfg.lox_tank.ullage_gas)},
        "notes": notes,
    }


def fly(config: Any, timeseries: Dict[str, Any], loads: Dict[str, float], ambient_pa: float, *,
        pressurant_kg: Optional[float] = None, copv_volume_L: Optional[float] = None,
        liftoff_mass_kg: Optional[float] = None, ullage_gas_kg: Optional[float] = None,
        pressurant_gas: Optional[str] = None) -> Dict[str, Any]:
    """Fly a Layer X burn (``timeseries`` in the Time-Series shape, ``replay.timeseries_payload``)
    in EngineDesign's flight simulation. Returns the flight's figures, its trajectory, the
    vehicle's stability over the burn (``stability``, DATA-CONTRACT 4), and the proper
    acceleration at every firing step on the burn's own clock.

    ``pressurant_kg`` is the bottle's gas at T-0 and ``copv_volume_L`` its volume, both from the
    twin. When they are given, they replace the config's COPV sizing in the vehicle's mass.

    ``pressurant_gas`` is the drawing's pressurant (``prep.derived["pressurant_gas"]``, e.g.
    ``"helium"``). When given, the T-0 ullage gas and the COPV's refill of the ullages are priced
    as that gas instead of the config tanks' ``ullage_gas``; ``None`` keeps the config's.

    ``liftoff_mass_kg`` is the vehicle as weighed on the rail. When given, the airframe is what is
    left of it after the motor, propellants and gases, so the vehicle lifts off at that mass.
    ``ullage_gas_kg`` is the gas already in the drawing's tanks at Fire, which flies with them."""
    from ui.flight_sim import setup_flight
    from scipy.interpolate import interp1d

    data = timeseries["data"]
    clock = np.asarray(data["time"], dtype=float)
    t = clock - clock[0]
    pre_notes: List[str] = []
    cfg = _flight_config(config, timeseries, loads, ambient_pa, pressurant_kg, copv_volume_L, pre_notes,
                         pressurant_gas=pressurant_gas)

    def curve(key: str, scale: float = 1.0) -> Any:
        return interp1d(t, np.asarray(data[key], dtype=float) * scale, kind="linear", bounds_error=False, fill_value=0.0)

    from engine.layerx.capture import thread_stdout

    try:
        with thread_stdout() as printed:
            result = setup_flight(cfg, curve("thrust_kN", 1e3), curve("mdot_O_kg_s"), curve("mdot_F_kg_s"),
                                  liftoff_mass=liftoff_mass_kg, ullage_gas_kg=ullage_gas_kg)
    except ValueError as exc:  # a vehicle that cannot fly (no airframe left, T/W under 1) is a finding
        return {"ok": False, "error": str(exc), "notes": pre_notes}
    except Exception as exc:  # noqa: BLE001 - a config the flight cannot build fails the flight, not the burn
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "notes": pre_notes}
    said = [line.split("] ", 1)[-1] for line in printed.getvalue().splitlines() if line.startswith("[flight_sim]")]
    flight = result.get("flight")
    if flight is None:
        return {"ok": False, "error": result.get("error") or "the flight simulation did not fly",
                "notes": pre_notes + said}

    accel = [axial_acceleration(flight, float(tt)) for tt in t]
    report = result.get("flight_report") or {}
    elevation = float(report.get("elevation_m", getattr(config.environment, "elevation", 0.0)))
    apogee_agl = float(result["apogee"])
    t_end = float(flight.apogee_time)
    grid = np.linspace(0.0, t_end, TRAJECTORY_POINTS)
    trajectory = {
        "t": grid.tolist(),
        "altitude_m": [float(flight.z(x)) - elevation for x in grid],
        "velocity_m_s": [float(flight.vz(x)) for x in grid],
        "mach": [float(flight.mach_number(x)) for x in grid],
        "accel_axial_g": [axial_acceleration(flight, float(x)) / G0 for x in grid],
    }
    i_max = int(np.argmax(accel))
    out = {
        "ok": True,
        "apogee_agl_m": apogee_agl,
        "apogee_msl_m": float(result.get("apogee_asl", apogee_agl + elevation)),
        "apogee_time_s": t_end,
        "max_velocity_m_s": float(result["max_velocity"]),
        "max_mach": float(report.get("max_mach", flight.max_mach_number)),
        "rail_exit_velocity_m_s": float(flight.out_of_rail_velocity),
        "rail_exit_time_s": float(flight.out_of_rail_time),
        "liftoff_accel_g": accel[0] / G0,
        "max_accel_g": accel[i_max] / G0,
        "max_accel_time_s": float(t[i_max]),
        "stability": _stability_or_failure(flight, cfg, clock, report.get("stability")),
        "pressurant_gas": str(cfg.lox_tank.ullage_gas),
        "checks": report.get("checks") or [],
        "ceiling": _ceiling(config, apogee_agl, elevation),
        "liftoff_mass_kg": float(flight.rocket.total_mass(0.0)),
        "burnout_mass_kg": float(flight.rocket.total_mass(float(t[-1]))),
        "mass_budget": result.get("mass_budget"),
        "notes": pre_notes + said + list(report.get("warnings") or []),
        "trajectory": trajectory,
        # On the burn's clock, one value per firing step.
        "schedule": {"t": clock.tolist(), "accel_m_s2": accel},
        "truncation": result.get("truncation_info") or {},
    }
    return out


def schedule_change(old: Optional[Dict[str, Any]], new: Optional[Dict[str, Any]]) -> float:
    """Largest relative move of the acceleration between two histories, on the newer one's
    clock. ``inf`` when there was no previous history. The last sample is left out: it sits at
    the depletion instant, which moves by a fraction of a step each pass, so it compares the
    tail-off of one burn against full thrust of the other and only ever governs a partial step."""
    if old is None or new is None:
        return math.inf
    t = list(new["t"])
    a = list(new["accel_m_s2"])
    if len(t) > 2:
        t, a = t[:-1], a[:-1]
    a_new = np.asarray(a, dtype=float)
    a_old = np.interp(t, old["t"], old["accel_m_s2"])
    return float(np.max(np.abs(a_new - a_old) / np.maximum(np.abs(a_new), G0)))
