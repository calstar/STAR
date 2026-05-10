"""Layer 4: Flight Simulation and Validation

Run flight simulation to validate trajectory performance and adjust tank fills
(propellant masses) to hit apogee targets.

This layer:
1. Starts from the current optimized engine configuration (Layers 1–3)
2. Runs flight simulation with **full** pressure curves
3. Lets `flight_sim.py` handle truncation when tanks run out
4. Iteratively reduces propellant masses if apogee is too high
5. Accepts the best match if apogee is below target and masses cannot be
   increased beyond their initial values

We optimize tank fills, not burn time. Burn time naturally follows from
propellant mass and the thrust / mdot curves.
"""

from __future__ import annotations

from typing import Dict, Any, Optional, Tuple, Callable
import numpy as np
import copy

from engine.pipeline.config_schemas import PintleEngineConfig
from ui.flight_sim import detect_tank_underfill_time
from scipy.interpolate import interp1d


def run_layer4_flight_simulation(
    optimized_config: PintleEngineConfig,
    pressure_curves: Dict[str, np.ndarray],
    time_array: np.ndarray,
    P_tank_O_array: np.ndarray,
    P_tank_F_array: np.ndarray,
    target_burn_time: float,
    target_apogee: float,
    apogee_tol: float,
    update_progress: Callable,
    log_status: Callable,
    run_flight_simulation_func: Callable,
    ) -> Dict[str, Any]:
    """
    Run Layer 4: Flight Simulation with tank-fill iteration.

    We:
    - Keep the full time history of thrust / mdot curves
    - Let the flight sim detect when tanks run out and truncate internally
    - Iteratively reduce LOX/fuel masses if apogee is too high
    """
    result: Dict[str, Any] = {
        "success": False,
        "apogee": 0.0,
        "max_velocity": 0.0,
        "layer": 4,
        "flight_candidate_valid": False,
        # Optional extras mirrored from the full optimizer / ui_app flight sim
        "iteration_data": [],
        "best_iteration": None,
        "best_apogee_error": float("inf"),
        "flight_obj": None,
        "actual_burn_time": None,
        "truncation_info": {},
    }

    try:
        # Copy config so we can safely tweak tank masses
        config_for_flight = copy.deepcopy(optimized_config)

        # Initial propellant masses from the optimized config
        initial_lox_mass = float(getattr(config_for_flight.lox_tank, "mass", 0.0))
        initial_fuel_mass = float(getattr(config_for_flight.fuel_tank, "mass", 0.0))

        # If tanks are not configured, just bail out gracefully
        if initial_lox_mass <= 0.0 or initial_fuel_mass <= 0.0:
            update_progress(
                "Layer 4: Flight Candidate",
                0.80,
                "Skipping flight sim: tank masses not configured",
            )
            return result

        # Start from full propellant, then adjust bidirectionally to find optimal
        current_lox_mass = initial_lox_mass
        current_fuel_mass = initial_fuel_mass

        # Adaptive step size for bidirectional search
        mass_adjustment_step = 0.05  # 5% adjustment per iteration (can be positive or negative)
        max_iterations = 20
        best_error = float("inf")
        best_result: Optional[Dict[str, Any]] = None
        iteration_data = []
        best_iteration_idx: Optional[int] = None
        
        # Track search direction and bounds for binary search-like behavior
        # Keep track of masses that give apogee above and below target
        lox_mass_above = initial_lox_mass  # Mass that gives apogee > target
        lox_mass_below = None  # Mass that gives apogee < target
        fuel_mass_above = initial_fuel_mass
        fuel_mass_below = None
        last_apogee = None
        last_direction = None  # 'up' or 'down'

        for i in range(1, max_iterations + 1):
            progress = 0.75 + 0.10 * (i / max_iterations)

            # Apply current masses
            config_for_flight.lox_tank.mass = current_lox_mass
            config_for_flight.fuel_tank.mass = current_fuel_mass

            update_progress(
                "Layer 4: Flight Candidate",
                progress,
                f"Iteration {i}: LOX={current_lox_mass:.2f} kg, Fuel={current_fuel_mass:.2f} kg "
                f"(target apogee {target_apogee:.0f} m)",
            )

            # CRITICAL: Detect tank underfill BEFORE running flight sim to prevent errors
            # Extract mdot arrays from pressure_curves (handle both arrays and interp1d objects)
            time_array_local = pressure_curves.get("time", time_array)
            mdot_O_raw = pressure_curves.get("mdot_O")
            mdot_F_raw = pressure_curves.get("mdot_F")
            
            # Convert to arrays if needed (handle interp1d objects by sampling)
            if time_array_local is not None and hasattr(time_array_local, '__call__'):
                # It's a callable (interp1d), sample it
                time_samples = np.linspace(0, target_burn_time, max(100, int(target_burn_time * 100)))
                time_array_local = np.asarray([float(time_array_local(t)) for t in time_samples], dtype=float)
            elif time_array_local is not None:
                time_array_local = np.asarray(time_array_local, dtype=float)
            else:
                time_array_local = np.asarray(time_array, dtype=float)
            
            if mdot_O_raw is not None and hasattr(mdot_O_raw, '__call__'):
                # It's a callable (interp1d), sample it using the same time array
                if not isinstance(time_array_local, np.ndarray) or len(time_array_local) == 0:
                    time_samples = np.linspace(0, target_burn_time, max(100, int(target_burn_time * 100)))
                else:
                    time_samples = time_array_local
                mdot_O_array = np.asarray([float(mdot_O_raw(t)) for t in time_samples], dtype=float)
            elif mdot_O_raw is not None:
                mdot_O_array = np.asarray(mdot_O_raw, dtype=float)
            else:
                mdot_O_array = np.array([], dtype=float)
            
            if mdot_F_raw is not None and hasattr(mdot_F_raw, '__call__'):
                # It's a callable (interp1d), sample it using the same time array
                if not isinstance(time_array_local, np.ndarray) or len(time_array_local) == 0:
                    time_samples = np.linspace(0, target_burn_time, max(100, int(target_burn_time * 100)))
                else:
                    time_samples = time_array_local
                mdot_F_array = np.asarray([float(mdot_F_raw(t)) for t in time_samples], dtype=float)
            elif mdot_F_raw is not None:
                mdot_F_array = np.asarray(mdot_F_raw, dtype=float)
            else:
                mdot_F_array = np.array([], dtype=float)
            
            # Ensure arrays are same length
            if len(time_array_local) > 0 and len(mdot_O_array) > 0 and len(mdot_F_array) > 0:
                min_len = min(len(time_array_local), len(mdot_O_array), len(mdot_F_array))
                if min_len > 0:
                    time_array_local = time_array_local[:min_len]
                    mdot_O_array = mdot_O_array[:min_len]
                    mdot_F_array = mdot_F_array[:min_len]
                    
                    # Create interpolation functions for underfill detection
                    mdot_O_func = interp1d(time_array_local, mdot_O_array, kind='linear', fill_value=0, bounds_error=False)
                    mdot_F_func = interp1d(time_array_local, mdot_F_array, kind='linear', fill_value=0, bounds_error=False)
                    
                    # Detect underfill times
                    lox_cutoff = detect_tank_underfill_time(mdot_O_func, current_lox_mass, target_burn_time)
                    fuel_cutoff = detect_tank_underfill_time(mdot_F_func, current_fuel_mass, target_burn_time)
                else:
                    lox_cutoff = None
                    fuel_cutoff = None
            else:
                lox_cutoff = None
                fuel_cutoff = None
                
            # Find earliest cutoff and truncate burn_time slightly (subtract 0.1% or 0.01s, whichever is larger)
            truncated_burn_time = target_burn_time
            if lox_cutoff is not None or fuel_cutoff is not None:
                earliest_cutoff = None
                if lox_cutoff is not None and fuel_cutoff is not None:
                    earliest_cutoff = min(lox_cutoff, fuel_cutoff)
                elif lox_cutoff is not None:
                    earliest_cutoff = lox_cutoff
                elif fuel_cutoff is not None:
                    earliest_cutoff = fuel_cutoff
                
                if earliest_cutoff is not None and earliest_cutoff < target_burn_time:
                    # Truncate slightly before the cutoff to prevent negative mass errors
                    # Use 0.1% of burn time or 0.01s, whichever is larger, as safety margin
                    safety_margin = max(target_burn_time * 0.001, 0.01)
                    truncated_burn_time = max(0.1, earliest_cutoff - safety_margin)

            # Run flight simulation
            # CRITICAL: Pass the ORIGINAL target_burn_time, not truncated_burn_time.
            # This ensures setup_flight uses the full time range for accurate truncation detection.
            # The pre-truncation check above was just for validation - setup_flight will do
            # its own truncation detection with the actual masses, which is more accurate.
            # Setting config burn_time ensures consistency.
            config_for_flight.thrust.burn_time = target_burn_time
            
            sim = run_flight_simulation_func(
                config_for_flight,
                pressure_curves,
                target_burn_time,  # Use original burn_time - setup_flight will handle truncation
            )

            success = bool(sim.get("success", False))
            apogee = float(sim.get("apogee", 0.0) or 0.0)
            max_velocity = float(sim.get("max_velocity", 0.0) or 0.0)
            flight_obj = sim.get("flight_obj", None)
            
            # Get actual burn time from truncation info if available, otherwise use truncated_burn_time
            truncation_info = sim.get("truncation_info", {})
            if truncation_info.get("truncated", False) and "cutoff_time" in truncation_info:
                # Use the actual cutoff time from flight sim (more accurate)
                actual_burn_time = float(truncation_info["cutoff_time"])
            else:
                # Use the truncated burn time we calculated, or fallback to target
                actual_burn_time = float(sim.get("flight_time", truncated_burn_time) or truncated_burn_time)

            # Basic thrust diagnostics from the pressure_curves input
            thrust_array = pressure_curves.get("thrust")
            time_array_local = pressure_curves.get("time")
            if thrust_array is not None and time_array_local is not None:
                thrust_array = np.asarray(thrust_array, dtype=float)
                time_array_local = np.asarray(time_array_local, dtype=float)
                min_len_local = min(len(thrust_array), len(time_array_local))
                if min_len_local > 0:
                    thrust_array = thrust_array[:min_len_local]
                    time_array_local = time_array_local[:min_len_local]
                    max_thrust = float(np.max(thrust_array))
                    initial_thrust = float(thrust_array[0])
                    # Guard against zero division if time range is degenerate
                    try:
                        total_impulse = float(np.trapezoid(thrust_array, time_array_local) if hasattr(np, "trapezoid") else np.trapz(thrust_array, time_array_local))
                        avg_thrust = float(total_impulse / max(actual_burn_time, 1e-6))
                    except Exception:
                        total_impulse = 0.0
                        avg_thrust = 0.0
                else:
                    max_thrust = 0.0
                    initial_thrust = 0.0
                    avg_thrust = 0.0
                    total_impulse = 0.0
            else:
                max_thrust = 0.0
                initial_thrust = 0.0
                avg_thrust = 0.0
                total_impulse = 0.0

            if not success:
                # If sim fails, try again with slightly less propellant; if it keeps failing,
                # we still keep the best attempt seen so far.
                iteration_data.append(
                    {
                        "iteration": i,
                        "burn_time": actual_burn_time,
                        "apogee": apogee,
                        "apogee_error_pct": 100.0,
                        "max_velocity": max_velocity,
                        "success": False,
                        "max_thrust": max_thrust,
                        "initial_thrust": initial_thrust,
                        "avg_thrust": avg_thrust,
                        "total_impulse": total_impulse,
                        "adjusted_lox_mass": current_lox_mass,
                        "adjusted_fuel_mass": current_fuel_mass,
                        "error": sim.get("error", ""),
                    }
                )
                current_lox_mass = max(0.1, current_lox_mass * (1.0 - mass_adjustment_step))
                current_fuel_mass = max(0.1, current_fuel_mass * (1.0 - mass_adjustment_step))
                continue

            # Compute fractional apogee error
            if target_apogee > 0.0:
                error_frac = abs(apogee - target_apogee) / target_apogee
            else:
                error_frac = 1.0

            iteration_data.append(
                {
                    "iteration": i,
                    "burn_time": actual_burn_time,
                    "apogee": apogee,
                    "apogee_error_pct": error_frac * 100.0,
                    "max_velocity": max_velocity,
                    "success": True,
                    "max_thrust": max_thrust,
                    "initial_thrust": initial_thrust,
                    "avg_thrust": avg_thrust,
                    "total_impulse": total_impulse,
                    "adjusted_lox_mass": current_lox_mass,
                    "adjusted_fuel_mass": current_fuel_mass,
                    "error": sim.get("error", ""),
                }
            )

            # Track the best candidate
            if error_frac < best_error:
                best_error = error_frac
                best_iteration_idx = i
                best_result = {
                    "success": True,
                    "apogee": apogee,
                    "max_velocity": max_velocity,
                    "layer": 4,
                    "flight_candidate_valid": error_frac < apogee_tol,
                    "iterations": i,
                    "adjusted_lox_mass": current_lox_mass,
                    "adjusted_fuel_mass": current_fuel_mass,
                    "flight_obj": flight_obj,
                    "actual_burn_time": actual_burn_time,
                    "truncation_info": sim.get("truncation_info", {}),
                }

            # If we're within tolerance, we can stop early (but still track for best result)
            if error_frac < apogee_tol:
                update_progress(
                    "Layer 4: Flight Candidate",
                    progress,
                    f"Apogee {apogee:.0f} m within {error_frac * 100:.1f}% of target "
                    f"{target_apogee:.0f} m (iteration {i}/{max_iterations}).",
                )
                # Don't break - continue to see if we can find an even better match

            # Bidirectional adjustment: increase or decrease masses based on apogee vs target
            current_direction = None
            if apogee > target_apogee:
                # Apogee too high - reduce masses
                lox_mass_above = current_lox_mass
                fuel_mass_above = current_fuel_mass
                
                # If we have a lower bound, use binary search; otherwise use step reduction
                if lox_mass_below is not None:
                    # Binary search between above and below bounds
                    current_lox_mass = (lox_mass_above + lox_mass_below) / 2.0
                    current_fuel_mass = (fuel_mass_above + fuel_mass_below) / 2.0
                else:
                    # No lower bound yet - reduce by step
                    current_lox_mass = max(0.1, current_lox_mass * (1.0 - mass_adjustment_step))
                    current_fuel_mass = max(0.1, current_fuel_mass * (1.0 - mass_adjustment_step))
                
                current_direction = 'down'
            else:
                # Apogee too low - increase masses
                lox_mass_below = current_lox_mass
                fuel_mass_below = current_fuel_mass
                
                # If we have an upper bound, use binary search; otherwise use step increase
                if lox_mass_above is not None and lox_mass_above > current_lox_mass:
                    # Binary search between above and below bounds
                    current_lox_mass = (lox_mass_above + lox_mass_below) / 2.0
                    current_fuel_mass = (fuel_mass_above + fuel_mass_below) / 2.0
                else:
                    # No upper bound or already at initial - increase by step (up to initial)
                    current_lox_mass = min(initial_lox_mass, current_lox_mass * (1.0 + mass_adjustment_step))
                    current_fuel_mass = min(initial_fuel_mass, current_fuel_mass * (1.0 + mass_adjustment_step))
                
                current_direction = 'up'
            
            # Prevent oscillation: if we're bouncing back and forth, reduce step size
            if i > 2 and last_direction is not None:
                if last_direction != current_direction:
                    # We're oscillating - reduce step size
                    mass_adjustment_step *= 0.8
                    mass_adjustment_step = max(0.01, mass_adjustment_step)  # Don't go below 1%
            
            last_direction = current_direction
            last_apogee = apogee

        # Finalize result from the best candidate, if any
        result["iteration_data"] = iteration_data
        if best_result is not None:
            result.update(best_result)
            result["best_iteration"] = best_iteration_idx
            result["best_apogee_error"] = best_error
        else:
            # No successful sim; keep default structure but mark failure
            result["success"] = False
            result["flight_candidate_valid"] = False

    except Exception as exc:
        update_progress(
            "Layer 4: Flight Candidate",
            0.85,
            f"Flight sim error: {exc}",
        )
        result.update(
            {
                "success": False,
                "error": str(exc),
                "apogee": 0.0,
                "max_velocity": 0.0,
                "flight_candidate_valid": False,
            }
        )

    return result

