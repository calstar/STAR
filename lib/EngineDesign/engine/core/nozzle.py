"""Nozzle model: thrust coefficient and thrust calculation with shifting equilibrium"""

import numpy as np
import logging
from typing import Dict, Optional, Any
from engine.pipeline.cea_cache import CEACache
from engine.pipeline.numerical_robustness import (
    PhysicalConstraints,
    NumericalStability,
    PhysicsValidator,
)
from engine.core.mach_solver import solve_exit_mach_robust


def calculate_chamber_temperature_profile(
    Tc: float,
    Lstar: float,
    reaction_progress: Optional[Dict] = None,
    n_points: int = 10,
) -> Dict[str, Any]:
    """
    Calculate temperature profile along chamber length.
    
    Temperature increases as reaction progresses from injection to throat.
    Uses reaction progress to model temperature rise.
    
    Parameters:
    -----------
    Tc : float
        Chamber temperature at throat (equilibrium) [K]
    Lstar : float
        Characteristic length [m]
    reaction_progress : dict, optional
        Reaction progress dict with progress_injection, progress_mid, progress_throat
    n_points : int
        Number of points along chamber (default: 10)
    
    Returns:
    --------
    profile : dict
        - positions: Array of positions along chamber [m] (0 = injection, Lstar = throat)
        - temperatures: Array of temperatures [K]
        - progress: Array of reaction progress (0-1)
        - T_injection: Temperature at injection plane [K]
        - T_mid: Temperature at mid-chamber [K]
        - T_throat: Temperature at throat [K]
    """
    # Default reaction progress if not provided
    if reaction_progress is None:
        progress_injection = 0.0
        progress_mid = 0.5
        progress_throat = 1.0
    else:
        progress_injection = reaction_progress.get("progress_injection", 0.0)
        progress_mid = reaction_progress.get("progress_mid", 0.5)
        progress_throat = reaction_progress.get("progress_throat", 1.0)
    
    # Initial temperature at injection (before significant reaction)
    # Assume reactants enter at ~300-500 K (propellant temperature)
    T_injection_guess = 400.0  # K, typical propellant injection temperature
    
    # Temperature at throat is equilibrium temperature (Tc)
    T_throat = Tc
    
    # Interpolate temperature based on reaction progress
    # T = T_injection + progress * (T_throat - T_injection)
    # But account for heat release: more progress = more heat = higher temp
    
    # Create position array
    positions = np.linspace(0.0, Lstar, n_points)
    
    # Reaction progress along chamber (linear interpolation)
    progress_array = np.linspace(progress_injection, progress_throat, n_points)
    
    # Temperature profile
    # Simple model: T = T_injection + progress * (T_throat - T_injection)
    # More accurate: account for heat release rate
    temperatures = T_injection_guess + progress_array * (T_throat - T_injection_guess)
    
    # Validate inputs first
    if Tc <= 0:
        raise ValueError(f"Invalid chamber temperature Tc={Tc} K. Must be positive.")
    if T_injection_guess <= 0:
        raise ValueError(f"Invalid injection temperature guess={T_injection_guess} K. Must be positive.")
    if T_injection_guess >= Tc:
        raise ValueError(
            f"Invalid temperature: T_injection_guess ({T_injection_guess} K) >= Tc ({Tc} K). "
            f"Injection temperature must be lower than chamber temperature."
        )
    
    # Refine: temperature rise is not linear with progress due to heat release
    # Use a power law to account for rapid initial heating
    # T = T_injection + (T_throat - T_injection) * progress^alpha
    # where alpha < 1 means faster initial heating
    alpha = 0.7  # Empirical: faster initial heating
    temperatures = T_injection_guess + (T_throat - T_injection_guess) * (progress_array ** alpha)
    
    # Mid-chamber temperature
    T_mid = T_injection_guess + (T_throat - T_injection_guess) * (progress_mid ** alpha)
    
    # Validate all temperatures - no clipping
    if not np.all(np.isfinite(temperatures)):
        raise ValueError(
            f"Non-finite temperatures in profile. "
            f"Tc={Tc} K, T_injection={T_injection_guess} K, alpha={alpha}"
        )
    
    # Check temperature bounds - raise error if violated
    T_min_phys = 200.0  # K - below this, propellants would be frozen
    T_max_phys = 5000.0  # K - above this, model assumptions break down
    
    if np.any(temperatures < T_min_phys):
        min_temp = np.min(temperatures)
        raise ValueError(
            f"Temperature profile contains unrealistic low temperatures: {min_temp:.1f} K < {T_min_phys} K. "
            f"Check reaction progress and T_injection_guess. Tc={Tc} K, alpha={alpha:.3f}"
        )
    
    if np.any(temperatures > T_max_phys):
        max_temp = np.max(temperatures)
        raise ValueError(
            f"Temperature profile contains unrealistic high temperatures: {max_temp:.1f} K > {T_max_phys} K. "
            f"Check reaction progress and chamber temperature. Tc={Tc} K, alpha={alpha:.3f}"
        )
    
    T_injection = float(temperatures[0])
    
    # Validate mid-chamber temperature
    if not np.isfinite(T_mid) or T_mid < T_min_phys or T_mid > T_max_phys:
        raise ValueError(
            f"Invalid mid-chamber temperature: T_mid={T_mid:.1f} K. "
            f"Must be in [{T_min_phys}, {T_max_phys}] K. progress_mid={progress_mid:.3f}"
        )
    
    return {
        "positions": positions.tolist(),
        "temperatures": temperatures.tolist(),
        "progress": progress_array.tolist(),
        "T_injection": T_injection,
        "T_mid": T_mid,
        "T_throat": T_throat,
    }


def calculate_thrust(
    Pc: float,
    MR: float,
    mdot_total: float,
    cea_cache: CEACache,
    config: Any,
    Pa: float = 101325.0,
    reaction_progress: Optional[Dict] = None,
    use_shifting_equilibrium: bool = True,
    debug: bool = False,
) -> dict:
    """
    Calculate engine thrust with high fidelity.
    
    Thrust consists of two components:
    1. Momentum thrust: ṁ × v_exit
    2. Pressure thrust: (P_exit - Pa) × A_exit
    
    F = ṁ × v_exit + (P_exit - Pa) × A_exit
    
    Or using thrust coefficient:
    F = Cf × Pc × At
    
    where Cf accounts for both momentum and pressure components.
    
    Parameters:
    -----------
    Pc : float
        Chamber pressure [Pa]
    MR : float
        Mixture ratio (O/F)
    mdot_total : float
        Total mass flow rate [kg/s]
    cea_cache : CEACache
        CEA cache for thermochemical properties
    config : PintleEngineConfig
        Complete engine configuration
    Pa : float
        Ambient pressure [Pa] (default: sea level)
    reaction_progress : dict, optional
        Reaction progress for shifting equilibrium
    use_shifting_equilibrium : bool
        Enable shifting equilibrium model
    
    Returns:
    --------
    results : dict
        Dictionary containing:
        - F: Total thrust [N]
        - F_momentum: Momentum thrust component [N]
        - F_pressure: Pressure thrust component [N]
        - Cf: Thrust coefficient
        - Cf_ideal: Ideal thrust coefficient from CEA
        - P_exit: Exit pressure [Pa]
        - v_exit: Exit velocity [m/s]
        - Isp: Specific impulse [s]
    """
    # Extract geometry from config.chamber_geometry
    cg = config.chamber_geometry
    if cg is None:
        raise ValueError("config.chamber_geometry must be provided")

    A_throat = cg.A_throat
    A_exit = cg.A_exit
    eps = cg.expansion_ratio
    efficiency = cg.nozzle_efficiency

    # Validate geometry inputs
    if A_throat is None or A_throat <= 0:
        raise ValueError(f"Invalid A_throat: {A_throat}")
    if A_exit is None or A_exit <= 0:
        raise ValueError(f"Invalid A_exit: {A_exit}")
    if eps is None or eps <= 1.0:
        raise ValueError(f"Invalid expansion ratio: eps={eps}")

    # Verify geometric consistency: eps = A_exit / A_throat
    eps_calc = A_exit / A_throat
    if not np.isclose(eps, eps_calc, rtol=1e-4):
        raise ValueError(
            f"Geometric inconsistency: config.chamber_geometry.expansion_ratio ({eps:.6f}) "
            f"does not match A_exit / A_throat ({eps_calc:.6f})"
        )

    # Get CEA properties (now with eps parameter for 3D cache)
    cea_props = cea_cache.eval(MR, Pc, Pa, eps)
    Cf_ideal = cea_props["Cf_ideal"]
    gamma = cea_props["gamma"]
    Tc = cea_props["Tc"]
    R = cea_props["R"]
    


    
    # Validate inputs
    gamma_val = float(gamma)
    eps_val = float(eps)
    Pc_val = float(Pc)

    if debug:
        logging.getLogger("evaluate").info(
            f"[NOZZLE][CEA] Pc={Pc_val:.3e} Pa, Pa={Pa:.3e} Pa, MR={MR:.4f}, eps={eps_val:.3f} | "
            f"Cf_ideal={Cf_ideal:.4f}, gamma={gamma_val:.4f}, Tc={Tc:.1f} K, R={R:.2f}"
        )


    # Validate mdot_total before using
    if mdot_total <= 0:
        raise ValueError(f"Invalid mass flow rate: mdot_total={mdot_total} kg/s. Must be positive.")
    
    # Calculate c*_actual implied by Pc, At, mdot
    cstar_implied = (Pc_val * A_throat) / mdot_total

    if debug:
        logging.getLogger("evaluate").info(
            f"[NOZ-CSTAR] c*_implied_from_mdot={cstar_implied:.1f} m/s | "
            f"c*_ideal_from_CEA={cea_props['cstar_ideal']:.1f} m/s | ratio={cstar_implied/cea_props['cstar_ideal']:.4f}"
        )

    
    # Apply nozzle efficiency
    Cf = efficiency * Cf_ideal
    
    # Calculate exit pressure using isentropic relations
    
    # For supersonic nozzles (eps > 1), we need to solve the area-Mach relation:
    # A/A* = (1/M) × [(2/(gamma+1)) × (1 + (gamma-1)/2 × M²)]^((gamma+1)/(2(gamma-1)))
    # Then use isentropic relation: P/Pc = [1 + (gamma-1)/2 × M²]^(-gamma/(gamma-1))
    
    gamma_check = PhysicalConstraints.validate_gamma(gamma_val)
    if not gamma_check.passed and gamma_check.severity == "error":
        raise ValueError(f"Invalid gamma: {gamma_check.message}")
    
    # Validate nozzle conditions before proceeding
    if gamma_val <= 1.0:
        raise ValueError(
            f"Invalid gamma={gamma_val:.4f}. Must be > 1.0 for physical gas. "
            f"Check CEA cache results and combustion chemistry."
        )
    
    if eps_val <= 1.0:
        raise ValueError(
            f"Invalid expansion ratio eps={eps_val:.4f}. Must be > 1.0 for supersonic nozzle. "
            f"Check chamber geometry: A_exit={A_exit:.6e} m², A_throat={A_throat:.6e} m²"
        )
    
    # Initialize exit conditions to None - must be properly calculated
    M_exit = None
    P_exit = None
    T_exit = None
    v_exit = None
    
    # Solve for exit Mach number from area ratio (supersonic solution)
    # Using consolidated solver from mach_solver module
    M_exit, M_converged = solve_exit_mach_robust(eps_val, gamma_val)
    
    if not M_converged:
        raise RuntimeError(
            f"Mach solver failed to converge for eps={eps_val:.4f}, gamma={gamma_val:.4f}. "
            f"Check nozzle geometry and thermodynamic properties."
        )
    
    if M_exit <= 1.0:
        raise ValueError(
            f"Subsonic exit Mach number: M_exit={M_exit:.4f}. "
            f"For supersonic nozzle (eps={eps_val:.4f} > 1), M_exit must be > 1. "
            f"Check area-Mach solver and nozzle geometry."
        )
    
    # Use isentropic relation for exit pressure
    # P_exit/Pc = [1 + (gamma-1)/2 × M_exit²]^(-gamma/(gamma-1))
    pressure_exponent = -gamma_val / (gamma_val - 1.0)
    pressure_factor = (1.0 + (gamma_val - 1.0) / 2.0 * M_exit**2) ** pressure_exponent
    P_exit = Pc_val * pressure_factor
    
    # Validate exit pressure
    if not np.isfinite(P_exit):
        raise ValueError(
            f"Non-finite exit pressure: P_exit={P_exit} Pa. "
            f"Pc={Pc_val:.3e} Pa, M_exit={M_exit:.4f}, gamma={gamma_val:.4f}"
        )
    
    if P_exit < 0:
        raise ValueError(
            f"Negative exit pressure: P_exit={P_exit:.3e} Pa. "
            f"This indicates a fundamental error in isentropic relations."
        )
    
    # Calculate exit temperature from Mach number (isentropic, consistent with pressure)
    # T_exit/Tc = 1 / [1 + (gamma-1)/2 × M_exit²]
    temperature_factor = 1.0 / (1.0 + (gamma_val - 1.0) / 2.0 * M_exit**2)
    T_exit = Tc * temperature_factor
    
    # Validate exit temperature
    if not np.isfinite(T_exit):
        raise ValueError(
            f"Non-finite exit temperature: T_exit={T_exit} K. "
            f"Tc={Tc} K, M_exit={M_exit:.4f}, gamma={gamma_val:.4f}"
        )
    
    if T_exit <= 0:
        raise ValueError(
            f"Non-positive exit temperature: T_exit={T_exit} K. "
            f"This indicates a fundamental error in isentropic relations."
        )
    
    if T_exit >= Tc:
        raise ValueError(
            f"Exit temperature exceeds chamber temperature: T_exit={T_exit} K >= Tc={Tc} K. "
            f"Isentropic expansion must cool the gas. M_exit={M_exit:.4f}"
        )
    
    # Calculate exit velocity from Mach number
    # v_exit = M_exit × sqrt(gamma × R × T_exit)
    sound_speed_exit_squared = gamma_val * R * T_exit
    sound_speed_exit, sound_valid = NumericalStability.safe_sqrt(sound_speed_exit_squared, "sound_speed_exit")
    
    if not sound_valid.passed:
        raise ValueError(
            f"Cannot calculate sound speed: {sound_valid.message}. "
            f"gamma={gamma_val:.4f}, R={R:.2f} J/(kg·K), T_exit={T_exit} K"
        )
    
    if not (np.isfinite(sound_speed_exit) and sound_speed_exit > 0):
        raise ValueError(
            f"Invalid sound speed: {sound_speed_exit} m/s. "
            f"gamma={gamma_val:.4f}, R={R:.2f} J/(kg·K), T_exit={T_exit} K"
        )
    
    v_exit = M_exit * sound_speed_exit
    
    if not np.isfinite(v_exit) or v_exit <= 0:
        raise ValueError(
            f"Invalid exit velocity: v_exit={v_exit} m/s. "
            f"M_exit={M_exit:.4f}, sound_speed={sound_speed_exit:.2f} m/s"
        )
    
    if debug:
        logging.getLogger("evaluate").info(
            f"[NOZZLE][ISO] M_exit={M_exit:.4f} | "
            f"T_exit={T_exit:.1f} K ({T_exit/Tc:.3f} Tc), "
            f"P_exit={P_exit:.3e} Pa ({P_exit/Pc_val:.4f} Pc)"
        )

    # Apply shifting equilibrium if enabled
    # PROPER ITERATIVE APPROACH: As gas expands, equilibrium composition shifts.
    # Gamma and R change between chamber (equilibrium) and exit (shifting).
    # Must iterate to find self-consistent solution: M_exit, P_exit, T_exit, gamma_exit, R_exit
    gamma_exit = gamma_val
    R_exit = R
    equilibrium_factor = 1.0
    
    if use_shifting_equilibrium and P_exit < Pc_val:
        try:
            from engine.pipeline.reaction_chemistry import calculate_shifting_equilibrium_properties
            
            # Get reaction progress at chamber (if provided)
            progress_chamber = 1.0  # Default: assume equilibrium at chamber
            if reaction_progress is not None:
                progress_chamber = reaction_progress.get("progress_throat", 1.0)
            
            # Reaction rate factor: Physics-based approach using Damköhler number
            # The equilibrium_factor returned by calculate_shifting_equilibrium_properties
            # is computed as Da/(1+Da) based on actual reaction and expansion time scales.
            # No longer using hardcoded 0.1 - let physics determine the value.
            #
            # Allow user override via config if available, otherwise use physics-based default
            reaction_rate_factor = None  # Will use default in function (physics-based)
            if config is not None and hasattr(config, 'nozzle'):
                if hasattr(config.nozzle, 'reaction_rate_factor'):
                    reaction_rate_factor = config.nozzle.reaction_rate_factor
            
            # ITERATIVE SHIFTING EQUILIBRIUM SOLUTION
            # Physics-based: iterate to find self-consistent M_exit, P_exit, T_exit, gamma_exit, R_exit
            # NO ARBITRARY CONSTANTS OR CLAMPING - all from physics equations
            gamma_exit_iter = gamma_val
            R_exit_iter = R
            M_exit_iter = M_exit
            P_exit_iter = P_exit
            T_exit_iter = T_exit
            
            # Use MR parameter passed to calculate_thrust (no hardcoded values)
            # MR is already available as a function parameter - use it directly
            MR_for_shifting = MR
            
            max_iterations = 20  # More iterations for convergence
            tolerance = 1e-6  # Stricter tolerance
            
            for iteration in range(max_iterations):
                gamma_exit_old = gamma_exit_iter
                
                # Calculate shifting equilibrium properties based on current exit conditions
                # Only pass reaction_rate_factor if explicitly set in config
                if reaction_rate_factor is not None:
                    shifting_props = calculate_shifting_equilibrium_properties(
                        Pc_val,
                        Tc,
                        gamma_val,
                        R,
                        P_exit_iter,  # Use current P_exit
                        progress_chamber,
                        reaction_rate_factor,
                        cea_cache,
                        MR=MR_for_shifting,  # Pass MR - no hardcoded values
                    )
                else:
                    # Use default (physics-based Da/(1+Da))
                    shifting_props = calculate_shifting_equilibrium_properties(
                        Pc_val,
                        Tc,
                        gamma_val,
                        R,
                        P_exit_iter,
                        progress_chamber,
                        cea_cache=cea_cache,
                        MR=MR_for_shifting,
                    )
                
                gamma_exit_iter = shifting_props["gamma_exit"]
                R_exit_iter = shifting_props["R_exit"]
                equilibrium_factor = shifting_props["equilibrium_factor"]
                
                # Check convergence
                gamma_change = abs(gamma_exit_iter - gamma_exit_old) / max(gamma_exit_old, 1.0)
                if gamma_change < tolerance:
                    break
                
                # Recalculate M_exit with new gamma_exit using consolidated solver
                if eps_val > 1.0 and gamma_exit_iter > 1.0:
                    M_exit_iter, _ = solve_exit_mach_robust(eps_val, gamma_exit_iter)
                
                # Recalculate P_exit and T_exit with new gamma_exit and M_exit_iter
                # Using isentropic relations (physics-based, no arbitrary factors)
                pressure_exponent_new = -gamma_exit_iter / (gamma_exit_iter - 1.0)
                pressure_factor_new = (1.0 + (gamma_exit_iter - 1.0) / 2.0 * M_exit_iter**2) ** pressure_exponent_new
                P_exit_iter = Pc_val * pressure_factor_new
                
                # Physics: P_exit cannot be negative
                if P_exit_iter < 0:
                    raise ValueError(f"Non-physical exit pressure: P_exit={P_exit_iter} Pa")
                
                # Note: P_exit can be < Pa (overexpanded) or > Pa (underexpanded)
                # Don't clamp to Pa - that's a physics result
                
                temperature_factor_new = 1.0 / (1.0 + (gamma_exit_iter - 1.0) / 2.0 * M_exit_iter**2)
                T_exit_iter = Tc * temperature_factor_new
                
                # Physics validation: T_exit must be positive and less than Tc
                if T_exit_iter <= 0 or T_exit_iter >= Tc:
                    raise ValueError(f"Non-physical exit temperature: T_exit={T_exit_iter} K, Tc={Tc} K")
            
            # Use converged values
            gamma_exit = gamma_exit_iter
            R_exit = R_exit_iter
            M_exit = M_exit_iter
            P_exit = P_exit_iter
            T_exit = T_exit_iter
            
        except Exception as e:
            # Don't silently fail - shifting equilibrium failure indicates physics issue
            raise RuntimeError(
                f"Shifting equilibrium calculation failed: {e}. "
                f"This indicates invalid nozzle conditions or chemistry model issues. "
                f"Pc={Pc_val:.3e} Pa, Tc={Tc} K, MR={MR:.4f}, P_exit={P_exit_iter:.3e} Pa"
            ) from e
    
    # Recalculate v_exit with final exit properties after shifting equilibrium
    # v_exit = M_exit × sqrt(gamma_exit × R_exit × T_exit)
    
    # Validate all exit properties are valid
    if not (np.isfinite(gamma_exit) and gamma_exit > 1.0):
        raise ValueError(f"Invalid gamma_exit: {gamma_exit}. Must be finite and > 1.0")
    
    if not (np.isfinite(R_exit) and R_exit > 0):
        raise ValueError(f"Invalid R_exit: {R_exit} J/(kg·K). Must be finite and positive")
    
    if not (np.isfinite(T_exit) and T_exit > 0):
        raise ValueError(f"Invalid T_exit: {T_exit} K. Must be finite and positive")
    
    if not (np.isfinite(M_exit) and M_exit > 1.0):
        raise ValueError(f"Invalid M_exit: {M_exit}. Must be finite and > 1.0 for supersonic nozzle")
    
    # Calculate sound speed at exit
    sound_speed_exit_final = np.sqrt(gamma_exit * R_exit * T_exit)
    
    if not (np.isfinite(sound_speed_exit_final) and sound_speed_exit_final > 0):
        raise ValueError(
            f"Invalid exit sound speed: {sound_speed_exit_final} m/s. "
            f"gamma_exit={gamma_exit:.4f}, R_exit={R_exit:.2f} J/(kg·K), T_exit={T_exit} K"
        )
    
    # Calculate exit velocity
    v_exit = M_exit * sound_speed_exit_final
    
    if not (np.isfinite(v_exit) and v_exit > 0):
        raise ValueError(
            f"Invalid exit velocity: v_exit={v_exit} m/s. "
            f"M_exit={M_exit:.4f}, sound_speed={sound_speed_exit_final:.2f} m/s"
        )
    
    # Calculate thrust components with validation
    g0 = 9.80665

    PcAt = Pc_val * A_throat
    F_mom = mdot_total * v_exit
    F_pres = (P_exit - Pa) * A_exit
    F_sum = F_mom + F_pres

    Cf_from_sum = F_sum / PcAt
    Isp_from_sum = F_sum / (mdot_total * g0)

    # Expected “effective exhaust velocity” should be ~ Isp*g0
    c_eff = F_sum / mdot_total

    if debug:
        logging.getLogger("evaluate").info(
            f"[NOZZLE][THRUSTCHK] PcAt={PcAt:.1f} N | "
            f"mdot={mdot_total:.4f} kg/s, v_exit={v_exit:.1f} m/s, c_eff=F/mdot={c_eff:.1f} m/s | "
            f"F_mom={F_mom:.1f} N, F_pres={F_pres:.1f} N, F_sum={F_sum:.1f} N | "
            f"Cf_sum={Cf_from_sum:.3f}, Isp_sum={Isp_from_sum:.1f} s"
        )

    # Compare to CEA-ish expectations
    if debug:
        logging.getLogger("evaluate").info(
            f"[NOZZLE][EXPECT] c*_ideal={cea_props['cstar_ideal']:.1f} m/s, "
            f"Cf_ideal={Cf_ideal:.3f} => expected c_eff~Cf*c*={Cf_ideal*cea_props['cstar_ideal']:.1f} m/s"
        )

    F_momentum = mdot_total * v_exit
    F_pressure = (P_exit - Pa) * A_exit
    F_total = F_momentum + F_pressure

    if debug:
        logging.getLogger("evaluate").info(
            f"[NOZZLE FINAL] "
            f"Pc={Pc_val:.3e} Pa, At={A_throat:.3e} m^2, Ae={A_exit:.3e} m^2, eps={A_exit/A_throat:.3f} "
            f"M_exit={M_exit:.4f}, gamma_exit={gamma_exit:.4f}, R_exit={R_exit:.2f} "
            f"T_exit={T_exit:.1f} K, Tc={Tc:.1f} K "
            f"v_exit={v_exit:.1f} m/s "
            f"P_exit={P_exit:.3e} Pa, Pa={Pa:.3e} Pa "
            f"mdot={mdot_total:.4f} kg/s "
            f"F_mom={F_momentum:.1f} N, F_pres={F_pressure:.1f} N "
            f"PcAt={Pc_val*A_throat:.1f} N "
            f"Cf_actual={F_total/(Pc_val*A_throat):.3f}, Cf_ideal={Cf_ideal:.3f}"
        )

    
    # Validate thrust components
    if not all(np.isfinite([F_momentum, F_pressure, F_total])):
        raise ValueError(
            f"Non-finite thrust components: F_momentum={F_momentum} N, "
            f"F_pressure={F_pressure} N, F_total={F_total} N"
        )
    
    # Also calculate using thrust coefficient method for validation
    F_cf = Cf * Pc_val * A_throat
    
    # Validate thrust equation
    thrust_check = PhysicsValidator.validate_thrust_equation(
        F_momentum, F_pressure, F_total, tolerance=1e-2  # 1% tolerance
    )
    if not thrust_check.passed and thrust_check.severity == "error":
        # Use thrust coefficient method if momentum+pressure fails
        F_total = F_cf
    
    # Use the more accurate method (momentum + pressure)
    F = F_total

    # Calculate ACTUAL thrust coefficient from thrust equation
    # Cf_actual = F / (Pc * A_throat)
    # This is the measured value, not the theoretical
    Cf_actual = F / (Pc_val * A_throat)
    
    if not np.isfinite(Cf_actual):
        raise ValueError(
            f"Non-finite Cf_actual. F={F:.2f} N, Pc={Pc_val:.3e} Pa, A_throat={A_throat:.6e} m²"
        )
    
    # Validate Cf_actual is reasonable
    # Typical range: 1.2-2.0 for most nozzles
    # Note: Cf_actual > Cf_ideal can occur with underexpanded nozzle (P_exit > Pa)
    # This is physically valid, so only warn if extremely high
    if Cf_actual > Cf_ideal * 1.5:  # More than 50% higher - very unusual
        if debug:
            logging.getLogger("evaluate").warning(
                f"Very high Cf_actual ({Cf_actual:.4f}) vs Cf_ideal ({Cf_ideal:.4f}). "
                f"P_exit={P_exit/1e6:.4f} MPa, Pa={Pa/1e6:.4f} MPa. "
                f"This may indicate severely underexpanded nozzle or calculation issue."
            )

    # Calculate throat temperature (at M=1, choked flow)
    # T_throat/Tc = 2/(gamma+1) for isentropic flow
    gamma_throat = gamma_val  # Use chamber gamma at throat (before expansion)
    
    if gamma_throat <= 1.0:
        raise ValueError(f"Invalid gamma at throat: {gamma_throat}. Must be > 1.0")
    
    throat_temp_ratio = 2.0 / (gamma_throat + 1.0)
    T_throat = Tc * throat_temp_ratio
    
    # Validate throat temperature
    if not np.isfinite(T_throat) or T_throat <= 0:
        raise ValueError(f"Invalid throat temperature: T_throat={T_throat} K. Tc={Tc} K, gamma={gamma_throat:.4f}")
    
    if T_throat >= Tc:
        raise ValueError(
            f"Throat temperature exceeds chamber temperature: T_throat={T_throat} K >= Tc={Tc} K. "
            f"This violates isentropic flow physics."
        )
    
    # Calculate throat pressure (critical pressure at M=1)
    # P_throat/Pc = [2/(gamma+1)]^(gamma/(gamma-1))
    pressure_exponent_throat = gamma_throat / (gamma_throat - 1.0)
    pressure_ratio_throat = throat_temp_ratio ** pressure_exponent_throat
    P_throat = Pc_val * pressure_ratio_throat
    
    if not np.isfinite(P_throat) or P_throat <= 0:
        raise ValueError(
            f"Invalid throat pressure: P_throat={P_throat:.3e} Pa. "
            f"Pc={Pc_val:.3e} Pa, gamma={gamma_throat:.4f}"
        )
    
    if P_throat >= Pc_val:
        raise ValueError(
            f"Throat pressure exceeds chamber pressure: P_throat={P_throat:.3e} Pa >= Pc={Pc_val:.3e} Pa. "
            f"This violates isentropic flow physics."
        )

    # Calculate Isp
    g0 = 9.80665  # m/s²
    Isp = F / (mdot_total * g0)
    
    if not np.isfinite(Isp):
        raise ValueError(
            f"Non-finite Isp: {Isp}. F={F:.2f} N, mdot_total={mdot_total:.4f} kg/s"
        )
    
    if Isp < 0:
        raise ValueError(
            f"Negative Isp: {Isp:.2f} s. This indicates negative thrust or negative mass flow. "
            f"F={F:.2f} N, mdot_total={mdot_total:.4f} kg/s"
        )

    # Calculate chamber temperature profile if reaction progress available
    temperature_profile = None
    if reaction_progress is not None:
        try:
            # Get Lstar from config if available
            Lstar = None
            if config is not None and hasattr(config, 'chamber_geometry'):
                V_chamber = getattr(config.chamber_geometry, 'volume', None)
                A_throat = getattr(config.chamber_geometry, 'A_throat', None)
                if V_chamber is not None and A_throat is not None and A_throat > 0:
                    Lstar = V_chamber / A_throat
            
            if Lstar is not None:
                temperature_profile = calculate_chamber_temperature_profile(
                    Tc, Lstar, reaction_progress, n_points=20
                )
        except Exception as e:
            # Temperature profile is optional - log but don't fail
            if debug:
                logging.getLogger("evaluate").warning(f"Temperature profile calculation failed: {e}")

    results = {
        "F": float(F),
        "F_momentum": float(F_momentum),
        "F_pressure": float(F_pressure),
        "F_cf_method": float(F_cf),  # For comparison
        "Cf": float(Cf_actual),  # Return actual Cf (measured from thrust)
        "Cf_actual": float(Cf_actual),  # Explicit actual value
        "Cf_ideal": float(Cf_ideal),  # Ideal from CEA
        "Cf_theoretical": float(Cf),  # Theoretical (efficiency-adjusted ideal)
        "P_exit": float(P_exit),
        "P_throat": float(P_throat),
        "v_exit": float(v_exit),
        "T_exit": float(T_exit),
        "T_throat": float(T_throat),
        "temperature_profile": temperature_profile,  # Full profile along chamber
        "Isp": float(Isp),
        "gamma_chamber": float(gamma_val),
        "gamma_exit": float(gamma_exit),
        "R_chamber": float(R),
        "R_exit": float(R_exit),
        "equilibrium_factor": float(equilibrium_factor),
        "M_exit": float(M_exit),
    }
    
    # Final validation of M_exit before returning
    if results["M_exit"] <= 1.0:
        raise ValueError(
            f"Invalid M_exit in results: {results['M_exit']:.6f}. "
            f"For supersonic nozzle, M_exit must be > 1.0. "
            f"eps={eps_val:.4f}, gamma_exit={gamma_exit:.4f}"
        )
    
    return results
