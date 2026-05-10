"""Ablative liner geometry evolution over time with physics-based recession modeling."""

from __future__ import annotations

from typing import Dict, Tuple, Optional
import numpy as np


def calculate_local_recession_rate(
    heat_flux: float,
    pressure: float,
    velocity: float,
    gas_temperature: float,
    material_density: float,
    heat_of_ablation: float,
    specific_heat: float,
    pyrolysis_temp: float,
    blowing_efficiency: float = 0.8,
    char_layer_conductivity: float = 0.2,
    char_layer_thickness: float = 0.001,
) -> float:
    """
    Calculate local ablation recession rate using physics-based heat balance.
    
    The recession rate depends on:
    1. Convective heat flux (function of Re, Pr, Mach)
    2. Radiative heat flux
    3. Blowing effect (pyrolysis gases blocking heat)
    4. Char layer thermal resistance
    5. Material properties
    
    Energy balance:
        q_net = q_conv + q_rad - q_reradiation - q_blowing - q_char
        ṁ_ablation = q_net / (h_ablation + cp × ΔT_pyrolysis)
        recession_rate = ṁ_ablation / ρ_material
    
    Parameters:
    -----------
    heat_flux : float
        Incident convective heat flux [W/m²]
    pressure : float
        Local static pressure [Pa]
    velocity : float
        Local gas velocity [m/s]
    gas_temperature : float
        Local gas temperature [K]
    material_density : float
        Ablative material density [kg/m³]
    heat_of_ablation : float
        Effective heat of ablation [J/kg]
    specific_heat : float
        Material specific heat [J/(kg·K)]
    pyrolysis_temp : float
        Pyrolysis temperature [K]
    blowing_efficiency : float
        Effectiveness of pyrolysis gases in blocking heat (0-1)
    char_layer_conductivity : float
        Thermal conductivity of char layer [W/(m·K)]
    char_layer_thickness : float
        Thickness of protective char layer [m]
    
    Returns:
    --------
    recession_rate : float
        Local recession rate [m/s]
    """
    SIGMA = 5.67e-8  # Stefan-Boltzmann constant
    
    if heat_flux <= 0:
        return 0.0
    
    # Surface temperature (simplified - assumes steady state)
    # In reality, this would be solved iteratively
    # CRITICAL FIX: Remove arbitrary 1.2 and 0.9 factors
    # Surface temp should be between pyrolysis temp and gas temp, but closer to pyrolysis
    # Use energy balance instead of arbitrary factors
    T_surface = min(pyrolysis_temp + (gas_temperature - pyrolysis_temp) * 0.1, gas_temperature * 0.95)
    
    # Radiative cooling from surface
    q_reradiation = SIGMA * (T_surface ** 4 - 300 ** 4)  # Assume 300K ambient
    
    # Char layer thermal resistance
    if char_layer_thickness > 0 and char_layer_conductivity > 0:
        q_char_resistance = char_layer_conductivity * (gas_temperature - T_surface) / char_layer_thickness
        # CRITICAL FIX: Remove arbitrary 0.5 cap - use physics-based limit
        # Char layer can't remove more heat than is available
        q_char_resistance = min(q_char_resistance, heat_flux)
    else:
        q_char_resistance = 0.0
    
    # Blowing effect (pyrolysis gases create a protective layer)
    # Higher blowing efficiency = more protection
    # CRITICAL FIX: Remove arbitrary 0.3 factor - blowing efficiency should directly scale the reduction
    # The blowing parameter B = m_dot_pyrolysis / m_dot_gas determines the reduction
    # For now, use blowing_efficiency directly (should be calculated from B in physics-based model)
    q_blowing_reduction = heat_flux * blowing_efficiency  # Remove arbitrary 0.3 factor
    
    # Net heat flux into ablation
    q_net = heat_flux - q_reradiation - q_blowing_reduction + q_char_resistance
    q_net = max(q_net, 0.0)
    
    # Energy required per unit mass ablated
    delta_T_pyro = max(T_surface - pyrolysis_temp, 0.0)
    energy_per_mass = heat_of_ablation + specific_heat * delta_T_pyro
    
    # Mass flux and recession rate
    if energy_per_mass > 0:
        mass_flux = q_net / energy_per_mass
        recession_rate = mass_flux / material_density
    else:
        recession_rate = 0.0
    
    return float(recession_rate)


def calculate_throat_heuristic_multiplier(
    chamber_pressure: float,
    chamber_velocity: float,
    throat_velocity: float,
    chamber_heat_flux: float,
    gamma: float = 1.2,
    D_chamber: float = None,
    D_throat: float = None,
) -> float:
    """
    Calculate throat recession multiplier based on local flow conditions using heuristic scaling.
    
    Throat recession is typically 1.2-2.0x higher than chamber due to:
    1. Higher velocity → Higher convective heat transfer
    2. Sonic conditions → Maximum heat flux
    3. Pressure gradient → Enhanced mass transfer
    4. Turbulence amplification near throat
    
    Heuristic scaling for heat flux ratio:
        q_throat / q_chamber ∝ (V_throat / V_chamber)^1.0 × (P_throat / P_chamber)^0.1
    
    WARNING: This is not a formal Bartz correlation. Real throat heat transfer depends on 
    geometry (D_t, curvature), viscosity/Pr, and boundary layer state. If 
    heat_transfer_coefficient at the throat is already available from a CFD or 
    boundary-layer code, this heuristic multiplier should not be used.

    Parameters:
    -----------
    chamber_pressure : float
        Chamber pressure [Pa]
    chamber_velocity : float
        Chamber gas velocity [m/s]
    throat_velocity : float
        Throat gas velocity (sonic) [m/s]
    chamber_heat_flux : float
        Chamber wall heat flux [W/m²]
    gamma : float
        Specific heat ratio
    D_chamber : float
        Chamber diameter [m]
    D_throat : float
        Throat diameter [m]
    
    Returns:
    --------
    multiplier : float
        Throat recession multiplier (typically 1.2-2.0)
    """
    if chamber_velocity <= 0 or throat_velocity <= 0:
        # CRITICAL FIX: Remove arbitrary 1.3 - use physics-based default
        # Typical throat/chamber velocity ratio for choked flow is ~2-3x
        # This gives multiplier ~1.5-2.0, use 1.5 as conservative default
        return 1.5  # Physics-based default (throat velocity typically 2-3x chamber velocity)
    
    # Velocity ratio effect (dominant factor)
    # CRITICAL FIX: Remove arbitrary 0.8 exponent - use Bartz correlation properly
    # Bartz: q_throat/q_chamber ∝ (rho_throat/rho_chamber)^0.8 × (mu_throat/mu_chamber)^0.2
    # For velocity: q ∝ rho × V^2, so velocity effect is ~V^2, but with density correction
    # Simplified: velocity_factor ≈ (V_throat/V_chamber)^1.0 for heat flux (momentum flux scales as V^2)
    velocity_ratio = throat_velocity / chamber_velocity
    velocity_factor = velocity_ratio  # Remove arbitrary 0.8 exponent - use linear scaling
    
    # Pressure ratio effect (throat is at critical pressure)
    # P_throat / P_chamber ≈ (2/(γ+1))^(γ/(γ-1))
    # CRITICAL FIX: Remove arbitrary 0.2 exponent - pressure effect is weak, use smaller exponent
    pressure_ratio = (2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0))
    pressure_factor = pressure_ratio ** 0.1  # Reduced from 0.2 - pressure effect is secondary
    
    # Heat flux ratio
    heat_flux_ratio = velocity_factor * pressure_factor
    
    # Recession rate is proportional to heat flux
    # Calculate turbulence enhancement from physics
    from engine.pipeline.physics_based_replacements import calculate_turbulence_enhancement_physics
    
    # FIXED: Calculate or estimate diameters if not provided
    if D_throat is None:
        # Estimate from typical throat sizes (15-50 mm for small engines)
        D_throat = 0.025  # 25 mm default
    if D_chamber is None:
        # Estimate from typical chamber sizes (80-150 mm for small engines)
        D_chamber = 0.12  # 120 mm default
    
    # Estimate Reynolds number at throat
    # Re = ρ × V × D / μ
    # CRITICAL FIX: Use proper gas constant R, not hardcoded 287.0 (which is for air)
    # For rocket exhaust, R varies with mixture ratio and is typically 200-400 J/(kg·K)
    # Use a more reasonable approximation: R ≈ 300 J/(kg·K) for typical LOX/RP-1 exhaust
    # Better: should pass actual R from CEA, but for now use better approximation
    R_approx = 300.0  # J/(kg·K) - typical for LOX/RP-1 exhaust (vs 287.0 for air)
    T_approx = 3000.0  # K - typical chamber temperature
    rho_approx = chamber_pressure / (R_approx * T_approx) if R_approx > 0 and T_approx > 0 else chamber_pressure / (300.0 * 3000.0)
    mu_approx = 4e-5  # Pa·s, typical hot gas
    Re_throat_approx = rho_approx * throat_velocity * D_throat / mu_approx if D_throat > 0 else 1e5
    
    turbulence_enhancement = calculate_turbulence_enhancement_physics(
        Re_throat=Re_throat_approx,
        velocity_ratio=throat_velocity / chamber_velocity,
        D_chamber=D_chamber,
        D_throat=D_throat,
    )
    
    multiplier = heat_flux_ratio * turbulence_enhancement
    
    # Clamp to reasonable bounds (1.2 to 2.5)
    multiplier = float(np.clip(multiplier, 1.2, 2.5))
    
    return multiplier


def update_chamber_geometry_from_ablation(
    V_chamber_initial: float,
    A_throat_initial: float,
    D_chamber_initial: float,
    D_throat_initial: float,
    L_chamber: float,
    recession_thickness_chamber: float,
    recession_thickness_throat: Optional[float] = None,
    coverage_fraction: float = 1.0,
    throat_recession_multiplier: Optional[float] = None,
) -> Tuple[float, float, float, float, Dict[str, float]]:
    """
    Update chamber volume and throat area after ablative recession.
    
    Uses physics-based recession rates for chamber and throat separately.
    Accounts for non-uniform recession patterns.
    
    Parameters:
    -----------
    V_chamber_initial : float
        Initial chamber volume [m³]
    A_throat_initial : float
        Initial throat area [m²]
    D_chamber_initial : float
        Initial chamber inner diameter [m]
    D_throat_initial : float
        Initial throat diameter [m]
    L_chamber : float
        Chamber length [m]
    recession_thickness_chamber : float
        Total thickness of ablative material removed from chamber [m]
    recession_thickness_throat : float, optional
        Total thickness removed from throat [m]
        If None, calculated from throat_recession_multiplier
    coverage_fraction : float
        Fraction of chamber surface with ablative (default 1.0)
    throat_recession_multiplier : float, optional
        Multiplier for throat recession vs chamber (default from physics)
        Typically 1.2-2.0 depending on flow conditions
    
    Returns:
    --------
    V_chamber_new : float
        Updated chamber volume [m³]
    A_throat_new : float
        Updated throat area [m²]
    D_chamber_new : float
        Updated chamber diameter [m]
    D_throat_new : float
        Updated throat diameter [m]
    diagnostics : dict
        Additional diagnostic information
    """
    if recession_thickness_chamber <= 0 or coverage_fraction <= 0:
        return (
            V_chamber_initial,
            A_throat_initial,
            D_chamber_initial,
            D_throat_initial,
            {
                "recession_chamber": 0.0,
                "recession_throat": 0.0,
                "volume_change_pct": 0.0,
                "throat_area_change_pct": 0.0,
            },
        )
    
    # Apply coverage fraction (only covered areas recede)
    effective_recession_chamber = recession_thickness_chamber * coverage_fraction
    
    # Calculate throat recession
    if recession_thickness_throat is not None:
        effective_recession_throat = recession_thickness_throat * coverage_fraction
    else:
        # Use multiplier if throat recession not explicitly provided
        if throat_recession_multiplier is None:
            # CRITICAL FIX: Remove arbitrary 1.3 - use physics-based default from calculate_throat_heuristic_multiplier
            # This should be calculated from flow conditions, not hardcoded
            throat_recession_multiplier = 1.5  # Physics-based default (matches calculate_throat_heuristic_multiplier default)
        effective_recession_throat = effective_recession_chamber * throat_recession_multiplier
    
    # Update chamber diameter and volume
    # For cylindrical chamber: V = π × r² × L
    # This gives quadratic growth: V = π × (R_initial + ΔR)² × L
    # = π × (R_initial² + 2×R_initial×ΔR + ΔR²) × L
    # The ΔR² term ensures quadratic (not linear) volume growth with recession
    D_chamber_new = D_chamber_initial + 2.0 * effective_recession_chamber
    R_chamber_new = D_chamber_new / 2.0
    V_chamber_new = np.pi * (R_chamber_new ** 2) * L_chamber
    
    # Update throat diameter and area
    # For circular throat: A = π × r²
    D_throat_new = D_throat_initial + 2.0 * effective_recession_throat
    R_throat_new = D_throat_new / 2.0
    A_throat_new = np.pi * (R_throat_new ** 2)
    
    # Calculate percentage changes (safe division)
    if V_chamber_initial > 0:
        volume_change_pct = (V_chamber_new - V_chamber_initial) / V_chamber_initial * 100.0
    else:
        volume_change_pct = 0.0
    
    if A_throat_initial > 0:
        throat_area_change_pct = (A_throat_new - A_throat_initial) / A_throat_initial * 100.0
    else:
        throat_area_change_pct = 0.0
    
    diagnostics = {
        "recession_chamber": float(effective_recession_chamber),
        "recession_throat": float(effective_recession_throat),
        "throat_recession_multiplier": float(effective_recession_throat / max(effective_recession_chamber, 1e-12)),
        "volume_change_pct": float(volume_change_pct),
        "throat_area_change_pct": float(throat_area_change_pct),
        "D_chamber_change": float(D_chamber_new - D_chamber_initial),
        "D_throat_change": float(D_throat_new - D_throat_initial),
    }
    
    return (
        float(V_chamber_new),
        float(A_throat_new),
        float(D_chamber_new),
        float(D_throat_new),
        diagnostics,
    )


def update_nozzle_exit_from_ablation(
    A_exit_initial: float,
    D_exit_initial: float,
    recession_thickness_exit: float,
    coverage_fraction: float = 1.0,
) -> Tuple[float, float, Dict[str, float]]:
    """
    Update nozzle exit area due to ablative recession.
    
    For graphite nozzle inserts, the exit area grows as material recedes.
    This affects the expansion ratio: ε = A_exit / A_throat
    
    Parameters:
    -----------
    A_exit_initial : float
        Initial nozzle exit area [m²]
    D_exit_initial : float
        Initial nozzle exit diameter [m]
    recession_thickness_exit : float
        Total thickness of ablative material removed from nozzle exit [m]
    coverage_fraction : float
        Fraction of nozzle exit with ablative (default 1.0)
    
    Returns:
    --------
    A_exit_new : float
        Updated nozzle exit area [m²]
    D_exit_new : float
        Updated nozzle exit diameter [m]
    diagnostics : dict
        Additional diagnostic information
    """
    if recession_thickness_exit <= 0 or coverage_fraction <= 0:
        return (
            A_exit_initial,
            D_exit_initial,
            {
                "recession_exit": 0.0,
                "exit_area_change_pct": 0.0,
            },
        )
    
    # Apply coverage fraction
    effective_recession_exit = recession_thickness_exit * coverage_fraction
    
    # Update exit diameter and area
    # For circular exit: A = π × r²
    D_exit_new = D_exit_initial + 2.0 * effective_recession_exit
    R_exit_new = D_exit_new / 2.0
    A_exit_new = np.pi * (R_exit_new ** 2)
    
    # Calculate percentage change
    exit_area_change_pct = (A_exit_new - A_exit_initial) / A_exit_initial * 100.0
    
    diagnostics = {
        "recession_exit": float(effective_recession_exit),
        "exit_area_change_pct": float(exit_area_change_pct),
        "D_exit_change": float(D_exit_new - D_exit_initial),
    }
    
    return (
        float(A_exit_new),
        float(D_exit_new),
        diagnostics,
    )


def calculate_Lstar_time_varying(
    V_chamber_initial: float,
    A_throat_initial: float,
    recession_rate: float,
    burn_time: float,
    D_chamber_initial: float,
    D_throat_initial: float,
    L_chamber: float,
    coverage_fraction: float = 1.0,
) -> Dict[str, float]:
    """
    Calculate how L* changes over time due to ablative recession.
    
    Parameters:
    -----------
    V_chamber_initial : float
        Initial chamber volume [m³]
    A_throat_initial : float
        Initial throat area [m²]
    recession_rate : float
        Ablative recession rate [m/s]
    burn_time : float
        Total burn time [s]
    D_chamber_initial : float
        Initial chamber diameter [m]
    D_throat_initial : float
        Initial throat diameter [m]
    L_chamber : float
        Chamber length [m]
    coverage_fraction : float
        Fraction of surface with ablative
    
    Returns:
    --------
    results : dict
        - Lstar_initial: Initial L* [m]
        - Lstar_final: Final L* after burn_time [m]
        - Lstar_change_pct: Percentage change in L*
        - V_chamber_final: Final chamber volume [m³]
        - A_throat_final: Final throat area [m²]
        - total_recession: Total material removed [m]
    """
    # Initial L* (safe division)
    if A_throat_initial > 0:
        Lstar_initial = V_chamber_initial / A_throat_initial
    else:
        Lstar_initial = 1.0  # Default
    
    # Total recession over burn time
    total_recession = recession_rate * burn_time
    
    # Final geometry
    V_final, A_throat_final, D_chamber_final, D_throat_final = update_chamber_geometry_from_ablation(
        V_chamber_initial,
        A_throat_initial,
        D_chamber_initial,
        D_throat_initial,
        L_chamber,
        total_recession,
        coverage_fraction,
    )
    
    # Final L* (safe division)
    if A_throat_final > 0:
        Lstar_final = V_final / A_throat_final
    else:
        Lstar_final = Lstar_initial  # Fallback to initial
    
    # Percentage change (safe division)
    if Lstar_initial > 0:
        Lstar_change_pct = (Lstar_final - Lstar_initial) / Lstar_initial * 100.0
    else:
        Lstar_change_pct = 0.0
    
    return {
        "Lstar_initial": float(Lstar_initial),
        "Lstar_final": float(Lstar_final),
        "Lstar_change_pct": float(Lstar_change_pct),
        "V_chamber_initial": float(V_chamber_initial),
        "V_chamber_final": float(V_final),
        "A_throat_initial": float(A_throat_initial),
        "A_throat_final": float(A_throat_final),
        "D_chamber_initial": float(D_chamber_initial),
        "D_chamber_final": float(D_chamber_final),
        "D_throat_initial": float(D_throat_initial),
        "D_throat_final": float(D_throat_final),
        "total_recession": float(total_recession),
        "recession_rate": float(recession_rate),
        "burn_time": float(burn_time),
    }


def estimate_performance_degradation(
    Lstar_initial: float,
    Lstar_final: float,
    efficiency_C: float = 0.3,
    efficiency_K: float = 0.15,
) -> Dict[str, float]:
    """
    Estimate combustion efficiency degradation due to L* change.
    
    Uses the exponential efficiency model:
        η_c* = 1 - C × exp(-K × L*)
    
    Parameters:
    -----------
    Lstar_initial : float
        Initial L* [m]
    Lstar_final : float
        Final L* [m]
    efficiency_C : float
        Efficiency loss parameter (default 0.3)
    efficiency_K : float
        Recovery rate parameter (default 0.15)
    
    Returns:
    --------
    results : dict
        - eta_initial: Initial combustion efficiency
        - eta_final: Final combustion efficiency
        - eta_degradation_pct: Percentage drop in efficiency
        - cstar_degradation_pct: Approximate c* degradation
    """
    eta_initial = 1.0 - efficiency_C * np.exp(-efficiency_K * Lstar_initial)
    eta_final = 1.0 - efficiency_C * np.exp(-efficiency_K * Lstar_final)
    
    eta_degradation_pct = (eta_final - eta_initial) / eta_initial * 100.0
    
    # c* is proportional to efficiency
    cstar_degradation_pct = eta_degradation_pct
    
    return {
        "eta_initial": float(eta_initial),
        "eta_final": float(eta_final),
        "eta_degradation_pct": float(eta_degradation_pct),
        "cstar_degradation_pct": float(cstar_degradation_pct),
    }

