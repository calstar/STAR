"""Iterative auto-sizing for ablative and graphite based on time series results.

This module runs time series analysis, checks results, and recursively updates
config until sizing is good enough.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple, Callable
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig, AblativeCoolingConfig, GraphiteInsertConfig
from engine.pipeline.time_varying_solver import TimeVaryingCoupledSolver, TimeVaryingState


def check_sizing_requirements(
    state_history: List[TimeVaryingState],
    config: PintleEngineConfig,
) -> Dict[str, any]:
    """
    Check if current sizing meets requirements.
    
    Requirements:
    - Ablative: sufficient thickness remaining at end of burn
    - Graphite: sufficient thickness remaining, throat area stable
    - No melting: wall temperatures within limits
    - Performance: acceptable Isp/thrust degradation
    
    Parameters:
    -----------
    state_history : List[TimeVaryingState]
        Time series state history
    config : PintleEngineConfig
        Current configuration
    
    Returns:
    --------
    check_results : dict
        - meets_requirements: bool
        - ablative_ok: bool
        - graphite_ok: bool
        - issues: List[str] - List of issues found
        - recommendations: Dict[str, float] - Recommended thickness adjustments
    """
    if len(state_history) == 0:
        return {
            "meets_requirements": False,
            "ablative_ok": False,
            "graphite_ok": False,
            "issues": ["No state history"],
            "recommendations": {},
        }
    
    final_state = state_history[-1]
    initial_state = state_history[0]
    
    issues = []
    recommendations = {}
    
    # Check ablative
    ablative_ok = True
    if config.ablative_cooling and config.ablative_cooling.enabled:
        initial_thickness = config.ablative_cooling.initial_thickness
        final_recession = final_state.recession_chamber
        remaining_thickness = initial_thickness - final_recession
        
        # Require at least 20% remaining thickness
        min_remaining_fraction = 0.2
        if remaining_thickness < initial_thickness * min_remaining_fraction:
            ablative_ok = False
            issues.append(f"Ablative: Only {remaining_thickness*1000:.1f} mm remaining ({remaining_thickness/initial_thickness*100:.1f}%), need at least {min_remaining_fraction*100:.0f}%")
            # Recommend increasing thickness
            recommended_thickness = final_recession / (1.0 - min_remaining_fraction) * 1.1  # 10% safety margin
            recommendations["ablative_thickness"] = recommended_thickness
        else:
            recommendations["ablative_thickness"] = initial_thickness  # Keep current
    
    # Check graphite
    graphite_ok = True
    if config.graphite_insert and config.graphite_insert.enabled:
        initial_thickness = config.graphite_insert.initial_thickness
        final_recession = final_state.recession_graphite
        remaining_thickness = initial_thickness - final_recession
        
        # Require at least 30% remaining thickness (graphite is critical)
        min_remaining_fraction = 0.3
        if remaining_thickness < initial_thickness * min_remaining_fraction:
            graphite_ok = False
            issues.append(f"Graphite: Only {remaining_thickness*1000:.1f} mm remaining ({remaining_thickness/initial_thickness*100:.1f}%), need at least {min_remaining_fraction*100:.0f}%")
            recommended_thickness = final_recession / (1.0 - min_remaining_fraction) * 1.15  # 15% safety margin
            recommendations["graphite_thickness"] = recommended_thickness
        else:
            recommendations["graphite_thickness"] = initial_thickness
        
        # Check throat area stability
        initial_area = initial_state.A_throat
        final_area = final_state.A_throat
        area_change_pct = abs(final_area - initial_area) / initial_area * 100.0
        
        # Require throat area change < 3%
        if area_change_pct > 3.0:
            graphite_ok = False
            issues.append(f"Graphite: Throat area changed by {area_change_pct:.2f}%, need < 3%")
            # Already recommended thickness increase above
    
    # Check performance degradation
    initial_isp = initial_state.Isp
    final_isp = final_state.Isp
    isp_degradation = (initial_isp - final_isp) / initial_isp * 100.0
    
    # Require Isp degradation < 5%
    if isp_degradation > 5.0:
        issues.append(f"Performance: Isp degraded by {isp_degradation:.2f}%, need < 5%")
        # This could be due to ablative or graphite issues
    
    meets_requirements = ablative_ok and graphite_ok and len(issues) == 0
    
    return {
        "meets_requirements": meets_requirements,
        "ablative_ok": ablative_ok,
        "graphite_ok": graphite_ok,
        "issues": issues,
        "recommendations": recommendations,
        "final_recession_ablative": final_state.recession_chamber if config.ablative_cooling and config.ablative_cooling.enabled else 0.0,
        "final_recession_graphite": final_state.recession_graphite if config.graphite_insert and config.graphite_insert.enabled else 0.0,
        "isp_degradation": isp_degradation,
    }


def update_config_from_recommendations(
    config: PintleEngineConfig,
    recommendations: Dict[str, float],
) -> PintleEngineConfig:
    """
    Update config with recommended thickness values.
    
    Parameters:
    -----------
    config : PintleEngineConfig
        Current configuration
    recommendations : Dict[str, float]
        Recommended thickness values
    
    Returns:
    --------
    updated_config : PintleEngineConfig
        Updated configuration
    """
    import copy
    updated_config = copy.deepcopy(config)
    
    # Update ablative thickness
    if "ablative_thickness" in recommendations and updated_config.ablative_cooling:
        updated_config.ablative_cooling.initial_thickness = recommendations["ablative_thickness"]
    
    # Update graphite thickness
    if "graphite_thickness" in recommendations and updated_config.graphite_insert:
        updated_config.graphite_insert.initial_thickness = recommendations["graphite_thickness"]
    
    return updated_config


def iterative_size_ablative_graphite(
    base_config: PintleEngineConfig,
    time_series: np.ndarray,
    P_tank_O: np.ndarray,
    P_tank_F: np.ndarray,
    max_iterations: int = 10,
    convergence_tolerance: float = 0.05,  # 5% thickness change
    callback: Optional[Callable[[int, PintleEngineConfig, Dict], None]] = None,
) -> Tuple[PintleEngineConfig, List[Dict]]:
    """
    Iteratively size ablative and graphite based on time series results.
    
    Algorithm:
    1. Run time series with current config
    2. Check if sizing meets requirements
    3. If not, update thickness based on recommendations
    4. Repeat until convergence or max iterations
    
    Parameters:
    -----------
    base_config : PintleEngineConfig
        Base configuration to start from
    time_series : np.ndarray
        Time array [s]
    P_tank_O : np.ndarray
        Oxidizer tank pressure [Pa]
    P_tank_F : np.ndarray
        Fuel tank pressure [Pa]
    max_iterations : int
        Maximum number of iterations
    convergence_tolerance : float
        Thickness change tolerance for convergence
    callback : Callable, optional
        Callback function(iteration, config, check_results) called each iteration
    
    Returns:
    --------
    final_config : PintleEngineConfig
        Final sized configuration
    iteration_history : List[Dict]
        History of each iteration (config, results, check_results)
    """
    from engine.core.runner import PintleEngineRunner
    
    current_config = base_config
    iteration_history = []
    
    for iteration in range(max_iterations):
        # Run time series using the coupled solver
        runner = PintleEngineRunner(current_config)
        solver = TimeVaryingCoupledSolver(current_config, runner.cea_cache)
        states = solver.solve_time_series(time_series, P_tank_O, P_tank_F)
        results = {"state_history": states, **solver.get_results_dict()}
        
        # Check requirements
        check_results = check_sizing_requirements(results["state_history"], current_config)
        
        # Store iteration history
        iteration_history.append({
            "iteration": iteration,
            "config": current_config,
            "results": results,
            "check_results": check_results,
        })
        
        # Callback
        if callback:
            callback(iteration, current_config, check_results)
        
        # Check if requirements met
        if check_results["meets_requirements"]:
            break
        
        # Check convergence
        if iteration > 0:
            prev_config = iteration_history[-2]["config"]
            thickness_changed = False
            
            if current_config.ablative_cooling and prev_config.ablative_cooling:
                ablative_change = abs(
                    current_config.ablative_cooling.initial_thickness - 
                    prev_config.ablative_cooling.initial_thickness
                ) / prev_config.ablative_cooling.initial_thickness
                if ablative_change < convergence_tolerance:
                    thickness_changed = True
            
            if current_config.graphite_insert and prev_config.graphite_insert:
                graphite_change = abs(
                    current_config.graphite_insert.initial_thickness - 
                    prev_config.graphite_insert.initial_thickness
                ) / prev_config.graphite_insert.initial_thickness
                if graphite_change < convergence_tolerance:
                    thickness_changed = True
            
            if thickness_changed and iteration > 2:
                # Converged but not meeting requirements - might be infeasible
                break
        
        # Update config with recommendations
        if "recommendations" in check_results and len(check_results["recommendations"]) > 0:
            current_config = update_config_from_recommendations(current_config, check_results["recommendations"])
        else:
            # No recommendations - might be other issues
            break
    
    return current_config, iteration_history

