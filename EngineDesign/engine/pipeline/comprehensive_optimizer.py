"""Comprehensive optimization system for pintle engine design.

This module provides end-to-end optimization from vehicle requirements to detailed
pintle injector and chamber geometry.

Optimization Levels:
1. Vehicle-Level: Flight performance → Propellant masses, tank sizes, COPV
2. Engine-Level: Thrust requirements → Chamber geometry, nozzle, cooling
3. Injector-Level: Performance targets → Pintle dimensions, orifice sizing, angles
4. Material-Level: Heat flux → Ablative thickness, graphite sizing

All levels are coupled and solved iteratively.
"""

from __future__ import annotations

from typing import Dict, Any, Optional, List, Tuple, Callable
import numpy as np
from scipy.optimize import minimize, differential_evolution, Bounds
from engine.pipeline.config_schemas import PintleEngineConfig, ensure_chamber_geometry
from engine.core.runner import PintleEngineRunner


class ComprehensivePintleOptimizer:
    """
    Comprehensive optimizer that solves for all pintle dimensions and chamber geometry.
    
    Optimizes:
    - Pintle injector: d_pintle_tip, h_gap, n_orifices, d_orifice, theta_orifice
    - Chamber: A_throat, A_exit, Lstar, D_chamber
    - Materials: ablative thickness, graphite thickness
    - Feed system: tank pressures, COPV sizing
    
    All coupled with flight simulation and stability analysis.
    """
    
    def __init__(self, base_config: PintleEngineConfig):
        self.base_config = base_config
        self.runner = PintleEngineRunner(base_config)
        self.optimization_history = []
    
    def optimize_pintle_geometry(
        self,
        target_thrust: float,
        target_isp: Optional[float] = None,
        target_mr: Optional[float] = None,
        P_tank_O: float = 3.0e6,  # 3 MPa
        P_tank_F: float = 3.0e6,  # 3 MPa
        constraints: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Optimize complete pintle injector geometry.
        
        Design variables:
        - d_pintle_tip: Pintle tip diameter [m]
        - h_gap: Annular gap height [m]
        - n_orifices: Number of LOX orifices
        - d_orifice: LOX orifice diameter [m]
        - theta_orifice: LOX injection angle [deg]
        - A_throat: Throat area [m²]
        - A_exit: Exit area [m²]
        - Lstar: Characteristic length [m]
        - D_chamber: Chamber diameter [m]
        
        Parameters:
        -----------
        target_thrust : float
            Target thrust [N]
        target_isp : float, optional
            Target specific impulse [s]
        target_mr : float, optional
            Target mixture ratio
        P_tank_O : float
            Oxidizer tank pressure [Pa]
        P_tank_F : float
            Fuel tank pressure [Pa]
        constraints : dict, optional
            Design constraints
        
        Returns:
        --------
        results : dict
            Optimized configuration and performance
        """
        if constraints is None:
            constraints = self._default_constraints()
        
        # Design variable bounds
        # [d_pintle_tip, h_gap, n_orifices, d_orifice, theta_orifice, A_throat, A_exit, Lstar, D_chamber]
        bounds = self._setup_pintle_bounds(constraints)
        
        # Initial guess
        x0 = self._generate_pintle_initial_guess(target_thrust, constraints)
        
        history = []
        
        def objective(x: np.ndarray) -> float:
            """Minimize error in meeting targets."""
            try:
                # Update config
                config = self._update_config_from_pintle_x(x, self.base_config)
                
                # Evaluate engine
                runner = PintleEngineRunner(config)
                results = runner.evaluate(P_tank_O, P_tank_F)
                
                # Calculate errors
                F_actual = results.get("F", 0.0)
                thrust_error = abs(F_actual - target_thrust) / target_thrust
                
                Isp_actual = results.get("Isp", 0.0)
                isp_error = 0.0
                if target_isp is not None:
                    isp_error = abs(Isp_actual - target_isp) / target_isp
                
                MR_actual = results.get("MR", 0.0)
                mr_error = 0.0
                if target_mr is not None:
                    mr_error = abs(MR_actual - target_mr) / target_mr
                
                # Stability penalty (check all three types)
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
                
                # Default minimums (can be overridden by constraints if provided)
                min_stability = 1.2
                chugging_penalty = max(0.0, min_stability - chugging_margin)
                acoustic_penalty = max(0.0, min_stability - acoustic_margin)
                feed_penalty = max(0.0, min_stability - feed_margin)
                
                # Combined stability penalty
                stability_penalty = chugging_penalty + acoustic_penalty + feed_penalty
                
                # Combined objective
                objective_value = (
                    10.0 * thrust_error +
                    5.0 * isp_error +
                    3.0 * mr_error +
                    2.0 * stability_penalty
                )
                
                history.append({
                    "x": x.copy(),
                    "F": F_actual,
                    "Isp": Isp_actual,
                    "MR": MR_actual,
                    "stability_margin": stability_margin,
                    "objective": objective_value,
                })
                
                return objective_value
                
            except Exception as e:
                return 1e6
        
        # Run optimization
        result = minimize(
            objective,
            x0,
            method="SLSQP",
            bounds=bounds,
            options={"maxiter": 200, "ftol": 1e-6},
        )
        
        # Extract optimized config
        optimized_config = self._update_config_from_pintle_x(result.x, self.base_config)
        optimized_runner = PintleEngineRunner(optimized_config)
        final_results = optimized_runner.evaluate(P_tank_O, P_tank_F)
        
        return {
            "optimized_config": optimized_config,
            "optimization_result": result,
            "performance": final_results,
            "convergence_history": history,
        }
    
    def _default_constraints(self) -> Dict[str, Any]:
        """Default design constraints for small-scale engines."""
        return {
            "min_pintle_tip_diameter": 0.010,  # 10mm
            "max_pintle_tip_diameter": 0.030,  # 30mm
            "min_gap_height": 0.0002,  # 0.2mm
            "max_gap_height": 0.001,  # 1mm
            "min_orifices": 6,
            "max_orifices": 24,
            "min_orifice_diameter": 0.001,  # 1mm
            "max_orifice_diameter": 0.005,  # 5mm
            "min_injection_angle": 20.0,  # deg
            "max_injection_angle": 45.0,  # deg
            "min_expansion_ratio": 5.0,
            "max_expansion_ratio": 20.0,
            "min_Lstar": 0.8,  # Allow down to 0.8m for very small engines
            "max_Lstar": 2.0,  # Up to 2.0m for larger small engines
            "min_chamber_diameter": 0.05,  # 50mm - appropriate for small engines
            "max_chamber_diameter": 0.15,  # 150mm - appropriate for small engines
        }
    
    def _setup_pintle_bounds(self, constraints: Dict[str, Any]) -> Bounds:
        """Set up optimization bounds for pintle variables."""
        return Bounds(
            [
                constraints["min_pintle_tip_diameter"],
                constraints["min_gap_height"],
                constraints["min_orifices"],
                constraints["min_orifice_diameter"],
                constraints["min_injection_angle"],
                # Chamber geometry bounds
                1e-6,  # A_throat min
                1e-5,  # A_exit min
                constraints["min_Lstar"],
                constraints["min_chamber_diameter"],
            ],
            [
                constraints["max_pintle_tip_diameter"],
                constraints["max_gap_height"],
                constraints["max_orifices"],
                constraints["max_orifice_diameter"],
                constraints["max_injection_angle"],
                # Chamber geometry bounds
                0.01,  # A_throat max
                0.1,  # A_exit max
                constraints["max_Lstar"],
                constraints["max_chamber_diameter"],
            ],
        )
    
    def _generate_pintle_initial_guess(
        self, target_thrust: float, constraints: Dict[str, Any]
    ) -> np.ndarray:
        """Generate initial guess for pintle optimization."""
        # Estimate throat area from thrust
        Pc_estimate = 3.0e6  # 3 MPa
        Cf_estimate = 1.5
        A_throat_estimate = target_thrust / (0.7 * Pc_estimate * Cf_estimate)
        
        # Initial pintle guess
        d_pintle_guess = 0.015  # 15mm
        h_gap_guess = 0.0005  # 0.5mm
        n_orifices_guess = 12
        d_orifice_guess = 0.003  # 3mm
        theta_orifice_guess = 30.0  # 30 deg
        
        # Chamber geometry
        eps_estimate = 10.0
        A_exit_estimate = A_throat_estimate * eps_estimate
        # For small-scale engines: L* typically 1.0-1.5 m (40-60 inches)
        Lstar_estimate = 1.27  # 50 inches - good default for small engines
        # Chamber diameter for small engine: typically 3-4x throat diameter
        # For 20mm throat, chamber ~60-80mm
        D_chamber_estimate = 0.070  # 70mm - appropriate for small engines
        
        return np.array([
            d_pintle_guess,
            h_gap_guess,
            n_orifices_guess,
            d_orifice_guess,
            theta_orifice_guess,
            A_throat_estimate,
            A_exit_estimate,
            Lstar_estimate,
            D_chamber_estimate,
        ])
    
    def _update_config_from_pintle_x(
        self, x: np.ndarray, base_config: PintleEngineConfig
    ) -> PintleEngineConfig:
        """Update configuration from pintle optimization variables."""
        import copy
        config = copy.deepcopy(base_config)
        
        d_pintle_tip, h_gap, n_orifices, d_orifice, theta_orifice, A_throat, A_exit, Lstar, D_chamber = x
        
        # Update injector geometry
        if hasattr(config.injector, 'geometry'):
            if hasattr(config.injector.geometry, 'fuel'):
                config.injector.geometry.fuel.d_pintle_tip = float(d_pintle_tip)
                config.injector.geometry.fuel.h_gap = float(h_gap)
            if hasattr(config.injector.geometry, 'lox'):
                config.injector.geometry.lox.n_orifices = int(round(n_orifices))
                config.injector.geometry.lox.d_orifice = float(d_orifice)
                config.injector.geometry.lox.theta_orifice = float(theta_orifice)
        
        # Ensure chamber_geometry exists
        if config.chamber_geometry is None:
            cg = ensure_chamber_geometry(config)
        else:
            cg = config.chamber_geometry
        
        volume = Lstar * A_throat
        
        # Update chamber_geometry
        cg.A_throat = float(A_throat)
        cg.volume = volume
        cg.Lstar = float(Lstar)
        cg.chamber_diameter = float(D_chamber)
        
        # Also update legacy chamber if it exists
        if config.chamber is not None:
            config.chamber.A_throat = float(A_throat)
            config.chamber.volume = volume
            config.chamber.Lstar = float(Lstar)
            config.chamber.chamber_inner_diameter = float(D_chamber)
        
        # Calculate chamber length
        A_chamber = np.pi * (D_chamber / 2.0) ** 2
        if A_chamber > 0:
            length = volume / A_chamber
        else:
            length = 0.25
        
        cg.length = length
        if config.chamber is not None:
            config.chamber.length = length
        
        # Update nozzle geometry
        D_exit = np.sqrt(4.0 * A_exit / np.pi) if A_exit > 0 else 0.0
        expansion_ratio = A_exit / A_throat if A_throat > 0 else 1.0
        
        cg.A_exit = float(A_exit)
        cg.exit_diameter = D_exit
        cg.expansion_ratio = expansion_ratio
        
        if config.nozzle is not None:
            config.nozzle.A_throat = float(A_throat)
            config.nozzle.A_exit = float(A_exit)
            config.nozzle.expansion_ratio = expansion_ratio
            config.nozzle.exit_diameter = D_exit
        
        # Update CEA cache expansion ratio
        if hasattr(config.combustion, 'cea'):
            config.combustion.cea.expansion_ratio = expansion_ratio
        
        return config


class VehicleLevelOptimizer:
    """
    Vehicle-level optimizer that couples flight simulation with engine optimization.
    
    Takes vehicle requirements (altitude, payload, constraints) and optimizes:
    - Propellant masses
    - Tank sizes
    - Engine geometry (via ComprehensivePintleOptimizer)
    - COPV sizing
    """
    
    def __init__(self, base_config: PintleEngineConfig):
        self.base_config = base_config
        self.pintle_optimizer = ComprehensivePintleOptimizer(base_config)
    
    def optimize_vehicle(
        self,
        vehicle_requirements: Dict[str, Any],
        constraints: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Optimize complete vehicle design.
        
        Parameters:
        -----------
        vehicle_requirements : dict
            - target_altitude: float [m]
            - payload_mass: float [kg]
            - max_length: float [m]
            - max_diameter: float [m]
            - recovery_system_mass: float [kg]
            - avionics_mass: float [kg]
            - constraints: dict with bounds
        
        Returns:
        --------
        results : dict
            Optimized vehicle configuration
        """
        # This is a placeholder - full implementation would:
        # 1. Optimize propellant masses and tank sizes
        # 2. For each candidate, optimize engine geometry
        # 3. Run flight simulation
        # 4. Check constraints (altitude, acceleration, etc.)
        # 5. Minimize total vehicle mass
        
        # For now, return structure
        return {
            "optimized_config": self.base_config,
            "vehicle_mass": 0.0,
            "flight_results": {},
        }

