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

def setup_flight(config, thrust_curve, mdot_lox, mdot_fuel, plot_results=False):
    """
    Build and simulate a RocketPy flight with configuration from config_minimal.yaml.

    Args:
        config: Configuration object with attributes matching config_minimal.yaml structure.
        plot_results (bool): whether to show diagnostic plots.

    Returns:
        dict: {
            "apogee": float,
            "max_velocity": float,
            "thrust_curve": list of (t, F),
            "flight": RocketPy Flight object,
            "params": configuration data
        }
    """



    # Extract parameters from config directly
    burn_time = config.thrust.burn_time

    # Densities from config
    rho_lox = config.fluids['oxidizer'].density
    rho_rp1 = config.fluids['fuel'].density

    # Initial masses from config
    m_lox0 = config.lox_tank.mass
    m_rp10 = config.fuel_tank.mass
    
    # Tank geometry
    lox_radius = config.lox_tank.lox_radius
    lox_height = config.lox_tank.lox_h
    rp1_radius = config.fuel_tank.rp1_radius
    rp1_height = config.fuel_tank.rp1_h
    
    # Validate and cap propellant masses to prevent RocketPy tank overfill errors
    # Tank volume = π * r² * h, max mass = volume * density * fill_factor
    # RocketPy's internal tank calculations (liquid height, center of mass) can fail
    # when liquid level gets too close to tank geometry bounds due to numerical precision
    import math
    FILL_FACTOR = 0.75  # Conservative (75%) to avoid RocketPy numerical precision issues
    
    lox_tank_volume = math.pi * lox_radius**2 * lox_height
    lox_max_mass = lox_tank_volume * rho_lox * FILL_FACTOR
    if m_lox0 > lox_max_mass:
        print(f"[flight_sim] Capping LOX mass: {m_lox0:.2f} -> {lox_max_mass:.2f} kg (tank vol: {lox_tank_volume*1000:.1f}L, 75% fill)")
        m_lox0 = lox_max_mass
    
    rp1_tank_volume = math.pi * rp1_radius**2 * rp1_height
    rp1_max_mass = rp1_tank_volume * rho_rp1 * FILL_FACTOR
    if m_rp10 > rp1_max_mass:
        print(f"[flight_sim] Capping Fuel mass: {m_rp10:.2f} -> {rp1_max_mass:.2f} kg (tank vol: {rp1_tank_volume*1000:.1f}L, 75% fill)")
        m_rp10 = rp1_max_mass
    
    # Check for both LOX and fuel underfill and truncate at whichever happens first
    lox_cutoff_time = detect_lox_underfill_time(mdot_lox, m_lox0, burn_time)
    fuel_cutoff_time = detect_fuel_underfill_time(mdot_fuel, m_rp10, burn_time)
    
    # Find the earliest cutoff time (or None if neither depletes)
    cutoff_time = None
    cutoff_reason = None
    if lox_cutoff_time is not None and fuel_cutoff_time is not None:
        if lox_cutoff_time <= fuel_cutoff_time:
            cutoff_time = lox_cutoff_time
            cutoff_reason = "LOX"
        else:
            cutoff_time = fuel_cutoff_time
            cutoff_reason = "fuel"
    elif lox_cutoff_time is not None:
        cutoff_time = lox_cutoff_time
        cutoff_reason = "LOX"
    elif fuel_cutoff_time is not None:
        cutoff_time = fuel_cutoff_time
        cutoff_reason = "fuel"
    
    truncation_info = None
    if cutoff_time is not None and cutoff_time < burn_time:
        truncation_msg = f"{cutoff_reason.capitalize()} tank underfill detected at t={cutoff_time:.3f} s. Truncating thrust and mass flows."
        print(truncation_msg)  # Also print for console/logging
        truncation_info = {
            "truncated": True,
            "cutoff_time": cutoff_time,
            "reason": cutoff_reason,
            "message": truncation_msg
        }
        # Nudge cutoff earlier to avoid zero/negative mass at the edge.
        # Use a stronger margin to stay safely away from the depletion point.
        margin = max(0.5, 0.05 * burn_time)
        cutoff_time = max(0.0, cutoff_time - margin)
        # If margin wipes out the burn, abort gracefully
        if cutoff_time <= 0:
            return {
                "success": False,
                "error": "Burn truncated to <= 0s due to tank underfill.",
                "flight": None,
                "flight_time": 0.0,
                "apogee": 0.0,
                "max_velocity": 0.0,
                "truncation_info": {"truncated": True, "cutoff_time": 0.0, "reason": cutoff_reason, "message": truncation_msg},
            }
        # Truncate thrust curve
        thrust_curve = truncate_thrust_curve(thrust_curve, cutoff_time)
        # Truncate mdot functions
        mdot_lox = truncate_mdot_function(mdot_lox, cutoff_time, cutoff_time)
        mdot_fuel = truncate_mdot_function(mdot_fuel, cutoff_time, cutoff_time)
        # Update burn_time to cutoff_time (but keep original for tank discretization)
        effective_burn_time = cutoff_time
    else:
        effective_burn_time = burn_time
        truncation_info = {"truncated": False}

    # Additional safety: if integrated mdot would exceed available mass, shorten burn further
    def _consumed_mass(mdot_func, t_end, n_samples=1500):
        times = np.linspace(0, t_end, n_samples)
        vals = np.array([float(mdot_func(t)) for t in times])
        return float(np.trapezoid(vals, times) if hasattr(np, "trapezoid") else np.trapz(vals, times))

    # Only if we have Function/callable mdot after truncation
    try:
        fuel_consumed = _consumed_mass(mdot_fuel, effective_burn_time)
        if fuel_consumed >= m_rp10 - 1e-6 and fuel_consumed > 0:
            # shrink burn until consumption fits with small margin
            for _ in range(5):
                scale = (m_rp10 * 0.98) / max(fuel_consumed, 1e-9)
                if scale >= 1.0:
                    break
                effective_burn_time = max(0.05, effective_burn_time * scale)
                # Re-truncate curves to new effective time
                thrust_curve = truncate_thrust_curve(thrust_curve, effective_burn_time)
                mdot_lox = truncate_mdot_function(mdot_lox, effective_burn_time, effective_burn_time)
                mdot_fuel = truncate_mdot_function(mdot_fuel, effective_burn_time, effective_burn_time)
                fuel_consumed = _consumed_mass(mdot_fuel, effective_burn_time)
            truncation_info["truncated"] = True
            truncation_info["cutoff_time"] = effective_burn_time
    except Exception:
        pass

    # Nozzle exit area (only used for visualization, not trajectory)
    # Note: When providing a thrust curve, RocketPy doesn't use nozzle params for simulation.
    # A_exit is only used to calculate nozzle_radius for the rocket drawing.
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
    env.set_atmospheric_model(type='Forecast', file='GFS')
    # GFS may override elevation with its terrain model - restore configured elevation
    env.set_elevation(config.environment.elevation)

    print(m_lox0)
    print(m_rp10)
    print(mdot_lox)
    print(mdot_fuel)

    # Tank geometries from config
    lox_geom = CylindricalTank(radius=config.lox_tank.lox_radius, height=config.lox_tank.lox_h, spherical_caps=False)
    rp1_geom = CylindricalTank(radius=config.fuel_tank.rp1_radius, height=config.fuel_tank.rp1_h, spherical_caps=False)

    # Fluids and tanks
    lox = Fluid(name="LOX", density=rho_lox)
    rp1 = Fluid(name="RP-1", density=rho_rp1)
    # GN2 (gaseous nitrogen) for ullage and pressurant - density varies with pressure
    # Use average density during blowdown (higher at start, lower at end)
    gn2_ullage = Fluid(name="GN2", density=50)  # kg/m³ approximate for ullage
    gn2_pressurant = Fluid(name="GN2_COPV", density=200)  # kg/m³ higher density in COPV
    
    # Pressurant (COPV) tank setup
    m_pressurant = 0.0
    press_tank_obj = None
    if config.press_tank:
        m_pressurant = getattr(config.press_tank, 'initial_gas_mass', None) or 0.0
        if m_pressurant > 0:
            # Create pressurant tank geometry
            press_geom = CylindricalTank(
                radius=config.press_tank.press_radius, 
                height=config.press_tank.press_h, 
                spherical_caps=False
            )
            
            # Estimate pressurant mass flow rate
            # Pressurant flows out to replace consumed propellant volume
            # Simplified: assume linear depletion over burn time
            # More accurate would be based on actual ullage volume increase rate
            if effective_burn_time > 0:
                mdot_pressurant_avg = m_pressurant / effective_burn_time
            else:
                mdot_pressurant_avg = 0.0
            
            print(f"  Pressurant (N₂): {m_pressurant:.3f} kg initial, ~{mdot_pressurant_avg:.4f} kg/s avg flow")

    # Convert mdot_lox and mdot_fuel to RocketPy Functions if they're not already
    # (MassFlowRateBasedTank expects Functions)
    # Handle: RocketPy Function, callable (interp1d), or constant float
    # Use high resolution (500 points/sec) with explicit cutoff points
    # IMPORTANT: Extend domain slightly beyond effective_burn_time to avoid RocketPy warnings
    # about evaluating functions outside their domain during numerical integration
    domain_buffer = max(0.01, effective_burn_time * 0.02)  # 2% buffer or 10ms minimum
    extended_time = effective_burn_time + domain_buffer
    
    if not isinstance(mdot_lox, Function):
        n_samples = max(int(burn_time * 500) + 1, 1000)
        times_base = np.linspace(0, extended_time, n_samples)
        # Add explicit cutoff points for sharp transition
        eps = 1e-6
        critical_times = [effective_burn_time, effective_burn_time + eps, extended_time]
        times_mdot = np.unique(np.concatenate([times_base, critical_times]))
        times_mdot = times_mdot[times_mdot <= extended_time]
        
        # Check if mdot_lox is callable (e.g., interp1d) or a constant
        if callable(mdot_lox):
            # It's callable (interp1d or similar) - evaluate at each time point
            # Return 0 for times beyond effective_burn_time (extended domain is just for RocketPy compatibility)
            mdot_lox_vals = np.array([float(mdot_lox(t)) if t <= effective_burn_time else 0.0 for t in times_mdot])
        else:
            # It's a constant value
            mdot_lox_vals = np.array([float(mdot_lox) if t <= effective_burn_time else 0.0 for t in times_mdot])
        
        # RocketPy Function expects 2D array: [[x1, y1], [x2, y2], ...]
        source = np.column_stack((times_mdot, mdot_lox_vals))
        mdot_lox = Function(source)
    
    if not isinstance(mdot_fuel, Function):
        n_samples = max(int(burn_time * 500) + 1, 1000)
        times_base = np.linspace(0, extended_time, n_samples)
        # Add explicit cutoff points for sharp transition
        eps = 1e-6
        critical_times = [effective_burn_time, effective_burn_time + eps, extended_time]
        times_mdot = np.unique(np.concatenate([times_base, critical_times]))
        times_mdot = times_mdot[times_mdot <= extended_time]
        
        # Check if mdot_fuel is callable (e.g., interp1d) or a constant
        if callable(mdot_fuel):
            # It's callable (interp1d or similar) - evaluate at each time point
            # Return 0 for times beyond effective_burn_time (extended domain is just for RocketPy compatibility)
            mdot_fuel_vals = np.array([float(mdot_fuel(t)) if t <= effective_burn_time else 0.0 for t in times_mdot])
        else:
            # It's a constant value
            mdot_fuel_vals = np.array([float(mdot_fuel) if t <= effective_burn_time else 0.0 for t in times_mdot])
        
        # RocketPy Function expects 2D array: [[x1, y1], [x2, y2], ...]
        source = np.column_stack((times_mdot, mdot_fuel_vals))
        mdot_fuel = Function(source)

    oxidizer_tank = MassFlowRateBasedTank(
        name="LOX Tank",
        geometry=lox_geom,
        flux_time=effective_burn_time,
        liquid=lox,
        gas=gn2_ullage,
        initial_liquid_mass=m_lox0,
        initial_gas_mass=0.05,  # Small ullage
        liquid_mass_flow_rate_in=0.0,
        liquid_mass_flow_rate_out=mdot_lox,
        gas_mass_flow_rate_in=0.0,
        gas_mass_flow_rate_out=0.0,
        discretize=100,
    )

    fuel_tank = MassFlowRateBasedTank(
        name="RP-1 Tank",
        geometry=rp1_geom,
        flux_time=effective_burn_time,
        liquid=rp1,
        gas=gn2_ullage,
        initial_liquid_mass=m_rp10,
        initial_gas_mass=0.05,  # Small ullage
        liquid_mass_flow_rate_in=0.0,
        liquid_mass_flow_rate_out=mdot_fuel,
        gas_mass_flow_rate_in=0.0,
        gas_mass_flow_rate_out=0.0,
        discretize=100,
    )

    # Create pressurant tank if configured
    pressurant_tank = None
    if config.press_tank and m_pressurant > 0:
        # Create pressurant mass flow function (linear depletion approximation)
        # Use extended_time domain to avoid RocketPy warnings
        n_samples = max(int(burn_time * 500) + 1, 1000)
        times_base = np.linspace(0, extended_time, n_samples)
        eps = 1e-6
        critical_times = [effective_burn_time, effective_burn_time + eps, extended_time]
        times_mdot = np.unique(np.concatenate([times_base, critical_times]))
        times_mdot = times_mdot[times_mdot <= extended_time]
        
        # Pressurant flow rate proportional to propellant consumption
        # This is a simplification - actual flow depends on blowdown ratio
        # Return 0 for times beyond effective_burn_time
        mdot_press_vals = np.array([mdot_pressurant_avg if t <= effective_burn_time else 0.0 for t in times_mdot])
        source = np.column_stack((times_mdot, mdot_press_vals))
        mdot_pressurant = Function(source)
        
        pressurant_tank = MassFlowRateBasedTank(
            name="Pressurant (N₂) Tank",
            geometry=press_geom,
            flux_time=effective_burn_time,
            liquid=gn2_pressurant,  # Using "liquid" field for gas (RocketPy limitation)
            gas=gn2_pressurant,
            initial_liquid_mass=m_pressurant,  # All mass starts as "liquid" (actually high-pressure gas)
            initial_gas_mass=0.01,  # Small amount
            liquid_mass_flow_rate_in=0.0,
            liquid_mass_flow_rate_out=mdot_pressurant,  # Gas flows out to propellant tanks
            gas_mass_flow_rate_in=0.0,
            gas_mass_flow_rate_out=0.0,
            discretize=100,
        )

    # thrust_curve is already set above (may have been truncated)

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

    rocket = Rocket(
        radius=rocket_radius,
        mass=rocket_mass,
        inertia=rocket_inertia,
        center_of_mass_without_motor=cm_wo_motor,
        coordinate_system_orientation="tail_to_nose",
        power_off_drag=0.45,
        power_on_drag=0.45,
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
    
    # Calculate top of highest tank to place nose above it
    # Motor center is at motor_position
    # LOX tank extends from motor_position + ox_tank_pos - lox_h/2 to motor_position + ox_tank_pos + lox_h/2
    lox_top = motor_position + config.lox_tank.ox_tank_pos + config.lox_tank.lox_h/2
    fuel_top = motor_position + config.fuel_tank.fuel_tank_pos + config.fuel_tank.rp1_h/2 if config.fuel_tank.fuel_tank_pos > 0 else 0
    
    # If pressurant tank is configured, include it
    press_top = 0
    if config.press_tank:
        press_top = motor_position + config.press_tank.pres_tank_pos + config.press_tank.press_h/2
    
    # Nose at top - above highest component
    max_height = max(lox_top, fuel_top, press_top, motor_position)
    nose_position = max_height + 4  # Small gap, then nose
    rocket.add_nose(length=0.6, kind="vonKarman", position=nose_position)

    # Compute initial thrust-to-weight ratio for validation
    # Sample thrust at t=0 from thrust curve
    if isinstance(thrust_curve, list):
        initial_thrust = thrust_curve[0][1] if thrust_curve else 0.0
    elif hasattr(thrust_curve, '__call__'):
        initial_thrust = float(thrust_curve(0.0))
    else:
        initial_thrust = float(thrust_curve)
    
    # Total initial mass = airframe + motor dry (includes engine + tank structures) + propellants + pressurant gas
    total_initial_mass = rocket_mass + motor_dry_mass + m_lox0 + m_rp10 + m_pressurant
    initial_twr = initial_thrust / (total_initial_mass * g0)
    
    print(f"\nMass Summary:")
    print(f"  Airframe: {rocket_mass:.2f} kg")
    print(f"  Motor dry (engine + tank structures): {motor_dry_mass:.2f} kg")
    print(f"  LOX propellant: {m_lox0:.2f} kg")
    print(f"  Fuel propellant: {m_rp10:.2f} kg")
    if m_pressurant > 0:
        print(f"  Pressurant gas: {m_pressurant:.3f} kg")
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
    
    if initial_twr < 1.3:
        print(f"WARNING: Low T/W ratio ({initial_twr:.3f}). Recommended > 1.3 for reliable liftoff.")
    
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
        # Also suppress ValueErrors that get raised for this issue
        try:
            flight = Flight(
                rocket=rocket,
                environment=env,
                rail_length=3.35,
                inclination=90,
                heading=0,
                max_time_step=0.02,
                max_time=max_flight_time,
                terminate_on_apogee=True,
            )
        except ValueError as e:
            if "must be within the domain of the Function" in str(e):
                # RocketPy internal numerical precision issue in tank calculations
                # Usually caused by liquid level exceeding tank geometry bounds
                raise ValueError(
                    f"Tank simulation error: liquid level exceeded tank geometry bounds. "
                    f"This usually means the propellant mass is too close to tank capacity. "
                    f"Try reducing LOX or fuel mass by 5-10%."
                )
            raise

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
    }