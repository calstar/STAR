"""Variable thickness graphite insert that conforms to chamber geometry.

The graphite insert should follow the chamber internal contour with variable thickness
based on local heat flux and thermal requirements.
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple
import numpy as np
from engine.pipeline.config_schemas import GraphiteInsertConfig


def calculate_graphite_thickness_profile(
    positions: np.ndarray,
    R_gas: np.ndarray,
    heat_flux_profile: np.ndarray,
    graphite_config: GraphiteInsertConfig,
    recession_profile: Optional[np.ndarray] = None,
) -> Dict[str, np.ndarray]:
    """
    Calculate variable thickness graphite insert profile conforming to chamber geometry.
    
    The graphite insert follows the chamber internal contour (gas boundary) with
    thickness varying based on local heat flux and thermal requirements.
    
    Parameters:
    -----------
    positions : np.ndarray
        Axial positions [m]
    R_gas : np.ndarray
        Gas boundary radius [m] (chamber internal contour)
    heat_flux_profile : np.ndarray
        Local heat flux [W/m²] at each position
    graphite_config : GraphiteInsertConfig
        Graphite configuration
    recession_profile : np.ndarray, optional
        Local recession [m] at each position
    
    Returns:
    --------
    profile : dict
        - R_inner: Inner radius (gas boundary) [m]
        - R_outer: Outer radius (graphite outer surface) [m]
        - thickness: Local thickness [m]
        - thickness_remaining: Remaining thickness after recession [m]
    """
    n_points = len(positions)
    
    # Inner radius follows gas boundary
    R_inner = R_gas.copy()
    
    # Base thickness from config
    base_thickness = graphite_config.initial_thickness
    
    # Calculate thickness variation based on heat flux
    # Higher heat flux = thicker graphite needed
    if len(heat_flux_profile) == n_points:
        avg_heat_flux = np.mean(heat_flux_profile)
        # Physics-based thickness scaling
        from engine.pipeline.physics_based_replacements import calculate_graphite_thickness_multiplier_physics
        
        # Calculate surface temperature (simplified - would come from thermal analysis)
        surface_temp = 2000.0  # K, typical graphite surface temp
        backface_temp_limit = 500.0  # K, typical limit
        
        thickness = np.zeros(n_points)
        for i in range(n_points):
            multiplier = calculate_graphite_thickness_multiplier_physics(
                heat_flux_local=heat_flux_profile[i],
                heat_flux_avg=avg_heat_flux,
                thermal_conductivity=graphite_config.thermal_conductivity,
                backface_temp_limit=backface_temp_limit,
                surface_temp=surface_temp,
            )
            thickness[i] = base_thickness * multiplier
    else:
        # Uniform thickness if no heat flux profile
        thickness = np.full(n_points, base_thickness)
    
    # Apply recession if provided
    if recession_profile is not None and len(recession_profile) == n_points:
        thickness_remaining = np.maximum(thickness - recession_profile, 0.0)
    else:
        thickness_remaining = thickness.copy()
    
    # Outer radius = inner radius + thickness
    R_outer = R_inner + thickness_remaining
    
    return {
        "R_inner": R_inner,
        "R_outer": R_outer,
        "thickness": thickness,
        "thickness_remaining": thickness_remaining,
        "positions": positions,
    }


def calculate_graphite_geometry_conforming(
    L_chamber: float,
    D_chamber: float,
    D_throat: float,
    positions_chamber: np.ndarray,
    R_gas_chamber: np.ndarray,
    heat_flux_chamber: np.ndarray,
    graphite_config: GraphiteInsertConfig,
    graphite_start: float,
    graphite_end: float,
    recession_graphite: float = 0.0,
) -> Dict[str, np.ndarray]:
    """
    Calculate graphite insert geometry that conforms to chamber internal contour.
    
    The graphite insert:
    1. Follows the chamber gas boundary (inner surface)
    2. Has variable thickness based on local heat flux
    3. Extends from graphite_start to graphite_end
    
    Parameters:
    -----------
    L_chamber : float
        Chamber length [m]
    D_chamber : float
        Chamber diameter [m]
    D_throat : float
        Throat diameter [m]
    positions_chamber : np.ndarray
        Axial positions along chamber [m]
    R_gas_chamber : np.ndarray
        Gas boundary radius along chamber [m]
    heat_flux_chamber : np.ndarray
        Heat flux along chamber [W/m²]
    graphite_config : GraphiteInsertConfig
        Graphite configuration
    graphite_start : float
        Graphite insert start position [m]
    graphite_end : float
        Graphite insert end position [m]
    recession_graphite : float
        Cumulative graphite recession [m]
    
    Returns:
    --------
    geometry : dict
        - positions: Axial positions in graphite region [m]
        - R_inner: Inner radius (gas boundary) [m]
        - R_outer: Outer radius (graphite outer) [m]
        - thickness: Local thickness [m]
        - thickness_remaining: Remaining thickness [m]
    """
    # Find positions within graphite region
    graphite_mask = (positions_chamber >= graphite_start) & (positions_chamber <= graphite_end)
    
    if not np.any(graphite_mask):
        # No graphite region, return empty
        return {
            "positions": np.array([]),
            "R_inner": np.array([]),
            "R_outer": np.array([]),
            "thickness": np.array([]),
            "thickness_remaining": np.array([]),
        }
    
    # Extract graphite region
    positions_graphite = positions_chamber[graphite_mask]
    R_gas_graphite = R_gas_chamber[graphite_mask]
    heat_flux_graphite = heat_flux_chamber[graphite_mask] if len(heat_flux_chamber) == len(positions_chamber) else np.full(len(positions_graphite), np.mean(heat_flux_chamber))
    
    # Create recession profile (uniform for now, could be spatial)
    recession_profile = np.full(len(positions_graphite), recession_graphite)
    
    # Calculate variable thickness profile
    profile = calculate_graphite_thickness_profile(
        positions_graphite,
        R_gas_graphite,
        heat_flux_graphite,
        graphite_config,
        recession_profile=recession_profile,
    )
    
    return profile

