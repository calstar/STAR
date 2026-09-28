"""
flight_sim.py
--------------
Reusable RocketPy-based liquid engine flight simulation module.
"""

import numpy as np
import math
import warnings
import matplotlib.pyplot as plt
from rocketpy import Environment, Rocket, Flight, Function, Fluid
from rocketpy.motors import LiquidMotor, CylindricalTank
from rocketpy.motors.tank import MassBasedTank, MassFlowRateBasedTank
from pathlib import Path

# Suppress RocketPy's harmless Function domain warnings during tank calculations
# These occur when RocketPy internally composes Functions for liquid level vs time
# and the discretization boundaries don't perfectly align (numerical precision issue)
warnings.filterwarnings(
    "ignore",
    message=".*must be within the domain of the Function.*",
    category=UserWarning,
)

g0 = 9.80665

def detect_tank_underfill_time(mdot, m_initial, burn_time, n_samples=5000):
    """
    Detect when a tank would get underfilled by integrating mdot over time.
    
    Parameters:
    -----------
    mdot : float or Function
        Mass flow rate. Can be a constant float or a RocketPy Function.
    m_initial : float
        Initial tank mass [kg]
    burn_time : float
        Total burn time [s]
    n_samples : int
        Number of time samples for integration (default: 5000)
    
    Returns:
    --------
    cutoff_time : float or None
        Time at which tank would be depleted (None if it never depletes)
    """
    # Create time array for sampling with higher resolution
    times = np.linspace(0, burn_time, n_samples)
    dt = burn_time / (n_samples - 1) if n_samples > 1 else burn_time
    
    # Sample mdot values
    if isinstance(mdot, Function):
        # It's a RocketPy Function - evaluate at each time
        mdot_values = np.array([mdot(t) for t in times])
    elif callable(mdot):
        # It's a callable function (e.g., scipy.interpolate.interp1d) - evaluate at each time
        mdot_values = np.array([float(mdot(t)) for t in times])
    else:
        # It's a constant float
        mdot_values = np.full_like(times, float(mdot))
    
    # Integrate mdot to get cumulative mass consumed
    # Use trapezoidal integration
    cumulative_mass = np.zeros_like(times)
    for i in range(1, len(times)):
        # Trapezoidal integration: ∫ mdot dt ≈ (mdot[i-1] + mdot[i]) * dt / 2
        cumulative_mass[i] = cumulative_mass[i-1] + (mdot_values[i-1] + mdot_values[i]) * dt / 2.0
    
    # Find where cumulative mass exceeds initial tank mass
    # Find the first index where cumulative_mass >= m_initial
    depletion_idx = np.where(cumulative_mass >= m_initial)[0]
    
    if len(depletion_idx) > 0:
        idx = depletion_idx[0]
        
        # Interpolate to find the exact cutoff time between samples
        if idx > 0:
            # Linear interpolation: find t where cumulative_mass(t) = m_initial
            mass_prev = cumulative_mass[idx - 1]
            mass_curr = cumulative_mass[idx]
            t_prev = times[idx - 1]
            t_curr = times[idx]
            
            # Linear interpolation: t = t_prev + (m_initial - mass_prev) * (t_curr - t_prev) / (mass_curr - mass_prev)
            if mass_curr > mass_prev:
                fraction = (m_initial - mass_prev) / (mass_curr - mass_prev)
                cutoff_time = t_prev + fraction * (t_curr - t_prev)
            else:
                cutoff_time = t_curr
        else:
            # Depletion happens at the very first sample
            cutoff_time = times[idx]
        
        return float(cutoff_time)
    else:
        # Tank never depletes during the burn
        return None

def detect_lox_underfill_time(mdot_lox, m_lox0, burn_time, n_samples=5000):
    """
    Detect when LOX tank would get underfilled by integrating mdot_lox over time.
    
    Parameters:
    -----------
    mdot_lox : float or Function
        LOX mass flow rate. Can be a constant float or a RocketPy Function.
    m_lox0 : float
        Initial LOX mass [kg]
    burn_time : float
        Total burn time [s]
    n_samples : int
        Number of time samples for integration (default: 5000)
    
    Returns:
    --------
    cutoff_time : float or None
        Time at which LOX would be depleted (None if it never depletes)
    """
    return detect_tank_underfill_time(mdot_lox, m_lox0, burn_time, n_samples)

def detect_fuel_underfill_time(mdot_fuel, m_fuel0, burn_time, n_samples=5000):
    """
    Detect when fuel tank would get underfilled by integrating mdot_fuel over time.
    
    Parameters:
    -----------
    mdot_fuel : float or Function
        Fuel mass flow rate. Can be a constant float or a RocketPy Function.
    m_fuel0 : float
        Initial fuel mass [kg]
    burn_time : float
        Total burn time [s]
    n_samples : int
        Number of time samples for integration (default: 5000)
    
    Returns:
    --------
    cutoff_time : float or None
        Time at which fuel would be depleted (None if it never depletes)
    """
    return detect_tank_underfill_time(mdot_fuel, m_fuel0, burn_time, n_samples)

def truncate_thrust_curve(thrust_curve, cutoff_time):
    """
    Truncate thrust curve at cutoff_time, setting thrust to 0 after that point.
    
    Parameters:
    -----------
    thrust_curve : list of (t, F) tuples or Function
        Original thrust curve
    cutoff_time : float
        Time at which to cut off thrust
    
    Returns:
    --------
    truncated_curve : list of (t, F) tuples
        Thrust curve with thrust=0 after cutoff_time
    """
    # Extend domain slightly beyond cutoff_time to avoid RocketPy warnings
    # about evaluating functions outside their domain during numerical integration
    domain_buffer = max(0.01, cutoff_time * 0.02)  # 2% buffer or 10ms minimum
    extended_time = cutoff_time + domain_buffer
    
    if isinstance(thrust_curve, Function) or callable(thrust_curve):
        # Convert Function or callable (e.g., interp1d) to list of tuples by sampling with high resolution
        # Use at least 500 samples per second for accurate representation
        n_samples = max(int(cutoff_time * 500) + 1, 500)
        times = np.linspace(0, cutoff_time, n_samples)
        curve = [(float(t), float(thrust_curve(t))) for t in times]
        # Ensure the last point is exactly at cutoff_time with thrust value
        if curve[-1][0] != cutoff_time:
            curve.append((cutoff_time, float(thrust_curve(cutoff_time))))
        # Add cutoff point with 0 thrust (small epsilon after for sharp transition)
        curve.append((cutoff_time + 1e-6, 0.0))
        # Add extended endpoint with 0 thrust to avoid RocketPy domain warnings
        curve.append((extended_time, 0.0))
        return curve
    elif isinstance(thrust_curve, list):
        # It's already a list of (t, F) tuples
        truncated = []
        for t, F in thrust_curve:
            if t < cutoff_time:
                truncated.append((t, F))
            elif t == cutoff_time:
                # If we hit cutoff_time exactly, use that value then add 0
                truncated.append((t, F))
                break
            else:
                # We've passed cutoff_time - interpolate and add cutoff point
                if len(truncated) > 0:
                    prev_t, prev_F = truncated[-1]
                    # Linear interpolation to cutoff_time
                    if t > prev_t:
                        F_cutoff = prev_F + (F - prev_F) * (cutoff_time - prev_t) / (t - prev_t)
                    else:
                        F_cutoff = prev_F
                    truncated.append((cutoff_time, F_cutoff))
                else:
                    # No previous points, just add cutoff with 0
                    truncated.append((cutoff_time, 0.0))
                break
        # Ensure we end with 0 thrust at cutoff_time
        if len(truncated) == 0:
            truncated.append((cutoff_time, 0.0))
        elif truncated[-1][0] < cutoff_time:
            # Add cutoff point if we haven't reached it yet
            if len(truncated) > 0:
                prev_t, prev_F = truncated[-1]
                truncated.append((cutoff_time, prev_F))
            truncated.append((cutoff_time, 0.0))
        elif truncated[-1][0] == cutoff_time and truncated[-1][1] != 0.0:
            # We're at cutoff_time but thrust isn't 0, add a 0 point
            truncated.append((cutoff_time, 0.0))
        # Add extended endpoint with 0 thrust to avoid RocketPy domain warnings
        truncated.append((extended_time, 0.0))
        return truncated
    else:
        raise TypeError(f"Unsupported thrust_curve type: {type(thrust_curve)}")

def truncate_mdot_function(mdot_func, cutoff_time, burn_time):
    """
    Create a new mdot function that is 0 after cutoff_time.
    
    Parameters:
    -----------
    mdot_func : float or Function
        Original mass flow rate
    cutoff_time : float
        Time at which to cut off mass flow
    burn_time : float
        Total burn time (for creating the function domain)
    
    Returns:
    --------
    truncated_func : Function
        Function that returns mdot_func(t) for t <= cutoff_time, 0 otherwise
    """
    # Use higher resolution sampling (500 points per second minimum)
    n_samples = max(int(burn_time * 500) + 1, 1000)
    
    # Extend domain slightly beyond burn_time to avoid RocketPy warnings
    # about evaluating functions outside their domain during numerical integration
    domain_buffer = max(0.01, burn_time * 0.02)  # 2% buffer or 10ms minimum
    extended_time = burn_time + domain_buffer
    
    if isinstance(mdot_func, Function) or callable(mdot_func):
        # Create base time samples with higher resolution, extending slightly beyond burn_time
        times_base = np.linspace(0, extended_time, n_samples)
        
        # Ensure cutoff_time and a point just after are explicitly included for sharp transition
        # This prevents RocketPy from interpolating a gradual falloff
        eps = 1e-6  # Small epsilon for sharp transition
        critical_times = [cutoff_time, cutoff_time + eps, extended_time]
        
        # Combine and sort all time points, removing duplicates
        times_all = np.unique(np.concatenate([times_base, critical_times]))
        times_all = times_all[times_all <= extended_time]
        
        # Evaluate original function and apply cutoff (0 after cutoff_time)
        values = np.array([float(mdot_func(t)) if t <= cutoff_time else 0.0 for t in times_all])
        
        # RocketPy Function expects 2D array: [[x1, y1], [x2, y2], ...]
        source = np.column_stack((times_all, values))
        return Function(source)
    else:
        # It's a constant - create a function that's constant until cutoff, then 0
        times_base = np.linspace(0, extended_time, n_samples)
        
        # Ensure cutoff_time and a point just after are explicitly included for sharp transition
        eps = 1e-6
        critical_times = [cutoff_time, cutoff_time + eps, extended_time]
        
        # Combine and sort all time points, removing duplicates
        times_all = np.unique(np.concatenate([times_base, critical_times]))
        times_all = times_all[times_all <= extended_time]
        
        # Apply constant value before cutoff, 0 after
        mdot_val = float(mdot_func)
        values = np.array([mdot_val if t <= cutoff_time else 0.0 for t in times_all])
        
        # RocketPy Function expects 2D array: [[x1, y1], [x2, y2], ...]
        source = np.column_stack((times_all, values))
        return Function(source)

def _sample(source, times):
    """Values of a thrust / mdot source (float, callable, RocketPy Function, (t, v) list) at times."""
    if isinstance(source, (list, tuple)) and source and isinstance(source[0], (list, tuple)):
        arr = np.asarray(source, dtype=float)
        return np.interp(times, arr[:, 0], arr[:, 1], left=0.0, right=0.0)
    if isinstance(source, Function) or callable(source):
        return np.array([float(source(t)) for t in times])
    return np.full_like(np.asarray(times, dtype=float), float(source))


def _cumulative(times, rates):
    return np.concatenate([[0.0], np.cumsum(0.5 * (rates[1:] + rates[:-1]) * np.diff(times))])


def _depletion_time(times, cumulative, m0):
    """First time the integral of mdot reaches m0, linear between samples; None if it never does."""
    idx = np.nonzero(cumulative >= m0)[0]
    if len(idx) == 0:
        return None
    i = int(idx[0])
    if i == 0:
        return float(times[0])
    c0, c1 = cumulative[i - 1], cumulative[i]
    return float(times[i - 1] + (m0 - c0) / (c1 - c0) * (times[i] - times[i - 1]))


def _on_grid(times, values, t_end):
    """(t, v) samples on [0, t_end], t_end included, for a RocketPy Function."""
    keep = times < t_end
    t = np.concatenate([times[keep], [t_end]])
    v = np.concatenate([values[keep], [np.interp(t_end, times, values)]])
    return np.column_stack((t, v))


def ullage_gas_density(tank_section):
    """Pressurant density in a tank's ullage at T-0 [kg/m3], CoolProp at the tank's
    initial_pressure_psi (absolute, as the engine solver reads it) and ullage_gas_temperature_K."""
    import CoolProp.CoolProp as CP

    P_psi = getattr(tank_section, "initial_pressure_psi", None)
    if P_psi is None:
        raise ValueError("Tank initial_pressure_psi is required to size the ullage gas")
    P = float(P_psi) * 6894.757293168
    T = float(tank_section.ullage_gas_temperature_K)
    return float(CP.PropsSI("D", "P", P, "T", T, str(tank_section.ullage_gas))), P, T


def flight_report(flight, config, drag_curves=None, extra=None):
    """What a flight says about the vehicle beyond apogee: Mach, rail exit, static margin, the
    ceiling datum, and the requirement checks the config declares. Pure: reads the flight."""
    rocket = flight.rocket
    elevation = float(config.environment.elevation)
    apogee_msl = float(flight.apogee)
    burnout = float(rocket.motor.burn_out_time)
    t_rail = float(flight.out_of_rail_time)
    buttons = getattr(config.rocket, "rail_button_upper_pos_m", None) is not None and getattr(config.rocket, "rail_button_lower_pos_m", None) is not None
    report = {
        "apogee_agl_m": apogee_msl - elevation,
        "apogee_msl_m": apogee_msl,
        "elevation_m": elevation,
        "max_mach": float(flight.max_mach_number),
        "max_speed_m_s": float(flight.max_speed),
        "burnout_time_s": burnout,
        "total_impulse_Ns": float(rocket.motor.total_impulse),
        "launch": {
            "rail_length_m": float(flight.rail_length),
            "effective_rail_length_m": float(flight.effective_1rl),
            "rail_buttons_declared": bool(buttons),
            "inclination_deg": float(flight.inclination),
            "heading_deg": float(flight.heading),
            "rail_exit_velocity_m_s": float(flight.out_of_rail_velocity),
            "rail_exit_time_s": t_rail,
        },
        "stability": {
            # Mach-0 Barrowman CP against the moving CG, in body diameters
            "static_margin_liftoff_cal": float(rocket.static_margin(0.0)),
            "static_margin_rail_exit_cal": float(rocket.static_margin(t_rail)),
            "static_margin_burnout_cal": float(rocket.static_margin(burnout)),
            # CP at the flight Mach, to apogee
            "min_stability_margin_cal": float(flight.min_stability_margin),
            "min_stability_margin_time_s": float(flight.min_stability_margin_time),
            "max_stability_margin_cal": float(flight.max_stability_margin),
            "max_stability_margin_time_s": float(flight.max_stability_margin_time),
        },
        "checks": [],
        "warnings": [],
    }
    if drag_curves is not None:
        report["drag"] = drag_curves.to_dict()
    dr = getattr(config, "design_requirements", None)
    checks = report["checks"]
    v_min = getattr(dr, "min_rail_exit_velocity_m_s", None) if dr is not None else None
    if v_min is not None:
        v = report["launch"]["rail_exit_velocity_m_s"]
        checks.append({"name": "rail_exit_velocity", "value": v, "limit": float(v_min), "kind": "min", "passed": v >= v_min,
                       "note": None if buttons else "no rail buttons declared: full rail length flown, an upper bound"})
    for key, kind in (("min_static_margin_cal", "min"), ("max_static_margin_cal", "max")):
        lim = getattr(dr, key, None) if dr is not None else None
        if lim is None:
            continue
        for where in ("rail_exit", "burnout"):
            sm = report["stability"][f"static_margin_{where}_cal"]
            checks.append({"name": f"static_margin_{where}", "value": sm, "limit": float(lim), "kind": kind,
                           "passed": sm >= lim if kind == "min" else sm <= lim})
    for c in checks:
        if not c["passed"]:
            report["warnings"].append(
                f"{c['name']} {c['value']:.2f} {'below' if c['kind'] == 'min' else 'above'} the required {c['limit']:.2f}"
            )
    if extra:
        for k, v in extra.items():
            if k == "warnings":
                report["warnings"].extend(v)
            else:
                report[k] = v
    return report


def setup_flight(config, thrust_curve, mdot_lox, mdot_fuel, plot_results=False):
    """
    Build and fly the vehicle in RocketPy from a thrust curve and the two propellant flows.

    Returns a dict: apogee (AGL), apogee_asl, max_velocity (vertical), flight (RocketPy Flight),
    truncation_info, mass_caps, flight_report (see flight_report), params (the config).
    """
    burn_time = float(config.thrust.burn_time)

    # Densities from config
    rho_lox = config.fluids['oxidizer'].density
    rho_rp1 = config.fluids['fuel'].density

    # Initial masses from config
    m_lox0 = config.lox_tank.mass
    m_rp10 = config.fuel_tank.mass

    # Cap propellant to what the tank holds (explicit capacity, else volume x fill factor)
    from engine.pipeline.tank_capacity import resolve_fuel_tank_limits, resolve_lox_tank_limits

    mass_caps = {}
    lox_max_mass, lox_tank_volume, lox_ff, _ = resolve_lox_tank_limits(config, rho_lox)
    lox_requested = m_lox0
    if m_lox0 > lox_max_mass:
        print(
            f"[flight_sim] Capping LOX mass: {m_lox0:.2f} -> {lox_max_mass:.2f} kg "
            f"(tank vol: {lox_tank_volume * 1000:.1f}L, {lox_ff * 100:.0f}% fill)"
        )
        m_lox0 = lox_max_mass
    mass_caps["lox"] = {
        "requested_kg": lox_requested,
        "effective_kg": m_lox0,
        "max_fill_kg": lox_max_mass,
        "tank_volume_m3": lox_tank_volume,
        "was_capped": lox_requested > m_lox0 + 1e-6,
        "fill_factor": lox_ff,
    }

    rp1_max_mass, rp1_tank_volume, fuel_ff, _ = resolve_fuel_tank_limits(config, rho_rp1)
    fuel_requested = m_rp10
    if m_rp10 > rp1_max_mass:
        print(
            f"[flight_sim] Capping Fuel mass: {m_rp10:.2f} -> {rp1_max_mass:.2f} kg "
            f"(tank vol: {rp1_tank_volume * 1000:.1f}L, {fuel_ff * 100:.0f}% fill)"
        )
        m_rp10 = rp1_max_mass
    mass_caps["fuel"] = {
        "requested_kg": fuel_requested,
        "effective_kg": m_rp10,
        "max_fill_kg": rp1_max_mass,
        "tank_volume_m3": rp1_tank_volume,
        "was_capped": fuel_requested > m_rp10 + 1e-6,
        "fill_factor": fuel_ff,
    }

    # DEPLETION. Thrust and both flows stop at the instant the first tank runs dry, with no margin.
    #
    # This used to chop 50 ms (or 1 % of the burn) off every truncated burn, because
    # MassFlowRateBasedTank re-integrates mdot on 100 points and goes a hair negative at an exact
    # depletion; and when that did not fire, a fuel-only loop shrank the burn to 98 % of the fuel
    # whenever the load came within 1 mg of the integral. Which one fired was floating-point noise:
    # loads of the exact integral x (1, 1+1e-9, 1+1e-6) flew 3941 / 3890 / 4033 m on the 6.5 kN
    # vehicle. The tanks below are MassBasedTank on the liquid mass itself, clipped at 1e-9 kg
    # (0.0 still trips RocketPy's inverse_volume domain), so an exact depletion is legal and the
    # result is continuous in the load.
    n_grid = max(5001, int(burn_time * 2000) + 1)
    t_grid = np.linspace(0.0, burn_time, n_grid)
    mdot_O_grid = _sample(mdot_lox, t_grid)
    mdot_F_grid = _sample(mdot_fuel, t_grid)
    cum_O = _cumulative(t_grid, mdot_O_grid)
    cum_F = _cumulative(t_grid, mdot_F_grid)
    t_dep = {"LOX": _depletion_time(t_grid, cum_O, m_lox0), "fuel": _depletion_time(t_grid, cum_F, m_rp10)}
    t_dep = {k: v for k, v in t_dep.items() if v is not None and v < burn_time}
    if t_dep:
        cutoff_reason = min(t_dep, key=t_dep.get)
        effective_burn_time = t_dep[cutoff_reason]
        if effective_burn_time <= 0.0:
            return {
                "success": False,
                "error": f"{cutoff_reason} tank is empty at ignition.",
                "flight": None,
                "flight_time": 0.0,
                "apogee": 0.0,
                "max_velocity": 0.0,
                "truncation_info": {"truncated": True, "cutoff_time": 0.0, "reason": cutoff_reason},
            }
        truncation_msg = (
            f"{cutoff_reason} tank runs dry at t={effective_burn_time:.4f} s of a {burn_time:.4f} s curve; "
            "thrust and both flows stop there."
        )
        print(f"[flight_sim] {truncation_msg}")
        thrust_curve = truncate_thrust_curve(thrust_curve, effective_burn_time)
        truncation_info = {
            "truncated": True,
            "cutoff_time": effective_burn_time,
            "reason": cutoff_reason,
            "message": truncation_msg,
        }
    else:
        effective_burn_time = burn_time
        truncation_info = {"truncated": False}

    from engine.pipeline.config_schemas import ensure_chamber_geometry
    cg = ensure_chamber_geometry(config)
    A_e = cg.A_exit

    # Check for required flight simulation config fields
    if not config.environment:
        raise ValueError("Flight simulation requires 'environment' configuration")
    if not config.rocket:
        raise ValueError("Flight simulation requires 'rocket' configuration")
    if not config.lox_tank:
        raise ValueError("Flight simulation requires 'lox_tank' configuration")
    if not config.fuel_tank:
        raise ValueError("Flight simulation requires 'fuel_tank' configuration")

    # Rocket parameters from config - support both NEW and LEGACY formats
    # NOTE: rocket_inertia is for AIRFRAME ONLY (without motor/propulsion)
    # RocketPy adds motor inertia separately via LiquidMotor(dry_inertia=...)
    rocket_inertia = config.rocket.inertia
    rocket_radius = config.rocket.radius
    
    # Check for NEW mass model (airframe_mass + propulsion_dry_mass)
    has_new_model = (
        hasattr(config.rocket, 'airframe_mass') and config.rocket.airframe_mass is not None and
        hasattr(config.rocket, 'propulsion_dry_mass') and config.rocket.propulsion_dry_mass is not None
    )
    
    if has_new_model:
        # NEW MODEL: Use detailed mass breakdown for proper RocketPy native handling
        airframe_mass = config.rocket.airframe_mass
        motor_position = getattr(config.rocket, 'motor_position', 0.5)
        
        # Check if we have detailed component breakdown (preferred)
        has_detailed_breakdown = (
            hasattr(config.rocket, 'engine_mass') and config.rocket.engine_mass is not None
        )
        
        if has_detailed_breakdown:
            # DETAILED MODEL: All propulsion dry mass goes to LiquidMotor
            # This includes engine + tank structures, with proper CM and inertia calculations
            engine_mass = config.rocket.engine_mass
            engine_cm_offset = getattr(config.rocket, 'engine_cm_offset', 0.15)
            lox_tank_structure_mass = getattr(config.rocket, 'lox_tank_structure_mass', None) or 0.0
            fuel_tank_structure_mass = getattr(config.rocket, 'fuel_tank_structure_mass', None) or 0.0
            copv_dry_mass = getattr(config.rocket, 'copv_dry_mass', None) or 0.0
            
            # Get tank positions (relative to nozzle exit)
            lox_tank_pos = config.lox_tank.ox_tank_pos
            fuel_tank_pos = config.fuel_tank.fuel_tank_pos
            copv_pos = config.press_tank.pres_tank_pos if config.press_tank else 0.0
            
            # TOTAL motor dry mass includes engine + all tank structures
            motor_dry_mass = engine_mass + lox_tank_structure_mass + fuel_tank_structure_mass + copv_dry_mass
            propulsion_dry_mass = motor_dry_mass
            
            # Compute weighted average CM of all dry components (relative to nozzle)
            # CM = sum(m_i * x_i) / sum(m_i)
            if motor_dry_mass > 0:
                weighted_cm = (
                    engine_mass * engine_cm_offset +
                    lox_tank_structure_mass * lox_tank_pos +
                    fuel_tank_structure_mass * fuel_tank_pos +
                    copv_dry_mass * copv_pos
                ) / motor_dry_mass
            else:
                weighted_cm = engine_cm_offset
            
            # Compute composite inertia using parallel axis theorem
            # I_total = sum(I_local_i + m_i * d_i^2) where d_i = distance from component CM to system CM
            # 
            # For each component, approximate as solid cylinder:
            #   I_axial = (1/2) * m * r^2
            #   I_transverse = (1/12) * m * (3*r^2 + h^2) ≈ (1/4) * m * r^2 for short cylinders
            #
            # Parallel axis theorem adds m * d^2 to transverse inertias
            
            def compute_component_inertia(mass, cm_pos, system_cm, radius, height=None):
                """Compute inertia contribution of a cylindrical component."""
                if mass <= 0:
                    return [0.0, 0.0, 0.0]
                
                # Distance from component CM to system CM (for parallel axis)
                d = cm_pos - system_cm
                
                # Local inertias (solid cylinder approximation)
                # Axial (Izz): I = (1/2) * m * r^2
                I_local_axial = 0.5 * mass * radius**2
                
                # Transverse (Ixx, Iyy): I = (1/12) * m * (3*r^2 + h^2)
                # If height not specified, use simplified: I ≈ (1/4) * m * r^2
                if height is not None and height > 0:
                    I_local_transverse = (1.0/12.0) * mass * (3 * radius**2 + height**2)
                else:
                    I_local_transverse = 0.25 * mass * radius**2
                
                # Apply parallel axis theorem to transverse inertias
                # I_total = I_local + m * d^2
                I_transverse_total = I_local_transverse + mass * d**2
                
                return [I_transverse_total, I_transverse_total, I_local_axial]
            
            # Engine inertia (compact cylinder)
            engine_r = rocket_radius * 0.6  # Engine smaller than rocket body
            engine_h = 0.3  # Approximate engine height
            I_engine = compute_component_inertia(engine_mass, engine_cm_offset, weighted_cm, engine_r, engine_h)
            
            # LOX tank structure inertia
            lox_tank_r = config.lox_tank.lox_radius
            lox_tank_h = config.lox_tank.lox_h
            I_lox_tank = compute_component_inertia(lox_tank_structure_mass, lox_tank_pos, weighted_cm, lox_tank_r, lox_tank_h)
            
            # Fuel tank structure inertia
            fuel_tank_r = config.fuel_tank.rp1_radius
            fuel_tank_h = config.fuel_tank.rp1_h
            I_fuel_tank = compute_component_inertia(fuel_tank_structure_mass, fuel_tank_pos, weighted_cm, fuel_tank_r, fuel_tank_h)
            
            # COPV structure inertia
            if copv_dry_mass > 0 and config.press_tank:
                copv_r = config.press_tank.press_radius
                copv_h = config.press_tank.press_h
                I_copv = compute_component_inertia(copv_dry_mass, copv_pos, weighted_cm, copv_r, copv_h)
            else:
                I_copv = [0.0, 0.0, 0.0]
            
            # Total motor inertia (sum of all components)
            motor_inertia = [
                I_engine[0] + I_lox_tank[0] + I_fuel_tank[0] + I_copv[0],  # Ixx (transverse)
                I_engine[1] + I_lox_tank[1] + I_fuel_tank[1] + I_copv[1],  # Iyy (transverse)
                I_engine[2] + I_lox_tank[2] + I_fuel_tank[2] + I_copv[2],  # Izz (axial)
            ]
            
            # Use the weighted CM as the motor's center of dry mass position
            engine_cm_offset = weighted_cm
            
            print(f"Using DETAILED mass model (RocketPy native):")
            print(f"  Engine + plumbing: {engine_mass:.2f} kg at {getattr(config.rocket, 'engine_cm_offset', 0.15):.2f}m above nozzle")
            print(f"  LOX tank structure: {lox_tank_structure_mass:.2f} kg at {lox_tank_pos:.2f}m (motor coords)")
            print(f"  Fuel tank structure: {fuel_tank_structure_mass:.2f} kg at {fuel_tank_pos:.2f}m (motor coords)")
            if copv_dry_mass > 0:
                print(f"  COPV structure: {copv_dry_mass:.2f} kg at {copv_pos:.2f}m (motor coords)")
            print(f"  Combined dry mass CM: {weighted_cm:.3f}m above nozzle")
            print(f"  Motor dry inertia: [{motor_inertia[0]:.4f}, {motor_inertia[1]:.4f}, {motor_inertia[2]:.4f}] kg·m²")
            print(f"  Total propulsion dry: {propulsion_dry_mass:.2f} kg")
        else:
            # SIMPLE MODEL: All propulsion lumped together (backward compatible)
            propulsion_dry_mass = config.rocket.propulsion_dry_mass
            propulsion_cm_offset = getattr(config.rocket, 'propulsion_cm_offset', 0.3)
            motor_dry_mass = propulsion_dry_mass
            engine_cm_offset = propulsion_cm_offset
            
            # Estimate motor inertia as solid cylinder (propulsion system)
            prop_r = rocket_radius * 0.8
            prop_h = 0.5  # Approximate propulsion system height
            # Solid cylinder: I_axial = (1/2)*m*r^2, I_transverse = (1/12)*m*(3*r^2 + h^2)
            I_transverse = (1.0/12.0) * motor_dry_mass * (3 * prop_r**2 + prop_h**2)
            I_axial = 0.5 * motor_dry_mass * prop_r**2
            motor_inertia = [I_transverse, I_transverse, I_axial]
            
            print(f"Using SIMPLE propulsion model:")
            print(f"  Propulsion dry mass: {propulsion_dry_mass:.2f} kg (lumped)")
            print(f"  Propulsion CM offset: {propulsion_cm_offset:.2f} m above nozzle")
            print(f"  Propulsion inertia (estimated): [{motor_inertia[0]:.4f}, {motor_inertia[1]:.4f}, {motor_inertia[2]:.4f}] kg·m²")
        
        rocket_mass = airframe_mass
        
        # Calculate CM of airframe (without motor/propulsion)
        cm_wo_motor = getattr(config.rocket, 'cm_wo_motor', None)
        if cm_wo_motor is None:
            # Estimate: airframe CM is above the motor, roughly 60% up the body
            cm_wo_motor = motor_position + 1.5
        
        total_dry_mass = airframe_mass + propulsion_dry_mass
        print(f"  Airframe mass: {airframe_mass:.2f} kg")
        print(f"  Airframe inertia: [{rocket_inertia[0]:.2f}, {rocket_inertia[1]:.2f}, {rocket_inertia[2]:.2f}] kg·m²")
        print(f"  Total dry mass: {total_dry_mass:.2f} kg")
    else:
        # LEGACY MODEL: mass + motor.dry_mass
        if config.rocket.mass is None:
            raise ValueError("Rocket configuration must include 'airframe_mass' + 'propulsion_dry_mass' (new) or 'mass' + 'motor' (legacy)")
        rocket_mass = config.rocket.mass
        
        if config.rocket.motor is None:
            raise ValueError("Legacy config requires 'motor' section with 'dry_mass'")
        motor_dry_mass = config.rocket.motor.dry_mass
        motor_inertia = config.rocket.motor_inertia if config.rocket.motor_inertia else [0.1, 0.1, 0.1]
        
        cm_wo_motor = config.rocket.cm_wo_motor if config.rocket.cm_wo_motor else 1.0
        motor_position = getattr(config.rocket, 'motor_position', 0.5)
        engine_cm_offset = 0.0  # Legacy: CM at nozzle
        
        print(f"Using LEGACY mass model:")
        print(f"  Rocket mass (airframe): {rocket_mass:.2f} kg")
        print(f"  Motor dry mass: {motor_dry_mass:.2f} kg")
        print(f"  Total dry mass: {rocket_mass + motor_dry_mass:.2f} kg")


    # Environment
    env = Environment(
        date=config.environment.date,
        latitude=config.environment.latitude,
        longitude=config.environment.longitude,
        elevation=config.environment.elevation,
    )
    # Atmosphere model is a toggle: deterministic ISA (default, offline) vs live GFS forecast.
    atmos = getattr(config.environment, 'atmosphere_model', 'standard_atmosphere') or 'standard_atmosphere'
    if str(atmos).lower() == 'forecast':
        try:
            env.set_atmospheric_model(type='Forecast', file='GFS')
        except Exception as e:
            # Forecast needs internet + a near date; fall back to ISA rather than failing the flight.
            print(f"[flight_sim] GFS forecast unavailable ({e}); falling back to standard atmosphere.")
            env.set_atmospheric_model(type='standard_atmosphere')
    else:
        env.set_atmospheric_model(type='standard_atmosphere')
    # GFS may override elevation with its terrain model - restore configured elevation
    env.set_elevation(config.environment.elevation)

    report_warnings = []

    # One stack for the tanks, the nose and the drag: engine/pipeline/vehicle_drag.built_stack.
    # The tank cylinders take their height from the same volume the mass caps use, so RocketPy's
    # tank, the cap and the ullage below cannot disagree about how big the tank is.
    from engine.pipeline.vehicle_drag import built_stack, resolve_drag_curves

    stack = built_stack(config)
    lox_geom = CylindricalTank(radius=config.lox_tank.lox_radius, height=stack["lox_h"], spherical_caps=False)
    rp1_geom = CylindricalTank(radius=config.fuel_tank.rp1_radius, height=stack["fuel_h"], spherical_caps=False)
    for name, section, h_attr in (("LOX", config.lox_tank, "lox_h"), ("fuel", config.fuel_tank, "rp1_h")):
        h_cfg = float(getattr(section, h_attr))
        h_used = stack["lox_h" if name == "LOX" else "fuel_h"]
        if abs(h_used - h_cfg) > 1e-6 * h_cfg:
            report_warnings.append(
                f"{name} tank: tank_volume_m3 and pi r^2 {h_attr} disagree; flown at the volume "
                f"(height {h_used:.4f} m, config {h_attr} {h_cfg:.4f} m)"
            )

    # Fluids and tanks — names/densities come from the loaded config so this follows the propellant
    # switch (LOX/CH4, LOX/Ethanol, LOX/RP-1, …); nothing here is hardcoded to a specific propellant.
    ox_name = getattr(config.fluids['oxidizer'], 'name', None) or "Oxidizer"
    fuel_name = getattr(config.fluids['fuel'], 'name', None) or "Fuel"
    lox = Fluid(name=ox_name, density=rho_lox)
    rp1 = Fluid(name=fuel_name, density=rho_rp1)

    # THE T-0 ULLAGE IS THE TANK'S OWN, AT TANK PRESSURE.
    #
    # This was Fluid("GN2", density=50) with initial_gas_mass=0.05 in both tanks: 1.000 L of gas
    # whatever the tank. The 6.5 kN tanks, loaded to 90 %, have 0.644 L (LOX) and 0.620 L (fuel)
    # of ullage, so RocketPy refused both tanks and the shipped vehicle could not be flown at all;
    # copv_flight_helpers then blamed the propellant load. The gas that is really there fills
    # V_tank - m/rho_liquid at the tank's pressure: 47.8 kg/m3 of N2 at 584.27 psia / 293.15 K,
    # 30.8 g and 29.6 g. The 0.999 keeps the fluid just inside RocketPy's inverse_volume domain,
    # which fails on float equality at a completely full tank.
    ullage = {}
    for name, section, m_liq, rho_liq, V in (
        ("LOX", config.lox_tank, m_lox0, rho_lox, lox_geom.total_volume),
        ("fuel", config.fuel_tank, m_rp10, rho_rp1, rp1_geom.total_volume),
    ):
        V_liq = m_liq / rho_liq
        V_ull = V - V_liq
        if V_ull <= 0.0:
            raise ValueError(
                f"{name} tank: {V_liq * 1e3:.4f} L of liquid in a {V * 1e3:.4f} L tank leaves no ullage"
            )
        rho_g, P_abs, T_g = ullage_gas_density(section)
        ullage[name] = {
            "tank_volume_L": V * 1e3,
            "liquid_volume_L": V_liq * 1e3,
            "ullage_volume_L": V_ull * 1e3,
            "gas": str(section.ullage_gas),
            "pressure_pa": P_abs,
            "temperature_K": T_g,
            "gas_density_kg_m3": rho_g,
            "initial_gas_kg": 0.999 * V_ull * rho_g,
            "fluid": Fluid(name=f"{section.ullage_gas} ullage", density=rho_g),
        }
    m_ullage_gas = ullage["LOX"]["initial_gas_kg"] + ullage["fuel"]["initial_gas_kg"]

    # Pressurant (COPV) tank setup
    m_pressurant = 0.0
    if config.press_tank:
        m_pressurant = getattr(config.press_tank, 'initial_gas_mass', None) or 0.0
        if m_pressurant > 0:
            # COPV VOLUME AND DENSITY COME FROM THE CONFIG, NOT FROM A CONSTANT.
            #
            # This used to build the tank from press_radius x press_h and fill it with
            # Fluid(density=200), a number with no source on it. Real GN2 at 4500 psi / 293 K
            # is 310 kg/m3 (CoolProp, Z = 1.150), so 200 under-states a charged COPV by 35 %
            # and caps a 5 L bottle at 1.0 kg. A 5 L COPV actually holds 1.551 kg, and
            # RocketPy then refused the tank outright as "overfilled".
            #
            # free_volume_L is the authoritative number: it is what the operator specifies and
            # what a propellant-volume budget counts. Build the geometry to it and take the
            # density as mass/volume, which is self-consistent by construction and assumes
            # nothing about fill pressure or gas species.
            free_L = getattr(config.press_tank, 'free_volume_L', None)
            if free_L and free_L > 0:
                V_copv = float(free_L)/1000.0
                press_h_eff = V_copv/(np.pi*config.press_tank.press_radius**2)
            else:
                press_h_eff = config.press_tank.press_h
                V_copv = np.pi*config.press_tank.press_radius**2*press_h_eff
            # 0.1 % of solver ullage. RocketPy composes gas_height through
            # geometry.inverse_volume, whose domain is exactly [0, V_copv], so a tank filled
            # to precisely its own volume fails on float equality. Mass is conserved exactly;
            # only the density carries the 0.1 %.
            gn2_pressurant = Fluid(name="GN2_COPV", density=m_pressurant/(V_copv*0.999))
            press_geom = CylindricalTank(
                radius=config.press_tank.press_radius,
                height=press_h_eff,
                spherical_caps=False
            )

            # PRESSURANT DOES NOT LEAVE THE VEHICLE.
            #
            # This used to drain the whole COPV over the burn
            # (mdot = m_pressurant / burn_time), which RocketPy subtracts from vehicle mass --
            # i.e. the gas was being flown as propellant. It is not: it moves from the COPV
            # into the ullage the departing propellant leaves behind, and every gram of it is
            # still on board at burnout.
            #
            # What it cost: on the 180 lb / 11 L point, 1.551 kg of N2 out of 81.647 kg wet.
            # Burnout mass 69.36 kg instead of 70.90, so ln(m0/mf) went 0.1412 -> 0.1631 and
            # ideal dv was over-stated by 51 m/s, about 13 %. It also drove the tank to
            # exactly -0.000 kg at burnout, which RocketPy raises on, so the sim would
            # intermittently fail outright rather than just answer wrongly.
            #
            # Nothing goes overboard. What the regulator moves into the ullages (below) leaves
            # the COPV and arrives in the tanks, so the mass is conserved and the CG follows it.
            mdot_pressurant_avg = 0.0

            print(f"  Pressurant (N₂): {m_pressurant:.3f} kg in {V_copv*1000:.2f} L "
                  f"({m_pressurant/V_copv:.0f} kg/m3), carried as dead mass (not expelled)")

    # REFILL. With a COPV on board the regulator holds tank pressure, so the ullage gas grows by
    # rho_gas/rho_liquid per kg of liquid drained and the COPV loses the same. Without one it is a
    # blowdown: the T-0 gas expands and its mass is fixed.
    refilled = m_pressurant > 0
    t_flux = np.concatenate([t_grid[t_grid < effective_burn_time], [effective_burn_time]])

    def _tank_masses(name, m0, cum):
        cum_f = np.interp(t_flux, t_grid, cum)
        liquid = np.clip(m0 - cum_f, 1.0e-9, None)
        gas = ullage[name]["initial_gas_kg"] + (
            ullage[name]["gas_density_kg_m3"] / (rho_lox if name == "LOX" else rho_rp1) * (m0 - liquid) if refilled else 0.0
        )
        return Function(np.column_stack((t_flux, liquid))), Function(np.column_stack((t_flux, np.broadcast_to(gas, t_flux.shape)))), liquid

    lox_liquid, lox_gas, lox_liq_arr = _tank_masses("LOX", m_lox0, cum_O)
    fuel_liquid, fuel_gas, fuel_liq_arr = _tank_masses("fuel", m_rp10, cum_F)
    oxidizer_tank = MassBasedTank(
        name="LOX Tank",
        geometry=lox_geom,
        flux_time=effective_burn_time,
        liquid=lox,
        gas=ullage["LOX"]["fluid"],
        liquid_mass=lox_liquid,
        gas_mass=lox_gas,
        discretize=100,
    )
    fuel_tank = MassBasedTank(
        name="Fuel Tank",
        geometry=rp1_geom,
        flux_time=effective_burn_time,
        liquid=rp1,
        gas=ullage["fuel"]["fluid"],
        liquid_mass=fuel_liquid,
        gas_mass=fuel_gas,
        discretize=100,
    )
    refill_kg = 0.0
    if refilled:
        refill_kg = sum(
            ullage[n]["gas_density_kg_m3"] / rho * (m0 - liq[-1])
            for n, rho, m0, liq in (("LOX", rho_lox, m_lox0, lox_liq_arr), ("fuel", rho_rp1, m_rp10, fuel_liq_arr))
        )
        if refill_kg > m_pressurant - 1.0e-4:
            raise ValueError(
                f"COPV holds {m_pressurant:.3f} kg; holding tank pressure over this burn needs "
                f"{refill_kg:.3f} kg into the ullages. The regulated curve cannot be flown with this COPV."
            )
        lockup_kg = max(u["gas_density_kg_m3"] for u in ullage.values()) * V_copv
        if refill_kg > m_pressurant - lockup_kg:
            report_warnings.append(
                f"COPV refill {refill_kg:.3f} kg exceeds the {m_pressurant - lockup_kg:.3f} kg above tank "
                "pressure (isothermal): the regulator would lose lockup before burnout"
            )

    # Create pressurant tank if configured
    pressurant_tank = None
    if config.press_tank and m_pressurant > 0:
        # What leaves the COPV is what arrives in the ullages, plus nothing overboard.
        refill_rate = mdot_pressurant_avg + (
            ullage["LOX"]["gas_density_kg_m3"] / rho_lox * np.interp(t_flux, t_grid, mdot_O_grid)
            + ullage["fuel"]["gas_density_kg_m3"] / rho_rp1 * np.interp(t_flux, t_grid, mdot_F_grid)
        )
        mdot_pressurant = Function(np.column_stack((t_flux, refill_rate)))

        pressurant_tank = MassFlowRateBasedTank(
            name="Pressurant (N₂) Tank",
            geometry=press_geom,
            flux_time=effective_burn_time,
            liquid=gn2_pressurant,  # Using "liquid" field for gas (RocketPy limitation)
            gas=gn2_pressurant,
            # The stub comes OUT OF the pressurant mass, not on top of it. It used to be a
            # flat 0.01 kg added alongside initial_liquid_mass, so the tank held
            # m_pressurant + 0.01 kg: with the density derived from m_pressurant/V that is
            # 0.0050322 m3 in a 0.0050000 m3 bottle, and RocketPy rejected it outright.
            initial_liquid_mass=max(0.0, m_pressurant - 1.0e-4),
            initial_gas_mass=1.0e-4,
            liquid_mass_flow_rate_in=0.0,
            liquid_mass_flow_rate_out=mdot_pressurant,  # into the ullages, still on board
            gas_mass_flow_rate_in=0.0,
            gas_mass_flow_rate_out=0.0,
            discretize=100,
        )

    # PRESSURE THRUST. The curve was computed at one ambient pressure; in flight the same engine
    # gives F + (p_ref - p(z)) * A_exit (Sutton & Biblarz eq. 3-21). Without reference_pressure
    # RocketPy's pressure_thrust is zero and the curve flew unchanged to apogee: ~55 N short at
    # 1.2 km MSL on the 6.5 kN engine.
    p_ref = getattr(config.thrust, "reference_pressure_pa", None)
    if p_ref is None:
        from engine.core.runner import compute_ambient_pressure_from_elevation

        p_ref = float(compute_ambient_pressure_from_elevation(float(config.environment.elevation)))

    # Liquid motor - use effective_burn_time for burn_time
    # engine_cm_offset: how far above nozzle the engine dry mass CM is
    # (tank structures are added separately if using detailed model)
    liquid_motor = LiquidMotor(
        thrust_source=thrust_curve,
        center_of_dry_mass_position=engine_cm_offset,  # CM of engine (not tanks) above nozzle
        dry_inertia=motor_inertia,
        dry_mass=motor_dry_mass,
        burn_time=(0.0, effective_burn_time),
        nozzle_radius=math.sqrt(A_e / math.pi),
        nozzle_position=0.0,  # Nozzle at origin of motor coordinate system
        coordinate_system_orientation="nozzle_to_combustion_chamber",
        reference_pressure=float(p_ref),
    )

    # Rocket assembly - stack from bottom (tail) to top (nose)
    # In "tail_to_nose" system: lower position = tail, higher position = nose
    # motor_position: where the nozzle exit is, measured from rocket tail

    # Add tanks relative to motor (nozzle) position
    # Each tank tracks its own mass, CM, and inertia as propellant/gas depletes
    liquid_motor.add_tank(fuel_tank, position=config.fuel_tank.fuel_tank_pos)
    liquid_motor.add_tank(oxidizer_tank, position=config.lox_tank.ox_tank_pos)

    # Add pressurant tank if configured
    if pressurant_tank is not None:
        liquid_motor.add_tank(pressurant_tank, position=config.press_tank.pres_tank_pos)
        print(f"  Added pressurant tank at position {config.press_tank.pres_tank_pos:.2f}m")

    # DRAG. Cd(M) from the user's tables, or the Barrowman / OpenRocket component build-up of the
    # vehicle assembled here (engine/pipeline/vehicle_drag.py). This was Cd 0.45 at every Mach,
    # motor on and off, whatever the length, fins or finish: the build-up for this 7.76 m, 49:1
    # vehicle is 0.64-0.91 depending on the finish, and friction alone is above 0.45.
    drag_curves = resolve_drag_curves(config, A_e, stack)
    rocket = Rocket(
        radius=rocket_radius,
        mass=rocket_mass,
        inertia=rocket_inertia,
        center_of_mass_without_motor=cm_wo_motor,
        coordinate_system_orientation="tail_to_nose",
        power_off_drag=drag_curves.rocketpy(power_on=False),
        power_on_drag=drag_curves.rocketpy(power_on=True),
    )
    rocket_length_cfg = getattr(config.rocket, "rocket_length", None)
    if rocket_length_cfg is not None and abs(float(rocket_length_cfg) - stack["length"]) > 1e-3:
        report_warnings.append(
            f"rocket.rocket_length {float(rocket_length_cfg):.3f} m, but the stack flown is {stack['length']:.3f} m "
            "tail to nose tip (tank positions + avionics_payload_length_m); drag and inertia use the stack"
        )

    # Fins at bottom (tail) - position 0.0
    rocket.add_trapezoidal_fins(
        n=config.rocket.fins.no_fins,
        root_chord=config.rocket.fins.root_chord,
        tip_chord=config.rocket.fins.tip_chord,
        span=config.rocket.fins.fin_span,
        position=config.rocket.fins.fin_position,  # User-specified position from rocket tail
    )

    # Motor above fins
    rocket.add_motor(liquid_motor, position=motor_position)

    # NOTE: Tank structure masses are now included in LiquidMotor.dry_mass
    # with proper CM and inertia calculations using parallel axis theorem.
    # This is the correct RocketPy approach - no need for separate point masses.

    # Nose tip avionics_payload_length_m above the highest tank top (built_stack). Length from the
    # fineness ratio (nose length / body DIAMETER) unless nose_length is set.
    body_diameter = 2.0 * rocket_radius
    nose_kind = getattr(config.rocket, 'nose_kind', None) or "vonKarman"
    nose_length = stack["nose_length"]
    print(f"  Nosecone: {nose_kind}, length {nose_length:.3f} m "
          f"(fineness {nose_length / body_diameter:.2f}:1 on Ø{body_diameter:.3f} m)")
    rocket.add_nose(length=nose_length, kind=nose_kind, position=stack["nose_tip"])

    upper = getattr(config.rocket, "rail_button_upper_pos_m", None)
    lower = getattr(config.rocket, "rail_button_lower_pos_m", None)
    if upper is not None and lower is not None:
        rocket.set_rail_buttons(upper_button_position=float(upper), lower_button_position=float(lower))

    # Compute initial thrust-to-weight ratio for validation
    # Sample thrust at t=0 from thrust curve
    if isinstance(thrust_curve, list):
        initial_thrust = thrust_curve[0][1] if thrust_curve else 0.0
    elif hasattr(thrust_curve, '__call__'):
        initial_thrust = float(thrust_curve(0.0))
    else:
        initial_thrust = float(thrust_curve)

    # Total initial mass = airframe + motor dry (includes engine + tank structures) + propellants + pressurant gas
    # + the T-0 ullage gas, which ground pre-pressurisation puts there on top of the COPV charge
    total_initial_mass = rocket_mass + motor_dry_mass + m_lox0 + m_rp10 + m_pressurant + m_ullage_gas
    initial_twr = initial_thrust / (total_initial_mass * g0)

    print(f"\nMass Summary:")
    print(f"  Airframe: {rocket_mass:.2f} kg")
    print(f"  Motor dry (engine + tank structures): {motor_dry_mass:.2f} kg")
    print(f"  LOX propellant: {m_lox0:.2f} kg")
    print(f"  Fuel propellant: {m_rp10:.2f} kg")
    if m_pressurant > 0:
        print(f"  Pressurant gas: {m_pressurant:.3f} kg")
    print(f"  Ullage gas at T-0: {m_ullage_gas:.3f} kg")
    print(f"  TOTAL: {total_initial_mass:.2f} kg")
    print(f"\nInitial thrust: {initial_thrust:.1f} N")
    print(f"Initial T/W ratio: {initial_twr:.3f}")

    if initial_twr < 1.0:
        raise ValueError(
            f"Thrust-to-weight ratio ({initial_twr:.3f}) is less than 1.0! "
            f"The rocket cannot take off. Either increase thrust or reduce mass. "
            f"Current: thrust={initial_thrust:.1f} N, mass={total_initial_mass:.2f} kg, "
            f"requires thrust > {total_initial_mass * g0:.1f} N"
        )

    # Flight simulation with timeout to prevent infinite loops
    # max_time limits simulation to prevent hangs if something goes wrong
    max_flight_time = max(300.0, effective_burn_time * 30)  # At least 5 min, or 30x burn time

    # Suppress RocketPy's internal Function domain warnings during flight simulation
    # These are numerical precision issues in tank level calculations, not real failures
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=".*must be within the domain of the Function.*",
            category=UserWarning,
        )
        flight = Flight(
            rocket=rocket,
            environment=env,
            rail_length=float(config.environment.rail_length_m),
            inclination=float(config.environment.launch_inclination_deg),
            heading=float(config.environment.launch_heading_deg),
            max_time_step=0.02,
            max_time=max_flight_time,
            terminate_on_apogee=True,
        )

    # RocketPy reports apogee as ASL (Above Sea Level) - convert to AGL for display
    elevation = float(config.environment.elevation)
    apogee_asl = float(flight.apogee)
    apogee_agl = apogee_asl - elevation

    try:
        # flight.vz.get_source() returns (N, 2): column 0 = time, column 1 = velocity
        vz_source = flight.vz.get_source()
        max_v = float(np.max(vz_source[:, 1]))  # Extract only the velocity column
    except Exception:
        max_v = None

    if truncation_info.get("truncated"):
        truncation_info["cutoff_time"] = float(liquid_motor.burn_out_time)

    report = flight_report(
        flight,
        config,
        drag_curves,
        extra={
            "reference_pressure_pa": float(p_ref),
            "nozzle_exit_area_m2": float(A_e),
            "wet_mass_kg": float(total_initial_mass),
            "stack_length_m": float(stack["length"]),
            "ullage": {k: {kk: vv for kk, vv in v.items() if kk != "fluid"} for k, v in ullage.items()},
            "copv_refill_kg": float(refill_kg),
            "warnings": report_warnings,
        },
    )

    # Carried on the Flight too: copv_flight_helpers.run_flight_simulation keeps only the Flight.
    flight.flight_report = report

    print(f"Apogee AGL [m]: {apogee_agl:.2f} (ASL: {apogee_asl:.2f}, elevation: {elevation:.2f})")
    if max_v is not None:
        print(f"Max velocity [m/s]: {max_v:.2f}")

    return {
        "apogee": apogee_agl,  # Return AGL for display
        "apogee_asl": apogee_asl,  # Also provide ASL if needed
        "elevation": elevation,
        "max_velocity": max_v,
        "thrust_curve": thrust_curve,
        "flight": flight,
        "params": config,
        "truncation_info": truncation_info,
        "mass_caps": mass_caps,
        "flight_report": report,
    }
