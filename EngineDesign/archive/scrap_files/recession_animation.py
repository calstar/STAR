"""Animated visualization of ablative recession over time.

This module creates animated cross-sections showing how the ablative liner
recedes over time, including localized effects at fuel impingement zones.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.pipeline.localized_ablation import calculate_impingement_zones


def create_recession_animation(
    time_history: np.ndarray,
    geometry_history: List[Dict[str, np.ndarray]],
    config: PintleEngineConfig,
    impingement_data: Optional[Dict[str, np.ndarray]] = None,
    save_path: Optional[str] = None,
) -> go.Figure:
    """
    Create animated plotly figure showing recession over time.
    
    Parameters:
    -----------
    time_history : np.ndarray
        Time points [s]
    geometry_history : List[dict]
        List of geometry dictionaries, one per time step
        Each dict contains:
        - positions: Axial positions [m]
        - D_gas_chamber: Gas-side diameter [m]
        - D_ablative_outer: Ablative outer diameter [m]
        - recession: Local recession [m]
    config : PintleEngineConfig
        Engine configuration
    impingement_data : dict, optional
        Output from calculate_impingement_zones()
    save_path : str, optional
        Path to save HTML animation
    
    Returns:
    --------
    fig : plotly.Figure
        Animated figure
    """
    n_steps = len(time_history)
    
    # Get initial geometry
    initial_geometry = geometry_history[0]
    positions = initial_geometry["positions"]
    n_points = len(positions)
    
    # Calculate impingement zones if not provided
    if impingement_data is None:
        chamber_length = positions[-1] if len(positions) > 0 else 0.2
        chamber_diameter = initial_geometry.get("D_chamber_initial", 0.1)
        impingement_data = calculate_impingement_zones(
            config, chamber_length, chamber_diameter, n_points=n_points
        )
    
    # Create figure with subplots
    fig = make_subplots(
        rows=2, cols=1,
        subplot_titles=("Chamber Cross-Section (Recession Over Time)", "Recession Rate Profile"),
        vertical_spacing=0.15,
        row_heights=[0.7, 0.3],
    )
    
    # Prepare data for animation
    frames = []
    
    for i, (t, geometry) in enumerate(zip(time_history, geometry_history)):
        positions = geometry["positions"]
        D_gas = np.array(geometry.get("D_gas_chamber", np.zeros_like(positions)))
        D_ablative = np.array(geometry.get("D_ablative_outer", D_gas))
        recession = np.array(geometry.get("recession", np.zeros_like(positions)))
        
        # Convert to radii
        R_gas = D_gas / 2.0
        R_ablative = D_ablative / 2.0
        
        # Create frame data
        frame_data = []
        
        # Gas boundary (top)
        frame_data.append(go.Scatter(
            x=positions,
            y=R_gas,
            mode='lines',
            name='Gas Boundary',
            line=dict(color='orange', width=3),
            showlegend=(i == 0),
        ))
        
        # Gas boundary (bottom)
        frame_data.append(go.Scatter(
            x=positions,
            y=-R_gas,
            mode='lines',
            name='Gas Boundary (Lower)',
            line=dict(color='orange', width=3),
            showlegend=False,
        ))
        
        # Ablative outer (top)
        frame_data.append(go.Scatter(
            x=positions,
            y=R_ablative,
            mode='lines',
            name='Ablative Outer',
            line=dict(color='brown', width=2, dash='dash'),
            fill='tonexty',
            fillcolor='rgba(139, 69, 19, 0.3)',
            showlegend=(i == 0),
        ))
        
        # Ablative outer (bottom)
        frame_data.append(go.Scatter(
            x=positions,
            y=-R_ablative,
            mode='lines',
            name='Ablative Outer (Lower)',
            line=dict(color='brown', width=2, dash='dash'),
            fill='tonexty',
            fillcolor='rgba(139, 69, 19, 0.3)',
            showlegend=False,
        ))
        
        # Impingement zones (highlighted)
        if impingement_data is not None:
            impingement_zones = impingement_data["impingement_zones"]
            if np.any(impingement_zones):
                imp_positions = positions[impingement_zones]
                imp_ablative = R_ablative[impingement_zones]
                
                frame_data.append(go.Scatter(
                    x=imp_positions,
                    y=imp_ablative,
                    mode='markers',
                    name='Impingement Zone',
                    marker=dict(size=8, color='red', symbol='circle'),
                    showlegend=(i == 0),
                ))
                frame_data.append(go.Scatter(
                    x=imp_positions,
                    y=-imp_ablative,
                    mode='markers',
                    name='Impingement Zone (Lower)',
                    marker=dict(size=8, color='red', symbol='circle'),
                    showlegend=False,
                ))
        
        # Recession rate profile (bottom subplot)
        recession_rate = np.gradient(recession, positions) if len(recession) > 1 else np.zeros_like(recession)
        frame_data.append(go.Scatter(
            x=positions,
            y=recession_rate * 1e6,  # Convert to mm/s
            mode='lines',
            name='Recession Rate',
            line=dict(color='red', width=2),
            xaxis='x2',
            yaxis='y2',
            showlegend=(i == 0),
        ))
        
        # Create frame
        frames.append(go.Frame(
            data=frame_data,
            name=str(i),
            traces=list(range(len(frame_data)))
        ))
    
    # Add initial data
    initial_geometry = geometry_history[0]
    positions = initial_geometry["positions"]
    D_gas = np.array(initial_geometry.get("D_gas_chamber", np.zeros_like(positions)))
    D_ablative = np.array(initial_geometry.get("D_ablative_outer", D_gas))
    R_gas = D_gas / 2.0
    R_ablative = D_ablative / 2.0
    
    # Initial traces
    fig.add_trace(go.Scatter(
        x=positions,
        y=R_gas,
        mode='lines',
        name='Gas Boundary',
        line=dict(color='orange', width=3),
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=-R_gas,
        mode='lines',
        name='Gas Boundary (Lower)',
        line=dict(color='orange', width=3),
        showlegend=False,
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=R_ablative,
        mode='lines',
        name='Ablative Outer',
        line=dict(color='brown', width=2, dash='dash'),
        fill='tonexty',
        fillcolor='rgba(139, 69, 19, 0.3)',
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=-R_ablative,
        mode='lines',
        name='Ablative Outer (Lower)',
        line=dict(color='brown', width=2, dash='dash'),
        fill='tonexty',
        fillcolor='rgba(139, 69, 19, 0.3)',
        showlegend=False,
    ), row=1, col=1)
    
    # Recession rate (initial)
    recession = np.array(initial_geometry.get("recession", np.zeros_like(positions)))
    recession_rate = np.gradient(recession, positions) if len(recession) > 1 else np.zeros_like(recession)
    fig.add_trace(go.Scatter(
        x=positions,
        y=recession_rate * 1e6,  # mm/s
        mode='lines',
        name='Recession Rate',
        line=dict(color='red', width=2),
    ), row=2, col=1)
    
    # Add frames
    fig.frames = frames
    
    # Update layout
    fig.update_layout(
        title="Ablative Recession Animation Over Time",
        height=800,
        updatemenus=[{
            "type": "buttons",
            "showactive": False,
            "buttons": [
                {
                    "label": "Play",
                    "method": "animate",
                    "args": [None, {
                        "frame": {"duration": 100, "redraw": True},
                        "fromcurrent": True,
                        "transition": {"duration": 50}
                    }]
                },
                {
                    "label": "Pause",
                    "method": "animate",
                    "args": [[None], {
                        "frame": {"duration": 0, "redraw": False},
                        "mode": "immediate",
                        "transition": {"duration": 0}
                    }]
                }
            ],
            "x": 0.1,
            "xanchor": "left",
            "y": 0,
            "yanchor": "bottom"
        }],
        sliders=[{
            "active": 0,
            "yanchor": "top",
            "xanchor": "left",
            "currentvalue": {
                "font": {"size": 20},
                "prefix": "Time: ",
                "visible": True,
                "xanchor": "right"
            },
            "transition": {"duration": 50, "easing": "cubic-in-out"},
            "pad": {"b": 10, "t": 50},
            "len": 0.9,
            "x": 0.1,
            "y": 0,
            "steps": [
                {
                    "args": [[str(i)], {
                        "frame": {"duration": 50, "redraw": True},
                        "mode": "immediate",
                        "transition": {"duration": 50}
                    }],
                    "label": f"{t:.2f} s",
                    "method": "animate"
                }
                for i, t in enumerate(time_history)
            ]
        }]
    )
    
    # Update axes
    fig.update_xaxes(title_text="Axial Position [m]", row=1, col=1)
    fig.update_yaxes(title_text="Radius [m]", row=1, col=1, scaleanchor="x", scaleratio=1)
    fig.update_xaxes(title_text="Axial Position [m]", row=2, col=1)
    fig.update_yaxes(title_text="Recession Rate [mm/s]", row=2, col=1)
    
    # Save if requested
    if save_path:
        fig.write_html(save_path)
    
    return fig

