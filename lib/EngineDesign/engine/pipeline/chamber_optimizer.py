"""Iterative optimization pipeline for chamber geometry design.

This module provides a comprehensive optimization system that:
- Solves for optimal chamber geometry given design requirements
- Considers manufacturing and structural constraints
- Ensures stability margins
- Sets up ablative cooling for burn time
- Iterates until convergence with feedforward dynamics
"""

import numpy as np
from typing import Dict, Any, Optional, List, Tuple, Callable
from scipy.optimize import minimize, differential_evolution, Bounds
from engine.pipeline.config_schemas import PintleEngineConfig, ensure_chamber_geometry, ChamberGeometryConfig
from engine.core.runner import PintleEngineRunner
from engine.pipeline.system_diagnostics import SystemDiagnostics


class ChamberOptimizer:
    """Iterative optimizer for chamber geometry design."""
    
    def __init__(self, base_config: PintleEngineConfig):
        self.base_config = base_config
        self.runner = PintleEngineRunner(base_config)
        self.diagnostics = SystemDiagnostics(base_config)
    
    def optimize(
        self,
        design_requirements: Dict[str, Any],
        constraints: Dict[str, Any],
        initial_guess: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        """
        Optimize chamber geometry to meet design requirements.
        
        Parameters:
        -----------
        design_requirements : dict
            - target_thrust: float [N] - Desired thrust
            - target_burn_time: float [s] - Desired burn time
            - target_stability_margin: float - Minimum stability margin (e.g., 1.2 = 20% margin)
            - P_tank_O: float [Pa] - Oxidizer tank pressure
            - P_tank_F: float [Pa] - Fuel tank pressure
            - target_Isp: Optional[float] [s] - Desired specific impulse (optional)
        
        constraints : dict
            - max_chamber_length: float [m] - Maximum chamber length
            - max_chamber_diameter: float [m] - Maximum chamber diameter
            - min_Lstar: float [m] - Minimum L* for combustion
            - max_Lstar: float [m] - Maximum L* (weight/structure)
            - min_expansion_ratio: float - Minimum expansion ratio
            - max_expansion_ratio: float - Maximum expansion ratio
            - manufacturing_tolerance: float [m] - Manufacturing tolerance for areas
            - max_wall_thickness: float [m] - Maximum wall thickness (structural)
            - min_wall_thickness: float [m] - Minimum wall thickness (structural)
        
        initial_guess : dict, optional
            - A_throat: float [m²]
            - A_exit: float [m²]
            - Lstar: float [m]
            - chamber_diameter: float [m]
        
        Returns:
        --------
        results : dict
            - optimized_config: PintleEngineConfig - Optimized configuration
            - performance: dict - Performance metrics
            - convergence_history: list - Optimization history
            - diagnostics: dict - System diagnostics
        """
        # Extract requirements
        target_thrust = design_requirements["target_thrust"]
        target_burn_time = design_requirements.get("target_burn_time", 10.0)
        target_stability_margin = design_requirements.get("target_stability_margin", 1.2)
        P_tank_O = design_requirements["P_tank_O"]
        P_tank_F = design_requirements["P_tank_F"]
        target_Isp = design_requirements.get("target_Isp", None)
        
        # Set up initial guess
        if initial_guess is None:
            initial_guess = self._generate_initial_guess(target_thrust, constraints)
        
        # Optimization variables: [A_throat, A_exit, Lstar, chamber_diameter]
        x0 = np.array([
            initial_guess["A_throat"],
            initial_guess["A_exit"],
            initial_guess["Lstar"],
            initial_guess.get("chamber_diameter", 0.1),
        ])
        
        # Set up bounds
        bounds = self._setup_bounds(constraints, initial_guess)
        
        # Optimization history
        history = []
        
        # Objective function
        def objective(x: np.ndarray) -> float:
            """Minimize error in meeting design requirements."""
            try:
                # Update config with current geometry
                config = self._update_config_from_x(x, self.base_config)
                
                # Evaluate engine
                runner = PintleEngineRunner(config)
                results = runner.evaluate(P_tank_O, P_tank_F)
                
                # Calculate errors (safe division)
                F_actual = results.get("F", 0.0)
                thrust_error = abs(F_actual - target_thrust) / target_thrust if target_thrust > 0 else 1.0
                
                Isp_actual = results.get("Isp", 0.0)
                isp_error = 0.0
                if target_Isp is not None and target_Isp > 0:
                    isp_error = abs(Isp_actual - target_Isp) / target_Isp
                
                # Stability margin error (safe division)
                stability = results.get("stability_results", {})
                chugging = stability.get("chugging", {})
                stability_margin = chugging.get("stability_margin", 0.0)
                if target_stability_margin > 0:
                    stability_error = max(0.0, target_stability_margin - stability_margin) / target_stability_margin
                else:
                    stability_error = 0.0 if stability_margin >= 0.5 else 1.0
                
                # Combined objective (weighted)
                objective_value = (
                    10.0 * thrust_error +  # Thrust is most important
                    5.0 * isp_error +
                    3.0 * stability_error
                )
                
                # Store history
                history.append({
                    "x": x.copy(),
                    "F": F_actual,
                    "Isp": Isp_actual,
                    "thrust_error": thrust_error,
                    "isp_error": isp_error,
                    "stability_error": stability_error,
                    "objective": objective_value,
                })
                
                return objective_value
                
            except Exception as e:
                # Return large penalty for invalid configurations
                return 1e6
        
        # Constraint functions
        constraints_list = self._setup_constraints(constraints, design_requirements, P_tank_O, P_tank_F)
        
        # Run optimization
        result = minimize(
            objective,
            x0,
            method="SLSQP",  # Sequential Least Squares Programming
            bounds=bounds,
            constraints=constraints_list,
            options={"maxiter": 100, "ftol": 1e-6},
        )
        
        # Extract optimized configuration
        optimized_config = self._update_config_from_x(result.x, self.base_config)
        optimized_runner = PintleEngineRunner(optimized_config)
        final_results = optimized_runner.evaluate(P_tank_O, P_tank_F)
        
        # Run diagnostics
        diagnostics = self.diagnostics.diagnose_all(P_tank_O, P_tank_F)
        
        # Calculate burn analysis with time-varying dynamics
        burn_analysis = self._calculate_burn_analysis(
            optimized_config, optimized_runner, target_burn_time, P_tank_O, P_tank_F
        )
        
        # Extract optimized parameters for display
        cg = ensure_chamber_geometry(optimized_config)
        optimized_params = {
            "A_throat": cg.A_throat,
            "A_exit": cg.A_exit,
            "Lstar": cg.Lstar,
            "chamber_diameter": cg.chamber_diameter,
            "chamber_length": cg.length,
            "expansion_ratio": cg.expansion_ratio,
        }
        
        return {
            "optimized_config": optimized_config,
            "optimization_result": result,
            "performance": final_results,
            "convergence_history": history,
            "diagnostics": diagnostics,
            "burn_analysis": burn_analysis,
            "design_requirements": design_requirements,
            "constraints": constraints,
            "optimized_parameters": optimized_params,  # NEW: For UI display
        }
    
    def _generate_initial_guess(self, target_thrust: float, constraints: Dict) -> Dict[str, float]:
        """Generate initial guess for optimization."""
        # Rough estimates based on target thrust
        # Typical: F ≈ 0.7 * Pc * A_throat * Cf (for sea level)
        # Assume Pc ≈ 2-3 MPa, Cf ≈ 1.5
        Pc_estimate = 2.5e6  # Pa
        Cf_estimate = 1.5
        
        A_throat_estimate = target_thrust / (0.7 * Pc_estimate * Cf_estimate)
        
        # Expansion ratio estimate (typical: 5-20)
        eps_estimate = 10.0
        eps_estimate = np.clip(eps_estimate, constraints.get("min_expansion_ratio", 3.0), 
                              constraints.get("max_expansion_ratio", 30.0))
        
        A_exit_estimate = A_throat_estimate * eps_estimate
        
        # L* estimate (typical: 0.8-1.5 m for pintle, but small engines can be 1.0-1.5 m)
        # For small-scale engines (20mm throat), L* is typically 1.0-1.5 m (40-60 inches)
        Lstar_estimate = 1.27  # 50 inches - good default for small engines
        Lstar_estimate = np.clip(Lstar_estimate, constraints.get("min_Lstar", 0.5), 
                                constraints.get("max_Lstar", 2.5))
        
        # Chamber diameter estimate (from volume and length)
        # V = L* * A_throat, and V = π * (D/2)² * L_chamber
        # Rough estimate: D ≈ 3 * sqrt(A_throat)
        chamber_diameter_estimate = 3.0 * np.sqrt(A_throat_estimate)
        chamber_diameter_estimate = np.clip(chamber_diameter_estimate, 0.05, 
                                            constraints.get("max_chamber_diameter", 0.3))
        
        return {
            "A_throat": A_throat_estimate,
            "A_exit": A_exit_estimate,
            "Lstar": Lstar_estimate,
            "chamber_diameter": chamber_diameter_estimate,
        }
    
    def _setup_bounds(self, constraints: Dict, initial_guess: Dict) -> Bounds:
        """Set up optimization bounds."""
        # Bounds: [A_throat, A_exit, Lstar, chamber_diameter]
        # For small-scale engines: 20mm throat = 0.000314 m², so allow down to 5mm = 0.00002 m²
        A_throat_min = 1e-6  # m² (1 mm²) - allows very small engines
        A_throat_max = 0.01  # m² (100 cm²)
        
        min_eps = constraints.get("min_expansion_ratio", 3.0)
        max_eps = constraints.get("max_expansion_ratio", 30.0)
        
        A_exit_min = A_throat_min * min_eps
        A_exit_max = A_throat_max * max_eps
        
        Lstar_min = constraints.get("min_Lstar", 0.5)
        Lstar_max = constraints.get("max_Lstar", 2.5)
        
        chamber_diameter_min = 0.05  # m
        chamber_diameter_max = constraints.get("max_chamber_diameter", 0.3)
        
        return Bounds(
            [A_throat_min, A_exit_min, Lstar_min, chamber_diameter_min],
            [A_throat_max, A_exit_max, Lstar_max, chamber_diameter_max],
        )
    
    def _setup_constraints(
        self, constraints: Dict, design_requirements: Dict, P_tank_O: float, P_tank_F: float
    ) -> List[Dict]:
        """Set up optimization constraints including airframe and system constraints."""
        constraint_list = []
        
        # Constraint: Expansion ratio within bounds
        def expansion_ratio_constraint(x):
            A_throat, A_exit = x[0], x[1]
            eps = A_exit / A_throat if A_throat > 0 else 1.0
            min_eps = constraints.get("min_expansion_ratio", 3.0)
            max_eps = constraints.get("max_expansion_ratio", 30.0)
            return [eps - min_eps, max_eps - eps]
        
        constraint_list.append({
            "type": "ineq",
            "fun": lambda x: expansion_ratio_constraint(x)[0],  # eps >= min_eps
        })
        constraint_list.append({
            "type": "ineq",
            "fun": lambda x: expansion_ratio_constraint(x)[1],  # eps <= max_eps
        })
        
        # Constraint: Chamber length within bounds
        def chamber_length_constraint(x):
            Lstar, chamber_diameter = x[2], x[3]
            # Estimate chamber length from L* and geometry
            A_throat = x[0]
            V_chamber = Lstar * A_throat
            A_chamber = np.pi * (chamber_diameter / 2) ** 2
            L_chamber = V_chamber / A_chamber if A_chamber > 0 else 0.0
            max_length = constraints.get("max_chamber_length", 1.0)
            # Also check airframe max_length if provided
            airframe_max_length = constraints.get("max_vehicle_length", None)
            if airframe_max_length is not None:
                max_length = min(max_length, airframe_max_length)
            return max_length - L_chamber
        
        constraint_list.append({
            "type": "ineq",
            "fun": chamber_length_constraint,
        })
        
        # Constraint: Chamber diameter within airframe limits
        def chamber_diameter_constraint(x):
            chamber_diameter = x[3]
            max_diameter = constraints.get("max_chamber_diameter", 0.3)
            # Also check airframe max_diameter if provided
            airframe_max_diameter = constraints.get("max_vehicle_diameter", None)
            if airframe_max_diameter is not None:
                max_diameter = min(max_diameter, airframe_max_diameter)
            return max_diameter - chamber_diameter
        
        constraint_list.append({
            "type": "ineq",
            "fun": chamber_diameter_constraint,
        })
        
        # Constraint: Total engine weight (if weight limits provided)
        def weight_constraint(x):
            try:
                config = self._update_config_from_x(x, self.base_config)
                runner = PintleEngineRunner(config)
                results = runner.evaluate(P_tank_O, P_tank_F)
                
                # Estimate engine weight (chamber + nozzle + injector)
                # Rough estimates: chamber wall, ablative, graphite, nozzle
                A_throat, A_exit, Lstar, chamber_diameter = x[0], x[1], x[2], x[3]
                
                # Chamber wall weight (stainless steel, ~3mm thick)
                L_chamber = (Lstar * A_throat) / (np.pi * (chamber_diameter / 2) ** 2) if chamber_diameter > 0 else 0.25
                chamber_wall_area = np.pi * chamber_diameter * L_chamber
                chamber_wall_volume = chamber_wall_area * 0.003  # 3mm thickness
                chamber_wall_mass = chamber_wall_volume * 8000.0  # Stainless density [kg/m³]
                
                # Ablative weight (if enabled)
                ablative_mass = 0.0
                if config.ablative_cooling and config.ablative_cooling.enabled:
                    ablative_thickness = config.ablative_cooling.initial_thickness
                    ablative_area = chamber_wall_area * config.ablative_cooling.coverage_fraction
                    ablative_volume = ablative_area * ablative_thickness
                    ablative_mass = ablative_volume * config.ablative_cooling.material_density
                
                # Graphite insert weight (if enabled)
                graphite_mass = 0.0
                if hasattr(config, 'graphite_insert') and config.graphite_insert and config.graphite_insert.enabled:
                    graphite_thickness = config.graphite_insert.initial_thickness
                    graphite_area = np.pi * (np.sqrt(4.0 * A_throat / np.pi) / 2.0) ** 2  # Throat area
                    graphite_volume = graphite_area * graphite_thickness
                    graphite_mass = graphite_volume * config.graphite_insert.material_density
                
                # Nozzle weight (simplified - conical nozzle)
                nozzle_length = constraints.get("nozzle_length", 0.1)  # Default 10cm
                nozzle_wall_thickness = 0.002  # 2mm
                D_exit = np.sqrt(4.0 * A_exit / np.pi)
                D_throat = np.sqrt(4.0 * A_throat / np.pi)
                nozzle_avg_diameter = (D_exit + D_throat) / 2.0
                nozzle_wall_area = np.pi * nozzle_avg_diameter * nozzle_length
                nozzle_wall_volume = nozzle_wall_area * nozzle_wall_thickness
                nozzle_wall_mass = nozzle_wall_volume * 8000.0  # Stainless
                
                # Total engine mass
                total_mass = chamber_wall_mass + ablative_mass + graphite_mass + nozzle_wall_mass
                
                # Check against weight limit
                max_weight = constraints.get("max_engine_weight", None)
                if max_weight is not None:
                    return max_weight - total_mass
                else:
                    return 1.0  # No constraint
                    
            except Exception:
                return -1e6  # Penalty for invalid configuration
        
        max_weight = constraints.get("max_engine_weight", None)
        if max_weight is not None:
            constraint_list.append({
                "type": "ineq",
                "fun": weight_constraint,
            })
        
        # Constraint: Stability margin (must meet minimum for all three types)
        def stability_constraint(x):
            try:
                config = self._update_config_from_x(x, self.base_config)
                runner = PintleEngineRunner(config)
                results = runner.evaluate(P_tank_O, P_tank_F)
                
                stability = results.get("stability_results", {})
                
                # Chugging stability
                chugging = stability.get("chugging", {})
                chugging_margin = chugging.get("stability_margin", 0.0)
                
                # Acoustic stability
                acoustic = stability.get("acoustic", {})
                acoustic_margin = acoustic.get("stability_margin", 0.0)
                
                # Feed system stability
                feed_system = stability.get("feed_system", {})
                feed_margin = feed_system.get("stability_margin", 0.0)
                
                # Get minimum requirements (with fallback to general target_stability_margin)
                min_stability = design_requirements.get("target_stability_margin", 1.2)
                chugging_min = design_requirements.get("chugging_margin_min", min_stability)
                acoustic_min = design_requirements.get("acoustic_margin_min", min_stability)
                feed_min = design_requirements.get("feed_stability_min", min_stability)
                
                # Return minimum margin (all must pass, so use the worst case)
                min_margin = min(
                    chugging_margin - chugging_min,
                    acoustic_margin - acoustic_min,
                    feed_margin - feed_min
                )
                
                return min_margin
                
            except Exception:
                return -1e6  # Penalty for invalid configuration
        
        constraint_list.append({
            "type": "ineq",
            "fun": stability_constraint,
        })
        
        # Constraint: Manufacturing tolerances (throat and exit areas)
        def manufacturing_constraint(x):
            A_throat, A_exit = x[0], x[1]
            tolerance = constraints.get("manufacturing_tolerance", 0.0001)  # 0.1mm default
            
            # Minimum area based on manufacturing capability
            min_area = np.pi * (tolerance / 2.0) ** 2
            return min(A_throat - min_area, A_exit - min_area)
        
        constraint_list.append({
            "type": "ineq",
            "fun": manufacturing_constraint,
        })
        
        return constraint_list
    
    def _update_config_from_x(self, x: np.ndarray, base_config: PintleEngineConfig) -> PintleEngineConfig:
        """Update configuration from optimization variables."""
        import copy
        config = copy.deepcopy(base_config)
        
        A_throat, A_exit, Lstar, chamber_diameter = x[0], x[1], x[2], x[3]
        
        # Ensure chamber_geometry exists
        if config.chamber_geometry is None:
            cg = ensure_chamber_geometry(config)
        else:
            cg = config.chamber_geometry
        
        # Calculate chamber length from volume and diameter
        volume = Lstar * A_throat  # V = L* * A_throat
        A_chamber = np.pi * (chamber_diameter / 2.0) ** 2
        if A_chamber > 0:
            length = volume / A_chamber
        else:
            length = 0.25  # Default fallback
        
        # Calculate exit diameter
        D_exit = np.sqrt(4.0 * A_exit / np.pi) if A_exit > 0 else 0.0
        expansion_ratio = A_exit / A_throat if A_throat > 0 else 1.0
        
        # Update chamber_geometry
        cg.A_throat = A_throat
        cg.A_exit = A_exit
        cg.volume = volume
        cg.length = length
        cg.Lstar = Lstar
        cg.chamber_diameter = chamber_diameter
        cg.exit_diameter = D_exit
        cg.expansion_ratio = expansion_ratio
        
        # Also update legacy sections if they exist (for backward compatibility)
        if config.chamber is not None:
            config.chamber.A_throat = A_throat
            config.chamber.volume = volume
            config.chamber.Lstar = Lstar
            config.chamber.chamber_inner_diameter = chamber_diameter
            config.chamber.length = length
        if config.nozzle is not None:
            config.nozzle.A_throat = A_throat
            config.nozzle.A_exit = A_exit
            config.nozzle.expansion_ratio = expansion_ratio
            config.nozzle.exit_diameter = D_exit
        
        # Update CEA cache expansion ratio
        if hasattr(config.combustion, 'cea'):
            config.combustion.cea.expansion_ratio = expansion_ratio
        
        # Update regen cooling chamber diameter if enabled
        if config.regen_cooling is not None and config.regen_cooling.enabled:
            config.regen_cooling.chamber_inner_diameter = chamber_diameter
        
        return config
    
    def _calculate_burn_analysis(
        self, config: PintleEngineConfig, runner: PintleEngineRunner,
        burn_time: float, P_tank_O: float, P_tank_F: float
    ) -> Dict[str, Any]:
        """Calculate burn analysis for the optimized configuration with full dynamics."""
        from engine.pipeline.burn_analysis import analyze_burn_degradation
        
        # Run time-series evaluation with coupled solver (includes chamber/nozzle dynamics and ablative)
        time_array = np.linspace(0.0, burn_time, 100)
        
        # Use constant tank pressures for now (could be made time-varying)
        P_tank_O_array = np.full_like(time_array, P_tank_O)
        P_tank_F_array = np.full_like(time_array, P_tank_F)
        
        # Use fully-coupled solver with ablative geometry tracking
        results_array = runner.evaluate_arrays_with_time(
            time_array,
            P_tank_O_array,
            P_tank_F_array,
            track_ablative_geometry=True,  # Enable ablative geometry tracking
            use_coupled_solver=True,  # Use fully-coupled solver (chamber + nozzle dynamics)
        )
        
        # Analyze degradation
        burn_results = analyze_burn_degradation(results_array, time_array)
        
        return burn_results

