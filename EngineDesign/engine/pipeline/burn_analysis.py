"""Comprehensive burn analysis for time-varying engine performance.

This module provides:
1. Performance degradation tracking
2. Ablative geometry evolution
3. Thrust curve analysis
4. Failure prediction
5. Mission performance metrics
"""

from __future__ import annotations

from typing import Dict, List, Tuple, Optional
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig


def analyze_burn_degradation(
    time_history: np.ndarray,
    thrust_history: np.ndarray,
    Pc_history: np.ndarray,
    Isp_history: np.ndarray,
    MR_history: np.ndarray,
    mdot_history: np.ndarray,
    A_throat_history: Optional[np.ndarray] = None,
    recession_history: Optional[np.ndarray] = None,
) -> Dict[str, any]:
    """
    Analyze performance degradation over a burn.
    
    Parameters:
    -----------
    time_history : array
        Time points [s]
    thrust_history : array
        Thrust [N]
    Pc_history : array
        Chamber pressure [Pa]
    Isp_history : array
        Specific impulse [s]
    MR_history : array
        Mixture ratio
    mdot_history : array
        Mass flow rate [kg/s]
    A_throat_history : array, optional
        Throat area evolution [m²]
    recession_history : array, optional
        Cumulative recession [m]
    
    Returns:
    --------
    results : dict
        Degradation metrics and analysis
    """
    if len(time_history) < 2:
        return {"error": "Need at least 2 time points"}
    
    # Initial and final values
    initial = {
        "thrust": float(thrust_history[0]),
        "Pc": float(Pc_history[0]),
        "Isp": float(Isp_history[0]),
        "MR": float(MR_history[0]),
        "mdot": float(mdot_history[0]),
    }
    
    final = {
        "thrust": float(thrust_history[-1]),
        "Pc": float(Pc_history[-1]),
        "Isp": float(Isp_history[-1]),
        "MR": float(MR_history[-1]),
        "mdot": float(mdot_history[-1]),
    }
    
    # Percentage changes
    changes = {
        "thrust_pct": ((final["thrust"] - initial["thrust"]) / initial["thrust"]) * 100.0,
        "Pc_pct": ((final["Pc"] - initial["Pc"]) / initial["Pc"]) * 100.0,
        "Isp_pct": ((final["Isp"] - initial["Isp"]) / initial["Isp"]) * 100.0,
        "MR_pct": ((final["MR"] - initial["MR"]) / initial["MR"]) * 100.0,
        "mdot_pct": ((final["mdot"] - initial["mdot"]) / initial["mdot"]) * 100.0,
    }
    
    # Throat area change
    if A_throat_history is not None and len(A_throat_history) > 0:
        A_throat_initial = float(A_throat_history[0])
        A_throat_final = float(A_throat_history[-1])
        changes["A_throat_pct"] = ((A_throat_final - A_throat_initial) / A_throat_initial) * 100.0
    else:
        changes["A_throat_pct"] = np.nan
    
    # Total impulse
    burn_time = float(time_history[-1] - time_history[0])
    total_impulse = float(np.trapezoid(thrust_history, time_history))  # N·s
    
    # Average performance
    avg_thrust = float(np.mean(thrust_history))
    avg_Pc = float(np.mean(Pc_history))
    avg_Isp = float(np.mean(Isp_history))
    avg_MR = float(np.mean(MR_history))
    avg_mdot = float(np.mean(mdot_history))
    
    # Peak values
    peak_thrust = float(np.max(thrust_history))
    peak_Pc = float(np.max(Pc_history))
    
    # Minimum values
    min_thrust = float(np.min(thrust_history))
    min_Isp = float(np.min(Isp_history))
    
    # Degradation rate (linear fit)
    if len(time_history) > 2:
        # Linear regression for degradation rate
        thrust_slope, thrust_intercept = np.polyfit(time_history, thrust_history, 1)
        Pc_slope, Pc_intercept = np.polyfit(time_history, Pc_history, 1)
        degradation_rates = {
            "thrust_rate": float(thrust_slope),  # N/s
            "Pc_rate": float(Pc_slope),  # Pa/s
        }
    else:
        degradation_rates = {
            "thrust_rate": 0.0,
            "Pc_rate": 0.0,
        }
    
    # Recession analysis
    recession_analysis = {}
    if recession_history is not None and len(recession_history) > 0:
        total_recession = float(recession_history[-1] - recession_history[0])
        avg_recession_rate = total_recession / burn_time if burn_time > 0 else 0.0
        recession_analysis = {
            "total_recession": float(total_recession),
            "avg_recession_rate": float(avg_recession_rate),
            "recession_rate_units": "m/s",
        }
    
    # Failure prediction (simplified)
    # Predict when thrust drops below threshold or geometry limits exceeded
    failure_analysis = {
        "thrust_drop_50pct_time": None,  # Time when thrust drops 50%
        "thrust_drop_80pct_time": None,  # Time when thrust drops 80%
        "geometry_limit_exceeded": False,
    }
    
    if len(time_history) > 2:
        thrust_50pct = initial["thrust"] * 0.5
        thrust_80pct = initial["thrust"] * 0.8
        
        # Find when thresholds crossed
        for i, thrust in enumerate(thrust_history):
            if thrust < thrust_50pct and failure_analysis["thrust_drop_50pct_time"] is None:
                failure_analysis["thrust_drop_50pct_time"] = float(time_history[i])
            if thrust < thrust_80pct and failure_analysis["thrust_drop_80pct_time"] is None:
                failure_analysis["thrust_drop_80pct_time"] = float(time_history[i])
    
    # Check geometry limits (if throat area grows too much)
    if A_throat_history is not None:
        A_throat_growth = (A_throat_history[-1] / A_throat_history[0] - 1.0) * 100.0
        if A_throat_growth > 20.0:  # More than 20% growth
            failure_analysis["geometry_limit_exceeded"] = True
    
    return {
        "burn_time": float(burn_time),
        "total_impulse": float(total_impulse),
        "initial": initial,
        "final": final,
        "changes": changes,
        "average": {
            "thrust": avg_thrust,
            "Pc": avg_Pc,
            "Isp": avg_Isp,
            "MR": avg_MR,
            "mdot": avg_mdot,
        },
        "peak": {
            "thrust": peak_thrust,
            "Pc": peak_Pc,
        },
        "minimum": {
            "thrust": min_thrust,
            "Isp": min_Isp,
        },
        "degradation_rates": degradation_rates,
        "recession_analysis": recession_analysis,
        "failure_analysis": failure_analysis,
    }


def calculate_mission_performance(
    time_history: np.ndarray,
    thrust_history: np.ndarray,
    mdot_history: np.ndarray,
    altitude_history: Optional[np.ndarray] = None,
    target_altitude: Optional[float] = None,
) -> Dict[str, any]:
    """
    Calculate mission performance metrics.
    
    Parameters:
    -----------
    time_history : array
        Time points [s]
    thrust_history : array
        Thrust [N]
    mdot_history : array
        Mass flow rate [kg/s]
    altitude_history : array, optional
        Altitude [m] (for altitude-specific analysis)
    target_altitude : float, optional
        Target altitude [m]
    
    Returns:
    --------
    results : dict
        Mission performance metrics
    """
    burn_time = float(time_history[-1] - time_history[0])
    
    # Total impulse
    total_impulse = float(np.trapezoid(thrust_history, time_history))  # N·s
    
    # Total propellant consumed
    total_propellant = float(np.trapezoid(mdot_history, time_history))  # kg
    
    # Average thrust
    avg_thrust = float(np.mean(thrust_history))
    
    # Thrust-to-weight ratio (requires vehicle mass - placeholder)
    # TWR = thrust / (mass × g)
    # This would need vehicle mass as input
    
    # Specific impulse (time-averaged)
    if total_propellant > 0:
        avg_Isp = total_impulse / (total_propellant * 9.80665)
    else:
        avg_Isp = 0.0
    
    # Thrust coefficient (time-averaged, simplified)
    # Would need Pc and At for accurate calculation
    
    results = {
        "burn_time": float(burn_time),
        "total_impulse": float(total_impulse),
        "total_propellant": float(total_propellant),
        "avg_thrust": float(avg_thrust),
        "avg_Isp": float(avg_Isp),
    }
    
    # Altitude-specific analysis
    if altitude_history is not None and len(altitude_history) == len(time_history):
        results["altitude_gained"] = float(altitude_history[-1] - altitude_history[0])
        results["max_altitude"] = float(np.max(altitude_history))
        
        if target_altitude is not None:
            results["target_reached"] = results["max_altitude"] >= target_altitude
            results["altitude_margin"] = results["max_altitude"] - target_altitude
    
    return results


def predict_burnout_time(
    time_history: np.ndarray,
    thrust_history: np.ndarray,
    mdot_history: np.ndarray,
    propellant_mass_remaining: float,
    threshold_thrust: Optional[float] = None,
) -> Dict[str, any]:
    """
    Predict when engine will burn out (propellant depletion or thrust threshold).
    
    Parameters:
    -----------
    time_history : array
        Time points [s]
    thrust_history : array
        Thrust [N]
    mdot_history : array
        Mass flow rate [kg/s]
    propellant_mass_remaining : float
        Remaining propellant mass [kg]
    threshold_thrust : float, optional
        Thrust threshold for "burnout" [N]
    
    Returns:
    --------
    results : dict
        Burnout predictions
    """
    current_time = float(time_history[-1])
    current_mdot = float(mdot_history[-1])
    
    # Propellant depletion time
    if current_mdot > 0:
        time_to_depletion = propellant_mass_remaining / current_mdot
        depletion_time = current_time + time_to_depletion
    else:
        time_to_depletion = np.inf
        depletion_time = np.inf
    
    # Thrust threshold burnout
    if threshold_thrust is not None:
        current_thrust = float(thrust_history[-1])
        
        if current_thrust <= threshold_thrust:
            threshold_time = current_time
            time_to_threshold = 0.0
        else:
            # Extrapolate using degradation rate
            if len(time_history) > 2:
                # Linear fit
                slope, intercept = np.polyfit(time_history[-10:], thrust_history[-10:], 1)
                if slope < 0:  # Degrading
                    time_to_threshold = (threshold_thrust - intercept) / slope - current_time
                    threshold_time = current_time + time_to_threshold
                else:
                    threshold_time = np.inf
                    time_to_threshold = np.inf
            else:
                threshold_time = np.inf
                time_to_threshold = np.inf
    else:
        threshold_time = np.nan
        time_to_threshold = np.nan
    
    # Use whichever comes first
    if threshold_thrust is not None and not np.isnan(threshold_time):
        burnout_time = min(depletion_time, threshold_time)
        burnout_type = "threshold" if threshold_time < depletion_time else "depletion"
    else:
        burnout_time = depletion_time
        burnout_type = "depletion"
    
    return {
        "burnout_time": float(burnout_time),
        "burnout_type": burnout_type,
        "time_to_burnout": float(burnout_time - current_time),
        "depletion_time": float(depletion_time),
        "time_to_depletion": float(time_to_depletion),
        "threshold_time": float(threshold_time) if threshold_thrust is not None else np.nan,
        "time_to_threshold": float(time_to_threshold) if threshold_thrust is not None else np.nan,
    }


def generate_burn_report(
    time_history: np.ndarray,
    results_dict: Dict[str, np.ndarray],
    config: PintleEngineConfig,
) -> str:
    """
    Generate a comprehensive text report of burn analysis.
    
    Parameters:
    -----------
    time_history : array
        Time points [s]
    results_dict : dict
        Results dictionary from evaluate_arrays_with_time
    config : PintleEngineConfig
        Engine configuration
    
    Returns:
    --------
    report : str
        Formatted text report
    """
    degradation = analyze_burn_degradation(
        time_history,
        results_dict.get("F", np.zeros_like(time_history)),
        results_dict.get("Pc", np.zeros_like(time_history)),
        results_dict.get("Isp", np.zeros_like(time_history)),
        results_dict.get("MR", np.zeros_like(time_history)),
        results_dict.get("mdot_total", np.zeros_like(time_history)),
        results_dict.get("A_throat", None),
        results_dict.get("recession_throat", None),
    )
    
    mission = calculate_mission_performance(
        time_history,
        results_dict.get("F", np.zeros_like(time_history)),
        results_dict.get("mdot_total", np.zeros_like(time_history)),
    )
    
    report_lines = [
        "=" * 80,
        "BURN ANALYSIS REPORT",
        "=" * 80,
        "",
        f"Burn Duration: {degradation['burn_time']:.2f} s",
        f"Total Impulse: {mission['total_impulse']/1000:.2f} kN·s",
        f"Total Propellant: {mission['total_propellant']:.2f} kg",
        "",
        "PERFORMANCE SUMMARY:",
        f"  Initial Thrust: {degradation['initial']['thrust']/1000:.2f} kN",
        f"  Final Thrust:   {degradation['final']['thrust']/1000:.2f} kN",
        f"  Change:         {degradation['changes']['thrust_pct']:+.2f}%",
        "",
        f"  Initial Isp:   {degradation['initial']['Isp']:.1f} s",
        f"  Final Isp:     {degradation['final']['Isp']:.1f} s",
        f"  Change:         {degradation['changes']['Isp_pct']:+.2f}%",
        "",
        f"  Initial Pc:    {degradation['initial']['Pc']/1e6:.2f} MPa",
        f"  Final Pc:      {degradation['final']['Pc']/1e6:.2f} MPa",
        f"  Change:         {degradation['changes']['Pc_pct']:+.2f}%",
        "",
    ]
    
    if not np.isnan(degradation['changes'].get('A_throat_pct', np.nan)):
        report_lines.append(
            f"  Throat Area Growth: {degradation['changes']['A_throat_pct']:+.2f}%"
        )
    
    if degradation['recession_analysis']:
        report_lines.extend([
            "",
            "ABLATIVE RECESSION:",
            f"  Total Recession: {degradation['recession_analysis']['total_recession']*1e6:.2f} µm",
            f"  Avg Rate:       {degradation['recession_analysis']['avg_recession_rate']*1e6:.3f} µm/s",
        ])
    
    report_lines.extend([
        "",
        "DEGRADATION RATES:",
        f"  Thrust: {degradation['degradation_rates']['thrust_rate']:.2f} N/s",
        f"  Pc:     {degradation['degradation_rates']['Pc_rate']/1e3:.2f} kPa/s",
    ])
    
    if degradation['failure_analysis']['thrust_drop_50pct_time']:
        report_lines.append(
            f"\n⚠️  Thrust dropped 50% at t = {degradation['failure_analysis']['thrust_drop_50pct_time']:.2f} s"
        )
    
    report_lines.append("\n" + "=" * 80)
    
    return "\n".join(report_lines)

