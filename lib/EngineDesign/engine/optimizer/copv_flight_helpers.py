"""COPV and Flight Simulation Helper Functions.

This module contains:
- COPV pressure curve calculation
- Flight simulation execution
"""

from __future__ import annotations

from typing import Dict, Any
import numpy as np
import pandas as pd

from engine.pipeline.config_schemas import PintleEngineConfig


def calculate_copv_pressure_curve(
    time_array: np.ndarray,
    mdot_O: np.ndarray,
    mdot_F: np.ndarray,
    P_tank_O: np.ndarray,
    P_tank_F: np.ndarray,
    config: PintleEngineConfig,
    copv_volume_m3: float,
    T0_K: float = 260.0,
    Tp_K: float = 260.0,
) -> Dict[str, Any]:
    """
    Calculate COPV pressure curve using polytropic blowdown model.
    
    Uses the same method as the COPV tab with user-specified temperatures (260K).
    """
    try:
        from copv.copv_solve_both import size_or_check_copv_for_polytropic_N2
        
        psi_to_Pa = 6894.757293168
        df = pd.DataFrame({
            "time": time_array,
            "mdot_O (kg/s)": mdot_O,
            "mdot_F (kg/s)": mdot_F,
            "P_tank_O (psi)": P_tank_O / psi_to_Pa,
            "P_tank_F (psi)": P_tank_F / psi_to_Pa,
        })
        
        copv_results = size_or_check_copv_for_polytropic_N2(
            df=df,
            config=config,
            n=1.2,
            T0_K=T0_K,
            Tp_K=Tp_K,
            use_real_gas=False,
            copv_volume_m3=copv_volume_m3,
            branch_temperatures_K={
                "oxidizer": Tp_K,
                "fuel": Tp_K,
            },
        )
        
        return {
            "success": True,
            "time": time_array,
            "copv_pressure_Pa": copv_results.get("PH_trace_Pa", np.zeros_like(time_array)),
            "copv_pressure_psi": copv_results.get("PH_trace_Pa", np.zeros_like(time_array)) / psi_to_Pa,
            "initial_pressure_Pa": copv_results.get("P0_Pa", 0),
            "initial_mass_kg": copv_results.get("m0_kg", 0),
            "total_delivered_kg": copv_results.get("total_delivered_mass_kg", 0),
            "min_margin_psi": copv_results.get("min_margin_Pa", 0) / psi_to_Pa,
        }
    except Exception as e:
        # Fallback: simple pressure estimate
        P_max = max(np.max(P_tank_O), np.max(P_tank_F))
        copv_P0 = P_max * 1.15
        n = 1.2
        mdot_total = mdot_O + mdot_F
        mass_consumed = np.cumsum(mdot_total * np.gradient(time_array))
        copv_pressure = copv_P0 * (1 - 0.3 * mass_consumed / (mass_consumed[-1] + 0.001))
        
        return {
            "success": False,
            "error": str(e),
            "time": time_array,
            "copv_pressure_Pa": copv_pressure,
            "copv_pressure_psi": copv_pressure / 6894.757293168,
            "initial_pressure_Pa": copv_P0,
            "initial_mass_kg": 0.5,
            "total_delivered_kg": 0.3,
            "min_margin_psi": 50.0,
        }


def run_flight_simulation(
    config: PintleEngineConfig,
    pressure_curves: Dict[str, np.ndarray],
    burn_time: float,
) -> Dict[str, Any]:
    """Run flight simulation on the optimized engine.
    
    Uses the existing setup_flight function from flight_sim.py.
    
    Args:
        config: Engine configuration (will be updated with burn_time)
        pressure_curves: Dict with 'time', 'thrust', 'mdot_O', 'mdot_F' arrays
        burn_time: Actual burn time to use (may be truncated from original)
    
    Returns:
        Dict with flight simulation results
    """
    try:
        from ui.flight_sim import setup_flight
        from scipy.interpolate import interp1d
        import copy
        
        # Create a copy to avoid modifying the original config
        config_copy = copy.deepcopy(config)
        
        # CRITICAL: Update config's burn_time to match the actual (possibly truncated) burn_time
        # This ensures setup_flight uses the correct burn_time for tank discretization
        # Ensure burn_time is a float, not an interp1d or other object
        if hasattr(burn_time, '__call__'):
            # burn_time is a callable (interp1d) - this shouldn't happen but handle it
            burn_time_float = float(burn_time(0))  # Just use the value at t=0 as fallback
        else:
            burn_time_float = float(burn_time)
        if hasattr(config_copy, 'thrust') and hasattr(config_copy.thrust, 'burn_time'):
            config_copy.thrust.burn_time = burn_time_float
        
        # Extract arrays and ensure they're numpy arrays (not interp1d objects)
        # Handle the case where pressure_curves values might be interp1d objects
        time_raw = pressure_curves["time"]
        thrust_raw = pressure_curves["thrust"]
        mdot_O_raw = pressure_curves["mdot_O"]
        mdot_F_raw = pressure_curves["mdot_F"]
        
        # Helper function to convert callable/interp1d to array
        def to_array(val, time_samples):
            """Convert a value (array, callable, or interp1d) to a numpy array."""
            if val is None:
                return np.array([], dtype=float)
            elif hasattr(val, '__call__'):
                # It's a callable (interp1d), sample it
                return np.asarray([float(val(t)) for t in time_samples], dtype=float)
            else:
                return np.asarray(val, dtype=float)
        
        # First, get time array (may need to generate samples if it's callable)
        if hasattr(time_raw, '__call__'):
            # Time is callable - generate time samples
            time_samples = np.linspace(0, burn_time_float, max(100, int(burn_time_float * 100)))
            time_array = time_samples
        else:
            time_array = np.asarray(time_raw, dtype=float)
            time_samples = time_array
        
        # Convert other arrays using the time samples
        thrust_array = to_array(thrust_raw, time_samples)
        mdot_O_array = to_array(mdot_O_raw, time_samples)
        mdot_F_array = to_array(mdot_F_raw, time_samples)
        
        # Ensure arrays are 1D and same length
        time_array = time_array.flatten()
        thrust_array = thrust_array.flatten()
        mdot_O_array = mdot_O_array.flatten()
        mdot_F_array = mdot_F_array.flatten()
        
        # Ensure all arrays have the same length
        min_len = min(len(time_array), len(thrust_array), len(mdot_O_array), len(mdot_F_array))
        if min_len == 0:
            raise ValueError("Pressure curves arrays are empty")
        
        time_array = time_array[:min_len]
        thrust_array = thrust_array[:min_len]
        mdot_O_array = mdot_O_array[:min_len]
        mdot_F_array = mdot_F_array[:min_len]
        
        # Convert arrays to interpolation functions for setup_flight
        # setup_flight expects Functions or callables, not arrays
        thrust_func = interp1d(time_array, thrust_array, kind='linear', fill_value=0, bounds_error=False)
        mdot_O_func = interp1d(time_array, mdot_O_array, kind='linear', fill_value=0, bounds_error=False)
        mdot_F_func = interp1d(time_array, mdot_F_array, kind='linear', fill_value=0, bounds_error=False)
        
        # Call the existing setup_flight function from flight_sim.py
        # This reuses all the smart logic: tank underfill detection, truncation, etc.
        result = setup_flight(config_copy, thrust_func, mdot_O_func, mdot_F_func, plot_results=False)
        
        apogee = result.get("apogee", 0)
        max_velocity = result.get("max_velocity", 0)
        
        # Validate results - if apogee is suspiciously low, something went wrong
        if apogee < 10.0:
            # Check if thrust curve is valid
            max_thrust = np.max(thrust_array) if len(thrust_array) > 0 else 0
            initial_thrust = thrust_array[0] if len(thrust_array) > 0 else 0
            
            # Check masses
            lox_mass = getattr(config_copy.lox_tank, 'mass', 0) if hasattr(config_copy, 'lox_tank') else 0
            fuel_mass = getattr(config_copy.fuel_tank, 'mass', 0) if hasattr(config_copy, 'fuel_tank') else 0
            
            error_msg = (
                f"Apogee is suspiciously low ({apogee:.1f}m). "
                f"Diagnostics: max_thrust={max_thrust:.1f}N, initial_thrust={initial_thrust:.1f}N, "
                f"lox_mass={lox_mass:.2f}kg, fuel_mass={fuel_mass:.2f}kg, burn_time={burn_time_float:.2f}s"
            )
            
            return {
                "success": False,
                "error": error_msg,
                "apogee": apogee,
                "max_velocity": max_velocity,
                "flight_time": result.get("flight_time", 0),
                "flight_obj": result.get("flight", None),
            }
        
        return {
            "success": True,
            "apogee": apogee,
            "max_velocity": max_velocity,
            "flight_time": result.get("flight_time", 0),
            "flight_obj": result.get("flight", None),
            "truncation_info": result.get("truncation_info", {}),  # Pass through truncation info
        }
    except ValueError as e:
        error_str = str(e)
        # Translate RocketPy's internal Function domain error into a user-friendly message
        if "must be within the domain of the Function" in error_str:
            # This is a RocketPy internal error about function composition bounds
            # Usually caused by tank fill levels exceeding geometry constraints
            return {
                "success": False,
                "error": "Tank simulation error: propellant mass may exceed tank capacity. Try reducing LOX or fuel mass slightly.",
                "apogee": 0,
                "max_velocity": 0,
            }
        # For other ValueErrors, return the actual error
        return {
            "success": False,
            "error": error_str,
            "apogee": 0,
            "max_velocity": 0,
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "apogee": 0,
            "max_velocity": 0,
        }

