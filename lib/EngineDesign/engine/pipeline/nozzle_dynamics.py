"""Nozzle dynamics: exit velocity, efficiency, melting, hotspots.

This module tracks nozzle performance and thermal behavior over time.
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple
import numpy as np
from engine.pipeline.config_schemas import NozzleConfig
from engine.core.mach_solver import solve_mach_robust


def calculate_nozzle_exit_velocity(
    Pc: float,
    Tc: float,
    gamma: float,
    R: float,
    expansion_ratio: float,
    nozzle_efficiency: float = 0.98,
    P_ambient: float = 101325.0,
) -> Dict[str, float]:
    """
    Calculate nozzle exit velocity using isentropic flow relations (Geometry-Driven).
    
    Implements a robust geometry-driven nozzle model:
    1. Determine M_exit from expansion ratio (geometry)
    2. Compute P_exit and T_exit isentropically from M_exit
    3. Calculate ideal velocity
    4. Apply nozzle efficiency for actual velocity
    
    Parameters:
    -----------
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    gamma : float
        Specific heat ratio
    R : float
        Gas constant [J/(kg·K)]
    expansion_ratio : float
        Nozzle expansion ratio (A_exit / A_throat)
    nozzle_efficiency : float, optional
        Nozzle energy efficiency factor (default: 0.98)
    P_ambient : float
        Ambient pressure [Pa] (unused for internal conversion, but kept for interface)
    
    Returns:
    --------
    results : dict
        - v_exit: Exit velocity [m/s] (actual, with efficiency)
        - M_exit: Exit Mach number
        - T_exit: Exit temperature [K]
        - efficiency: Nozzle efficiency used
        - P_exit: Exit pressure [Pa]
        - P_throat: Throat pressure [Pa]
    """
    # Throat conditions (for reference)
    # P_throat/Pc = [2/(gamma+1)]^(gamma/(gamma-1))
    P_throat = Pc * ((2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0)))
    
    # Exit Mach number from area ratio (Geometry-Driven)
    # For isentropic flow: A/A* = (1/M) * ((2/(gamma+1)) * (1 + (gamma-1)/2 * M^2))^((gamma+1)/(2*(gamma-1)))
    M_exit, _ = solve_mach_robust(expansion_ratio, gamma, supersonic=True)
    
    # Exit temperature (isentropic from stagnation)
    # T_exit/Tc = 1 / [1 + (γ-1)/2 × M_exit²]
    temperature_factor = 1.0 / (1.0 + (gamma - 1.0) / 2.0 * M_exit ** 2)
    T_exit = Tc * temperature_factor
    
    # Exit Pressure (isentropic from stagnation)
    # P_exit/Pc = [1 + (γ-1)/2 × M_exit²]^(-γ/(γ-1))
    pressure_exponent = -gamma / (gamma - 1.0)
    pressure_factor = (1.0 + (gamma - 1.0) / 2.0 * M_exit ** 2) ** pressure_exponent
    P_exit = Pc * pressure_factor
    
    # Exit velocity: v = M * sqrt(gamma * R * T)
    # This is the IDEAL isentropic velocity
    v_exit_ideal = M_exit * np.sqrt(gamma * R * T_exit)
    
    # Apply efficiency explicitly
    # v_actual = eta * v_ideal
    v_exit = v_exit_ideal * nozzle_efficiency
    
    return {
        "v_exit": float(v_exit),
        "M_exit": float(M_exit),
        "T_exit": float(T_exit),
        "efficiency": float(nozzle_efficiency),
        "P_exit": float(P_exit),
        "P_throat": float(P_throat),
    }


def calculate_nozzle_heat_flux(
    positions: np.ndarray,
    Pc: float,
    Tc: float,
    mdot: float,
    gamma: float,
    R: float,
    D_throat: float,
    expansion_ratio: float,
    Pr: float = 0.7,
    mu: float = 4e-5,
) -> Dict[str, np.ndarray]:
    """
    Calculate heat flux distribution along nozzle.
    
    Uses Bartz correlation for heat flux:
    q = 0.026 * (mu^0.2 * cp / Pr^0.6) * (Pc^0.8 / D_throat^0.2) * (T_gas^0.8) * (1 + (gamma-1)/2 * M^2)^(-0.6)
    
    Parameters:
    -----------
    positions : np.ndarray
        Axial positions along nozzle [m] (0 = throat, L = exit)
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    mdot : float
        Mass flow rate [kg/s]
    gamma : float
        Specific heat ratio
    R : float
        Gas constant [J/(kg·K)]
    D_throat : float
        Throat diameter [m]
    expansion_ratio : float
        Nozzle expansion ratio
    Pr : float
        Prandtl number
    mu : float
        Dynamic viscosity [Pa·s]
    
    Returns:
    --------
    results : dict
        - heat_flux: Heat flux at each position [W/m²]
        - temperature: Gas temperature at each position [K]
        - pressure: Gas pressure at each position [Pa]
        - mach_number: Mach number at each position
        - velocity: Gas velocity at each position [m/s]
    """
    n_points = len(positions)
    L_nozzle = positions[-1] - positions[0] if len(positions) > 1 else 0.1
    
    # Calculate local properties along nozzle
    heat_flux = np.zeros(n_points)
    temperature = np.zeros(n_points)
    pressure = np.zeros(n_points)
    mach_number = np.zeros(n_points)
    velocity = np.zeros(n_points)
    
    # Throat conditions
    P_throat = Pc * ((2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0)))
    T_throat = Tc * (2.0 / (gamma + 1.0))
    M_throat = 1.0
    v_throat = np.sqrt(gamma * R * T_throat)
    
    # Exit conditions
    A_throat = np.pi * (D_throat / 2.0) ** 2
    A_exit = A_throat * expansion_ratio
    D_exit = np.sqrt(4.0 * A_exit / np.pi)
    
    # Solve for exit Mach number (isentropic)
    # A/A* = (1/M) * ((2/(gamma+1)) * (1 + (gamma-1)/2 * M^2))^((gamma+1)/(2*(gamma-1)))
    # Use robust consolidated solver
    # Note: Only M_exit is used for interpolation; P_exit, T_exit, v_exit are calculated locally in the loop
    M_exit, _ = solve_mach_robust(expansion_ratio, gamma, supersonic=True)
    
    # Calculate pressure exponent (used in loop for local pressure calculation)
    pressure_exponent = -gamma / (gamma - 1.0)
    
    # Interpolate along nozzle
    for i, x in enumerate(positions):
        # Normalized position (0 = throat, 1 = exit)
        xi = (x - positions[0]) / L_nozzle if L_nozzle > 0 else 0.0
        
        # Local area ratio (linear interpolation for simplicity)
        A_local = A_throat + (A_exit - A_throat) * xi
        D_local = np.sqrt(4.0 * A_local / np.pi)
        area_ratio = A_local / A_throat
        
        # Local Mach number (approximate from area ratio)
        if area_ratio <= 1.0:
            M_local = 1.0
        else:
            # For supersonic: M increases with area
            M_local = 1.0 + (M_exit - 1.0) * xi
        
        # Local properties (isentropic)
        # CORRECT: Use Pc and Tc (stagnation conditions) as reference
        # T_local/Tc = [1 + (γ-1)/2 × M_local²]^(-1)
        temperature_factor_local = 1.0 / (1.0 + (gamma - 1.0) / 2.0 * M_local ** 2)
        T_local = Tc * temperature_factor_local
        # P_local/Pc = [1 + (γ-1)/2 × M_local²]^(-γ/(γ-1))
        pressure_factor_local = (1.0 + (gamma - 1.0) / 2.0 * M_local ** 2) ** pressure_exponent
        P_local = Pc * pressure_factor_local
        v_local = M_local * np.sqrt(gamma * R * T_local)
        
        # Heat flux using Bartz correlation
        cp = gamma * R / (gamma - 1.0)  # Specific heat
        # Bartz: q = 0.026 * (mu^0.2 * cp / Pr^0.6) * (Pc^0.8 / D^0.2) * (T^0.8) * (1 + (gamma-1)/2 * M^2)^(-0.6)
        q_bartz = 0.026 * ((mu ** 0.2 * cp) / (Pr ** 0.6)) * ((Pc ** 0.8) / (D_local ** 0.2)) * (T_local ** 0.8) * ((1.0 + (gamma - 1.0) / 2.0 * M_local ** 2) ** (-0.6))
        
        heat_flux[i] = q_bartz
        temperature[i] = T_local
        pressure[i] = P_local
        mach_number[i] = M_local
        velocity[i] = v_local
    
    return {
        "heat_flux": heat_flux,
        "temperature": temperature,
        "pressure": pressure,
        "mach_number": mach_number,
        "velocity": velocity,
        "positions": positions,
    }


def detect_nozzle_hotspots(
    heat_flux: np.ndarray,
    positions: np.ndarray,
    threshold_multiplier: float = 1.5,
) -> Dict[str, np.ndarray]:
    """
    Detect hotspots in nozzle based on heat flux.
    
    Hotspots are regions where heat flux exceeds threshold (typically 1.5x average).
    
    Parameters:
    -----------
    heat_flux : np.ndarray
        Heat flux distribution [W/m²]
    positions : np.ndarray
        Axial positions [m]
    threshold_multiplier : float
        Multiplier for average heat flux to define hotspot threshold
    
    Returns:
    --------
    hotspots : dict
        - is_hotspot: Boolean array indicating hotspot locations
        - hotspot_intensity: Intensity factor (1.0 = threshold, >1.0 = hotspot)
        - hotspot_positions: Positions of hotspots [m]
        - max_heat_flux: Maximum heat flux [W/m²]
        - avg_heat_flux: Average heat flux [W/m²]
    """
    avg_heat_flux = np.mean(heat_flux)
    max_heat_flux = np.max(heat_flux)
    threshold = avg_heat_flux * threshold_multiplier
    
    # Identify hotspots
    is_hotspot = heat_flux > threshold
    hotspot_intensity = heat_flux / (threshold + 1e-10)
    
    # Get hotspot positions
    hotspot_positions = positions[is_hotspot]
    
    return {
        "is_hotspot": is_hotspot,
        "hotspot_intensity": hotspot_intensity,
        "hotspot_positions": hotspot_positions,
        "max_heat_flux": float(max_heat_flux),
        "avg_heat_flux": float(avg_heat_flux),
        "threshold": float(threshold),
    }


def calculate_nozzle_melting(
    heat_flux: np.ndarray,
    positions: np.ndarray,
    material_melting_temp: float = 2000.0,  # K, typical nozzle material
    thermal_conductivity: float = 50.0,  # W/(m·K)
    wall_thickness: float = 0.002,  # m
    backface_temp: float = 300.0,  # K
    time: float = 1.0,  # s
) -> Dict[str, np.ndarray]:
    """
    Calculate nozzle wall temperature and melting risk.
    
    Parameters:
    -----------
    heat_flux : np.ndarray
        Heat flux distribution [W/m²]
    positions : np.ndarray
        Axial positions [m]
    material_melting_temp : float
        Material melting temperature [K]
    thermal_conductivity : float
        Material thermal conductivity [W/(m·K)]
    wall_thickness : float
        Wall thickness [m]
    backface_temp : float
        Backface temperature [K]
    time : float
        Exposure time [s]
    
    Returns:
    --------
    melting : dict
        - wall_temperature: Wall surface temperature [K]
        - is_melting: Boolean array indicating melting locations
        - safety_margin: Safety margin (1.0 = at melting, >1.0 = safe)
        - time_to_melt: Estimated time to melt [s]
    """
    n_points = len(heat_flux)
    
    # Steady-state wall temperature
    # q = k * (T_wall - T_back) / t
    # T_wall = T_back + q * t / k
    wall_temperature = backface_temp + heat_flux * wall_thickness / thermal_conductivity
    
    # Check for melting
    is_melting = wall_temperature > material_melting_temp
    safety_margin = material_melting_temp / (wall_temperature + 1e-10)
    
    # Time to melt (simplified - assumes constant heat flux)
    # For transient: T = T_back + (q * t / (rho * cp * t)) * (1 - exp(-t/tau))
    # Simplified: assume steady-state reached
    time_to_melt = np.full(n_points, np.inf)
    for i in range(n_points):
        if heat_flux[i] > 0 and wall_temperature[i] < material_melting_temp:
            # Time to reach melting temp
            delta_T_needed = material_melting_temp - backface_temp
            if delta_T_needed > 0:
                # From steady-state: T = T_back + q*t/k
                # t = (T - T_back) * k / q
                time_to_melt[i] = delta_T_needed * thermal_conductivity / heat_flux[i]
        elif wall_temperature[i] >= material_melting_temp:
            time_to_melt[i] = 0.0
    
    return {
        "wall_temperature": wall_temperature,
        "is_melting": is_melting,
        "safety_margin": safety_margin,
        "time_to_melt": time_to_melt,
        "max_temperature": float(np.max(wall_temperature)),
        "melting_locations": positions[is_melting],
    }

