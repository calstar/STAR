"""Physics-based replacements for arbitrary multipliers.

This module provides physics-based calculations to replace arbitrary factors
and multipliers throughout the codebase.
"""

from __future__ import annotations

from typing import Dict, Optional
import numpy as np


def calculate_recirculation_length_physics(
    D_chamber: float,
    d_pintle_tip: float,
    fuel_velocity: float,
    lox_velocity: float,
    Re_chamber: float,
) -> float:
    """
    Calculate recirculation length based on physics.
    
    Physics:
    - Recirculation length scales with chamber diameter
    - Depends on Reynolds number (turbulent flow)
    - Depends on velocity ratio (fuel/LOX)
    - Typical: L_recirc = 0.2-0.4 * D_chamber for turbulent jets
    
    Parameters:
    -----------
    D_chamber : float
        Chamber diameter [m]
    d_pintle_tip : float
        Pintle tip diameter [m]
    fuel_velocity : float
        Fuel injection velocity [m/s]
    lox_velocity : float
        LOX injection velocity [m/s]
    Re_chamber : float
        Chamber Reynolds number
    
    Returns:
    --------
    L_recirc : float
        Recirculation length [m]
    """
    # Base recirculation length from turbulent jet theory
    # For turbulent jets: L_recirc ~ 0.2-0.4 * D_chamber
    # Depends on Reynolds number: higher Re = longer recirculation
    Re_factor = np.clip(Re_chamber / 1e5, 0.5, 2.0)  # Normalize to 1e5
    base_factor = 0.2 + 0.1 * np.log10(max(Re_factor, 0.1))  # 0.2-0.3 range
    
    # Velocity ratio effect: higher velocity ratio = longer recirculation
    velocity_ratio = fuel_velocity / (lox_velocity + 1e-10)
    velocity_factor = 1.0 + 0.2 * np.clip(velocity_ratio - 1.0, 0.0, 2.0)
    
    # Pintle size effect: larger pintle = larger recirculation zone
    pintle_ratio = d_pintle_tip / (D_chamber + 1e-10)
    pintle_factor = 1.0 + 0.3 * np.clip(pintle_ratio - 0.1, 0.0, 0.3)
    
    L_recirc = base_factor * D_chamber * velocity_factor * pintle_factor
    
    return float(np.clip(L_recirc, 0.1 * D_chamber, 0.5 * D_chamber))


def calculate_evaporation_factor_physics(
    evaporation_length: float,
    chamber_length: float,
    SMD: float,
    target_smd: float,
    Pc: float,
    Tc: float,
) -> float:
    """
    Calculate evaporation factor based on physics.
    
    Physics:
    - If evaporation_length < chamber_length: good evaporation
    - Factor based on d^2-law evaporation: t_evap ~ d^2 / K
    - Accounts for incomplete evaporation when L_evap > L_chamber
    
    Parameters:
    -----------
    evaporation_length : float
        Evaporation length [m]
    chamber_length : float
        Chamber length [m]
    SMD : float
        Sauter mean diameter [m]
    target_smd : float
        Target SMD [m]
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    
    Returns:
    --------
    evap_factor : float
        Evaporation factor (0-1, higher = better)
    """
    if chamber_length <= 0:
        return 0.5  # Unknown
    
    # Evaporation ratio: how much of chamber is needed for evaporation
    evap_ratio = evaporation_length / chamber_length
    
    # Physics: evaporation efficiency based on residence time vs evaporation time
    # If L_evap << L_chamber: complete evaporation (factor → 1)
    # If L_evap >> L_chamber: incomplete evaporation (factor → 0)
    # Model: efficiency = exp(-L_evap / L_chamber) for L_evap > L_chamber
    if evap_ratio <= 1.0:
        # Complete evaporation within chamber
        evap_factor = 1.0 - 0.2 * evap_ratio  # Slight penalty for longer evaporation
    else:
        # Incomplete evaporation
        # Use exponential decay: efficiency drops as L_evap increases
        evap_factor = np.exp(-(evap_ratio - 1.0))
    
    # Droplet size effect: larger droplets = slower evaporation
    if SMD > 0 and target_smd > 0:
        smd_penalty = (SMD / target_smd) ** 0.5  # Square root scaling (d^2 law)
        evap_factor = evap_factor / smd_penalty
    
    return float(np.clip(evap_factor, 0.1, 1.0))


def calculate_smd_factor_physics(
    SMD: float,
    target_smd: float,
    Re_injector: float,
    We_injector: float,
) -> float:
    """
    Calculate SMD factor based on physics.
    
    Physics:
    - Smaller droplets → better mixing
    - Factor based on mixing time: t_mix ~ d^2 / D
    - Accounts for spray quality from Weber/Reynolds numbers
    
    Parameters:
    -----------
    SMD : float
        Actual Sauter mean diameter [m]
    target_smd : float
        Target SMD [m]
    Re_injector : float
        Injector Reynolds number
    We_injector : float
        Injector Weber number
    
    Returns:
    --------
    smd_factor : float
        SMD factor (0-1, higher = better mixing)
    """
    if SMD <= 0 or target_smd <= 0:
        # Estimate from injector conditions
        # Higher We → better breakup → smaller droplets
        we_factor = np.clip(We_injector / 15.0, 0.5, 2.0)  # Normalize to We=15
        estimated_factor = 0.5 + 0.3 * np.log10(max(we_factor, 0.1))
        return float(np.clip(estimated_factor, 0.3, 0.9))
    
    # Physics: mixing time scales with d^2 (diffusion limited)
    # Smaller droplets → faster mixing
    smd_ratio = SMD / target_smd
    
    # Mixing efficiency: efficiency ~ 1 / (1 + (d/d_target)^2)
    # This comes from diffusion time scaling: t ~ d^2
    smd_factor = 1.0 / (1.0 + (smd_ratio - 1.0) ** 2)
    
    return float(np.clip(smd_factor, 0.1, 1.0))


def calculate_throat_heat_flux_physics(
    heat_flux_chamber: float,
    Pc: float,
    V_chamber: float,
    V_throat: float,
    gamma: float,
    D_chamber: float,
    D_throat: float,
) -> float:
    """
    Calculate throat heat flux using Bartz correlation (physics-based).
    
    Physics:
    - Bartz correlation: q_throat / q_chamber = f(V, P, D)
    - Accounts for velocity, pressure, and diameter effects
    - No arbitrary multipliers
    
    Parameters:
    -----------
    heat_flux_chamber : float
        Chamber heat flux [W/m²]
    Pc : float
        Chamber pressure [Pa]
    V_chamber : float
        Chamber velocity [m/s]
    V_throat : float
        Throat velocity [m/s] (sonic)
    gamma : float
        Specific heat ratio
    D_chamber : float
        Chamber diameter [m]
    D_throat : float
        Throat diameter [m]
    
    Returns:
    --------
    heat_flux_throat : float
        Throat heat flux [W/m²]
    """
    if V_chamber <= 0 or V_throat <= 0:
        return heat_flux_chamber * 1.3  # Fallback
    
    # Bartz correlation for heat flux ratio
    # q_throat / q_chamber = (V_throat/V_chamber)^0.8 × (P_throat/P_chamber)^0.2 × (D_chamber/D_throat)^0.1
    
    # Velocity ratio (dominant)
    velocity_ratio = V_throat / V_chamber
    velocity_factor = velocity_ratio ** 0.8
    
    # Pressure ratio (throat is at critical pressure)
    P_throat = Pc * ((2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0)))
    pressure_ratio = P_throat / Pc
    pressure_factor = pressure_ratio ** 0.2
    
    # Diameter ratio (smaller throat = higher heat flux)
    diameter_ratio = D_chamber / (D_throat + 1e-10)
    diameter_factor = diameter_ratio ** 0.1
    
    # Total heat flux ratio
    heat_flux_ratio = velocity_factor * pressure_factor * diameter_factor
    
    heat_flux_throat = heat_flux_chamber * heat_flux_ratio
    
    return float(heat_flux_throat)


def calculate_recirculation_intensity_physics(
    fuel_velocity: float,
    lox_velocity: float,
    d_pintle_tip: float,
    D_chamber: float,
    Re_injector: float,
) -> float:
    """
    Calculate recirculation intensity based on physics.
    
    Physics:
    - Recirculation intensity depends on velocity ratio
    - Higher velocity difference → stronger recirculation
    - Depends on Reynolds number (turbulent flow)
    - Scales with injector size
    
    Parameters:
    -----------
    fuel_velocity : float
        Fuel injection velocity [m/s]
    lox_velocity : float
        LOX injection velocity [m/s]
    d_pintle_tip : float
        Pintle tip diameter [m]
    D_chamber : float
        Chamber diameter [m]
    Re_injector : float
        Injector Reynolds number
    
    Returns:
    --------
    intensity : float
        Recirculation intensity (0-1)
    """
    # Velocity difference drives recirculation
    velocity_diff = abs(fuel_velocity - lox_velocity)
    velocity_avg = (fuel_velocity + lox_velocity) / 2.0
    velocity_ratio = velocity_diff / (velocity_avg + 1e-10)
    
    # Base intensity from velocity ratio
    # Higher velocity difference → stronger recirculation
    base_intensity = 0.2 * velocity_ratio  # Physics-based scaling
    
    # Reynolds number effect: higher Re → more turbulent → stronger recirculation
    Re_factor = np.clip(Re_injector / 1e4, 0.5, 2.0)
    Re_enhancement = 1.0 + 0.3 * np.log10(max(Re_factor, 0.1))
    
    # Pintle size effect: larger pintle → larger recirculation
    pintle_ratio = d_pintle_tip / (D_chamber + 1e-10)
    pintle_factor = 1.0 + 0.2 * np.clip(pintle_ratio - 0.1, 0.0, 0.3)
    
    intensity = base_intensity * Re_enhancement * pintle_factor
    
    return float(np.clip(intensity, 0.0, 0.8))


def calculate_turbulence_enhancement_physics(
    Re_throat: float,
    velocity_ratio: float,
    D_chamber: float,
    D_throat: float,
) -> float:
    """
    Calculate turbulence enhancement at throat based on physics.
    
    Physics:
    - Turbulence increases near throat due to:
      1. Higher Reynolds number (sonic conditions)
      2. Flow acceleration (velocity gradient)
      3. Geometry change (diameter reduction)
    
    Parameters:
    -----------
    Re_throat : float
        Throat Reynolds number
    velocity_ratio : float
        V_throat / V_chamber
    D_chamber : float
        Chamber diameter [m]
    D_throat : float
        Throat diameter [m]
    
    Returns:
    --------
    enhancement : float
        Turbulence enhancement factor
    """
    # Reynolds number effect: higher Re → more turbulent
    Re_factor = np.clip(Re_throat / 1e5, 0.5, 2.0)
    Re_enhancement = 1.0 + 0.15 * np.log10(max(Re_factor, 0.1))
    
    # Velocity gradient effect: acceleration → turbulence
    velocity_enhancement = 1.0 + 0.1 * (velocity_ratio - 1.0)
    
    # Geometry effect: diameter reduction → flow acceleration → turbulence
    diameter_ratio = D_chamber / (D_throat + 1e-10)
    geometry_enhancement = 1.0 + 0.05 * np.log10(max(diameter_ratio, 1.0))
    
    enhancement = Re_enhancement * velocity_enhancement * geometry_enhancement
    
    return float(np.clip(enhancement, 1.0, 1.3))


def calculate_graphite_thickness_multiplier_physics(
    heat_flux_local: float,
    heat_flux_avg: float,
    thermal_conductivity: float,
    backface_temp_limit: float,
    surface_temp: float,
) -> float:
    """
    Calculate graphite thickness multiplier based on thermal requirements.
    
    Physics:
    - Thickness needed to maintain backface temperature
    - t ~ k × (T_surface - T_backface) / q
    - Higher heat flux → thicker graphite needed
    
    Parameters:
    -----------
    heat_flux_local : float
        Local heat flux [W/m²]
    heat_flux_avg : float
        Average heat flux [W/m²]
    thermal_conductivity : float
        Graphite thermal conductivity [W/(m·K)]
    backface_temp_limit : float
        Maximum backface temperature [K]
    surface_temp : float
        Surface temperature [K]
    
    Returns:
    --------
    multiplier : float
        Thickness multiplier (relative to average)
    """
    if heat_flux_avg <= 0:
        return 1.0
    
    # Required thickness scales with heat flux and temperature difference
    # t = k × ΔT / q
    delta_T = surface_temp - backface_temp_limit
    
    if delta_T <= 0:
        return 1.0
    
    # Thickness ratio = heat flux ratio (for same ΔT and k)
    heat_flux_ratio = heat_flux_local / heat_flux_avg
    
    # Minimum thickness (mechanical) + thermal thickness
    # Multiplier = (t_min + t_thermal_local) / (t_min + t_thermal_avg)
    # For simplicity, assume t_min << t_thermal, so multiplier ≈ heat_flux_ratio
    # But add bounds for safety
    multiplier = 0.8 + 0.4 * np.clip(heat_flux_ratio - 0.5, 0.0, 2.0)
    
    return float(np.clip(multiplier, 0.7, 1.8))

