"""Simple recession animation: just shows diameter evolution over time.

This is a much simpler approach:
1. Plot recession vs time
2. Show cross-section evolving where diameter changes over time
No complex multi-layer stuff - just diameter evolution.
"""

from __future__ import annotations

from typing import Dict, List, Optional
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from engine.pipeline.config_schemas import PintleEngineConfig


def create_simple_recession_animation(
    time_history: np.ndarray,
    recession_history: np.ndarray,
    D_chamber_initial: float,
    D_throat_initial: float,
    L_chamber: float,
    max_frames: int = 20,
) -> go.Figure:
    """
    Create simple animation showing diameter evolution over time.
    
    Shows:
    1. Recession vs time (plot)
    2. Cross-section evolving (diameter changes over time)
    
    Parameters:
    -----------
    time_history : np.ndarray
        Time array [s]
    recession_history : np.ndarray
        Recession array [m] (chamber recession)
    D_chamber_initial : float
        Initial chamber diameter [m]
    D_throat_initial : float
        Initial throat diameter [m]
    L_chamber : float
        Chamber length [m]
    max_frames : int
        Maximum number of frames
    
    Returns:
    --------
    fig : go.Figure
        Plotly figure with animation
    """
    n_steps = len(time_history)
    
    # Limit frames
    if n_steps > max_frames:
        step = max(1, n_steps // max_frames)
        indices = np.arange(0, n_steps, step)
        time_history = time_history[indices]
        recession_history = recession_history[indices]
        n_steps = len(time_history)
    
    if n_steps == 0:
        raise ValueError("No time steps")
    
    # Create positions along chamber
    n_points = 50
    positions = np.linspace(0.0, L_chamber, n_points)
    throat_pos = L_chamber
    
    # Calculate diameters at each time step
    all_D_chamber = []
    all_D_throat = []
    
    for i in range(n_steps):
        recession = recession_history[i]
        
        # Chamber diameter grows with recession
        D_chamber = D_chamber_initial + 2.0 * recession
        
        # Throat diameter (assume constant for now, or can change)
        D_throat = D_throat_initial  # Graphite keeps it constant
        
        all_D_chamber.append(D_chamber)
        all_D_throat.append(D_throat)
    
    # Create figure with subplots
    fig = make_subplots(
        rows=2, cols=1,
        subplot_titles=("Recession vs Time", "Chamber Cross-Section Evolution"),
        vertical_spacing=0.15,
        row_heights=[0.3, 0.7],
    )
    
    # Plot 1: Recession vs time
    fig.add_trace(go.Scatter(
        x=time_history,
        y=recession_history * 1000,  # Convert to mm
        mode='lines+markers',
        name='Chamber Recession',
        line=dict(color='red', width=2),
        marker=dict(size=5),
    ), row=1, col=1)
    
    # Plot 2: Cross-section evolution
    # Initial state
    D_chamber_0 = all_D_chamber[0]
    D_throat_0 = all_D_throat[0]
    
    # Create radius profile
    R_chamber = D_chamber_0 / 2.0
    R_throat = D_throat_0 / 2.0
    
    # Simple profile: constant chamber, converging to throat
    # Find throat position (where diameter is minimum)
    throat_idx = np.argmin([D_chamber_0, D_throat_0])
    throat_pos_actual = L_chamber  # Throat at end of chamber
    
    R_profile = np.zeros(n_points)
    for i, x in enumerate(positions):
        if x < throat_pos_actual * 0.8:  # Most of chamber
            R_profile[i] = R_chamber
        else:  # Converging section
            x_conv = (x - throat_pos_actual * 0.8) / (throat_pos_actual * 0.2 + 1e-10)
            x_conv = np.clip(x_conv, 0.0, 1.0)
            R_profile[i] = R_chamber + (R_throat - R_chamber) * x_conv
    
    # Initial cross-section (top)
    fig.add_trace(go.Scatter(
        x=positions,
        y=R_profile,
        mode='lines',
        name='Gas Boundary (t=0)',
        line=dict(color='orange', width=3),
    ), row=2, col=1)
    
    # Initial cross-section (bottom)
    fig.add_trace(go.Scatter(
        x=positions,
        y=-R_profile,
        mode='lines',
        name='Gas Boundary Lower',
        line=dict(color='orange', width=3),
        showlegend=False,
    ), row=2, col=1)
    
    # Create frames
    frames = []
    for i in range(n_steps):
        D_chamber_i = all_D_chamber[i]
        D_throat_i = all_D_throat[i]
        recession_i = recession_history[i]
        
        # Update radius profile
        R_chamber_i = D_chamber_i / 2.0
        R_throat_i = D_throat_i / 2.0
        
        # Throat position (same as initial)
        throat_pos_actual = L_chamber
        
        R_profile_i = np.zeros(n_points)
        for j, x in enumerate(positions):
            if x < throat_pos_actual * 0.8:
                R_profile_i[j] = R_chamber_i
            else:
                x_conv = (x - throat_pos_actual * 0.8) / (throat_pos_actual * 0.2 + 1e-10)
                x_conv = np.clip(x_conv, 0.0, 1.0)
                R_profile_i[j] = R_chamber_i + (R_throat_i - R_chamber_i) * x_conv
        
        # Create frame data - update existing traces
        frames.append(go.Frame(
            data=[
                go.Scatter(x=time_history[:i+1], y=recession_history[:i+1] * 1000, 
                          mode='lines+markers', line=dict(color='red', width=2), 
                          marker=dict(size=5), name='Chamber Recession'),
                go.Scatter(x=positions, y=R_profile_i, mode='lines',
                          line=dict(color='orange', width=3), name='Gas Boundary'),
                go.Scatter(x=positions, y=-R_profile_i, mode='lines',
                          line=dict(color='orange', width=3), showlegend=False),
            ],
            name=str(i),
            traces=[0, 1, 2]
        ))
    
    # Add frames
    fig.frames = frames
    
    # Update layout with animation controls
    fig.update_layout(
        title="Recession Evolution Over Time",
        height=800,
        updatemenus=[{
            "type": "buttons",
            "showactive": False,
            "x": 0.1,
            "y": 0,
            "buttons": [
                {
                    "label": "▶ Play",
                    "method": "animate",
                    "args": [None, {
                        "frame": {"duration": 500, "redraw": True},
                        "fromcurrent": True,
                        "transition": {"duration": 0}
                    }]
                },
                {
                    "label": "⏸ Pause",
                    "method": "animate",
                    "args": [[None], {
                        "frame": {"duration": 0, "redraw": False},
                        "mode": "immediate",
                        "transition": {"duration": 0}
                    }]
                }
            ],
        }],
        sliders=[{
            "active": 0,
            "currentvalue": {"prefix": "Time: ", "suffix": " s", "visible": True},
            "x": 0.1,
            "len": 0.9,
            "xanchor": "left",
            "y": 0,
            "yanchor": "top",
            "steps": [
                {
                    "args": [[str(i)], {
                        "frame": {"duration": 300, "redraw": True},
                        "mode": "immediate",
                        "transition": {"duration": 0}
                    }],
                    "label": f"{t:.2f}",
                    "method": "animate"
                }
                for i, t in enumerate(time_history)
            ]
        }]
    )
    
    fig.update_xaxes(title_text="Time [s]", row=1, col=1)
    fig.update_yaxes(title_text="Recession [mm]", row=1, col=1)
    fig.update_xaxes(title_text="Axial Position [m]", row=2, col=1)
    fig.update_yaxes(title_text="Radius [m]", row=2, col=1, scaleanchor="x", scaleratio=1)
    
    return fig

