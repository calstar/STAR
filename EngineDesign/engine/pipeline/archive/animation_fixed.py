"""Fixed recession animation that actually works.

Simple, robust animation showing:
1. Recession vs time
2. Diameter evolution
"""

from __future__ import annotations

from typing import Optional
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots


def create_working_animation(
    time_history: np.ndarray,
    recession_history: np.ndarray,
    D_chamber_initial: float,
    D_throat_initial: float,
    L_chamber: float,
    max_frames: int = 15,
) -> go.Figure:
    """
    Create working animation.
    
    Parameters:
    -----------
    time_history : np.ndarray
        Time array [s]
    recession_history : np.ndarray
        Recession array [m]
    D_chamber_initial : float
        Initial chamber diameter [m]
    D_throat_initial : float
        Initial throat diameter [m]
    L_chamber : float
        Chamber length [m]
    max_frames : int
        Max frames
    
    Returns:
    --------
    fig : go.Figure
        Plotly figure
    """
    # Limit frames
    n_steps = len(time_history)
    if n_steps > max_frames:
        step = max(1, n_steps // max_frames)
        indices = np.arange(0, n_steps, step)
        time_history = time_history[indices]
        recession_history = recession_history[indices]
        n_steps = len(time_history)
    
    if n_steps == 0:
        raise ValueError("No time steps")
    
    # Create positions
    n_points = 50
    positions = np.linspace(0.0, L_chamber, n_points)
    throat_pos = L_chamber
    
    # Calculate diameters at each time
    all_D_chamber = []
    for recession in recession_history:
        D_chamber = D_chamber_initial + 2.0 * recession
        all_D_chamber.append(D_chamber)
    
    # Create figure
    fig = make_subplots(
        rows=2, cols=1,
        subplot_titles=("Recession vs Time", "Chamber Cross-Section"),
        vertical_spacing=0.15,
        row_heights=[0.3, 0.7],
    )
    
    # Initial traces
    D_chamber_0 = all_D_chamber[0]
    R_chamber_0 = D_chamber_0 / 2.0
    R_throat_0 = D_throat_initial / 2.0
    
    # Initial radius profile
    R_profile_0 = np.zeros(n_points)
    for i, x in enumerate(positions):
        if x < throat_pos * 0.8:
            R_profile_0[i] = R_chamber_0
        else:
            x_conv = (x - throat_pos * 0.8) / (throat_pos * 0.2 + 1e-10)
            x_conv = np.clip(x_conv, 0.0, 1.0)
            R_profile_0[i] = R_chamber_0 + (R_throat_0 - R_chamber_0) * x_conv
    
    # Add initial traces (start with first point only)
    fig.add_trace(go.Scatter(
        x=[time_history[0]],
        y=[recession_history[0] * 1000],
        mode='lines+markers',
        name='Recession',
        line=dict(color='red', width=2),
        marker=dict(size=5),
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=R_profile_0,
        mode='lines',
        name='Gas Boundary',
        line=dict(color='orange', width=3),
    ), row=2, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=-R_profile_0,
        mode='lines',
        name='Gas Boundary Lower',
        line=dict(color='orange', width=3),
        showlegend=False,
    ), row=2, col=1)
    
    # Create frames
    frames = []
    for i in range(n_steps):
        D_chamber_i = all_D_chamber[i]
        R_chamber_i = D_chamber_i / 2.0
        
        # Update profile
        R_profile_i = np.zeros(n_points)
        for j, x in enumerate(positions):
            if x < throat_pos * 0.8:
                R_profile_i[j] = R_chamber_i
            else:
                x_conv = (x - throat_pos * 0.8) / (throat_pos * 0.2 + 1e-10)
                x_conv = np.clip(x_conv, 0.0, 1.0)
                R_profile_i[j] = R_chamber_i + (R_throat_0 - R_chamber_i) * x_conv
        
        # Frame data: update all three traces
        frames.append(go.Frame(
            name=str(i),
            traces=[0, 1, 2],
            data=[
                go.Scatter(
                    x=time_history[:i+1], 
                    y=recession_history[:i+1] * 1000,
                    mode='lines+markers', 
                    line=dict(color='red', width=2),
                    marker=dict(size=5)
                ),
                go.Scatter(
                    x=positions, 
                    y=R_profile_i, 
                    mode='lines',
                    line=dict(color='orange', width=3)
                ),
                go.Scatter(
                    x=positions, 
                    y=-R_profile_i, 
                    mode='lines',
                    line=dict(color='orange', width=3)
                ),
            ]
        ))
    
    fig.frames = frames
    
    # Layout
    fig.update_layout(
        title="Recession Evolution",
        height=800,
        updatemenus=[{
            "type": "buttons",
            "showactive": False,
            "buttons": [
                {"label": "▶ Play", "method": "animate", "args": [None, {
                    "frame": {"duration": 500, "redraw": True},
                    "fromcurrent": True
                }]},
                {"label": "⏸ Pause", "method": "animate", "args": [[None], {
                    "frame": {"duration": 0, "redraw": False},
                    "mode": "immediate"
                }]}
            ]
        }],
        sliders=[{
            "active": 0,
            "currentvalue": {"prefix": "Time: ", "suffix": " s"},
            "steps": [{
                "args": [[str(i)], {
                    "frame": {"duration": 300, "redraw": True},
                    "mode": "immediate"
                }],
                "label": f"{time_history[i]:.2f}",
                "method": "animate"
            } for i in range(len(time_history))]
        }]
    )
    
    fig.update_xaxes(title_text="Time [s]", row=1, col=1)
    fig.update_yaxes(title_text="Recession [mm]", row=1, col=1)
    fig.update_xaxes(title_text="Axial Position [m]", row=2, col=1)
    fig.update_yaxes(title_text="Radius [m]", row=2, col=1)
    
    return fig

