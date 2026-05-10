"""Fixed animated visualization of ablative recession over time.

This version fixes the animation issues and prevents tab restarts.
"""

from __future__ import annotations

from typing import Dict, List, Optional
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.pipeline.localized_ablation import calculate_impingement_zones


def create_recession_animation(
    time_history: np.ndarray,
    geometry_history: List[Dict],
    config: PintleEngineConfig,
    impingement_data: Optional[Dict] = None,
    max_frames: int = 50,
) -> go.Figure:
    """
    Create animated plotly figure showing recession over time.
    
    Fixed version that:
    - Limits number of frames to prevent crashes
    - Handles missing data gracefully
    - Uses simpler animation structure
    """
    n_steps = len(time_history)
    
    # Limit frames to prevent crashes
    if n_steps > max_frames:
        step = n_steps // max_frames
        indices = np.arange(0, n_steps, step)
        time_history = time_history[indices]
        geometry_history = [geometry_history[i] for i in indices]
        n_steps = len(time_history)
    
    if n_steps == 0:
        raise ValueError("No time steps available for animation")
    
    # Get initial geometry
    initial_geometry = geometry_history[0]
    positions = np.array(initial_geometry.get("positions", []))
    
    if len(positions) == 0:
        raise ValueError("No positions in geometry data")
    
    # Create figure
    fig = make_subplots(
        rows=2, cols=1,
        subplot_titles=("Chamber Cross-Section", "Recession Rate"),
        vertical_spacing=0.15,
        row_heights=[0.7, 0.3],
    )
    
    # Prepare data arrays for all frames
    all_R_gas = []
    all_R_ablative = []
    all_recession_rates = []
    
    for geometry in geometry_history:
        try:
            positions = np.array(geometry.get("positions", []))
            if len(positions) == 0:
                continue
                
            # Handle D_gas_chamber - can be array or single value
            D_gas_raw = geometry.get("D_gas_chamber", [])
            if isinstance(D_gas_raw, (list, np.ndarray)):
                D_gas = np.array(D_gas_raw)
                if len(D_gas) != len(positions):
                    # If lengths don't match, use first value or interpolate
                    if len(D_gas) == 1:
                        D_gas = np.full_like(positions, float(D_gas[0]))
                    else:
                        D_gas = np.full_like(positions, float(D_gas[0]))  # Use first value
            else:
                D_gas = np.full_like(positions, float(D_gas_raw) if D_gas_raw else 0.1)
            
            # Handle D_ablative_outer
            D_ablative_raw = geometry.get("D_ablative_outer", D_gas)
            if isinstance(D_ablative_raw, (list, np.ndarray)):
                D_ablative = np.array(D_ablative_raw)
                if len(D_ablative) != len(positions):
                    if len(D_ablative) == 1:
                        D_ablative = np.full_like(positions, float(D_ablative[0]))
                    else:
                        D_ablative = np.full_like(positions, float(D_ablative[0]))
            else:
                D_ablative = np.full_like(positions, float(D_ablative_raw) if D_ablative_raw else D_gas[0])
            
            # Handle recession
            recession_raw = geometry.get("recession", [])
            if isinstance(recession_raw, (list, np.ndarray)):
                recession = np.array(recession_raw)
                if len(recession) != len(positions):
                    if len(recession) == 1:
                        recession = np.full_like(positions, float(recession[0]))
                    else:
                        recession = np.full_like(positions, float(recession[0]))
            else:
                recession = np.full_like(positions, float(recession_raw) if recession_raw else 0.0)
            
            R_gas = D_gas / 2.0
            R_ablative = D_ablative / 2.0
            
            # Calculate recession rate (derivative with respect to time, not position)
            # For now, just show cumulative recession
            recession_rate = np.zeros_like(positions)  # Will be calculated from time history if needed
            
            all_R_gas.append(R_gas)
            all_R_ablative.append(R_ablative)
            all_recession_rates.append(recession_rate)
        except Exception as e:
            # Skip this geometry if there's an error
            continue
    
    # Use first frame positions for all
    positions = np.array(geometry_history[0].get("positions", []))
    
    # Add initial traces (will be updated by animation)
    fig.add_trace(go.Scatter(
        x=positions,
        y=all_R_gas[0] if len(all_R_gas) > 0 else np.zeros_like(positions),
        mode='lines',
        name='Gas Boundary',
        line=dict(color='orange', width=3),
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=-all_R_gas[0] if len(all_R_gas) > 0 else np.zeros_like(positions),
        mode='lines',
        name='Gas Boundary (Lower)',
        line=dict(color='orange', width=3),
        showlegend=False,
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=all_R_ablative[0] if len(all_R_ablative) > 0 else np.zeros_like(positions),
        mode='lines',
        name='Ablative Outer',
        line=dict(color='brown', width=2, dash='dash'),
        fill='tonexty',
        fillcolor='rgba(139, 69, 19, 0.3)',
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=-all_R_ablative[0] if len(all_R_ablative) > 0 else np.zeros_like(positions),
        mode='lines',
        name='Ablative Outer (Lower)',
        line=dict(color='brown', width=2, dash='dash'),
        fill='tonexty',
        fillcolor='rgba(139, 69, 19, 0.3)',
        showlegend=False,
    ), row=1, col=1)
    
    # Recession rate trace
    fig.add_trace(go.Scatter(
        x=positions,
        y=all_recession_rates[0] if len(all_recession_rates) > 0 else np.zeros_like(positions),
        mode='lines',
        name='Recession Rate',
        line=dict(color='red', width=2),
    ), row=2, col=1)
    
    # Create frames
    frames = []
    for i in range(n_steps):
        if i >= len(all_R_gas) or i >= len(all_R_ablative) or i >= len(all_recession_rates):
            continue
            
        frame_data = [
            go.Scatter(x=positions, y=all_R_gas[i], mode='lines', line=dict(color='orange', width=3)),
            go.Scatter(x=positions, y=-all_R_gas[i], mode='lines', line=dict(color='orange', width=3), showlegend=False),
            go.Scatter(x=positions, y=all_R_ablative[i], mode='lines', line=dict(color='brown', width=2, dash='dash'),
                      fill='tonexty', fillcolor='rgba(139, 69, 19, 0.3)'),
            go.Scatter(x=positions, y=-all_R_ablative[i], mode='lines', line=dict(color='brown', width=2, dash='dash'),
                      fill='tonexty', fillcolor='rgba(139, 69, 19, 0.3)', showlegend=False),
            go.Scatter(x=positions, y=all_recession_rates[i], mode='lines', line=dict(color='red', width=2)),
        ]
        
        frames.append(go.Frame(
            data=frame_data,
            name=str(i),
            traces=[0, 1, 2, 3, 4]
        ))
    
    fig.frames = frames
    
    # Update layout
    fig.update_layout(
        title="Ablative Recession Over Time",
        height=800,
        updatemenus=[{
            "type": "buttons",
            "showactive": False,
            "buttons": [
                {
                    "label": "Play",
                    "method": "animate",
                    "args": [None, {
                        "frame": {"duration": 200, "redraw": True},
                        "fromcurrent": True,
                        "transition": {"duration": 100}
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
        }],
        sliders=[{
            "active": 0,
            "currentvalue": {
                "prefix": "Time: ",
                "suffix": " s",
            },
            "steps": [
                {
                    "args": [[str(i)], {
                        "frame": {"duration": 100, "redraw": True},
                        "mode": "immediate",
                        "transition": {"duration": 100}
                    }],
                    "label": f"{t:.2f}",
                    "method": "animate"
                }
                for i, t in enumerate(time_history[:len(frames)])
            ]
        }]
    )
    
    # Update axes
    fig.update_xaxes(title_text="Axial Position [m]", row=1, col=1)
    fig.update_yaxes(title_text="Radius [m]", row=1, col=1, scaleanchor="x", scaleratio=1)
    fig.update_xaxes(title_text="Axial Position [m]", row=2, col=1)
    fig.update_yaxes(title_text="Recession Rate [mm/s]", row=2, col=1)
    
    return fig

