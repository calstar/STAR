"""Combustion efficiency models (L* correction)

This module provides both:
1. Simple efficiency model (eta_cstar) - backward compatible
2. Advanced physics-based model (via combustion_physics module)
"""

import numpy as np
import logging
from typing import Optional, Dict, Any
from .config_schemas import CombustionEfficiencyConfig
from .constants import (
    DEFAULT_CHAMBER_PRESS_PA,
    DEFAULT_CHAMBER_TEMP_K,
    DEFAULT_CSTAR_IDEAL_M_S,
    DEFAULT_GAMMA_ND,
    DEFAULT_GAS_CONST_J_KG_K,
    DEFAULT_MIXTURE_RATIO_ND,
    DEFAULT_TURBULENCE_INTENSITY_ND,
)


def calculate_Lstar(
    V_chamber: float,
    A_throat: float,
    Lstar_override: Optional[float] = None
) -> float:
    """
    Calculate characteristic length L*.
    
    L* = V_chamber / A_throat
    
    Parameters:
    -----------
    V_chamber : float
        Chamber volume [m³]
    A_throat : float
        Throat area [m²]
    Lstar_override : float, optional
        Override value if provided in config
    
    Returns:
    --------
    Lstar : float [m]
    """
    if Lstar_override is not None:
        return float(Lstar_override)
    
    if A_throat <= 0:
        raise ValueError("A_throat must be positive")
    
    Lstar = V_chamber / A_throat
    return float(Lstar)


def eta_cstar(
    Lstar: float,
    config: CombustionEfficiencyConfig,
    cooling_efficiency: float,
    advanced_params: Dict[str, Any],
    debug: bool = False,
) -> float:
    """
    Calculate combustion efficiency using advanced physics-based model.
    
    This corrects CEA's infinite-area equilibrium assumption for finite chambers.
    
    NOTE: CEA uses EQUILIBRIUM flow (not frozen). The correction accounts for:
    - Finite residence time (L*)
    - Incomplete mixing
    - Finite-rate chemistry effects
    - Heat losses (applied externally via cooling_efficiency)
    
    Parameters:
    -----------
    Lstar : float
        Characteristic length [m]
    config : CombustionEfficiencyConfig
        Efficiency configuration
    cooling_efficiency : float
        Cooling efficiency factor (from heat transfer), applied externally
    advanced_params : dict
        Required parameters for advanced model:
        - Pc: Chamber pressure [Pa]
        - Tc: Chamber temperature [K]
        - cstar_ideal: Ideal c* [m/s]
        - gamma: Specific heat ratio
        - R: Gas constant [J/(kg·K)]
        - MR: Mixture ratio
        - Ac: Chamber cross-sectional area [m²]
        - At: Throat area [m²]
        - m_dot_total: Total mass flow rate [kg/s]
        - chamber_length: Chamber length [m]
        - Dinj: Injector diameter [m] (optional, estimated from Ac if not provided)
        - u_fuel: Fuel injection velocity [m/s] (optional)
        - u_lox: LOX injection velocity [m/s] (optional)
        - spray_diagnostics: Spray diagnostics dict (optional)
        - turbulence_intensity: Turbulence intensity 0-1 (optional)
        - Tc_kinetics: Temperature for kinetics [K] (optional)
        - fuel_props: Fuel properties dict (optional)
    debug : bool
        Enable debug logging
    
    Returns:
    --------
    eta : float
        Combustion efficiency (0-1)
    """
    from .combustion_physics import calculate_combustion_efficiency_advanced
    
    # Extract parameters
    Pc = advanced_params.get("Pc", DEFAULT_CHAMBER_PRESS_PA)
    Tc = advanced_params.get("Tc", DEFAULT_CHAMBER_TEMP_K)
    Tc_kinetics = advanced_params.get("Tc_kinetics", None)
    
    # DEBUG: advanced_params extraction
    if debug:
        logging.getLogger("evaluate").info(
            f"[EFF_DEBUG] Pc={Pc/1e6:.3f} MPa, Tc={Tc:.0f} K, "
            f"Tc_kinetics={Tc_kinetics if Tc_kinetics else 'None'}"
        )
    
    cstar_ideal = advanced_params.get("cstar_ideal", DEFAULT_CSTAR_IDEAL_M_S)
    gamma = advanced_params.get("gamma", DEFAULT_GAMMA_ND)
    R = advanced_params.get("R", DEFAULT_GAS_CONST_J_KG_K)
    MR = advanced_params.get("MR", DEFAULT_MIXTURE_RATIO_ND)
    Ac = advanced_params.get("Ac", None)
    At = advanced_params.get("At", None)
    chamber_length = advanced_params.get("chamber_length", None)
    m_dot_total = advanced_params.get("m_dot_total", None)
    u_fuel = advanced_params.get("u_fuel", None)
    u_lox = advanced_params.get("u_lox", None)
    Dinj = advanced_params.get("Dinj", None)
    spray_diagnostics = advanced_params.get("spray_diagnostics", None)
    turbulence_intensity = advanced_params.get("turbulence_intensity", DEFAULT_TURBULENCE_INTENSITY_ND)
    fuel_props = advanced_params.get("fuel_props", None)
    
    # Validate required parameters
    if Ac is None or m_dot_total is None:
        raise ValueError("Ac and m_dot_total are required for combustion efficiency calculation")
    if At is None:
        raise ValueError("At is required for combustion efficiency calculation")
    if chamber_length is None:
        raise ValueError("chamber_length is required for combustion efficiency calculation")
    
    # Estimate Dinj from chamber area if not provided
    if Dinj is None:
        Dinj = float(np.sqrt(4.0 * Ac / np.pi))
    Dinj = float(max(Dinj, 1e-6))
    
    # Calculate advanced efficiency
    results = calculate_combustion_efficiency_advanced(
        Lstar, Pc, Tc, cstar_ideal, gamma, R, MR, config,
        Ac, At, Dinj, m_dot_total,
        u_fuel=u_fuel, u_lox=u_lox,
        spray_diagnostics=spray_diagnostics, 
        turbulence_intensity=turbulence_intensity,
        chamber_length=chamber_length,
        Tc_kinetics=Tc_kinetics,
        fuel_props=fuel_props,
        debug=debug
    )
    
    eta = results["eta_total"]
    
    if debug:
        logging.getLogger("evaluate").info(
            f"[ADV_EFF_DEBUG] eta_total: {eta:.4f} "
            f"(Lstar: {results['eta_Lstar']:.4f}, Kinetics: {results['eta_kinetics']:.4f}, "
            f"Mixing: {results['eta_mixing']:.4f})"
        )
    
    # Apply cooling efficiency (external factor)
    # NOTE: The advanced model does NOT include cooling losses internally.
    # We apply cooling_efficiency here as an external multiplicative factor.
    # This is by design to avoid double-counting and maintain clear separation.
    
    # Validate cooling efficiency - no clipping, raise error if invalid
    if not np.isfinite(cooling_efficiency):
        raise ValueError(f"Invalid cooling_efficiency: {cooling_efficiency}. Must be finite.")
    if cooling_efficiency < 0.0 or cooling_efficiency > 1.0:
        raise ValueError(
            f"Invalid cooling_efficiency: {cooling_efficiency:.4f}. Must be in [0, 1]. "
            f"Check heat transfer calculations and cooling model configuration."
        )
    
    cooling_eff = float(cooling_efficiency)
    eta *= cooling_eff
    
    # Validate final efficiency - no clipping, raise error if invalid
    if not np.isfinite(eta):
        raise ValueError(f"Invalid combustion efficiency: {eta}. Must be finite.")
    if eta < 0.0 or eta > 1.0:
        raise ValueError(
            f"Invalid combustion efficiency: {eta:.4f}. Must be in [0, 1]. "
            f"Check L*={Lstar:.4f} m, mixing quality (eta_mixing={results['eta_mixing']:.4f}), "
            f"kinetics (eta_kinetics={results['eta_kinetics']:.4f}), "
            f"residence time effects (eta_Lstar={results['eta_Lstar']:.4f}), "
            f"and cooling efficiency ({cooling_eff:.4f})."
        )
    
    return float(eta)


def calculate_actual_chamber_temp(
    Tc_ideal: float,
    eta: float,
    gamma: float
) -> float:
    """
    Calculate actual chamber temperature accounting for combustion efficiency.
    
    T_c,actual = T_c,ideal × [η / (1 - (1-η) × (γ-1)/γ)]
    
    Parameters:
    -----------
    Tc_ideal : float
        Ideal chamber temperature from CEA [K]
    eta : float
        Combustion efficiency
    gamma : float
        Specific heat ratio
    
    Returns:
    --------
    Tc_actual : float [K]
    """
    if gamma <= 1:
        return Tc_ideal
    
    denominator = 1.0 - (1.0 - eta) * (gamma - 1.0) / gamma
    if denominator <= 0:
        return Tc_ideal
    
    Tc_actual = Tc_ideal * (eta / denominator)
    return float(Tc_actual)


def calculate_frozen_flow_correction(
    Lstar: float,
    gamma_ideal: float,
    alpha: float = 0.1
) -> float:
    """
    Calculate frozen flow correction factor for gamma.
    
    γ_actual = γ_ideal × [1 - α × (1 - η_c*)]
    
    This accounts for incomplete chemical reactions in the nozzle.
    
    Parameters:
    -----------
    Lstar : float
        Characteristic length [m]
    gamma_ideal : float
        Ideal gamma from CEA
    alpha : float
        Frozen flow parameter (default 0.1)
    
    Returns:
    --------
    correction_factor : float
        Factor to multiply gamma_ideal by
    """
    # Validate inputs
    if Lstar <= 0:
        raise ValueError(f"Invalid Lstar: {Lstar}. Must be positive.")
    if gamma_ideal <= 1.0:
        raise ValueError(f"Invalid gamma_ideal: {gamma_ideal}. Must be > 1.0 for physical gas.")
    if alpha < 0 or alpha > 1:
        raise ValueError(f"Invalid alpha: {alpha}. Must be in [0, 1].")
    
    # Estimate efficiency from L* (simplified)
    # Using default C=0.3, K=0.15
    eta_est = 1.0 - 0.3 * np.exp(-0.15 * Lstar)
    
    correction = 1.0 - alpha * (1.0 - eta_est)
    
    # Validate correction factor - no clipping, raise error if invalid
    if not np.isfinite(correction):
        raise ValueError(f"Invalid frozen flow correction: {correction}. Check Lstar={Lstar}, alpha={alpha}.")
    if correction < 0.5 or correction > 1.1:
        raise ValueError(
            f"Frozen flow correction out of reasonable range: {correction:.4f}. "
            f"Expected [0.5, 1.1] for typical rocket engines. "
            f"Lstar={Lstar:.4f} m, gamma_ideal={gamma_ideal:.4f}, alpha={alpha:.4f}. "
            f"This suggests a fundamental issue with the model or inputs."
        )
    
    return float(correction)
