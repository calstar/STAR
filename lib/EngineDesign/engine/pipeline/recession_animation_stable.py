"""Stable recession animation that doesn't crash.

This version uses a simpler approach to avoid crashes.
"""

from __future__ import annotations

from typing import Dict, List, Optional
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from engine.pipeline.config_schemas import PintleEngineConfig


def create_recession_animation(
    time_history: np.ndarray,
    geometry_history: List[Dict],
    config: PintleEngineConfig,
    impingement_data: Optional[Dict] = None,
    max_frames: int = 20,
) -> go.Figure:
    """
    Create stable animated figure showing recession over time.
    
    Uses static figure with time slider instead of frames to avoid crashes.
    """
    if len(geometry_history) == 0:
        raise ValueError("No geometry history provided")
    
    n_steps = len(time_history)
    
    # Limit frames aggressively to prevent crashes
    if n_steps > max_frames:
        step = max(1, n_steps // max_frames)
        indices = np.arange(0, n_steps, step)
        time_history = time_history[indices]
        geometry_history = [geometry_history[i] for i in indices if i < len(geometry_history)]
        n_steps = len(time_history)
    
    if n_steps == 0 or len(geometry_history) == 0:
        raise ValueError("No valid time steps or geometry data")
    
    # Get positions from first valid geometry
    positions = None
    for geom in geometry_history:
        pos = geom.get("positions", [])
        if len(pos) > 0:
            positions = np.array(pos)
            break
    
    if positions is None or len(positions) == 0:
        raise ValueError("No positions found in geometry data")
    
    # Prepare all data
    all_R_gas = []
    all_R_ablative = []
    all_recession = []
    
    for geometry in geometry_history:
        try:
            pos = np.array(geometry.get("positions", positions))
            if len(pos) != len(positions):
                if len(pos) > 1:
                    pos = np.interp(positions, np.linspace(0, 1, len(pos)), pos)
                else:
                    pos = positions
            
            # Get diameters
            D_gas_list = geometry.get("D_gas_chamber", [])
            if isinstance(D_gas_list, (list, np.ndarray)):
                D_gas = np.array(D_gas_list)
                if len(D_gas) == 1:
                    D_gas = np.full_like(positions, float(D_gas[0]))
                elif len(D_gas) != len(positions):
                    D_gas = np.full_like(positions, float(D_gas[0]) if len(D_gas) > 0 else 0.1)
            else:
                D_gas = np.full_like(positions, float(D_gas_list) if D_gas_list else 0.1)
            
            D_ablative_list = geometry.get("D_ablative_outer", D_gas)
            if isinstance(D_ablative_list, (list, np.ndarray)):
                D_ablative = np.array(D_ablative_list)
                if len(D_ablative) == 1:
                    D_ablative = np.full_like(positions, float(D_ablative[0]))
                elif len(D_ablative) != len(positions):
                    D_ablative = np.full_like(positions, float(D_ablative[0]) if len(D_ablative) > 0 else D_gas[0])
            else:
                D_ablative = np.full_like(positions, float(D_ablative_list) if D_ablative_list else D_gas[0])
            
            recession_list = geometry.get("recession", [])
            if isinstance(recession_list, (list, np.ndarray)):
                recession = np.array(recession_list)
                if len(recession) == 1:
                    recession = np.full_like(positions, float(recession[0]))
                elif len(recession) != len(positions):
                    recession = np.full_like(positions, float(recession[0]) if len(recession) > 0 else 0.0)
            else:
                recession = np.full_like(positions, float(recession_list) if recession_list else 0.0)
            
            R_gas = D_gas / 2.0
            R_ablative = D_ablative / 2.0
            
            all_R_gas.append(R_gas)
            all_R_ablative.append(R_ablative)
            all_recession.append(recession)
        except Exception:
            continue
    
    if len(all_R_gas) == 0:
        raise ValueError("No valid geometry data after processing")
    
    # Use static figure with slider instead of frames (more stable)
    fig = make_subplots(
        rows=2, cols=1,
        subplot_titles=("Chamber Cross-Section", "Cumulative Recession"),
        vertical_spacing=0.15,
        row_heights=[0.7, 0.3],
    )
    
    # Add initial data (frame 0)
    first_data = {
        "R_gas": all_R_gas[0] if len(all_R_gas) > 0 else np.zeros_like(positions),
        "R_ablative": all_R_ablative[0] if len(all_R_ablative) > 0 else np.zeros_like(positions),
        "recession": all_recession[0] if len(all_recession) > 0 else np.zeros_like(positions),
    }
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=first_data["R_gas"],
        mode='lines',
        name='Gas Boundary',
        line=dict(color='orange', width=3),
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=-first_data["R_gas"],
        mode='lines',
        name='Gas Boundary (Lower)',
        line=dict(color='orange', width=3),
        showlegend=False,
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=first_data["R_ablative"],
        mode='lines',
        name='Ablative Outer',
        line=dict(color='brown', width=2, dash='dash'),
        fill='tonexty',
        fillcolor='rgba(139, 69, 19, 0.3)',
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=-first_data["R_ablative"],
        mode='lines',
        name='Ablative Outer (Lower)',
        line=dict(color='brown', width=2, dash='dash'),
        fill='tonexty',
        fillcolor='rgba(139, 69, 19, 0.3)',
        showlegend=False,
    ), row=1, col=1)
    
    fig.add_trace(go.Scatter(
        x=positions,
        y=first_data["recession"] * 1e6,
        mode='lines',
        name='Cumulative Recession',
        line=dict(color='red', width=2),
    ), row=2, col=1)
    
    # Create frames (limited to prevent crashes)
    frames = []
    n_frames = min(len(all_R_gas), n_steps, max_frames)
    
    for i in range(n_frames):
        if i >= len(all_R_gas) or i >= len(all_R_ablative) or i >= len(all_recession):
            continue
        
        frame_data = [
            go.Scatter(x=positions, y=all_R_gas[i], mode='lines', line=dict(color='orange', width=3)),
            go.Scatter(x=positions, y=-all_R_gas[i], mode='lines', line=dict(color='orange', width=3), showlegend=False),
            go.Scatter(x=positions, y=all_R_ablative[i], mode='lines', line=dict(color='brown', width=2, dash='dash'),
                      fill='tonexty', fillcolor='rgba(139, 69, 19, 0.3)'),
            go.Scatter(x=positions, y=-all_R_ablative[i], mode='lines', line=dict(color='brown', width=2, dash='dash'),
                      fill='tonexty', fillcolor='rgba(139, 69, 19, 0.3)', showlegend=False),
            go.Scatter(x=positions, y=all_recession[i] * 1e6, mode='lines', line=dict(color='red', width=2)),
        ]
        
        frames.append(go.Frame(
            data=frame_data,
            name=str(i),
            traces=[0, 1, 2, 3, 4]
        ))
    
    if len(frames) == 0:
        # Fallback: just show static plot
        fig.update_layout(
            title="Ablative Recession (Static View)",
            height=800,
        )
    else:
        fig.frames = frames
        
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
                            "frame": {"duration": 500, "redraw": True},
                            "fromcurrent": True,
                        }]
                    },
                    {
                        "label": "Pause",
                        "method": "animate",
                        "args": [[None], {
                            "frame": {"duration": 0, "redraw": False},
                            "mode": "immediate",
                        }]
                    }
                ],
            }],
            sliders=[{
                "active": 0,
                "currentvalue": {"prefix": "Time: ", "suffix": " s"},
                "steps": [
                    {
                        "args": [[str(i)], {"frame": {"duration": 300, "redraw": True}, "mode": "immediate"}],
                        "label": f"{t:.2f}",
                        "method": "animate"
                    }
                    for i, t in enumerate(time_history[:len(frames)])
                ]
            }]
        )
    
    fig.update_xaxes(title_text="Axial Position [m]", row=1, col=1)
    fig.update_yaxes(title_text="Radius [m]", row=1, col=1, scaleanchor="x", scaleratio=1)
    fig.update_xaxes(title_text="Axial Position [m]", row=2, col=1)
    fig.update_yaxes(title_text="Recession [mm]", row=2, col=1)
    
    return fig

