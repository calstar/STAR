"""Coupled optimizer for pintle injector and chamber geometry.

This module solves the two-way coupling problem:
- Pintle geometry affects chamber performance (spray quality, mixing, efficiency)
- Chamber geometry affects pintle performance (pressure, flow rates, stability)

The optimizer iterates between pintle and chamber optimization until convergence.
"""

from __future__ import annotations

from typing import Dict, Any, Optional, List, Tuple
import numpy as np
from scipy.optimize import minimize, Bounds
import copy

from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.runner import PintleEngineRunner
from engine.pipeline.chamber_optimizer import ChamberOptimizer
from engine.pipeline.comprehensive_optimizer import ComprehensivePintleOptimizer


class CoupledPintleChamberOptimizer:
    """
    Coupled optimizer that iteratively solves pintle and chamber optimization.
    
    The optimization problem is:
    - Pintle geometry → affects chamber pressure, efficiency, stability
    - Chamber geometry → affects pintle flow rates, pressure drops, spray
    
    Solution approach:
    1. Initialize with initial guesses
    2. Optimize pintle (with current chamber geometry)
    3. Optimize chamber (with current pintle geometry)
    4. Check convergence (geometry changes < tolerance)
    5. Repeat until converged
    """
    
    def __init__(self, base_config: PintleEngineConfig):
        self.base_config = base_config
        self.pintle_optimizer = ComprehensivePintleOptimizer(base_config)
        self.chamber_optimizer = ChamberOptimizer(base_config)
        self.iteration_history = []
    
    def optimize_coupled(
        self,
        design_requirements: Dict[str, Any],
        constraints: Dict[str, Any],
        max_iterations: int = 10,
        convergence_tolerance: float = 0.01,
        use_time_varying: bool = True,  # NEW: Optimize across entire burn time
    ) -> Dict[str, Any]:
        """
        Optimize pintle and chamber geometry with full coupling.
        
        Parameters:
        -----------
        design_requirements : dict
            - target_thrust: float [N]
            - target_burn_time: float [s]
            - target_stability_margin: float
            - P_tank_O: float [Pa]
            - P_tank_F: float [Pa]
            - target_Isp: Optional[float] [s]
        
        constraints : dict
            - max_chamber_length: float [m]
            - max_chamber_diameter: float [m]
            - min_Lstar: float [m]
            - max_Lstar: float [m]
            - min_expansion_ratio: float
            - max_expansion_ratio: float
            - max_engine_weight: Optional[float] [kg]
            - max_vehicle_length: Optional[float] [m]
            - max_vehicle_diameter: Optional[float] [m]
        
        max_iterations : int
            Maximum number of coupling iterations
        
        convergence_tolerance : float
            Relative change tolerance for convergence (e.g., 0.01 = 1%)
        
        use_time_varying : bool
            If True, optimize chamber across entire burn time (accounts for ablative recession)
            If False, optimize at t=0 only
        
        Returns:
        --------
        results : dict
            - optimized_config: PintleEngineConfig
            - iteration_history: List of iteration results
            - convergence_info: Dict with convergence status
            - performance: Final performance metrics
        """
        current_config = copy.deepcopy(self.base_config)
        iteration_history = []
        
        P_tank_O = design_requirements["P_tank_O"]
        P_tank_F = design_requirements["P_tank_F"]
        target_thrust = design_requirements["target_thrust"]
        target_burn_time = design_requirements.get("target_burn_time", 10.0)
        
        # Track previous geometry for convergence
        prev_pintle_params = None
        prev_chamber_params = None
        
        # Track time-varying results from the last successful optimization
        last_time_varying_results = None
        last_time_varying_summary = None
        
        for iteration in range(max_iterations):
            iteration_result = {
                "iteration": iteration,
                "pintle_config": None,
                "chamber_config": None,
                "performance": None,
                "convergence": None,
            }
            
            # Step 1: Optimize pintle geometry (with current chamber)
            try:
                pintle_results = self.pintle_optimizer.optimize_pintle_geometry(
                    target_thrust=target_thrust,
                    target_isp=design_requirements.get("target_Isp", None),
                    target_mr=current_config.combustion.MR if hasattr(current_config.combustion, 'MR') else 2.5,
                    P_tank_O=P_tank_O,
                    P_tank_F=P_tank_F,
                    constraints=constraints,
                )
                
                # Update config with optimized pintle
                current_config = pintle_results["optimized_config"]
                iteration_result["pintle_config"] = self._extract_pintle_params(current_config)
                iteration_result["pintle_performance"] = pintle_results["performance"]
                
            except Exception as e:
                import warnings
                warnings.warn(f"Pintle optimization failed at iteration {iteration}: {e}")
                # Continue with current config
                iteration_result["pintle_config"] = self._extract_pintle_params(current_config)
            
            # Step 2: Optimize chamber geometry (with current pintle)
            # CRITICAL: Use time-varying optimization if enabled
            try:
                chamber_design_reqs = {
                    "target_thrust": target_thrust,
                    "target_burn_time": target_burn_time,
                    "target_stability_margin": design_requirements.get("target_stability_margin", 1.2),
                    "P_tank_O": P_tank_O,
                    "P_tank_F": P_tank_F,
                    "target_Isp": design_requirements.get("target_Isp", None),
                }
                
                # Update chamber optimizer with current config
                self.chamber_optimizer.base_config = current_config
                self.chamber_optimizer.runner = PintleEngineRunner(current_config)
                
                # Run chamber optimization (with time-varying if enabled)
                if use_time_varying:
                    chamber_results = self._optimize_chamber_time_varying(
                        current_config,
                        chamber_design_reqs,
                        constraints,
                        target_burn_time,
                        P_tank_O,
                        P_tank_F,
                    )
                else:
                    chamber_results = self.chamber_optimizer.optimize(
                        chamber_design_reqs,
                        constraints,
                    )
                
                # Update config with optimized chamber
                current_config = chamber_results["optimized_config"]
                iteration_result["chamber_config"] = self._extract_chamber_params(current_config)
                iteration_result["chamber_performance"] = chamber_results["performance"]
                
                # Preserve time-varying results if available (from _optimize_chamber_time_varying)
                if "time_varying_results" in chamber_results:
                    last_time_varying_results = chamber_results["time_varying_results"]
                if "performance" in chamber_results and "time_varying" in chamber_results["performance"]:
                    last_time_varying_summary = chamber_results["performance"]["time_varying"]
                
            except Exception as e:
                import warnings
                warnings.warn(f"Chamber optimization failed at iteration {iteration}: {e}")
                iteration_result["chamber_config"] = self._extract_chamber_params(current_config)
            
            # Step 3: Evaluate final performance
            # Use chamber performance which includes time_varying data, augment with single-point eval
            try:
                runner = PintleEngineRunner(current_config)
                final_performance = runner.evaluate(P_tank_O, P_tank_F)
                
                # Merge with chamber performance to preserve time_varying data
                if iteration_result.get("chamber_performance"):
                    merged_performance = dict(iteration_result["chamber_performance"])
                    # Update with single-point values but keep time_varying from chamber optimization
                    for key, value in final_performance.items():
                        if key != "time_varying":  # Don't overwrite time_varying
                            merged_performance[key] = value
                    iteration_result["performance"] = merged_performance
                else:
                    iteration_result["performance"] = final_performance
            except Exception as e:
                import warnings
                warnings.warn(f"Performance evaluation failed at iteration {iteration}: {e}")
            
            # Step 4: Check convergence
            current_pintle = self._extract_pintle_params(current_config)
            current_chamber = self._extract_chamber_params(current_config)
            
            if prev_pintle_params is not None and prev_chamber_params is not None:
                # Calculate relative changes
                pintle_change = self._calculate_relative_change(prev_pintle_params, current_pintle)
                chamber_change = self._calculate_relative_change(prev_chamber_params, current_chamber)
                max_change = max(pintle_change, chamber_change)
                
                iteration_result["convergence"] = {
                    "pintle_change": pintle_change,
                    "chamber_change": chamber_change,
                    "max_change": max_change,
                    "converged": max_change < convergence_tolerance,
                }
                
                if max_change < convergence_tolerance:
                    # Converged!
                    iteration_result["converged"] = True
                    iteration_history.append(iteration_result)
                    break
            else:
                iteration_result["convergence"] = {
                    "pintle_change": np.inf,
                    "chamber_change": np.inf,
                    "max_change": np.inf,
                    "converged": False,
                }
            
            prev_pintle_params = current_pintle
            prev_chamber_params = current_chamber
            iteration_history.append(iteration_result)
        
        # Final evaluation
        runner = PintleEngineRunner(current_config)
        final_performance = runner.evaluate(P_tank_O, P_tank_F)
        
        # Include time-varying summary in final performance if available
        if last_time_varying_summary is not None:
            final_performance["time_varying"] = last_time_varying_summary
        
        result = {
            "optimized_config": current_config,
            "iteration_history": iteration_history,
            "convergence_info": {
                "converged": iteration_history[-1]["convergence"]["converged"] if iteration_history else False,
                "iterations": len(iteration_history),
                "final_change": iteration_history[-1]["convergence"]["max_change"] if iteration_history else np.inf,
            },
            "performance": final_performance,
            "design_requirements": design_requirements,
            "constraints": constraints,
        }
        
        # Include time-varying results (array data) if available for plotting
        if last_time_varying_results is not None:
            result["time_varying_results"] = last_time_varying_results
        
        return result
    
    def _optimize_chamber_time_varying(
        self,
        config: PintleEngineConfig,
        design_requirements: Dict[str, Any],
        constraints: Dict[str, Any],
        burn_time: float,
        P_tank_O: float,
        P_tank_F: float,
    ) -> Dict[str, Any]:
        """
        Optimize chamber geometry across entire burn time.
        
        This accounts for:
        - Ablative recession (chamber volume grows, throat area grows)
        - Graphite recession (throat area may grow if graphite erodes)
        - Time-varying Cf (thrust coefficient changes with geometry)
        - Time-varying efficiency (L* changes affect combustion efficiency)
        
        Objective: Minimize error in average thrust over burn time
        """
        target_thrust = design_requirements["target_thrust"]
        target_stability_margin = design_requirements.get("target_stability_margin", 1.2)
        
        # Optimization variables: [A_throat, A_exit, Lstar, chamber_diameter]
        # Generate initial guess
        initial_guess = self.chamber_optimizer._generate_initial_guess(target_thrust, constraints)
        x0 = np.array([
            initial_guess["A_throat"],
            initial_guess["A_exit"],
            initial_guess["Lstar"],
            initial_guess.get("chamber_diameter", 0.1),
        ])
        
        # Set up bounds
        bounds = self.chamber_optimizer._setup_bounds(constraints, initial_guess)
        
        # Optimization history
        history = []
        
        def objective_time_varying(x: np.ndarray) -> float:
            """Minimize error in average thrust over entire burn time."""
            try:
                # Update config with current geometry
                config_current = self.chamber_optimizer._update_config_from_x(x, config)
                
                # Run time-varying analysis
                runner = PintleEngineRunner(config_current)
                
                # Time array for burn analysis
                n_time_points = 50  # Enough resolution
                time_array = np.linspace(0.0, burn_time, n_time_points)
                P_tank_O_array = np.full_like(time_array, P_tank_O)
                P_tank_F_array = np.full_like(time_array, P_tank_F)
                
                # Evaluate with time-varying solver (includes ablative recession)
                results_array = runner.evaluate_arrays_with_time(
                    time_array,
                    P_tank_O_array,
                    P_tank_F_array,
                    track_ablative_geometry=True,  # Enable ablative tracking
                    use_coupled_solver=True,  # Use fully-coupled solver
                )
                
                # Calculate average thrust over burn time
                thrust_array = results_array["F"]
                avg_thrust = np.mean(thrust_array)
                
                # Calculate thrust error (minimize deviation from target)
                thrust_error = abs(avg_thrust - target_thrust) / target_thrust
                
                # Calculate stability margin (worst case over burn time)
                stability_margins = results_array.get("chugging_stability_margin", np.array([1.0]))
                min_stability = np.min(stability_margins)
                stability_error = max(0.0, target_stability_margin - min_stability) / target_stability_margin
                
                # Penalty for large thrust variation (want steady performance)
                thrust_std = np.std(thrust_array)
                thrust_variation_penalty = (thrust_std / avg_thrust) if avg_thrust > 0 else 1.0
                
                # Combined objective
                objective_value = (
                    10.0 * thrust_error +  # Thrust is most important
                    5.0 * stability_error +  # Stability must be maintained
                    2.0 * thrust_variation_penalty  # Penalize large variations
                )
                
                # Store history
                history.append({
                    "x": x.copy(),
                    "avg_thrust": avg_thrust,
                    "thrust_error": thrust_error,
                    "stability_error": stability_error,
                    "thrust_variation": thrust_std,
                    "objective": objective_value,
                })
                
                return objective_value
                
            except Exception as e:
                import warnings
                warnings.warn(f"Time-varying objective evaluation failed: {e}")
                return 1e6
        
        # Set up constraints (same as regular optimizer)
        constraints_list = self.chamber_optimizer._setup_constraints(
            constraints, design_requirements, P_tank_O, P_tank_F
        )
        
        # Run optimization
        result = minimize(
            objective_time_varying,
            x0,
            method="SLSQP",
            bounds=bounds,
            constraints=constraints_list,
            options={"maxiter": 100, "ftol": 1e-6},
        )
        
        # Extract optimized configuration
        optimized_config = self.chamber_optimizer._update_config_from_x(result.x, config)
        optimized_runner = PintleEngineRunner(optimized_config)
        
        # Final time-varying evaluation
        time_array = np.linspace(0.0, burn_time, 100)
        P_tank_O_array = np.full_like(time_array, P_tank_O)
        P_tank_F_array = np.full_like(time_array, P_tank_F)
        
        final_results_array = optimized_runner.evaluate_arrays_with_time(
            time_array,
            P_tank_O_array,
            P_tank_F_array,
            track_ablative_geometry=True,
            use_coupled_solver=True,
        )
        
        # Calculate final performance metrics
        final_results = optimized_runner.evaluate(P_tank_O, P_tank_F)
        
        # Add time-varying metrics
        final_results["time_varying"] = {
            "avg_thrust": float(np.mean(final_results_array["F"])),
            "min_thrust": float(np.min(final_results_array["F"])),
            "max_thrust": float(np.max(final_results_array["F"])),
            "thrust_std": float(np.std(final_results_array["F"])),
            "avg_isp": float(np.mean(final_results_array["Isp"])),
            "min_stability_margin": float(np.min(final_results_array.get("chugging_stability_margin", [1.0]))),
            "max_recession_chamber": float(np.max(final_results_array.get("recession_chamber", [0.0]))),
            "max_recession_throat": float(np.max(final_results_array.get("recession_throat", [0.0]))),
        }
        
        return {
            "optimized_config": optimized_config,
            "optimization_result": result,
            "performance": final_results,
            "convergence_history": history,
            "time_varying_results": final_results_array,
        }
    
    def _extract_pintle_params(self, config: PintleEngineConfig) -> Dict[str, float]:
        """Extract pintle geometry parameters for convergence checking."""
        params = {}
        if hasattr(config, 'injector') and config.injector.type == "pintle":
            geometry = config.injector.geometry
            if hasattr(geometry, 'fuel'):
                params["d_pintle_tip"] = geometry.fuel.d_pintle_tip
                params["h_gap"] = geometry.fuel.h_gap
            if hasattr(geometry, 'lox'):
                params["n_orifices"] = float(geometry.lox.n_orifices)
                params["d_orifice"] = geometry.lox.d_orifice
                params["theta_orifice"] = geometry.lox.theta_orifice
        return params
    
    def _extract_chamber_params(self, config: PintleEngineConfig) -> Dict[str, float]:
        """Extract chamber geometry parameters for convergence checking."""
        from engine.pipeline.config_schemas import ensure_chamber_geometry
        cg = ensure_chamber_geometry(config)
        return {
            "A_throat": cg.A_throat,
            "A_exit": cg.A_exit,
            "Lstar": cg.Lstar,
            "chamber_diameter": cg.chamber_diameter,
        }
    
    def _calculate_relative_change(
        self, params_prev: Dict[str, float], params_current: Dict[str, float]
    ) -> float:
        """Calculate maximum relative change between parameter sets."""
        max_change = 0.0
        for key in set(params_prev.keys()) | set(params_current.keys()):
            if key in params_prev and key in params_current:
                val_prev = params_prev[key]
                val_current = params_current[key]
                if abs(val_prev) > 1e-10:
                    rel_change = abs(val_current - val_prev) / abs(val_prev)
                    max_change = max(max_change, rel_change)
        return max_change

