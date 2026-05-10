"""Main pipeline orchestrator - runs full tank pressure to thrust pipeline"""

import numpy as np
import logging
import os
from typing import Dict, Any, Optional, Union
import copy

from engine.pipeline.config_schemas import PintleEngineConfig, ensure_chamber_geometry
from engine.pipeline.cea_cache import CEACache
from engine.core.chamber_solver import ChamberSolver
from engine.core.nozzle import calculate_thrust
from engine.core.chamber_profiles import (
    calculate_chamber_pressure_profile,
    calculate_chamber_intrinsics,
)
from engine.pipeline.thermal.ablative_geometry import (
    update_chamber_geometry_from_ablation,
    update_nozzle_exit_from_ablation,
    calculate_local_recession_rate,
)
from engine.pipeline.thermal.graphite_cooling import (
    compute_graphite_recession,
    calculate_throat_heuristic_multiplier,
)
from engine.pipeline.constants import DEFAULT_GAMMA_ND


def compute_ambient_pressure_from_elevation(elevation_m: float) -> float:
    """Compute ambient pressure from elevation using standard atmosphere model.
    
    Uses the barometric formula:
    P = P0 * exp(-M*g*h/(R*T0))
    
    Parameters:
    -----------
    elevation_m : float
        Elevation above sea level [m]
    
    Returns:
    --------
    float
        Ambient pressure [Pa]
    
    Reference values:
        P0 = 101325 Pa (sea level pressure)
        M = 0.0289644 kg/mol (molar mass of dry air)
        g = 9.80665 m/s² (standard gravity)
        R = 8.31447 J/(mol·K) (universal gas constant)
        T0 = 288.15 K (sea level temperature, 15°C)
    """
    P0 = 101325.0  # Pa
    M = 0.0289644  # kg/mol
    g = 9.80665    # m/s²
    R = 8.31447    # J/(mol·K)
    T0 = 288.15    # K
    return P0 * np.exp(-M * g * elevation_m / (R * T0))


class PintleEngineRunner:
    """Main pipeline runner - orchestrates full tank pressure to thrust calculation"""
    
    def __init__(self, config: PintleEngineConfig):
        """
        Initialize pipeline runner.
        
        Parameters:
        -----------
        config : PintleEngineConfig
            Engine configuration (should be a deep copy if isolation is needed)
        """
        # Store config reference - caller is responsible for ensuring isolation
        # (deep copy is done in Layer 3 before passing config to runner)
        self.config = config
        cg = ensure_chamber_geometry(self.config)
        
        # Initialize CEA cache
        self.cea_cache = CEACache(config.combustion.cea)
        
        # Initialize chamber solver
        self.solver = ChamberSolver(config, self.cea_cache)
    
    def _get_ambient_pressure(self, P_ambient: Optional[float] = None) -> float:
        """Get ambient pressure, computing from config elevation if not provided.
        
        Parameters:
        -----------
        P_ambient : float, optional
            Explicit ambient pressure [Pa]. If None, computed from config.
        
        Returns:
        --------
        float
            Ambient pressure [Pa]
        """
        if P_ambient is not None:
            return P_ambient
        
        # Compute from config environment elevation if available
        if hasattr(self.config, 'environment') and self.config.environment is not None:
            elevation = getattr(self.config.environment, 'elevation', None)
            if elevation is not None and elevation >= 0:
                return compute_ambient_pressure_from_elevation(elevation)
        
        # Default to sea level
        return 101325.0
    
    def _get_elevation(self) -> float:
        """Get elevation from config, or 0.0 if not available."""
        if hasattr(self.config, 'environment') and self.config.environment is not None:
            return getattr(self.config.environment, 'elevation', 0.0) or 0.0
        return 0.0
    
    def evaluate(
        self,
        P_tank_O: float,
        P_tank_F: float,
        Pc_guess: Optional[float] = None,
        P_ambient: Optional[float] = None,
        debug: bool = False,
        silent: bool = False
    ) -> Dict[str, Any]:
        """
        Evaluate engine performance at given tank pressures.
        
        Parameters:
        -----------
        P_tank_O : float
            Oxidizer tank pressure [Pa]
        P_tank_F : float
            Fuel tank pressure [Pa]
        Pc_guess : float, optional
            Initial guess for chamber pressure [Pa]
        P_ambient : float, optional
            Ambient pressure [Pa]. If None, computed from config environment
            elevation using standard atmosphere model.
        debug : bool, optional
            If True, enables debug logging to output/logs/evaluate.log and prints
            detailed execution traces. Defaults to False.
        
        Returns:
        --------
        results : dict
            Dictionary containing all performance metrics:
            - Pc: Chamber pressure [Pa]
            - mdot_O: Oxidizer mass flow [kg/s]
            - mdot_F: Fuel mass flow [kg/s]
            - MR: Mixture ratio (O/F)
            - F: Thrust [N]
            - Isp: Specific impulse [s]
            - cstar_actual: Actual characteristic velocity [m/s]
            - P_ambient: Ambient pressure used [Pa]
            - elevation: Elevation from config [m]
            - diagnostics: Detailed diagnostics dict
        
        Raises:
        -------
        ValueError
            If any physics validation fails (invalid values, out of range, etc.)
        KeyError
            If required data is missing from results
        RuntimeError
            If solver fails to converge or calculation fails
        """
        # Wrap entire evaluation in try-except to log errors before re-raising
        try:
            return self._evaluate_internal(P_tank_O, P_tank_F, Pc_guess, P_ambient, debug, silent)
        except Exception as e:
            # Log error with full traceback if debug is enabled
            if debug:
                logger = logging.getLogger("evaluate")
                logger.error("="*80)
                logger.error("[EVALUATION FAILED]")
                logger.error(f"Error type: {type(e).__name__}")
                logger.error(f"Error message: {str(e)}")
                logger.error(f"Inputs: P_tank_O={P_tank_O/6894.76:.2f} psi, P_tank_F={P_tank_F/6894.76:.2f} psi")
                logger.error("Full traceback:", exc_info=True)
                logger.error("="*80)
            # Re-raise the exception to crash the program as intended
            raise
    
    def _evaluate_internal(
        self,
        P_tank_O: float,
        P_tank_F: float,
        Pc_guess: Optional[float] = None,
        P_ambient: Optional[float] = None,
        debug: bool = False,
        silent: bool = False
    ) -> Dict[str, Any]:
        """Internal evaluation implementation (wrapped by evaluate() for error logging)."""
        # Configure logging
        logger = logging.getLogger("evaluate")
        logger.propagate = False  # Prevent double logging to root logger
        
        if debug:
            log_dir = "output/logs"
            os.makedirs(log_dir, exist_ok=True)
            log_file = os.path.join(log_dir, "evaluate.log")
            
            # Remove existing handlers to avoid duplicates
            for handler in logger.handlers[:]:
                logger.removeHandler(handler)
            
            logger.setLevel(logging.DEBUG)
            
            # File handler
            fh = logging.FileHandler(log_file, mode='w')
            fh.setLevel(logging.DEBUG)
            file_formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
            fh.setFormatter(file_formatter)
            logger.addHandler(fh)
            
            # Console handler
            ch = logging.StreamHandler()
            ch.setLevel(logging.INFO)
            console_formatter = logging.Formatter('%(message)s')
            ch.setFormatter(console_formatter)
            logger.addHandler(ch)
            
            logger.info("Debug logging enabled. Writing to %s", log_file)
        else:
            # Remove existing handlers
            for handler in logger.handlers[:]:
                logger.removeHandler(handler)
            
            logger.setLevel(logging.INFO)
            
            # Only add console handler if not silent
            if not silent:
                ch = logging.StreamHandler()
                ch.setLevel(logging.INFO)
                console_formatter = logging.Formatter('%(message)s')
                ch.setFormatter(console_formatter)
                logger.addHandler(ch)

        # Helper to log messages
        def log_info(msg):
            logger.info(msg)

        # Get ambient pressure (from config elevation if not provided)
        Pa = self._get_ambient_pressure(P_ambient)
        elevation = self._get_elevation()
        
        # Ensure chamber_geometry exists
        cg = ensure_chamber_geometry(self.config)
        
        # Print chamber geometry at start of evaluation (exclude design parameters)
        # Print chamber geometry at start of evaluation (exclude design parameters)
        log_info("\n" + "="*80)
        log_info("[CHAMBER GEOMETRY] Loaded configuration:")
        log_info(f"  Volume:           {cg.volume*1e6:.2f} cm³ ({cg.volume:.6e} m³)")
        log_info(f"  A_throat:         {cg.A_throat*1e6:.4f} mm² ({cg.A_throat:.6e} m²)")
        log_info(f"  A_exit:           {cg.A_exit*1e6:.4f} mm² ({cg.A_exit:.6e} m²)")
        log_info(f"  Expansion Ratio:  {cg.expansion_ratio:.4f}")
        log_info(f"  Nozzle Efficiency:{cg.nozzle_efficiency:.4f}")
        if cg.length:
            log_info(f"  Length:           {cg.length*1000:.2f} mm")
        if cg.Lstar:
            log_info(f"  L* (config):      {cg.Lstar*1000:.2f} mm")
        if cg.chamber_diameter:
            log_info(f"  Chamber Diameter: {cg.chamber_diameter*1000:.2f} mm")
        # if cg.contraction_ratio:
        #     log_info(f"  Contraction Ratio:{cg.contraction_ratio:.4f}")
        log_info("="*80 + "\n")
        
        # Solve for chamber pressure
        Pc, diagnostics = self.solver.solve(P_tank_O, P_tank_F, Pc_guess, debug=debug)
        

        At = cg.A_throat
        
        # Validate all required diagnostics are present
        required_keys = ["cstar_actual", "mdot_O", "mdot_F", "MR", "gamma", "R", "Tc"]
        for key in required_keys:
            if key not in diagnostics:
                raise KeyError(f"Missing required diagnostic '{key}' from chamber solver")
        
        cstar = diagnostics["cstar_actual"]
        mdot = diagnostics["mdot_O"] + diagnostics["mdot_F"]

        # Validate cstar and At before using
        if At <= 0:
            raise ValueError(f"Invalid throat area: At={At:.6e} m². Must be positive.")
        
        if cstar <= 0:
            raise ValueError(f"Invalid c*: {cstar:.2f} m/s. Must be positive.")
        
        if mdot <= 0:
            raise ValueError(f"Invalid mass flow: mdot={mdot:.4f} kg/s. Must be positive.")
        
        mdot_choked = Pc * At / cstar
        ratio = mdot / mdot_choked

        # Get final mass flow rates
        mdot_O = diagnostics["mdot_O"]
        mdot_F = diagnostics["mdot_F"]
        mdot_total = mdot_O + mdot_F
        MR = diagnostics["MR"]
        
        cstar_actual = diagnostics["cstar_actual"]
        gamma = diagnostics["gamma"]
        R = diagnostics["R"]
        Tc = diagnostics["Tc"]

        # Calculate implied c* from choked flow equation
        if mdot_total <= 0:
            raise ValueError(f"Invalid total mass flow: mdot_total={mdot_total} kg/s. Must be positive.")
        
        cstar_implied = Pc * At / mdot_total
        cstar_cea = cstar_actual
        
        # Validate cstar_cea for ratio calculation
        if cstar_cea <= 0:
            raise ValueError(f"Invalid cstar_cea: {cstar_cea} m/s. Must be positive.")
        
        if mdot_choked <= 0:
            raise ValueError(f"Invalid mdot_choked: {mdot_choked} kg/s. Must be positive.")
    
        log_info(
            f"[COUPLING] Pc={Pc/6894.757:.1f} psi, At={At*1e6:.1f} mm^2, "
            f"c*_CEA={cstar_cea:.1f} m/s, c*_implied={cstar_implied:.1f} m/s, "
            f"ratio={cstar_implied/cstar_cea:.3f}, "
            f"mdot={mdot_total:.3f} kg/s, mdot_choked={mdot_choked:.3f} kg/s, "
            f"mdot_ratio={mdot_total/mdot_choked:.3f}"
        )
        
        # Calculate thrust using computed ambient pressure
        
        
        log_info(
            f"[RUNNER][GEOM] At={cg.A_throat:.6e} m^2, Ae={cg.A_exit:.6e} m^2, "
            f"eps={cg.expansion_ratio:.4f}, eff={cg.nozzle_efficiency:.3f}"
        )
        log_info(f"[RUNNER][STATE] Pc={Pc:.3e} Pa, Pa={Pa:.3e} Pa, MR={MR:.4f}, mdot={mdot_total:.4f} kg/s")

        # Check if shifting equilibrium is enabled
        use_shifting = getattr(self.config.combustion.efficiency, 'use_shifting_equilibrium', True)
        reaction_progress = diagnostics.get("reaction_progress", None)
        
        cea_noz = self.cea_cache.eval(MR, Pc, Pa, cg.expansion_ratio)
        log_info(
            f"[THERMO] chamber: Tc={Tc:.1f} K gamma={gamma:.4f} R={R:.2f} c*_actual={cstar_actual:.1f} | "
            f"CEA(noz): Tc={cea_noz['Tc']:.1f} K gamma={cea_noz['gamma']:.4f} R={cea_noz['R']:.2f} c*_ideal={cea_noz['cstar_ideal']:.1f}"
        )


        thrust_results = calculate_thrust(
            Pc,
            MR,
            mdot_total,
            self.cea_cache,
            self.config,
            Pa,
            reaction_progress=reaction_progress,  # Pass reaction progress for shifting equilibrium
            use_shifting_equilibrium=use_shifting,
            debug=debug,
        )
        
        # Extract thrust results - all required fields
        required_thrust_keys = ["F", "Isp", "v_exit", "P_exit", "P_throat", "T_exit", "T_throat", 
                                 "M_exit", "Cf_actual", "Cf_ideal", "Cf_theoretical"]
        for key in required_thrust_keys:
            if key not in thrust_results:
                raise KeyError(
                    f"Missing required thrust result '{key}'. "
                    f"calculate_thrust() must return all required fields."
                )
        
        F = thrust_results["F"]
        Isp = thrust_results["Isp"]
        v_exit = thrust_results["v_exit"]
        P_exit = thrust_results["P_exit"]
        P_throat = thrust_results["P_throat"]
        T_exit = thrust_results["T_exit"]
        T_throat = thrust_results["T_throat"]
        M_exit = thrust_results["M_exit"]
        
        # Shifting equilibrium results - these have defaults since they're only present when enabled
        gamma_exit = thrust_results.get("gamma_exit")
        R_exit = thrust_results.get("R_exit")
        
        if gamma_exit is None:
            gamma_exit = gamma  # Use chamber gamma if shifting equilibrium not enabled
        if R_exit is None:
            R_exit = R  # Use chamber R if shifting equilibrium not enabled
        
        Cf_actual = thrust_results["Cf_actual"]
        Cf_ideal = thrust_results["Cf_ideal"]
        Cf_theoretical = thrust_results["Cf_theoretical"]
        temperature_profile = thrust_results.get("temperature_profile")  # Optional

        # Cooling results - optional
        cooling_results = diagnostics.get("cooling")
        if cooling_results is None:
            cooling_results = {}  # Empty dict if no cooling
        
        # Use Lstar from config if available, otherwise calculate from geometry
        current_Lstar = cg.Lstar if cg.Lstar is not None else (cg.volume / cg.A_throat if cg.A_throat > 0 else 0)
        
        # Calculate chamber pressure profile along length
        pressure_profile = None
        try:
            pressure_profile = calculate_chamber_pressure_profile(
                Pc=Pc,
                Lstar=current_Lstar,
                mdot_total=mdot_total,
                gamma=gamma,
                R=R,
                Tc=Tc,
                A_throat=cg.A_throat,
                n_points=30,
            )
        except Exception as e:
            import warnings
            warnings.warn(f"Pressure profile calculation failed: {e}")
        
        # Calculate chamber intrinsics
        # Pass ambient pressure (Pa) for choking check, or use 0.9 * 1 atm as fallback
        chamber_intrinsics = None
        try:
            chamber_intrinsics = calculate_chamber_intrinsics(
                Pc=Pc,
                Tc=Tc,
                mdot_total=mdot_total,
                gamma=gamma,
                R=R,
                V_chamber=cg.volume,
                A_throat=cg.A_throat,
                Lstar=current_Lstar,
                MR=MR,
                P_back=Pa,  # Pass ambient pressure for choking verification
            )
        except Exception as e:
            import traceback
            log_info(f"WARNING: Chamber intrinsics calculation failed: {type(e).__name__}: {e}")
            if debug:
                log_info(f"Traceback: {''.join(traceback.format_exc())}")
            import warnings
            warnings.warn(f"Chamber intrinsics calculation failed: {e}")
        
        # Extract injector pressure diagnostics from closure diagnostics
        injector_pressure_diagnostics = {
            "P_injector_O": diagnostics.get("P_injector_O"),
            "P_injector_F": diagnostics.get("P_injector_F"),
            "delta_p_injector_O": diagnostics.get("delta_p_injector_O"),
            "delta_p_injector_F": diagnostics.get("delta_p_injector_F"),
            "delta_p_feed_O": diagnostics.get("delta_p_feed_O"),
            "delta_p_feed_F": diagnostics.get("delta_p_feed_F"),
        }
        
        # Extract discharge coefficients
        Cd_O = diagnostics.get("Cd_O", np.nan)
        Cd_F = diagnostics.get("Cd_F", np.nan)
        
        # Calculate stability analysis if enabled
        stability_results = {
            "stability_state": "unstable",
            "stability_score": 0.0,
            "is_stable": False,
            "chugging": {"frequency": 0.0, "stability_margin": 0.0, "stability_index": 0.0, "period": 0.0, "tau_residence": 0.0, "Lstar": 0.0},
            "acoustic": {"stability_margin": 0.0, "modes": {}, "longitudinal_modes": [], "transverse_modes": [], "sound_speed": 0.0},
            "feed_system": {"pogo_frequency": 0.0, "surge_frequency": 0.0, "water_hammer_margin": 0.0, "stability_margin": 0.0, "sound_speed": 0.0},
            "mode_coupling": [],
            "Lstar": 0.0,
            "issues": ["Stability analysis not available"],
            "recommendations": [],
        }
        try:
            from engine.pipeline.stability.analysis import comprehensive_stability_analysis
            
            stability_results = comprehensive_stability_analysis(
                config=self.config,
                Pc=Pc,
                MR=MR,
                mdot_total=mdot_total,
                cstar=cstar_actual,
                gamma=gamma,
                R=R,
                Tc=Tc,
                diagnostics=diagnostics,
            )
        except Exception as e:
            import warnings
            warnings.warn(f"Stability analysis failed: {e}")
            # Keep default empty structure above
        
        # Compile results
        results = {
            "Pc": Pc,
            "mdot_O": mdot_O,
            "mdot_F": mdot_F,
            "mdot_total": mdot_total,
            "MR": MR,
            "F": F,
            "Isp": Isp,
            "v_exit": v_exit,
            "M_exit": M_exit,  # Exit Mach number
            "P_exit": P_exit,
            "P_throat": P_throat,
            "T_exit": T_exit,
            "T_throat": T_throat,
            "Tc": Tc,
            "Cf": Cf_actual,  # Actual measured Cf
            "Cf_actual": Cf_actual,
            "Cf_ideal": Cf_ideal,
            "Cf_theoretical": Cf_theoretical,
            "temperature_profile": temperature_profile,
            "eps": cg.expansion_ratio,  # Expansion ratio
            "A_throat": cg.A_throat,
            "A_exit": cg.A_exit,
            "cstar_actual": cstar_actual,
            "cstar_ideal": diagnostics["cstar_ideal"],
            "eta_cstar": diagnostics["eta_cstar"],
            "gamma": gamma,
            "gamma_exit": gamma_exit,  # Exit gamma (for shifting equilibrium)
            "R": R,
            "R_exit": R_exit,  # Exit gas constant (for shifting equilibrium)
            "Cd_O": Cd_O,
            "Cd_F": Cd_F,
            "cooling": cooling_results,
            "stability": stability_results,
            "stability_results": stability_results,  # Alias for compatibility with optimization code
            "pressure_profile": pressure_profile,
            "chamber_intrinsics": chamber_intrinsics,
            "injector_pressure": injector_pressure_diagnostics,
            "P_ambient": Pa,  # Ambient pressure used for thrust calculation
            "elevation": elevation,  # Elevation from config (0 if not set)
            "diagnostics": diagnostics,
        }
        
        # Print comprehensive results summary
        log_info("\n" + "="*80)
        log_info("[PERFORMANCE SUMMARY]")
        log_info(f"  Thrust:           {F/1000:.3f} kN ({F:.2f} N)")
        log_info(f"  Specific Impulse: {Isp:.2f} s")
        log_info(f"  Chamber Pressure: {Pc/6894.76:.2f} psi ({Pc/1e6:.4f} MPa)")
        log_info(f"  Mixture Ratio:    {MR:.4f} (O/F)")
        log_info(f"  Total Mass Flow:  {mdot_total:.4f} kg/s (O: {mdot_O:.4f}, F: {mdot_F:.4f})")
        log_info(f"  c* (actual):      {cstar_actual:.2f} m/s")
        log_info(f"  c* (ideal):       {diagnostics['cstar_ideal']:.2f} m/s")
        log_info(f"  η_c*:             {diagnostics['eta_cstar']:.4f}")
        log_info(f"  Cf (actual):      {Cf_actual:.4f}")
        log_info(f"  Cf (ideal):       {Cf_ideal:.4f}")
        log_info(f"  Exit Velocity:    {v_exit:.2f} m/s")
        log_info(f"  Exit Mach:        {M_exit:.3f}")
        log_info(f"  Exit Pressure:    {P_exit/6894.76:.2f} psi ({P_exit/1e3:.2f} kPa)")
        log_info(f"  Temperatures:     Tc={Tc:.1f} K, T_throat={T_throat:.1f} K, T_exit={T_exit:.1f} K")
        log_info(f"  γ (chamber/exit): {gamma:.4f} / {gamma_exit:.4f}")
        log_info(f"  R (chamber/exit): {R:.2f} / {R_exit:.2f} J/(kg·K)")
        log_info("-"*80)
        
        log_info("[INJECTOR PRESSURE DROPS]")
        if injector_pressure_diagnostics.get("P_injector_O") is not None:
            log_info(f"  P_injector (LOX): {injector_pressure_diagnostics['P_injector_O']/6894.76:.2f} psi")
        if injector_pressure_diagnostics.get("P_injector_F") is not None:
            log_info(f"  P_injector (Fuel):{injector_pressure_diagnostics['P_injector_F']/6894.76:.2f} psi")
        if injector_pressure_diagnostics.get("delta_p_injector_O") is not None:
            log_info(f"  ΔP_inj (LOX):     {injector_pressure_diagnostics['delta_p_injector_O']/6894.76:.2f} psi")
        if injector_pressure_diagnostics.get("delta_p_injector_F") is not None:
            log_info(f"  ΔP_inj (Fuel):    {injector_pressure_diagnostics['delta_p_injector_F']/6894.76:.2f} psi")
        if injector_pressure_diagnostics.get("delta_p_feed_O") is not None:
            log_info(f"  ΔP_feed (LOX):    {injector_pressure_diagnostics['delta_p_feed_O']/6894.76:.2f} psi")
        if injector_pressure_diagnostics.get("delta_p_feed_F") is not None:
            log_info(f"  ΔP_feed (Fuel):   {injector_pressure_diagnostics['delta_p_feed_F']/6894.76:.2f} psi")
        log_info("-"*80)
        
        log_info("[CHAMBER INTRINSICS]")
        if chamber_intrinsics:
            log_info(f"  L*:               {chamber_intrinsics.get('Lstar', 0)*1000:.2f} mm")
            log_info(f"  Residence Time:   {chamber_intrinsics.get('residence_time', 0)*1000:.3f} ms")
            log_info(f"  Velocity (mean):  {chamber_intrinsics.get('velocity_mean', 0):.2f} m/s")
            log_info(f"  Velocity (throat):{chamber_intrinsics.get('velocity_throat', 0):.2f} m/s")
            log_info(f"  Gas Density:      {chamber_intrinsics.get('density', 0):.3f} kg/m³")
            log_info(f"  Sound Speed:      {chamber_intrinsics.get('sound_speed', 0):.2f} m/s")
            log_info(f"  Mach (chamber):   {chamber_intrinsics.get('mach_number', 0):.4f}")
            log_info(f"  Reynolds Number:  {chamber_intrinsics.get('reynolds_number', 0):.2e}")
        else:
            log_info("  (Chamber intrinsics calculation failed)")
        log_info("="*80 + "\n")
        
        return results  # End of _evaluate_internal()
    
    def evaluate_arrays(
        self,
        P_tank_O: Union[np.ndarray, list],
        P_tank_F: Union[np.ndarray, list],
        P_ambient: Optional[float] = None
    ) -> Dict[str, np.ndarray]:
        """
        Evaluate engine performance for arrays of tank pressures (time series).
        
        Parameters:
        -----------
        P_tank_O : array-like
            Array of oxidizer tank pressures [Pa]
        P_tank_F : array-like
            Array of fuel tank pressures [Pa]
        P_ambient : float, optional
            Ambient pressure [Pa]. If None, defaults to sea level (101325 Pa).
            This is used for thrust calculation and should match the target exit pressure
            for accurate performance evaluation.
        
        Returns:
        --------
        results : dict
            Dictionary with arrays of all performance metrics
        """
        P_tank_O = np.asarray(P_tank_O)
        P_tank_F = np.asarray(P_tank_F)
        
        if P_tank_O.shape != P_tank_F.shape:
            raise ValueError("P_tank_O and P_tank_F must have same shape")
        
        # Initialize result arrays
        n = P_tank_O.size
        results = {
            "Pc": np.full(n, np.nan),
            "mdot_O": np.full(n, np.nan),
            "mdot_F": np.full(n, np.nan),
            "mdot_total": np.full(n, np.nan),
            "MR": np.full(n, np.nan),
            "F": np.full(n, np.nan),
            "Isp": np.full(n, np.nan),
            "v_exit": np.full(n, np.nan),
            "P_exit": np.full(n, np.nan),
            "eps": np.full(n, np.nan),  # Expansion ratio
            "A_throat": np.full(n, np.nan),
            "A_exit": np.full(n, np.nan),
            "cstar_actual": np.full(n, np.nan),
            "cstar_ideal": np.full(n, np.nan),
            "eta_cstar": np.full(n, np.nan),
            "Tc": np.full(n, np.nan),
            "gamma": np.full(n, np.nan),
            "R": np.full(n, np.nan),
            "Cd_O": np.full(n, np.nan),
            "Cd_F": np.full(n, np.nan),
            "diagnostics": [],
        }
        
        # Evaluate at each point
        for i in range(n):
            try:
                point_results = self.evaluate(
                    float(P_tank_O.flat[i]),
                    float(P_tank_F.flat[i]),
                    P_ambient=P_ambient
                )
                
                # Store scalar results (including eps for 3D CEA cache)
                for key in ["Pc", "mdot_O", "mdot_F", "mdot_total", "MR", "F", "Isp",
                           "v_exit", "P_exit", "eps", "A_throat", "A_exit",
                           "cstar_actual", "cstar_ideal", "eta_cstar",
                           "Tc", "gamma", "R", "Cd_O", "Cd_F"]:
                    results[key][i] = point_results[key]
                
                # Store diagnostics
                results["diagnostics"].append(point_results["diagnostics"])
                
            except Exception as e:
                # If solve fails, leave NaN values
                results["diagnostics"].append({"error": str(e)})
                continue
        
        return results
    
    def evaluate_arrays_with_time(
        self,
        times: Union[np.ndarray, list],
        P_tank_O: Union[np.ndarray, list],
        P_tank_F: Union[np.ndarray, list],
        track_ablative_geometry: Optional[bool] = None,
        use_coupled_solver: bool = True,  # NEW: Use fully-coupled solver
        P_ambient: Optional[float] = None,
    ) -> Dict[str, np.ndarray]:
        """
        Evaluate engine performance over time with ablative geometry evolution.
        
        This method tracks cumulative ablative recession and updates chamber
        geometry (V_chamber, A_throat, L*) at each time step, providing
        accurate performance predictions for ablative engines.
        
        Parameters:
        -----------
        times : array-like
            Time points [s]
        P_tank_O : array-like
            Array of oxidizer tank pressures [Pa]
        P_tank_F : array-like
            Array of fuel tank pressures [Pa]
        track_ablative_geometry : bool, optional
            Override config setting for geometry tracking
        P_ambient : float, optional
            Ambient pressure [Pa]. If None, defaults to sea level (101325 Pa).
            This is used for thrust calculation and should match the target exit pressure
            for accurate performance evaluation.
        
        Returns:
        --------
        results : dict
            Dictionary with arrays of all performance metrics plus:
            - Lstar: Time-varying characteristic length [m]
            - V_chamber: Time-varying chamber volume [m³]
            - A_throat: Time-varying throat area [m²]
            - recession_chamber: Cumulative chamber recession [m]
            - recession_throat: Cumulative throat recession [m]
        """
        times = np.asarray(times)
        P_tank_O = np.asarray(P_tank_O)
        P_tank_F = np.asarray(P_tank_F)
        
        if times.shape != P_tank_O.shape or times.shape != P_tank_F.shape:
            raise ValueError("times, P_tank_O, and P_tank_F must have same shape")
        
        if len(times) < 2:
            raise ValueError("Need at least 2 time points for time-varying analysis")
        
        # Check if ablative geometry tracking is enabled
        ablative_cfg = self.config.ablative_cooling
        if track_ablative_geometry is None:
            track_ablative_geometry = (
                ablative_cfg is not None 
                and ablative_cfg.enabled 
                and ablative_cfg.track_geometry_evolution
            )
        
        # Use fully-coupled solver if enabled (recommended for complete analysis)
        # This solver integrates ALL systems simultaneously:
        # - Reaction chemistry → shifting equilibrium
        # - Geometry evolution → chamber dynamics
        # - Ablative/graphite recession → geometry
        # - Stability analysis → all time-varying effects
        if use_coupled_solver and track_ablative_geometry:
            try:
                from engine.pipeline.time_varying_solver import TimeVaryingCoupledSolver
                
                solver = TimeVaryingCoupledSolver(self.config, self.cea_cache)
                states = solver.solve_time_series(times, P_tank_O, P_tank_F)
                results = solver.get_results_dict()
                
                # Add additional metrics for compatibility
                results["mdot_O"] = results["mdot_total"] * results["MR"] / (1.0 + results["MR"])
                results["mdot_F"] = results["mdot_total"] / (1.0 + results["MR"])
                results["cstar_actual"] = results["Pc"] * results["A_throat"] / results["mdot_total"]
                results["cstar_ideal"] = results["cstar_actual"] / 0.85  # Approximate
                results["eta_cstar"] = results["cstar_actual"] / results["cstar_ideal"]
                results["gamma"] = results["gamma_chamber"]
                results["R"] = results["R_chamber"]
                # diagnostics now comes from get_results_dict() - contains ablative heat flux profiles
                
                return results
            except Exception as e:
                # STRICT MODE: if graphite insert is enabled, do NOT silently fall back.
                # The legacy solver does not have enough information to run the strict
                # graphite oxidation model without hidden defaults.
                graphite_cfg = getattr(self.config, "graphite_insert", None)
                if graphite_cfg is not None and getattr(graphite_cfg, "enabled", False):
                    raise

                import warnings
                warnings.warn(f"Fully-coupled solver failed: {e}. Falling back to standard solver.")
                # Fall through to standard solver
        
        # Initialize result arrays
        n = len(times)
        results = {
            "Pc": np.full(n, np.nan),
            "mdot_O": np.full(n, np.nan),
            "mdot_F": np.full(n, np.nan),
            "mdot_total": np.full(n, np.nan),
            "MR": np.full(n, np.nan),
            "F": np.full(n, np.nan),
            "Isp": np.full(n, np.nan),
            "v_exit": np.full(n, np.nan),
            "P_exit": np.full(n, np.nan),
            "cstar_actual": np.full(n, np.nan),
            "cstar_ideal": np.full(n, np.nan),
            "eta_cstar": np.full(n, np.nan),
            "Tc": np.full(n, np.nan),
            "gamma": np.full(n, np.nan),
            "R": np.full(n, np.nan),
            "Cd_O": np.full(n, np.nan),
            "Cd_F": np.full(n, np.nan),
            "Lstar": np.full(n, np.nan),
            "V_chamber": np.full(n, np.nan),
            "A_throat": np.full(n, np.nan),
            "A_exit": np.full(n, np.nan),
            "eps": np.full(n, np.nan),  # Expansion ratio
            "recession_chamber": np.full(n, 0.0),
            "recession_throat": np.full(n, 0.0),
            "recession_exit": np.full(n, 0.0),
            "throat_recession_multiplier": np.full(n, np.nan),
            "diagnostics": [],
            # Stability arrays (comprehensive analysis for all 3 types)
            "chugging_stability_margin": np.full(n, np.nan),
            "stability_score": np.full(n, np.nan),
            "stability_state": np.full(n, "unstable", dtype=object),
        }
        
        # Ensure chamber_geometry exists
        self.config.chamber_geometry = ensure_chamber_geometry(self.config)
        cg = self.config.chamber_geometry
        
        # Initial geometry
        V_chamber_initial = cg.volume
        A_throat_initial = cg.A_throat
        A_exit_initial = cg.A_exit
        L_chamber = cg.length if cg.length else 0.18
        # FIXED: Add safety checks for sqrt operations
        D_chamber_initial = np.sqrt(max(0, 4 * V_chamber_initial / (np.pi * L_chamber))) if L_chamber > 0 else 0.1
        D_throat_initial = np.sqrt(max(0, 4 * A_throat_initial / np.pi)) if A_throat_initial > 0 else 0.015
        D_exit_initial = np.sqrt(max(0, 4 * A_exit_initial / np.pi)) if A_exit_initial > 0 else 0.1
        
        # Track cumulative recession
        cumulative_recession_chamber = 0.0
        cumulative_recession_throat = 0.0
        cumulative_recession_exit = 0.0
        
        # Create a mutable config copy for geometry updates
        config_copy = copy.deepcopy(self.config)
        
        # Evaluate at each time point
        for i in range(n):
            dt = times[i] - times[i-1] if i > 0 else 0.0
            
            try:
                # Update solver with current geometry
                solver_temp = ChamberSolver(config_copy, self.cea_cache)
                
                # Evaluate performance using the updated solver
                # (NOT self.evaluate which uses the original geometry!)
                Pc, diagnostics = solver_temp.solve(
                    float(P_tank_O[i]),
                    float(P_tank_F[i]),
                    Pc_guess=None
                )
                
                # Calculate thrust and performance
                # Use provided ambient pressure or default to sea level (101325 Pa)
                Pa = P_ambient if P_ambient is not None else 101325.0  # Ambient pressure
                
                # Ensure expansion ratio is consistent for calculate_thrust
                cg = config_copy.chamber_geometry
                if cg.A_throat and cg.A_exit:
                    cg.expansion_ratio = cg.A_exit / cg.A_throat
                
                thrust_results = calculate_thrust(
                    Pc,
                    diagnostics["MR"],
                    diagnostics["mdot_total"],
                    self.cea_cache,
                    config_copy,
                    Pa,
                )
                thrust = thrust_results["F"]
                v_exit = thrust_results["v_exit"]
                P_exit = thrust_results["P_exit"]
                
                # Package results like evaluate() does
                point_results = {
                    "Pc": Pc,
                    "mdot_O": diagnostics["mdot_O"],
                    "mdot_F": diagnostics["mdot_F"],
                    "mdot_total": diagnostics["mdot_total"],
                    "MR": diagnostics["MR"],
                    "F": thrust,
                    "Isp": thrust / (diagnostics["mdot_total"] * 9.80665) if diagnostics["mdot_total"] > 0 else 0.0,
                    "v_exit": v_exit,
                    "P_exit": P_exit,
                    "cstar_actual": diagnostics["cstar_actual"],
                    "cstar_ideal": diagnostics["cstar_ideal"],
                    "eta_cstar": diagnostics["eta_cstar"],
                    "Tc": diagnostics["Tc"],
                    "gamma": diagnostics["gamma"],
                    "R": diagnostics["R"],
                    "Cd_O": diagnostics.get("Cd_O", np.nan),
                    "Cd_F": diagnostics.get("Cd_F", np.nan),
                    "diagnostics": diagnostics,
                }
                
                # Store scalar results
                for key in ["Pc", "mdot_O", "mdot_F", "mdot_total", "MR", "F", "Isp",
                           "v_exit", "P_exit", "cstar_actual", "cstar_ideal", "eta_cstar",
                           "Tc", "gamma", "R", "Cd_O", "Cd_F"]:
                    results[key][i] = point_results[key]
                
                # Store current geometry
                if track_ablative_geometry:
                    # If geometry is evolving, calculate the instantaneous L*
                    results["Lstar"][i] = cg.volume / cg.A_throat if cg.A_throat > 0 else (cg.Lstar or 0)
                else:
                    # Otherwise use the nominal value from config
                    results["Lstar"][i] = cg.Lstar if cg.Lstar is not None else (cg.volume / cg.A_throat if cg.A_throat > 0 else 0)
                results["V_chamber"][i] = cg.volume
                results["A_throat"][i] = cg.A_throat
                results["A_exit"][i] = cg.A_exit
                results["eps"][i] = cg.expansion_ratio  # Store expansion ratio
                results["recession_chamber"][i] = cumulative_recession_chamber
                results["recession_throat"][i] = cumulative_recession_throat
                results["recession_exit"][i] = cumulative_recession_exit
                
                # Store diagnostics
                results["diagnostics"].append(point_results["diagnostics"])
                
                # Calculate comprehensive stability analysis (accounts for chugging, acoustic, and feed system)
                try:
                    from engine.pipeline.stability.analysis import comprehensive_stability_analysis
                    
                    # Build diagnostics dict for comprehensive analysis
                    stability_diagnostics = {
                        "mdot_O": diagnostics["mdot_O"],
                        "mdot_F": diagnostics["mdot_F"],
                        "P_tank_O": float(P_tank_O[i]),
                        "P_tank_F": float(P_tank_F[i]),
                    }
                    
                    stability_results = comprehensive_stability_analysis(
                        config=config_copy,
                        Pc=Pc,
                        MR=diagnostics["MR"],
                        mdot_total=diagnostics["mdot_total"],
                        cstar=diagnostics["cstar_actual"],
                        gamma=diagnostics["gamma"],
                        R=diagnostics["R"],
                        Tc=diagnostics["Tc"],
                        diagnostics=stability_diagnostics,
                    )
                    
                    # Extract stability metrics
                    results["chugging_stability_margin"][i] = stability_results.get("chugging", {}).get("stability_margin", np.nan)
                    results["stability_score"][i] = stability_results.get("stability_score", np.nan)
                    results["stability_state"][i] = stability_results.get("stability_state", "unstable")
                except Exception as e:
                    import warnings
                    warnings.warn(f"Stability analysis failed at time step {i}: {e}")
                    # Leave as NaN/unstable (already initialized)
                
                # Update geometry for next time step (if ablative tracking enabled)
                if track_ablative_geometry and dt > 0 and i < n - 1:
                    # Get ablative recession rate from diagnostics
                    cooling_diag = point_results.get("diagnostics", {}).get("cooling", {})
                    ablative_diag = cooling_diag.get("ablative", {})
                    
                    # Check for graphite insert (separate from chamber ablator)
                    graphite_cfg = config_copy.graphite_insert
                    use_graphite_throat = graphite_cfg is not None and graphite_cfg.enabled
                    
                    recession_rate_chamber = 0.0
                    recession_rate_throat = 0.0
                    
                    # Chamber recession (from ablative cooling)
                    if ablative_diag.get("enabled", False):
                        recession_rate_chamber = ablative_diag.get("recession_rate", 0.0)
                    
                    # Throat recession (from graphite insert if enabled, else from ablator)
                    if use_graphite_throat:
                        # Check for simplified mode
                        simplified_mode = getattr(graphite_cfg, "simplified_graphite_oxidation", False)
                        
                        if not simplified_mode:
                            # STRICT MODE NOTE:
                            # The graphite oxidation model no longer assumes hidden defaults for gas properties
                            # (oxygen mass fraction, viscosity, backside temperature, etc.). The legacy
                            # runner time-march path does not have enough information to supply these
                            # quantities consistently. Use the fully-coupled solver path instead.
                            raise ValueError(
                                "Graphite throat oxidation is running in strict mode and requires explicit gas/thermal inputs "
                                "(e.g., oxygen_mass_fraction, hot-gas viscosity, backside temperature, etc.). "
                                "Please run with use_coupled_solver=True (fully-coupled time-varying solver) or set "
                                "'simplified_graphite_oxidation: true' in your graphite_insert config."
                            )

                        # Use graphite insert properties for throat recession
                        Pc = point_results["Pc"]
                        Tc = point_results["Tc"]
                        
                        # Get throat heat flux from cooling diagnostics
                        # Throat heat flux is typically higher than chamber
                        chamber_heat_flux = ablative_diag.get("incident_heat_flux", 1e6) if ablative_diag.get("enabled", False) else 1e6
                        
                        # Estimate throat heat flux (higher than chamber due to sonic conditions)
                        # Use heuristic multiplier scaling
                        gamma = point_results.get("gamma", DEFAULT_GAMMA_ND)
                        throat_heat_flux_mult = calculate_throat_heuristic_multiplier(
                            Pc, 50.0, 1000.0, chamber_heat_flux, gamma  # Approximate velocities
                        )
                        throat_heat_flux = chamber_heat_flux * throat_heat_flux_mult
                        
                        # Calculate graphite recession rate (passing dummy values for unused strict inputs in simplified mode)
                        graphite_results = compute_graphite_recession(
                            net_heat_flux=throat_heat_flux,
                            throat_temperature=Tc * 0.85,  # Approximate throat temperature
                            gas_temperature=Tc,
                            graphite_config=graphite_cfg,
                            throat_area=cg.A_throat,
                            pressure=Pc,
                            gas_density=1.0,  # Placeholder
                            gas_viscosity=4e-5,  # Placeholder
                            oxygen_mass_fraction=0.0,  # Placeholder
                            characteristic_length=0.01,  # Placeholder
                            gas_velocity=1000.0,  # Placeholder
                            heat_transfer_coefficient=1000.0,  # Placeholder
                            backside_temperature=300.0,  # Placeholder
                            effective_thickness=0.01,  # Placeholder
                        )
                        
                        # CRITICAL FIX: For cumulative recession tracking (diagnostics), use recession_rate_calculated
                        # even though recession_rate is 0 (which prevents throat area from changing).
                        # The recession_rate = 0 is only to keep throat area constant, but we still want to
                        # track cumulative recession for diagnostics and display.
                        recession_rate_throat = graphite_results.get("recession_rate_calculated", 0.0)
                        if recession_rate_throat == 0.0:
                            # Fallback to recession_rate if calculated is not available
                            recession_rate_throat = graphite_results.get("recession_rate", 0.0)
                        
                        # Apply graphite coverage fraction
                        recession_rate_throat *= graphite_cfg.coverage_fraction
                        
                        # If ablator also covers throat (partial coverage), add ablator contribution
                        if ablative_diag.get("enabled", False) and graphite_cfg.coverage_fraction < 1.0:
                            ablator_coverage = 1.0 - graphite_cfg.coverage_fraction
                            recession_rate_ablator_throat = recession_rate_chamber * throat_heat_flux_mult
                            recession_rate_throat += recession_rate_ablator_throat * ablator_coverage
                    elif ablative_diag.get("enabled", False):
                        # Use ablative properties for throat (original behavior)
                        # Calculate throat recession multiplier from flow conditions
                        if ablative_cfg.throat_recession_multiplier is not None:
                            throat_mult = ablative_cfg.throat_recession_multiplier
                        else:
                            # Calculate from physics
                            Pc = point_results["Pc"]
                            mdot_total = point_results["mdot_total"]
                            gamma = point_results["gamma"]
                            R = point_results["R"]
                            Tc = point_results["Tc"]
                            
                            # Chamber velocity
                            rho_chamber = Pc / (R * Tc)
                            A_chamber = np.pi * (D_chamber_initial ** 2) / 4.0
                            v_chamber = mdot_total / (rho_chamber * A_chamber) if rho_chamber > 0 else 0.0
                            
                            # Throat velocity (sonic)
                            v_throat = np.sqrt(gamma * R * Tc / (gamma + 1))
                            
                            # Heat flux (from cooling diagnostics)
                            chamber_heat_flux = ablative_diag.get("incident_heat_flux", 1e6)
                            
                            throat_mult = calculate_throat_heuristic_multiplier(
                                Pc, v_chamber, v_throat, chamber_heat_flux, gamma
                            )
                        
                        results["throat_recession_multiplier"][i] = throat_mult
                        recession_rate_throat = recession_rate_chamber * throat_mult
                    
                    # Update cumulative recession
                    recession_increment_chamber = recession_rate_chamber * dt
                    recession_increment_throat = recession_rate_throat * dt
                    
                    cumulative_recession_chamber += recession_increment_chamber
                    cumulative_recession_throat += recession_increment_throat
                    
                    # Update geometry
                    # Use ablative coverage for chamber, graphite coverage for throat
                    chamber_coverage = ablative_cfg.coverage_fraction if ablative_cfg and ablative_cfg.enabled else 1.0
                    throat_coverage = graphite_cfg.coverage_fraction if use_graphite_throat and graphite_cfg else chamber_coverage
                    
                    V_new, A_throat_new, D_chamber_new, D_throat_new, geom_diag = update_chamber_geometry_from_ablation(
                        V_chamber_initial,
                        A_throat_initial,
                        D_chamber_initial,
                        D_throat_initial,
                        L_chamber,
                        cumulative_recession_chamber,
                        cumulative_recession_throat,
                        chamber_coverage,  # Chamber coverage from ablator
                        None,  # Don't use multiplier here, we already calculated throat recession
                    )
                    
                    # Update config for next iteration
                    config_copy.chamber_geometry.volume = V_new
                    config_copy.chamber_geometry.A_throat = A_throat_new
                    
                    # Update L* if specified
                    if config_copy.chamber_geometry.Lstar is not None:
                        config_copy.chamber_geometry.Lstar = V_new / A_throat_new
                    
                    # Update nozzle exit geometry if nozzle is ablative
                    if ablative_cfg and ablative_cfg.enabled and ablative_cfg.nozzle_ablative:
                        # Nozzle exit recedes at similar rate to chamber (can be tuned)
                        # For now, assume exit recession rate = 0.8 × chamber rate (less severe than throat)
                        recession_increment_exit = recession_rate_chamber * 0.8 * dt
                        cumulative_recession_exit += recession_increment_exit
                        
                        A_exit_new, D_exit_new, exit_diag = update_nozzle_exit_from_ablation(
                            A_exit_initial,
                            D_exit_initial,
                            cumulative_recession_exit,
                            ablative_cfg.coverage_fraction,
                        )
                        
                        # Update nozzle config
                        config_copy.chamber_geometry.A_exit = A_exit_new
                        
                        # Expansion ratio will be recalculated on next iteration
                
            except Exception as e:
                # If solve fails, leave NaN values
                # Suppress warnings/prints for performance - errors still stored in diagnostics
                results["diagnostics"].append({"error": str(e)})
                continue
        
        return results

