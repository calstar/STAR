"""Comprehensive Design Optimization UI for Pintle Engine.

This module provides a user-friendly interface for:
1. Optimal injector sizing
2. Optimal chamber sizing
3. Stability margin optimization
4. Flight performance optimization
5. System constraint management

Goal: Build a pipeline that sizes optimal injector and chamber for required
stability margins and flight performance given system constraints.
"""

from __future__ import annotations

from typing import Dict, Any, Optional, Tuple, List
from datetime import datetime
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import streamlit as st
import copy

from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.runner import PintleEngineRunner
from engine.pipeline.chamber_optimizer import ChamberOptimizer
from engine.pipeline.comprehensive_geometry_sizing import (
    size_complete_geometry,
    plot_complete_geometry,
    select_optimal_geometry,
)
from engine.pipeline.system_diagnostics import SystemDiagnostics

# Import chamber geometry functions for proper calculations
from engine.core.chamber_geometry import (
    chamber_length_calc,
    chamber_volume_calc,
    contraction_ratio_calc,
    area_chamber_calc,
    chamber_geometry_calc,
    contraction_length_horizontal_calc,
)

# Import chamber geometry visualizer
from engine.pipeline.chamber_geometry_visualizer import (
    calculate_chamber_geometry_clear,
    plot_chamber_geometry_clear,
)

# =============================================================================
# MODULAR OPTIMIZATION LAYERS (refactored)
# These modules contain the extracted layer logic for better maintainability
# =============================================================================
from engine.optimizer import (
    # Helpers - used directly throughout this file
    generate_segmented_pressure_curve,
    segments_from_optimizer_vars,
    optimizer_vars_from_segments,
    # Layer functions
    create_layer1_apply_x_to_config,
    run_layer2_pressure,
    run_layer3_thermal_protection,
    run_layer4_flight_simulation,
    # Display functions
    plot_pressure_curves,
    plot_copv_pressure,
    plot_flight_trajectory,
    plot_optimization_convergence,
    plot_time_varying_results,
    # COPV and flight helpers
    calculate_copv_pressure_curve,
    run_flight_simulation,
    # Utilities
    extract_all_parameters,
    # Main optimizer
    run_full_engine_optimization_with_flight_sim,
)

# Import UI tab functions from views
from engine.optimizer.views import (
    _design_requirements_tab,
    _full_engine_optimization_tab,
    _layer1_tab,
    _layer2_tab,
    _layer3_tab,
    _layer4_tab,
)

# Alias for backward compatibility with internal function names
_calculate_copv_pressure_curve = calculate_copv_pressure_curve
_run_flight_simulation = run_flight_simulation
_extract_all_parameters = extract_all_parameters
_run_full_engine_optimization_with_flight_sim = run_full_engine_optimization_with_flight_sim


# =============================================================================
# HELPER FUNCTIONS - PLOTTING AND VISUALIZATION
# (Helper functions moved to optimization_layers/helpers.py)
# =============================================================================

def _plot_segmented_pressure_preview(
    pressure_config: Dict[str, Any],
    target_burn_time: float,
) -> None:
    """Plot preview of segmented pressure curves."""
    import streamlit as st
    
    lox_segments = pressure_config.get("lox_segments", [])
    fuel_segments = pressure_config.get("fuel_segments", [])
    
    if not lox_segments and not fuel_segments:
        st.warning("No pressure segments defined.")
        return
    
    # Generate curves
    n_points = 200
    
    if lox_segments:
        lox_time, lox_pressure = generate_segmented_pressure_curve(lox_segments, n_points)
    else:
        lox_time = np.linspace(0, target_burn_time, n_points)
        lox_pressure = np.full(n_points, pressure_config.get("lox_start_psi", 500))
    
    if fuel_segments:
        fuel_time, fuel_pressure = generate_segmented_pressure_curve(fuel_segments, n_points)
    else:
        fuel_time = np.linspace(0, target_burn_time, n_points)
        fuel_pressure = np.full(n_points, pressure_config.get("fuel_start_psi", 500))
    
    # Create plot
    fig = make_subplots(rows=1, cols=1)
    
    fig.add_trace(
        go.Scatter(
            x=lox_time, y=lox_pressure,
            mode='lines',
            name='LOX Tank',
            line=dict(color='blue', width=2),
        )
    )
    
    fig.add_trace(
        go.Scatter(
            x=fuel_time, y=fuel_pressure,
            mode='lines',
            name='Fuel Tank',
            line=dict(color='orange', width=2),
        )
    )
    
    # Add segment boundaries
    t_cumulative = 0.0
    for i, seg in enumerate(lox_segments):
        t_cumulative += seg["duration"]
        if i < len(lox_segments) - 1:
            fig.add_vline(
                x=t_cumulative, 
                line=dict(color="blue", width=1, dash="dash"),
                annotation_text=f"LOX S{i+1}",
                annotation_position="top left",
            )
    
    t_cumulative = 0.0
    for i, seg in enumerate(fuel_segments):
        t_cumulative += seg["duration"]
        if i < len(fuel_segments) - 1:
            fig.add_vline(
                x=t_cumulative, 
                line=dict(color="orange", width=1, dash="dot"),
                annotation_text=f"Fuel S{i+1}",
                annotation_position="bottom left",
            )
    
    fig.update_layout(
        title="Segmented Pressure Curves Preview",
        xaxis_title="Time [s]",
        yaxis_title="Tank Pressure [psi]",
        height=350,
        showlegend=True,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
    )
    
    st.plotly_chart(fig, use_container_width=True, key="optimization_history_plot")
    
    # Summary metrics
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("LOX Start", f"{lox_pressure[0]:.0f} psi")
    with col2:
        st.metric("LOX End", f"{lox_pressure[-1]:.0f} psi")
    with col3:
        st.metric("Fuel Start", f"{fuel_pressure[0]:.0f} psi")
    with col4:
        st.metric("Fuel End", f"{fuel_pressure[-1]:.0f} psi")


def _display_optimized_parameters(
    opt_results: Dict[str, Any],
    opt_config: PintleEngineConfig
) -> None:
    """Display optimized parameters from optimization results."""
    # Extract all parameters
    params = extract_all_parameters(opt_config)
    
    # Display in columns
    col1, col2, col3 = st.columns(3)
    
    with col1:
        st.markdown("#### 🔧 Injector Parameters")
        if "d_pintle_tip" in params:
            st.caption(f"Pintle Tip Ø: {params['d_pintle_tip'] * 1000:.2f} mm")
        if "h_gap" in params:
            st.caption(f"Gap Height: {params['h_gap'] * 1000:.2f} mm")
        if "n_orifices" in params:
            st.caption(f"Orifices: {int(params['n_orifices'])}")
        if "d_orifice" in params:
            st.caption(f"Orifice Ø: {params['d_orifice'] * 1000:.2f} mm")
        if "theta_orifice" in params:
            st.caption(f"Orifice Angle: {params['theta_orifice']:.1f}°")
    
    with col2:
        st.markdown("#### 🔥 Chamber Parameters")
        if "A_throat" in params:
            D_throat = np.sqrt(4 * params['A_throat'] / np.pi) * 1000
            st.caption(f"Throat Ø: {D_throat:.2f} mm")
        if "Lstar" in params:
            st.caption(f"L*: {params['Lstar'] * 1000:.1f} mm")
        if "chamber_diameter" in params:
            st.caption(f"Diameter: {params['chamber_diameter'] * 1000:.1f} mm")
        if "volume" in params:
            st.caption(f"Volume: {params['volume'] * 1e6:.1f} cm³")
    
    with col3:
        st.markdown("#### 🔺 Nozzle Parameters")
        if "expansion_ratio" in params:
            st.caption(f"Expansion Ratio: {params['expansion_ratio']:.2f}")
        if "A_exit" in params:
            D_exit = np.sqrt(4 * params['A_exit'] / np.pi) * 1000
            st.caption(f"Exit Ø: {D_exit:.1f} mm")
    
    # Display performance metrics if available
    performance = opt_results.get("performance", {})
    if performance:
        st.markdown("---")
        st.markdown("#### 📊 Performance Metrics")
        perf_col1, perf_col2, perf_col3, perf_col4 = st.columns(4)
        with perf_col1:
            if "thrust" in performance:
                st.metric("Thrust", f"{performance['thrust']:.0f} N")
        with perf_col2:
            if "Isp" in performance:
                st.metric("Isp", f"{performance['Isp']:.1f} s")
        with perf_col3:
            if "Pc" in performance:
                st.metric("Chamber Pressure", f"{performance['Pc']/1e6:.2f} MPa")
        with perf_col4:
            if "MR" in performance:
                st.metric("Mixture Ratio", f"{performance['MR']:.2f}")


# =============================================================================
# =============================================================================
# MAIN UI FUNCTIONS
# =============================================================================
# =============================================================================

def design_optimization_view(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner] = None) -> PintleEngineConfig:
    """
    Comprehensive design optimization interface.
    
    Provides guided workflow to:
    1. Set design requirements (thrust, altitude, stability)
    2. Optimize injector geometry
    3. Optimize chamber geometry
    4. Validate stability margins
    5. Validate flight performance
    6. Export optimized design
    """
    st.header("🚀 Engine Design Optimization")
    st.markdown("""
    **Goal:** Size optimal injector and chamber geometry to meet your:
    - **Stability margins** (chugging, acoustic, feed system)
    - **Flight performance** (altitude, payload capacity)
    - **System constraints** (weight, size, manufacturing)
    """)
    
    # Create tabs for different optimization stages
    tab_design, tab_full_engine, tab_layer1, tab_layer2, tab_layer3, tab_layer4, tab_layer5 = st.tabs([
        "📋 Design Requirements",
        "🚀 Full Engine Optimizer",
        "🔧 Layer 1: Static Optimization",
        "⏱️ Layer 2: Pressure Candidate",
        "🔥 Layer 3: Thermal Protection",
        "✈️ Layer 4: Flight Simulation",
        "📊 Layer 5: Flight Analysis"
    ])
    
    with tab_design:
        config_obj = _design_requirements_tab(config_obj)
    
    with tab_full_engine:
        config_obj = _full_engine_optimization_tab(config_obj, runner)
    
    with tab_layer1:
        config_obj = _layer1_tab(config_obj, runner)
    
    with tab_layer2:
        config_obj = _layer2_tab(config_obj, runner)
    
    with tab_layer3:
        config_obj = _layer3_tab(config_obj, runner)
    
    with tab_layer4:
        config_obj = _layer4_tab(config_obj, runner)
    
    with tab_layer5:
        config_obj = _layer5_tab(config_obj, runner)
    
    return config_obj

