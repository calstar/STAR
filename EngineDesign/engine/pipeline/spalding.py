"""Spalding number and droplet surface temperature calculations.

This module provides physics-based calculations for:
1. Droplet surface temperature (T_s) estimation
2. Spalding mass transfer number (B_m)

These are used in evaporation time scale and efficiency calculations.
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple
import warnings

import numpy as np

from CoolProp.CoolProp import PropsSI





def calculate_vapor_pressure(
    Ts: float,
    fuel: str = "RP-1",
) -> float:
    """
    Calculate saturation vapor pressure at given temperature.
    
    Uses CoolProp PropsSI with n-dodecane as surrogate for RP-1.
    
    Parameters
    ----------
    Ts : float
        Temperature [K]
    fuel : str
        Fuel name ("RP-1" uses n-dodecane surrogate)
    
    Returns
    -------
    P_sat : float
        Saturation vapor pressure [Pa]
    """

    # Fluid surrogate mapping for CoolProp
    FUEL_SURROGATES = {
        "RP-1": "n-Dodecane",
        "RP1": "n-Dodecane",
        "rp-1": "n-Dodecane",
        "rp1": "n-Dodecane",
        "Ethanol": "Ethanol",
        "ethanol": "Ethanol",
    }
    if not np.isfinite(Ts) or Ts <= 0:
        raise ValueError(f"Invalid temperature: {Ts} K")

    if fuel not in FUEL_SURROGATES:
        raise ValueError(f"Invalid fuel: {fuel}")
    
    # Sanity check for Celsius/Kelvin confusion
    if Ts < 200.0:
        warnings.warn(
            f"[VAPOR_PRESSURE] Ts={Ts:.1f} K is suspiciously low (< 200 K). "
            "Check for Celsius/Kelvin confusion.",
            RuntimeWarning,
            stacklevel=2,
        )
    
    # Get CoolProp fluid name from surrogate mapping
    coolprop_fluid = FUEL_SURROGATES.get(fuel, fuel)

    # Get critical temperature - saturation pressure is undefined at/above T_crit
    T_crit = PropsSI("Tcrit", coolprop_fluid)
    
    # NO SILENT CLAMPING: Raise error if Ts >= T_crit
    # The solver is responsible for enforcing domain boundaries
    if Ts >= T_crit:
        raise ValueError(
            f"[VAPOR_PRESSURE] Ts={Ts:.1f} K >= T_crit={T_crit:.1f} K for {coolprop_fluid}. "
            "Saturation pressure is undefined above critical temperature. "
            "The solver must enforce T_s < T_crit."
        )
    
    # Use CoolProp PropsSI: P = f(T, Q=0 for saturated liquid)
    P_sat = PropsSI("P", "T", Ts, "Q", 0, coolprop_fluid)
    return float(P_sat)


def calculate_droplet_surface_temperature(
    Tc: float,
    Pc: float,
    fuel_props: Optional[Dict] = None,
) -> Tuple[float, float]:
    """
    Calculate droplet surface temperature and film temperature.
    
    The surface temperature T_s is estimated based on:
    - Boiling point at elevated pressure
    - Heat transfer from hot gas
    - Wet-bulb temperature approximation
    
    Film temperature Tf = 0.5 * (Tg + T_s) is used for property evaluation.
    
    Parameters
    ----------
    Tc : float
        Chamber/gas temperature [K]
    Pc : float
        Chamber pressure [Pa]
    fuel_props : dict, optional
        Fuel properties:
        - T_boil or boiling_point: Boiling point at 1 atm [K]
        - L_vap or latent_heat: Latent heat of vaporization [J/kg]
    
    Returns
    -------
    T_s : float
        Droplet surface temperature [K]
    Tf : float
        Film temperature [K]
    """
    if not np.isfinite(Tc) or Tc <= 0:
        raise ValueError(f"Invalid gas temperature: {Tc} K")
    if not np.isfinite(Pc) or Pc <= 0:
        raise ValueError(f"Invalid pressure: {Pc} Pa")
    
    # Extract fuel properties (RP-1 defaults)
    if fuel_props is not None:
        T_boil = fuel_props.get("T_boil", fuel_props.get("boiling_point", 489.0))
    else:
        T_boil = 489.0  # K, RP-1 at 1 atm
    
    # Estimate droplet surface temperature
    # At high heat transfer rates, T_s approaches wet-bulb temperature
    # Approximation: weighted average between boiling point and gas temperature
    # T_s typically 100-300 K above boiling point in rocket conditions
    T_s = min(T_boil + 50.0, 0.7 * Tc + 0.3 * T_boil)
    
    # Clamp to physical bounds
    T_s = max(T_s, T_boil)  # At least boiling point
    T_s = min(T_s, Tc)      # Can't exceed gas temperature
    
    # Film temperature for property evaluation
    Tf = 0.5 * (Tc + T_s)
    
    return float(T_s), float(Tf)


def calculate_spalding_number(
    Tc: float,
    Pc: float,
    T_s: Optional[float] = None,
    fuel_props: Optional[Dict] = None,
    use_reference_pressure: bool = False,
) -> float:
    """
    Calculate Spalding mass transfer number.
    
    Two formulations are available:
    1. Thermodynamic: B = cp * (T_infinity - T_s) / L_vap
    2. Pressure-based: B = Y_s / (1 - Y_s), where Y_s = P_sat(T_s) / Pc
    
    The thermodynamic formulation is more stable during solver iterations.
    The pressure-based formulation can optionally use a reference pressure
    for stability during chamber pressure iteration.
    
    Parameters
    ----------
    Tc : float
        Chamber/gas temperature [K]
    Pc : float
        Chamber pressure [Pa]
    T_s : float, optional
        Droplet surface temperature [K]. If None, calculated internally.
    fuel_props : dict, optional
        Fuel properties:
        - T_boil or boiling_point: Boiling point at 1 atm [K]
        - L_vap or latent_heat: Latent heat of vaporization [J/kg]
        - cp_gas: Gas specific heat [J/(kg·K)] (default: 1200)
        - Pc_ref: Reference pressure for stability [Pa] (default: 2.5e6)
    use_reference_pressure : bool
        If True, use reference pressure instead of actual Pc for stability
        during solver iterations. Default False.
    
    Returns
    -------
    B : float
        Spalding mass transfer number [-]
    """
    if not np.isfinite(Tc) or Tc <= 0:
        raise ValueError(f"Invalid gas temperature: {Tc} K")
    if not np.isfinite(Pc) or Pc <= 0:
        raise ValueError(f"Invalid pressure: {Pc} Pa")
    
    # Extract fuel properties (RP-1 defaults)
    if fuel_props is not None:
        T_boil = fuel_props.get("T_boil", fuel_props.get("boiling_point", 489.0))
        L_vap = fuel_props.get("L_vap", fuel_props.get("latent_heat", 300e3))
        cp_gas = fuel_props.get("cp_gas", 1200.0)
        Pc_ref = fuel_props.get("Pc_ref", 2.5e6)
    else:
        T_boil = 489.0    # K
        L_vap = 300e3     # J/kg
        cp_gas = 1200.0   # J/(kg·K)
        Pc_ref = 2.5e6    # Pa
    
    # Calculate T_s if not provided
    if T_s is None:
        T_s, _ = calculate_droplet_surface_temperature(Tc, Pc, fuel_props)
    
    # Use thermodynamic Spalding number (more stable)
    # B = cp * (T_infinity - T_s) / L_vap
    delta_T = Tc - T_s
    if delta_T <= 0:
        # If gas is cooler than droplet, minimal evaporation
        return 0.01  # Minimum for numerical stability
    
    B = cp_gas * delta_T / L_vap
    
    # Clamp to physically plausible range for rocket conditions
    # Typical range: 0.05 - 10 for high-temperature combustion
    B = np.clip(B, 0.01, 15.0)
    
    return float(B)


def calculate_spalding_pressure_based(
    Tc: float,
    Pc: float,
    T_s: Optional[float] = None,
    fuel_props: Optional[Dict] = None,
    use_reference_pressure: bool = True,
) -> float:
    """
    Calculate Spalding number using pressure-based formulation.
    
    B_m = Y_s / (1 - Y_s), where Y_s = P_sat(T_s) / Pc
    
    This formulation directly uses vapor pressure at the droplet surface.
    Can use a reference pressure for stability during solver iterations.
    
    Parameters
    ----------
    Tc : float
        Chamber/gas temperature [K]
    Pc : float
        Chamber pressure [Pa]
    T_s : float, optional
        Droplet surface temperature [K]. If None, calculated internally.
    fuel_props : dict, optional
        Fuel properties (see calculate_spalding_number)
    use_reference_pressure : bool
        If True, use Pc_ref instead of Pc for stability. Default True.
    
    Returns
    -------
    B : float
        Spalding mass transfer number [-]
    """
    if not np.isfinite(Tc) or Tc <= 0:
        raise ValueError(f"Invalid gas temperature: {Tc} K")
    if not np.isfinite(Pc) or Pc <= 0:
        raise ValueError(f"Invalid pressure: {Pc} Pa")
    
    # Extract fuel properties (RP-1 defaults)
    if fuel_props is not None:
        fuel = fuel_props.get("fuel", fuel_props.get("name", "RP-1"))
        Pc_ref = fuel_props.get("Pc_ref", 2.5e6)
    else:
        fuel = "RP-1"
        Pc_ref = 2.5e6    # Pa
    
    # Calculate T_s if not provided
    if T_s is None:
        T_s, _ = calculate_droplet_surface_temperature(Tc, Pc, fuel_props)
    
    # Calculate saturation vapor pressure using CoolProp
    P_sat = calculate_vapor_pressure(T_s, fuel=fuel)
    
    # Choose pressure for mass fraction calculation
    P_denom = Pc_ref if use_reference_pressure else Pc
    P_denom = max(P_denom, 1e3)  # Prevent division by zero
    
    # Mass fraction at surface: Y_s = P_sat / P
    Y_s = P_sat / P_denom
    Y_s = np.clip(Y_s, 0.0, 0.95)  # Prevent division by zero, cap at 95%
    
    # Pressure-based Spalding number
    B = Y_s / (1.0 - Y_s)
    
    # Clamp to physically plausible range
    B = np.clip(B, 0.05, 1.0)  # Narrower range for stability
    
    return float(B)


def calculate_film_diffusivity(
    Tf: float,
    Pc: float,
    D0: float = 1e-5,
    T0: float = 500.0,
    P0: float = 1e6,
) -> float:
    """
    Calculate mass diffusivity at film temperature.
    
    D = D0 * (Tf/T0)^1.5 * (P0/Pc)
    
    Parameters
    ----------
    Tf : float
        Film temperature [K]
    Pc : float
        Chamber pressure [Pa]
    D0 : float
        Reference diffusivity [m²/s] at T0, P0. Default 1e-5.
    T0 : float
        Reference temperature [K]. Default 500.
    P0 : float
        Reference pressure [Pa]. Default 1e6 (1 MPa).
    
    Returns
    -------
    D : float
        Mass diffusivity [m²/s]
    """
    if not np.isfinite(Tf) or Tf <= 0:
        raise ValueError(f"Invalid film temperature: {Tf} K")
    if not np.isfinite(Pc) or Pc <= 0:
        raise ValueError(f"Invalid pressure: {Pc} Pa")
    
    D = D0 * (Tf / T0) ** 1.5 * (P0 / Pc)
    
    if not np.isfinite(D) or D <= 0:
        raise ValueError(f"Non-physical diffusivity: D={D}")
    
    return float(D)


def calculate_vapor_pressure_antoine(
    Ts: float,
    fuel_props: Optional[Dict] = None,
) -> float:
    """
    Calculate vapor pressure at droplet surface temperature.
    
    Parameters
    ----------
    Ts : float
        Droplet surface temperature [K]
    fuel_props : dict, optional
        Fuel properties (see calculate_spalding_number)
    
    Returns
    -------
    P_sat : float
        Vapor pressure [Pa] at droplet surface temperature
    """
    try:
        A = float(fuel_props["A_antoine"])
        B = float(fuel_props["B_antoine"])
        C = float(fuel_props["C_antoine"])
    except KeyError as e:
        raise KeyError(f"Missing Antoine coefficient: {e}. Need A_antoine, B_antoine, C_antoine.") from e

    log10_P_bar = A - B / (Ts + C)
    P_bar = 10 ** log10_P_bar
    P_sat = P_bar * 1e5
    return float(P_sat)


# Universal gas constant
R_UNIVERSAL = 8314.462618  # J/(kmol·K)


def solve_spalding_coupled(
    T_inf: float,
    P: float,
    W_F: float,
    L_vap: float,
    gamma: Optional[float] = None,
    R_gas: Optional[float] = None,
    fuel: str = "RP-1",
    Y_F_inf: float = 0.0,
    cp_liquid: Optional[float] = None,
    T_liquid_in: Optional[float] = None,
    T_s_init: Optional[float] = None,
    T_min: Optional[float] = None,
    T_max: Optional[float] = None,
    alpha: float = 0.3,
    tol: float = 0.1,
    max_iter: int = 100,
    MR: Optional[float] = None,
    eps: Optional[float] = None,
    cea_props: Optional[callable] = None,
) -> Dict[str, float]:
    """
    Coupled solver for Spalding Mass Number (B_M) and Droplet Surface Temperature (T_s).
    
    Solves a two-equation coupled system by fixed-point iteration with under-relaxation:
    1. B_M = (Y_{F,s} - Y_{F,inf}) / (1 - Y_{F,s})
    2. T_s = T_inf - (L_eff / c_p,g) * ln(1 + B_M)
    
    Uses vapor pressure to compute surface mass fraction Y_{F,s} via mole-to-mass
    fraction conversion.
    
    **Two modes of operation:**
    
    1. **Fixed-property mode** (legacy): Provide `gamma` and `R_gas` directly.
    2. **CEA accessor mode**: Provide `cea_props` callable with `MR` and `eps`.
       The callable has signature `cea_props(Pc, MR, eps) -> (gamma, R)`.
    
    Parameters
    ----------
    T_inf : float
        Far-field gas temperature [K] (e.g., chamber temperature T_c)
    P : float
        Gas pressure [Pa] (e.g., chamber pressure P_c)
    W_F : float
        Molecular weight of fuel vapor [kg/kmol] (numerically = g/mol)
    L_vap : float
        Latent heat of vaporization [J/kg]
    gamma : float, optional
        Specific heat ratio of the gas mixture [-]. Required if cea_props is None.
    R_gas : float, optional
        Mixture-specific gas constant [J/(kg·K)]. Required if cea_props is None.
    fuel : str, optional
        Fuel name for vapor pressure lookup (default: "RP-1")
    Y_F_inf : float, optional
        Far-field fuel vapor mass fraction [-] (default: 0.0)
    cp_liquid : float, optional
        Liquid fuel specific heat [J/(kg·K)]. If provided with T_liquid_in,
        used to compute effective latent heat.
    T_liquid_in : float, optional
        Incoming liquid fuel temperature [K]. If provided with cp_liquid,
        used to compute effective latent heat.
    T_s_init : float, optional
        Initial guess for surface temperature [K]. Default: 0.9 * T_inf
    T_min : float, optional
        Minimum allowed surface temperature [K]. Default: 200 K
    T_max : float, optional
        Maximum allowed surface temperature [K]. Default: T_inf
    alpha : float, optional
        Under-relaxation factor (0 < alpha <= 1). Default: 0.3
    tol : float, optional
        Convergence tolerance for T_s [K]. Default: 0.1 K
    max_iter : int, optional
        Maximum iterations. Default: 100
    MR : float, optional
        Mixture ratio (O/F) for CEA accessor mode. Required if cea_props is not None.
    eps : float, optional
        Expansion ratio for CEA accessor mode. Required if cea_props is not None.
    cea_props : callable, optional
        CEA property accessor with signature `cea_props(Pc, MR, eps) -> (gamma, R)`.
        If provided, gamma and R_gas must be None.
    
    Returns
    -------
    result : dict
        Dictionary containing:
        - "B_M": Spalding mass transfer number [-]
        - "T_s": Droplet surface temperature [K]
        - "Y_F_s": Surface fuel mass fraction [-]
        - "X_F_s": Surface fuel mole fraction [-]
        - "L_eff": Effective latent heat [J/kg]
        - "c_p_g": Gas heat capacity [J/(kg·K)]
        - "W_g": Gas mixture molecular weight [kg/kmol]
        - "T_film": Film temperature (diagnostic) [K]
        - "delta_T": Temperature difference T_inf - T_s [K]
        - "gamma_used": Specific heat ratio used [-]
        - "R_gas_used": Gas constant used [J/(kg·K)]
        - "use_cea_props": Whether CEA accessor mode was used [bool]
        - "iterations": Number of iterations [-]
        - "converged": Whether solver converged [bool]
    
    Notes
    -----
    - Uses CoolProp for vapor pressure via calculate_vapor_pressure()
    - The relation ln(1+B_M) = c_p,g * (T_inf - T_s) / L_eff is an approximation
      valid for Le ≈ 1 and quasi-steady boundary layer.
    - T_s converges to a wet-bulb-like equilibrium, not necessarily T_boil(P).
    - If p_vap(T_s) > P, a warning is issued but computation continues.
    - T_film is diagnostic only; no film-temperature interpolation of γ(T) or R(T)
      is performed since the CEA table lacks a temperature axis.
    
    Raises
    ------
    ValueError
        If input parameters are invalid or non-physical.
    """
    # Input validation - basic parameters
    if not np.isfinite(T_inf) or T_inf <= 0:
        raise ValueError(f"Invalid far-field temperature: T_inf = {T_inf} K")
    if not np.isfinite(P) or P <= 0:
        raise ValueError(f"Invalid pressure: P = {P} Pa")
    if not np.isfinite(W_F) or W_F <= 0:
        raise ValueError(f"Invalid fuel molecular weight: W_F = {W_F} kg/kmol")
    if not np.isfinite(L_vap) or L_vap <= 0:
        raise ValueError(f"Invalid latent heat: L_vap = {L_vap} J/kg")
    if not 0 <= Y_F_inf < 1:
        raise ValueError(f"Invalid far-field mass fraction: Y_F_inf = {Y_F_inf}")
    if not 0 < alpha <= 1:
        raise ValueError(f"Invalid relaxation factor: alpha = {alpha}")
    
    # Mode selection: CEA accessor mode vs fixed-property mode
    if cea_props is not None:
        # CEA accessor mode: get gamma/R from callable
        if gamma is not None or R_gas is not None:
            raise ValueError(
                "When using cea_props, gamma and R_gas must be None. "
                f"Got gamma={gamma}, R_gas={R_gas}"
            )
        if MR is None or eps is None:
            raise ValueError(
                "CEA accessor mode requires MR and eps to be provided. "
                f"Got MR={MR}, eps={eps}"
            )
        # Call CEA accessor once (properties are constant during iteration)
        gamma, R_gas = cea_props(P, MR, eps)
        use_cea_props = True
    else:
        # Fixed-property mode: require gamma and R_gas
        if gamma is None or R_gas is None:
            raise ValueError(
                "Either provide (gamma, R_gas) directly, or provide "
                "(cea_props, MR, eps) for CEA accessor mode. "
                f"Got gamma={gamma}, R_gas={R_gas}, cea_props={cea_props}"
            )
        use_cea_props = False
    
    # Validate gamma and R_gas (now available in both modes)
    if not np.isfinite(gamma) or gamma <= 1:
        raise ValueError(f"Invalid specific heat ratio: gamma = {gamma}")
    if not np.isfinite(R_gas) or R_gas <= 0:
        raise ValueError(f"Invalid gas constant: R_gas = {R_gas} J/(kg·K)")
    
    # Store the values used for output
    gamma_used = float(gamma)
    R_gas_used = float(R_gas)
    
    # Precompute gas properties from gamma and R (constant for iteration)
    # c_p,g = gamma / (gamma - 1) * R
    c_p_g = (gamma / (gamma - 1.0)) * R_gas
    
    # Gas mixture molecular weight: W_g = R_u / R
    W_g = R_UNIVERSAL / R_gas
    
    # =============================================================================
    # CRITICAL TEMPERATURE DOMAIN ENFORCEMENT
    # Saturation pressure is undefined above T_crit for real fluids.
    # The solver must enforce T_s < T_crit to stay within model validity.
    # =============================================================================
    FUEL_SURROGATES = {
        "RP-1": "n-Dodecane", "RP1": "n-Dodecane", "rp-1": "n-Dodecane", "rp1": "n-Dodecane",
        "Ethanol": "Ethanol", "ethanol": "Ethanol",
    }
    coolprop_fluid = FUEL_SURROGATES.get(fuel, fuel)
    T_crit = PropsSI("Tcrit", coolprop_fluid)
    T_crit_margin = 1e-2  # 0.01 K margin below T_crit
    T_crit_limit = T_crit - T_crit_margin
    
    # Warn once if T_inf is above T_crit (model is at edge of validity)
    if T_inf >= T_crit_limit:
        warnings.warn(
            f"[SPALDING_REGIME] T_inf={T_inf:.1f} K >= T_crit_limit={T_crit_limit:.1f} K "
            f"for {coolprop_fluid}. Model validity is limited (supercritical regime).",
            RuntimeWarning,
            stacklevel=2,
        )
    
    # Set temperature bounds, enforcing T_max <= T_crit_limit
    if T_max is None:
        T_max = min(T_inf, T_crit_limit)
    else:
        T_max = min(T_max, T_crit_limit)
    
    if T_min is None:
        T_min = 200.0  # Reasonable lower bound
    
    # Sanity check: if T_max <= T_min, we have no valid domain
    if T_max <= T_min:
        raise ValueError(
            f"[SPALDING_DOMAIN] No valid T_s domain: T_min={T_min:.1f} K >= T_max={T_max:.1f} K. "
            f"T_crit_limit={T_crit_limit:.1f} K. Check fuel surrogate or input temperatures."
        )
    
    # Initial guess for surface temperature
    if T_s_init is not None:
        T_s = min(T_s_init, T_max)  # Clamp to valid domain
    else:
        # Default: 90% of far-field, but clamped to valid domain
        T_s = min(0.9 * T_inf, T_max)
    
    # Clamp initial guess to bounds
    T_s = np.clip(T_s, T_min, T_max)
    
    # Check if effective latent heat should include liquid sensible heating
    use_sensible_heating = (cp_liquid is not None and T_liquid_in is not None)
    
    converged = False
    B_M = 0.0
    Y_F_s = 0.0
    X_F_s = 0.0
    L_eff = L_vap
    
    # =============================================================================
    # ITERATION DIAGNOSTICS
    # Track p_vap stalling and provide periodic status output
    # =============================================================================
    DIAG_INTERVAL = 5  # Print diagnostics every N iterations
    p_s_prev = None
    warned_pv_stall = False
    T_s_clipped_count = 0
    X_F_s_clipped_count = 0
    
    for iteration in range(max_iter):
        # Step 1: Vapor pressure at current T_s
        try:
            p_s = calculate_vapor_pressure(T_s, fuel=fuel)
        except Exception as e:
            raise ValueError(f"Vapor pressure calculation failed at T_s = {T_s:.1f} K: {e}") from e
        
        # =============================================================================
        # DIAGNOSTIC: Detect p_vap stall (constant vapor pressure despite T_s changes)
        # =============================================================================
        if p_s_prev is not None:
            delta_pv_rel = abs(p_s - p_s_prev) / max(p_s, 1.0)
            if delta_pv_rel < 1e-6 and iteration > 1 and not warned_pv_stall:
                # Check if T_s is also changing - if so, this is a stall
                T_s_change = abs(T_s - T_s_clipped_count)  # Reuse variable for last T_s
                if T_s_change > 0.1:  # T_s is changing but p_vap is not
                    warnings.warn(
                        f"[SPALDING_DIAG] p_vap stalled: p_s={p_s:.0f} Pa unchanged for T_s≈{T_s:.1f} K. "
                        "Check if T_s is near T_crit or if fuel surrogate data is wrong.",
                        RuntimeWarning,
                        stacklevel=2,
                    )
                    warned_pv_stall = True
        
        # Diagnostic: warn if vapor pressure exceeds total pressure
        if p_s > P:
            warnings.warn(
                f"Vapor pressure p_vap({T_s:.1f} K) = {p_s:.0f} Pa > P = {P:.0f} Pa. "
                "Model is outside intended regime (possible boiling).",
                RuntimeWarning,
                stacklevel=2,
            )
        
        # Step 2: Surface mole fraction (with safety clamp)
        X_F_s_raw = p_s / P
        X_F_s = np.clip(X_F_s_raw, 0.0, 0.999999)
        X_F_s_clipped = (X_F_s != X_F_s_raw)
        
        # Step 3: Convert mole fraction to mass fraction
        # Y_{F,s} = X_{F,s} * W_F / (X_{F,s} * W_F + (1 - X_{F,s}) * W_g)
        numerator = X_F_s * W_F
        denominator = X_F_s * W_F + (1.0 - X_F_s) * W_g
        Y_F_s = numerator / denominator
        
        # Step 4: Spalding mass transfer number
        # B_M = (Y_{F,s} - Y_{F,inf}) / (1 - Y_{F,s})
        den = max(1.0 - Y_F_s, 1e-12)
        if den <= 1e-12:
            warnings.warn(
                f"Y_F_s = {Y_F_s:.6f} ≈ 1, denominator floored to 1e-12.",
                RuntimeWarning,
                stacklevel=2,
            )
        B_M = (Y_F_s - Y_F_inf) / den
        
        # Soft guard: when B_M is negative but close to -1, ln(1 + B_M) spikes
        # and causes wild temperature updates. Clamp to a safe floor.
        B_M_FLOOR = -0.9  # ln(1 + (-0.9)) = ln(0.1) ≈ -2.3, still manageable
        if B_M < B_M_FLOOR:
            warnings.warn(
                f"B_M = {B_M:.4f} is dangerously close to -1. "
                f"Clamping to {B_M_FLOOR} to prevent log spike.",
                RuntimeWarning,
                stacklevel=2,
            )
            B_M = B_M_FLOOR
        
        # Check for condensation regime (B_M < 0)
        # ln(1 + B_M) requires B_M > -1
        if B_M <= -1.0:
            raise ValueError(
                f"B_M = {B_M:.4f} <= -1 (condensation regime). "
                "ln(1 + B_M) is undefined. Check inputs or model assumptions."
            )
        
        # Step 5: Effective latent heat
        if use_sensible_heating:
            # L_eff = L_vap + c_p,liquid * (T_s - T_liquid,in)
            L_eff_raw = L_vap + cp_liquid * (T_s - T_liquid_in)
        else:
            L_eff_raw = L_vap
        
        # Floor L_eff to prevent non-physical values, but warn if triggered
        L_eff = max(L_eff_raw, 0.1 * L_vap)
        if L_eff_raw <= 0:
            warnings.warn(
                f"L_eff_raw = {L_eff_raw:.0f} J/kg <= 0 (bad cp_liquid/T_liquid_in?). "
                f"Floored to {L_eff:.0f} J/kg.",
                RuntimeWarning,
                stacklevel=2,
            )
        
        # Step 6: Compute unrelaxed temperature update
        # T_s_new = T_inf - (L_eff / c_p,g) * ln(1 + B_M)
        # Use log1p for numerical stability when B_M is small
        log_term = np.log1p(B_M)
        T_s_unrelaxed = T_inf - (L_eff / c_p_g) * log_term
        
        # Compute film temperature (diagnostic only, not used for property interpolation)
        T_film = 0.5 * (T_inf + T_s)
        
        # Step 7: Under-relaxation
        T_s_new = (1.0 - alpha) * T_s + alpha * T_s_unrelaxed
        
        # Step 8: Apply bounds (domain enforcement: T_s must stay below T_crit)
        # NOTE: This is VALID clipping for iterative solvers - enforcing physical domain
        # T_s cannot exceed critical temperature (boiling becomes impossible)
        # However, if clipping happens too frequently, it indicates solver instability
        T_s_pre_clip = T_s_new
        T_s_new = np.clip(T_s_new, T_min, T_max)
        T_s_clipped = (T_s_new != T_s_pre_clip)
        
        # Count clipping events - too many indicates problem
        if T_s_clipped or X_F_s_clipped:
            clipping_count += 1
        
        # =============================================================================
        # DIAGNOSTIC: Periodic iteration logging
        # =============================================================================
        if iteration % DIAG_INTERVAL == 0 or iteration == 0:
            clip_flags = ""
            if T_s_clipped:
                clip_flags += "T_s_clip "
            if X_F_s_clipped:
                clip_flags += "X_F_s_clip "
            warnings.warn(
                f"[SPALDING_ITER {iteration:3d}] T_s={T_s:.1f}→{T_s_new:.1f} K (unrel={T_s_unrelaxed:.1f}), "
                f"p_s={p_s:.0f} Pa, X_F_s={X_F_s:.4f}, Y_F_s={Y_F_s:.4f}, B_M={B_M:.4f}, "
                f"log1p(B_M)={log_term:.4f} {clip_flags}",
                RuntimeWarning,
                stacklevel=2,
            )
        
        # Track previous p_s for stall detection
        p_s_prev = p_s
        
        # Check convergence
        delta_T = abs(T_s_new - T_s)
        if delta_T < tol:
            converged = True
            T_s = T_s_new
            break
        
        T_s = T_s_new
    
    # Check if solver is clipping too frequently (>50% of iterations)
    # This indicates the solver is unable to stay in the valid domain naturally
    if clipping_count > max_iter * 0.5:
        raise RuntimeError(
            f"Spalding solver clipping excessively: {clipping_count}/{max_iter} iterations. "
            f"This indicates the solver is unable to stay in valid domain (T_s in [{T_min:.1f}, {T_max:.1f}] K, X_F_s in [0, 1]). "
            f"Final T_s={T_s:.1f} K, T_inf={T_inf:.1f} K, P={P:.1e} Pa. "
            f"Check input conditions or reduce under-relaxation factor alpha."
        )
    
    # Final pass: recompute all values with converged T_s for consistency
    p_s = calculate_vapor_pressure(T_s, fuel=fuel)
    X_F_s = np.clip(p_s / P, 0.0, 0.999999)
    numerator = X_F_s * W_F
    denominator = X_F_s * W_F + (1.0 - X_F_s) * W_g
    Y_F_s = numerator / denominator
    den = max(1.0 - Y_F_s, 1e-12)
    B_M = (Y_F_s - Y_F_inf) / den
    
    if use_sensible_heating:
        L_eff = max(L_vap + cp_liquid * (T_s - T_liquid_in), 0.1 * L_vap)
    else:
        L_eff = L_vap
    
    # Final diagnostics
    T_film = 0.5 * (T_inf + T_s)
    delta_T = T_inf - T_s
    
    return {
        "B_M": float(B_M),
        "T_s": float(T_s),
        "Y_F_s": float(Y_F_s),
        "X_F_s": float(X_F_s),
        "L_eff": float(L_eff),
        "c_p_g": float(c_p_g),
        "W_g": float(W_g),
        "T_film": float(T_film),
        "delta_T": float(delta_T),
        "gamma_used": gamma_used,
        "R_gas_used": R_gas_used,
        "use_cea_props": use_cea_props,
        "iterations": iteration + 1,
        "converged": converged,
        "T_crit": float(T_crit),
        "T_crit_limit": float(T_crit_limit),
    }