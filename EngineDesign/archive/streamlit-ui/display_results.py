"""Display and plotting functions for optimization results.

This module contains functions for visualizing optimization results,
pressure curves, flight trajectories, and engine comparisons.
"""

from __future__ import annotations

from typing import Dict, Any, Optional
import numpy as np
import pandas as pd
import streamlit as st
from plotly.subplots import make_subplots
import plotly.graph_objects as go
import time
import uuid

from engine.pipeline.config_schemas import PintleEngineConfig

# CRITICAL FIX: Generate unique keys for Streamlit plots to avoid duplicate key errors
def _get_unique_key(base_name: str) -> str:
    """Generate a unique key for Streamlit elements."""
    return f"{base_name}_{uuid.uuid4().hex[:8]}"


def plot_pressure_curves(pressure_curves: Dict[str, np.ndarray]) -> None:
    """Plot tank pressure and performance curves."""
    time = pressure_curves.get("time", np.array([]))
    if len(time) == 0:
        st.warning("No pressure curve data available")
        return
    
    fig = make_subplots(
        rows=2, cols=2,
        subplot_titles=("Tank Pressures", "Thrust", "Chamber Pressure", "Isp"),
        vertical_spacing=0.15,
        horizontal_spacing=0.1,
    )
    
    P_tank_O_psi = pressure_curves.get("P_tank_O", np.array([])) / 6894.76
    P_tank_F_psi = pressure_curves.get("P_tank_F", np.array([])) / 6894.76
    fig.add_trace(go.Scatter(x=time, y=P_tank_O_psi, name="LOX Tank", line=dict(color="blue")), row=1, col=1)
    fig.add_trace(go.Scatter(x=time, y=P_tank_F_psi, name="Fuel Tank", line=dict(color="orange")), row=1, col=1)
    
    thrust = pressure_curves.get("thrust", np.array([]))
    fig.add_trace(go.Scatter(x=time, y=thrust, name="Thrust", line=dict(color="red")), row=1, col=2)
    
    Pc_MPa = pressure_curves.get("Pc", np.array([])) / 1e6
    fig.add_trace(go.Scatter(x=time, y=Pc_MPa, name="Pc", line=dict(color="green")), row=2, col=1)
    
    Isp = pressure_curves.get("Isp", np.array([]))
    fig.add_trace(go.Scatter(x=time, y=Isp, name="Isp", line=dict(color="purple")), row=2, col=2)
    
    fig.update_xaxes(title_text="Time [s]", row=2, col=1)
    fig.update_xaxes(title_text="Time [s]", row=2, col=2)
    fig.update_yaxes(title_text="Pressure [psi]", row=1, col=1)
    fig.update_yaxes(title_text="Thrust [N]", row=1, col=2)
    fig.update_yaxes(title_text="Pc [MPa]", row=2, col=1)
    fig.update_yaxes(title_text="Isp [s]", row=2, col=2)
    
    fig.update_layout(height=600, showlegend=True)
    st.plotly_chart(fig, use_container_width=True, key=_get_unique_key("pressure_curves_plot"))
    
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("Avg Thrust", f"{np.mean(thrust):.1f} N")
    with col2:
        st.metric("Avg Isp", f"{np.mean(Isp):.1f} s")
    with col3:
        st.metric("Avg Pc", f"{np.mean(Pc_MPa):.2f} MPa")
    with col4:
        st.metric("Burn Time", f"{time[-1]:.1f} s")


def plot_copv_pressure(copv_results: Dict[str, Any], pressure_curves: Dict[str, np.ndarray]) -> None:
    """Plot COPV pressure curve alongside tank pressures."""
    time = copv_results.get("time", np.array([]))
    copv_pressure_psi = copv_results.get("copv_pressure_psi", np.array([]))
    
    if len(time) == 0:
        st.warning("No COPV data available")
        return
    
    fig = make_subplots(specs=[[{"secondary_y": True}]])
    
    fig.add_trace(
        go.Scatter(x=time, y=copv_pressure_psi, name="COPV Pressure", line=dict(color="green", width=2)),
        secondary_y=False
    )
    
    P_tank_O_psi = pressure_curves.get("P_tank_O", np.array([])) / 6894.76
    P_tank_F_psi = pressure_curves.get("P_tank_F", np.array([])) / 6894.76
    fig.add_trace(
        go.Scatter(x=time, y=P_tank_O_psi, name="LOX Tank", line=dict(color="blue", dash="dot")),
        secondary_y=True
    )
    fig.add_trace(
        go.Scatter(x=time, y=P_tank_F_psi, name="Fuel Tank", line=dict(color="orange", dash="dot")),
        secondary_y=True
    )
    
    fig.update_xaxes(title_text="Time [s]")
    fig.update_yaxes(title_text="COPV Pressure [psi]", secondary_y=False)
    fig.update_yaxes(title_text="Tank Pressure [psi]", secondary_y=True)
    
    fig.update_layout(height=400, title="COPV and Tank Pressure Blowdown")
    st.plotly_chart(fig, use_container_width=True, key=_get_unique_key("copv_pressure_plot"))


def plot_flight_trajectory(flight_obj, requirements: Dict[str, Any]) -> None:
    """Plot flight trajectory from RocketPy flight object."""
    try:
        elevation = requirements.get("elevation", 0)
        
        altitude_data = flight_obj.z.get_source()
        velocity_data = flight_obj.vz.get_source()
        
        if altitude_data is not None:
            time = altitude_data[:, 0]
            altitude_agl = altitude_data[:, 1] - elevation
            
            fig = make_subplots(rows=1, cols=2, subplot_titles=("Altitude vs Time", "Velocity vs Time"))
            
            fig.add_trace(
                go.Scatter(x=time, y=altitude_agl, name="Altitude", line=dict(color="blue")),
                row=1, col=1
            )
            
            if velocity_data is not None:
                vz = velocity_data[:, 1]
                fig.add_trace(
                    go.Scatter(x=time, y=vz, name="Vertical Velocity", line=dict(color="red")),
                    row=1, col=2
                )
            
            fig.update_xaxes(title_text="Time [s]")
            fig.update_yaxes(title_text="Altitude AGL [m]", row=1, col=1)
            fig.update_yaxes(title_text="Velocity [m/s]", row=1, col=2)
            
            fig.update_layout(height=400, showlegend=True)
            st.plotly_chart(fig, use_container_width=True, key=_get_unique_key("flight_trajectory_plot"))
    except Exception as e:
        st.warning(f"Could not plot flight trajectory: {e}")


def plot_optimization_convergence(optimization_results: Dict[str, Any]) -> None:
    """
    Lightweight optimization summary.

    Historically this function rendered a large multi‑panel “Optimization Convergence”
    dashboard (8 plots + several metric sections). That view was visually noisy and is
    now removed to keep the Layer 1 UI focused on the objective/parameterization
    history plots.

    We keep a very small summary here so any existing callers continue to work
    without drawing the full dashboard.
    """
    history = optimization_results.get("iteration_history", [])

    if not history:
        st.info("No optimization history available.")
        return

    thrust_errors = [h.get("thrust_error", 0.0) * 100.0 for h in history]
    of_errors = [h.get("of_error", 0.0) * 100.0 for h in history]
    conv_info = optimization_results.get("convergence_info", {}) or {}

    st.markdown("### 📈 Optimization Summary")
    col1, col2, col3 = st.columns(3)
    with col1:
        st.metric("Total Iterations", f"{len(history)}")
    with col2:
        st.metric("Final Thrust Error", f"{thrust_errors[-1]:.1f}%" if thrust_errors else "N/A")
    with col3:
        st.metric("Final O/F Error", f"{of_errors[-1]:.1f}%" if of_errors else "N/A")

    # Optional simple converged flag
    status = "Yes" if conv_info.get("converged", False) else "No"
    st.caption(f"Converged: **{status}**")


def plot_layer1_parameterization_history(optimization_results: Dict[str, Any]) -> None:
    """Plot history of all Layer 1 parameterization variables (geometries and pressures)."""
    history = optimization_results.get("iteration_history", [])
    
    if not history:
        st.info("No optimization history available.")
        return
    
    st.markdown("### 📊 Parameterization Variables History")
    
    iterations = [h.get("iteration", i) for i, h in enumerate(history)]
    
    # Extract all parameterization variables
    # Try to get from individual fields first, fall back to extracting from "x" array if available
    def get_var(h, key, x_idx, default, scale=1.0):
        """Get variable from history entry, with fallback to x array."""
        if key in h and h[key] is not None:
            return h[key] * scale
        elif "x" in h and h["x"] is not None and len(h["x"]) > x_idx:
            return float(h["x"][x_idx]) * scale
        else:
            return default * scale
    
    A_throat = [get_var(h, "A_throat", 0, 0.001) * 1e6 for h in history]  # Convert to mm²
    Lstar = [get_var(h, "Lstar", 1, 1.0) for h in history]
    expansion_ratio = [get_var(h, "expansion_ratio", 2, 10.0) for h in history]
    D_chamber_outer = [get_var(h, "D_chamber_outer", 3, 0.1) * 1000 for h in history]  # Convert to mm
    D_chamber_inner = [h.get("D_chamber_inner", (h.get("x", [0.1])[3] if "x" in h and len(h.get("x", [])) > 3 else 0.1) - 0.0254) * 1000 for h in history]  # Convert to mm
    d_pintle_tip = [get_var(h, "d_pintle_tip", 4, 0.015) * 1000 for h in history]  # Convert to mm
    h_gap = [get_var(h, "h_gap", 5, 0.0006) * 1000 for h in history]  # Convert to mm
    n_orifices = [int(round(get_var(h, "n_orifices", 6, 16, scale=1.0))) for h in history]
    d_orifice = [get_var(h, "d_orifice", 7, 0.003) * 1000 for h in history]  # Convert to mm
    P_O_start_psi = [get_var(h, "P_O_start_psi", 10, 500) for h in history]
    P_F_start_psi = [get_var(h, "P_F_start_psi", 11, 600) for h in history]
    # Calculate exit diameter from A_throat and expansion_ratio: D_exit = sqrt(4 * A_throat * expansion_ratio / pi)
    A_throat_m2 = [get_var(h, "A_throat", 0, 0.001, scale=1.0) for h in history]  # Keep in m² for calculation
    D_exit = [np.sqrt(max(0, (4 * A_throat_m2[i] * expansion_ratio[i]) / np.pi)) * 1000 for i in range(len(history))]  # Convert to mm
    
    # Create subplots: 4 rows x 3 cols = 12 plots
    fig = make_subplots(
        rows=4, cols=3,
        subplot_titles=(
            "Throat Area [mm²]", "L* [m]", "Expansion Ratio",
            "Chamber Outer Diameter [mm]", "Chamber Inner Diameter [mm]", "Pintle Tip Diameter [mm]",
            "Gap Height [mm]", "Number of Orifices", "Orifice Diameter [mm]",
            "LOX Start Pressure [psi]", "Fuel Start Pressure [psi]", "Exit Diameter [mm]"
        ),
        vertical_spacing=0.12,
        horizontal_spacing=0.10,
    )
    
    # Row 1: Core geometry
    fig.add_trace(
        go.Scatter(x=iterations, y=A_throat, mode='lines+markers', name='A_throat', line=dict(color='blue'), showlegend=False),
        row=1, col=1
    )
    fig.add_trace(
        go.Scatter(x=iterations, y=Lstar, mode='lines+markers', name='L*', line=dict(color='green'), showlegend=False),
        row=1, col=2
    )
    fig.add_trace(
        go.Scatter(x=iterations, y=expansion_ratio, mode='lines+markers', name='Expansion Ratio', line=dict(color='orange'), showlegend=False),
        row=1, col=3
    )
    
    # Row 2: Chamber dimensions and pintle
    fig.add_trace(
        go.Scatter(x=iterations, y=D_chamber_outer, mode='lines+markers', name='D_outer', line=dict(color='red'), showlegend=False),
        row=2, col=1
    )
    fig.add_trace(
        go.Scatter(x=iterations, y=D_chamber_inner, mode='lines+markers', name='D_inner', line=dict(color='purple'), showlegend=False),
        row=2, col=2
    )
    fig.add_trace(
        go.Scatter(x=iterations, y=d_pintle_tip, mode='lines+markers', name='d_pintle', line=dict(color='cyan'), showlegend=False),
        row=2, col=3
    )
    
    # Row 3: Injector geometry
    fig.add_trace(
        go.Scatter(x=iterations, y=h_gap, mode='lines+markers', name='h_gap', line=dict(color='magenta'), showlegend=False),
        row=3, col=1
    )
    fig.add_trace(
        go.Scatter(x=iterations, y=n_orifices, mode='lines+markers', name='n_orifices', line=dict(color='brown'), showlegend=False),
        row=3, col=2
    )
    fig.add_trace(
        go.Scatter(x=iterations, y=d_orifice, mode='lines+markers', name='d_orifice', line=dict(color='pink'), showlegend=False),
        row=3, col=3
    )
    
    # Row 4: Pressures and exit diameter
    fig.add_trace(
        go.Scatter(x=iterations, y=P_O_start_psi, mode='lines+markers', name='P_LOX', line=dict(color='blue'), showlegend=False),
        row=4, col=1
    )
    fig.add_trace(
        go.Scatter(x=iterations, y=P_F_start_psi, mode='lines+markers', name='P_Fuel', line=dict(color='orange'), showlegend=False),
        row=4, col=2
    )
    fig.add_trace(
        go.Scatter(x=iterations, y=D_exit, mode='lines+markers', name='D_exit', line=dict(color='teal'), showlegend=False),
        row=4, col=3
    )
    
    # Update x-axis labels for bottom row
    fig.update_xaxes(title_text="Iteration", row=4, col=1)
    fig.update_xaxes(title_text="Iteration", row=4, col=2)
    fig.update_xaxes(title_text="Iteration", row=4, col=3)
    
    # Update layout
    fig.update_layout(height=1000, showlegend=False, title_text="Layer 1 Parameterization Variables Over Iterations")
    
    st.plotly_chart(fig, use_container_width=True, key=_get_unique_key("layer1_parameterization_history_plot"))


def plot_time_varying_results(time_varying_results: Dict[str, np.ndarray]) -> None:
    """Plot time-varying results (stability, recession, etc.)."""
    time = time_varying_results.get("time", np.array([]))
    if len(time) == 0:
        st.warning("No time-varying data available")
        return
    
    fig = make_subplots(
        rows=2, cols=2,
        subplot_titles=(
            "Stability Margin", "Chamber Recession",
            "Throat Recession", "Mass Flow Rates"
        ),
        vertical_spacing=0.15,
    )
    
    stability = time_varying_results.get("chugging_stability_margin", np.array([]))
    if len(stability) > 0:
        fig.add_trace(
            go.Scatter(x=time[:len(stability)], y=stability, name="Chugging Margin", line=dict(color="blue")),
            row=1, col=1
        )
    
    recession_chamber = time_varying_results.get("recession_chamber", np.array([]))
    if len(recession_chamber) > 0:
        fig.add_trace(
            go.Scatter(x=time[:len(recession_chamber)], y=recession_chamber * 1000, name="Chamber", line=dict(color="red")),
            row=1, col=2
        )
    
    recession_throat = time_varying_results.get("recession_throat", np.array([]))
    if len(recession_throat) > 0:
        fig.add_trace(
            go.Scatter(x=time[:len(recession_throat)], y=recession_throat * 1000, name="Throat", line=dict(color="orange")),
            row=2, col=1
        )
    
    mdot_O = time_varying_results.get("mdot_O", np.array([]))
    mdot_F = time_varying_results.get("mdot_F", np.array([]))
    if len(mdot_O) > 0:
        fig.add_trace(
            go.Scatter(x=time[:len(mdot_O)], y=mdot_O, name="LOX", line=dict(color="blue")),
            row=2, col=2
        )
    if len(mdot_F) > 0:
        fig.add_trace(
            go.Scatter(x=time[:len(mdot_F)], y=mdot_F, name="Fuel", line=dict(color="orange")),
            row=2, col=2
        )
    
    fig.update_xaxes(title_text="Time [s]", row=2, col=1)
    fig.update_xaxes(title_text="Time [s]", row=2, col=2)
    fig.update_yaxes(title_text="Stability Margin", row=1, col=1)
    fig.update_yaxes(title_text="Recession [mm]", row=1, col=2)
    fig.update_yaxes(title_text="Recession [mm]", row=2, col=1)
    fig.update_yaxes(title_text="Mass Flow [kg/s]", row=2, col=2)
    
    fig.update_layout(height=600, showlegend=True)
    st.plotly_chart(fig, use_container_width=True, key=_get_unique_key("time_varying_results_plot"))

