"""Localized ablation modeling at fuel impingement points.

This module models enhanced ablation at locations where fuel spray impinges
on the ablative liner, accounting for:
1. Direct impingement heat flux
2. Enhanced local heat transfer
3. Spatial distribution of impingement zones
4. Time-varying impingement patterns
"""

from __future__ import annotations

from typing import Dict, Tuple, Optional, List
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig, PintleInjectorConfig


def calculate_impingement_zones(
    config: PintleEngineConfig,
    chamber_length: float,
    chamber_diameter: float,
    n_points: int = 100,
) -> Dict[str, np.ndarray]:
    """
    Calculate spatial distribution of fuel impingement zones on chamber wall.
    
    For pintle injectors, fuel sprays radially outward and impinges on the
    chamber wall at specific axial and circumferential locations.
    
    Parameters:
    -----------
    config : PintleEngineConfig
        Engine configuration
    chamber_length : float
        Chamber length [m]
    chamber_diameter : float
        Chamber diameter [m]
    n_points : int
        Number of axial points to evaluate
    
    Returns:
    --------
    impingement_data : dict
        - axial_positions: Array of axial positions [m]
        - impingement_heat_flux_multiplier: Local heat flux multiplier (1.0 = baseline, >1.0 = enhanced)
        - impingement_zones: Boolean array indicating impingement zones
        - spray_angle: Spray angle at each position [rad]
        - impingement_distance: Distance from injector to wall [m]
    """
    if not hasattr(config, 'injector') or config.injector.type != "pintle":
        # No impingement for non-pintle injectors
        positions = np.linspace(0, chamber_length, n_points)
        return {
            "axial_positions": positions,
            "impingement_heat_flux_multiplier": np.ones_like(positions),
            "impingement_zones": np.zeros_like(positions, dtype=bool),
            "spray_angle": np.zeros_like(positions),
            "impingement_distance": np.full_like(positions, np.nan),
        }
    
    injector_config: PintleInjectorConfig = config.injector
    geometry = injector_config.geometry
    
    # Get pintle geometry
    d_pintle_tip = geometry.fuel.d_pintle_tip
    theta_orifice = geometry.lox.theta_orifice  # Orifice angle [deg]
    n_orifices = geometry.lox.n_orifices
    
    # Calculate spray characteristics
    # Fuel sprays radially from pintle tip
    # LOX sprays axially at angle theta_orifice
    # Combined spray impinges on wall
    
    positions = np.linspace(0, chamber_length, n_points)
    
    # Calculate where fuel spray impinges on wall
    # Assuming radial fuel spray and axial LOX spray
    # Impingement occurs where spray trajectory intersects chamber wall
    
    # Simplified model: impingement occurs at distance from injector
    # based on spray angle and chamber radius
    R_chamber = chamber_diameter / 2.0
    R_pintle = d_pintle_tip / 2.0
    
    # Fuel spray angle (radial, ~90 degrees from axis)
    # Combined spray angle depends on momentum flux ratio
    # For now, use simplified model based on orifice angle
    spray_angle_deg = theta_orifice  # Approximate
    spray_angle = np.deg2rad(spray_angle_deg)
    
    # Distance from injector to wall impingement
    # For radial spray: L_impinge ≈ R_chamber / tan(spray_angle)
    # For small angles, L_impinge ≈ R_chamber / spray_angle
    if spray_angle > 0.01:
        L_impinge = R_chamber / np.tan(spray_angle)
    else:
        L_impinge = chamber_length * 0.1  # Default: 10% of chamber length
    
    # Impingement zone: region where spray hits wall
    # Use Gaussian distribution around impingement point
    impingement_center = min(L_impinge, chamber_length * 0.3)  # Typically in first 30% of chamber
    impingement_width = chamber_length * 0.1  # 10% of chamber length
    
    # Calculate impingement intensity (Gaussian distribution)
    impingement_intensity = np.exp(-0.5 * ((positions - impingement_center) / (impingement_width / 3)) ** 2)
    
    # Heat flux multiplier: enhanced ablation at impingement zones
    # Typical enhancement: 2-5x baseline heat flux
    base_multiplier = 1.0
    max_multiplier = 3.5  # 3.5x enhancement at peak impingement
    heat_flux_multiplier = base_multiplier + (max_multiplier - base_multiplier) * impingement_intensity
    
    # Identify impingement zones (where multiplier > 1.5)
    impingement_zones = heat_flux_multiplier > 1.5
    
    # Calculate spray angle at each position
    # Spray angle decreases with distance from injector
    spray_angles = np.full_like(positions, spray_angle)
    # At impingement, spray angle is perpendicular to wall
    near_impingement = np.abs(positions - impingement_center) < impingement_width
    spray_angles[near_impingement] = np.pi / 2.0  # Perpendicular
    
    # Impingement distance (distance from injector to wall at each position)
    impingement_distances = np.sqrt((positions - 0) ** 2 + R_chamber ** 2)
    
    return {
        "axial_positions": positions,
        "impingement_heat_flux_multiplier": heat_flux_multiplier,
        "impingement_zones": impingement_zones,
        "spray_angle": spray_angles,
        "impingement_distance": impingement_distances,
        "impingement_center": impingement_center,
        "impingement_width": impingement_width,
    }


def calculate_localized_recession(
    base_heat_flux: np.ndarray,
    impingement_data: Dict[str, np.ndarray],
    base_recession_rate: np.ndarray,
    ablative_config,
) -> np.ndarray:
    """
    Calculate localized recession rates accounting for fuel impingement.
    
    Parameters:
    -----------
    base_heat_flux : np.ndarray
        Baseline heat flux [W/m²] at each axial position
    impingement_data : dict
        Output from calculate_impingement_zones()
    base_recession_rate : np.ndarray
        Baseline recession rate [m/s] (without impingement enhancement)
    ablative_config : AblativeCoolingConfig
        Ablative configuration
    
    Returns:
    --------
    localized_recession_rate : np.ndarray
        Enhanced recession rate [m/s] accounting for impingement
    """
    multiplier = impingement_data["impingement_heat_flux_multiplier"]
    
    # Enhanced heat flux at impingement zones
    enhanced_heat_flux = base_heat_flux * multiplier
    
    # Enhanced recession rate (proportional to heat flux)
    # Recession rate scales with heat flux: ṙ ∝ q / (H_ablation × ρ)
    localized_recession_rate = base_recession_rate * multiplier
    
    return localized_recession_rate


def get_impingement_enhancement_factor(
    config: PintleEngineConfig,
    axial_position: float,
    chamber_length: float,
) -> float:
    """
    Get heat flux enhancement factor at a specific axial position.
    
    Parameters:
    -----------
    config : PintleEngineConfig
        Engine configuration
    axial_position : float
        Axial position along chamber [m]
    chamber_length : float
        Chamber length [m]
    
    Returns:
    --------
    enhancement_factor : float
        Heat flux multiplier (1.0 = baseline, >1.0 = enhanced)
    """
    impingement_data = calculate_impingement_zones(config, chamber_length, 0.1, n_points=100)
    positions = impingement_data["axial_positions"]
    multipliers = impingement_data["impingement_heat_flux_multiplier"]
    
    # Interpolate to get multiplier at specific position
    if axial_position <= positions[0]:
        return multipliers[0]
    elif axial_position >= positions[-1]:
        return multipliers[-1]
    else:
        return np.interp(axial_position, positions, multipliers)

