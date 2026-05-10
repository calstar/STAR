"""Time-series evaluation endpoints."""

from pathlib import Path
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel, Field, ValidationError
from typing import List, Optional, Literal
import numpy as np
import pandas as pd
import io
import yaml

from backend.state import app_state
from engine.pipeline.time_series import generate_pressure_profile
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.optimizer.layers.layer2_pressure import generate_pressure_curve_from_segments
from copv.copv_solve_both import size_or_check_copv_for_polytropic_N2

# Get path to N2 Z lookup table (relative to project root)
_PROJECT_ROOT = Path(__file__).parent.parent.parent
N2_Z_LOOKUP_CSV = str(_PROJECT_ROOT / "copv" / "n2_Z_lookup.csv")

router = APIRouter(prefix="/api/timeseries", tags=["timeseries"])


# Constants
PSI_TO_PA = 6894.76
PA_TO_PSI = 1.0 / PSI_TO_PA


def convert_numpy(obj):
    """Recursively convert numpy types to Python native types."""
    if isinstance(obj, dict):
        return {k: convert_numpy(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [convert_numpy(item) for item in obj]
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, (np.integer, np.floating)):
        return obj.item()
    elif isinstance(obj, np.bool_):
        return bool(obj)
    else:
        return obj


def compute_timeseries_results(
    runner,
    times: np.ndarray,
    P_tank_O_psi: np.ndarray,
    P_tank_F_psi: np.ndarray,
    run_copv: bool = True,  # NEW: flag to control COPV analysis
    lox_mass_kg: Optional[np.ndarray] = None, # NEW: Propellant mass history for flameout masking
    fuel_mass_kg: Optional[np.ndarray] = None, # NEW: Propellant mass history for flameout masking
):
    """Compute time-series results from pressure profiles.
    
    This is a standalone version that doesn't depend on Streamlit.
    """
    P_tank_O_pa = np.asarray(P_tank_O_psi) * PSI_TO_PA
    P_tank_F_pa = np.asarray(P_tank_F_psi) * PSI_TO_PA

    # Check if ablative geometry tracking is enabled
    ablative_cfg = runner.config.ablative_cooling
    use_time_varying = (
        ablative_cfg is not None 
        and ablative_cfg.enabled 
        and getattr(ablative_cfg, 'track_geometry_evolution', False)
        and len(times) >= 2
    )
    
    if use_time_varying:
        results = runner.evaluate_arrays_with_time(
            times, 
            P_tank_O_pa, 
            P_tank_F_pa,
            use_coupled_solver=True,
        )
    else:
        results = runner.evaluate_arrays(P_tank_O_pa, P_tank_F_pa)

    # Build results dict
    result_data = {
        "time": np.asarray(times).tolist(),
        "P_tank_O_psi": np.asarray(P_tank_O_psi, dtype=float).tolist(),
        "P_tank_F_psi": np.asarray(P_tank_F_psi, dtype=float).tolist(),
        # Use mutable arrays for masking
        "Pc_psi": np.asarray(results["Pc"], dtype=float) * PA_TO_PSI,
        "thrust_kN": np.asarray(results["F"], dtype=float) / 1000.0,
        "Isp_s": np.asarray(results["Isp"], dtype=float),
        "MR": np.asarray(results["MR"], dtype=float),
        "mdot_O_kg_s": np.asarray(results["mdot_O"], dtype=float),
        "mdot_F_kg_s": np.asarray(results["mdot_F"], dtype=float),
        "mdot_total_kg_s": np.asarray(results["mdot_total"], dtype=float),
        "cstar_actual_m_s": np.asarray(results["cstar_actual"], dtype=float),
        "gamma": np.asarray(results["gamma"], dtype=float),
    }

    # FLAMEOUT MASKING
    # If mass history is provided, mask performance metrics where propellant is depleted.
    # We define "depleted" as mass <= epsilon (e.g. 1e-4 kg).
    # Since tanks are clamped to 0 in solver, checking <= 1e-4 is safe.
    mask = None
    
    # helper for robust conversion
    def to_float_array(arr):
        try:
            return np.asarray(arr, dtype=float)
        except Exception:
            return np.zeros(len(times))
            
    if lox_mass_kg is not None and len(lox_mass_kg) == len(times):
        lox_m = to_float_array(lox_mass_kg)
        mask_lox = lox_m <= 1e-4
        if mask is None:
            mask = mask_lox
        else:
            mask = mask | mask_lox
            
    if fuel_mass_kg is not None and len(fuel_mass_kg) == len(times):
        fuel_m = to_float_array(fuel_mass_kg)
        mask_fuel = fuel_m <= 1e-4
        if mask is None:
            mask = mask_fuel
        else:
            mask = mask | mask_fuel
            
    if mask is not None:
        # LOGGING for debugging
        n_masked = np.sum(mask)
        if n_masked > 0:
            import logging
            logging.info(f"[TIMESERIES] Masking {n_masked}/{len(times)} points due to flameout.")
        
        # Apply mask to performance metrics (set to 0.0)
        # Note: We do NOT mask tank pressures (they show residual gas)
        metrics_to_mask = [
            "Pc_psi", "thrust_kN", "Isp_s", "MR", 
            "mdot_O_kg_s", "mdot_F_kg_s", "mdot_total_kg_s", 
            "cstar_actual_m_s"
        ]
        for key in metrics_to_mask:
            if key in result_data:
                # Ensure array is mutable and float type
                arr = np.array(result_data[key], dtype=float)
                arr[mask] = 0.0
                result_data[key] = arr

                
    # Convert arrays back to lists for JSON serialization
    for k, v in result_data.items():
        if isinstance(v, np.ndarray):
            result_data[k] = v.tolist()
    
    # Add optional fields if available
    if "Cd_O" in results:
        result_data["Cd_O"] = np.asarray(results["Cd_O"], dtype=float).tolist()
    if "Cd_F" in results:
        result_data["Cd_F"] = np.asarray(results["Cd_F"], dtype=float).tolist()
    
    # Extract diagnostics data (matching Streamlit pattern)
    diagnostics_list = results.get("diagnostics", [])
    n_points = len(times)
    
    # Initialize arrays for optional data
    delta_P_injector_O_psi = []
    delta_P_injector_F_psi = []
    recession_rate_ablative_um_s = []
    recession_rate_graphite_thermal_um_s = []
    recession_rate_graphite_oxidation_um_s = []
    
    # Extract data from diagnostics (matching Streamlit pattern)
    for i, diag in enumerate(diagnostics_list):
        if not isinstance(diag, dict):
            delta_P_injector_O_psi.append(np.nan)
            delta_P_injector_F_psi.append(np.nan)
            recession_rate_ablative_um_s.append(np.nan)
            recession_rate_graphite_thermal_um_s.append(np.nan)
            recession_rate_graphite_oxidation_um_s.append(np.nan)
            continue
            
        # Injector pressure drops (check both locations like Streamlit)
        injector_pressure = diag.get("injector_pressure", {})
        if injector_pressure and isinstance(injector_pressure, dict):
            delta_P_O = injector_pressure.get("delta_P_injector_O")
            delta_P_F = injector_pressure.get("delta_P_injector_F")
        else:
            # Fallback to direct access
            delta_P_O = diag.get("delta_P_injector_O")
            delta_P_F = diag.get("delta_P_injector_F")
        
        if delta_P_O is not None:
            delta_P_injector_O_psi.append(float(delta_P_O * PA_TO_PSI))
        else:
            delta_P_injector_O_psi.append(np.nan)
            
        if delta_P_F is not None:
            delta_P_injector_F_psi.append(float(delta_P_F * PA_TO_PSI))
        else:
            delta_P_injector_F_psi.append(np.nan)
        
        # Cooling diagnostics - recession rates (matching Streamlit pattern)
        cooling = diag.get("cooling", {})
        ablative = cooling.get("ablative", {}) if cooling else {}
        graphite = cooling.get("graphite", {}) if cooling else {}
        
        # Ablative recession rate
        if ablative and isinstance(ablative, dict):
            recession_rate = ablative.get("recession_rate")
            if recession_rate is not None:
                recession_rate_ablative_um_s.append(float(recession_rate * 1e6))  # Convert m/s to µm/s
            else:
                recession_rate_ablative_um_s.append(np.nan)
        else:
            recession_rate_ablative_um_s.append(np.nan)
        
        # Graphite recession rates
        if graphite and isinstance(graphite, dict) and graphite.get("enabled", False):
            thermal_rate = graphite.get("recession_rate_thermal")
            oxidation_rate = graphite.get("oxidation_rate")
            if thermal_rate is not None:
                recession_rate_graphite_thermal_um_s.append(float(thermal_rate * 1e6))  # Convert m/s to µm/s
            else:
                recession_rate_graphite_thermal_um_s.append(np.nan)
            if oxidation_rate is not None:
                recession_rate_graphite_oxidation_um_s.append(float(oxidation_rate * 1e6))  # Convert m/s to µm/s
            else:
                recession_rate_graphite_oxidation_um_s.append(np.nan)
        else:
            recession_rate_graphite_thermal_um_s.append(np.nan)
            recession_rate_graphite_oxidation_um_s.append(np.nan)
    
    # Extract Heat Flux Profiles from regen or ablative cooling data
    # Priority: regen > ablative (use whichever is available)
    axial_positions = None
    heat_flux_profiles = []
    wall_temp_profiles = []
    
    # Ablative-specific profiles (incident, conv, rad, net)
    ablative_axial_positions = None
    ablative_q_incident_profiles = []
    ablative_q_conv_profiles = []
    ablative_q_rad_profiles = []
    ablative_q_net_profiles = []
    ablative_throat_index = -1
    
    # Debug: check first diagnostic for structure
    import logging
    logger = logging.getLogger(__name__)
    if diagnostics_list and len(diagnostics_list) > 0 and isinstance(diagnostics_list[0], dict):
        first_diag = diagnostics_list[0]
        cooling_data = first_diag.get("cooling", {})
        logger.info(f"[TIMESERIES DEBUG] First diagnostic 'cooling' keys: {list(cooling_data.keys()) if cooling_data else 'no cooling'}")
        if cooling_data and "ablative" in cooling_data:
            abl_data = cooling_data["ablative"]
            logger.info(f"[TIMESERIES DEBUG] ablative keys: {list(abl_data.keys()) if isinstance(abl_data, dict) else 'not a dict'}")
            if isinstance(abl_data, dict):
                logger.info(f"[TIMESERIES DEBUG] ablative segment_x length: {len(abl_data.get('segment_x', []))}")
    
    for i, diag in enumerate(diagnostics_list):
        if not isinstance(diag, dict):
            heat_flux_profiles.append([])
            wall_temp_profiles.append([])
            ablative_q_incident_profiles.append([])
            ablative_q_conv_profiles.append([])
            ablative_q_rad_profiles.append([])
            ablative_q_net_profiles.append([])
            continue
            
        cooling = diag.get("cooling", {})
        regen = cooling.get("regen", {}) if cooling else {}
        ablative = cooling.get("ablative", {}) if cooling else {}
        
        # Try regen first
        if regen and isinstance(regen, dict):
            segment_positions = regen.get("segment_positions", [])
            segment_heat_flux = regen.get("segment_heat_flux", [])
            segment_wall_temps = regen.get("segment_wall_temperatures", [])
            
            # Set axial_positions once (should be same for all time steps)
            if axial_positions is None and segment_positions:
                axial_positions = [float(p) for p in segment_positions]
            
            heat_flux_profiles.append([float(q) for q in segment_heat_flux] if segment_heat_flux else [])
            wall_temp_profiles.append([float(t) for t in segment_wall_temps] if segment_wall_temps else [])
        else:
            heat_flux_profiles.append([])
            wall_temp_profiles.append([])
        
        # Extract ablative profile data (separate from regen)
        if ablative and isinstance(ablative, dict):
            segment_x = ablative.get("segment_x", [])
            segment_q_incident = ablative.get("segment_q_incident", [])
            segment_q_conv = ablative.get("segment_q_conv", [])
            segment_q_rad = ablative.get("segment_q_rad", [])
            segment_q_net = ablative.get("segment_q_net", [])
            throat_idx = ablative.get("throat_index", -1)
            
            # Set ablative positions once
            if ablative_axial_positions is None and segment_x:
                ablative_axial_positions = [float(p) for p in segment_x]
                ablative_throat_index = throat_idx
            
            ablative_q_incident_profiles.append([float(q) for q in segment_q_incident] if segment_q_incident else [])
            ablative_q_conv_profiles.append([float(q) for q in segment_q_conv] if segment_q_conv else [])
            ablative_q_rad_profiles.append([float(q) for q in segment_q_rad] if segment_q_rad else [])
            ablative_q_net_profiles.append([float(q) for q in segment_q_net] if segment_q_net else [])
        else:
            ablative_q_incident_profiles.append([])
            ablative_q_conv_profiles.append([])
            ablative_q_rad_profiles.append([])
            ablative_q_net_profiles.append([])
    
    # Extract geometry evolution data (from evaluate_arrays_with_time results)
    Lstar_mm = None
    V_chamber_m3 = None
    A_throat_m2 = None
    recession_cumulative_chamber_um = None
    recession_cumulative_throat_um = None
    
    if "Lstar" in results:
        Lstar_array = np.asarray(results["Lstar"], dtype=float)
        if len(Lstar_array) == n_points:
            Lstar_mm = (Lstar_array * 1000.0).tolist()  # Convert m to mm
    
    if "V_chamber" in results:
        V_chamber_array = np.asarray(results["V_chamber"], dtype=float)
        if len(V_chamber_array) == n_points:
            V_chamber_m3 = V_chamber_array.tolist()
    
    if "A_throat" in results:
        A_throat_array = np.asarray(results["A_throat"], dtype=float)
        if len(A_throat_array) == n_points:
            A_throat_m2 = A_throat_array.tolist()
    
    if "recession_chamber" in results:
        recession_array = np.asarray(results["recession_chamber"], dtype=float)
        if len(recession_array) == n_points:
            recession_cumulative_chamber_um = (recession_array * 1e6).tolist()  # Convert m to µm
    
    if "recession_throat" in results:
        recession_array = np.asarray(results["recession_throat"], dtype=float)
        if len(recession_array) == n_points:
            recession_cumulative_throat_um = (recession_array * 1e6).tolist()  # Convert m to µm
    
    # Calculate cumulative recession from rates (matching Streamlit pattern)
    recession_cumulative_ablative_mm = None
    recession_cumulative_graphite_thermal_mm = None
    recession_cumulative_graphite_oxidation_mm = None
    
    if any(np.isfinite(recession_rate_ablative_um_s)):
        times_array = np.asarray(times)
        dt = np.diff(times_array, prepend=times_array[0] if len(times_array) > 0 else 0.0)
        recession_rate_m_s = np.asarray(recession_rate_ablative_um_s, dtype=float) * 1e-6  # Convert µm/s to m/s
        recession_rate_m_s = np.nan_to_num(recession_rate_m_s, nan=0.0)
        cumulative = np.cumsum(recession_rate_m_s * dt) * 1000.0  # Convert to mm
        recession_cumulative_ablative_mm = cumulative.tolist()
    
    if any(np.isfinite(recession_rate_graphite_thermal_um_s)):
        times_array = np.asarray(times)
        dt = np.diff(times_array, prepend=times_array[0] if len(times_array) > 0 else 0.0)
        recession_rate_m_s = np.asarray(recession_rate_graphite_thermal_um_s, dtype=float) * 1e-6
        recession_rate_m_s = np.nan_to_num(recession_rate_m_s, nan=0.0)
        cumulative = np.cumsum(recession_rate_m_s * dt) * 1000.0
        recession_cumulative_graphite_thermal_mm = cumulative.tolist()
    
    if any(np.isfinite(recession_rate_graphite_oxidation_um_s)):
        times_array = np.asarray(times)
        dt = np.diff(times_array, prepend=times_array[0] if len(times_array) > 0 else 0.0)
        recession_rate_m_s = np.asarray(recession_rate_graphite_oxidation_um_s, dtype=float) * 1e-6
        recession_rate_m_s = np.nan_to_num(recession_rate_m_s, nan=0.0)
        cumulative = np.cumsum(recession_rate_m_s * dt) * 1000.0
        recession_cumulative_graphite_oxidation_mm = cumulative.tolist()
    
    # Add optional data fields (only if data exists)
    if delta_P_injector_O_psi and any(np.isfinite(delta_P_injector_O_psi)):
        result_data["delta_P_injector_O_psi"] = delta_P_injector_O_psi
    if delta_P_injector_F_psi and any(np.isfinite(delta_P_injector_F_psi)):
        result_data["delta_P_injector_F_psi"] = delta_P_injector_F_psi
    
    if Lstar_mm and any(np.isfinite(Lstar_mm)):
        result_data["Lstar_mm"] = Lstar_mm
    
    if recession_rate_ablative_um_s and any(np.isfinite(recession_rate_ablative_um_s)):
        result_data["recession_rate_ablative_um_s"] = recession_rate_ablative_um_s
    if recession_rate_graphite_thermal_um_s and any(np.isfinite(recession_rate_graphite_thermal_um_s)):
        result_data["recession_rate_graphite_thermal_um_s"] = recession_rate_graphite_thermal_um_s
    if recession_rate_graphite_oxidation_um_s and any(np.isfinite(recession_rate_graphite_oxidation_um_s)):
        result_data["recession_rate_graphite_oxidation_um_s"] = recession_rate_graphite_oxidation_um_s
    
    if recession_cumulative_ablative_mm and any(np.isfinite(recession_cumulative_ablative_mm)):
        result_data["recession_cumulative_ablative_mm"] = recession_cumulative_ablative_mm
    if recession_cumulative_graphite_thermal_mm and any(np.isfinite(recession_cumulative_graphite_thermal_mm)):
        result_data["recession_cumulative_graphite_thermal_mm"] = recession_cumulative_graphite_thermal_mm
    if recession_cumulative_graphite_oxidation_mm and any(np.isfinite(recession_cumulative_graphite_oxidation_mm)):
        result_data["recession_cumulative_graphite_oxidation_mm"] = recession_cumulative_graphite_oxidation_mm
    
    if recession_cumulative_chamber_um and any(np.isfinite(recession_cumulative_chamber_um)):
        result_data["recession_cumulative_chamber_um"] = recession_cumulative_chamber_um
    if recession_cumulative_throat_um and any(np.isfinite(recession_cumulative_throat_um)):
        result_data["recession_cumulative_throat_um"] = recession_cumulative_throat_um
    
    if V_chamber_m3 and any(np.isfinite(V_chamber_m3)) and len(V_chamber_m3) > 0:
        result_data["V_chamber_m3"] = V_chamber_m3
        result_data["V_chamber_initial_m3"] = float(V_chamber_m3[0])
    if A_throat_m2 and any(np.isfinite(A_throat_m2)) and len(A_throat_m2) > 0:
        result_data["A_throat_m2"] = A_throat_m2
        result_data["A_throat_initial_m2"] = float(A_throat_m2[0])
    
    # Add Heat Flux Profiles (only if data exists)
    # Regen heat flux profiles
    if axial_positions:
        result_data["axial_positions_m"] = axial_positions
        result_data["heat_flux_profiles_w_m2"] = heat_flux_profiles
        result_data["wall_temp_profiles_k"] = wall_temp_profiles
    
    # Ablative heat flux profiles (separate from regen)
    # Debug logging
    import logging
    logger = logging.getLogger(__name__)
    logger.info(f"[TIMESERIES] ablative_axial_positions: {ablative_axial_positions is not None}, length={len(ablative_axial_positions) if ablative_axial_positions else 0}")
    logger.info(f"[TIMESERIES] ablative_q_incident_profiles length: {len(ablative_q_incident_profiles)}")
    if ablative_q_incident_profiles and len(ablative_q_incident_profiles) > 0:
        non_empty = sum(1 for p in ablative_q_incident_profiles if p and len(p) > 0)
        logger.info(f"[TIMESERIES] ablative_q_incident_profiles non-empty profiles: {non_empty}/{len(ablative_q_incident_profiles)}")
    
    if ablative_axial_positions:
        result_data["ablative_axial_positions_m"] = ablative_axial_positions
        result_data["ablative_q_incident_profiles_w_m2"] = ablative_q_incident_profiles
        result_data["ablative_q_conv_profiles_w_m2"] = ablative_q_conv_profiles
        result_data["ablative_q_rad_profiles_w_m2"] = ablative_q_rad_profiles
        result_data["ablative_q_net_profiles_w_m2"] = ablative_q_net_profiles
        result_data["ablative_throat_index"] = ablative_throat_index
        logger.info(f"[TIMESERIES] Added ablative heat flux data to result_data")
    else:
        logger.info(f"[TIMESERIES] NO ablative_axial_positions - skipping ablative data")
    
    # Calculate summary statistics
    thrust_arr = np.asarray(results["F"], dtype=float) / 1000.0
    Pc_arr = np.asarray(results["Pc"], dtype=float) * PA_TO_PSI
    Isp_arr = np.asarray(results["Isp"], dtype=float)
    mdot_arr = np.asarray(results["mdot_total"], dtype=float)
    
    summary = {
        "avg_thrust_kN": float(np.nanmean(thrust_arr)),
        "peak_thrust_kN": float(np.nanmax(thrust_arr)),
        "min_thrust_kN": float(np.nanmin(thrust_arr)),
        "avg_Pc_psi": float(np.nanmean(Pc_arr)),
        "peak_Pc_psi": float(np.nanmax(Pc_arr)),
        "avg_Isp_s": float(np.nanmean(Isp_arr)),
        "total_impulse_kNs": float(np.trapezoid(thrust_arr, times) if hasattr(np, "trapezoid") else np.trapz(thrust_arr, times)),
        "total_propellant_kg": float(np.trapezoid(mdot_arr, times) if hasattr(np, "trapezoid") else np.trapz(mdot_arr, times)),
        "burn_time_s": float(times[-1] - times[0]) if len(times) > 1 else 0.0,
    }
    
    # =========================================================================
    # Propellant Mass Remaining (Tank Fill Levels)
    # =========================================================================
    # Calculate total propellant consumed per branch
    mdot_O_arr = np.asarray(results["mdot_O"], dtype=float)
    mdot_F_arr = np.asarray(results["mdot_F"], dtype=float)
    if hasattr(np, "trapezoid"):
        total_lox_kg = float(np.trapezoid(mdot_O_arr, times))
        total_fuel_kg = float(np.trapezoid(mdot_F_arr, times))
    else:
        total_lox_kg = float(np.trapz(mdot_O_arr, times))
        total_fuel_kg = float(np.trapz(mdot_F_arr, times))

    # If blowdown mode provided mass history, use it directly
    if lox_mass_kg is not None and len(lox_mass_kg) == len(times):
        result_data["lox_mass_remaining_kg"] = to_float_array(lox_mass_kg).tolist()
    else:
        # Calculate from integrating mass flow (mass remaining = total - cumulative consumed)
        times_arr = np.asarray(times, dtype=float)
        mdot_O_arr_clean = np.nan_to_num(mdot_O_arr, nan=0.0)
        cumulative_O = np.zeros(len(times_arr))
        for i in range(1, len(times_arr)):
            dt = times_arr[i] - times_arr[i - 1]
            cumulative_O[i] = cumulative_O[i - 1] + 0.5 * (mdot_O_arr_clean[i - 1] + mdot_O_arr_clean[i]) * dt
        lox_remaining = total_lox_kg - cumulative_O
        result_data["lox_mass_remaining_kg"] = lox_remaining.tolist()

    if fuel_mass_kg is not None and len(fuel_mass_kg) == len(times):
        result_data["fuel_mass_remaining_kg"] = to_float_array(fuel_mass_kg).tolist()
    else:
        times_arr = np.asarray(times, dtype=float)
        mdot_F_arr_clean = np.nan_to_num(mdot_F_arr, nan=0.0)
        cumulative_F = np.zeros(len(times_arr))
        for i in range(1, len(times_arr)):
            dt = times_arr[i] - times_arr[i - 1]
            cumulative_F[i] = cumulative_F[i - 1] + 0.5 * (mdot_F_arr_clean[i - 1] + mdot_F_arr_clean[i]) * dt
        fuel_remaining = total_fuel_kg - cumulative_F
        result_data["fuel_mass_remaining_kg"] = fuel_remaining.tolist()
    
    # =========================================================================
    # COPV Sizing Analysis - Always run if press_tank config is available
    # AND run_copv is enabled
    # =========================================================================
    copv_results = None
    if run_copv:
        copv_results = _run_copv_analysis(
            runner.config,
            times,
            result_data["mdot_O_kg_s"],
            result_data["mdot_F_kg_s"],
            P_tank_O_psi,
            P_tank_F_psi,
        )
    
    if copv_results:
        # Add COPV pressure trace to result data
        result_data["copv_pressure_psi"] = copv_results["copv_pressure_psi"]
        
        # Add COPV summary metrics
        summary["copv_initial_pressure_psi"] = copv_results["copv_initial_pressure_psi"]
        summary["copv_initial_mass_kg"] = copv_results["copv_initial_mass_kg"]
        summary["copv_min_margin_psi"] = copv_results["copv_min_margin_psi"]
        summary["copv_volume_L"] = copv_results["copv_volume_L"]
    
    # =========================================================================
    # Correlation Matrix - Compute correlations between key variables
    # =========================================================================
    correlation_data = _compute_correlation_matrix(result_data)
    if correlation_data:
        result_data["correlation_matrix"] = correlation_data["matrix"]
        result_data["correlation_labels"] = correlation_data["labels"]
    
    return result_data, summary





def _compute_correlation_matrix(result_data: dict) -> Optional[dict]:
    """Compute correlation matrix for key time-series variables.
    
    Returns dict with 'matrix' (2D list) and 'labels' (list of variable names).
    """
    # Define variables to include in correlation analysis
    # Map from result_data keys to display labels
    variable_map = {
        "P_tank_O_psi": "LOX Tank P",
        "P_tank_F_psi": "Fuel Tank P",
        "Pc_psi": "Chamber P",
        "thrust_kN": "Thrust",
        "Isp_s": "Isp",
        "MR": "O/F Ratio",
        "mdot_O_kg_s": "LOX mdot",
        "mdot_F_kg_s": "Fuel mdot",
        "mdot_total_kg_s": "Total mdot",
        "cstar_actual_m_s": "c*",
        "gamma": "Gamma",
        "copv_pressure_psi": "COPV P",
    }
    
    # Build dataframe with available variables
    df_data = {}
    labels = []
    
    for key, label in variable_map.items():
        if key in result_data and result_data[key] is not None:
            arr = np.asarray(result_data[key], dtype=float)
            if len(arr) > 0 and np.any(np.isfinite(arr)):
                df_data[label] = arr
                labels.append(label)
    
    if len(labels) < 2:
        return None
    
    # Create dataframe and compute correlation
    df = pd.DataFrame(df_data)
    corr = df.corr().fillna(0.0)
    
    # Convert to list format for JSON serialization
    matrix = corr.values.tolist()
    
    return {
        "matrix": matrix,
        "labels": labels,
    }


def _run_copv_analysis(
    config,
    times: np.ndarray,
    mdot_O_kg_s: list,
    mdot_F_kg_s: list,
    P_tank_O_psi: np.ndarray,
    P_tank_F_psi: np.ndarray,
) -> Optional[dict]:
    """Run COPV blowdown analysis using the polytropic N2 solver.
    
    Uses hardcoded defaults per requirements:
    - n = 1.2 (polytropic exponent)
    - T0_K = 300 (initial COPV temp)
    - R = 296.8 (gas constant for N2)
    - Oxidizer gas temp: 250K
    - Fuel gas temp: 293K
    - use_real_gas = True (use Z lookup table)
    
    Returns dict with copv_pressure_psi trace and summary metrics, or None if unavailable.
    """
    # Check if press_tank config is available
    press_tank = getattr(config, 'press_tank', None)
    if press_tank is None:
        return None
    
    # Get COPV free volume from config (default 4.5L)
    free_volume_L = getattr(press_tank, 'free_volume_L', None) or 4.5
    copv_volume_m3 = free_volume_L / 1000.0  # Convert L to m³
    
    # Build dataframe for COPV solver
    df = pd.DataFrame({
        "time": np.asarray(times),
        "mdot_O (kg/s)": np.asarray(mdot_O_kg_s),
        "mdot_F (kg/s)": np.asarray(mdot_F_kg_s),
        "P_tank_O (psi)": np.asarray(P_tank_O_psi),
        "P_tank_F (psi)": np.asarray(P_tank_F_psi),
    })
    
    try:
        # Run COPV solver with hardcoded parameters
        copv_result = size_or_check_copv_for_polytropic_N2(
            df=df,
            config=config,
            n=1.2,  # polytropic exponent
            T0_K=300.0,  # initial COPV temperature
            Tp_K=293.0,  # default propellant gas temp (overridden by branch temps)
            use_real_gas=True,  # use Z lookup table
            n2_Z_csv=N2_Z_LOOKUP_CSV,
            pressurant_R=296.8,  # gas constant for N2
            branch_temperatures_K={
                "oxidizer": 250.0,  # oxidizer gas temp
                "fuel": 293.0,      # fuel gas temp
            },
            copv_volume_m3=copv_volume_m3,
        )
        
        # Extract COPV pressure trace (Pa -> psi)
        PH_trace_Pa = np.asarray(copv_result.get("PH_trace_Pa", []))
        if len(PH_trace_Pa) == 0:
            return None
        
        copv_pressure_psi = (PH_trace_Pa * PA_TO_PSI).tolist()
        
        return {
            "copv_pressure_psi": copv_pressure_psi,
            "copv_initial_pressure_psi": float(copv_result.get("P0_Pa", 0) * PA_TO_PSI),
            "copv_initial_mass_kg": float(copv_result.get("m0_kg", 0)),
            "copv_min_margin_psi": float(copv_result.get("min_margin_Pa", 0) * PA_TO_PSI),
            "copv_volume_L": free_volume_L,
        }
        
    except Exception as e:
        # Log error but don't fail the whole request
        import logging
        logging.warning(f"COPV analysis failed: {e}")
        return None


# Request models for simple profile generation
class ProfileParams(BaseModel):
    """Parameters for a single propellant profile."""
    start_pressure_psi: float = Field(..., gt=0, description="Start pressure in psi")
    end_pressure_psi: float = Field(..., gt=0, description="End pressure in psi")
    profile_type: Literal["linear", "exponential", "power"] = Field(default="linear")
    decay_constant: Optional[float] = Field(default=3.0, ge=0.1, le=10.0)
    power: Optional[float] = Field(default=2.0, ge=0.1, le=5.0)


class GenerateProfileRequest(BaseModel):
    """Request body for simple profile generation."""
    duration_s: float = Field(..., gt=0, le=600, description="Burn duration in seconds")
    n_steps: int = Field(default=101, ge=2, le=2000, description="Number of time steps")
    lox_profile: ProfileParams
    fuel_profile: ProfileParams


class GenerateProfileResponse(BaseModel):
    """Response for profile generation."""
    status: str
    data: dict
    summary: dict


@router.post("/generate", response_model=GenerateProfileResponse)
async def generate_timeseries(request: GenerateProfileRequest):
    """Generate time-series results from simple pressure profiles.
    
    Supports linear, exponential, and power profile types.
    """
    if not app_state.has_config():
        raise HTTPException(
            status_code=400,
            detail="No config loaded. Upload a config file first."
        )
    
    try:
        # Generate LOX profile
        lox_params = {}
        if request.lox_profile.profile_type == "exponential":
            lox_params["decay_constant"] = request.lox_profile.decay_constant
        elif request.lox_profile.profile_type == "power":
            lox_params["power"] = request.lox_profile.power
            
        times, lox_pressures = generate_pressure_profile(
            request.lox_profile.profile_type,
            request.lox_profile.start_pressure_psi,
            request.lox_profile.end_pressure_psi,
            request.duration_s,
            request.n_steps,
            **lox_params,
        )
        
        # Generate Fuel profile
        fuel_params = {}
        if request.fuel_profile.profile_type == "exponential":
            fuel_params["decay_constant"] = request.fuel_profile.decay_constant
        elif request.fuel_profile.profile_type == "power":
            fuel_params["power"] = request.fuel_profile.power
            
        _, fuel_pressures = generate_pressure_profile(
            request.fuel_profile.profile_type,
            request.fuel_profile.start_pressure_psi,
            request.fuel_profile.end_pressure_psi,
            request.duration_s,
            request.n_steps,
            **fuel_params,
        )
        
        # Compute time-series results
        data, summary = compute_timeseries_results(
            app_state.runner,
            times,
            lox_pressures,
            fuel_pressures,
        )
        
        return GenerateProfileResponse(
            status="success",
            data=convert_numpy(data),
            summary=convert_numpy(summary),
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Time-series evaluation failed: {str(e)}"
        )


# Request models for segment-based profiles
class PressureSegment(BaseModel):
    """A single segment of a pressure curve."""
    length_ratio: float = Field(..., ge=0.01, le=1.0, description="Fraction of total time")
    type: Literal["blowdown", "linear"] = Field(default="blowdown")
    start_pressure_psi: float = Field(..., gt=0, description="Start pressure in psi")
    end_pressure_psi: float = Field(..., gt=0, description="End pressure in psi")
    k: float = Field(default=0.5, ge=0.1, le=3.0, description="Blowdown decay constant")


class SegmentsRequest(BaseModel):
    """Request body for segment-based profile generation."""
    duration_s: float = Field(..., gt=0, le=600, description="Burn duration in seconds")
    n_points: int = Field(default=200, ge=10, le=2000, description="Number of time points")
    lox_segments: List[PressureSegment] = Field(default=[], max_length=20)
    fuel_segments: List[PressureSegment] = Field(default=[], max_length=20)
    
    # Blowdown mode parameters
    blowdown_mode: bool = Field(default=False, description="Enable pure blowdown (no COPV regulation)")
    lox_initial_pressure_psi: Optional[float] = Field(default=None, gt=0, description="Initial LOX tank pressure (psi), required for blowdown mode")
    fuel_initial_pressure_psi: Optional[float] = Field(default=None, gt=0, description="Initial fuel tank pressure (psi), required for blowdown mode")


class SegmentsResponse(BaseModel):
    """Response for segment-based profile generation."""
    status: str
    data: dict
    summary: dict
    lox_curve_preview: List[float]
    fuel_curve_preview: List[float]


def segments_to_dict_list(segments: List[PressureSegment]) -> List[dict]:
    """Convert Pydantic segments to dict list for curve generation."""
    result = []
    prev_end = None
    
    for i, seg in enumerate(segments):
        # First segment uses its start pressure; subsequent segments chain from previous end
        if i == 0:
            start_p = seg.start_pressure_psi * PSI_TO_PA
        else:
            start_p = prev_end if prev_end else seg.start_pressure_psi * PSI_TO_PA
        
        end_p = seg.end_pressure_psi * PSI_TO_PA
        
        # Ensure decreasing pressure
        if end_p > start_p:
            end_p = start_p * 0.95
        
        result.append({
            "length_ratio": seg.length_ratio,
            "type": seg.type,
            "start_pressure": start_p,
            "end_pressure": end_p,
            "k": seg.k,
        })
        prev_end = end_p
    
    return result


@router.post("/from-segments", response_model=SegmentsResponse)
async def generate_from_segments(request: SegmentsRequest):
    """Generate time-series results from segment-based pressure curves.
    
    Two modes:
    1. Regulated mode (default): Uses segments to define pressure curves, COPV analysis enabled
    2. Blowdown mode: Simulates pure tank blowdown from initial conditions, ignores segments
    
    Each segment specifies:
    - length_ratio: fraction of total time (0-1)
    - type: 'blowdown' or 'linear'
    - start_pressure_psi: start pressure (auto-chained from previous segment)
    - end_pressure_psi: end pressure
    - k: blowdown decay constant (0.1-3.0)
    
    The blowdown formula: P(t) = P_end + (P_start - P_end) * exp(-k * t_norm)
    """
    if not app_state.has_config():
        raise HTTPException(
            status_code=400,
            detail="No config loaded. Upload a config file first."
        )
    
    # Validate blowdown mode parameters
    if request.blowdown_mode:
        if request.lox_initial_pressure_psi is None:
            raise HTTPException(
                status_code=400,
                detail="lox_initial_pressure_psi is required when blowdown_mode=true"
            )
        if request.fuel_initial_pressure_psi is None:
            raise HTTPException(
                status_code=400,
                detail="fuel_initial_pressure_psi is required when blowdown_mode=true"
            )
    else:
        # Validate regulated mode parameters
        if not request.lox_segments or not request.fuel_segments:
             raise HTTPException(
                status_code=400,
                detail="Segments are required when blowdown_mode=false"
            )
    
    try:
        # Generate time array
        times = np.linspace(0, request.duration_s, request.n_points)
        
        if request.blowdown_mode:
            # ===== BLOWDOWN MODE =====
            # Import coupled blowdown solver
            from copv.blowdown_solver import simulate_coupled_blowdown
            
            # Define engine callback for coupled solver
            def engine_evaluator(P_lox_Pa: float, P_fuel_Pa: float):
                # Run single-point evaluation
                # Note: evaluate returns dict with mdot_O and mdot_F (kg/s)
                try:
                    res = app_state.runner.evaluate(
                        P_tank_O=P_lox_Pa,
                        P_tank_F=P_fuel_Pa,
                        silent=True
                    )
                    return res["mdot_O"], res["mdot_F"]
                except Exception:
                    # If evaluation fails (e.g. pressure too low for CEA), return 0 flow
                    return 0.0, 0.0

            # Run coupled simulation
            blowdown_results = simulate_coupled_blowdown(
                times=times,
                evaluate_engine_fn=engine_evaluator,
                P_lox_initial_Pa=request.lox_initial_pressure_psi * PSI_TO_PA,
                P_fuel_initial_Pa=request.fuel_initial_pressure_psi * PSI_TO_PA,
                config=app_state.runner.config,
                R_pressurant=296.803,  # N2
                T_lox_gas_K=250.0,
                T_fuel_gas_K=293.0,
                n_polytropic=1.2,
                use_real_gas=True,
                n2_Z_csv=N2_Z_LOOKUP_CSV,
            )
            
            # Extract Actual Blowdown Pressures
            lox_curve_pa = blowdown_results["lox"]["P_Pa"]
            fuel_curve_pa = blowdown_results["fuel"]["P_Pa"]
            lox_curve_psi = lox_curve_pa * PA_TO_PSI
            fuel_curve_psi = fuel_curve_pa * PA_TO_PSI
            
            # Extract Propellant Mass History (for flameout masking)
            lox_mass_kg = blowdown_results["lox"]["m_prop_kg"]
            fuel_mass_kg = blowdown_results["fuel"]["m_prop_kg"]
            
            # Run final evaluation with actual blowdown pressures
            data, summary = compute_timeseries_results(
                app_state.runner,
                times,
                lox_curve_psi,
                fuel_curve_psi,
                run_copv=False,  # Skip COPV analysis for efficiency
                lox_mass_kg=lox_mass_kg,
                fuel_mass_kg=fuel_mass_kg,
            )
            
            # (COPV analysis skipped via flag, so no cleanup needed)
            
        else:
            # ===== REGULATED MODE (original behavior) =====
            # Convert segments to dict format
            lox_seg_dicts = segments_to_dict_list(request.lox_segments)
            fuel_seg_dicts = segments_to_dict_list(request.fuel_segments)
            
            # Generate pressure curves from segments (Pa)
            lox_curve_pa = generate_pressure_curve_from_segments(
                lox_seg_dicts,
                n_points=request.n_points,
            )
            fuel_curve_pa = generate_pressure_curve_from_segments(
                fuel_seg_dicts,
                n_points=request.n_points,
            )
            
            # Convert to psi for the API
            lox_curve_psi = lox_curve_pa * PA_TO_PSI
            fuel_curve_psi = fuel_curve_pa * PA_TO_PSI
            
            # Compute time-series results (includes COPV analysis)
            data, summary = compute_timeseries_results(
                app_state.runner,
                times,
                lox_curve_psi,
                fuel_curve_psi,
            )
        
        return SegmentsResponse(
            status="success",
            data=convert_numpy(data),
            summary=convert_numpy(summary),
            lox_curve_preview=lox_curve_psi.tolist(),
            fuel_curve_preview=fuel_curve_psi.tolist(),
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Segment-based evaluation failed: {str(e)}"
        )


# Preview endpoint for real-time curve visualization
class PreviewSegmentsRequest(BaseModel):
    """Request for curve preview without full evaluation."""
    n_points: int = Field(default=100, ge=10, le=500)
    segments: List[PressureSegment] = Field(..., min_length=1, max_length=20)


class PreviewResponse(BaseModel):
    """Response with curve preview data."""
    curve_psi: List[float]
    normalized_time: List[float]


@router.post("/preview-curve", response_model=PreviewResponse)
async def preview_curve(request: PreviewSegmentsRequest):
    """Preview a pressure curve from segments without running full evaluation.
    
    Useful for real-time curve visualization in the UI.
    """
    try:
        seg_dicts = segments_to_dict_list(request.segments)
        curve_pa = generate_pressure_curve_from_segments(
            seg_dicts,
            n_points=request.n_points,
        )
        curve_psi = (curve_pa * PA_TO_PSI).tolist()
        normalized_time = np.linspace(0, 1, request.n_points).tolist()
        
        return PreviewResponse(
            curve_psi=curve_psi,
            normalized_time=normalized_time,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Curve preview failed: {str(e)}"
        )


@router.post("/from-csv", response_model=GenerateProfileResponse)
async def generate_from_csv(file: UploadFile = File(...)):
    """Generate time-series results from uploaded CSV file or YAML config file.
    
    CSV files must contain columns:
    - T (or time): time in seconds
    - P_O (or P_tank_O): LOX tank pressure in psi
    - P_F (or P_tank_F): Fuel tank pressure in psi
    
    YAML config files:
    - Must be a valid PintleEngineConfig
    - If it contains a 'pressure_curves' section, will generate curves from segments
    - Will set the uploaded config as the active session config
    - If time column is missing in CSV, it will be generated with uniform spacing.
    """
    try:
        contents = await file.read()
        filename = file.filename or ""
        
        # Check if it's a YAML config file
        is_yaml = filename.endswith(('.yaml', '.yml'))
        
        if is_yaml:
            # Try to parse as YAML config
            try:
                config_dict = yaml.safe_load(contents.decode("utf-8"))
                config = PintleEngineConfig(**config_dict)
                
                # Check if config has pressure_curves section
                if hasattr(config, 'pressure_curves') and config.pressure_curves is not None:
                    pressure_curves = config.pressure_curves
                    
                    # Extract parameters
                    n_points = pressure_curves.n_points
                    target_burn_time_s = pressure_curves.target_burn_time_s
                    
                    # Convert segments to dict format for curve generation
                    lox_segments = []
                    for seg in pressure_curves.lox_segments:
                        lox_segments.append({
                            "length_ratio": seg.length_ratio,
                            "type": seg.type,
                            "start_pressure": seg.start_pressure_pa,
                            "end_pressure": seg.end_pressure_pa,
                            "k": seg.k or 0.5,
                        })
                    
                    fuel_segments = []
                    for seg in pressure_curves.fuel_segments:
                        fuel_segments.append({
                            "length_ratio": seg.length_ratio,
                            "type": seg.type,
                            "start_pressure": seg.start_pressure_pa,
                            "end_pressure": seg.end_pressure_pa,
                            "k": seg.k or 0.5,
                        })
                    
                    # Generate pressure curves
                    lox_curve_pa = generate_pressure_curve_from_segments(
                        lox_segments,
                        n_points=n_points,
                    )
                    fuel_curve_pa = generate_pressure_curve_from_segments(
                        fuel_segments,
                        n_points=n_points,
                    )
                    
                    # Convert to psi
                    lox_curve_psi = lox_curve_pa * PA_TO_PSI
                    fuel_curve_psi = fuel_curve_pa * PA_TO_PSI
                    
                    # Generate time array
                    times = np.linspace(0, target_burn_time_s, n_points)
                    
                    # Set config as active
                    app_state.set_config(config)
                    
                    # Compute time-series results
                    data, summary = compute_timeseries_results(
                        app_state.runner,
                        times,
                        lox_curve_psi,
                        fuel_curve_psi,
                    )
                    
                    return GenerateProfileResponse(
                        status="success",
                        data=convert_numpy(data),
                        summary=convert_numpy(summary),
                    )
                else:
                    # Config doesn't have pressure_curves, just set it as active
                    app_state.set_config(config)
                    raise HTTPException(
                        status_code=400,
                        detail="Config file does not contain a 'pressure_curves' section. Please upload a config with pressure_curves or use a CSV file."
                    )
                    
            except yaml.YAMLError as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid YAML: {str(e)}"
                )
            except ValidationError as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Config validation error: {str(e)}"
                )
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to process config file: {str(e)}"
                )
        else:
            # Process as CSV file
            if not app_state.has_config():
                raise HTTPException(
                    status_code=400,
                    detail="No config loaded. Upload a config file first."
                )
            
            try:
                df = pd.read_csv(io.BytesIO(contents))
                
                # Normalize column names (case-insensitive, handle variations)
                df.columns = df.columns.str.strip()
                column_map = {}
                for col in df.columns:
                    col_lower = col.lower()
                    if col_lower in ['t', 'time', 'time_s', 'time (s)']:
                        column_map[col] = 'time'
                    elif col_lower in ['p_o', 'p_tank_o', 'p_tank_o_psi', 'lox_pressure', 'lox_pressure_psi']:
                        column_map[col] = 'P_O'
                    elif col_lower in ['p_f', 'p_tank_f', 'p_tank_f_psi', 'fuel_pressure', 'fuel_pressure_psi']:
                        column_map[col] = 'P_F'
                
                # Rename columns
                df = df.rename(columns=column_map)
                
                # Check required columns
                if 'P_O' not in df.columns or 'P_F' not in df.columns:
                    raise HTTPException(
                        status_code=400,
                        detail="CSV must contain columns P_O (or P_tank_O) and P_F (or P_tank_F)"
                    )
                
                # Generate time column if missing
                if 'time' not in df.columns:
                    # Use uniform spacing, default 0.1s
                    n_points = len(df)
                    df['time'] = np.linspace(0, n_points * 0.1, n_points)
                
                # Sort by time
                df = df.sort_values('time').reset_index(drop=True)
                
                # Extract arrays
                times = np.asarray(df['time'], dtype=float)
                P_tank_O_psi = np.asarray(df['P_O'], dtype=float)
                P_tank_F_psi = np.asarray(df['P_F'], dtype=float)
                
                # Validate data
                if len(times) < 2:
                    raise HTTPException(
                        status_code=400,
                        detail="CSV must contain at least 2 data points"
                    )
                
                if np.any(np.isnan(P_tank_O_psi)) or np.any(np.isnan(P_tank_F_psi)):
                    raise HTTPException(
                        status_code=400,
                        detail="Pressure values cannot contain NaN"
                    )
                
                if np.any(P_tank_O_psi <= 0) or np.any(P_tank_F_psi <= 0):
                    raise HTTPException(
                        status_code=400,
                        detail="Pressure values must be positive"
                    )
                
                # Compute time-series results
                data, summary = compute_timeseries_results(
                    app_state.runner,
                    times,
                    P_tank_O_psi,
                    P_tank_F_psi,
                )
                
                return GenerateProfileResponse(
                    status="success",
                    data=convert_numpy(data),
                    summary=convert_numpy(summary),
                )
                
            except HTTPException:
                raise
            except pd.errors.EmptyDataError:
                raise HTTPException(
                    status_code=400,
                    detail="CSV file is empty"
                )
            except pd.errors.ParserError as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"Failed to parse CSV: {str(e)}"
                )
            except Exception as e:
                raise HTTPException(
                    status_code=500,
                    detail=f"Time-series evaluation from CSV failed: {str(e)}"
                )
                
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"File upload failed: {str(e)}"
        )

