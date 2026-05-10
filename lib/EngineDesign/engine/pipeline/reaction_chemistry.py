"""Finite-rate chemistry and reaction progress modeling for combustion chamber.

This module provides physics-based (not reference-based) models for:
1. Reaction progress tracking through chamber
2. Finite-rate chemistry effects using actual Arrhenius kinetics
3. Species evolution modeling
4. Shifting equilibrium in nozzle based on actual flow conditions
"""

from __future__ import annotations

from typing import Dict, List, Tuple, Optional, Any
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.pipeline.numerical_robustness import (
    NumericalStability,
    PhysicalConstraints,
)

# Universal gas constant [J/(mol·K)]
R_gas = 8314.462618  # J/(kmol·K) for per-kmol calculations


def calculate_reaction_progress(
    residence_time: float,
    reaction_time_scale: float,
    initial_progress: float = 0.0,
) -> float:
    """
    Calculate reaction progress based on residence time and reaction kinetics.
    
    Models chemical reaction progress as first-order kinetics:
    dX/dt = (1 - X) / τ_chem
    
    Solution: X(t) = 1 - (1 - X0) × exp(-t / τ)
    
    Parameters:
    -----------
    residence_time : float
        Time spent in chamber [s] (must be >= 0)
    reaction_time_scale : float
        Chemical reaction time scale [s] (must be > 0)
    initial_progress : float
        Initial reaction progress (0-1)
    
    Returns:
    --------
    progress : float
        Reaction progress (0-1), where 1 = complete equilibrium
    
    Raises:
    -------
    ValueError
        If inputs are invalid (negative time, non-positive time scale, etc.)
    """
    # Validate inputs - raise errors rather than clamping
    if not np.isfinite(residence_time):
        raise ValueError(f"Non-finite residence_time: {residence_time}")
    if residence_time < 0:
        raise ValueError(f"Negative residence_time: {residence_time}")
    
    if not np.isfinite(reaction_time_scale):
        raise ValueError(f"Non-finite reaction_time_scale: {reaction_time_scale}")
    if reaction_time_scale <= 0:
        raise ValueError(f"Non-positive reaction_time_scale: {reaction_time_scale}")
    
    if not np.isfinite(initial_progress):
        raise ValueError(f"Non-finite initial_progress: {initial_progress}")
    if initial_progress < 0 or initial_progress > 1:
        raise ValueError(f"Initial_progress out of bounds [0,1]: {initial_progress}")
    
    # Reaction progress based on first-order kinetics
    # X = 1 - (1 - X0) × exp(-t / τ)
    time_ratio = residence_time / reaction_time_scale
    
    if not np.isfinite(time_ratio):
        raise ValueError(f"Non-finite time_ratio: {residence_time} / {reaction_time_scale}")
    
    # Calculate exponential - allow any value (physics will determine)
    exp_term = np.exp(-time_ratio)
    if not np.isfinite(exp_term):
        if time_ratio > 0:
            exp_term = 0.0  # Complete reaction (t >> τ)
        else:
            exp_term = 1.0  # No reaction (t << 0, invalid case)
    
    progress = 1.0 - (1.0 - initial_progress) * exp_term
    
    if not np.isfinite(progress):
        raise ValueError(f"Non-finite progress calculated: residence_time={residence_time}, reaction_time_scale={reaction_time_scale}")
    
    # Progress is naturally bounded [0, 1] by the exponential form
    # But don't clamp - if it's outside bounds, that's a physics error
    if progress < 0 or progress > 1:
        raise ValueError(f"Progress outside [0,1]: {progress} (this indicates a physics error)")
    
    return float(progress)


def calculate_reaction_rate_constant(
    Pc: float,
    Tc: float,
    MR: float,
    fuel_type: str = "RP-1",
    config: Optional[PintleEngineConfig] = None,
) -> float:
    """
    Calculate chemical reaction rate constant using Arrhenius kinetics.
    
    Rate constant: k = A × P^n × exp(-Ea / (R_gas × T))
    Reaction time: τ = 1 / k
    
    Uses actual Arrhenius parameters for hydrocarbon/LOX combustion:
    - Pre-exponential factor A depends on fuel type and mixture ratio
    - Pressure exponent n: typically 0.7-1.0 for gas-phase reactions
    - Activation energy Ea: depends on fuel complexity
    
    Parameters:
    -----------
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    MR : float
        Mixture ratio (O/F)
    fuel_type : str
        Fuel type ("RP-1", "Ethanol", "H2", etc.) - affects activation energy
    config : PintleEngineConfig, optional
        Engine configuration for kinetics parameters. If None, uses built-in defaults.
    
    Returns:
    --------
    k : float
        Reaction rate constant [1/s]
    
    Raises:
    -------
    ValueError
        If inputs are invalid or result is non-physical
    """
    # Validate inputs
    if not np.isfinite(Pc) or Pc <= 0:
        raise ValueError(f"Invalid pressure: {Pc} Pa")
    if not np.isfinite(Tc) or Tc <= 0:
        raise ValueError(f"Invalid temperature: {Tc} K")
    if not np.isfinite(MR) or MR <= 0:
        raise ValueError(f"Invalid mixture ratio: {MR}")
    
    # Get kinetics parameters from config if available, otherwise use built-in defaults
    if config is not None:
        eff_cfg = config.combustion.efficiency
        # Map fuel type to config parameters
        if fuel_type.upper() in ["RP-1", "KEROSENE", "JP"]:
            A0 = eff_cfg.A0_hydrocarbon
            n_pre = eff_cfg.n_pre_hydrocarbon
            Ea = eff_cfg.Ea_hydrocarbon
            n_pressure = 0.8
        elif fuel_type.upper() in ["ETHANOL", "C2H5OH"]:
            A0 = eff_cfg.A0_ethanol
            n_pre = eff_cfg.n_pre_ethanol
            Ea = eff_cfg.Ea_ethanol
            n_pressure = 0.8
        elif fuel_type.upper() in ["H2", "HYDROGEN"]:
            A0 = eff_cfg.A0_hydrogen
            n_pre = eff_cfg.n_pre_hydrogen
            Ea = eff_cfg.Ea_hydrogen
            n_pressure = 0.5
        else:
            # Default to hydrocarbon
            A0 = eff_cfg.A0_hydrocarbon
            n_pre = eff_cfg.n_pre_hydrocarbon
            Ea = eff_cfg.Ea_hydrocarbon
            n_pressure = 0.8
    else:
        # Built-in defaults (backward compatibility)
        if fuel_type.upper() in ["RP-1", "KEROSENE", "JP"]:
            A0 = 1e7
            n_pre = 0.3
            Ea = 80000.0
            n_pressure = 0.8
        elif fuel_type.upper() in ["ETHANOL", "C2H5OH"]:
            A0 = 5e7
            n_pre = 0.25
            Ea = 140000.0
            n_pressure = 0.8
        elif fuel_type.upper() in ["H2", "HYDROGEN"]:
            A0 = 1e9
            n_pre = 0.2
            Ea = 40000.0
            n_pressure = 0.5
        else:
            # Default: generic hydrocarbon
            A0 = 1e7
            n_pre = 0.3
            Ea = 80000.0
            n_pressure = 0.8
    
    # Adjust activation energy based on mixture ratio
    # Fuel-rich or oxidizer-rich can have different effective Ea
    if MR < 1.5:  # Fuel-rich: more complex chemistry
        Ea *= 1.2  # Higher effective activation energy
    elif MR > 3.0:  # Oxidizer-rich: simpler chemistry
        Ea *= 0.9  # Lower effective activation energy
    
    # Pre-exponential with pressure dependence
    # A(P) = A0 × (P / P0)^n_pre, where P0 = 1 MPa reference
    P0_ref = 1e6  # 1 MPa reference
    pressure_prefactor = (Pc / P0_ref) ** n_pre
    
    A = A0 * pressure_prefactor
    
    if not np.isfinite(A) or A <= 0:
        raise ValueError(f"Non-physical pre-exponential: A={A}, Pc={Pc}")
    
    # Pressure term: P^n
    pressure_term = (Pc / P0_ref) ** n_pressure
    
    if not np.isfinite(pressure_term) or pressure_term <= 0:
        raise ValueError(f"Non-physical pressure term: (Pc/P0)^n={pressure_term}, Pc={Pc}")
    
    # Arrhenius exponential: exp(-Ea / (R × T))
    arrhenius_exponent = -Ea / (R_gas * Tc)
    
    if not np.isfinite(arrhenius_exponent):
        raise ValueError(f"Non-finite Arrhenius exponent: Ea={Ea}, R_gas={R_gas}, Tc={Tc}")
    
    # Clamp exponent to prevent overflow/underflow, but only for numerical stability
    # This is a numerical safeguard, not physics clamping
    arrhenius_exponent = np.clip(arrhenius_exponent, -50.0, 50.0)
    
    arrhenius_term = np.exp(arrhenius_exponent)
    
    if not np.isfinite(arrhenius_term) or arrhenius_term <= 0:
        raise ValueError(f"Non-physical Arrhenius term: exp({arrhenius_exponent}) = {arrhenius_term}")
    
    # Overall rate constant: k = A × P^n × exp(-Ea/(R×T))
    k = A * pressure_term * arrhenius_term
    
    if not np.isfinite(k) or k <= 0:
        raise ValueError(f"Non-physical rate constant: k={k}")
    
    return float(k)


def calculate_reaction_time_scale(
    Pc: float,
    Tc: float,
    MR: float,
    fuel_type: str = "RP-1",
    config: Optional[PintleEngineConfig] = None,
) -> float:
    """
    Calculate chemical reaction time scale from Arrhenius rate constant.
    
    τ = 1 / k, where k is the reaction rate constant.
    
    Parameters:
    -----------
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    MR : float
        Mixture ratio (O/F)
    fuel_type : str
        Fuel type
    config : PintleEngineConfig, optional
        Engine configuration for kinetics parameters
    
    Returns:
    --------
    tau : float
        Reaction time scale [s]
    """
    k = calculate_reaction_rate_constant(Pc, Tc, MR, fuel_type, config=config)
    
    tau = 1.0 / k
    
    if not np.isfinite(tau) or tau <= 0:
        raise ValueError(f"Non-physical reaction time: τ={tau} = 1/k={1/k}")
    
    return float(tau)


def calculate_evaporation_time_scale(
    Pc: float,
    Tc: float,
    droplet_diameter: float,
    fuel_props: Optional[Dict] = None,
    gamma: float = 1.2,
    R_gas: float = 300.0,
) -> float:
    """
    Calculate droplet evaporation time scale from physics.
    
    Uses D² law: τ_evap = d² / (8 × D × ln(1 + B))
    where D is mass diffusivity and B is Spalding number.
    
    Parameters:
    -----------
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    droplet_diameter : float
        Droplet diameter [m] (SMD or characteristic size)
    fuel_props : dict, optional
        Fuel properties (density, latent heat, etc.)
    gamma : float
        Specific heat ratio from CEA
    R_gas : float
        Gas constant [J/(kg·K)] from CEA
    
    Returns:
    --------
    tau_evap : float
        Evaporation time scale [s]
    """
    from engine.pipeline.combustion_physics import calculate_gasification_efficiency
    from engine.pipeline.physics_constants import PRANDTL_DEFAULT
    
    if not np.isfinite(Pc) or Pc <= 0:
        raise ValueError(f"Invalid pressure: {Pc} Pa")
    if not np.isfinite(Tc) or Tc <= 0:
        raise ValueError(f"Invalid temperature: {Tc} K")
    if not np.isfinite(droplet_diameter) or droplet_diameter <= 0:
        raise ValueError(f"Invalid droplet diameter: {droplet_diameter} m")
    
    # Default fuel properties (RP-1)
    if fuel_props is None:
        fuel_props = {}
    
    # Extract properties with defaults
    rho_l = fuel_props.get("density", 810.0)
    L_eff = fuel_props.get("L_vap") or fuel_props.get("latent_heat", 300e3)
    cp_l = fuel_props.get("specific_heat", 2000.0)
    T_inj = fuel_props.get("temperature", 293.0)
    
    # Estimate gas properties
    # rho_g = P / (R_gas * T)
    rho_g = Pc / (R_gas * Tc)
    
    # cp_g = gamma * R / (gamma - 1)
    if gamma > 1.0:
        cp_g = gamma * R_gas / (gamma - 1.0)
    else:
        cp_g = 2200.0
        
    mu_g = 7e-5  # Approximation for hot gas
    
    # Call gasification model
    # We pass a dummy tau_res because we only need the timescale diagnostics
    # U_slip is estimated as modest value (convection aids evaporation)
    try:
        _, diagnostics = calculate_gasification_efficiency(
            Tc=Tc,
            Pc=Pc,
            tau_res=1.0,  # Dummy value
            SMD=droplet_diameter,
            rho_l=rho_l,
            cp_l=cp_l,
            L_eff=L_eff,
            T_inj=T_inj,
            cp_g=cp_g,
            rho_g=rho_g,
            mu_g=mu_g,
            U_slip=20.0,  # Assumed slip for reaction progress estimate
            Pr=PRANDTL_DEFAULT
        )
        tau_evap = diagnostics["tau_vap"]
    except Exception as e:
        # Fallback if model fails (rare)
        warnings.warn(f"Gasification model failed in reaction_chemistry: {e}. Using fallback.")
        tau_evap = 1e-3  # 1 ms default fallback
        
    return float(tau_evap)


def calculate_mixing_time_scale(
    L_chamber: float,
    u_mean: float,
    turbulence_intensity: float = 0.1,
) -> float:
    """
    Calculate turbulent mixing time scale from actual flow conditions.
    
    τ_mix = L / u_turbulent, where u_turbulent = turbulence_intensity × u_mean
    
    Parameters:
    -----------
    L_chamber : float
        Characteristic mixing length [m] (typically L*)
    u_mean : float
        Mean flow velocity [m/s]
    turbulence_intensity : float
        Turbulence intensity (typically 0.05-0.2 for rocket chambers)
    
    Returns:
    --------
    tau_mix : float
        Mixing time scale [s]
    """
    if not np.isfinite(L_chamber) or L_chamber <= 0:
        raise ValueError(f"Invalid chamber length: {L_chamber} m")
    if not np.isfinite(u_mean) or u_mean <= 0:
        raise ValueError(f"Invalid mean velocity: {u_mean} m/s")
    if not np.isfinite(turbulence_intensity) or turbulence_intensity <= 0:
        raise ValueError(f"Invalid turbulence intensity: {turbulence_intensity}")
    
    u_turbulent = turbulence_intensity * u_mean
    
    if not np.isfinite(u_turbulent) or u_turbulent <= 0:
        raise ValueError(f"Non-physical turbulent velocity: u_turb={u_turbulent}")
    
    tau_mix = L_chamber / u_turbulent
    
    if not np.isfinite(tau_mix) or tau_mix <= 0:
        raise ValueError(f"Non-physical mixing time: τ={tau_mix}")
    
    return float(tau_mix)


def calculate_chamber_reaction_progress(
    Lstar: float,
    Pc: float,
    Tc: float,
    cstar: float,
    gamma: float,
    R: float,
    MR: float,
    config: PintleEngineConfig,
    spray_diagnostics: Optional[Dict] = None,
    Tc_kinetics: Optional[float] = None,
) -> Dict[str, float]:
    """
    Calculate reaction progress through chamber using actual physics.
    
    No reference conditions - all calculations based on actual engine state.
    
    Parameters:
    -----------
    Lstar : float
        Characteristic length [m]
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K] (Used for residence time - Ideal is conservative)
    cstar : float
        Characteristic velocity [m/s]
    gamma : float
        Specific heat ratio
    R : float
        Gas constant [J/(kg·K)]
    MR : float
        Mixture ratio
    config : PintleEngineConfig
        Engine configuration
    spray_diagnostics : dict, optional
        Spray diagnostics (SMD, velocities, etc.) for evaporation/mixing
    Tc_kinetics : float, optional
        Temperature to use for reaction kinetics [K]. If None, uses Tc.
        (Actual/Effective is conservative)
    
    Returns:
    --------
    results : dict
        Reaction progress and time scales
    """
    # Validate all inputs - raise errors, don't clamp
    if not all(np.isfinite([Lstar, Pc, Tc, cstar, gamma, R, MR])):
        raise ValueError("Non-finite input parameters to calculate_chamber_reaction_progress")
    
    # Use Tc_kinetics for reaction-rate limited processes if provided
    T_react = Tc_kinetics if Tc_kinetics is not None else Tc
    
    if Lstar <= 0 or Pc <= 0 or Tc <= 0 or cstar <= 0 or gamma <= 1.0 or R <= 0 or MR <= 0 or T_react <= 0:
        raise ValueError(f"Invalid physical parameters: L*={Lstar}, Pc={Pc}, Tc={Tc}, T_react={T_react}, c*={cstar}, γ={gamma}, R={R}, MR={MR}")
    
    # Calculate residence time from actual conditions (Ideal Tc is conservative: shorter time)
    # τ_res = V_chamber * rho / mdot
    # Since L* = V_chamber / At and mdot = Pc * At / cstar (choked flow):
    # τ_res = (Lstar * At) * (Pc / (R * Tc)) / (Pc * At / cstar) = Lstar * cstar / (R * Tc)
    tau_residence, tau_valid = NumericalStability.safe_divide(Lstar * cstar, R * Tc, None, "tau_residence")
    if not tau_valid.passed:
        raise ValueError(f"Residence time calculation failed: L*={Lstar}, c*={cstar}, R={R}, Tc={Tc}")
    
    # Get fuel type from config
    fuel_name = config.propellants.fuel.name if hasattr(config, 'propellants') else "RP-1"
    
    # Calculate reaction time scale from Arrhenius kinetics (Actual T_react is conservative: longer time)
    tau_reaction = calculate_reaction_time_scale(Pc, T_react, MR, fuel_name, config=config)
    
    # Calculate evaporation time from droplet physics (Actual T_react is conservative: longer time)
    # Use SMD from spray diagnostics if available
    if spray_diagnostics and "SMD" in spray_diagnostics:
        smd = spray_diagnostics["SMD"]  # [m]
    else:
        # Estimate from spray physics (typical SMD ~ 50-200 microns)
        smd = 100e-6  # 100 microns default
    
    fuel_props = None
    if hasattr(config, 'propellants') and hasattr(config.propellants, 'fuel'):
        fuel_props = {
            "density": config.propellants.fuel.density,
            "boiling_point": getattr(config.propellants.fuel, 'boiling_point', 489.0),
        }
    
    tau_evaporation = calculate_evaporation_time_scale(Pc, T_react, smd, fuel_props, gamma=gamma, R_gas=R)
    
    # Calculate mixing time from actual flow velocities
    # Mean velocity from characteristic velocity
    # c* ≈ a* ≈ u* (at throat conditions), so mean velocity ≈ c* / 10-20
    u_mean = cstar / 15.0  # Approximate mean velocity
    
    # Turbulence intensity from spray diagnostics if available
    turbulence_intensity = 0.1  # Default 10%
    if spray_diagnostics and "turbulence_intensity_mix" in spray_diagnostics:
        turbulence_intensity = spray_diagnostics["turbulence_intensity_mix"]
    
    tau_mixing = calculate_mixing_time_scale(Lstar, u_mean, turbulence_intensity)
    
    # Effective time scale for sequential process
    # Reactions start during mixing, so combine: τ_eff = sqrt(τ_mix² + τ_reac²) + τ_evap
    mixing_squared = tau_mixing ** 2
    reaction_squared = tau_reaction ** 2
    
    if not (np.isfinite(mixing_squared) and np.isfinite(reaction_squared)):
        raise ValueError(f"Non-finite time scales: τ_mix={tau_mixing}, τ_reac={tau_reaction}")
    
    sum_squared = mixing_squared + reaction_squared
    tau_combined, tau_combined_valid = NumericalStability.safe_sqrt(sum_squared, "sqrt(tau_mix^2 + tau_reac^2)")
    if not tau_combined_valid.passed:
        # Fallback to simple sum if sqrt fails
        tau_combined = tau_mixing + tau_reaction
    
    tau_effective = tau_evaporation + tau_combined
    
    if not np.isfinite(tau_effective) or tau_effective <= 0:
        raise ValueError(f"Non-physical effective time: τ_eff={tau_effective}")
    
    # Reaction progress at different locations
    progress_injection = calculate_reaction_progress(0.0, tau_effective, 0.0)
    progress_mid = calculate_reaction_progress(tau_residence / 2.0, tau_effective, 0.0)
    progress_throat = calculate_reaction_progress(tau_residence, tau_effective, 0.0)
    
    return {
        "progress_injection": float(progress_injection),
        "progress_mid": float(progress_mid),
        "progress_throat": float(progress_throat),
        "tau_residence": float(tau_residence),
        "tau_evaporation": float(tau_evaporation),
        "tau_mixing": float(tau_mixing),
        "tau_reaction": float(tau_reaction),
        "tau_effective": float(tau_effective),
    }


def calculate_frozen_gamma_from_composition(
    gamma_equilibrium: float,
    P: float,
    T: float,
    cea_cache: Optional[Any] = None,
) -> float:
    """
    Calculate frozen gamma from actual composition differences.
    
    Frozen composition = composition at high T, P (no dissociation)
    Equilibrium composition = composition at current T, P (with dissociation)
    
    Uses CEA to get gamma at high-pressure limit (frozen) vs equilibrium.
    
    Parameters:
    -----------
    gamma_equilibrium : float
        Gamma at equilibrium (current conditions)
    P : float
        Pressure [Pa]
    T : float
        Temperature [K]
    cea_cache : optional
        CEA cache to get actual composition-based gamma
    
    Returns:
    --------
    gamma_frozen : float
        Gamma for frozen composition
    """
    # If we have CEA cache, get actual frozen gamma from high-P limit
    # For now, use composition-based estimate
    
    # Frozen composition has less dissociation → more complex molecules → higher gamma
    # Typical shift: 0.05 to 0.25 depending on temperature
    # At very high T: more dissociation in equilibrium → larger shift
    # At low T: less dissociation → smaller shift
    
    # Calculate frozen gamma from actual composition difference
    # Frozen = high pressure limit (no dissociation)
    # Equilibrium = current conditions (with dissociation)
    
    # If we have CEA cache, get actual frozen gamma from high-P limit
    if cea_cache is not None:
        # Try to get frozen gamma by evaluating at high pressure (10x current)
        # This suppresses dissociation
        try:
            # Get MR from cache if available, otherwise must be provided
            MR = getattr(cea_cache, 'last_MR', None)
            if MR is None:
                # Cannot use hardcoded value - this is a physics error
                # MR should be passed as parameter or stored in cache
                raise ValueError("MR must be provided or available from cea_cache. Cannot use hardcoded value.")
            # Evaluate at high pressure (frozen limit)
            P_frozen = P * 10.0  # 10x pressure suppresses dissociation
            frozen_props = cea_cache.eval(MR, P_frozen, T, None)
            gamma_frozen = frozen_props.get('gamma', None)
            if gamma_frozen is not None and np.isfinite(gamma_frozen) and gamma_frozen > gamma_equilibrium:
                return float(gamma_frozen)
        except Exception:
            # CEA evaluation failed - use composition-based estimate
            pass
    
    # Composition-based estimate: frozen has less dissociation
    # Dissociation reduces average molecular weight → lower gamma
    # Temperature-dependent: more dissociation at higher T
    # Pressure-dependent: less dissociation at higher P
    
    # Use actual dissociation equilibrium
    # For hydrocarbon combustion products:
    # - At high T, low P: significant dissociation (CO2 → CO + O, H2O → H + OH)
    # - At high T, high P: less dissociation (Le Chatelier's principle)
    
    # Estimate dissociation fraction from temperature
    # Typical dissociation energy: ~500-1000 kJ/mol
    # At T ~ 3000 K: kT ~ 25 kJ/mol → some dissociation
    # At T ~ 3500 K: kT ~ 29 kJ/mol → more dissociation
    
    # Use Arrhenius-like scaling for dissociation
    E_diss = 800000.0  # J/mol - typical dissociation energy
    T_ref = 3000.0  # K - reference temperature
    dissociation_factor = np.exp(-E_diss / (R_gas * T)) / np.exp(-E_diss / (R_gas * T_ref))
    
    # Pressure effect: higher P suppresses dissociation
    P_ref = 1e6  # 1 MPa reference
    pressure_suppression = (P / P_ref) ** 0.3  # Weak pressure dependence
    
    # Gamma shift: more dissociation → lower gamma
    # Typical shift: 0.05-0.20 depending on conditions
    # Maximum shift occurs at high T, low P
    max_shift = 0.20  # Maximum possible shift
    shift_factor = max_shift * dissociation_factor / (1.0 + pressure_suppression)
    
    # No arbitrary clamping - let physics determine
    # But ensure physical bounds: frozen gamma > equilibrium (less dissociation)
    gamma_frozen = gamma_equilibrium + shift_factor
    
    # Frozen gamma should be higher (less dissociation)
    if gamma_frozen <= gamma_equilibrium:
        raise ValueError(f"Frozen gamma should be > equilibrium: γ_frozen={gamma_frozen}, γ_eq={gamma_equilibrium}")
    
    # Physical bounds: gamma between 1.0 and 2.0
    if gamma_frozen > 2.0 or gamma_frozen < 1.0:
        raise ValueError(f"Gamma out of physical bounds: γ_frozen={gamma_frozen}")
    
    return float(gamma_frozen)


def calculate_shifting_equilibrium_gamma(
    P_chamber: float,
    T_chamber: float,
    gamma_chamber: float,
    P_exit: float,
    T_exit: float,
    progress_chamber: float,
    reaction_rate_factor: float = 0.1,
    cea_cache: Optional[Any] = None,
    MR: Optional[float] = None,  # Mixture ratio (must be provided)
) -> Tuple[float, float]:
    """
    Calculate gamma for shifting equilibrium in nozzle from actual flow physics.
    
    Uses Damköhler number based on actual expansion and reaction time scales.
    No reference conditions - all from actual flow.
    
    Parameters:
    -----------
    P_chamber : float
        Chamber pressure [Pa]
    T_chamber : float
        Chamber temperature [K]
    gamma_chamber : float
        Gamma at chamber (equilibrium)
    P_exit : float
        Exit pressure [Pa]
    T_exit : float
        Exit temperature [K]
    progress_chamber : float
        Reaction progress at chamber (0-1)
    reaction_rate_factor : float
        User-adjustable factor (0 = frozen, 1 = equilibrium)
    cea_cache : optional
        CEA cache for composition-based frozen gamma
    
    Returns:
    --------
    gamma_exit : float
        Gamma at exit (shifting equilibrium)
    equilibrium_factor : float
        How close to equilibrium at exit (0-1)
    """
    # Validate inputs
    if not all(np.isfinite([P_chamber, T_chamber, gamma_chamber, P_exit, T_exit, progress_chamber])):
        raise ValueError("Non-finite input parameters to calculate_shifting_equilibrium_gamma")
    
    if P_chamber <= 0 or T_chamber <= 0 or P_exit <= 0 or T_exit <= 0:
        raise ValueError(f"Invalid pressures/temperatures: Pc={P_chamber}, Tc={T_chamber}, Pe={P_exit}, Te={T_exit}")
    
    if gamma_chamber <= 1.0 or gamma_chamber > 2.0:
        raise ValueError(f"Invalid gamma: {gamma_chamber}")
    
    if progress_chamber < 0 or progress_chamber > 1:
        raise ValueError(f"Invalid progress: {progress_chamber}")
    
    # Calculate frozen gamma from actual composition
    gamma_frozen = calculate_frozen_gamma_from_composition(
        gamma_chamber, P_chamber, T_chamber, cea_cache
    )
    
    # Calculate expansion time scale from actual flow
    # τ_expansion ≈ L_nozzle / u_mean
    # Approximate from pressure ratio: faster expansion = higher pressure ratio
    # Use isentropic flow: u ≈ sqrt(2 × cp × (Tc - Te))
    cp_chamber = gamma_chamber * R_gas / (gamma_chamber - 1.0)  # J/(kg·K), approximate
    delta_T = T_chamber - T_exit
    
    if delta_T <= 0:
        raise ValueError(f"Invalid temperature drop: Tc={T_chamber}, Te={T_exit}")
    
    u_exit_squared = 2.0 * cp_chamber * delta_T
    u_exit, u_valid = NumericalStability.safe_sqrt(u_exit_squared, "u_exit")
    if not u_valid.passed:
        raise ValueError(f"Exit velocity calculation failed: {u_valid.message}")
    
    # Nozzle length: calculate from actual geometry
    # For conical nozzle: L_nozzle = (De - Dt) / (2 * tan(θ))
    # For bell nozzle: L_nozzle ≈ 0.8 * De (typical)
    # Use pressure ratio to estimate expansion ratio, then get length
    eps = P_chamber / P_exit  # Pressure ratio (approximate expansion ratio)
    
    # Get actual geometry from cea_cache if available
    if cea_cache is not None and hasattr(cea_cache, 'config'):
        # Try to get throat diameter from config
        from engine.pipeline.config_schemas import ensure_chamber_geometry
        try:
            cg = ensure_chamber_geometry(cea_cache.config)
            if cg.A_throat:
                A_throat = cg.A_throat
                D_throat = np.sqrt(4.0 * A_throat / np.pi)
            else:
                raise ValueError("A_throat not available")
        except (ValueError, AttributeError):
            # Fallback: estimate from pressure ratio (isentropic area ratio)
            # A/A* = (1/M) * [(2/(γ+1)) * (1 + (γ-1)/2 * M²)]^((γ+1)/(2(γ-1)))
            # For large eps, M ≈ sqrt(2/(γ-1) * (eps^((γ-1)/γ) - 1))
            M_approx = np.sqrt(2.0 / (gamma_chamber - 1.0) * (eps ** ((gamma_chamber - 1.0) / gamma_chamber) - 1.0))
            M_approx = max(M_approx, 1.0)  # Must be supersonic
            # Estimate D_throat from typical rocket sizes (20-50 mm for small engines)
            D_throat = 0.020  # 20 mm default (will be overridden if config available)
    else:
        # No config available - estimate from typical rocket scaling
        # For small engines: D_throat ~ 0.02-0.05 m
        D_throat = 0.020  # 20 mm default
    
    # Nozzle length: bell nozzle approximation L ≈ 0.8 * De
    # De ≈ Dt * sqrt(eps) for circular cross-section
    D_exit = D_throat * np.sqrt(eps)
    L_nozzle = 0.8 * D_exit  # Typical bell nozzle length
    
    tau_expansion, tau_exp_valid = NumericalStability.safe_divide(L_nozzle, u_exit, None, "tau_expansion")
    if not tau_exp_valid.passed:
        raise ValueError(f"Expansion time calculation failed: L={L_nozzle}, u={u_exit}")
    
    # Get mixture ratio - must be provided or available
    if MR is not None:
        MR_exit = MR  # Use provided MR (same as chamber for steady flow)
    elif cea_cache is not None and hasattr(cea_cache, 'last_MR'):
        MR_exit = cea_cache.last_MR  # Use last evaluated MR
    else:
        raise ValueError("MR must be provided. Cannot use hardcoded value - this is a physics error.")
    
    # Get fuel type from config
    fuel_type = None
    if cea_cache is not None and hasattr(cea_cache, 'config'):
        conf = cea_cache.config
        # Path 1: Directly on CEAConfig (most common now)
        if hasattr(conf, 'fuel_name'):
            fuel_type = conf.fuel_name
        # Path 2: Nested in propellants (legacy/alternate)
        elif hasattr(conf, 'propellants') and hasattr(conf.propellants, 'fuel'):
            fuel_type = conf.propellants.fuel.name
        # Path 3: In fluids dict
        elif hasattr(conf, 'fluids') and 'fuel' in conf.fluids:
            fuel_obj = conf.fluids['fuel']
            if hasattr(fuel_obj, 'name'):
                fuel_type = fuel_obj.name
            elif isinstance(fuel_obj, dict):
                fuel_type = fuel_obj.get('name')
        # Path 4: Nested in cea section (legacy)
        elif hasattr(conf, 'cea') and hasattr(conf.cea, 'fuel_name'):
            fuel_type = conf.cea.fuel_name
    # Final fallback - use default but warn
    if fuel_type is None:
        import warnings
        warnings.warn("Fuel type not found in config, using default 'RP-1'. This may affect shifting equilibrium accuracy.")
        fuel_type = "RP-1"  # Default fallback
    
    tau_reaction_exit = calculate_reaction_time_scale(P_exit, T_exit, MR_exit, fuel_type)
    
    # Damköhler number: Da = τ_expansion / τ_reaction
    Da, Da_valid = NumericalStability.safe_divide(tau_expansion, tau_reaction_exit, None, "Damköhler_number")
    if not Da_valid.passed:
        raise ValueError(f"Damköhler number calculation failed: τ_exp={tau_expansion}, τ_reac={tau_reaction_exit}")
    
    # Equilibrium factor: Φ = Da / (1 + Da)
    # Da >> 1: reactions fast → equilibrium (Φ → 1)
    # Da << 1: reactions slow → frozen (Φ → 0)
    equilibrium_factor = Da / (1.0 + Da)
    
    # Adjust based on chamber progress
    # If chamber not at equilibrium, exit won't be either
    equilibrium_factor *= progress_chamber
    
    # Apply user-specified reaction rate factor
    equilibrium_factor = (1.0 - reaction_rate_factor) * (1.0 - equilibrium_factor) + reaction_rate_factor
    
    # Interpolate between frozen and equilibrium
    gamma_exit = gamma_frozen + (gamma_chamber - gamma_frozen) * equilibrium_factor
    
    if not np.isfinite(gamma_exit) or gamma_exit <= 1.0 or gamma_exit > 2.0:
        raise ValueError(f"Non-physical exit gamma: γ_exit={gamma_exit}, γ_frozen={gamma_frozen}, γ_chamber={gamma_chamber}")
    
    return float(gamma_exit), float(equilibrium_factor)


def calculate_shifting_equilibrium_properties(
    P_chamber: float,
    T_chamber: float,
    gamma_chamber: float,
    R_chamber: float,
    P_exit: float,
    progress_chamber: float,
    reaction_rate_factor: float = 0.1,
    cea_cache: Optional[Any] = None,
    MR: Optional[float] = None,  # Mixture ratio (must be provided)
) -> Dict[str, float]:
    """
    Calculate thermodynamic properties at exit using shifting equilibrium.
    
    All calculations based on actual flow conditions, no references.
    
    Parameters:
    -----------
    P_chamber : float
        Chamber pressure [Pa]
    T_chamber : float
        Chamber temperature [K]
    gamma_chamber : float
        Gamma at chamber
    R_chamber : float
        Gas constant at chamber [J/(kg·K)]
    P_exit : float
        Exit pressure [Pa]
    progress_chamber : float
        Reaction progress at chamber (0-1)
    reaction_rate_factor : float
        Reaction rate factor (0 = frozen, 1 = equilibrium)
    cea_cache : optional
        CEA cache for composition calculations
    
    Returns:
    --------
    properties : dict
        Exit properties with shifting equilibrium
    """
    # Validate inputs
    if not all(np.isfinite([P_chamber, T_chamber, gamma_chamber, R_chamber, P_exit, progress_chamber])):
        raise ValueError("Non-finite input parameters to calculate_shifting_equilibrium_properties")
    
    # Calculate exit temperature (isentropic) for initial guess
    pressure_ratio, P_ratio_valid = NumericalStability.safe_divide(P_exit, P_chamber, None, "P_exit/P_chamber")
    if not P_ratio_valid.passed or pressure_ratio <= 0 or pressure_ratio >= 1:
        raise ValueError(f"Invalid pressure ratio: Pe/Pc={pressure_ratio}")
    
    # Isentropic temperature ratio: T/T0 = (P/P0)^((γ-1)/γ)
    gamma_exponent, gamma_exp_valid = NumericalStability.safe_divide(
        gamma_chamber - 1.0, gamma_chamber, None, "(gamma-1)/gamma"
    )
    if not gamma_exp_valid.passed:
        raise ValueError(f"Invalid gamma exponent: γ={gamma_chamber}")
    
    temp_ratio = pressure_ratio ** gamma_exponent
    if not np.isfinite(temp_ratio) or temp_ratio <= 0 or temp_ratio >= 1:
        raise ValueError(f"Invalid temperature ratio: T_ratio={temp_ratio}")
    
    T_exit_guess = T_chamber * temp_ratio
    if not np.isfinite(T_exit_guess) or T_exit_guess <= 0 or T_exit_guess >= T_chamber:
        raise ValueError(f"Invalid exit temperature guess: Te={T_exit_guess}, Tc={T_chamber}")
    
    # Get MR if not provided
    if MR is None and cea_cache is not None:
        MR = getattr(cea_cache, 'last_MR', None)
    if MR is None:
        raise ValueError("MR must be provided for shifting equilibrium calculation")
    
    # Calculate shifting equilibrium gamma
    gamma_exit, equilibrium_factor = calculate_shifting_equilibrium_gamma(
        P_chamber,
        T_chamber,
        gamma_chamber,
        P_exit,
        T_exit_guess,
        progress_chamber,
        reaction_rate_factor,
        cea_cache,
        MR=MR,
    )
    
    # Recalculate T_exit with shifting gamma
    # Use average gamma for isentropic relation
    gamma_avg = (gamma_chamber + gamma_exit) / 2.0
    
    gamma_exponent_avg, gamma_exp_avg_valid = NumericalStability.safe_divide(
        gamma_avg - 1.0, gamma_avg, None, "(gamma_avg-1)/gamma_avg"
    )
    if not gamma_exp_avg_valid.passed:
        raise ValueError(f"Invalid average gamma exponent: γ_avg={gamma_avg}")
    
    temp_ratio_avg = pressure_ratio ** gamma_exponent_avg
    if not np.isfinite(temp_ratio_avg):
        raise ValueError(f"Non-finite temperature ratio: T_ratio_avg={temp_ratio_avg}")
    
    T_exit = T_chamber * temp_ratio_avg
    if not np.isfinite(T_exit) or T_exit <= 0:
        raise ValueError(f"Non-physical exit temperature: Te={T_exit}")
    
    # Gas constant changes with composition shift
    # R = R_universal / M_molecular
    # For shifting equilibrium: composition changes → molecular weight changes → R changes
    
    # Relationship between gamma and molecular weight:
    # γ = 1 + 2/(f + 2) where f is degrees of freedom
    # For ideal gas: cp = (f/2 + 1) * R, cv = (f/2) * R
    # γ = cp/cv = 1 + 2/f
    # f = 2/(γ - 1)
    
    # Molecular weight affects R but not gamma directly
    # However, composition changes affect both
    # For hydrocarbon products: dissociation creates simpler molecules (lower M) → higher R
    
    # Calculate from actual composition change
    # If we have CEA, get actual R from composition
    if cea_cache is not None:
        try:
            MR = getattr(cea_cache, 'last_MR', None)
            if MR is not None:
                # Get R at exit conditions (with shifting equilibrium)
                # Use equilibrium factor to interpolate
                R_equilibrium = R_chamber  # At exit with equilibrium composition
                # Get frozen R (high P limit)
                P_frozen = P_exit * 10.0
                frozen_props = cea_cache.eval(MR, P_frozen, T_exit, None)
                R_frozen = frozen_props.get('R', None)
                if R_frozen is not None and np.isfinite(R_frozen):
                    # Interpolate based on equilibrium factor
                    R_exit = R_frozen + (R_equilibrium - R_frozen) * equilibrium_factor
                    if np.isfinite(R_exit) and R_exit > 0:
                        return {
                            "gamma_exit": float(gamma_exit),
                            "R_exit": float(R_exit),
                            "T_exit": float(T_exit),
                            "equilibrium_factor": float(equilibrium_factor),
                            "gamma_avg": float(gamma_avg),
                        }
        except Exception:
            # CEA evaluation failed - use composition-based estimate
            pass
    
    # Composition-based estimate: R changes with molecular weight
    # For dissociation: M decreases → R increases
    # Relationship: R_frozen / R_equilibrium ≈ M_equilibrium / M_frozen
    # From gamma relationship: can estimate M change
    
    # Approximate: ΔR/R ≈ -α × Δγ/γ where α depends on composition
    # For hydrocarbon products: α ≈ 0.15-0.25 (empirical)
    # Use equilibrium factor to determine composition state
    gamma_diff = gamma_exit - gamma_chamber
    gamma_frozen = calculate_frozen_gamma_from_composition(gamma_chamber, P_chamber, T_chamber, cea_cache)
    gamma_range = gamma_frozen - gamma_chamber
    
    if abs(gamma_range) > 1e-6:
        # Composition change factor (0 = equilibrium, 1 = frozen)
        composition_factor = (gamma_exit - gamma_chamber) / gamma_range
        
        # R change: frozen has simpler molecules → higher R
        # Typical: R_frozen / R_equilibrium ≈ 1.05-1.15 for hydrocarbon products
        R_ratio_max = 1.10  # Maximum R increase for frozen composition
        R_change_ratio = (R_ratio_max - 1.0) * composition_factor
        
        R_exit = R_chamber * (1.0 + R_change_ratio)
    else:
        # No composition change → no R change
        R_exit = R_chamber
    if not np.isfinite(R_exit) or R_exit <= 0:
        raise ValueError(f"Non-physical exit gas constant: R_exit={R_exit}")
    
    return {
        "gamma_exit": float(gamma_exit),
        "R_exit": float(R_exit),
        "T_exit": float(T_exit),
        "equilibrium_factor": float(equilibrium_factor),
        "gamma_avg": float(gamma_avg),
    }


# Keep species evolution function simple - no changes needed
def calculate_species_evolution(
    progress: float,
    species_equilibrium: Dict[str, float],
    species_initial: Optional[Dict[str, float]] = None,
) -> Dict[str, float]:
    """
    Calculate species concentrations based on reaction progress.
    
    Linear interpolation between initial and equilibrium:
    X_species = X_initial + progress × (X_equilibrium - X_initial)
    
    Parameters:
    -----------
    progress : float
        Reaction progress (0-1)
    species_equilibrium : dict
        Equilibrium species mole fractions {species_name: fraction}
    species_initial : dict, optional
        Initial species mole fractions (default: pure reactants)
    
    Returns:
    --------
    species_current : dict
        Current species mole fractions
    """
    if not np.isfinite(progress) or progress < 0 or progress > 1:
        raise ValueError(f"Invalid progress: {progress}")
    
    if species_initial is None:
        species_initial = {}
    
    species_current = {}
    
    # Interpolate between initial and equilibrium
    for species, X_eq in species_equilibrium.items():
        if not np.isfinite(X_eq) or X_eq < 0 or X_eq > 1:
            raise ValueError(f"Invalid equilibrium fraction for {species}: {X_eq}")
        
        X_init = species_initial.get(species, 0.0)
        if not np.isfinite(X_init) or X_init < 0 or X_init > 1:
            raise ValueError(f"Invalid initial fraction for {species}: {X_init}")
        
        X_current = X_init + progress * (X_eq - X_init)
        
        # Natural bounds from interpolation, but validate
        if not np.isfinite(X_current) or X_current < 0 or X_current > 1:
            raise ValueError(f"Non-physical species fraction for {species}: X={X_current}")
        
        species_current[species] = float(X_current)
    
    return species_current
