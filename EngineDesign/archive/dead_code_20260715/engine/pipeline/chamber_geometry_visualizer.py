"""Clear chamber geometry visualization showing the actual structure.

Structure:
- Gas boundary (inner surface where hot gas flows)
- Ablative liner (chamber region, NOT throat)
- Graphite insert (ONLY at throat region, small axial length)
- Stainless steel case (outer structure)
- Nozzle (diverging section after throat)
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple
import numpy as np
import plotly.graph_objects as go
from engine.pipeline.config_schemas import PintleEngineConfig, AblativeCoolingConfig, GraphiteInsertConfig
from engine.pipeline.chamber_geometry_fixed import calculate_chamber_geometry_fixed


def calculate_chamber_geometry_clear(
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
    Calculate chamber geometry - delegates to fixed version.
    """
    return calculate_chamber_geometry_fixed(
        L_chamber=L_chamber,
        D_chamber=D_chamber,
        D_throat=D_throat,
        L_nozzle=L_nozzle,
        expansion_ratio=expansion_ratio,
        ablative_config=ablative_config,
        graphite_config=graphite_config,
        recession_chamber=recession_chamber,
        recession_graphite=recession_graphite,
        n_points=n_points,
    )


def calculate_chamber_geometry_clear_OLD(
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
    Calculate clear chamber geometry showing actual structure.
    
    Structure:
    - 0 to L_chamber: Chamber (ablative liner)
    - L_chamber: Throat (graphite insert, small axial extent)
    - L_chamber to L_chamber+L_nozzle: Nozzle (diverging, can be ablative or other)
    
    Parameters:
    -----------
    L_chamber : float
        Chamber length [m] (from injector to throat)
    D_chamber : float
        Chamber inner diameter [m]
    D_throat : float
        Throat diameter [m]
    L_nozzle : float
        Nozzle length [m] (diverging section after throat)
    expansion_ratio : float
        Nozzle expansion ratio (A_exit / A_throat)
    ablative_config : AblativeCoolingConfig, optional
        Ablative configuration
    graphite_config : GraphiteInsertConfig, optional
        Graphite configuration
    recession_chamber : float
        Cumulative ablative recession [m]
    recession_graphite : float
        Cumulative graphite recession [m]
    n_points : int
        Number of points for geometry
    
    Returns:
    --------
    geometry : dict
        - positions: Axial positions [m]
        - R_gas: Gas boundary radius [m]
        - R_ablative_outer: Ablative outer radius [m] (chamber region only)
        - R_graphite_outer: Graphite outer radius [m] (throat region only)
        - R_stainless: Stainless steel outer radius [m]
        - R_nozzle_gas: Nozzle gas boundary radius [m]
        - throat_position: Throat axial position [m]
        - graphite_start: Graphite insert start position [m]
        - graphite_end: Graphite insert end position [m]
    """
    # Calculate nozzle exit diameter
    A_throat = np.pi * (D_throat / 2.0) ** 2
    A_exit = A_throat * expansion_ratio
    D_exit = np.sqrt(4.0 * A_exit / np.pi)
    
    # Total length
    L_total = L_chamber + L_nozzle
    
    # Create positions
    positions = np.linspace(0.0, L_total, n_points)
    
    # Throat position
    throat_pos = L_chamber
    
    # Gas boundary (chamber + nozzle)
    R_gas = np.zeros_like(positions)
    for i, x in enumerate(positions):
        if x <= throat_pos:
            # Chamber: constant diameter
            R_gas[i] = (D_chamber / 2.0) + recession_chamber
        else:
            # Nozzle: diverging (linear for simplicity)
            x_nozzle = x - throat_pos
            R_throat = D_throat / 2.0
            R_exit = D_exit / 2.0
            if L_nozzle > 0:
                R_gas[i] = R_throat + (R_exit - R_throat) * (x_nozzle / L_nozzle)
            else:
                R_gas[i] = R_throat
    
    # Ablative liner (chamber region only, NOT throat or nozzle)
    # Variable thickness based on local heat flux and recession
    if ablative_config and ablative_config.enabled:
        # Base thickness after recession
        base_thickness = max(
            ablative_config.initial_thickness - recession_chamber,
            0.0
        )
        
        # Variable thickness: can vary along chamber based on heat flux
        # For now, use constant thickness (can be made variable with heat flux profile)
        ablative_thickness_profile = np.full(n_points, base_thickness)
        
        R_ablative_outer = np.zeros_like(positions)
        for i, x in enumerate(positions):
            if x < throat_pos:  # Chamber region only
                # Ablative outer = gas boundary + variable thickness
                R_ablative_outer[i] = R_gas[i] + ablative_thickness_profile[i]
            else:
                # No ablative in throat/nozzle region
                R_ablative_outer[i] = R_gas[i]
    else:
        R_ablative_outer = R_gas.copy()
    
    # Graphite insert (throat region only, variable thickness conforming to chamber)
    if graphite_config and graphite_config.enabled:
        # Get graphite axial length
        graphite_axial_half_length = getattr(graphite_config, 'axial_half_length', None)
        if graphite_axial_half_length is None or graphite_axial_half_length <= 0:
            graphite_axial_half_length = 0.75 * D_throat  # Default: 0.75 * D_throat on each side
        
        graphite_start = max(throat_pos - graphite_axial_half_length, 0.0)
        graphite_end = min(throat_pos + graphite_axial_half_length, L_total)
        
        # Calculate variable thickness graphite conforming to chamber geometry
        # Import variable thickness module
        try:
            from engine.pipeline.thermal.graphite_variable_thickness import calculate_graphite_geometry_conforming
            
            # Create heat flux profile (simplified - could be from actual analysis)
            # Higher heat flux near throat
            heat_flux_profile = np.zeros_like(positions)
            for i, x in enumerate(positions):
                if graphite_start <= x <= graphite_end:
                    # Heat flux peaks at throat
                    distance_from_throat = abs(x - throat_pos)
                    heat_flux_profile[i] = 1e6 * np.exp(-distance_from_throat / (0.1 * D_throat))
                else:
                    heat_flux_profile[i] = 0.0
            
            # Calculate conforming graphite geometry
            graphite_geometry = calculate_graphite_geometry_conforming(
                L_chamber=L_chamber,
                D_chamber=D_chamber,
                D_throat=D_throat,
                positions_chamber=positions,
                R_gas_chamber=R_gas,
                heat_flux_chamber=heat_flux_profile,
                graphite_config=graphite_config,
                graphite_start=graphite_start,
                graphite_end=graphite_end,
                recession_graphite=recession_graphite,
            )
            
            # Use variable thickness profile
            R_graphite_outer = np.zeros_like(positions)
            for i, x in enumerate(positions):
                if graphite_start <= x <= graphite_end:
                    # Find corresponding point in graphite geometry
                    if len(graphite_geometry["positions"]) > 0:
                        idx = np.argmin(np.abs(graphite_geometry["positions"] - x))
                        if idx < len(graphite_geometry["R_outer"]):
                            R_graphite_outer[i] = graphite_geometry["R_outer"][idx]
                        else:
                            # Fallback: use gas radius + base thickness
                            R_graphite_outer[i] = R_gas[i] + max(graphite_config.initial_thickness - recession_graphite, 0.0)
                    else:
                        R_graphite_outer[i] = R_gas[i] + max(graphite_config.initial_thickness - recession_graphite, 0.0)
                else:
                    # No graphite outside throat region
                    R_graphite_outer[i] = R_gas[i]
        except ImportError:
            # Fallback to uniform thickness
            graphite_thickness = max(graphite_config.initial_thickness - recession_graphite, 0.0)
            R_graphite_outer = np.zeros_like(positions)
            for i, x in enumerate(positions):
                if graphite_start <= x <= graphite_end:
                    # Graphite region: conforms to gas boundary + thickness
                    R_graphite_outer[i] = R_gas[i] + graphite_thickness
                else:
                    R_graphite_outer[i] = R_gas[i]
    else:
        R_graphite_outer = R_gas.copy()
        graphite_start = throat_pos
        graphite_end = throat_pos
    
    # Stainless steel case (CONSTANT OUTER DIAMETER)
    # The outer diameter must be constant - stainless does NOT follow internal contour
    # Find the maximum inner radius across ALL positions
    R_inner_max = np.maximum(R_ablative_outer, R_graphite_outer)
    R_inner_max_global = np.max(R_inner_max)  # Maximum inner radius anywhere
    
    # Stainless steel thickness
    stainless_thickness = 0.002  # Default 2mm (constant)
    
    # Constant outer radius = max inner radius + thickness
    # This creates a truly constant outer diameter
    R_stainless_constant = R_inner_max_global + stainless_thickness
    
    # Stainless outer radius is constant everywhere
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


def plot_chamber_geometry_clear(geometry: Dict[str, np.ndarray], config: Optional[PintleEngineConfig] = None) -> go.Figure:
    """
    Create clear plotly figure showing chamber geometry structure.
    
    Shows:
    - Gas boundary (orange)
    - Ablative liner (brown, chamber region only)
    - Graphite insert (black, throat region only)
    - Stainless steel (gray, outer)
    - Throat marker (red)
    """
    positions = geometry["positions"]
    R_gas = geometry["R_gas"]
    R_ablative = geometry["R_ablative_outer"]
    R_graphite = geometry["R_graphite_outer"]
    R_stainless = geometry["R_stainless"]
    throat_pos = geometry["throat_position"]
    graphite_start = geometry["graphite_start"]
    graphite_end = geometry["graphite_end"]
    
    fig = go.Figure()
    
    # Gas boundary (top)
    fig.add_trace(go.Scatter(
        x=positions,
        y=R_gas,
        mode='lines',
        name='Gas Boundary',
        line=dict(color='orange', width=3),
        fill='tozeroy',
        fillcolor='rgba(255, 165, 0, 0.1)',
    ))
    
    # Gas boundary (bottom)
    fig.add_trace(go.Scatter(
        x=positions,
        y=-R_gas,
        mode='lines',
        name='Gas Boundary (Lower)',
        line=dict(color='orange', width=3),
        fill='tozeroy',
        fillcolor='rgba(255, 165, 0, 0.1)',
        showlegend=False,
    ))
    
    # Ablative liner (chamber region only)
    # Find chamber region (before throat)
    chamber_mask = positions < throat_pos
    if np.any(chamber_mask):
        chamber_positions = positions[chamber_mask]
        chamber_ablative = R_ablative[chamber_mask]
        
        fig.add_trace(go.Scatter(
            x=chamber_positions,
            y=chamber_ablative,
            mode='lines',
            name='Ablative Liner (Chamber)',
            line=dict(color='brown', width=2, dash='dash'),
            fill='tonexty',
            fillcolor='rgba(139, 69, 19, 0.3)',
        ))
        
        fig.add_trace(go.Scatter(
            x=chamber_positions,
            y=-chamber_ablative,
            mode='lines',
            name='Ablative (Lower)',
            line=dict(color='brown', width=2, dash='dash'),
            fill='tonexty',
            fillcolor='rgba(139, 69, 19, 0.3)',
            showlegend=False,
        ))
    
    # Graphite insert (throat region only)
    graphite_mask = (positions >= graphite_start) & (positions <= graphite_end)
    if np.any(graphite_mask):
        graphite_positions = positions[graphite_mask]
        graphite_outer = R_graphite[graphite_mask]
        
        fig.add_trace(go.Scatter(
            x=graphite_positions,
            y=graphite_outer,
            mode='lines',
            name='Graphite Insert (Throat)',
            line=dict(color='black', width=3),
            fill='tonexty',
            fillcolor='rgba(0, 0, 0, 0.4)',
        ))
        
        fig.add_trace(go.Scatter(
            x=graphite_positions,
            y=-graphite_outer,
            mode='lines',
            name='Graphite (Lower)',
            line=dict(color='black', width=3),
            fill='tonexty',
            fillcolor='rgba(0, 0, 0, 0.4)',
            showlegend=False,
        ))
    
    # Stainless steel (outer) - constant outer diameter
    # Find what's underneath (ablative or graphite)
    R_under_stainless = np.maximum(R_ablative, R_graphite)
    
    # Stainless steel fills from inner to outer (constant outer)
    fig.add_trace(go.Scatter(
        x=positions,
        y=R_stainless,
        mode='lines',
        name='Stainless Steel Case',
        line=dict(color='gray', width=2, dash='dot'),
        fill='tonexty',
        fillcolor='rgba(128, 128, 128, 0.2)',
    ))
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=-R_stainless,
        mode='lines',
        name='Stainless (Lower)',
        line=dict(color='gray', width=2, dash='dot'),
        fill='tonexty',
        fillcolor='rgba(128, 128, 128, 0.2)',
        showlegend=False,
    ))
    
    # Throat marker
    R_throat = geometry["D_throat"] / 2.0
    fig.add_trace(go.Scatter(
        x=[throat_pos],
        y=[R_throat],
        mode='markers',
        name='Throat',
        marker=dict(size=15, color='red', symbol='circle', line=dict(width=3, color='darkred')),
    ))
    
    fig.add_trace(go.Scatter(
        x=[throat_pos],
        y=[-R_throat],
        mode='markers',
        marker=dict(size=15, color='red', symbol='circle', line=dict(width=3, color='darkred')),
        showlegend=False,
    ))
    
    # Centerline
    fig.add_trace(go.Scatter(
        x=[positions[0], positions[-1]],
        y=[0, 0],
        mode='lines',
        name='Centerline',
        line=dict(color='gray', width=1, dash='dash'),
        showlegend=False,
    ))
    
    # Calculate data ranges for proper 1:1 aspect ratio
    x_min, x_max = positions.min(), positions.max()
    y_max = max(np.max(R_stainless), np.max(R_gas))
    y_min = -y_max  # Symmetric about centerline
    
    x_range = x_max - x_min
    y_range = y_max - y_min
    
    # Add 5% padding
    x_pad = 0.05 * x_range
    y_pad = 0.05 * y_range
    
    fig.update_layout(
        title="Chamber Geometry: Gas → Ablative (Chamber) → Graphite (Throat) → Stainless Steel",
        xaxis_title="Axial Position [m]",
        yaxis_title="Radius [m]",
        height=600,
        showlegend=True,
        # Force 1:1 aspect ratio with explicit ranges
        xaxis=dict(
            range=[x_min - x_pad, x_max + x_pad],
            constrain="domain",
        ),
        yaxis=dict(
            range=[y_min - y_pad, y_max + y_pad],
            scaleanchor="x",
            scaleratio=1,
            constrain="domain",
        ),
    )
    
    return fig

