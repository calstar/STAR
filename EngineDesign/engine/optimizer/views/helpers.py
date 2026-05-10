"""Helper Functions for UI Tabs.

This module contains helper functions used by the tab functions in tabs.py.
"""

from __future__ import annotations

from typing import Dict, Any, Optional
import numpy as np
import pandas as pd
import streamlit as st
import copy

from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.runner import PintleEngineRunner

# Import chamber geometry visualizer
from engine.pipeline.chamber_geometry_visualizer import (
    calculate_chamber_geometry_clear,
    plot_chamber_geometry_clear,
)

# Import from optimization_layers
from engine.optimizer import (
    extract_all_parameters,
    plot_optimization_convergence,
    plot_pressure_curves,
    plot_copv_pressure,
    plot_flight_trajectory,
)

def _display_current_engine_config(config_obj: PintleEngineConfig) -> None:
    """Display current engine configuration in a compact format."""
    col1, col2, col3 = st.columns(3)
    
    with col1:
        st.markdown("#### 🔧 Injector")
        if hasattr(config_obj, 'injector') and config_obj.injector.type == "pintle":
            geometry = config_obj.injector.geometry
            if hasattr(geometry, 'fuel'):
                st.caption(f"Pintle Tip: {geometry.fuel.d_pintle_tip*1000:.2f} mm")
                st.caption(f"Gap Height: {geometry.fuel.h_gap*1000:.2f} mm")
            if hasattr(geometry, 'lox'):
                st.caption(f"Orifices: {geometry.lox.n_orifices} × {geometry.lox.d_orifice*1000:.2f} mm")
                st.caption(f"Orifice Angle: {geometry.lox.theta_orifice:.1f}°")
    
    with col2:
        st.markdown("#### 🔥 Chamber")
        if hasattr(config_obj, 'chamber'):
            D_throat = np.sqrt(4 * config_obj.chamber.A_throat / np.pi) * 1000
            st.caption(f"Throat Ø: {D_throat:.2f} mm")
            st.caption(f"L*: {config_obj.chamber.Lstar*1000:.1f} mm")
            st.caption(f"Volume: {config_obj.chamber.volume*1e6:.1f} cm³")
    
    with col3:
        st.markdown("#### 🔺 Nozzle")
        if hasattr(config_obj, 'nozzle'):
            D_exit = np.sqrt(4 * config_obj.nozzle.A_exit / np.pi) * 1000
            st.caption(f"Exit Ø: {D_exit:.2f} mm")
            st.caption(f"Expansion Ratio: {config_obj.nozzle.expansion_ratio:.2f}")


# =============================================================================
# =============================================================================
# OPTIMIZATION FUNCTIONS
# =============================================================================
# =============================================================================



def _show_complete_optimization_results(
    config_before: PintleEngineConfig,
    config_after: PintleEngineConfig,
    optimization_results: Dict[str, Any],
    requirements: Dict[str, Any],
    target_burn_time: float,
) -> None:
    """Show complete optimization results with all visualizations."""
    
    # Tab layout for organized results
    result_tabs = st.tabs([
        "📊 Summary",
        "🔧 Injector & Chamber",
        "📈 Pressure Curves",
        "🛢️ COPV",
        "🚀 Flight Simulation",
    ])
    
    with result_tabs[0]:
        # Show optimization convergence plot
        plot_optimization_convergence(optimization_results)
        
        # Summary comparison
        _show_full_engine_comparison(config_before, config_after, optimization_results)
        
        # Validation checks
        _show_engine_validation_checks(config_after, optimization_results, requirements)
    
    with result_tabs[1]:
        # Injector parameters
        st.markdown("### 🔧 Optimized Pintle Injector")
        params = optimization_results.get("optimized_parameters", {})
        
        col1, col2, col3 = st.columns(3)
        with col1:
            st.metric("Pintle Tip Ø", f"{params.get('d_pintle_tip', 0) * 1000:.2f} mm")
            st.metric("Gap Height", f"{params.get('h_gap', 0) * 1000:.3f} mm")
        with col2:
            st.metric("Orifice Count", f"{int(params.get('n_orifices', 0))}")
            st.metric("Orifice Ø", f"{params.get('d_orifice', 0) * 1000:.2f} mm")
        with col3:
            st.metric("Orifice Angle", f"{params.get('theta_orifice', 90):.1f}°")
            st.metric("(Perpendicular)", "✅ Fixed at 90°")
        
        st.markdown("### 🔥 Optimized Chamber Geometry")
        col1, col2, col3 = st.columns(3)
        with col1:
            D_throat = np.sqrt(4 * params.get('A_throat', 0) / np.pi) * 1000
            st.metric("Throat Ø", f"{D_throat:.2f} mm")
            st.metric("Throat Area", f"{params.get('A_throat', 0) * 1e6:.2f} mm²")
        with col2:
            st.metric("L*", f"{params.get('Lstar', 0) * 1000:.1f} mm")
            st.metric("Chamber Ø", f"{params.get('chamber_diameter', 0) * 1000:.1f} mm")
        with col3:
            st.metric("Expansion Ratio", f"{params.get('expansion_ratio', 0):.2f}")
            D_exit = np.sqrt(4 * params.get('A_exit', 0) / np.pi) * 1000
            st.metric("Exit Ø", f"{D_exit:.2f} mm")
        
        # Chamber visualization
        st.markdown("### 📐 Chamber Geometry Visualization")
        try:
            _display_chamber_geometry_plot(config_after, optimization_results)
        except Exception as e:
            st.warning(f"Could not generate chamber visualization: {e}")
    
    with result_tabs[2]:
        # Pressure curves
        st.markdown("### 📈 Tank Pressure Curves (200 points)")
        pressure_curves = optimization_results.get("pressure_curves", {})
        
        if pressure_curves:
            plot_pressure_curves(pressure_curves)
        else:
            st.info("Pressure curves not available.")
    
    with result_tabs[3]:
        # COPV results
        st.markdown("### 🛢️ COPV Pressure Curve")
        copv_results = optimization_results.get("copv_results", {})
        
        if copv_results:
            col1, col2, col3, col4 = st.columns(4)
            with col1:
                st.metric("Initial Pressure", f"{copv_results.get('initial_pressure_Pa', 0) / 6894.76:.0f} psi")
            with col2:
                st.metric("Initial N₂ Mass", f"{copv_results.get('initial_mass_kg', 0):.3f} kg")
            with col3:
                st.metric("Total Delivered", f"{copv_results.get('total_delivered_kg', 0):.3f} kg")
            with col4:
                st.metric("Min Margin", f"{copv_results.get('min_margin_psi', 0):.1f} psi")
            
            st.caption("*Calculated with T₀ = T_propellant = 260 K*")
            
            plot_copv_pressure(copv_results, pressure_curves)
        else:
            st.info("COPV results not available.")
    
    with result_tabs[4]:
        # Flight simulation results
        st.markdown("### 🚀 Flight Simulation Results")
        flight_result = optimization_results.get("flight_sim_result", {})
        
        if flight_result.get("success", False):
            target_apogee = requirements.get("target_apogee", 3048.0)
            apogee = flight_result.get("apogee", 0)
            apogee_error = abs(apogee - target_apogee) / target_apogee * 100 if target_apogee > 0 else 100.0
            
            col1, col2, col3 = st.columns(3)
            with col1:
                st.metric("Apogee AGL", f"{apogee:.0f} m", delta=f"Target: {target_apogee:.0f} m")
            with col2:
                st.metric("Max Velocity", f"{flight_result.get('max_velocity', 0):.1f} m/s")
            with col3:
                if apogee_error < 10:
                    st.metric("Apogee Error", f"{apogee_error:.1f}%", delta="✅ Within 10%")
                else:
                    st.metric("Apogee Error", f"{apogee_error:.1f}%", delta="⚠️ > 10%")
            
            # Plot flight trajectory if available
            flight_obj = flight_result.get("flight_obj")
            if flight_obj:
                try:
                    plot_flight_trajectory(flight_obj, requirements)
                except Exception as e:
                    st.warning(f"Could not plot trajectory: {e}")
        else:
            error_msg = flight_result.get("error", "Flight simulation was not run (candidate did not meet thresholds)")
            st.warning(f"⚠️ {error_msg}")
            
            # Show detailed failure reasons from final_performance
            final_perf = optimization_results.get("final_performance", {})
            failure_reasons = final_perf.get("failure_reasons", [])
            if failure_reasons:
                st.error("**Why flight sim was skipped:**")
                for reason in failure_reasons:
                    st.write(f"  • {reason}")
            else:
                # Show actual values vs thresholds
                thrust_err = final_perf.get("initial_thrust_error", 0) * 100
                of_err = final_perf.get("initial_MR_error", 0) * 100
                stability = final_perf.get("initial_stability", 0)
                st.info(f"Thrust error: {thrust_err:.1f}% | O/F error: {of_err:.1f}% | Stability margin: {stability:.2f}")
            
            st.info("Flight sim runs when: thrust error < 15%, O/F error < 20%, stability ≥ 50% of target")




def _display_chamber_geometry_plot(config: PintleEngineConfig, optimization_results: Dict[str, Any]) -> None:
    """Display chamber geometry visualization using the same approach as chamber design tab.
    
    Shows multi-layer structure: Gas → Ablative (Chamber) → Graphite (Throat) → Stainless Steel
    """
    try:
        # Get chamber parameters from config
        A_throat = getattr(config.chamber, 'A_throat', 1e-4)
        D_throat = np.sqrt(4 * A_throat / np.pi)
        D_chamber = getattr(config.chamber, 'chamber_inner_diameter', 0.08)
        V_chamber = getattr(config.chamber, 'volume', 0.001)
        L_chamber = getattr(config.chamber, 'length', 0.2)
        Lstar = getattr(config.chamber, 'Lstar', 1.0)
        
        # Get nozzle parameters
        L_nozzle = getattr(config.nozzle, 'length', 0.1) if hasattr(config, 'nozzle') else 0.1
        expansion_ratio = getattr(config.nozzle, 'expansion_ratio', 10.0) if hasattr(config, 'nozzle') else 10.0
        
        # Get ablative and graphite configs (same as chamber design tab)
        ablative_cfg = config.ablative_cooling if hasattr(config, 'ablative_cooling') else None
        graphite_cfg = config.graphite_insert if hasattr(config, 'graphite_insert') else None
        
        # Validate inputs
        if V_chamber <= 0 or A_throat <= 0 or L_chamber <= 0:
            st.warning(f"Invalid geometry inputs: V={V_chamber:.6f}, A_throat={A_throat:.6f}, L={L_chamber:.6f}")
            return
        
        # Calculate actual diameters with safe validation
        if D_chamber > 0:
            D_chamber_actual = D_chamber
        elif V_chamber > 0 and L_chamber > 0:
            D_chamber_actual = np.sqrt(4.0 * V_chamber / (np.pi * L_chamber))
        else:
            D_chamber_actual = 0.1  # Default 100mm
        
        if D_throat > 0:
            D_throat_actual = D_throat
        elif A_throat > 0:
            D_throat_actual = np.sqrt(4.0 * A_throat / np.pi)
        else:
            D_throat_actual = 0.015  # Default 15mm
        
        # Use the same clear geometry visualizer as the chamber design tab
        geometry_clear = calculate_chamber_geometry_clear(
            L_chamber=L_chamber,
            D_chamber=D_chamber_actual,
            D_throat=D_throat_actual,
            L_nozzle=L_nozzle,
            expansion_ratio=expansion_ratio,
            ablative_config=ablative_cfg,
            graphite_config=graphite_cfg,
            recession_chamber=0.0,  # No recession for fresh design
            recession_graphite=0.0,
            n_points=200,
        )
        
        # Create the same plot as chamber design tab (1:1 aspect ratio is handled in base function)
        fig_contour = plot_chamber_geometry_clear(geometry_clear, config)
        st.plotly_chart(fig_contour, use_container_width=True, key="chamber_contour_plot")
        
        # Display geometry summary
        st.markdown("#### Chamber Geometry Summary")
        
        # Calculate derived values
        A_chamber = np.pi * (D_chamber_actual / 2) ** 2
        contraction_ratio = A_chamber / A_throat if A_throat > 0 else 1.0
        A_exit = A_throat * expansion_ratio
        D_exit = np.sqrt(4 * A_exit / np.pi)
        
        # Get performance for Cf calculation
        performance = optimization_results.get("performance", {})
        Pc = performance.get("Pc", 2e6)
        thrust = performance.get("F", 5000)
        Cf = thrust / (Pc * A_throat) if Pc * A_throat > 0 else 1.5
        
        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("Total Chamber Length", f"{L_chamber * 39.37:.2f} in ({L_chamber * 1000:.1f} mm)")
        with col2:
            st.metric("Chamber Diameter", f"{D_chamber_actual * 39.37:.2f} in ({D_chamber_actual * 1000:.1f} mm)")
        with col3:
            st.metric("Throat Diameter", f"{D_throat_actual * 39.37:.3f} in ({D_throat_actual * 1000:.2f} mm)")
        with col4:
            st.metric("Exit Diameter", f"{D_exit * 39.37:.2f} in ({D_exit * 1000:.1f} mm)")
        
        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("L* (Characteristic Length)", f"{Lstar:.3f} m ({Lstar * 39.37:.2f} in)")
        with col2:
            st.metric("Contraction Ratio", f"{contraction_ratio:.2f}")
        with col3:
            st.metric("Expansion Ratio", f"{expansion_ratio:.2f}")
        with col4:
            st.metric("Force Coefficient (Cf)", f"{Cf:.3f}")
        
        col1, col2, col3 = st.columns(3)
        with col1:
            st.metric("Chamber Volume", f"{V_chamber * 1e6:.1f} cm³ ({V_chamber * 61023.7:.1f} in³)")
        with col2:
            if ablative_cfg and ablative_cfg.enabled:
                st.metric("Ablative Thickness", f"{ablative_cfg.initial_thickness * 1000:.1f} mm")
            else:
                st.metric("Ablative", "Not configured")
        with col3:
            if graphite_cfg and graphite_cfg.enabled:
                st.metric("Graphite Thickness", f"{graphite_cfg.initial_thickness * 1000:.1f} mm")
            else:
                st.metric("Graphite", "Not configured")
        
        # DXF Download - exactly like chamber design tab
        st.markdown("---")
        st.markdown("#### Download Chamber Contour")
        
        try:
            import tempfile
            import os
            
            # Generate DXF to a temporary file using chamber_geometry_calc
            with tempfile.NamedTemporaryFile(mode='w', suffix='.dxf', delete=False) as tmp_file:
                tmp_dxf_path = tmp_file.name
            
            # Generate DXF using chamber_geometry_calc
            _, _, _ = chamber_geometry_calc(
                pc_design=Pc,
                thrust_design=thrust,
                force_coeffcient=Cf,
                diameter_inner=D_chamber_actual,
                diameter_exit=D_exit,
                l_star=Lstar,
                do_plot=False,
                steps=200,
                export_dxf=tmp_dxf_path
            )
            
            # Read the DXF file
            with open(tmp_dxf_path, 'rb') as f:
                dxf_bytes = f.read()
            
            # Clean up temporary file
            os.unlink(tmp_dxf_path)
            
            # Download button
            st.download_button(
                label="📐 Download Chamber Contour (DXF)",
                data=dxf_bytes,
                file_name="optimized_chamber_contour.dxf",
                mime="application/dxf",
                key="full_engine_opt_dxf_download"
            )
            st.caption("DXF file includes: cylindrical section, 45° contraction cone, and RAO nozzle contour")
            
        except ImportError:
            st.warning("ezdxf library is required for DXF export. Install it with: `pip install ezdxf`")
        except Exception as e:
            st.warning(f"Could not generate DXF: {e}")
            
    except Exception as e:
        st.warning(f"Could not generate chamber geometry: {e}")
        import traceback
        st.code(traceback.format_exc())




def _show_full_engine_comparison(
    config_before: PintleEngineConfig,
    config_after: PintleEngineConfig,
    optimization_results: Dict[str, Any]
) -> None:
    """Show before/after comparison for full engine optimization."""
    st.markdown("### 📈 Before vs After Comparison")
    
    # Extract all parameters
    params_before = extract_all_parameters(config_before)
    params_after = extract_all_parameters(config_after)
    
    # Create comparison table
    comparison_data = []
    
    # Injector comparisons
    if "d_pintle_tip" in params_before and "d_pintle_tip" in params_after:
        comparison_data.append({
            "Component": "Injector",
            "Parameter": "Pintle Tip Ø [mm]",
            "Before": f"{params_before['d_pintle_tip'] * 1000:.2f}",
            "After": f"{params_after['d_pintle_tip'] * 1000:.2f}",
            "Change": f"{((params_after['d_pintle_tip'] / params_before['d_pintle_tip'] - 1) * 100):+.1f}%"
        })
    
    if "h_gap" in params_before and "h_gap" in params_after:
        comparison_data.append({
            "Component": "Injector",
            "Parameter": "Gap Height [mm]",
            "Before": f"{params_before['h_gap'] * 1000:.2f}",
            "After": f"{params_after['h_gap'] * 1000:.2f}",
            "Change": f"{((params_after['h_gap'] / params_before['h_gap'] - 1) * 100):+.1f}%"
        })
    
    if "n_orifices" in params_before and "n_orifices" in params_after:
        comparison_data.append({
            "Component": "Injector",
            "Parameter": "Orifice Count",
            "Before": f"{int(params_before['n_orifices'])}",
            "After": f"{int(params_after['n_orifices'])}",
            "Change": f"{int(params_after['n_orifices'] - params_before['n_orifices']):+d}"
        })
    
    if "d_orifice" in params_before and "d_orifice" in params_after:
        comparison_data.append({
            "Component": "Injector",
            "Parameter": "Orifice Ø [mm]",
            "Before": f"{params_before['d_orifice'] * 1000:.2f}",
            "After": f"{params_after['d_orifice'] * 1000:.2f}",
            "Change": f"{((params_after['d_orifice'] / params_before['d_orifice'] - 1) * 100):+.1f}%"
        })
    
    if "theta_orifice" in params_before and "theta_orifice" in params_after:
        comparison_data.append({
            "Component": "Injector",
            "Parameter": "Orifice Angle [°]",
            "Before": f"{params_before['theta_orifice']:.1f}",
            "After": f"{params_after['theta_orifice']:.1f}",
            "Change": f"Fixed at 90°"
        })
    
    # Chamber comparisons
    D_throat_before = np.sqrt(4 * params_before.get('A_throat', 0) / np.pi) * 1000
    D_throat_after = np.sqrt(4 * params_after.get('A_throat', 0) / np.pi) * 1000
    comparison_data.append({
        "Component": "Chamber",
        "Parameter": "Throat Ø [mm]",
        "Before": f"{D_throat_before:.2f}",
        "After": f"{D_throat_after:.2f}",
        "Change": f"{((D_throat_after / D_throat_before - 1) * 100):+.1f}%"
    })
    
    comparison_data.append({
        "Component": "Chamber",
        "Parameter": "L* [m]",
        "Before": f"{params_before.get('Lstar', 0):.3f}",
        "After": f"{params_after.get('Lstar', 0):.3f}",
        "Change": f"{((params_after.get('Lstar', 1) / params_before.get('Lstar', 1) - 1) * 100):+.1f}%"
    })
    
    comparison_data.append({
        "Component": "Chamber",
        "Parameter": "Diameter [mm]",
        "Before": f"{params_before.get('chamber_diameter', 0) * 1000:.1f}",
        "After": f"{params_after.get('chamber_diameter', 0) * 1000:.1f}",
        "Change": f"{((params_after.get('chamber_diameter', 1) / params_before.get('chamber_diameter', 1) - 1) * 100):+.1f}%"
    })
    
    # Nozzle comparisons
    comparison_data.append({
        "Component": "Nozzle",
        "Parameter": "Expansion Ratio",
        "Before": f"{params_before.get('expansion_ratio', 0):.2f}",
        "After": f"{params_after.get('expansion_ratio', 0):.2f}",
        "Change": f"{((params_after.get('expansion_ratio', 1) / params_before.get('expansion_ratio', 1) - 1) * 100):+.1f}%"
    })
    
    # Performance comparisons
    performance = optimization_results.get("performance", {})
    if performance:
        comparison_data.append({
            "Component": "Performance",
            "Parameter": "Thrust [N]",
            "Before": "-",
            "After": f"{performance.get('F', 0):.1f}",
            "Change": "Optimized"
        })
        comparison_data.append({
            "Component": "Performance",
            "Parameter": "Isp [s]",
            "Before": "-",
            "After": f"{performance.get('Isp', 0):.1f}",
            "Change": "Optimized"
        })
        comparison_data.append({
            "Component": "Performance",
            "Parameter": "Chamber Pressure [MPa]",
            "Before": "-",
            "After": f"{performance.get('Pc', 0) / 1e6:.2f}",
            "Change": "Optimized"
        })
        comparison_data.append({
            "Component": "Performance",
            "Parameter": "Mixture Ratio",
            "Before": "-",
            "After": f"{performance.get('MR', 0):.3f}",
            "Change": "Optimized"
        })
        
        # Stability
        stability = performance.get("stability_results", {})
        chugging = stability.get("chugging", {})
        if chugging:
            comparison_data.append({
                "Component": "Stability",
                "Parameter": "Chugging Margin",
                "Before": "-",
                "After": f"{chugging.get('stability_margin', 0):.3f}",
                "Change": "✅" if chugging.get('stability_margin', 0) > 1.0 else "⚠️"
            })
    
    df_comparison = pd.DataFrame(comparison_data)
    st.dataframe(df_comparison, use_container_width=True, hide_index=True)




def _show_engine_validation_checks(
    config: PintleEngineConfig,
    optimization_results: Dict[str, Any],
    requirements: Dict[str, Any]
) -> None:
    """Show validation checks for the optimized engine."""
    st.markdown("### ✅ Engine Validation Checks")
    
    performance = optimization_results.get("performance", {})
    validation = optimization_results.get("validation", {})
    
    checks = []
    
    # Thrust check
    target_thrust = requirements.get("target_thrust", 7000.0)
    actual_thrust = performance.get("F", 0)
    thrust_error = abs(actual_thrust - target_thrust) / target_thrust * 100 if target_thrust > 0 else 100.0
    checks.append({
        "Check": "Target Thrust",
        "Target": f"{target_thrust:.0f} N",
        "Actual": f"{actual_thrust:.1f} N",
        "Error": f"{thrust_error:.1f}%",
        "Status": "✅ Pass" if thrust_error < 10 else "⚠️ Check"
    })
    
    # O/F ratio check
    target_of = requirements.get("optimal_of_ratio", 2.3)
    actual_of = performance.get("MR", 0)
    of_error = abs(actual_of - target_of) / target_of * 100 if target_of > 0 else 100.0
    checks.append({
        "Check": "O/F Ratio",
        "Target": f"{target_of:.2f}",
        "Actual": f"{actual_of:.3f}",
        "Error": f"{of_error:.1f}%",
        "Status": "✅ Pass" if of_error < 15 else "⚠️ Check"
    })
    
    # L* check
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    cg = ensure_chamber_geometry(config)
    min_lstar = requirements.get("min_Lstar", 0.95)
    max_lstar = requirements.get("max_Lstar", 1.27)
    actual_lstar = cg.Lstar
    lstar_ok = min_lstar <= actual_lstar <= max_lstar
    checks.append({
        "Check": "L* Constraint",
        "Target": f"{min_lstar:.1f} - {max_lstar:.1f} m",
        "Actual": f"{actual_lstar:.3f} m",
        "Error": "-",
        "Status": "✅ Pass" if lstar_ok else "⚠️ Out of range"
    })
    
    # Stability checks
    stability = performance.get("stability_results", {})
    min_stability_margin = requirements.get("min_stability_margin", 1.2)
    
    chugging = stability.get("chugging", {})
    chugging_margin = chugging.get("stability_margin", 0)
    checks.append({
        "Check": "Chugging Stability",
        "Target": f"> {min_stability_margin:.2f}",
        "Actual": f"{chugging_margin:.3f}",
        "Error": "-",
        "Status": "✅ Pass" if chugging_margin >= min_stability_margin else "⚠️ Unstable"
    })
    
    acoustic = stability.get("acoustic", {})
    acoustic_margin = acoustic.get("stability_margin", 0)
    checks.append({
        "Check": "Acoustic Stability",
        "Target": f"> {min_stability_margin:.2f}",
        "Actual": f"{acoustic_margin:.3f}",
        "Error": "-",
        "Status": "✅ Pass" if acoustic_margin >= min_stability_margin else "⚠️ Unstable"
    })
    
    feed = stability.get("feed_system", {})
    feed_margin = feed.get("stability_margin", 0)
    checks.append({
        "Check": "Feed System Stability",
        "Target": f"> {min_stability_margin:.2f}",
        "Actual": f"{feed_margin:.3f}",
        "Error": "-",
        "Status": "✅ Pass" if feed_margin >= min_stability_margin else "⚠️ Unstable"
    })
    
    # Geometry checks
    max_chamber_od = requirements.get("max_chamber_outer_diameter", 0.15)
    actual_chamber_d = cg.chamber_diameter
    checks.append({
        "Check": "Chamber Diameter",
        "Target": f"< {max_chamber_od*1000:.0f} mm",
        "Actual": f"{actual_chamber_d*1000:.1f} mm",
        "Error": "-",
        "Status": "✅ Pass" if actual_chamber_d <= max_chamber_od else "⚠️ Too large"
    })
    
    # Orifice angle check
    orifice_angle = 90.0  # Should be fixed at 90
    if hasattr(config, 'injector') and config.injector.type == "pintle":
        if hasattr(config.injector.geometry, 'lox'):
            orifice_angle = config.injector.geometry.lox.theta_orifice
    checks.append({
        "Check": "Orifice Angle",
        "Target": "90° (perpendicular)",
        "Actual": f"{orifice_angle:.1f}°",
        "Error": "-",
        "Status": "✅ Pass" if abs(orifice_angle - 90.0) < 0.1 else "⚠️ Not perpendicular"
    })
    
    df_checks = pd.DataFrame(checks)
    st.dataframe(df_checks, use_container_width=True, hide_index=True)
    
    # Summary
    all_pass = all("Pass" in c["Status"] for c in checks)
    if all_pass:
        st.success("🎉 All validation checks passed! Engine design is valid.")
    else:
        failed = [c["Check"] for c in checks if "Pass" not in c["Status"]]
        st.warning(f"⚠️ Some checks need attention: {', '.join(failed)}")




def _optimize_injector(
    config_obj: PintleEngineConfig,
    runner: PintleEngineRunner,
    target_thrust: float,
    target_MR: float,
    optimize_pintle: bool,
    optimize_orifices: bool,
    optimize_spray: bool,
) -> Tuple[PintleEngineConfig, Dict[str, Any]]:
    """Optimize injector geometry using comprehensive optimizer."""
    from engine.pipeline.comprehensive_optimizer import ComprehensivePintleOptimizer
    
    optimizer = ComprehensivePintleOptimizer(config_obj)
    
    # Run optimization
    results = optimizer.optimize_pintle_geometry(
        target_thrust=target_thrust,
        target_mr=target_MR,
        P_tank_O=3.0e6,  # Default
        P_tank_F=3.0e6,  # Default
    )
    
    # Extract optimized parameters for display
    optimized_config = results["optimized_config"]
    optimized_params = {}
    
    if hasattr(optimized_config, 'injector') and optimized_config.injector.type == "pintle":
        geometry = optimized_config.injector.geometry
        if hasattr(geometry, 'fuel'):
            optimized_params["d_pintle_tip"] = geometry.fuel.d_pintle_tip
            optimized_params["h_gap"] = geometry.fuel.h_gap
            optimized_params["d_reservoir_inner"] = geometry.fuel.d_reservoir_inner if hasattr(geometry.fuel, 'd_reservoir_inner') else None
        if hasattr(geometry, 'lox'):
            optimized_params["n_orifices"] = geometry.lox.n_orifices
            optimized_params["d_orifice"] = geometry.lox.d_orifice
            optimized_params["theta_orifice"] = geometry.lox.theta_orifice
    
    # Add optimized parameters to results
    results["optimized_parameters"] = optimized_params
    
    return optimized_config, results




def _show_injector_comparison(
    config_before: PintleEngineConfig,
    config_after: PintleEngineConfig,
    optimization_results: Dict[str, Any]
) -> None:
    """Show before/after comparison for injector optimization."""
    st.markdown("### 📈 Before vs After Comparison")
    
    # Extract parameters
    def get_injector_params(config):
        params = {}
        if hasattr(config, 'injector') and config.injector.type == "pintle":
            geometry = config.injector.geometry
            if hasattr(geometry, 'fuel'):
                params["d_pintle_tip"] = geometry.fuel.d_pintle_tip
                params["h_gap"] = geometry.fuel.h_gap
                params["d_reservoir_inner"] = geometry.fuel.d_reservoir_inner if hasattr(geometry.fuel, 'd_reservoir_inner') else 0.0
            if hasattr(geometry, 'lox'):
                params["n_orifices"] = geometry.lox.n_orifices
                params["d_orifice"] = geometry.lox.d_orifice
                params["theta_orifice"] = geometry.lox.theta_orifice
        return params
    
    params_before = get_injector_params(config_before)
    params_after = get_injector_params(config_after)
    
    # Create comparison table
    comparison_data = []
    
    if "d_pintle_tip" in params_before and "d_pintle_tip" in params_after:
        comparison_data.append({
            "Parameter": "Pintle Tip Diameter [mm]",
            "Before": f"{params_before['d_pintle_tip'] * 1000:.2f}",
            "After": f"{params_after['d_pintle_tip'] * 1000:.2f}",
            "Change": f"{((params_after['d_pintle_tip'] / params_before['d_pintle_tip'] - 1) * 100):+.1f}%"
        })
    
    if "h_gap" in params_before and "h_gap" in params_after:
        comparison_data.append({
            "Parameter": "Fuel Gap Thickness [mm]",
            "Before": f"{params_before['h_gap'] * 1000:.2f}",
            "After": f"{params_after['h_gap'] * 1000:.2f}",
            "Change": f"{((params_after['h_gap'] / params_before['h_gap'] - 1) * 100):+.1f}%"
        })
    
    if "n_orifices" in params_before and "n_orifices" in params_after:
        comparison_data.append({
            "Parameter": "Number of Orifices",
            "Before": f"{int(params_before['n_orifices'])}",
            "After": f"{int(params_after['n_orifices'])}",
            "Change": f"{int(params_after['n_orifices'] - params_before['n_orifices']):+d}"
        })
    
    if "d_orifice" in params_before and "d_orifice" in params_after:
        comparison_data.append({
            "Parameter": "Orifice Diameter [mm]",
            "Before": f"{params_before['d_orifice'] * 1000:.2f}",
            "After": f"{params_after['d_orifice'] * 1000:.2f}",
            "Change": f"{((params_after['d_orifice'] / params_before['d_orifice'] - 1) * 100):+.1f}%"
        })
    
    if "theta_orifice" in params_before and "theta_orifice" in params_after:
        comparison_data.append({
            "Parameter": "Orifice Angle [°]",
            "Before": f"{params_before['theta_orifice']:.1f}",
            "After": f"{params_after['theta_orifice']:.1f}",
            "Change": f"{(params_after['theta_orifice'] - params_before['theta_orifice']):+.1f}°"
        })
    
    # Performance comparison
    try:
        runner_before = PintleEngineRunner(config_before)
        runner_after = PintleEngineRunner(config_after)
        P_tank_O = 3e6
        P_tank_F = 3e6
        
        results_before = runner_before.evaluate(P_tank_O, P_tank_F)
        results_after = optimization_results.get("performance", runner_after.evaluate(P_tank_O, P_tank_F))
        
        comparison_data.append({
            "Parameter": "Thrust [N]",
            "Before": f"{results_before.get('F', 0):.1f}",
            "After": f"{results_after.get('F', 0):.1f}",
            "Change": f"{((results_after.get('F', 0) / max(results_before.get('F', 1), 1) - 1) * 100):+.1f}%"
        })
        comparison_data.append({
            "Parameter": "Isp [s]",
            "Before": f"{results_before.get('Isp', 0):.1f}",
            "After": f"{results_after.get('Isp', 0):.1f}",
            "Change": f"{((results_after.get('Isp', 0) / max(results_before.get('Isp', 1), 1) - 1) * 100):+.1f}%"
        })
        comparison_data.append({
            "Parameter": "Mixture Ratio",
            "Before": f"{results_before.get('MR', 0):.3f}",
            "After": f"{results_after.get('MR', 0):.3f}",
            "Change": f"{(results_after.get('MR', 0) - results_before.get('MR', 0)):+.3f}"
        })
    except Exception:
        pass
    
    if comparison_data:
        df_comparison = pd.DataFrame(comparison_data)
        st.dataframe(df_comparison, use_container_width=True, hide_index=True)
    else:
        st.warning("Could not generate comparison table")




def _display_injector_parameters(config: PintleEngineConfig, optimization_results: Dict[str, Any]) -> None:
    """Display optimized injector parameters."""
    if not hasattr(config, 'injector') or config.injector.type != "pintle":
        st.warning("No pintle injector configuration found")
        return
    
    geometry = config.injector.geometry
    
    col1, col2, col3 = st.columns(3)
    
    with col1:
        st.markdown("#### 🔧 Fuel Geometry")
        if hasattr(geometry, 'fuel'):
            st.metric("Pintle Tip Diameter", f"{geometry.fuel.d_pintle_tip * 1000:.2f} mm")
            st.metric("Gap Height", f"{geometry.fuel.h_gap * 1000:.2f} mm")
            if hasattr(geometry.fuel, 'd_reservoir_inner'):
                st.metric("Reservoir Inner Diameter", f"{geometry.fuel.d_reservoir_inner * 1000:.2f} mm")
    
    with col2:
        st.markdown("#### 🔵 Oxidizer Geometry")
        if hasattr(geometry, 'lox'):
            st.metric("Number of Orifices", f"{geometry.lox.n_orifices}")
            st.metric("Orifice Diameter", f"{geometry.lox.d_orifice * 1000:.2f} mm")
            st.metric("Orifice Angle", f"{geometry.lox.theta_orifice:.1f}°")
    
    with col3:
        st.markdown("#### ⚡ Performance")
        performance = optimization_results.get("performance", {})
        if performance:
            st.metric("Thrust", f"{performance.get('F', 0):.1f} N")
            st.metric("Isp", f"{performance.get('Isp', 0):.1f} s")
            st.metric("Mixture Ratio", f"{performance.get('MR', 0):.3f}")
            st.metric("Chamber Pressure", f"{performance.get('Pc', 0) / 1e6:.2f} MPa")
            
            # Spray diagnostics if available
            diagnostics = performance.get("diagnostics", {})
            spray_diag = diagnostics.get("spray_diagnostics", {})
            if spray_diag:
                st.markdown("##### Spray Quality")
                st.metric("SMD (Oxidizer)", f"{spray_diag.get('D32_O', 0) * 1e6:.1f} µm")
                st.metric("SMD (Fuel)", f"{spray_diag.get('D32_F', 0) * 1e6:.1f} µm")
                st.metric("Evaporation Length", f"{spray_diag.get('x_star', 0) * 1000:.1f} mm")




def _optimize_chamber(
    config_obj: PintleEngineConfig,
    runner: PintleEngineRunner,
    requirements: Dict[str, Any],
    P_tank_O: float,
    P_tank_F: float,
    optimize_geometry: bool,
    optimize_cooling: bool,
    optimize_ablative: bool,
    optimize_graphite: bool,
) -> Tuple[PintleEngineConfig, Dict[str, Any]]:
    """Optimize chamber geometry and cooling system with time-varying analysis."""
    from engine.pipeline.chamber_optimizer import ChamberOptimizer
    
    optimizer = ChamberOptimizer(config_obj)
    
    # Set up design requirements
    design_requirements = {
        "target_thrust": requirements.get("target_thrust", 7000.0),
        "target_burn_time": requirements.get("target_burn_time", 10.0),
        "target_stability_margin": requirements.get("min_stability_margin", 1.2),
        "P_tank_O": P_tank_O,
        "P_tank_F": P_tank_F,
        "target_Isp": requirements.get("target_Isp", None),
    }
    
    # Set up constraints
    constraints = {
        "max_chamber_length": requirements.get("max_chamber_length", 0.5),
        "max_chamber_diameter": requirements.get("max_chamber_diameter", 0.15),
        "min_Lstar": 0.95,
        "max_Lstar": 1.27,
        "min_expansion_ratio": 3.0,
        "max_expansion_ratio": 30.0,
        "max_engine_weight": requirements.get("max_total_mass", None),
        "max_vehicle_length": requirements.get("max_chamber_length", None),
        "max_vehicle_diameter": requirements.get("max_chamber_diameter", None),
    }
    
    # Run optimization (now includes time-varying analysis)
    results = optimizer.optimize(design_requirements, constraints)
    
    return results["optimized_config"], results




def _show_optimization_comparison(
    config_before: PintleEngineConfig,
    config_after: PintleEngineConfig,
    optimization_results: Dict[str, Any]
) -> None:
    """Show before/after comparison of optimization."""
    st.markdown("### 📈 Before vs After Comparison")
    
    # Get performance before
    try:
        runner_before = PintleEngineRunner(config_before)
        P_tank_O = optimization_results.get("design_requirements", {}).get("P_tank_O", 3e6)
        P_tank_F = optimization_results.get("design_requirements", {}).get("P_tank_F", 3e6)
        results_before = runner_before.evaluate(P_tank_O, P_tank_F)
    except Exception:
        results_before = {}
    
    # Get performance after
    results_after = optimization_results.get("performance", {})
    
    # Create comparison table
    comparison_data = []
    
    # Geometry comparison
    comparison_data.append({
        "Parameter": "Throat Area [mm²]",
        "Before": f"{config_before.chamber.A_throat * 1e6:.2f}",
        "After": f"{config_after.chamber.A_throat * 1e6:.2f}",
        "Change": f"{((config_after.chamber.A_throat / config_before.chamber.A_throat - 1) * 100):+.1f}%"
    })
    comparison_data.append({
        "Parameter": "Exit Area [mm²]",
        "Before": f"{config_before.nozzle.A_exit * 1e6:.2f}",
        "After": f"{config_after.nozzle.A_exit * 1e6:.2f}",
        "Change": f"{((config_after.nozzle.A_exit / config_before.nozzle.A_exit - 1) * 100):+.1f}%"
    })
    comparison_data.append({
        "Parameter": "L* [mm]",
        "Before": f"{config_before.chamber.Lstar * 1000:.1f}",
        "After": f"{config_after.chamber.Lstar * 1000:.1f}",
        "Change": f"{((config_after.chamber.Lstar / config_before.chamber.Lstar - 1) * 100):+.1f}%"
    })
    
    # Performance comparison
    if results_before and results_after:
        comparison_data.append({
            "Parameter": "Thrust [N]",
            "Before": f"{results_before.get('F', 0):.1f}",
            "After": f"{results_after.get('F', 0):.1f}",
            "Change": f"{((results_after.get('F', 0) / max(results_before.get('F', 1), 1) - 1) * 100):+.1f}%"
        })
        comparison_data.append({
            "Parameter": "Isp [s]",
            "Before": f"{results_before.get('Isp', 0):.1f}",
            "After": f"{results_after.get('Isp', 0):.1f}",
            "Change": f"{((results_after.get('Isp', 0) / max(results_before.get('Isp', 1), 1) - 1) * 100):+.1f}%"
        })
        comparison_data.append({
            "Parameter": "Chamber Pressure [MPa]",
            "Before": f"{results_before.get('Pc', 0) / 1e6:.2f}",
            "After": f"{results_after.get('Pc', 0) / 1e6:.2f}",
            "Change": f"{((results_after.get('Pc', 0) / max(results_before.get('Pc', 1), 1) - 1) * 100):+.1f}%"
        })
    
    df_comparison = pd.DataFrame(comparison_data)
    st.dataframe(df_comparison, use_container_width=True, hide_index=True)




def _display_optimized_parameters(optimization_results: Dict[str, Any], config: PintleEngineConfig) -> None:
    """Display optimized parameters in a clear format."""
    # Extract optimized parameters
    opt_params = optimization_results.get("optimized_parameters", {})
    
    if not opt_params:
        # Extract from config
        from engine.pipeline.config_schemas import ensure_chamber_geometry
        cg = ensure_chamber_geometry(config)
        opt_params = {
            "A_throat": cg.A_throat,
            "A_exit": cg.A_exit,
            "Lstar": cg.Lstar,
            "chamber_diameter": cg.chamber_diameter,
            "chamber_length": cg.length,
            "expansion_ratio": cg.expansion_ratio,
        }
    
    # Pintle parameters
    if hasattr(config, 'injector') and config.injector.type == "pintle":
        geometry = config.injector.geometry
        if hasattr(geometry, 'fuel'):
            opt_params["d_pintle_tip"] = geometry.fuel.d_pintle_tip
            opt_params["h_gap"] = geometry.fuel.h_gap
        if hasattr(geometry, 'lox'):
            opt_params["n_orifices"] = geometry.lox.n_orifices
            opt_params["d_orifice"] = geometry.lox.d_orifice
            opt_params["theta_orifice"] = geometry.lox.theta_orifice
    
    # Display in columns
    col1, col2, col3 = st.columns(3)
    
    with col1:
        st.markdown("#### 🔥 Chamber Geometry")
        st.metric("Throat Area", f"{opt_params.get('A_throat', 0) * 1e6:.2f} mm²")
        st.metric("Exit Area", f"{opt_params.get('A_exit', 0) * 1e6:.2f} mm²")
        st.metric("L*", f"{opt_params.get('Lstar', 0) * 1000:.1f} mm")
        st.metric("Chamber Diameter", f"{opt_params.get('chamber_diameter', 0) * 1000:.2f} mm")
        st.metric("Chamber Length", f"{opt_params.get('chamber_length', 0) * 1000:.1f} mm")
        st.metric("Expansion Ratio", f"{opt_params.get('expansion_ratio', 0):.2f}")
    
    with col2:
        if "d_pintle_tip" in opt_params:
            st.markdown("#### 🔧 Pintle Injector")
            st.metric("Pintle Tip Diameter", f"{opt_params.get('d_pintle_tip', 0) * 1000:.2f} mm")
            st.metric("Gap Height", f"{opt_params.get('h_gap', 0) * 1000:.2f} mm")
            st.metric("Number of Orifices", f"{int(opt_params.get('n_orifices', 0))}")
            st.metric("Orifice Diameter", f"{opt_params.get('d_orifice', 0) * 1000:.2f} mm")
            st.metric("Orifice Angle", f"{opt_params.get('theta_orifice', 0):.1f}°")
        else:
            st.info("No pintle parameters optimized")
    
    with col3:
        st.markdown("#### ⚡ Performance")
        performance = optimization_results.get("performance", {})
        if performance:
            st.metric("Thrust", f"{performance.get('F', 0):.1f} N")
            st.metric("Isp", f"{performance.get('Isp', 0):.1f} s")
            st.metric("Chamber Pressure", f"{performance.get('Pc', 0) / 1e6:.2f} MPa")
            st.metric("Mass Flow", f"{performance.get('mdot_total', 0):.3f} kg/s")
            
            # Stability
            stability = performance.get("stability_results", {})
            if stability:
                chugging = stability.get("chugging", {})
                st.metric("Stability Margin", f"{chugging.get('stability_margin', 0):.3f}")
            
            # Time-varying metrics if available (check both locations)
            time_varying = optimization_results.get("time_varying")
            if time_varying is None:
                time_varying = performance.get("time_varying", {})
            if time_varying:
                st.markdown("##### ⏱️ Time-Averaged (Burn)")
                st.metric("Avg Thrust", f"{time_varying.get('avg_thrust', 0):.1f} N")
                st.metric("Min Stability", f"{time_varying.get('min_stability_margin', 0):.3f}")
                st.metric("Max Recession", f"{time_varying.get('max_recession_chamber', 0) * 1000:.2f} mm")




def _show_time_varying_results(time_varying: Dict[str, Any]) -> None:
    """Show time-varying optimization results."""
    st.markdown("### ⏱️ Time-Varying Performance")
    
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("Avg Thrust", f"{time_varying.get('avg_thrust', 0):.1f} N")
    with col2:
        st.metric("Min Thrust", f"{time_varying.get('min_thrust', 0):.1f} N")
    with col3:
        st.metric("Max Thrust", f"{time_varying.get('max_thrust', 0):.1f} N")
    with col4:
        st.metric("Thrust Std", f"{time_varying.get('thrust_std', 0):.1f} N")
    
    st.info(f"📊 Thrust variation: {time_varying.get('thrust_std', 0) / max(time_varying.get('avg_thrust', 1), 1) * 100:.1f}% (lower is better)")




def _plot_stability_evolution(runner: PintleEngineRunner, P_tank_O: float, P_tank_F: float) -> None:
    """Plot stability evolution over time."""
    try:
        from engine.pipeline.time_varying_solver import TimeVaryingCoupledSolver
        
        solver = TimeVaryingCoupledSolver(runner.config, runner.cea_cache)
        burn_time = 10.0  # Default
        time_array = np.linspace(0, burn_time, 50)
        P_tank_O_array = np.full_like(time_array, P_tank_O)
        P_tank_F_array = np.full_like(time_array, P_tank_F)
        
        states = solver.solve_time_series(time_array, P_tank_O_array, P_tank_F_array)
        results = solver.get_results_dict()
        
        # Plot stability margins over time
        fig = make_subplots(rows=3, cols=1, subplot_titles=("Chugging Margin", "Acoustic Margin", "Feed System Margin"))
        
        # Would extract stability margins from results and plot
        # Placeholder for now
        st.plotly_chart(fig, use_container_width=True, key="stability_plot")
        
    except Exception as e:
        st.warning(f"Could not plot stability evolution: {e}")



