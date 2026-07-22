"""Finite-rate chemistry and reaction progress modeling for combustion chamber.

This module provides physics-based (not reference-based) models for:
1. Reaction progress tracking through chamber
2. Finite-rate chemistry effects using actual Arrhenius kinetics
3. Species evolution modeling
4. Shifting equilibrium in nozzle based on actual flow conditions
"""

from __future__ import annotations

from typing import Dict, List, Tuple, Optional, Any
import warnings
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.pipeline.numerical_robustness import (
    NumericalStability,
    PhysicalConstraints,
)

# Universal gas constant [J/(mol·K)]
R_gas = 8314.462618  # J/(kmol·K) for per-kmol calculations


def _fuel_name_for_kinetics(config: PintleEngineConfig) -> str:
    """Label used for Arrhenius fuel-type branching (matches reaction_rate_constant lists).

    Priority: legacy ``propellants.fuel.name`` → ``combustion.cea.fuel_name`` → ``fluids['fuel'].name``
    → ``\"RP-1\"``.
    """
    prop = getattr(config, "propellants", None)
    if prop is not None and getattr(prop, "fuel", None) is not None:
        name = getattr(prop.fuel, "name", None)
        if name:
            return str(name)
    cea = getattr(getattr(config, "combustion", None), "cea", None)
    if cea is not None:
        fn = getattr(cea, "fuel_name", None)
        if fn:
            return str(fn)
    fluids = getattr(config, "fluids", None)
    if fluids and "fuel" in fluids:
        fuel = fluids["fuel"]
        fn = getattr(fuel, "name", None)
        if fn:
            return str(fn)
    return "RP-1"


def _fuel_props_for_evaporation(config: PintleEngineConfig) -> Optional[Dict[str, float]]:
    """Density and boiling point for droplet evaporation time scale."""
    prop = getattr(config, "propellants", None)
    if prop is not None and getattr(prop, "fuel", None) is not None:
        bp = getattr(prop.fuel, "boiling_point", None)
        return {
            "density": float(prop.fuel.density),
            "boiling_point": float(bp) if bp is not None else 489.0,
        }
    fluids = getattr(config, "fluids", None)
    if not fluids or "fuel" not in fluids:
        return None
    fuel = fluids["fuel"]
    bp = getattr(fuel, "boiling_point", None)
    return {
        "density": float(fuel.density),
        "boiling_point": float(bp) if bp is not None else 489.0,
    }


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
        elif fuel_type.upper() in ["CH4", "METHANE"]:
            # Methane: explicit branch (falls back to hydrocarbon kinetics if no methane-specific attrs)
            A0 = getattr(eff_cfg, "A0_methane", eff_cfg.A0_hydrocarbon)
            n_pre = getattr(eff_cfg, "n_pre_methane", eff_cfg.n_pre_hydrocarbon)
            Ea = getattr(eff_cfg, "Ea_methane", eff_cfg.Ea_hydrocarbon)
            n_pressure = 0.8
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
        elif fuel_type.upper() in ["CH4", "METHANE"]:
            A0 = 1.5e7
            n_pre = 0.3
            Ea = 100000.0
            n_pressure = 0.8
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
    
    fuel_name = _fuel_name_for_kinetics(config)

    # Calculate reaction time scale from Arrhenius kinetics (Actual T_react is conservative: longer time)
    tau_reaction = calculate_reaction_time_scale(Pc, T_react, MR, fuel_name, config=config)
    
    # Calculate evaporation time from droplet physics (Actual T_react is conservative: longer time)
    # Use SMD from spray diagnostics if available
    if spray_diagnostics and "SMD" in spray_diagnostics:
        smd = spray_diagnostics["SMD"]  # [m]
    else:
        # Estimate from spray physics (typical SMD ~ 50-200 microns)
        smd = 100e-6  # 100 microns default
    
    fuel_props = _fuel_props_for_evaporation(config)

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


# --- Retired: shifting-equilibrium nozzle approximation ------------------------
# calculate_frozen_gamma_from_composition / calculate_shifting_equilibrium_gamma /
# calculate_shifting_equilibrium_properties were an empirical Damkoehler estimate
# of the exit composition shift (~700 lines). Superseded by CEA's shifting-
# equilibrium vacuum thrust coefficient (cea_cache "Cf_vac"). See
# docs/thrust_efficiency_bug_analysis.md. Removed 2026-06-28.


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
