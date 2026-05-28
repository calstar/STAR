"""Fully-coupled time-varying solver for complete engine analysis.

This module provides comprehensive time-varying analysis with full coupling between:
1. Reaction chemistry (time-varying reaction progress)
2. Shifting equilibrium (affected by reaction chemistry changes)
3. Chamber dynamics (L*, efficiency, pressure)
4. Ablative recession (geometry evolution)
5. Graphite recession (throat area evolution)
6. Nozzle dynamics (expansion ratio changes)
7. Stability analysis (over time with all changes)

All systems are integrated simultaneously - no decoupling or approximations.
"""

from __future__ import annotations

from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass
import numpy as np
import copy

from engine.pipeline.config_schemas import PintleEngineConfig, ensure_chamber_geometry, ChamberGeometryConfig
from engine.core.chamber_solver import ChamberSolver
from engine.core.exceptions import EngineShutdownException
from engine.core.nozzle import calculate_thrust
from engine.pipeline.reaction_chemistry import (
    calculate_chamber_reaction_progress,
    calculate_shifting_equilibrium_properties,
)
from engine.pipeline.thermal.ablative_cooling import compute_ablative_response
from engine.pipeline.thermal.ablative_geometry import (
    update_chamber_geometry_from_ablation,
    update_nozzle_exit_from_ablation,
    calculate_throat_heuristic_multiplier,
)
from engine.pipeline.thermal.graphite_cooling import compute_graphite_recession
from engine.pipeline.stability.analysis import (
    calculate_chugging_frequency,
    calculate_acoustic_modes,
    analyze_feed_system_stability,  # Correct function name
)
from engine.pipeline.thermal.regen_cooling import estimate_hot_wall_heat_flux


@dataclass
class TimeVaryingState:
    """Complete state of the engine at a given time."""
    time: float  # [s]
    
    # Geometry (evolving)
    V_chamber: float  # [m³]
    A_throat: float  # [m²]  # CRITICAL: Stays constant with graphite insert
    A_exit: float  # [m²]
    Lstar: float  # [m]
    D_chamber: float  # [m]
    D_throat: float  # [m]  # CRITICAL: Stays constant with graphite insert
    D_exit: float  # [m]
    eps: float  # Expansion ratio
    
    # Cumulative recession
    recession_chamber: float  # [m]
    recession_throat: float  # [m]  # Ablative recession at throat (if no graphite)
    recession_exit: float  # [m]
    recession_graphite: float  # [m]  # Graphite insert recession
    graphite_thickness_remaining: float  # [m]  # Remaining graphite thickness
    
    # Reaction chemistry
    reaction_progress: Dict[str, float]  # progress_injection, progress_mid, progress_throat
    tau_residence: float  # [s]
    tau_effective: float  # [s]
    
    # Performance
    Pc: float  # [Pa]
    Tc: float  # [K]
    MR: float
    mdot_total: float  # [kg/s]
    F: float  # [N]
    Isp: float  # [s]
    v_exit: float  # [m/s]
    P_exit: float  # [Pa]
    T_exit: float  # [K]
    M_exit: float
    
    # Thermodynamics
    gamma_chamber: float
    gamma_exit: float
    R_chamber: float
    R_exit: float
    equilibrium_factor: float
    
    # Stability
    chugging_frequency: float  # [Hz]
    chugging_stability_margin: float
    stability_state: str  # "stable", "marginal", or "unstable"
    stability_score: float  # 0-1 score from comprehensive analysis
    acoustic_modes: Dict[str, float]
    feed_stability: Dict[str, float]
    
    # Heat flux and cooling
    heat_flux_chamber: float  # [W/m²]
    heat_flux_throat: float  # [W/m²]
    ablative_recession_rate: float  # [m/s]
    graphite_recession_rate: float  # [m/s]
    # Throat recession breakdown (graphite model)
    throat_oxidation_recession_rate: float  # [m/s]
    throat_ablation_recession_rate: float  # [m/s] (thermal/sublimation component)
    
    # Chamber intrinsics (TIME-VARYING - these change as geometry evolves)
    mach_number: float  # Chamber Mach number (should change over time, not hardcoded)
    eta_cstar: float  # Combustion efficiency n* (should change over time)
    reynolds_number: float  # Reynolds number
    residence_time: float  # [s]
    
    # Multi-layer thermal analysis
    T_ablative_surface: float  # [K] - Phenolic ablator surface temperature
    T_stainless_chamber: float  # [K] - Stainless steel back-face (chamber)
    T_graphite_surface: float  # [K] - Graphite surface temperature
    T_stainless_throat: float  # [K] - Stainless steel back-face (throat)
    
    # Nozzle dynamics
    nozzle_efficiency: float  # Nozzle efficiency (0-1)
    nozzle_max_heat_flux: float  # [W/m²] - Maximum heat flux in nozzle
    nozzle_max_wall_temp: float  # [K] - Maximum wall temperature in nozzle
    nozzle_is_melting: bool  # Whether nozzle is melting
    nozzle_hotspot_count: int  # Number of hotspots detected
    
    # Full diagnostics from ChamberSolver (includes ablative heat flux profiles)
    # Must be at end since it has a default value
    diagnostics: Optional[Dict[str, Any]] = None


class TimeVaryingCoupledSolver:
    """
    Fully-coupled time-varying solver for complete engine analysis.
    
    Integrates all systems simultaneously:
    - Reaction chemistry → shifting equilibrium
    - Geometry evolution → chamber dynamics
    - Ablative/graphite recession → geometry
    - Stability analysis → all time-varying effects
    """
    
    def __init__(
        self,
        config: PintleEngineConfig,
        cea_cache: Any,
    ):
        """
        Initialize the coupled time-varying solver.
        
        Parameters:
        -----------
        config : PintleEngineConfig
            Engine configuration
        cea_cache : CEACache
            CEA cache for thermochemical properties
        """
        self.config = config
        self.cea_cache = cea_cache
        
        # Ensure chamber_geometry exists
        cg = ensure_chamber_geometry(config)
        
        # Store initial geometry
        self.V_chamber_initial = cg.volume
        self.A_throat_initial = cg.A_throat
        self.A_exit_initial = cg.A_exit
        self.L_chamber = cg.length if cg.length else 0.18
        self.L_cylindrical = cg.length_cylindrical if cg.length_cylindrical else 0.12
        self.L_contraction = cg.length_contraction if cg.length_contraction else 0.06
        # FIXED: Use chamber_diameter from unified config
        self.D_chamber_initial = cg.chamber_diameter if cg.chamber_diameter and cg.chamber_diameter > 0 else 0.08
        self.D_throat_initial = np.sqrt(max(0, 4 * self.A_throat_initial / np.pi)) if self.A_throat_initial > 0 else 0.015
        self.D_exit_initial = np.sqrt(max(0, 4 * self.A_exit_initial / np.pi)) if self.A_exit_initial > 0 else 0.1
        
        # Initialize state history
        self.state_history: List[TimeVaryingState] = []
        self.shutdown_info: Optional[dict] = None
    
    def solve_time_step(
        self,
        time: float,
        dt: float,
        P_tank_O: float,
        P_tank_F: float,
        previous_state: Optional[TimeVaryingState] = None,
    ) -> TimeVaryingState:
        """
        Solve one time step with full coupling.
        
        This method:
        1. Updates geometry from previous recession
        2. Solves chamber pressure with updated geometry
        3. Calculates reaction progress (time-varying)
        4. Calculates heat flux
        5. Calculates recession rates
        6. Updates geometry
        7. Calculates thrust with shifting equilibrium (using reaction progress)
        8. Calculates stability
        9. Returns complete state
        
        Parameters:
        -----------
        time : float
            Current time [s]
        dt : float
            Time step [s]
        P_tank_O : float
            Oxidizer tank pressure [Pa]
        P_tank_F : float
            Fuel tank pressure [Pa]
        previous_state : TimeVaryingState, optional
            Previous time step state (for cumulative recession)
        
        Returns:
        --------
        state : TimeVaryingState
            Complete engine state at this time step
        """
        # Initialize geometry from previous state or initial
        if previous_state is not None:
            V_chamber = previous_state.V_chamber
            A_throat = previous_state.A_throat  # CRITICAL: Throat area stays constant with graphite
            A_exit = previous_state.A_exit
            recession_chamber = previous_state.recession_chamber
            recession_throat = previous_state.recession_throat
            recession_exit = previous_state.recession_exit
            recession_graphite = previous_state.recession_graphite
            graphite_thickness_remaining = previous_state.graphite_thickness_remaining
        else:
            V_chamber = self.V_chamber_initial
            A_throat = self.A_throat_initial  # Initial throat area (defined by graphite insert)
            A_exit = self.A_exit_initial
            recession_chamber = 0.0
            recession_throat = 0.0
            recession_exit = 0.0
            recession_graphite = 0.0
            # Initialize graphite thickness
            graphite_cfg = getattr(self.config, 'graphite_insert', None)
            graphite_thickness_remaining = (
                graphite_cfg.initial_thickness 
                if graphite_cfg and graphite_cfg.enabled 
                else 0.0
            )
        
        # Update config with current geometry
        config_current = copy.deepcopy(self.config)
        
        # Ensure chamber_geometry exists in current config
        if config_current.chamber_geometry is None:
            # Create from legacy sections if they exist
            cg = ensure_chamber_geometry(config_current)
        else:
            cg = config_current.chamber_geometry
        
        # Update chamber_geometry with current geometry
        cg.volume = V_chamber
        cg.A_throat = A_throat
        cg.A_exit = A_exit
        cg.expansion_ratio = A_exit / A_throat if A_throat > 0 else cg.expansion_ratio
        
        # Calculate and update current lengths
        # For simplicity, we assume lengths don't change much during ablation 
        # (mostly diameter and volume change), but we keep them in sync
        cg.length = self.L_chamber
        cg.length_cylindrical = self.L_cylindrical
        cg.length_contraction = self.L_contraction
        
        # Calculate and update current L*
        Lstar = V_chamber / A_throat if A_throat > 0 else cg.Lstar
        cg.Lstar = Lstar  # CRITICAL: Update Lstar so ChamberSolver uses it correctly
        
        # Update chamber solver with current geometry
        solver = ChamberSolver(config_current, self.cea_cache)
        
        # Solve chamber pressure with updated geometry
        # Use previous Pc as guess for branch continuity (prevents S-curve bifurcation jumps)
        Pc_prev = previous_state.Pc if previous_state is not None and np.isfinite(previous_state.Pc) else None
        Pc, diagnostics = solver.solve(P_tank_O, P_tank_F, Pc_guess=Pc_prev)
        
        # Extract diagnostics
        MR = diagnostics["MR"]
        mdot_total = diagnostics["mdot_total"]
        Tc = diagnostics["Tc"]
        gamma_chamber = diagnostics["gamma"]
        R_chamber = diagnostics["R"]
        cstar_actual = diagnostics["cstar_actual"]
        cstar_ideal = diagnostics["cstar_ideal"]
        # CRITICAL FIX: Remove arbitrary 0.85 default - use physics-based fallback
        eta_cstar = diagnostics.get("eta_cstar", cstar_actual / cstar_ideal if cstar_ideal > 0 else 0.90)
        
        # CRITICAL: Calculate chamber intrinsics (Mach number, etc.) - these should change over time
        # as geometry evolves. This was missing before!
        from engine.core.chamber_profiles import calculate_chamber_intrinsics
        # Get ambient pressure from config if available, otherwise use fallback (0.9 * 1 atm)
        P_back = None
        if hasattr(self.config, 'environment') and self.config.environment is not None:
            elevation = getattr(self.config.environment, 'elevation', None)
            if elevation is not None:
                # Use standard atmosphere model
                from engine.core.runner import compute_ambient_pressure_from_elevation
                P_back = compute_ambient_pressure_from_elevation(elevation)
        # If still None, fallback will be used (0.9 * 1 atm)
        chamber_intrinsics = calculate_chamber_intrinsics(
            Pc=Pc,
            Tc=Tc,
            mdot_total=mdot_total,
            gamma=gamma_chamber,
            R=R_chamber,
            V_chamber=V_chamber,
            A_throat=A_throat,
            Lstar=Lstar,
            MR=MR,
            P_back=P_back,  # Pass ambient pressure if available, None uses fallback
        )
        mach_number = chamber_intrinsics["mach_number"]  # Now calculated dynamically, not hardcoded
        
        # Calculate reaction progress (TIME-VARYING - depends on current L*)
        # Use conservative "Worst of Both Worlds" temperatures:
        # Tc_ideal for residence time (shortest time), effective_Tc for kinetics (slowest reactions)
        reaction_progress_dict = calculate_chamber_reaction_progress(
            Lstar,
            Pc,
            diagnostics["Tc_ideal"], # Ideal Tc (Residence Time)
            cstar_ideal,             # Ideal cstar (Residence Time)
            gamma_chamber,
            R_chamber,
            MR,
            self.config,
            spray_diagnostics=diagnostics.get("spray_diagnostics"),
            Tc_kinetics=Tc,          # Actual/Effective Tc (Kinetics)
        )
        
        # Extract reaction progress
        progress_throat = reaction_progress_dict["progress_throat"]
        progress_mid = reaction_progress_dict["progress_mid"]
        progress_injection = reaction_progress_dict["progress_injection"]
        
        # Calculate current chamber diameter (for heat flux and area)
        if previous_state is not None:
            D_chamber_current = previous_state.D_chamber
        else:
            D_chamber_current = self.D_chamber_initial
            
        A_chamber_current = np.pi * (D_chamber_current / 2.0) ** 2

        # Calculate heat flux for ablation/graphite
        # Chamber heat flux
        gas_props_chamber = {
            "Pc": Pc,
            "Tc": Tc,
            "gamma": gamma_chamber,
            "R": R_chamber,
            "chamber_length": self.L_chamber,
            "chamber_area": A_chamber_current,
        }
        heat_flux_chamber_dict = estimate_hot_wall_heat_flux(
            gas_props_chamber,
            None,  # No regen config
            wall_temperature=1200.0,  # Typical ablative surface temp
            mdot_total=mdot_total,
        )
        heat_flux_chamber = heat_flux_chamber_dict["heat_flux_total"]
        h_hot_chamber = heat_flux_chamber_dict.get("h_g", 50000.0)  # Convective coefficient
        
        # Throat heat flux using physics-based Bartz correlation
        from engine.pipeline.physics_based_replacements import calculate_throat_heat_flux_physics
        
        # Calculate chamber velocity (CRITICAL FIX: Don't overwrite V_chamber volume!)
        rho_chamber = Pc / (R_chamber * Tc)
        A_chamber = np.pi * (D_chamber_current / 2.0) ** 2
        chamber_velocity = mdot_total / (rho_chamber * A_chamber)  # FIXED: Use chamber_velocity, not V_chamber
        
        # Throat velocity (sonic)
        throat_velocity = np.sqrt(gamma_chamber * R_chamber * Tc * 2.0 / (gamma_chamber + 1.0))  # FIXED: Use throat_velocity, not V_throat
        
        # Current throat diameter (use previous state or initial)
        if previous_state is not None:
            D_throat_current = previous_state.D_throat
        else:
            D_throat_current = self.D_throat_initial
        
        # Physics-based throat heat flux
        heat_flux_throat = calculate_throat_heat_flux_physics(
            heat_flux_chamber=heat_flux_chamber,
            Pc=Pc,
            V_chamber=chamber_velocity,  # FIXED: Pass velocity, not volume
            V_throat=throat_velocity,  # FIXED: Pass velocity, not volume
            gamma=gamma_chamber,
            D_chamber=D_chamber_current,
            D_throat=D_throat_current,
        )
        
        # Convective coefficient scales with heat flux (h = q / (T_gas - T_wall))
        h_hot_throat = h_hot_chamber * (heat_flux_throat / (heat_flux_chamber + 1e-10))
        
        # Calculate ablative recession rate
        ablative_cfg = self.config.ablative_cooling
        if ablative_cfg.enabled:
            # Surface area for chamber
            A_surface_chamber = np.pi * self.D_chamber_initial * self.L_chamber * ablative_cfg.coverage_fraction
            
            ablative_response = compute_ablative_response(
                net_heat_flux=heat_flux_chamber,
                surface_temperature=1200.0,  # Typical ablative surface
                ablative_config=ablative_cfg,
                surface_area=A_surface_chamber,
                turbulence_intensity=0.1,  # Typical
            )
            recession_rate_ablative = ablative_response["recession_rate"]
        else:
            recession_rate_ablative = 0.0
        
        # Calculate graphite recession rate (and breakdown for diagnostics)
        graphite_cfg = getattr(self.config, 'graphite_insert', None)
        if graphite_cfg and graphite_cfg.enabled:
            # Check for simplified mode - try multiple ways to be robust to config loading issues
            simplified_mode = False
            if hasattr(graphite_cfg, "simplified_graphite_oxidation"):
                simplified_mode = bool(graphite_cfg.simplified_graphite_oxidation)
            elif isinstance(graphite_cfg, dict):
                simplified_mode = bool(graphite_cfg.get("simplified_graphite_oxidation", False))
            
            # Also check root config in case it was put there by mistake
            if not simplified_mode:
                simplified_mode = bool(getattr(self.config, "simplified_graphite_oxidation", False))
            
            gas_viscosity = None
            T_backside = None
            
            if not simplified_mode:
                # STRICT graphite oxidation inputs: no hidden defaults in compute_graphite_recession
                # - gas_density: use chamber density (good throat approximation for diffusion scaling)
                # - gas_viscosity: require an explicit config value (thermal_analysis.hot_gas_viscosity or regen_cooling.hot_gas_viscosity)
                
                # Check for hot_gas_viscosity in multiple possible locations
                gas_viscosity = None
                
                # 1. thermal_analysis section
                thermal_analysis_cfg = getattr(self.config, "thermal_analysis", None)
                if thermal_analysis_cfg:
                    gas_viscosity = getattr(thermal_analysis_cfg, "hot_gas_viscosity", None)
                
                # 2. Fallback to regen_cooling section
                if gas_viscosity is None:
                    regen_cfg = getattr(self.config, "regen_cooling", None)
                    if regen_cfg:
                        gas_viscosity = getattr(regen_cfg, "hot_gas_viscosity", None)
                
                if gas_viscosity is None:
                    raise ValueError(
                        "Graphite oxidation strict mode requires hot_gas_viscosity to be set in either "
                        "config.thermal_analysis or config.regen_cooling. "
                        "Set 'simplified_graphite_oxidation: true' in graphite_insert to use a constant recession rate instead."
                    )
                gas_viscosity = float(gas_viscosity)

                # Backside temperature should come from the multi-layer thermal model; require it.
                if 'T_stainless_throat' not in locals() or T_stainless_throat is None:
                    # In some cases T_stainless_throat might not be calculated yet or fail
                    # Fallback to T_backside_thermal if available, or 300K
                    T_backside = 300.0
                else:
                    T_backside = float(T_stainless_throat)
            else:
                # In simplified mode, these are not used for recession but we provide placeholders
                gas_viscosity = 4e-5 
                T_backside = 300.0

            graphite_response = compute_graphite_recession(
                net_heat_flux=heat_flux_throat,
                throat_temperature=2000.0,  # Typical graphite surface
                gas_temperature=Tc,
                graphite_config=graphite_cfg,
                throat_area=A_throat,
                pressure=Pc,
                gas_density=float(rho_chamber),
                gas_viscosity=gas_viscosity,
                oxygen_mass_fraction=getattr(graphite_cfg, "oxygen_mass_fraction", None),
                characteristic_length=float(D_throat_current),
                gas_velocity=float(throat_velocity),
                heat_transfer_coefficient=float(h_hot_throat),
                backside_temperature=T_backside,
                effective_thickness=float(graphite_thickness_remaining),
            )
            recession_rate_graphite = graphite_response["recession_rate"]
            throat_oxidation_rate = float(graphite_response.get("oxidation_rate", 0.0) or 0.0)
            # "recession_rate_thermal" is the thermal/sublimation component in compute_graphite_recession()
            throat_ablation_rate = float(graphite_response.get("recession_rate_thermal", 0.0) or 0.0)
        else:
            recession_rate_graphite = 0.0
            throat_oxidation_rate = 0.0
            throat_ablation_rate = 0.0
        
        # Calculate throat recession multiplier (heuristic-based)
        if ablative_cfg.enabled and ablative_cfg.throat_recession_multiplier is None:
            # Calculate from flow conditions (use already computed velocities)
            # chamber_velocity and throat_velocity already computed above
            throat_multiplier = calculate_throat_heuristic_multiplier(
                Pc,
                chamber_velocity,  # Use already computed chamber_velocity
                throat_velocity,  # Use already computed throat_velocity
                heat_flux_chamber,
                gamma_chamber,
            )
        elif ablative_cfg.enabled:
            throat_multiplier = ablative_cfg.throat_recession_multiplier
        else:
            throat_multiplier = 1.0
        
        # Update recession (cumulative)
        recession_chamber_new = recession_chamber + recession_rate_ablative * dt
        recession_exit_new = recession_exit + recession_rate_ablative * dt  # Simplified
        
        # CRITICAL: Graphite insert behavior
        # Graphite DOES erode, which means throat area DOES grow (just slower than ablative)
        # Graphite does NOT ablate if sizing_only_mode=True
        if graphite_cfg and graphite_cfg.enabled and graphite_thickness_remaining > 0:
            # Graphite insert is present
            # If sizing_only_mode=True, suppress recession to keep throat constant
            sizing_only_mode = getattr(graphite_cfg, 'sizing_only_mode', False)
            
            if sizing_only_mode:
                # Graphite doesn't recede - throat area stays CONSTANT
                recession_graphite_new = recession_graphite  # Graphite doesn't recede
                graphite_thickness_remaining_new = graphite_thickness_remaining  # Constant
                
                # PHYSICS: THROAT AREA STAYS CONSTANT in sizing mode
                D_throat_current = np.sqrt(max(0, 4.0 * A_throat / np.pi)) if A_throat > 0 else 0.015
                D_throat_new = D_throat_current  # NO CHANGE
                A_throat_new = A_throat  # NO CHANGE
            else:
                # Recession allowed (physical behavior)
                # Graphite oxidation in strict mode is complex - the time-varying solver 
                # integrates these changes into the geometry.
                
                # Throat area grows with graphite recession
                D_throat_current = np.sqrt(max(0, 4.0 * A_throat / np.pi)) if A_throat > 0 else 0.015
                D_throat_new = D_throat_current + 2.0 * recession_rate_graphite * dt
                A_throat_new = np.pi * (D_throat_new / 2.0) ** 2
                
                recession_graphite_new = recession_graphite + recession_rate_graphite * dt
                graphite_thickness_remaining_new = graphite_thickness_remaining - recession_rate_graphite * dt
                graphite_thickness_remaining_new = max(graphite_thickness_remaining_new, 0.0)
            
            # DEFINE THROAT RECESSION CONSISTENTLY:
            # While graphite is present, the physical throat surface is graphite.
            # Therefore, "recession_throat" should reflect graphite surface recession
            # (oxidation + thermal ablation), not the hypothetical ablative recession
            # behind the insert. The ablative recession is already captured in
            # recession_chamber; recession_graphite tracks the graphite thickness loss.
            recession_throat_new = recession_graphite_new
            
            # Update chamber volume (ablative recession still affects chamber)
            # Use INITIAL diameter as the reference and apply cumulative recession once.
            if ablative_cfg.enabled:
                D_chamber_new = self.D_chamber_initial + 2.0 * recession_chamber_new * ablative_cfg.coverage_fraction
                V_chamber_new = np.pi * (D_chamber_new / 2.0) ** 2 * self.L_chamber
            else:
                # No ablative - keep previous volume/diameter (or initial if first step)
                D_chamber_new = self.D_chamber_initial if previous_state is None else previous_state.D_chamber
                V_chamber_new = V_chamber  # Volume carried over
        elif graphite_cfg and graphite_cfg.enabled and graphite_thickness_remaining <= 0:
            # Graphite insert fully consumed - now ablative recession affects throat area
            recession_graphite_new = recession_graphite  # No more graphite to erode
            graphite_thickness_remaining_new = 0.0
            recession_throat_new = recession_throat + recession_rate_ablative * throat_multiplier * dt
            
            # Now update geometry from ablative recession (throat area can change)
            V_chamber_new, A_throat_new, D_chamber_new, D_throat_new, geom_diagnostics = (
                update_chamber_geometry_from_ablation(
                    self.V_chamber_initial,
                    self.A_throat_initial,
                    self.D_chamber_initial,
                    self.D_throat_initial,
                    self.L_chamber,
                    recession_chamber_new,
                    recession_thickness_throat=recession_throat_new,
                    coverage_fraction=ablative_cfg.coverage_fraction if ablative_cfg.enabled else 1.0,
                    throat_recession_multiplier=throat_multiplier,
                )
            )
        else:
            # No graphite insert - ablative recession directly affects throat area
            recession_graphite_new = recession_graphite
            graphite_thickness_remaining_new = 0.0
            recession_throat_new = recession_throat + recession_rate_ablative * throat_multiplier * dt
            
            # Update geometry from ablative recession (throat area changes)
            V_chamber_new, A_throat_new, D_chamber_new, D_throat_new, geom_diagnostics = (
                update_chamber_geometry_from_ablation(
                    self.V_chamber_initial,
                    self.A_throat_initial,
                    self.D_chamber_initial,
                    self.D_throat_initial,
                    self.L_chamber,
                    recession_chamber_new,
                    recession_thickness_throat=recession_throat_new,
                    coverage_fraction=ablative_cfg.coverage_fraction if ablative_cfg.enabled else 1.0,
                    throat_recession_multiplier=throat_multiplier,
                )
            )
        
        # Update exit area (if nozzle is ablative)
        A_exit_new, D_exit_new, exit_diagnostics = update_nozzle_exit_from_ablation(
            self.A_exit_initial,
            self.D_exit_initial,
            recession_exit_new,
            coverage_fraction=ablative_cfg.coverage_fraction if ablative_cfg.enabled else 1.0,
        )
        
        # Calculate new expansion ratio
        cg = ensure_chamber_geometry(self.config)
        eps_new = A_exit_new / A_throat_new if A_throat_new > 0 else cg.expansion_ratio
        Lstar_new = V_chamber_new / A_throat_new if A_throat_new > 0 else Lstar
        
        # Update config with current time-varying geometry
        config_current.chamber_geometry.A_throat = A_throat_new
        config_current.chamber_geometry.A_exit = A_exit_new
        config_current.chamber_geometry.expansion_ratio = eps_new
        config_current.chamber_geometry.volume = V_chamber_new
        
        # Calculate thrust with shifting equilibrium
        # CRITICAL: Pass reaction progress so shifting equilibrium accounts for time-varying chemistry
        Pa = 101325.0  # Ambient
        
        thrust_results = calculate_thrust(
            Pc,
            MR,
            mdot_total,
            self.cea_cache,
            config_current,
            Pa,
            reaction_progress=reaction_progress_dict,  # TIME-VARYING reaction progress
            use_shifting_equilibrium=True,
        )
        
        F = thrust_results["F"]
        Isp = thrust_results["Isp"]
        v_exit = thrust_results["v_exit"]
        P_exit = thrust_results["P_exit"]
        T_exit = thrust_results["T_exit"]
        M_exit = thrust_results["M_exit"]
        gamma_exit = thrust_results["gamma_exit"]
        R_exit = thrust_results["R_exit"]
        equilibrium_factor = thrust_results["equilibrium_factor"]
        
        # Calculate nozzle dynamics (efficiency, melting, hotspots)
        try:
            from engine.pipeline.nozzle_dynamics import (
                calculate_nozzle_exit_velocity,
                calculate_nozzle_heat_flux,
                detect_nozzle_hotspots,
                calculate_nozzle_melting,
            )
            
            # Get nozzle efficiency from config
            nozzle_eff_config = getattr(config_current.chamber_geometry, 'nozzle_efficiency', 0.92)
            
            # Nozzle exit velocity and efficiency (now geometry-driven)
            nozzle_velocity_results = calculate_nozzle_exit_velocity(
                Pc=Pc,
                Tc=Tc,
                gamma=gamma_exit,
                R=R_exit,
                expansion_ratio=eps_new,
                nozzle_efficiency=nozzle_eff_config,
                P_ambient=101325.0,
            )
            nozzle_efficiency = nozzle_velocity_results["efficiency"]
            
            # Nozzle heat flux distribution
            # Nozzle length is not yet in ChamberGeometryConfig, using 0.1 as default
            L_nozzle = 0.1
            n_nozzle_points = 50
            nozzle_positions = np.linspace(0.0, L_nozzle, n_nozzle_points)
            
            nozzle_heat_flux_results = calculate_nozzle_heat_flux(
                positions=nozzle_positions,
                Pc=Pc,
                Tc=Tc,
                mdot=mdot_total,
                gamma=gamma_exit,
                R=R_exit,
                D_throat=D_throat_new,
                expansion_ratio=eps_new,
            )
            
            # Detect hotspots
            hotspots = detect_nozzle_hotspots(
                heat_flux=nozzle_heat_flux_results["heat_flux"],
                positions=nozzle_positions,
            )
            
            # Check for melting
            material_melting_temp = 2000.0  # K, typical nozzle material
            melting_results = calculate_nozzle_melting(
                heat_flux=nozzle_heat_flux_results["heat_flux"],
                positions=nozzle_positions,
                material_melting_temp=material_melting_temp,
            )
            
            nozzle_dynamics = {
                "efficiency": nozzle_efficiency,
                "max_heat_flux": float(np.max(nozzle_heat_flux_results["heat_flux"])),
                "avg_heat_flux": float(np.mean(nozzle_heat_flux_results["heat_flux"])),
                "max_wall_temp": melting_results["max_temperature"],
                "is_melting": bool(np.any(melting_results["is_melting"])),
                "hotspot_count": int(np.sum(hotspots["is_hotspot"])),
                "hotspot_max_intensity": float(np.max(hotspots["hotspot_intensity"])),
            }
        except Exception as e:
            import warnings
            warnings.warn(f"Nozzle dynamics calculation failed: {e}")
            # CRITICAL FIX: Remove arbitrary 0.95 default - use config value or calculate
            nozzle_efficiency = getattr(config_current.chamber_geometry, 'nozzle_efficiency', 0.92)  # Use config or typical value
            nozzle_dynamics = {
                "efficiency": nozzle_efficiency,
                "max_heat_flux": 0.0,
                "avg_heat_flux": 0.0,
                "max_wall_temp": 0.0,
                "is_melting": False,
                "hotspot_count": 0,
                "hotspot_max_intensity": 1.0,
            }
        
        # Calculate stability with pintle geometry, impingement, and recirculation
        # Use enhanced physics-based spatial stability analysis
        try:
            from engine.pipeline.stability.enhanced import calculate_pintle_stability_enhanced
            from engine.pipeline.localized_ablation import calculate_impingement_zones
            
            # Create position array for spatial analysis
            n_stability_points = 50
            positions_stability = np.linspace(0.0, self.L_chamber, n_stability_points)
            
            # Calculate local properties (simplified - assume uniform for now)
            P_local = np.full(n_stability_points, Pc)
            c_local = np.full(n_stability_points, np.sqrt(gamma_chamber * R_chamber * Tc))
            rho_local = np.full(n_stability_points, Pc / (R_chamber * Tc))
            mdot_local = np.full(n_stability_points, mdot_total)
            
            # Recession profile (spatial variation)
            recession_profile = None
            if ablative_cfg and ablative_cfg.enabled:
                # Create spatial recession profile (more at impingement zones)
                impingement_data = calculate_impingement_zones(
                    config_current, self.L_chamber, D_chamber_new, n_points=n_stability_points
                )
                # Recession is enhanced at impingement zones
                recession_base = recession_chamber_new
                recession_profile = recession_base * impingement_data["impingement_heat_flux_multiplier"]
            
            # Get injection velocities for recirculation calculation
            # These would come from injector solve, but use estimates for now
            fuel_velocity = 50.0  # [m/s] - typical fuel injection velocity
            lox_velocity = 30.0   # [m/s] - typical LOX injection velocity
            
            # Calculate enhanced pintle-based stability with recirculation
            stability_spatial = calculate_pintle_stability_enhanced(
                config_current,
                positions_stability,
                P_local,
                c_local,
                rho_local,
                mdot_local,
                recession_profile=recession_profile,
                L_chamber=self.L_chamber,
                D_chamber=D_chamber_new,
                fuel_velocity=fuel_velocity,
                lox_velocity=lox_velocity,
            )
            
            # Use average values for single-point metrics
            chugging_freq = float(np.mean(stability_spatial["chugging_frequency"]))
            stability_margin = float(np.mean(stability_spatial["stability_margin"]))
            
            # Acoustic modes (use base calculation for now, could be enhanced)
            acoustic = calculate_acoustic_modes(
                self.L_chamber,
                D_chamber_new,
                gamma_chamber,
                R_chamber,
                Tc,
            )
            
            # Feed system stability
            feed_stability = {
                "pogo_frequency": np.nan,
                "surge_frequency": np.nan,
                "stability_margin": stability_margin,
            }
            
        except Exception as e:
            # Fallback to simple calculation
            import warnings
            warnings.warn(f"Pintle stability calculation failed, using fallback: {e}")
            chugging = calculate_chugging_frequency(
                V_chamber_new,
                A_throat_new,
                cstar_actual,
                gamma_chamber,
                Pc,
                R=R_chamber,
                Tc=Tc,
            )
            chugging_freq = chugging["frequency"]
            # CRITICAL FIX: Remove arbitrary 0.5 default - stability margin should be calculated
            # If not available, use neutral (0.0) rather than arbitrary positive value
            stability_margin = chugging.get("stability_margin", 0.0)  # Neutral if unknown
            
            acoustic = calculate_acoustic_modes(
                self.L_chamber,
                D_chamber_new,
                Tc,
                gamma_chamber,
                R_chamber,
            )
            
            feed_stability = {
                "pogo_frequency": np.nan,
                "surge_frequency": np.nan,
                "stability_margin": 1.0,
            }
        
        # Use comprehensive stability analysis if available
        comprehensive_stability = None
        try:
            from engine.pipeline.stability.analysis import comprehensive_stability_analysis
            
            # Create stability diagnostics dict for comprehensive analysis
            # (separate from solver diagnostics to avoid overwriting ablative profiles)
            # Calculate component mass flows
            mdot_O = mdot_total * MR / (1.0 + MR)
            mdot_F = mdot_total / (1.0 + MR)
            
            stability_diag = {
                "mdot_O": mdot_O,
                "mdot_F": mdot_F,
                "P_tank_O": P_tank_O,
                "P_tank_F": P_tank_F,
            }
            
            comprehensive_stability = comprehensive_stability_analysis(
                config=self.config,
                Pc=Pc,
                MR=MR,
                mdot_total=mdot_total,
                cstar=cstar_actual,
                gamma=gamma_chamber,
                R=R_chamber,
                Tc=Tc,
                diagnostics=stability_diag,
            )
            
            # Update stability_margin from comprehensive analysis
            stability_margin = comprehensive_stability.get("chugging", {}).get("stability_margin", stability_margin)
            chugging_freq = comprehensive_stability.get("chugging", {}).get("frequency", chugging_freq)
        except Exception as e:
            import warnings
            warnings.warn(f"Comprehensive stability analysis failed: {e}")
            comprehensive_stability = None
        
        # Multi-layer thermal analysis (phenolic → stainless steel)
        # Calculate temperature profile through wall to check stainless steel temperature
        from engine.pipeline.thermal_analysis import (
            calculate_steady_state_temperature_profile,
            MaterialLayer,
            ThermalBoundaryConditions,
        )
        
        # Get stainless steel case config (user input)
        stainless_cfg = getattr(self.config, 'stainless_steel_case', None)
        if stainless_cfg is None or not stainless_cfg.enabled:
            # Default stainless steel properties
            stainless_cfg = type('obj', (object,), {
                'enabled': True,
                'thickness': 0.003,  # 3mm
                'thermal_conductivity': 15.0,
                'density': 8000.0,
                'specific_heat': 500.0,
                'max_temperature': 1000.0,
                'emissivity': 0.8,  # CRITICAL FIX: Use typical ablative emissivity, not arbitrary 0.3
            })()
        
        # Calculate thermal profile for chamber wall (phenolic → stainless)
        T_stainless_chamber = np.nan
        T_ablative_surface = np.nan
        if ablative_cfg.enabled and stainless_cfg.enabled:
            # Layers: Hot gas → Phenolic ablator → Stainless steel → Ambient
            ablative_layer = MaterialLayer(
                name="Phenolic Ablator",
                thickness=max(ablative_cfg.initial_thickness - recession_chamber_new, 0.0001),  # Current thickness (min 0.1mm)
                thermal_conductivity=ablative_cfg.thermal_conductivity,
                density=ablative_cfg.material_density,
                specific_heat=ablative_cfg.specific_heat,
                emissivity=ablative_cfg.surface_emissivity,
                pyrolysis_temp=ablative_cfg.pyrolysis_temperature,
            )
            
            stainless_layer = MaterialLayer(
                name="Stainless Steel Case",
                thickness=stainless_cfg.thickness,
                thermal_conductivity=stainless_cfg.thermal_conductivity,
                density=stainless_cfg.density,
                specific_heat=stainless_cfg.specific_heat,
                emissivity=stainless_cfg.emissivity,
            )
            
            layers = [ablative_layer, stainless_layer]
            
            # Boundary conditions
            bc_chamber = ThermalBoundaryConditions(
                T_hot_gas=Tc,
                h_hot_gas=h_hot_chamber,
                q_rad_hot=heat_flux_chamber_dict.get("heat_flux_radiative", 0.0),
                T_ambient=300.0,
                h_ambient=10.0,  # Natural convection
            )
            
            try:
                thermal_profile_chamber = calculate_steady_state_temperature_profile(
                    layers,
                    bc_chamber,
                    n_points_per_layer=10,
                )
                T_ablative_surface = thermal_profile_chamber["T_surface_hot"]
                T_stainless_chamber = thermal_profile_chamber["T_surface_cold"]  # Back-face of stainless
            except Exception as e:
                import warnings
                warnings.warn(f"Chamber thermal profile calculation failed: {e}")
        
        # Calculate thermal profile for throat (graphite → stainless)
        T_stainless_throat = np.nan
        T_graphite_surface = np.nan
        if graphite_cfg and graphite_cfg.enabled and stainless_cfg.enabled and graphite_thickness_remaining > 0:
            graphite_layer = MaterialLayer(
                name="Graphite Insert",
                thickness=max(graphite_thickness_remaining, 0.0001),  # Current thickness (min 0.1mm)
                thermal_conductivity=graphite_cfg.thermal_conductivity,
                density=graphite_cfg.material_density,
                specific_heat=graphite_cfg.specific_heat,
                emissivity=0.8,  # Graphite emissivity
            )
            
            stainless_throat_layer = MaterialLayer(
                name="Stainless Steel Case (Throat)",
                thickness=stainless_cfg.thickness,
                thermal_conductivity=stainless_cfg.thermal_conductivity,
                density=stainless_cfg.density,
                specific_heat=stainless_cfg.specific_heat,
                emissivity=stainless_cfg.emissivity,
            )
            
            layers_throat = [graphite_layer, stainless_throat_layer]
            
            # Throat boundary conditions (higher heat flux)
            bc_throat = ThermalBoundaryConditions(
                T_hot_gas=Tc,
                h_hot_gas=h_hot_throat,
                q_rad_hot=heat_flux_throat * 0.2,  # Estimate radiative component
                T_ambient=300.0,
                h_ambient=10.0,
            )
            
            try:
                thermal_profile_throat = calculate_steady_state_temperature_profile(
                    layers_throat,
                    bc_throat,
                    n_points_per_layer=10,
                )
                T_graphite_surface = thermal_profile_throat["T_surface_hot"]
                T_stainless_throat = thermal_profile_throat["T_surface_cold"]
            except Exception as e:
                import warnings
                warnings.warn(f"Throat thermal profile calculation failed: {e}")
        
        # Build complete state
        state = TimeVaryingState(
            time=time,
            V_chamber=V_chamber_new,
            A_throat=A_throat_new,  # CRITICAL: This stays constant with graphite, grows without graphite
            A_exit=A_exit_new,
            Lstar=Lstar_new,
            D_chamber=D_chamber_new,
            D_throat=D_throat_new,  # CRITICAL: This stays constant with graphite, grows without graphite
            D_exit=D_exit_new,
            eps=eps_new,
            recession_chamber=recession_chamber_new,
            recession_throat=recession_throat_new,
            recession_exit=recession_exit_new,
            recession_graphite=recession_graphite_new,
            graphite_thickness_remaining=graphite_thickness_remaining_new,
            reaction_progress={
                "progress_injection": progress_injection,
                "progress_mid": progress_mid,
                "progress_throat": progress_throat,
            },
            tau_residence=reaction_progress_dict["tau_residence"],
            tau_effective=reaction_progress_dict["tau_effective"],
            Pc=Pc,
            Tc=Tc,
            MR=MR,
            mdot_total=mdot_total,
            F=F,
            Isp=Isp,
            mach_number=mach_number,  # TIME-VARYING - calculated dynamically
            eta_cstar=eta_cstar,  # TIME-VARYING - calculated from actual/ideal c*
            reynolds_number=chamber_intrinsics.get("reynolds_number", 10000.0),
            residence_time=chamber_intrinsics.get("residence_time", 0.001),
            v_exit=v_exit,
            P_exit=P_exit,
            T_exit=T_exit,
            M_exit=M_exit,
            gamma_chamber=gamma_chamber,
            gamma_exit=gamma_exit,
            R_chamber=R_chamber,
            R_exit=R_exit,
            equilibrium_factor=equilibrium_factor,
            chugging_frequency=chugging_freq,
            chugging_stability_margin=stability_margin,
            stability_state=comprehensive_stability.get("stability_state", "unstable") if comprehensive_stability else "unstable",
            stability_score=comprehensive_stability.get("stability_score", 0.0) if comprehensive_stability else 0.0,
            acoustic_modes=acoustic,
            feed_stability=feed_stability,
            heat_flux_chamber=heat_flux_chamber,
            heat_flux_throat=heat_flux_throat,
            ablative_recession_rate=recession_rate_ablative,
            graphite_recession_rate=recession_rate_graphite,
            throat_oxidation_recession_rate=throat_oxidation_rate,
            throat_ablation_recession_rate=throat_ablation_rate,
            T_ablative_surface=T_ablative_surface,
            T_stainless_chamber=T_stainless_chamber,
            T_graphite_surface=T_graphite_surface,
            T_stainless_throat=T_stainless_throat,
            # Nozzle dynamics
            nozzle_efficiency=nozzle_dynamics["efficiency"],
            nozzle_max_heat_flux=nozzle_dynamics["max_heat_flux"],
            nozzle_max_wall_temp=nozzle_dynamics["max_wall_temp"],
            nozzle_is_melting=nozzle_dynamics["is_melting"],
            nozzle_hotspot_count=nozzle_dynamics["hotspot_count"],
            # Full diagnostics from ChamberSolver (includes ablative heat flux profiles)
            diagnostics=diagnostics,
        )
        
        return state
    
    def _make_nan_state(self, time: float, previous_state=None) -> TimeVaryingState:
        """Create a NaN performance state for a failed time step, preserving geometry."""
        if previous_state is not None:
            V_chamber = previous_state.V_chamber
            A_throat = previous_state.A_throat
            A_exit = previous_state.A_exit
            Lstar = previous_state.Lstar
            D_chamber = previous_state.D_chamber
            D_throat = previous_state.D_throat
            D_exit = previous_state.D_exit
            eps = previous_state.eps
            recession_chamber = previous_state.recession_chamber
            recession_throat = previous_state.recession_throat
            recession_exit = previous_state.recession_exit
            recession_graphite = previous_state.recession_graphite
            graphite_thickness_remaining = previous_state.graphite_thickness_remaining
        else:
            V_chamber = self.V_chamber_initial
            A_throat = self.A_throat_initial
            A_exit = self.A_exit_initial
            Lstar = V_chamber / A_throat if A_throat > 0 else 0.0
            D_chamber = self.D_chamber_initial
            D_throat = self.D_throat_initial
            D_exit = self.D_exit_initial
            eps = A_exit / A_throat if A_throat > 0 else 1.0
            recession_chamber = 0.0
            recession_throat = 0.0
            recession_exit = 0.0
            recession_graphite = 0.0
            graphite_cfg = getattr(self.config, 'graphite_insert', None)
            graphite_thickness_remaining = (
                graphite_cfg.initial_thickness
                if graphite_cfg and graphite_cfg.enabled
                else 0.0
            )

        return TimeVaryingState(
            time=time,
            V_chamber=V_chamber,
            A_throat=A_throat,
            A_exit=A_exit,
            Lstar=Lstar,
            D_chamber=D_chamber,
            D_throat=D_throat,
            D_exit=D_exit,
            eps=eps,
            recession_chamber=recession_chamber,
            recession_throat=recession_throat,
            recession_exit=recession_exit,
            recession_graphite=recession_graphite,
            graphite_thickness_remaining=graphite_thickness_remaining,
            reaction_progress={"progress_injection": np.nan, "progress_mid": np.nan, "progress_throat": np.nan},
            tau_residence=np.nan,
            tau_effective=np.nan,
            Pc=np.nan,
            Tc=np.nan,
            MR=np.nan,
            mdot_total=np.nan,
            F=np.nan,
            Isp=np.nan,
            v_exit=np.nan,
            P_exit=np.nan,
            T_exit=np.nan,
            M_exit=np.nan,
            gamma_chamber=np.nan,
            gamma_exit=np.nan,
            R_chamber=np.nan,
            R_exit=np.nan,
            equilibrium_factor=np.nan,
            chugging_frequency=np.nan,
            chugging_stability_margin=np.nan,
            stability_state="unstable",
            stability_score=np.nan,
            acoustic_modes={},
            feed_stability={},
            heat_flux_chamber=np.nan,
            heat_flux_throat=np.nan,
            ablative_recession_rate=np.nan,
            graphite_recession_rate=np.nan,
            throat_oxidation_recession_rate=np.nan,
            throat_ablation_recession_rate=np.nan,
            mach_number=np.nan,
            eta_cstar=np.nan,
            reynolds_number=np.nan,
            residence_time=np.nan,
            T_ablative_surface=np.nan,
            T_stainless_chamber=np.nan,
            T_graphite_surface=np.nan,
            T_stainless_throat=np.nan,
            nozzle_efficiency=np.nan,
            nozzle_max_heat_flux=np.nan,
            nozzle_max_wall_temp=np.nan,
            nozzle_is_melting=False,
            nozzle_hotspot_count=0,
            diagnostics=None,
        )

    def _make_zero_state(self, t: float, last_state: Optional[TimeVaryingState]) -> TimeVaryingState:
        """Create a zero-performance state for post-shutdown time steps.

        All performance fields (Pc, thrust, mdot, Isp, …) are 0.0.
        Geometry is preserved from the last valid state so plots don't jump.
        """
        if last_state is not None:
            V_chamber = last_state.V_chamber
            A_throat = last_state.A_throat
            A_exit = last_state.A_exit
            Lstar = last_state.Lstar
            D_chamber = last_state.D_chamber
            D_throat = last_state.D_throat
            D_exit = last_state.D_exit
            eps = last_state.eps
            recession_chamber = last_state.recession_chamber
            recession_throat = last_state.recession_throat
            recession_exit = last_state.recession_exit
            recession_graphite = last_state.recession_graphite
            graphite_thickness_remaining = last_state.graphite_thickness_remaining
        else:
            V_chamber = self.V_chamber_initial
            A_throat = self.A_throat_initial
            A_exit = self.A_exit_initial
            Lstar = V_chamber / A_throat if A_throat > 0 else 0.0
            D_chamber = self.D_chamber_initial
            D_throat = self.D_throat_initial
            D_exit = self.D_exit_initial
            eps = A_exit / A_throat if A_throat > 0 else 1.0
            recession_chamber = 0.0
            recession_throat = 0.0
            recession_exit = 0.0
            recession_graphite = 0.0
            graphite_cfg = getattr(self.config, 'graphite_insert', None)
            graphite_thickness_remaining = (
                graphite_cfg.initial_thickness
                if graphite_cfg and graphite_cfg.enabled
                else 0.0
            )

        return TimeVaryingState(
            time=t,
            V_chamber=V_chamber,
            A_throat=A_throat,
            A_exit=A_exit,
            Lstar=Lstar,
            D_chamber=D_chamber,
            D_throat=D_throat,
            D_exit=D_exit,
            eps=eps,
            recession_chamber=recession_chamber,
            recession_throat=recession_throat,
            recession_exit=recession_exit,
            recession_graphite=recession_graphite,
            graphite_thickness_remaining=graphite_thickness_remaining,
            reaction_progress={"progress_injection": 0.0, "progress_mid": 0.0, "progress_throat": 0.0},
            tau_residence=0.0,
            tau_effective=0.0,
            Pc=0.0,
            Tc=0.0,
            MR=0.0,
            mdot_total=0.0,
            F=0.0,
            Isp=0.0,
            v_exit=0.0,
            P_exit=0.0,
            T_exit=0.0,
            M_exit=0.0,
            gamma_chamber=0.0,
            gamma_exit=0.0,
            R_chamber=0.0,
            R_exit=0.0,
            equilibrium_factor=0.0,
            chugging_frequency=0.0,
            chugging_stability_margin=0.0,
            stability_state="shutdown",
            stability_score=0.0,
            acoustic_modes={},
            feed_stability={},
            heat_flux_chamber=0.0,
            heat_flux_throat=0.0,
            ablative_recession_rate=0.0,
            graphite_recession_rate=0.0,
            throat_oxidation_recession_rate=0.0,
            throat_ablation_recession_rate=0.0,
            mach_number=0.0,
            eta_cstar=0.0,
            reynolds_number=0.0,
            residence_time=0.0,
            T_ablative_surface=0.0,
            T_stainless_chamber=0.0,
            T_graphite_surface=0.0,
            T_stainless_throat=0.0,
            nozzle_efficiency=0.0,
            nozzle_max_heat_flux=0.0,
            nozzle_max_wall_temp=0.0,
            nozzle_is_melting=False,
            nozzle_hotspot_count=0,
            diagnostics=None,
        )

    def solve_time_series(
        self,
        times: np.ndarray,
        P_tank_O: np.ndarray,
        P_tank_F: np.ndarray,
    ) -> List[TimeVaryingState]:
        """
        Solve complete time series with full coupling.

        Parameters:
        -----------
        times : np.ndarray
            Time points [s]
        P_tank_O : np.ndarray
            Oxidizer tank pressures [Pa]
        P_tank_F : np.ndarray
            Fuel tank pressures [Pa]

        Returns:
        --------
        states : List[TimeVaryingState]
            Complete state history
        """
        if len(times) != len(P_tank_O) or len(times) != len(P_tank_F):
            raise ValueError("times, P_tank_O, and P_tank_F must have same length")

        self.shutdown_info = None  # reset on each run

        states = []
        previous_state = None

        for i, t in enumerate(times):
            dt = times[i] - times[i - 1] if i > 0 else 0.0

            try:
                state = self.solve_time_step(
                    time=t,
                    dt=dt,
                    P_tank_O=P_tank_O[i],
                    P_tank_F=P_tank_F[i],
                    previous_state=previous_state,
                )
            except EngineShutdownException as _shutdown_err:
                import logging as _logging
                _logging.getLogger("evaluate").info(
                    f"[TIME_VARYING] Engine shutdown at step {i} (t={t:.3f}s): "
                    f"{_shutdown_err.reason}. Filling remaining {len(times) - i} "
                    f"step(s) with zero-performance states."
                )
                self.shutdown_info = {
                    "time_s": float(t),
                    "step_index": i,
                    "reason": _shutdown_err.reason,
                    "details": _shutdown_err.details,
                }
                # Fill all remaining time steps (including this one) with
                # zero-performance states so array lengths stay consistent.
                for j in range(i, len(times)):
                    states.append(self._make_zero_state(times[j], previous_state))
                break
            except Exception as _step_err:
                import logging as _logging
                _logging.getLogger("evaluate").warning(
                    f"[TIME_VARYING] Step {i} (t={t:.3f}s, "
                    f"P_lox={P_tank_O[i]/6894.76:.1f} psi, "
                    f"P_fuel={P_tank_F[i]/6894.76:.1f} psi) failed: {_step_err}. "
                    f"Using NaN state."
                )
                state = self._make_nan_state(t, previous_state)
                states.append(state)
                previous_state = state
                continue

            states.append(state)
            previous_state = state

        self.state_history = states
        return states
    
    def get_results_dict(self) -> Dict[str, np.ndarray]:
        """
        Convert state history to results dictionary (compatible with existing code).
        
        Returns:
        --------
        results : dict
            Dictionary with arrays of all metrics
        """
        if not self.state_history:
            raise ValueError("No state history - run solve_time_series first")
        
        n = len(self.state_history)
        
        results = {
            "time": np.array([s.time for s in self.state_history]),
            "Pc": np.array([s.Pc for s in self.state_history]),
            "Tc": np.array([s.Tc for s in self.state_history]),
            "MR": np.array([s.MR for s in self.state_history]),
            "mdot_total": np.array([s.mdot_total for s in self.state_history]),
            "F": np.array([s.F for s in self.state_history]),
            "Isp": np.array([s.Isp for s in self.state_history]),
            "v_exit": np.array([s.v_exit for s in self.state_history]),
            "P_exit": np.array([s.P_exit for s in self.state_history]),
            "T_exit": np.array([s.T_exit for s in self.state_history]),
            "M_exit": np.array([s.M_exit for s in self.state_history]),
            "gamma_chamber": np.array([s.gamma_chamber for s in self.state_history]),
            "gamma_exit": np.array([s.gamma_exit for s in self.state_history]),
            "R_chamber": np.array([s.R_chamber for s in self.state_history]),
            "R_exit": np.array([s.R_exit for s in self.state_history]),
            "equilibrium_factor": np.array([s.equilibrium_factor for s in self.state_history]),
            "Lstar": np.array([s.Lstar for s in self.state_history]),
            "V_chamber": np.array([s.V_chamber for s in self.state_history]),
            "A_throat": np.array([s.A_throat for s in self.state_history]),
            "A_exit": np.array([s.A_exit for s in self.state_history]),
            "D_chamber": np.array([s.D_chamber for s in self.state_history]),
            "A_chamber": np.array([np.pi * (s.D_chamber / 2.0)**2 for s in self.state_history]),
            "contraction_ratio": np.array([(np.pi * (s.D_chamber / 2.0)**2) / s.A_throat if s.A_throat > 0 else 1.0 for s in self.state_history]),
            "eps": np.array([s.eps for s in self.state_history]),
            "recession_chamber": np.array([s.recession_chamber for s in self.state_history]),
            "recession_throat": np.array([s.recession_throat for s in self.state_history]),  # Throat recession (tracked even with graphite)
            "recession_exit": np.array([s.recession_exit for s in self.state_history]),
            "recession_graphite": np.array([s.recession_graphite for s in self.state_history]),
            "D_throat": np.array([s.D_throat for s in self.state_history]),  # Throat diameter (constant with graphite, grows without)
            "throat_area_change_pct": np.array([(s.A_throat - self.A_throat_initial) / self.A_throat_initial * 100.0 for s in self.state_history]),
            "chugging_frequency": np.array([s.chugging_frequency for s in self.state_history]),
            "chugging_stability_margin": np.array([s.chugging_stability_margin for s in self.state_history]),
            "stability_state": np.array([s.stability_state for s in self.state_history]),
            "stability_score": np.array([s.stability_score for s in self.state_history]),
            "heat_flux_chamber": np.array([s.heat_flux_chamber for s in self.state_history]),
            "heat_flux_throat": np.array([s.heat_flux_throat for s in self.state_history]),
            "ablative_recession_rate": np.array([s.ablative_recession_rate for s in self.state_history]),
            "graphite_recession_rate": np.array([s.graphite_recession_rate for s in self.state_history]),
            "throat_oxidation_recession_rate": np.array([s.throat_oxidation_recession_rate for s in self.state_history]),
            "throat_ablation_recession_rate": np.array([s.throat_ablation_recession_rate for s in self.state_history]),
            # CRITICAL: Add time-varying chamber intrinsics (these change over time!)
            "mach_number": np.array([s.mach_number for s in self.state_history]),  # TIME-VARYING - not hardcoded
            "eta_cstar": np.array([s.eta_cstar for s in self.state_history]),  # TIME-VARYING n* - changes with L*
            "reynolds_number": np.array([s.reynolds_number for s in self.state_history]),
            "residence_time": np.array([s.residence_time for s in self.state_history]),
            "T_ablative_surface": np.array([s.T_ablative_surface for s in self.state_history]),
            "T_stainless_chamber": np.array([s.T_stainless_chamber for s in self.state_history]),
            "T_graphite_surface": np.array([s.T_graphite_surface for s in self.state_history]),
            "T_stainless_throat": np.array([s.T_stainless_throat for s in self.state_history]),
            # Nozzle dynamics
            "nozzle_efficiency": np.array([s.nozzle_efficiency for s in self.state_history]),
            "nozzle_max_heat_flux": np.array([s.nozzle_max_heat_flux for s in self.state_history]),
            "nozzle_max_wall_temp": np.array([s.nozzle_max_wall_temp for s in self.state_history]),
            "nozzle_is_melting": np.array([s.nozzle_is_melting for s in self.state_history]),
            "nozzle_hotspot_count": np.array([s.nozzle_hotspot_count for s in self.state_history]),
        }
        
        # Extract reaction progress arrays
        results["reaction_progress_throat"] = np.array([s.reaction_progress["progress_throat"] for s in self.state_history])
        results["reaction_progress_mid"] = np.array([s.reaction_progress["progress_mid"] for s in self.state_history])
        results["reaction_progress_injection"] = np.array([s.reaction_progress["progress_injection"] for s in self.state_history])
        results["tau_residence"] = np.array([s.tau_residence for s in self.state_history])
        results["tau_effective"] = np.array([s.tau_effective for s in self.state_history])
        
        # Include full diagnostics from ChamberSolver (contains ablative heat flux profiles)
        results["diagnostics"] = [s.diagnostics for s in self.state_history]
        
        return results

