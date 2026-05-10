"""Fixed chamber geometry calculation with proper constant outer diameter.

This ensures:
1. Constant outer diameter for stainless steel
2. Proper layering: Gas → Ablative → Graphite → Stainless
3. Smooth transitions
4. Correct thickness modeling
"""

from __future__ import annotations

from typing import Dict, Optional
import numpy as np
from engine.pipeline.config_schemas import AblativeCoolingConfig, GraphiteInsertConfig


def calculate_chamber_geometry_fixed(
    L_chamber: float,
    D_chamber: float,
    D_throat: float,
    L_nozzle: float = 0.0,
    expansion_ratio: float = 10.0,
    ablative_config: Optional[AblativeCoolingConfig] = None,
    graphite_config: Optional[GraphiteInsertConfig] = None,
    recession_chamber: float = 0.0,
    recession_graphite: float = 0.0,
    n_points: int = 200,
) -> Dict[str, np.ndarray]:
    """
    Calculate chamber geometry with FIXED constant outer diameter.
    
    Structure:
    - Gas boundary (inner surface)
    - Ablative liner (chamber region only)
    - Graphite insert (throat region only)
    - Stainless steel (CONSTANT outer diameter)
    
    Parameters:
    -----------
    L_chamber : float
        Chamber length [m]
    D_chamber : float
        Chamber inner diameter [m] (after recession)
    D_throat : float
        Throat diameter [m]
    L_nozzle : float
        Nozzle length [m]
    expansion_ratio : float
        Nozzle expansion ratio
    ablative_config : AblativeCoolingConfig, optional
        Ablative configuration
    graphite_config : GraphiteInsertConfig, optional
        Graphite configuration
    recession_chamber : float
        Chamber recession [m]
    recession_graphite : float
        Graphite recession [m]
    n_points : int
        Number of points for geometry
    
    Returns:
    --------
    geometry : dict
        - positions: Axial positions [m]
        - R_gas: Gas boundary radius [m]
        - R_ablative_outer: Ablative outer radius [m]
        - R_graphite_outer: Graphite outer radius [m]
        - R_stainless: Stainless outer radius [m] (CONSTANT)
        - throat_position: Throat axial position [m]
        - graphite_start: Graphite start position [m]
        - graphite_end: Graphite end position [m]
    """
    # Total length
    L_total = L_chamber + L_nozzle
    
    # Create positions
    positions = np.linspace(0.0, L_total, n_points)
    
    # Throat position
    throat_pos = L_chamber
    
    # Calculate exit diameter from expansion ratio
    A_throat = np.pi * (D_throat / 2.0) ** 2
    A_exit = A_throat * expansion_ratio
    D_exit = np.sqrt(4.0 * A_exit / np.pi)
    
    # Gas boundary radius profile
    R_gas = np.zeros(n_points)
    for i, x in enumerate(positions):
        if x < throat_pos:
            # Chamber: constant diameter
            R_gas[i] = D_chamber / 2.0
        elif x < throat_pos + L_nozzle:
            # Nozzle: diverging
            x_nozzle = (x - throat_pos) / L_nozzle if L_nozzle > 0 else 0.0
            R_throat = D_throat / 2.0
            R_exit = D_exit / 2.0
            # Smooth transition
            R_gas[i] = R_throat + (R_exit - R_throat) * x_nozzle
        else:
            # Beyond nozzle
            R_gas[i] = D_exit / 2.0
    
    # Ablative liner (chamber region only)
    if ablative_config and ablative_config.enabled:
        ablative_thickness = max(
            ablative_config.initial_thickness - recession_chamber,
            0.0
        )
        R_ablative_outer = np.zeros_like(positions)
        for i, x in enumerate(positions):
            if x < throat_pos:
                R_ablative_outer[i] = R_gas[i] + ablative_thickness
            else:
                R_ablative_outer[i] = R_gas[i]  # No ablative in nozzle
    else:
        R_ablative_outer = R_gas.copy()
    
    # Graphite insert (throat region only)
    if graphite_config and graphite_config.enabled:
        graphite_axial_half_length = getattr(graphite_config, 'axial_half_length', None)
        if graphite_axial_half_length is None or graphite_axial_half_length <= 0:
            graphite_axial_half_length = 0.75 * D_throat
        
        graphite_start = max(throat_pos - graphite_axial_half_length, 0.0)
        graphite_end = min(throat_pos + graphite_axial_half_length, L_total)
        
        graphite_thickness = max(
            graphite_config.initial_thickness - recession_graphite,
            0.0
        )
        
        R_graphite_outer = np.zeros_like(positions)
        for i, x in enumerate(positions):
            if graphite_start <= x <= graphite_end:
                # Graphite conforms to gas boundary + thickness
                R_graphite_outer[i] = R_gas[i] + graphite_thickness
            else:
                R_graphite_outer[i] = R_gas[i]
    else:
        R_graphite_outer = R_gas.copy()
        graphite_start = throat_pos
        graphite_end = throat_pos
    
    # Stainless steel: CONSTANT OUTER DIAMETER
    # Find maximum inner radius (ablative or graphite) across ALL positions
    R_inner_max = np.maximum(R_ablative_outer, R_graphite_outer)
    R_inner_max_global = np.max(R_inner_max)
    
    # Constant thickness (realistic: 2-3mm for small engines)
    stainless_thickness = 0.0025  # 2.5mm (more realistic)
    
    # Constant outer radius everywhere
    R_stainless_constant = R_inner_max_global + stainless_thickness
    R_stainless = np.full_like(positions, R_stainless_constant)
    
    return {
        "positions": positions,
        "R_gas": R_gas,
        "R_ablative_outer": R_ablative_outer,
        "R_graphite_outer": R_graphite_outer,
        "R_stainless": R_stainless,
        "throat_position": throat_pos,
        "graphite_start": graphite_start,
        "graphite_end": graphite_end,
        "D_chamber": D_chamber,
        "D_throat": D_throat,
        "D_exit": D_exit,
    }

