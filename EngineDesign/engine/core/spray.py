"""Spray and mixing models (J, TMR, θ, We, SMD, x*)"""

from __future__ import annotations

import numpy as np
from typing import Tuple, List
from engine.pipeline.config_schemas import SprayConfig


def momentum_flux_ratio(rho_O: float, u_O: float, rho_F: float, u_F: float) -> float:
    """
    Calculate momentum flux ratio J.
    
    J = (ρ_O × u_O²) / (ρ_F × u_F²)
    
    Parameters:
    -----------
    rho_O : float
        Oxidizer density [kg/m³]
    u_O : float
        Oxidizer velocity [m/s]
    rho_F : float
        Fuel density [kg/m³]
    u_F : float
        Fuel velocity [m/s]
    
    Returns:
    --------
    J : float
    """
    if u_F == 0:
        return np.inf if u_O > 0 else 0.0
    
    J = (rho_O * u_O**2) / (rho_F * u_F**2)
    return float(J)


def thrust_momentum_ratio(J: float, MR: float) -> float:
    """
    Calculate Thrust/Momentum Ratio (TMR).
    
    TMR is a geometry-dependent parameter related to J and mixture ratio.
    This is a simplified model - can be enhanced with geometry-specific correlations.
    
    Parameters:
    -----------
    J : float
        Momentum flux ratio
    MR : float
        Mixture ratio (O/F)
    
    Returns:
    --------
    TMR : float
    """
    # Simplified model: TMR ≈ J / (1 + MR)
    # Can be replaced with geometry-specific correlation
    TMR = J / (1 + MR) if MR > 0 else J
    return float(TMR)


def spray_angle_from_J(J: float, k: float, n: float) -> float:
    """
    Calculate spray angle from momentum flux ratio J.
    
    Uses half-angle tangent form: tan(θ/2) = k × J^n
    
    PHYSICS INTUITION:
    ------------------
    Imagine the spray as a cone coming out of the injector:
    
    1. **Momentum Vector Decomposition**:
       - The fuel (RP-1) flows RADIALLY outward (perpendicular to axis)
       - The oxidizer (LOX) flows AXIALLY (along the axis, with some angle)
       - When they collide, the combined spray has both radial and axial momentum
    
    2. **Why Half-Angle?**:
       - The spray is SYMMETRIC about the axis
       - We measure angles FROM THE AXIS, not from the opposite edge
       - A particle at the edge of the spray travels at angle θ/2 from the axis
       - Its momentum vector makes angle θ/2 with the axis (not θ!)
       - When we decompose momentum: p_radial = p × sin(θ/2), p_axial = p × cos(θ/2)
       - Full angle θ = 2×(θ/2) is just a convention - we use θ/2 in calculations
    
    3. **Why Tangent?**:
       - In a conical spray, momentum vectors decompose as:
         * Radial component: p_radial = p_total × sin(θ/2)
         * Axial component: p_axial = p_total × cos(θ/2)
       - The RATIO of radial to axial momentum is:
         p_radial / p_axial = sin(θ/2) / cos(θ/2) = tan(θ/2)
       - This ratio determines how "spread out" the spray is
    
    4. **Connection to J**:
       - J = (ρ_O u_O²) / (ρ_F u_F²) measures relative momentum flux
       - High J → more oxidizer momentum → spray more axial (smaller angle)
       - Low J → more fuel momentum → spray more radial (larger angle)
       - The spray angle emerges from balancing these momentum components
    
    5. **Why Not Direct θ = k×J^n?**:
       - Direct form treats angle as arbitrary scalar
       - But spray angle comes from VECTOR balance of momenta
       - tan(θ/2) captures this vector relationship naturally
       - Also provides natural bounds: tan(θ/2) → ∞ as θ → 90°
    
    Parameters:
    -----------
    J : float
        Momentum flux ratio
    k : float
        Model coefficient
    n : float
        Model exponent
    
    Returns:
    --------
    theta : float [rad]
    """
    if J <= 0:
        return 0.0
    
    # Half-angle tangent form: tan(θ/2) = k × J^n
    # This is the physically meaningful form for spray angles
    tan_half_theta = k * (J ** n)
    theta = 2 * np.arctan(tan_half_theta)
    
    # Clamp to reasonable range [0, π/2] (0-90 degrees)
    # Note: The tan form naturally limits angles, but we clamp for safety
    return float(np.clip(theta, 0, np.pi / 2))


def spray_angle_from_TMR(TMR: float) -> float:
    """
    Calculate spray angle from Thrust/Momentum Ratio.
    
    θ = arccos(1 / (1 + TMR^0.75))
    
    Parameters:
    -----------
    TMR : float
        Thrust/Momentum Ratio
    
    Returns:
    --------
    theta : float [rad]
    """
    if TMR <= 0:
        return 0.0
    
    cos_theta = 1 / (1 + TMR**0.75)
    cos_theta = np.clip(cos_theta, -1, 1)  # Ensure valid arccos range
    theta = np.arccos(cos_theta)
    
    return float(theta)


def weber_number(rho: float, u: float, d_char: float, sigma: float) -> float:
    """
    Calculate Weber number.
    
    We = (ρ × u² × d_char) / σ
    
    Parameters:
    -----------
    rho : float
        Density [kg/m³]
    u : float
        Velocity [m/s]
    d_char : float
        Characteristic diameter [m] (port diameter or annulus hydraulic diameter)
    sigma : float
        Surface tension [N/m]
    
    Returns:
    --------
    We : float
    """
    if sigma <= 0:
        return np.inf
    
    We = (rho * u**2 * d_char) / sigma
    return float(We)


def ohnesorge_number(mu: float, rho: float, sigma: float, d_or: float) -> float:
    """
    Calculate Ohnesorge number.
    
    Oh = μ / √(ρ × σ × d_or)
    
    Parameters:
    -----------
    mu : float
        Dynamic viscosity [Pa·s]
    rho : float
        Density [kg/m³]
    sigma : float
        Surface tension [N/m]
    d_or : float
        Orifice diameter [m]
    
    Returns:
    --------
    Oh : float
    """
    if rho <= 0 or sigma <= 0 or d_or <= 0:
        return 0.0
    
    # FIXED: Ensure sqrt input is positive
    sqrt_arg = rho * sigma * d_or
    Oh = mu / np.sqrt(max(sqrt_arg, 1e-12)) if sqrt_arg > 0 else 0.0
    return float(Oh)


def smd_lefebvre(
    d_or: float,
    We: float,
    Oh: float,
    C: float,
    m: float,
    p: float
) -> float:
    """
    Calculate Sauter Mean Diameter (SMD) using Lefebvre correlation.
    
    D32 = C × d_or × We^(-m) × Oh^p
    
    Parameters:
    -----------
    d_or : float
        Orifice diameter [m]
    We : float
        Weber number
    Oh : float
        Ohnesorge number
    C : float
        Model constant
    m : float
        Weber exponent
    p : float
        Ohnesorge exponent
    
    Returns:
    --------
    D32 : float [m]
    """
    if We <= 0 or d_or <= 0:
        return d_or  # Fallback to orifice diameter
    
    D32 = C * d_or * (We ** (-m)) * (Oh ** p)
    return float(D32)


def tau_evap(D32: float, K: float) -> float:
    """
    Calculate evaporation time.
    
    τ_evap = K × D32²
    
    Parameters:
    -----------
    D32 : float
        Sauter Mean Diameter [m]
    K : float
        Evaporation constant [s/m²]
    
    Returns:
    --------
    tau : float [s]
    """
    tau = K * (D32 ** 2)
    return float(tau)


def xstar(U_rel: float, tau_evap: float) -> float:
    """
    Calculate evaporation length x*.
    
    x* = U_rel × τ_evap
    
    Parameters:
    -----------
    U_rel : float
        Relative velocity [m/s]
    tau_evap : float
        Evaporation time [s]
    
    Returns:
    --------
    x_star : float [m]
    """
    x_star = U_rel * tau_evap
    return float(x_star)


def check_spray_constraints(
    We_O: float,
    We_F: float,
    x_star: float,
    config: SprayConfig
) -> Tuple[bool, List[str]]:
    """
    Check if spray constraints are satisfied.
    
    Constraints:
    - We_i ≥ We_min
    - x* < x_limit
    
    Parameters:
    -----------
    We_O : float
        Oxidizer Weber number
    We_F : float
        Fuel Weber number
    x_star : float
        Evaporation length [m]
    config : SprayConfig
        Spray configuration
    
    Returns:
    --------
    constraints_satisfied : bool
    violations : list[str]
        List of violated constraint names
    """
    violations = []
    
    # Check Weber number constraints
    We_min = config.weber.get("We_min", 15.0)
    if We_O < We_min:
        violations.append(f"We_O < We_min ({We_O:.2f} < {We_min:.2f})")
    if We_F < We_min:
        violations.append(f"We_F < We_min ({We_F:.2f} < {We_min:.2f})")
    
    # Check evaporation length constraint
    if config.evaporation.use_constraint:
        if x_star >= config.evaporation.x_star_limit:
            violations.append(
                f"x* >= x_limit ({x_star:.4f} >= {config.evaporation.x_star_limit:.4f} m)"
            )
    

    constraints_satisfied = len(violations) == 0
    return constraints_satisfied, violations


def smd_pintle(
    L_open: float,
    V_rel: float,
    rho_f: float,
    mu_f: float,
    sigma_f: float,
    C: float,
    B: float,
    n: float,
    p: float,
) -> float:
    """
    Calculate Sauter Mean Diameter (SMD) for pintle injector using relative velocity physics.
    
    Formula: SMD = C * L_open * We_rel^(-n) * (1 + B * Oh_f)^p
    
    Parameters:
    -----------
    L_open : float
        Characteristic length (Pintle Opening / Gap Height) [m]
    V_rel : float
        Relative velocity magnitude between streams [m/s]
    rho_f : float
        Fuel (sheet) density [kg/m³]
    mu_f : float
        Fuel (sheet) dynamic viscosity [Pa·s]
    sigma_f : float
        Fuel surface tension [N/m]
    C, B, n, p : float
        Correlation constants
        
    Returns:
    --------
    D32 : float [m]
    """
    if L_open <= 0:
        raise ValueError(f"smd_pintle: L_open must be positive, got {L_open}")
    if rho_f <= 0:
        raise ValueError(f"smd_pintle: rho_f must be positive, got {rho_f}")
    if sigma_f <= 0:
        raise ValueError(f"smd_pintle: sigma_f must be positive, got {sigma_f}")
    if mu_f < 0:
        raise ValueError(f"smd_pintle: mu_f must be non-negative, got {mu_f}")
    
    if C <= 0:
        raise ValueError(f"smd_pintle: C must be positive, got {C}")
    if n <= 0:
        raise ValueError(f"smd_pintle: n must be positive, got {n}")
    if B < 0:
        raise ValueError(f"smd_pintle: B must be non-negative, got {B}")
    if p < 0:
        raise ValueError(f"smd_pintle: p must be non-negative, got {p}")

    if V_rel < 0:
        raise ValueError(f"smd_pintle: V_rel must be non-negative, got {V_rel}")
    
    if V_rel == 0:
        import warnings
        warnings.warn("smd_pintle: V_rel is 0.0, We=0. SMD calculation relying on Ohnesorge term only.")

    # Calculate Weber number based on relative velocity
    # We = rho * V^2 * L / sigma
    We_rel = (rho_f * (V_rel ** 2) * L_open) / sigma_f
    
    # Calculate Ohnesorge number for the liquid sheet
    # Oh = mu / sqrt(rho * sigma * L)
    denom = np.sqrt(rho_f * sigma_f * L_open)
    Oh_f = mu_f / denom if denom > 0 else 0.0
    
    # Apply correlation
    # SMD = C * L_open * We^(-n) * (1 + B * Oh)^p
    factor_we = (We_rel ** (-n)) if We_rel > 0 else 1.0
    factor_oh = (1.0 + B * Oh_f) ** p
    
    D32 = C * L_open * factor_we * factor_oh
        
    return float(D32)

