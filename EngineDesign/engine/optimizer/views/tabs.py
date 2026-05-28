"""UI Tab Functions for Design Optimization View.

This module contains all Streamlit tab functions for the design optimization interface.
"""

from __future__ import annotations

from typing import Dict, Any, Optional
from datetime import datetime
import numpy as np
import pandas as pd
import streamlit as st
import copy
import sys
from pathlib import Path
import plotly.graph_objects as go

from engine.pipeline.config_schemas import PintleEngineConfig
from engine.pipeline.layer2_tank_capacity import resolve_layer2_tank_capacities_kg
from engine.core.runner import PintleEngineRunner

# Import from optimization_layers
from engine.optimizer import (
    run_full_engine_optimization_with_flight_sim,
    extract_all_parameters,
    plot_optimization_convergence,
    plot_pressure_curves,
    plot_copv_pressure,
    plot_flight_trajectory,
    plot_time_varying_results,
    plot_layer1_parameterization_history,
    generate_segmented_pressure_curve,
    calculate_copv_pressure_curve,
)
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization
from engine.optimizer.layers.layer2_pressure import run_layer2_pressure
from engine.optimizer.layers.layer3_thermal_protection import run_layer3_thermal_protection
from engine.optimizer.layers.layer4_flight_simulation import run_layer4_flight_simulation
from engine.optimizer.copv_flight_helpers import run_flight_simulation
from ui.flight_visuals import (
    extract_flight_series,
    plot_flight_results,
    render_rocket_view,
    plot_additional_rocket_plots,
)

# Import helper functions from views.helpers
from engine.optimizer.views.helpers import (
    _display_current_engine_config,
    _show_complete_optimization_results,
    _display_chamber_geometry_plot,
    _show_full_engine_comparison,
    _show_engine_validation_checks,
    _optimize_injector,
    _show_injector_comparison,
    _display_injector_parameters,
    _optimize_chamber,
    _show_optimization_comparison,
    _display_optimized_parameters,
    _show_time_varying_results,
    _plot_stability_evolution,
)

def _design_requirements_tab(config_obj: PintleEngineConfig) -> PintleEngineConfig:
    """Design requirements input tab with full rocket configuration and engine design inputs."""
    st.subheader("Design Requirements")
    st.markdown("""
    Configure your rocket and specify engine design targets. The optimizer will solve for:
    - **Propellant masses** (LOX & fuel to achieve target apogee)
    - **Engine geometry** (injector, chamber, nozzle sizing)
    - **Burn time** (optimized for mission profile)
    """)
    
    # Initialize working config from session state or config_obj
    working = st.session_state.get("design_config", {})
    if not working:
        working = config_obj.model_dump(exclude_none=False) if config_obj else {}
    
    # ==========================================================================
    # SECTION 1: ROCKET CONFIGURATION (from Flight Sim)
    # ==========================================================================
    st.markdown("---")
    st.markdown("## 🚀 Rocket Configuration")
    st.caption("Define your vehicle structure. Propellant masses will be solved by the optimizer.")
    
    # --- Environment Expander ---
    with st.expander("🌍 Environment", expanded=False):
        st.caption("Launch site location. Atmospheric conditions will be fetched from NOAA GFS forecast.")
        env = working.get("environment") if working.get("environment") is not None else {}
        env.setdefault("latitude", 35.34722)
        env.setdefault("longitude", -117.8099547)
        env.setdefault("elevation", 626.67)
        
        # Handle date
        env_date = None
        env_hour = 12
        if env.get("date") is not None:
            try:
                y, m, d, h = list(env["date"])
                env_date = datetime(y, m, d).date()
                env_hour = int(h)
            except Exception:
                env_date = datetime.now().date()
                env_hour = 12
        else:
            env_date = datetime.now().date()
            env_hour = 12
        
        colE1, colE2 = st.columns(2)
        with colE1:
            env_lat = st.number_input("Latitude [deg]", value=float(env.get("latitude") or 35.34722), key="opt_env_lat",
                help="Launch site latitude. Positive = North, Negative = South.")
            env_elev = st.number_input("Elevation [m]", value=float(env.get("elevation") or 626.67), key="opt_env_elev",
                help="Ground elevation above sea level.")
            env_date_input = st.date_input("Launch date", value=env_date, key="opt_env_date",
                help="Date for GFS atmospheric forecast.")
        with colE2:
            env_lon = st.number_input("Longitude [deg]", value=float(env.get("longitude") or -117.8099547), key="opt_env_lon",
                help="Launch site longitude. Positive = East, Negative = West.")
            env_hour_input = st.number_input("Launch hour [0-23 UTC]", min_value=0, max_value=23, value=env_hour, step=1, key="opt_env_hour",
                help="Launch hour in UTC.")
        
        env["latitude"] = float(env_lat)
        env["longitude"] = float(env_lon)
        env["elevation"] = float(env_elev)
        env["date"] = [int(env_date_input.year), int(env_date_input.month), int(env_date_input.day), int(env_hour_input)]
        working["environment"] = env
    
    # --- Rocket Expander ---
    with st.expander("🛩️ Rocket Structure", expanded=True):
        st.caption("**Mass Model:** Airframe (body/fins/avionics) + Propulsion (engine + tanks). Propellant masses are solved by optimizer.")
        rocket = working.get("rocket") if working.get("rocket") is not None else {}
        
        # Defaults
        rocket.setdefault("airframe_mass", 78.72)
        rocket.setdefault("engine_mass", 8.0)
        rocket.setdefault("lox_tank_structure_mass", 5.0)
        rocket.setdefault("fuel_tank_structure_mass", 3.0)
        rocket.setdefault("motor_position", 0.0)
        rocket.setdefault("engine_cm_offset", 0.15)
        rocket.setdefault("radius", 0.1015)
        rocket.setdefault("rocket_length", 3.5)
        rocket.setdefault("inertia", [8.0, 8.0, 0.5])
        
        st.markdown("##### Dry Masses (no propellant)")
        
        airframe = st.number_input(
            "Airframe mass [kg]", 
            value=float(rocket.get("airframe_mass") or 78.72), 
            key="opt_airframe_mass",
            help="Fuselage, fins, nosecone, avionics, payload (NO propulsion)"
        )
        
        st.caption("**Propulsion breakdown:**")
        colE1, colE2, colE3, colE4 = st.columns(4)
        with colE1:
            engine_mass = st.number_input(
                "Engine + plumbing [kg]", 
                value=float(rocket.get("engine_mass") or 8.0), 
                key="opt_engine_mass",
                help="Chamber, nozzle, injector, valves, ALL fittings & plumbing"
            )
        with colE2:
            lox_tank_mass = st.number_input(
                "LOX tank [kg]", 
                value=float(rocket.get("lox_tank_structure_mass") or 5.0), 
                key="opt_lox_tank_mass",
                help="Empty LOX tank structure (walls, no propellant)"
            )
        with colE3:
            fuel_tank_mass = st.number_input(
                "Fuel tank [kg]", 
                value=float(rocket.get("fuel_tank_structure_mass") or 3.0), 
                key="opt_fuel_tank_mass",
                help="Empty fuel tank structure (walls, no propellant)"
            )
        with colE4:
            copv_tank_mass = st.number_input(
                "COPV tank [kg]", 
                value=float(rocket.get("copv_dry_mass") or 5.0), 
                key="opt_copv_tank_mass",
                help="Empty COPV tank structure (walls, no pressurant gas)"
            )
        
        propulsion_dry = engine_mass + lox_tank_mass + fuel_tank_mass + copv_tank_mass
        total_dry = airframe + propulsion_dry
        st.info(f"**Propulsion dry:** {propulsion_dry:.2f} kg (engine + tanks + COPV) | **Total dry:** {total_dry:.2f} kg")
        
        st.markdown("##### Geometry & Positions")
        st.caption("Coordinate system: z=0 at rocket tail (bottom), positive toward nose (top).")
        colG1, colG2, colG3 = st.columns(3)
        with colG1:
            r_radius = st.number_input("Rocket radius [m]", value=float(rocket.get("radius") or 0.1015), key="opt_rocket_radius",
                help="Outer body radius (diameter ÷ 2). Used for aerodynamics and MoI.")
        with colG2:
            rocket_length = st.number_input("Rocket length [m]", value=float(rocket.get("rocket_length") or 3.5), key="opt_rocket_length",
                help="Total rocket length (tail to nose tip).")
        with colG3:
            motor_pos = st.number_input("Motor position [m]", value=float(rocket.get("motor_position") or 0.0), key="opt_motor_position",
                help="Distance from rocket tail to nozzle exit.")
        
        engine_cm_offset = st.number_input(
            "Engine CM offset [m]", 
            value=float(rocket.get("engine_cm_offset") or 0.15), 
            key="opt_engine_cm",
            help="Height of engine center of mass above nozzle exit."
        )

        # Airframe center of mass without propulsion (for flight dynamics)
        st.markdown("##### Airframe CM (no propulsion)")
        cm_wo_motor_val = rocket.get("cm_wo_motor")
        if cm_wo_motor_val is None:
            # Default heuristic: place airframe CM some distance above motor,
            # matching the fallback used in flight_sim.setup_flight
            cm_wo_motor_val = motor_pos + 1.5
        cm_wo_motor = st.number_input(
            "Airframe CM without motor [m]",
            value=float(cm_wo_motor_val),
            key="opt_cm_wo_motor",
            help="Center of mass of the airframe ONLY (no engine, tanks, or propellant), measured from rocket tail (z=0).",
        )
    
        st.markdown("##### Inertia (airframe only)")
        st.caption("💡 Propulsion inertia is auto-calculated using parallel axis theorem.")
        
        auto_inertia = st.checkbox("Auto-estimate inertia from mass & geometry", value=True, key="opt_auto_inertia",
            help="Estimate using solid cylinder approximation.")
        
        if auto_inertia:
            m_dry = airframe + propulsion_dry
            r = r_radius
            L = rocket_length
            i_xx_est = (1.0/12.0) * m_dry * (3 * r**2 + L**2)
            i_yy_est = i_xx_est
            i_zz_est = 0.5 * m_dry * r**2
            st.success(f"**Auto-estimated** (m={m_dry:.1f}kg, r={r*1000:.0f}mm, L={L:.2f}m):\n\n"
                      f"Ixx = {i_xx_est:.3f} kg·m² | Iyy = {i_yy_est:.3f} kg·m² | Izz = {i_zz_est:.4f} kg·m²")
            i_xx, i_yy, i_zz = i_xx_est, i_yy_est, i_zz_est
        else:
            _inertia = rocket.get("inertia") or [8.0, 8.0, 0.5]
            colI1, colI2, colI3 = st.columns(3)
            with colI1:
                i_xx = st.number_input("Ixx [kg·m²]", value=float(_inertia[0]), key="opt_inertia_x")
            with colI2:
                i_yy = st.number_input("Iyy [kg·m²]", value=float(_inertia[1]), key="opt_inertia_y")
            with colI3:
                i_zz = st.number_input("Izz [kg·m²]", value=float(_inertia[2]), key="opt_inertia_z")
        
        # Fins
        st.markdown("##### Fins")
        fins = rocket.get("fins") if rocket.get("fins") is not None else {}
        # Use 'or' pattern to handle None values (fin_position can be 0.0, so use explicit check)
        no_fins_val = fins.get("no_fins") or 3
        root_chord_val = fins.get("root_chord") or 0.2
        tip_chord_val = fins.get("tip_chord") or 0.1
        fin_span_val = fins.get("fin_span") or 0.3
        fin_position_val = fins.get("fin_position")
        if fin_position_val is None:
            fin_position_val = 0.0
        
        colF1, colF2, colF3 = st.columns(3)
        with colF1:
            fins["no_fins"] = int(st.number_input("Fin count", value=int(no_fins_val), min_value=1, step=1, key="opt_fins_count"))
            fins["root_chord"] = float(st.number_input("Root chord [m]", value=float(root_chord_val), key="opt_fins_root"))
        with colF2:
            fins["tip_chord"] = float(st.number_input("Tip chord [m]", value=float(tip_chord_val), key="opt_fins_tip"))
            fins["fin_span"] = float(st.number_input("Fin span [m]", value=float(fin_span_val), key="opt_fins_span"))
        with colF3:
            fins["fin_position"] = float(st.number_input("Fin position [m]", value=float(fin_position_val), key="opt_fins_pos"))

        # Store rocket config
        rocket["airframe_mass"] = float(airframe)
        rocket["engine_mass"] = float(engine_mass)
        rocket["lox_tank_structure_mass"] = float(lox_tank_mass)
        rocket["fuel_tank_structure_mass"] = float(fuel_tank_mass)
        rocket["copv_dry_mass"] = float(copv_tank_mass)
        rocket["propulsion_dry_mass"] = float(propulsion_dry)
        rocket["motor_position"] = float(motor_pos)
        rocket["engine_cm_offset"] = float(engine_cm_offset)
        rocket["cm_wo_motor"] = float(cm_wo_motor)
        rocket["radius"] = float(r_radius)
        rocket["rocket_length"] = float(rocket_length)
        rocket["inertia"] = [float(i_xx), float(i_yy), float(i_zz)]
        rocket["fins"] = fins
        working["rocket"] = rocket
    
    # --- Tanks Expander ---
    with st.expander("🛢️ Tank Geometry", expanded=False):
        st.caption("**Tank dimensions and positions.** Propellant masses will be solved by the optimizer to achieve target apogee.")
        
        lox_tank = working.get("lox_tank") if working.get("lox_tank") is not None else {}
        fuel_tank = working.get("fuel_tank") if working.get("fuel_tank") is not None else {}
        
        st.markdown("##### LOX Tank")
        # Use 'or' pattern to handle None values
        lox_h_val = lox_tank.get("lox_h") or 1.14
        lox_radius_val = lox_tank.get("lox_radius") or 0.0762
        ox_tank_pos_val = lox_tank.get("ox_tank_pos") or 0.6
        
        colL1, colL2, colL3 = st.columns(3)
        with colL1:
            lox_tank["lox_h"] = float(st.number_input("Height [m]", value=float(lox_h_val), key="opt_lox_h",
                help="Internal cylindrical height."))
        with colL2:
            lox_tank["lox_radius"] = float(st.number_input("Radius [m]", value=float(lox_radius_val), key="opt_lox_radius",
                help="Internal radius."))
        with colL3:
            lox_tank["ox_tank_pos"] = float(st.number_input("Position [m]", value=float(ox_tank_pos_val), key="opt_lox_pos",
                help="Tank center relative to nozzle exit."))
        
        # Calculate LOX tank capacity
        fluids = working.get("fluids") if working.get("fluids") is not None else {}
        ox_fluid = fluids.get("oxidizer") if fluids.get("oxidizer") is not None else {}
        rho_lox = float(ox_fluid.get("density") or 1140.0)
        # Get volume from config or calculate from geometry
        if lox_tank.get("tank_volume_m3") is not None:
            lox_volume = float(lox_tank["tank_volume_m3"])
        else:
            lox_volume = np.pi * lox_tank["lox_radius"]**2 * lox_tank["lox_h"]
        lox_capacity = lox_volume * rho_lox
        st.caption(f"Tank Volume: **{lox_volume*1000:.1f} L** | Max Capacity: **{lox_capacity:.1f} kg** (optimizer will fill as needed)")
        
        st.markdown("##### Fuel Tank")
        # Use 'or' pattern to handle None values
        rp1_h_val = fuel_tank.get("rp1_h") or 0.609
        rp1_radius_val = fuel_tank.get("rp1_radius") or 0.0762
        fuel_tank_pos_val = fuel_tank.get("fuel_tank_pos")
        if fuel_tank_pos_val is None:
            fuel_tank_pos_val = -0.2  # Can't use 'or' for negative default
        
        colFu1, colFu2, colFu3 = st.columns(3)
        with colFu1:
            fuel_tank["rp1_h"] = float(st.number_input("Height [m]", value=float(rp1_h_val), key="opt_rp1_h"))
        with colFu2:
            fuel_tank["rp1_radius"] = float(st.number_input("Radius [m]", value=float(rp1_radius_val), key="opt_rp1_radius"))
        with colFu3:
            fuel_tank["fuel_tank_pos"] = float(st.number_input("Position [m]", value=float(fuel_tank_pos_val), key="opt_rp1_pos"))
        
        # Calculate Fuel tank capacity
        fu_fluid = fluids.get("fuel") if fluids.get("fuel") is not None else {}
        rho_fuel = float(fu_fluid.get("density") or 780.0)
        # Get volume from config or calculate from geometry
        if fuel_tank.get("tank_volume_m3") is not None:
            fuel_volume = float(fuel_tank["tank_volume_m3"])
        else:
            fuel_volume = np.pi * fuel_tank["rp1_radius"]**2 * fuel_tank["rp1_h"]
        fuel_capacity = fuel_volume * rho_fuel
        st.caption(f"Tank Volume: **{fuel_volume*1000:.1f} L** | Max Capacity: **{fuel_capacity:.1f} kg** (optimizer will fill as needed)")
        
        # --- Pressurant Tank (COPV) ---
        st.markdown("##### Pressurant Tank (COPV - GN₂)")
        press_tank = working.get("press_tank") if working.get("press_tank") is not None else {}
        
        # Use 'or' pattern to handle None values
        press_h_val = press_tank.get("press_h") or 0.457
        press_radius_val = press_tank.get("press_radius") or 0.0762
        pres_tank_pos_val = press_tank.get("pres_tank_pos") or 1.2
        
        colP1, colP2, colP3 = st.columns(3)
        with colP1:
            press_tank["press_h"] = float(st.number_input("Height [m]", value=float(press_h_val), key="opt_press_h",
                help="COPV cylindrical height."))
        with colP2:
            press_tank["press_radius"] = float(st.number_input("Radius [m]", value=float(press_radius_val), key="opt_press_radius",
                help="COPV radius."))
        with colP3:
            press_tank["pres_tank_pos"] = float(st.number_input("Position [m]", value=float(pres_tank_pos_val), key="opt_press_pos",
                help="COPV center position relative to nozzle exit. Typically above propellant tanks."))
        
        # Calculate COPV volume from geometry (external dimensions)
        press_volume_calc = np.pi * press_tank["press_radius"]**2 * press_tank["press_h"]
        
        # User-specified free internal volume (may be smaller than calculated due to walls)
        copv_free_volume_default = press_tank.get("free_volume_L") or 4.5  # Default 4.5L
        copv_free_volume_L = st.number_input(
            "COPV Free Volume [L]",
            min_value=0.1,
            max_value=100.0,
            value=float(copv_free_volume_default),
            step=0.5,
            key="opt_copv_free_volume",
            help="Internal free gas volume (excluding walls). Typically 85-95% of calculated geometric volume."
        )
        press_tank["free_volume_L"] = copv_free_volume_L
        st.caption(f"Geometric Volume: {press_volume_calc*1000:.1f} L | Free Volume: **{copv_free_volume_L:.1f} L**")
        
        working["lox_tank"] = lox_tank
        working["fuel_tank"] = fuel_tank
        working["press_tank"] = press_tank
    
    # --- Fluids Expander ---
    with st.expander("💧 Fluid Properties", expanded=False):
        st.caption("Propellant densities for capacity calculations.")
        fluids = working.get("fluids") if working.get("fluids") is not None else {}
        ox = fluids.get("oxidizer") if fluids.get("oxidizer") is not None else {}
        fu = fluids.get("fuel") if fluids.get("fuel") is not None else {}
        
        # Use 'or' pattern to handle None values
        ox_name = ox.get("name") or "LOX"
        ox_density = ox.get("density") or 1140.0
        fu_name = fu.get("name") or "RP-1"
        fu_density = fu.get("density") or 780.0
        
        colOx1, colOx2 = st.columns(2)
        with colOx1:
            st.markdown("**Oxidizer**")
            ox["name"] = st.text_input("Name", value=str(ox_name), key="opt_ox_name")
            ox["density"] = float(st.number_input("Density [kg/m³]", value=float(ox_density), key="opt_ox_density",
                help="LOX ≈ 1140 kg/m³"))
        with colOx2:
            st.markdown("**Fuel**")
            fu["name"] = st.text_input("Name", value=str(fu_name), key="opt_fu_name")
            fu["density"] = float(st.number_input("Density [kg/m³]", value=float(fu_density), key="opt_fu_density",
                help="RP-1 ≈ 780-820 kg/m³"))
        
        fluids["oxidizer"] = ox
        fluids["fuel"] = fu
        working["fluids"] = fluids
    
    # ==========================================================================
    # SECTION 2: ENGINE DESIGN INPUTS
    # ==========================================================================
    st.markdown("---")
    st.markdown("## 🔧 Engine Design Targets")
    st.caption("Specify performance targets and constraints. The optimizer will size the engine to meet these.")
    
    col1, col2 = st.columns(2)
    
    with col1:
        st.markdown("### Performance Targets")
        
        target_thrust = st.number_input(
            "Target Peak Thrust [N]",
            min_value=100.0,
            max_value=100000.0,
            value=7000.0,
            step=100.0,
            key="opt_target_thrust",
            help="Peak thrust during burn. Engine will be sized to achieve this."
        )
        
        target_apogee = st.number_input(
            "Target Apogee [m AGL]",
            min_value=100.0,
            max_value=200000.0,
            value=3048.0,  # 10k feet
            step=100.0,
            key="opt_target_apogee",
            help="Target altitude above ground level. Optimizer will solve for propellant masses."
        )
        
        optimal_of_ratio = st.number_input(
            "Optimal O/F Ratio",
            min_value=1.5,
            max_value=4.0,
            value=2.3,
            step=0.1,
            key="opt_of_ratio",
            help="Target oxidizer-to-fuel mixture ratio. LOX/RP-1 optimal: 2.4-2.8 for Isp, 2.2-2.5 for stability."
        )
        
        target_burn_time = st.number_input(
            "Target Burn Time [s]",
            min_value=1.0,
            max_value=60.0,
            value=10.0,
            step=1.0,
            key="opt_target_burn_time",
            help="Design burn time. Flight sim will truncate if propellant depletes earlier."
        )
        
        st.markdown("### Tank Pressures")
        
        max_lox_tank_pressure = st.number_input(
            "Max LOX Tank Pressure [psi]",
            min_value=100.0,
            max_value=5000.0,
            value=700.0,
            step=25.0,
            key="opt_max_lox_pressure",
            help="Maximum operating pressure in LOX tank. Sets upper bound for chamber pressure."
        )
        
        max_fuel_tank_pressure = st.number_input(
            "Max Fuel Tank Pressure [psi]",
            min_value=100.0,
            max_value=5000.0,
            value=850.0,
            step=25.0,
            key="opt_max_fuel_pressure",
            help="Maximum operating pressure in fuel tank."
        )
    
    with col2:
        st.markdown("### Geometry Constraints")
        
        max_engine_length = st.number_input(
            "Max Engine Length [m]",
            min_value=0.1,
            max_value=3.0,
            value=0.5,
            step=0.05,
            key="opt_max_engine_length",
            help="Maximum total engine length (chamber + nozzle). Must fit in vehicle."
        )
        
        max_chamber_outer_diameter = st.number_input(
            "Max Chamber Outer Diameter [m]",
            min_value=0.05,
            max_value=1.0,
            value=0.15,
            step=0.01,
            key="opt_max_chamber_od",
            help="Maximum chamber outer diameter (including wall thickness and cooling jacket)."
        )
        
        max_nozzle_exit_diameter = st.number_input(
            "Max Nozzle Exit Diameter [m]",
            min_value=0.05,
            max_value=1.0,
            value=0.101,
            step=0.01,
            key="opt_max_nozzle_exit_od",
            help="Maximum nozzle exit outer diameter. Constrains expansion ratio."
        )
        
        st.markdown("### L* (Characteristic Length) Constraints")
        
        col_lstar1, col_lstar2 = st.columns(2)
        with col_lstar1:
            min_lstar = st.number_input(
                "Minimum L* [m]",
                min_value=0.5,
                max_value=3.0,
                value=0.95,
                step=0.1,
                key="opt_min_lstar",
                help="Minimum characteristic length. Lower = smaller chamber but less complete combustion. Typical: 0.8-1.0m for LOX/RP-1."
            )
        with col_lstar2:
            max_lstar = st.number_input(
                "Maximum L* [m]",
                min_value=0.5,
                max_value=3.0,
                value=1.27,
                step=0.1,
                key="opt_max_lstar",
                help="Maximum characteristic length. Higher = better combustion but heavier/longer chamber. Typical: 1.5-2.0m for LOX/RP-1."
            )
        
        st.markdown("### Stability Requirements")
        st.info("""
        **New Comprehensive Stability Analysis:**
        - Uses stability_score (0-1) and stability_state ("stable"/"marginal"/"unstable")
        - Considers chugging, acoustic modes, feed system, and mode coupling
        - **Stable**: score ≥ 0.75 (recommended for flight)
        - **Marginal**: 0.4 ≤ score < 0.75 (acceptable with caution)
        - **Unstable**: score < 0.4 (not acceptable)
        """)
        
        min_stability_score = st.number_input(
            "Minimum Stability Score",
            min_value=0.0,
            max_value=1.0,
            value=0.75,
            step=0.05,
            key="opt_min_stability_score",
            help="Minimum stability score (0-1). 0.75 = 'stable', 0.4 = 'marginal', <0.4 = 'unstable'"
        )
        
        require_stable_state = st.checkbox(
            "Require 'Stable' State (not just 'Marginal')",
            value=True,
            key="opt_require_stable_state",
            help="If checked, optimizer will only converge when stability_state == 'stable'. If unchecked, allows 'marginal' state."
        )
        
        st.markdown("#### Individual Stability Margins (for detailed tracking)")
        st.caption("These are used for detailed feedback but the optimizer primarily uses stability_score above.")
        
        min_stability_margin = st.number_input(
            "Minimum Overall Stability Margin (legacy)",
            min_value=1.0,
            max_value=5.0,
            value=1.2,
            step=0.1,
            key="opt_min_stability",
            help="Legacy margin-based requirement (for backward compatibility)"
        )
        
        chugging_margin_min = st.number_input(
            "Chugging Margin (min)",
            min_value=0.0,
            max_value=10.0,
            value=0.2,
            step=0.1,
            key="opt_chugging_margin",
            help="Minimum chugging stability margin (for detailed tracking)"
        )
        
        acoustic_margin_min = st.number_input(
            "Acoustic Margin (min)",
            min_value=0.0,
            max_value=10.0,
            value=0.1,
            step=0.1,
            key="opt_acoustic_margin",
            help="Minimum acoustic stability margin (for detailed tracking)"
        )
        
        feed_stability_min = st.number_input(
            "Feed System Margin (min)",
            min_value=0.0,
            max_value=10.0,
            value=0.15,
            step=0.1,
            key="opt_feed_margin",
            help="Minimum feed system stability margin (for detailed tracking)"
        )
        
    # Convert pressures to SI (Pa)
    max_P_tank_O = max_lox_tank_pressure * 6894.76  # psi to Pa
    max_P_tank_F = max_fuel_tank_pressure * 6894.76
    
    # Store all requirements in session state
    st.session_state["design_requirements"] = {
        # Performance targets
        "target_thrust": target_thrust,
        "target_apogee": target_apogee,
        "optimal_of_ratio": optimal_of_ratio,
        "target_burn_time": target_burn_time,
        # Tank pressures (SI)
        "max_P_tank_O": max_P_tank_O,
        "max_P_tank_F": max_P_tank_F,
        "max_lox_tank_pressure_psi": max_lox_tank_pressure,
        "max_fuel_tank_pressure_psi": max_fuel_tank_pressure,
        # Geometry constraints
        "max_engine_length": max_engine_length,
        "max_chamber_outer_diameter": max_chamber_outer_diameter,
        "max_nozzle_exit_diameter": max_nozzle_exit_diameter,
        # L* constraints
        "min_Lstar": min_lstar,
        "max_Lstar": max_lstar,
        # Stability (new comprehensive analysis)
        "min_stability_score": min_stability_score,
        "require_stable_state": require_stable_state,
        # Stability (legacy margins for backward compatibility)
        "min_stability_margin": min_stability_margin,
        "chugging_margin_min": chugging_margin_min,
        "acoustic_margin_min": acoustic_margin_min,
        "feed_stability_min": feed_stability_min,
        # Tank capacities (for optimizer bounds)
        "lox_tank_capacity_kg": lox_capacity,
        "fuel_tank_capacity_kg": fuel_capacity,
        # COPV
        "copv_free_volume_L": copv_free_volume_L,
        "copv_free_volume_m3": copv_free_volume_L / 1000.0,
    }
    
    # Store rocket config for optimizer
    st.session_state["design_config"] = working
    st.session_state["rocket_dry_mass"] = total_dry
    
    # Summary
    st.markdown("---")
    st.markdown("### 📋 Design Summary")
    
    col_s1, col_s2, col_s3, col_s4 = st.columns(4)
    with col_s1:
        st.metric("Rocket Dry Mass", f"{total_dry:.1f} kg")
        st.metric("Target Apogee", f"{target_apogee:.0f} m")
    with col_s2:
        st.metric("Target Thrust", f"{target_thrust:.0f} N")
        st.metric("Optimal O/F", f"{optimal_of_ratio:.2f}")
    with col_s3:
        st.metric("Max Tank Pressure", f"{max(max_lox_tank_pressure, max_fuel_tank_pressure):.0f} psi")
        st.metric("Target Burn Time", f"{target_burn_time:.1f} s")
    with col_s4:
        st.metric("L* Range", f"{min_lstar:.1f} - {max_lstar:.1f} m")
        st.metric("Max Engine Length", f"{max_engine_length*1000:.0f} mm")
    
    st.success("✅ Configuration saved. Proceed to **Full Engine Optimizer** to optimize your complete engine, or use individual tabs for specific optimizations.")
    
    return config_obj




def _full_engine_optimization_tab(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner]) -> PintleEngineConfig:
    """Full engine optimization tab - optimizes both pintle injector and chamber together."""
    st.subheader("🚀 Full Engine Optimizer")
    
    if runner is None:
        st.warning("⚠️ Runner not available. Please load configuration first.")
        return config_obj
    
    # Get design requirements
    requirements = st.session_state.get("design_requirements", {})
    if not requirements:
        st.warning("⚠️ Please set design requirements in the 'Design Requirements' tab first.")
        return config_obj
    
    # Create subtabs for Optimization and Flight Simulation
    subtab_optimize, subtab_flight = st.tabs([
        "⚙️ Engine Optimization",
        "✈️ Flight Simulation"
    ])
    
    with subtab_optimize:
        config_obj = _optimizer_subtab_content(config_obj, runner, requirements)
    
    with subtab_flight:
        config_obj = _layer4_tab(config_obj, runner)
    
    return config_obj


def _optimizer_subtab_content(config_obj: PintleEngineConfig, runner: PintleEngineRunner, requirements: Dict[str, Any]) -> PintleEngineConfig:
    """Content for the Engine Optimization subtab."""
    st.markdown("""
    **Complete engine optimization** that jointly sizes:
    - **Pintle injector**: orifice count, diameters, gap height, tip diameter
    - **Chamber geometry**: throat area, chamber volume, L*, diameter
    - **Nozzle geometry**: exit area, expansion ratio
    
    Uses all design requirements from the **Design Requirements** tab including:
    - Target thrust, O/F ratio, tank pressures
    - L* constraints, geometry limits
    - Stability requirements
    
    *Note: Orifice angle is fixed at 90° (perpendicular to longitudinal axis) for optimal impingement.*
    """)
    
    # Display current design requirements summary
    st.markdown("### 📋 Current Design Requirements")
    col_req1, col_req2, col_req3 = st.columns(3)
    
    with col_req1:
        st.metric("Target Thrust", f"{requirements.get('target_thrust', 7000):.0f} N")
        st.metric("Optimal O/F", f"{requirements.get('optimal_of_ratio', 2.3):.2f}")
    with col_req2:
        st.metric("Max LOX Pressure", f"{requirements.get('max_lox_tank_pressure_psi', 700):.0f} psi")
        st.metric("Max Fuel Pressure", f"{requirements.get('max_fuel_tank_pressure_psi', 850):.0f} psi")
    with col_req3:
        st.metric("L* Range", f"{requirements.get('min_Lstar', 0.95):.1f} - {requirements.get('max_Lstar', 1.27):.1f} m")
        st.metric("Min Stability", f"{requirements.get('min_stability_margin', 1.2):.2f}")
    
    st.markdown("---")
    
    # Optimization Configuration
    st.markdown("### ⚙️ Optimization Configuration")
    
    st.markdown("#### Optimization Parameters")
    
    # Use target_burn_time from Design Requirements tab
    target_burn_time = requirements.get("target_burn_time", 10.0)
    st.info(f"**Target Burn Time:** {target_burn_time:.1f} s *(from Design Requirements tab)*")
    
    max_iterations = st.number_input(
        "Max Optimization Iterations",
        min_value=20,
        max_value=200,
        value=80,
        step=10,
        key="full_opt_max_iter",
        help="Maximum function evaluations (typically converges in 30-60)"
    )
    
    st.markdown("#### ⏱️ Time-Varying Analysis")
    use_time_varying = st.checkbox(
        "Enable Time-Varying Optimization",
        value=True,
        key="full_opt_time_varying",
        help="Optimize across entire burn time (accounts for ablative recession, geometry evolution, and time-varying stability)"
    )
    if use_time_varying:
        st.caption("✅ Optimizer will account for ablative recession, chamber/throat evolution, and stability over entire burn")
    else:
        st.caption("⚠️ Single-point optimization at t=0 only (faster but less accurate)")
    
    st.markdown("#### Target Tolerances")
    st.caption("Optimizer stops early when within these tolerances")
    
    thrust_tolerance = st.number_input(
        "Thrust Tolerance [%]",
        min_value=1.0,
        max_value=20.0,
        value=10.0,
        step=1.0,
        key="full_opt_thrust_tol",
        help="Acceptable deviation from target thrust"
    ) / 100.0
    
    apogee_tolerance = st.number_input(
        "Apogee Tolerance [%]",
        min_value=5.0,
        max_value=30.0,
        value=15.0,
        step=5.0,
        key="full_opt_apogee_tol",
        help="Acceptable deviation from target apogee"
    ) / 100.0
    
    # ==========================================================================
    # PRESSURE CURVE - OPTIMIZER CONTROLLED
    # ==========================================================================
    st.markdown("---")
    st.markdown("### 🛢️ Tank Pressure Curves")
    
    # Get max pressures from requirements (user's only input for pressure)
    max_lox_pressure_psi = float(requirements.get("max_lox_tank_pressure_psi", 700))
    max_fuel_pressure_psi = float(requirements.get("max_fuel_tank_pressure_psi", 850))
    
    st.info(
        f"🎛️ **Optimizer-Controlled Pressure Curves**\n\n"
        f"The optimizer jointly optimizes **injector geometry** AND **tank pressures** to achieve target O/F ratio.\n\n"
        f"**What the optimizer controls:**\n"
        f"- Starting pressures at t=0 (can be anywhere from 30% to 100% of max)\n"
        f"- Pressure profiles over time (4 control points per tank)\n"
        f"- Curve shape (linear vs exponential blending)\n\n"
        f"**Hard constraints (never exceeded):**\n"
        f"- Max LOX Tank Pressure: **{max_lox_pressure_psi:.0f} psi**\n"
        f"- Max Fuel Tank Pressure: **{max_fuel_pressure_psi:.0f} psi**\n"
        f"- Target Burn Time: **{target_burn_time:.1f} s**\n\n"
        f"*The optimizer finds the best geometry + pressure combination to meet thrust, O/F, and stability targets.*"
    )
    
    # Pressure config for optimizer (no user segments - optimizer will generate)
    # Optimizer will create N segments (up to 20) with linear/blowdown types
    pressure_config = {
        "mode": "optimizer_controlled",
        "max_lox_pressure_psi": max_lox_pressure_psi,
        "max_fuel_pressure_psi": max_fuel_pressure_psi,
        "target_burn_time": target_burn_time,
        "n_segments": 3,  # Default: 3 segments per tank (optimizer can use fewer by setting duration near zero)
        # Initial values (optimizer will refine these)
        "lox_start_psi": max_lox_pressure_psi,
        "fuel_start_psi": max_fuel_pressure_psi,
        "lox_end_pct": 0.7,  # Initial guess
        "fuel_end_pct": 0.7,  # Initial guess
    }
    
    # Tolerances config
    tolerances = {
        "thrust": thrust_tolerance,
        "apogee": apogee_tolerance,
    }
    
    # Convergence tolerance
    convergence_tol = thrust_tolerance
    
    st.markdown("---")
    
    # Display current configuration
    st.markdown("### 📊 Current Engine Configuration")
    _display_current_engine_config(config_obj)
    
    st.markdown("---")
    
    # Run Full Engine Optimization
    if st.button("🚀 Run Full Engine Optimization", type="primary", key="run_full_engine_opt"):
        try:
            # Store before config for comparison
            config_before = copy.deepcopy(config_obj)
            
            # Create progress bar container
            progress_bar = st.progress(0, text="Initializing optimization...")
            status_text = st.empty()
            
            # Run the full engine optimization with progress callback
            def progress_callback(stage: str, progress: float, message: str):
                # Format progress bar to show stage clearly
                progress_text = f"{stage}\n{message}" if "\n" not in message else f"{stage}\n{message}"
                progress_bar.progress(progress, text=progress_text)
                status_text.text(f"{stage} | {message}")
            
            optimized_config, optimization_results = run_full_engine_optimization_with_flight_sim(
                config_obj,
                runner,
                requirements,
                target_burn_time,
                max_iterations,
                tolerances,
                pressure_config,
                progress_callback=progress_callback,
                use_time_varying=use_time_varying,
            )
            
            # Clear progress bar
            progress_bar.empty()
            status_text.empty()
            
            # Store results
            config_obj = optimized_config
            st.session_state["optimized_config"] = optimized_config
            st.session_state["optimization_results"] = optimization_results
            st.session_state["optimization_before_config"] = config_before
            
            # Update config_dict so changes persist
            config_dict_updated = optimized_config.model_dump(exclude_none=False)
            st.session_state["config_dict"] = config_dict_updated
            
            # Display success
            conv_info = optimization_results.get("convergence_info", {})
            flight_result = optimization_results.get("flight_sim_result", {})
            
            if conv_info.get("converged", False):
                st.success(f"✅ Optimization converged after {conv_info.get('iterations', 0)} iterations!")
            else:
                st.warning(f"⚠️ Optimization completed after {conv_info.get('iterations', 0)} iterations (final change: {conv_info.get('final_change', 0)*100:.2f}%)")
            
            if flight_result.get("success", False):
                apogee = flight_result.get("apogee", 0)
                target_apogee = requirements.get("target_apogee", 3048.0)
                apogee_error = abs(apogee - target_apogee) / target_apogee * 100 if target_apogee > 0 else 100.0
                if apogee_error < 10:
                    st.success(f"🎯 Flight simulation: Apogee = {apogee:.0f} m (target: {target_apogee:.0f} m, error: {apogee_error:.1f}%)")
                else:
                    st.warning(f"⚠️ Flight simulation: Apogee = {apogee:.0f} m (target: {target_apogee:.0f} m, error: {apogee_error:.1f}%)")
            
            # Display results
            st.markdown("---")
            st.markdown("## ✅ Optimization Results")
            
            # Show complete results with all visualizations
            _show_complete_optimization_results(config_before, optimized_config, optimization_results, requirements, target_burn_time)
            
        except Exception as e:
            st.error(f"Optimization failed: {e}")
            import traceback
            st.code(traceback.format_exc())
    
    # Show optimization results if available from previous run
    if "optimized_config" in st.session_state and "optimization_results" in st.session_state:
        opt_results = st.session_state.get("optimization_results", {})
        opt_config = st.session_state.get("optimized_config", config_obj)
        config_before = st.session_state.get("optimization_before_config", config_obj)
        
        if st.checkbox("Show Previous Optimization Results", value=False, key="show_prev_full_opt"):
            st.markdown("---")
            st.markdown("## 📊 Previous Optimization Results")
            _show_complete_optimization_results(config_before, opt_config, opt_results, requirements, target_burn_time)
    
    return config_obj




def _injector_optimization_tab(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner]) -> PintleEngineConfig:
    """Injector optimization tab."""
    st.subheader("Injector Geometry Optimization")
    st.markdown("""
    Optimize injector geometry (pintle tip, orifices, spray) to achieve:
    - Target mixture ratio
    - Good spray quality (SMD, evaporation)
    - Stable operation
    - Efficient combustion
    """)
    
    if runner is None:
        st.warning("⚠️ Runner not available. Please load configuration first.")
        return config_obj
    
    # Get design requirements
    requirements = st.session_state.get("design_requirements", {})
    if not requirements:
        st.warning("⚠️ Please set design requirements in the 'Design Requirements' tab first.")
        return config_obj
    
    target_thrust = requirements.get("target_thrust", 7000.0)
    target_MR = config_obj.combustion.MR if hasattr(config_obj.combustion, 'MR') else 2.5
    
    col1, col2 = st.columns([2, 1])
    
    with col1:
        # Use optimized config if available
        display_config = st.session_state.get("optimized_config", config_obj)
        is_optimized = "optimized_config" in st.session_state
        
        if is_optimized:
            st.markdown("### ✅ Optimized Injector Configuration")
            st.info("📊 Showing optimized parameters below. Scroll down to see before/after comparison.")
        else:
            st.markdown("### Current Injector Configuration")
        
        # Display injector parameters (optimized if available)
        injector_config = display_config.injector if hasattr(display_config, 'injector') else None
        if injector_config and injector_config.type == "pintle":
            geometry = injector_config.geometry
            col_a, col_b, col_c = st.columns(3)
            with col_a:
                if hasattr(geometry, 'fuel') and hasattr(geometry.fuel, 'd_pintle_tip'):
                    st.metric("Pintle Tip Diameter", f"{geometry.fuel.d_pintle_tip * 1000:.2f} mm")
                if hasattr(geometry, 'lox') and hasattr(geometry.lox, 'd_orifice'):
                    st.metric("Oxidizer Orifice Diameter", f"{geometry.lox.d_orifice * 1000:.2f} mm")
            with col_b:
                if hasattr(geometry, 'fuel') and hasattr(geometry.fuel, 'h_gap'):
                    st.metric("Fuel Gap Thickness", f"{geometry.fuel.h_gap * 1000:.2f} mm")
                if hasattr(geometry, 'lox') and hasattr(geometry.lox, 'n_orifices'):
                    st.metric("Number of Orifices", f"{geometry.lox.n_orifices}")
            with col_c:
                if hasattr(geometry, 'fuel') and hasattr(geometry.fuel, 'd_reservoir_inner'):
                    st.metric("Reservoir Inner Diameter", f"{geometry.fuel.d_reservoir_inner * 1000:.2f} mm")
                if hasattr(geometry, 'lox') and hasattr(geometry.lox, 'theta_orifice'):
                    st.metric("Orifice Angle", f"{geometry.lox.theta_orifice:.1f}°")
        elif injector_config:
            st.info(f"Injector type: {injector_config.type} (detailed metrics not yet implemented)")
        
        # Optimization controls
        st.markdown("### Optimization Options")
        optimize_injector = st.checkbox("Enable Injector Optimization", value=False)
        
        if optimize_injector:
            st.markdown("#### Optimization Variables")
            
            optimize_pintle = st.checkbox("Optimize Pintle Tip Diameter", value=True)
            optimize_orifices = st.checkbox("Optimize Orifice Sizes", value=True)
            optimize_spray = st.checkbox("Optimize Spray Parameters", value=False)
            
            if st.button("🚀 Run Injector Optimization", type="primary"):
                with st.spinner("Optimizing injector geometry..."):
                    try:
                        # Store before config for comparison
                        config_before = copy.deepcopy(config_obj)
                        
                        # Run injector optimization
                        optimized_config, optimization_results = _optimize_injector(
                            config_obj,
                            runner,
                            target_thrust,
                            target_MR,
                            optimize_pintle,
                            optimize_orifices,
                            optimize_spray,
                        )
                        
                        # Store results
                        config_obj = optimized_config
                        st.session_state["optimized_config"] = optimized_config
                        st.session_state["optimization_results"] = optimization_results
                        st.session_state["optimization_before_config"] = config_before
                        
                        # Update config_dict
                        config_dict_updated = optimized_config.model_dump(exclude_none=False)
                        st.session_state["config_dict"] = config_dict_updated
                        
                        st.success("✅ Injector optimization complete!")
                        
                        # Display optimized parameters immediately
                        st.markdown("---")
                        st.markdown("## ✅ Optimization Complete!")
                        
                        # Show before/after comparison
                        _show_injector_comparison(config_before, optimized_config, optimization_results)
                        
                        # Display optimized parameters
                        st.markdown("### 📊 Optimized Injector Parameters")
                        _display_injector_parameters(optimized_config, optimization_results)
                        
                    except Exception as e:
                        st.error(f"Optimization failed: {e}")
                        import traceback
                        st.code(traceback.format_exc())
    
    with col2:
        st.markdown("### Injector Diagnostics")
        if runner:
            try:
                # Get tank pressures (use defaults if not available)
                P_tank_O = 3e6  # 3 MPa default
                P_tank_F = 3e6
                
                results = runner.evaluate(P_tank_O, P_tank_F)
                diagnostics = results.get("diagnostics", {})
                
                # Injector diagnostics
                injector_diag = diagnostics.get("injector_pressure", {})
                if injector_diag:
                    st.metric("Oxidizer Pressure Drop", f"{injector_diag.get('delta_P_O', 0) / 6894.76:.1f} psi")
                    st.metric("Fuel Pressure Drop", f"{injector_diag.get('delta_P_F', 0) / 6894.76:.1f} psi")
                
                # Spray diagnostics
                spray_diag = diagnostics.get("spray_diagnostics", {})
                if spray_diag:
                    st.metric("SMD (Oxidizer)", f"{spray_diag.get('D32_O', 0) * 1e6:.1f} µm")
                    st.metric("SMD (Fuel)", f"{spray_diag.get('D32_F', 0) * 1e6:.1f} µm")
                    st.metric("Evaporation Length", f"{spray_diag.get('x_star', 0) * 1000:.1f} mm")
            except Exception as e:
                st.warning(f"Could not compute diagnostics: {e}")
    
    return config_obj




def _chamber_optimization_tab(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner]) -> PintleEngineConfig:
    """Chamber optimization tab."""
    st.subheader("Chamber Geometry Optimization")
    st.markdown("""
    Optimize chamber geometry (throat, exit, L*) and cooling system (ablative, graphite) to achieve:
    - Target thrust
    - Required stability margins
    - Adequate cooling for burn time
    - Optimal performance
    """)
    
    if runner is None:
        st.warning("⚠️ Runner not available. Please load configuration first.")
        return config_obj
    
    # Get design requirements
    requirements = st.session_state.get("design_requirements", {})
    if not requirements:
        st.warning("⚠️ Please set design requirements in the 'Design Requirements' tab first.")
        return config_obj
    
    col1, col2 = st.columns([2, 1])
    
    with col1:
        st.markdown("### Current Chamber Configuration")
        
        # Display current chamber parameters
        chamber_config = config_obj.chamber if hasattr(config_obj, 'chamber') else None
        if chamber_config:
            col_a, col_b, col_c = st.columns(3)
            with col_a:
                st.metric("Throat Area", f"{chamber_config.A_throat * 1e6:.2f} mm²")
                st.metric("Throat Diameter", f"{np.sqrt(4 * chamber_config.A_throat / np.pi) * 1000:.2f} mm")
            with col_b:
                st.metric("Chamber Volume", f"{chamber_config.volume * 1000:.2f} L")
                st.metric("L*", f"{chamber_config.Lstar * 1000:.1f} mm")
            with col_c:
                st.metric("Chamber Length", f"{chamber_config.length * 1000:.1f} mm")
                st.metric("Chamber Diameter", f"{np.sqrt(4 * chamber_config.volume / (np.pi * chamber_config.length)) * 1000:.1f} mm")
        
        # Nozzle parameters
        nozzle_config = config_obj.nozzle if hasattr(config_obj, 'nozzle') else None
        if nozzle_config:
            st.markdown("#### Nozzle")
            col_a, col_b = st.columns(2)
            with col_a:
                st.metric("Exit Area", f"{nozzle_config.A_exit * 1e6:.2f} mm²")
            with col_b:
                st.metric("Expansion Ratio", f"{nozzle_config.expansion_ratio:.2f}")
        
        # Cooling system status
        st.markdown("#### Cooling System")
        col_a, col_b, col_c = st.columns(3)
        with col_a:
            ablative_enabled = (config_obj.ablative_cooling and 
                              config_obj.ablative_cooling.enabled if hasattr(config_obj, 'ablative_cooling') else False)
            st.metric("Ablative Liner", "✅ Enabled" if ablative_enabled else "❌ Disabled")
        with col_b:
            graphite_enabled = (config_obj.graphite_insert and 
                               config_obj.graphite_insert.enabled if hasattr(config_obj, 'graphite_insert') else False)
            st.metric("Graphite Insert", "✅ Enabled" if graphite_enabled else "❌ Disabled")
        with col_c:
            regen_enabled = (config_obj.regen_cooling and 
                            config_obj.regen_cooling.enabled if hasattr(config_obj, 'regen_cooling') else False)
            st.metric("Regen Cooling", "✅ Enabled" if regen_enabled else "❌ Disabled")
        
        # Optimization controls
        st.markdown("### Optimization Options")
        optimize_chamber = st.checkbox("Enable Chamber Optimization", value=False)
        
        if optimize_chamber:
            st.markdown("#### Optimization Variables")
            
            optimize_geometry = st.checkbox("Optimize Geometry (Throat, Exit, L*)", value=True)
            optimize_cooling = st.checkbox("Optimize Cooling System Sizing", value=True)
            optimize_ablative = st.checkbox("Optimize Ablative Thickness", value=ablative_enabled)
            optimize_graphite = st.checkbox("Optimize Graphite Insert", value=graphite_enabled)
            
            # Get tank pressures for optimization
            P_tank_O = st.number_input(
                "Oxidizer Tank Pressure [Pa]",
                min_value=1e5,
                max_value=10e6,
                value=3e6,
                step=1e5,
                format="%.0f"
            )
            P_tank_F = st.number_input(
                "Fuel Tank Pressure [Pa]",
                min_value=1e5,
                max_value=10e6,
                value=3e6,
                step=1e5,
                format="%.0f"
            )
            
            # Option to use coupled optimization
            use_coupled = st.checkbox(
                "Use Coupled Optimization (Pintle + Chamber)",
                value=True,
                help="Iteratively optimize both pintle and chamber until convergence"
            )
            
            if st.button("🚀 Run Chamber Optimization", type="primary"):
                with st.spinner("Optimizing chamber geometry and cooling system..."):
                    try:
                        if use_coupled:
                            # Use coupled optimizer
                            from engine.pipeline.coupled_optimizer import CoupledPintleChamberOptimizer
                            
                            coupled_optimizer = CoupledPintleChamberOptimizer(config_obj)
                            
                            design_requirements = {
                                "target_thrust": requirements.get("target_thrust", 7000.0),
                                "target_burn_time": requirements.get("target_burn_time", 10.0),
                                "target_stability_margin": requirements.get("min_stability_margin", 1.2),
                                "P_tank_O": P_tank_O,
                                "P_tank_F": P_tank_F,
                                "target_Isp": requirements.get("target_Isp", None),
                            }
                            
                            constraints = {
                                "max_chamber_length": requirements.get("max_chamber_length", 0.5),
                                "max_chamber_diameter": requirements.get("max_chamber_diameter", 0.15),
                                "min_Lstar": 0.95,
                                "max_Lstar": 1.27,
                                "min_expansion_ratio": 3.0,
                                "max_expansion_ratio": 30.0,
                                "max_engine_weight": requirements.get("max_total_mass", None),
                            }
                            
                            coupled_results = coupled_optimizer.optimize_coupled(
                                design_requirements,
                                constraints,
                                max_iterations=10,
                                use_time_varying=True,  # Optimize across entire burn time
                            )
                            
                            optimized_config = coupled_results["optimized_config"]
                            optimization_results = coupled_results
                            
                            # Display convergence info
                            conv_info = coupled_results["convergence_info"]
                            if conv_info["converged"]:
                                st.success(f"✅ Coupled optimization converged after {conv_info['iterations']} iterations!")
                            else:
                                st.warning(f"⚠️ Optimization did not fully converge after {conv_info['iterations']} iterations (change: {conv_info['final_change']*100:.2f}%)")
                            
                        else:
                            # Use single chamber optimization
                            optimized_config, optimization_results = _optimize_chamber(
                            config_obj,
                            runner,
                            requirements,
                            P_tank_O,
                            P_tank_F,
                            optimize_geometry,
                            optimize_cooling,
                            optimize_ablative,
                            optimize_graphite,
                        )
                        
                        # Store results
                        st.session_state["optimized_config"] = optimized_config
                        st.session_state["optimization_results"] = optimization_results
                        st.session_state["optimization_before_config"] = copy.deepcopy(config_obj)  # Store before for comparison
                        
                        # Update main config_dict so changes persist
                        import yaml
                        config_dict_updated = optimized_config.model_dump(exclude_none=False)
                        st.session_state["config_dict"] = config_dict_updated
                        
                        # Display results immediately
                        st.markdown("---")
                        st.markdown("## ✅ Optimization Complete!")
                        
                        # Show before/after comparison
                        _show_optimization_comparison(config_obj, optimized_config, optimization_results)
                        
                        # Display optimized parameters
                        st.markdown("### 📊 Optimized Parameters")
                        _display_optimized_parameters(optimization_results, optimized_config)
                        
                        # Show time-varying results if available
                        # Check both possible locations: direct key and nested in performance
                        time_varying_summary = optimization_results.get("time_varying")
                        if time_varying_summary is None:
                            time_varying_summary = optimization_results.get("performance", {}).get("time_varying")
                        if time_varying_summary:
                            _show_time_varying_results(time_varying_summary)
                        
                        # Also show time-varying plots if array data available
                        if "time_varying_results" in optimization_results:
                            plot_time_varying_results(optimization_results["time_varying_results"])
                        
                        # Update config_obj for return
                        config_obj = optimized_config
                        
                    except Exception as e:
                        st.error(f"Optimization failed: {e}")
                        import traceback
                        st.code(traceback.format_exc())
    
    with col2:
        st.markdown("### Chamber Diagnostics")
        if runner:
            try:
                P_tank_O = 3e6
                P_tank_F = 3e6
                results = runner.evaluate(P_tank_O, P_tank_F)
                
                st.metric("Chamber Pressure", f"{results.get('Pc', 0) / 1e6:.2f} MPa")
                st.metric("Chamber Temperature", f"{results.get('Tc', 0):.0f} K")
                st.metric("Thrust", f"{results.get('F', 0):.1f} N")
                st.metric("Isp", f"{results.get('Isp', 0):.1f} s")
                st.metric("c* (actual)", f"{results.get('cstar_actual', 0):.0f} m/s")
                
                # Chamber intrinsics
                intrinsics = results.get("chamber_intrinsics", {})
                if intrinsics:
                    st.metric("L*", f"{intrinsics.get('Lstar', 0) * 1000:.1f} mm")
                    st.metric("Mach Number", f"{intrinsics.get('mach_number', 0):.3f}")
                    st.metric("Residence Time", f"{intrinsics.get('residence_time', 0) * 1000:.2f} ms")
            except Exception as e:
                st.warning(f"Could not compute diagnostics: {e}")
    
    return config_obj




def _stability_analysis_tab(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner]) -> None:
    """Stability analysis tab."""
    st.subheader("Stability Margin Analysis")
    st.markdown("""
    Comprehensive stability analysis including:
    - Chugging stability (feed system coupling)
    - Acoustic stability (combustion instabilities)
    - Feed system stability (pressure oscillations)
    """)
    
    if runner is None:
        st.warning("⚠️ Runner not available. Please load configuration first.")
        return
    
    # Get requirements
    requirements = st.session_state.get("design_requirements", {})
    min_stability_margin = requirements.get("min_stability_margin", 1.2)
    
    col1, col2 = st.columns([2, 1])
    
    with col1:
        # Run stability analysis
        P_tank_O = st.number_input(
            "Oxidizer Tank Pressure [Pa]",
            min_value=1e5,
            max_value=10e6,
            value=3e6,
            step=1e5,
            format="%.0f",
            key="stability_P_tank_O"
        )
        P_tank_F = st.number_input(
            "Fuel Tank Pressure [Pa]",
            min_value=1e5,
            max_value=10e6,
            value=3e6,
            step=1e5,
            format="%.0f",
            key="stability_P_tank_F"
        )
        
        if st.button("🔍 Analyze Stability", type="primary"):
            with st.spinner("Running stability analysis..."):
                try:
                    results = runner.evaluate(P_tank_O, P_tank_F)
                    stability_results = results.get("stability_results", {})
                    
                    # Display stability margins
                    st.markdown("### Stability Margins")
                    
                    col_a, col_b, col_c = st.columns(3)
                    
                    # Chugging stability
                    chugging = stability_results.get("chugging", {})
                    chugging_margin = chugging.get("stability_margin", 0.0)
                    chugging_freq = chugging.get("frequency", 0.0)
                    
                    with col_a:
                        margin_color = "🟢" if chugging_margin >= min_stability_margin else "🔴"
                        st.metric(
                            f"{margin_color} Chugging Margin",
                            f"{chugging_margin:.3f}",
                            delta=f"Target: {min_stability_margin:.2f}"
                        )
                        st.caption(f"Frequency: {chugging_freq:.1f} Hz")
                    
                    # Acoustic stability
                    acoustic = stability_results.get("acoustic", {})
                    acoustic_margin = acoustic.get("stability_margin", 0.0)
                    acoustic_modes = acoustic.get("modes", {})
                    
                    with col_b:
                        margin_color = "🟢" if acoustic_margin >= min_stability_margin else "🔴"
                        st.metric(
                            f"{margin_color} Acoustic Margin",
                            f"{acoustic_margin:.3f}",
                            delta=f"Target: {min_stability_margin:.2f}"
                        )
                        if acoustic_modes:
                            first_mode = list(acoustic_modes.values())[0] if acoustic_modes else 0.0
                            st.caption(f"1st Mode: {first_mode:.1f} Hz")
                    
                    # Feed system stability
                    feed = stability_results.get("feed_system", {})
                    feed_margin = feed.get("stability_margin", 0.0)
                    
                    with col_c:
                        margin_color = "🟢" if feed_margin >= min_stability_margin else "🔴"
                        st.metric(
                            f"{margin_color} Feed System Margin",
                            f"{feed_margin:.3f}",
                            delta=f"Target: {min_stability_margin:.2f}"
                        )
                    
                    # Overall status
                    all_stable = (chugging_margin >= min_stability_margin and
                                 acoustic_margin >= min_stability_margin and
                                 feed_margin >= min_stability_margin)
                    
                    if all_stable:
                        st.success("✅ All stability margins meet requirements!")
                    else:
                        st.warning("⚠️ Some stability margins are below requirements. Consider optimization.")
                    
                    # Plot stability over time (if time-series available)
                    st.markdown("### Stability Evolution")
                    if st.checkbox("Show time-varying stability", value=False):
                        _plot_stability_evolution(runner, P_tank_O, P_tank_F)
                    
                except Exception as e:
                    st.error(f"Stability analysis failed: {e}")
                    import traceback
                    st.code(traceback.format_exc())
    
    with col2:
        st.markdown("### Stability Guidelines")
        st.info("""
        **Chugging Stability:**
        - Margin > 1.2 (20% margin) recommended
        - Affected by: injector design, feed system, chamber geometry
        
        **Acoustic Stability:**
        - Margin > 1.2 recommended
        - Affected by: chamber length, L*, injector design
        
        **Feed System Stability:**
        - Margin > 1.15 recommended
        - Affected by: tank pressures, line sizes, injector pressure drops
        """)




def _flight_performance_tab(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner]) -> None:
    """Flight performance tab."""
    st.subheader("Flight Performance Analysis")
    st.markdown("""
    Analyze flight performance including:
    - Altitude capability
    - Payload capacity
    - Trajectory optimization
    """)
    
    if runner is None:
        st.warning("⚠️ Runner not available. Please load configuration first.")
        return
    
    requirements = st.session_state.get("design_requirements", {})
    target_altitude = requirements.get("target_apogee", 3048.0)
    
    col1, col2 = st.columns([2, 1])
    
    with col1:
        st.markdown("### Flight Simulation")
        
        if st.button("✈️ Run Flight Simulation", type="primary"):
            with st.spinner("Running flight simulation..."):
                try:
                    from ui.flight_sim import setup_flight
                    from ui.interactive_pipeline import solve_for_thrust
                    
                    # Generate thrust curve
                    P_tank_O = 3e6
                    P_tank_F = 3e6
                    
                    # Run flight simulation
                    # (Implementation would go here)
                    
                    st.success("✅ Flight simulation complete!")
                    st.info("Flight simulation results would be displayed here.")
                    
                except Exception as e:
                    st.error(f"Flight simulation failed: {e}")
                    import traceback
                    st.code(traceback.format_exc())
    
    with col2:
        st.markdown("### Performance Targets")
        st.metric("Target Altitude", f"{target_altitude:.0f} m")
        st.metric("Target Thrust", f"{requirements.get('target_thrust', 7000):.0f} N")




def _results_export_tab(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner]) -> None:
    """Results and export tab."""
    st.subheader("Optimization Results & Export")
    
    optimized_config = st.session_state.get("optimized_config", None)
    optimization_results = st.session_state.get("optimization_results", None)
    
    if optimized_config and optimization_results:
        st.success("✅ Optimized configuration available!")
        
        # Display summary
        st.markdown("### 📊 Optimization Summary")
        
        # Show optimized parameters
        _display_optimized_parameters(optimization_results, optimized_config)
        
        # Show time-varying plot if available
        if "time_varying_results" in optimization_results:
            st.markdown("### ⏱️ Time-Varying Performance")
            plot_time_varying_results(optimization_results["time_varying_results"])
        
        # Compare before/after
        config_before = st.session_state.get("optimization_before_config", None)
        if config_before and runner:
            try:
                P_tank_O = 3e6
                P_tank_F = 3e6
                
                # Before
                results_before = runner.evaluate(P_tank_O, P_tank_F)
                
                # After
                runner_opt = PintleEngineRunner(optimized_config)
                results_after = runner_opt.evaluate(P_tank_O, P_tank_F)
                
                # Comparison table
                comparison_data = {
                    "Metric": ["Thrust [N]", "Isp [s]", "Chamber Pressure [MPa]", "Stability Margin"],
                    "Before": [
                        f"{results_before.get('F', 0):.1f}",
                        f"{results_before.get('Isp', 0):.1f}",
                        f"{results_before.get('Pc', 0) / 1e6:.2f}",
                        f"{results_before.get('stability_results', {}).get('chugging', {}).get('stability_margin', 0):.3f}",
                    ],
                    "After": [
                        f"{results_after.get('F', 0):.1f}",
                        f"{results_after.get('Isp', 0):.1f}",
                        f"{results_after.get('Pc', 0) / 1e6:.2f}",
                        f"{results_after.get('stability_results', {}).get('chugging', {}).get('stability_margin', 0):.3f}",
                    ],
                }
                df_comparison = pd.DataFrame(comparison_data)
                st.dataframe(df_comparison, use_container_width=True)
                
            except Exception as e:
                st.warning(f"Could not compare results: {e}")
        
        # Export options
        st.markdown("### Export Configuration")
        if st.button("💾 Export Optimized Config (YAML)"):
            try:
                import yaml
                from engine.pipeline.io import save_config
                
                # Save config
                config_dict = optimized_config.model_dump(exclude_none=False)
                yaml_str = yaml.dump(config_dict, default_flow_style=False)
                
                st.download_button(
                    label="Download YAML",
                    data=yaml_str,
                    file_name="optimized_engine_config.yaml",
                    mime="text/yaml"
                )
            except Exception as e:
                st.error(f"Export failed: {e}")
    else:
        st.info("No optimized configuration available. Run optimization in Injector or Chamber tabs.")


def _layer1_tab(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner]) -> PintleEngineConfig:
    """Layer 1: Static Optimization tab."""
    st.subheader("Layer 1: Static Optimization")
    st.markdown("""
    **Layer 1** optimizes only **static** quantities:
    - **Engine geometry**: throat area, L*, expansion ratio, pintle parameters
    - **Initial tank pressures**: single starting LOX and fuel tank pressures (no time history)

    This layer evaluates at t=0 (static) to find an engine geometry and initial tank pressures
    that meet the target thrust/O/F and stability requirements. All time‑varying pressure curves
    and thermal protection sizing are handled in downstream layers (Layer 2/3).
    """)
    
    if runner is None:
        st.warning("⚠️ Runner not available. Please load configuration first.")
        return config_obj
    
    requirements = st.session_state.get("design_requirements", {})
    if not requirements:
        st.warning("⚠️ Please set design requirements in the 'Design Requirements' tab first.")
        return config_obj
    
    # Check for optimization results
    optimization_results = st.session_state.get("optimization_results", None)
    layer_status = optimization_results.get("layer_status", {}) if optimization_results else {}
    layer1_valid = layer_status.get("layer_1_pressure_candidate", False)
    
    st.markdown("---")
    st.markdown("### Run Layer 1 Individually")
    
    col_run1, col_run2 = st.columns([1, 1])
    with col_run1:
        max_iterations = st.number_input(
            "Max Iterations",
            min_value=20,
            max_value=200,
            value=80,
            step=10,
            key="layer1_max_iter",
            help="Maximum optimization iterations for Layer 1"
        )
    with col_run2:
        thrust_tolerance = st.number_input(
            "Thrust Tolerance [%]",
            min_value=1.0,
            max_value=20.0,
            value=10.0,
            step=1.0,
            key="layer1_thrust_tol",
            help="Acceptable deviation from target thrust"
        ) / 100.0
    
    # Live objective convergence plot container (persists while optimization runs)
    st.markdown("#### Layer 1 Objective Convergence")
    objective_plot_container = st.empty()
    
    if st.button("🚀 Run Layer 1 Optimization", type="primary", key="run_layer1"):
        try:
            target_burn_time = requirements.get("target_burn_time", 10.0)
            max_lox_pressure_psi = float(requirements.get("max_lox_tank_pressure_psi", 700))
            max_fuel_pressure_psi = float(requirements.get("max_fuel_tank_pressure_psi", 850))
            
            pressure_config = {
                "mode": "optimizer_controlled",
                "max_lox_pressure_psi": max_lox_pressure_psi,
                "max_fuel_pressure_psi": max_fuel_pressure_psi,
                "target_burn_time": target_burn_time,
                "n_segments": 3,
            }
            
            tolerances = {
                "thrust": thrust_tolerance,
                "apogee": 0.15,  # Not used for Layer 1
            }
            
            # Reset any previous objective history
            st.session_state["layer1_objective_history"] = []
            
            progress_bar = st.progress(0, text="Initializing Layer 1 optimization...")
            status_text = st.empty()
            
            def progress_callback(stage: str, progress: float, message: str):
                progress_bar.progress(progress, text=f"{stage}\n{message}")
                status_text.text(f"{stage} | {message}")
            
            def objective_callback(iteration: int, objective: float, best_objective: float):
                """Stream Layer 1 objective history into a live-updating convergence plot."""
                try:
                    history = st.session_state.get("layer1_objective_history", [])
                    history.append(
                        {
                            "iteration": int(iteration),
                            "objective": float(objective),
                            "best_objective": float(best_objective),
                        }
                    )
                    st.session_state["layer1_objective_history"] = history

                    if not history:
                        return

                    df = pd.DataFrame(history)
                    fig = go.Figure()
                    fig.add_trace(
                        go.Scatter(
                            x=df["iteration"],
                            y=df["objective"],
                            mode="lines+markers",
                            name="Objective",
                            line=dict(color="#1f77b4"),
                        )
                    )
                    fig.add_trace(
                        go.Scatter(
                            x=df["iteration"],
                            y=df["best_objective"],
                            mode="lines",
                            name="Best Objective",
                            line=dict(color="#ff7f0e", dash="dash"),
                        )
                    )
                    fig.update_layout(
                        xaxis_title="Iteration",
                        yaxis_title="Objective Value",
                        yaxis_type="log",
                        height=300,
                        margin=dict(l=40, r=20, t=30, b=40),
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                    )
                    objective_plot_container.plotly_chart(fig, use_container_width=True)
                except Exception:
                    # Never let plotting errors break the optimization loop
                    pass
            
            # Run Layer 1 optimization directly
            optimized_config, optimization_results = run_layer1_optimization(
                config_obj=config_obj,
                runner=runner,
                requirements=requirements,
                target_burn_time=target_burn_time,
                max_iterations=max_iterations,
                tolerances=tolerances,
                pressure_config=pressure_config,
                update_progress=progress_callback,
                log_status=lambda stage, msg: status_text.text(f"{stage} | {msg}"),
                objective_callback=objective_callback,
            )
            
            progress_bar.empty()
            status_text.empty()
            
            # Store results
            config_obj = optimized_config
            st.session_state["optimized_config"] = optimized_config
            st.session_state["optimization_results"] = optimization_results
            st.session_state["layer1_results"] = optimization_results
            
            # Update config_dict
            config_dict_updated = optimized_config.model_dump(exclude_none=False)
            st.session_state["config_dict"] = config_dict_updated
            
            st.success("✅ Layer 1 optimization complete!")
            st.rerun()
            
        except Exception as e:
            st.error(f"Layer 1 optimization failed: {e}")
            import traceback
            st.code(traceback.format_exc())
    
    st.markdown("---")
    st.markdown("### Layer 1 Status")
    if optimization_results and layer1_valid is not None:
        # ------------------------------------------------------------------
        # Convergence / validity summary
        # ------------------------------------------------------------------
        convergence_info = optimization_results.get("convergence_info", {})
        converged_flag = bool(convergence_info.get("converged", False))
        iteration_history = optimization_results.get("iteration_history", []) or []
        total_iterations = int(convergence_info.get("iterations", len(iteration_history)))
        final_change = convergence_info.get("final_change", None)

        cols_status = st.columns(3)
        with cols_status[0]:
            if layer1_valid:
                st.success("✅ Layer 1: Pressure Candidate VALID")
            else:
                st.error("❌ Layer 1: Pressure Candidate INVALID")
        with cols_status[1]:
            st.metric("Converged", "Yes" if converged_flag else "No")
        with cols_status[2]:
            st.metric("Total Iterations", f"{total_iterations}")

        if final_change is not None and np.isfinite(final_change):
            st.caption(
                f"Convergence uses max relative geometry change between coupled pintle/chamber iterations "
                f"(final change: {final_change:.3e})."
            )

        # Optional: simple thrust error metric vs design target
        performance = optimization_results.get("performance", {}) or {}
        target_thrust = requirements.get("target_thrust")
        if performance and target_thrust:
            thrust_val = performance.get("thrust") or performance.get("F")
            if thrust_val is not None:
                thrust_err_pct = abs(thrust_val - target_thrust) / max(target_thrust, 1e-6) * 100.0
                st.metric("Thrust Error", f"{thrust_err_pct:.1f} %")

        # ------------------------------------------------------------------
        # Objective history (from optimization loop), if available
        # (Detailed multi-panel convergence dashboard removed for Layer 1 tab
        #  to keep the UI focused on the objective history and parameterization
        #  variable history.)
        history = st.session_state.get("layer1_objective_history", [])
        if history:
            df_hist = pd.DataFrame(history)
            obj_fig = go.Figure()
            obj_fig.add_trace(
                go.Scatter(
                    x=df_hist["iteration"],
                    y=df_hist["objective"],
                    mode="lines+markers",
                    name="Objective",
                    line=dict(color="#1f77b4"),
                )
            )
            obj_fig.add_trace(
                go.Scatter(
                    x=df_hist["iteration"],
                    y=df_hist["best_objective"],
                    mode="lines",
                    name="Best Objective",
                    line=dict(color="#ff7f0e", dash="dash"),
                )
            )
            obj_fig.update_layout(
                title="Layer 1 Objective Function History",
                xaxis_title="Iteration",
                yaxis_title="Objective Value",
                yaxis_type="log",
                height=300,
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            )
            st.plotly_chart(obj_fig, use_container_width=True, key="layer1_objective_history_plot")
        
        # NOTE:
        # Historically this tab showed an additional multi-panel parameterization
        # history dashboard implemented in `display_results.plot_layer1_parameterization_history`.
        # To keep the Layer 1-only page minimal (and fully decoupled from
        # `display_results`), that dashboard has been removed from this tab.
        # The underlying history is still recorded in `optimization_results`
        # for use by the full-engine views or offline analysis if desired.
        
        # ------------------------------------------------------------------
        # Performance metrics at t = 0 (forward mode)
        # ------------------------------------------------------------------
        if performance:
            # Explicitly show the tank pressures at which performance is evaluated
            P_O_start_psi = performance.get("P_O_start_psi")
            P_F_start_psi = performance.get("P_F_start_psi")
            if P_O_start_psi is not None or P_F_start_psi is not None:
                st.markdown("#### Evaluation Tank Pressures (t = 0)")
                col_p1, col_p2 = st.columns(2)
                with col_p1:
                    if P_O_start_psi is not None:
                        st.metric("LOX Tank Pressure", f"{P_O_start_psi:.1f} psi")
                with col_p2:
                    if P_F_start_psi is not None:
                        st.metric("Fuel Tank Pressure", f"{P_F_start_psi:.1f} psi")

            st.markdown("#### Performance at t = 0 (Forward Mode Metrics)")
            PA_TO_PSI = 1.0 / 6894.76  # Conversion factor: Pa to psi
            
            # Try to get Cf and P_exit from performance dict, or calculate Cf if needed
            Cf_actual = performance.get("Cf_actual", performance.get("Cf"))
            if Cf_actual is None:
                # Calculate Cf from F, Pc, and A_throat if available
                F_val = performance.get("thrust", performance.get("F"))
                Pc_val = performance.get("Pc")
                if F_val is not None and Pc_val is not None:
                    A_throat_val = getattr(config_obj.chamber, "A_throat", None)
                    if A_throat_val and A_throat_val > 0 and Pc_val > 0:
                        Cf_actual = F_val / (Pc_val * A_throat_val)
            
            P_exit_actual = performance.get("P_exit")
            
            col1, col2, col3, col4 = st.columns(4)
            with col1:
                if "thrust" in performance or "F" in performance:
                    thrust_val = performance.get("thrust", performance.get("F", 0))
                    st.metric("Thrust", f"{thrust_val:.0f} N")
                if "Isp" in performance:
                    st.metric("Isp", f"{performance['Isp']:.1f} s")
            with col2:
                if "Pc" in performance:
                    st.metric("Chamber Pressure", f"{performance['Pc'] * PA_TO_PSI:.1f} psi")
                if P_exit_actual is not None:
                    st.metric("Exit Pressure", f"{P_exit_actual * PA_TO_PSI:.2f} psi")
                # Show target exit pressure if available from optimizer
                exit_targeting = optimization_results.get("exit_pressure_targeting", {})
                target_P_exit = exit_targeting.get("target_P_exit", None)
                if target_P_exit is not None:
                    st.metric("Target Exit Pressure", f"{target_P_exit * PA_TO_PSI:.2f} psi")
            with col3:
                if "mdot_total" in performance:
                    st.metric("Total Mass Flow", f"{performance['mdot_total']:.3f} kg/s")
                if "mdot_O" in performance:
                    st.metric("Oxidizer Flow", f"{performance['mdot_O']:.3f} kg/s")
                # Display Cf prominently in this column
                if Cf_actual is not None:
                    st.metric("Cf (Thrust Coefficient)", f"{Cf_actual:.3f}")
            with col4:
                if "mdot_F" in performance:
                    st.metric("Fuel Flow", f"{performance['mdot_F']:.3f} kg/s")
                if "MR" in performance:
                    st.metric("O/F Ratio", f"{performance['MR']:.3f}")

            # Additional nozzle / performance metrics
            col5, col6, col7 = st.columns(3)
            with col5:
                if "cstar_actual" in performance:
                    st.metric("c* (actual)", f"{performance['cstar_actual']:.1f} m/s")
            with col6:
                if "v_exit" in performance:
                    st.metric("Exit Velocity", f"{performance['v_exit']:.1f} m/s")
            with col7:
                # Show Cf again here if not shown above, or show additional metrics
                if Cf_actual is None:
                    st.metric("Cf (Thrust Coefficient)", "N/A")
                # Could show other metrics here if needed

        # ------------------------------------------------------------------
        # Full optimization-variable convergence history (all 12 variables)
        # ------------------------------------------------------------------
        try:
            st.markdown("#### Layer 1 Parameterization Convergence (All Optimization Variables)")
            plot_layer1_parameterization_history(optimization_results)
        except Exception as e:
            st.warning(f"Could not plot Layer 1 parameterization history: {e}")

        # ------------------------------------------------------------------
        # Optimizer parameters table (geometry + injector + initial pressures)
        # ------------------------------------------------------------------
        st.markdown("#### Optimizer Parameters")
        opt_params = optimization_results.get("optimized_parameters", {}) or {}

        # Fallbacks from config if optimizer did not return explicit parameters
        if not opt_params:
            opt_params = {
                "A_throat": getattr(config_obj.chamber, "A_throat", None),
                "A_exit": getattr(config_obj.nozzle, "A_exit", None),
                "Lstar": getattr(config_obj.chamber, "Lstar", None),
                "chamber_diameter": getattr(
                    config_obj.chamber,
                    "chamber_inner_diameter",
                    np.sqrt(
                        4.0 * getattr(config_obj.chamber, "volume", 0.0)
                        / (np.pi * max(getattr(config_obj.chamber, "length", 1e-6), 1e-6))
                    ),
                ),
                "chamber_length": getattr(config_obj.chamber, "length", None),
                "expansion_ratio": getattr(config_obj.nozzle, "expansion_ratio", None),
            }

        # Pintle injector details from config
        injector_geom = getattr(getattr(config_obj, "injector", None), "geometry", None)
        if injector_geom is not None:
            fuel_geom = getattr(injector_geom, "fuel", None)
            lox_geom = getattr(injector_geom, "lox", None)
            if fuel_geom is not None:
                opt_params.setdefault("d_pintle_tip", getattr(fuel_geom, "d_pintle_tip", None))
            if lox_geom is not None:
                opt_params.setdefault("n_orifices", getattr(lox_geom, "n_orifices", None))
                opt_params.setdefault("d_orifice", getattr(lox_geom, "d_orifice", None))

        rows = []

        # Initial tank pressures (psi)
        P_O_start_psi = performance.get("P_O_start_psi")
        P_F_start_psi = performance.get("P_F_start_psi")
        if P_O_start_psi is not None:
            rows.append({"Parameter": "Init LOX Pressure", "Value": f"{P_O_start_psi:.1f}", "Units": "psi"})
        if P_F_start_psi is not None:
            rows.append({"Parameter": "Init Fuel Pressure", "Value": f"{P_F_start_psi:.1f}", "Units": "psi"})

        # Chamber / nozzle geometry
        A_throat = opt_params.get("A_throat")
        A_exit = opt_params.get("A_exit")
        Lstar_val = opt_params.get("Lstar", None)
        D_inner = opt_params.get("chamber_diameter")
        L_chamber = opt_params.get("chamber_length", None)
        exp_ratio = opt_params.get("expansion_ratio")
        
        # Add L*, Inner Diameter, and Chamber Length back to table
        if Lstar_val is not None:
            rows.append({"Parameter": "L*", "Value": f"{Lstar_val:.4f}", "Units": "m"})
        if D_inner is not None:
            rows.append({"Parameter": "Inner Diameter", "Value": f"{D_inner*1000:.2f}", "Units": "mm"})
        if L_chamber is not None:
            rows.append({"Parameter": "Chamber Length", "Value": f"{L_chamber*1000:.2f}", "Units": "mm"})

        # Calculate chamber outer diameter
        D_outer = None
        if D_inner is not None:
            # Get wall thicknesses from config
            ablative_cfg = getattr(config_obj, "ablative_cooling", None)
            stainless_cfg = getattr(config_obj, "stainless_steel_case", None)
            
            wall_thickness = 0.0
            if ablative_cfg and getattr(ablative_cfg, "enabled", False):
                ablative_thickness = getattr(ablative_cfg, "initial_thickness", 0.0)
                wall_thickness += ablative_thickness
            if stainless_cfg and getattr(stainless_cfg, "enabled", False):
                stainless_thickness = getattr(stainless_cfg, "thickness", 0.0)
                wall_thickness += stainless_thickness
            
            D_outer = D_inner + 2.0 * wall_thickness
        
        if exp_ratio is not None:
            rows.append({"Parameter": "Expansion Ratio", "Value": f"{exp_ratio:.3f}", "Units": "-"})

        if A_throat is not None:
            D_throat = np.sqrt(4 * A_throat / np.pi)
            rows.append({"Parameter": "Throat Diameter", "Value": f"{D_throat*1000:.2f}", "Units": "mm"})
            rows.append({"Parameter": "Throat Area", "Value": f"{A_throat*1e6:.2f}", "Units": "mm²"})
        if A_exit is not None:
            D_exit = np.sqrt(4 * A_exit / np.pi)
            rows.append({"Parameter": "Exit Diameter", "Value": f"{D_exit*1000:.2f}", "Units": "mm"})
            rows.append({"Parameter": "Exit Area", "Value": f"{A_exit*1e6:.2f}", "Units": "mm²"})
        
        # Add chamber outer diameter if calculated
        if D_outer is not None:
            rows.append({"Parameter": "Chamber Outer Diameter", "Value": f"{D_outer*1000:.2f}", "Units": "mm"})

        # Injector parameters
        if opt_params.get("d_pintle_tip") is not None:
            rows.append(
                {
                    "Parameter": "Pintle Tip Diameter",
                    "Value": f"{opt_params['d_pintle_tip']*1000:.2f}",
                    "Units": "mm",
                }
            )
        if opt_params.get("n_orifices") is not None:
            rows.append(
                {
                    "Parameter": "Number of Orifices",
                    "Value": f"{int(opt_params['n_orifices'])}",
                    "Units": "-",
                }
            )
        if opt_params.get("d_orifice") is not None:
            rows.append(
                {
                    "Parameter": "Orifice Diameter",
                    "Value": f"{opt_params['d_orifice']*1000:.2f}",
                    "Units": "mm",
                }
            )

        if rows:
            df_params = pd.DataFrame(rows)
            st.table(df_params)

        # ------------------------------------------------------------------
        # Chamber geometry visualizer (visual only)
        # ------------------------------------------------------------------
        st.markdown("#### Chamber Geometry Visualizer (Layer 1 Result)")
        try:
            from engine.pipeline.chamber_geometry_visualizer import (
                calculate_chamber_geometry_clear,
                plot_chamber_geometry_clear,
            )

            # Safe geometry extraction (no recession here – static layer)
            A_throat_vis = getattr(config_obj.chamber, "A_throat", A_throat or 1e-4)
            D_throat_vis = np.sqrt(4 * A_throat_vis / np.pi)
            D_chamber_vis = getattr(config_obj.chamber, "chamber_inner_diameter", D_inner or 0.08)
            V_chamber_vis = getattr(config_obj.chamber, "volume", 0.001)
            L_chamber_vis = getattr(config_obj.chamber, "length", L_chamber or 0.2)
            Lstar_vis = getattr(config_obj.chamber, "Lstar", Lstar_val or 1.0)

            L_nozzle_vis = getattr(config_obj.nozzle, "length", 0.1) if hasattr(config_obj, "nozzle") else 0.1
            exp_ratio_vis = getattr(
                config_obj.nozzle,
                "expansion_ratio",
                exp_ratio if exp_ratio is not None else 10.0,
            )

            ablative_cfg = getattr(config_obj, "ablative_cooling", None)
            graphite_cfg = getattr(config_obj, "graphite_insert", None)

            # Validate diameters with simple fallbacks
            if D_chamber_vis <= 0 and V_chamber_vis > 0 and L_chamber_vis > 0:
                D_chamber_vis = np.sqrt(4.0 * V_chamber_vis / (np.pi * L_chamber_vis))
            if D_throat_vis <= 0 and A_throat_vis > 0:
                D_throat_vis = np.sqrt(4.0 * A_throat_vis / np.pi)

            geom_clear = calculate_chamber_geometry_clear(
                L_chamber=L_chamber_vis,
                D_chamber=D_chamber_vis,
                D_throat=D_throat_vis,
                L_nozzle=L_nozzle_vis,
                expansion_ratio=exp_ratio_vis,
                ablative_config=ablative_cfg,
                graphite_config=graphite_cfg,
                recession_chamber=0.0,
                recession_graphite=0.0,
                n_points=200,
            )

            fig_geom = plot_chamber_geometry_clear(geom_clear, config_obj)
            st.plotly_chart(fig_geom, use_container_width=True, key="layer1_chamber_contour_plot")
        except Exception as e:
            st.warning(f"Could not render chamber geometry visualization: {e}")

        # ------------------------------------------------------------------
        # Layer 1 export for downstream Layer 2-only runs
        # ------------------------------------------------------------------
        st.markdown("#### Export Layer 1 Results for Layer 2")
        perf = optimization_results.get("performance", {}) if isinstance(optimization_results, dict) else {}

        # Start from the optimized PintleEngineConfig as YAML.
        config_dict = config_obj.model_dump(exclude_none=False) if hasattr(config_obj, "model_dump") else {}

        # Attach design requirements so Layer 2-only workflows can recover them.
        config_dict.setdefault("design_requirements", requirements)

        # Optionally attach the initial LOX/fuel tank pressures (psi) used in Layer 1.
        P_O_start_psi = perf.get("P_O_start_psi")
        P_F_start_psi = perf.get("P_F_start_psi")
        if P_O_start_psi is not None:
            config_dict["initial_lox_tank_pressure_psi"] = float(P_O_start_psi)
        if P_F_start_psi is not None:
            config_dict["initial_fuel_tank_pressure_psi"] = float(P_F_start_psi)

        import yaml

        yaml_str = yaml.dump(config_dict, default_flow_style=False)

        st.download_button(
            label="💾 Download Layer 1 Optimized Config (YAML)",
            data=yaml_str,
            file_name="layer1_optimized_config.yaml",
            mime="text/yaml",
            help="Download the optimized Layer 1 PintleEngineConfig as YAML, including design requirements and optional initial LOX/fuel tank pressures.",
        )
    else:
        st.info("💡 Layer 1 has not been run yet. Click 'Run Layer 1 Optimization' above or use the Full Engine Optimizer.")
    
    return config_obj


def _layer2_tab(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner]) -> PintleEngineConfig:
    """Layer 2: Pressure Candidate Optimization tab."""
    st.subheader("Layer 2: Pressure Candidate")
    st.markdown("""
    **Layer 2** optimizes the time-varying LOX and fuel tank pressure curves (the **pressure candidate**)
    using full-burn time-series analysis.
    
    This layer:
    - Uses the Layer 1 static solution as a starting point
    - Optimizes segmented tank pressure profiles over the burn
    - Checks impulse vs. target apogee, tank capacity limits, stability margins, and O/F ratio
    - Produces a validated pressure candidate for downstream thermal and flight analysis
    """)
    
    if runner is None:
        st.warning("⚠️ Runner not available. Please load configuration first.")
        return config_obj
    
    requirements = st.session_state.get("design_requirements", {})
    if not requirements:
        st.warning("⚠️ Please set design requirements in the 'Design Requirements' tab first.")
        return config_obj
    
    # Check for Layer 1 results (prerequisite) – now optional if user uploads a Layer 1 file.
    layer1_results = st.session_state.get("layer1_results") or st.session_state.get("optimization_results")
    layer1_config = st.session_state.get("optimized_config", config_obj)

    st.markdown("---")
    st.markdown("### Run Layer 2 Individually")

    # Optional: allow user to upload a Layer 1 optimized config YAML produced by the Layer 1 tab.
    st.markdown("#### Optional: Load Layer 1 Optimized Config (YAML)")
    uploaded_layer1_file = st.file_uploader(
        "Upload `layer1_optimized_config.yaml`",
        type=["yaml", "yml"],
        key="layer2_layer1_upload",
        help="If provided, Layer 2 will use the optimized PintleEngineConfig (and optional initial LOX/Fuel tank pressures) from this file.",
    )

    uploaded_layer1_dict = None
    uploaded_layer1_config: Optional[PintleEngineConfig] = None
    if uploaded_layer1_file is not None:
        import yaml
        try:
            uploaded_layer1_dict = yaml.safe_load(uploaded_layer1_file.read())
            if isinstance(uploaded_layer1_dict, dict):
                uploaded_layer1_config = PintleEngineConfig(**uploaded_layer1_dict)
            else:
                st.error("Uploaded Layer 1 file did not contain a valid mapping/object.")
                uploaded_layer1_dict = None
        except Exception as e:
            st.error(f"Could not parse uploaded Layer 1 YAML: {e}")
            uploaded_layer1_dict = None
            uploaded_layer1_config = None

    # Live objective convergence plot container (persists while optimization runs)
    st.markdown("#### Layer 2 Objective Convergence")
    objective_plot_container = st.empty()
    
    if st.button("🚀 Run Layer 2 Optimization", type="primary", key="run_layer2"):
        try:
            # Basic design/flight requirements
            target_burn_time = requirements.get("target_burn_time", 10.0)
            peak_thrust = requirements.get("target_thrust", 7000.0)
            target_apogee_m = requirements.get("target_apogee", 3048.0)  # default ~10k ft
            optimal_of_ratio = requirements.get("optimal_of_ratio", None)
            min_stability_margin = requirements.get("min_stability_margin", None)
            
            # Rocket dry mass (stored by design requirements tab)
            rocket_dry_mass_kg = st.session_state.get("rocket_dry_mass", None)
            if rocket_dry_mass_kg is None:
                # Fallback: approximate from stored design config if available
                design_cfg = st.session_state.get("design_config", {})
                rocket_cfg = design_cfg.get("rocket", {}) if isinstance(design_cfg, dict) else {}
                airframe_mass = float(rocket_cfg.get("airframe_mass") or 0.0)
                propulsion_dry_mass = float(rocket_cfg.get("propulsion_dry_mass") or 0.0)
                rocket_dry_mass_kg = airframe_mass + propulsion_dry_mass
            
            # Resolve base config for Layer 2 and initial tank pressures.
            psi_to_Pa = 6894.76

            # Prefer the uploaded optimized config if present; otherwise fall back to the in-memory Layer 1 optimized config.
            base_layer2_config = uploaded_layer1_config or layer1_config

            # Tank capacities: ``tank_volume_m3`` (or π r² h) × ``fluids`` density; optional tab overrides; then defaults
            max_lox_tank_capacity_kg, max_fuel_tank_capacity_kg = resolve_layer2_tank_capacities_kg(
                base_layer2_config,
                design_lox_kg=requirements.get("lox_tank_capacity_kg"),
                design_fuel_kg=requirements.get("fuel_tank_capacity_kg"),
                default_lox_kg=10.0,
                default_fuel_kg=10.0,
            )

            P_O_start_psi = None
            P_F_start_psi = None

            # 1) Try to read explicit initial tank pressures from the uploaded YAML.
            if uploaded_layer1_dict and isinstance(uploaded_layer1_dict, dict):
                P_O_start_psi = uploaded_layer1_dict.get("initial_lox_tank_pressure_psi", None)
                P_F_start_psi = uploaded_layer1_dict.get("initial_fuel_tank_pressure_psi", None)

            # 2) Fall back to in‑memory Layer 1 performance metrics, if available.
            if (P_O_start_psi is None or P_F_start_psi is None) and layer1_results:
                performance = layer1_results.get("performance", {}) if isinstance(layer1_results, dict) else {}
                if P_O_start_psi is None:
                    P_O_start_psi = performance.get("P_O_start_psi", None)
                if P_F_start_psi is None:
                    P_F_start_psi = performance.get("P_F_start_psi", None)

            if P_O_start_psi is None or P_F_start_psi is None:
                st.error(
                    "❌ Initial LOX/Fuel tank pressures are missing. "
                    "Either upload a Layer 1 optimized config that includes "
                    "`initial_lox_tank_pressure_psi` and `initial_fuel_tank_pressure_psi`, "
                    "or run Layer 1 in this session first."
                )
                return config_obj

            initial_lox_pressure_pa = float(P_O_start_psi) * psi_to_Pa
            initial_fuel_pressure_pa = float(P_F_start_psi) * psi_to_Pa
            
            # Optimization resolution and minimum pressure clamp
            n_time_points = 200
            min_pressure_pa = 1e6  # ~150 psi legacy floor

            # Reset any previous objective history
            st.session_state["layer2_objective_history"] = []
            
            progress_bar = st.progress(0, text="Running Layer 2 pressure optimization...")
            status_text = st.empty()
            
            def update_progress(stage: str, progress: float, message: str):
                # Show iteration information directly on the progress bar text
                progress_bar.progress(progress, text=f"{stage} | {message}")
                status_text.text(f"{stage} | {message}")
            
            def log_status(stage: str, message: str):
                # Logging is handled inside layer2_pressure; this hook can be used to surface messages in UI if desired.
                # For now, surface key messages in the status text area to give some feedback during long runs.
                status_text.text(f"{stage} | {message}")

            def objective_callback(eval_index: int, objective: float, best_objective: float):
                """Stream Layer 2 objective history into a live-updating convergence plot."""
                try:
                    history = st.session_state.get("layer2_objective_history", [])
                    history.append(
                        {
                            "evaluation": int(eval_index),
                            "objective": float(objective),
                            "best_objective": float(best_objective),
                        }
                    )
                    st.session_state["layer2_objective_history"] = history

                    if not history:
                        return

                    df = pd.DataFrame(history)
                    fig = go.Figure()
                    fig.add_trace(
                        go.Scatter(
                            x=df["evaluation"],
                            y=df["objective"],
                            mode="lines+markers",
                            name="Objective",
                            line=dict(color="#1f77b4"),
                        )
                    )
                    fig.add_trace(
                        go.Scatter(
                            x=df["evaluation"],
                            y=df["best_objective"],
                            mode="lines",
                            name="Best Objective",
                            line=dict(color="#ff7f0e", dash="dash"),
                        )
                    )
                    fig.update_layout(
                        xaxis_title="Evaluation",
                        yaxis_title="Objective Value",
                        height=300,
                        margin=dict(l=40, r=20, t=30, b=40),
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                    )
                    objective_plot_container.plotly_chart(fig, use_container_width=True)
                except Exception:
                    # Never let plotting errors break the optimization loop
                    pass
            
            # Run Layer 2 pressure-curve optimization (uses new API in layer2_pressure.py)
            optimized_config, time_array, P_tank_O_optimized, P_tank_F_optimized, summary, success = run_layer2_pressure(
                optimized_config=base_layer2_config,
                initial_lox_pressure_pa=initial_lox_pressure_pa,
                initial_fuel_pressure_pa=initial_fuel_pressure_pa,
                peak_thrust=peak_thrust,
                target_apogee_m=target_apogee_m,
                rocket_dry_mass_kg=rocket_dry_mass_kg,
                max_lox_tank_capacity_kg=max_lox_tank_capacity_kg,
                max_fuel_tank_capacity_kg=max_fuel_tank_capacity_kg,
                target_burn_time=target_burn_time,
                n_time_points=n_time_points,
                update_progress=update_progress,
                log_status=log_status,
                min_pressure_pa=min_pressure_pa,
                optimal_of_ratio=optimal_of_ratio,
                min_stability_margin=min_stability_margin,
                save_evaluation_plots=True,  # Enable PNG plot updates while optimization runs
                objective_callback=objective_callback,
            )
            
            # Run time series with optimized pressure curves to get full results.
            # IMPORTANT: For Layer 2 we explicitly *disable* ablative/graphite
            # geometry evolution. Layer 2 is only about the pressure candidate;
            # thermal protection and recession are handled in Layer 3.
            optimized_runner = PintleEngineRunner(optimized_config)
            try:
                full_time_results = optimized_runner.evaluate_arrays_with_time(
                    time_array,
                    P_tank_O_optimized,
                    P_tank_F_optimized,
                    track_ablative_geometry=False,
                    use_coupled_solver=False,
                )
            except Exception:
                full_time_results = {}
            
            # Build time-varying summary
            if full_time_results:
                chugging_stability_history = full_time_results.get("chugging_stability_margin", np.array([1.0]))
                min_time_stability_margin = float(np.min(chugging_stability_history))
                
                stability_scores = full_time_results.get("stability_score", None)
                if stability_scores is None:
                    min_stability_score_time = max(0.0, min(1.0, (min_time_stability_margin - 0.3) * 1.5))
                else:
                    min_stability_score_time = float(np.min(stability_scores))
                
                time_varying_summary = {
                    "avg_thrust": float(np.mean(full_time_results.get("F", [peak_thrust]))),
                    "min_thrust": float(np.min(full_time_results.get("F", [peak_thrust]))),
                    "max_thrust": float(np.max(full_time_results.get("F", [peak_thrust]))),
                    "thrust_std": float(np.std(full_time_results.get("F", [0]))),
                    "avg_isp": float(np.mean(full_time_results.get("Isp", [250]))),
                    "min_stability_margin": min_time_stability_margin,
                    "min_stability_score": min_stability_score_time,
                    "max_recession_chamber": float(np.max(full_time_results.get("recession_chamber", [0.0]))),
                    "max_recession_throat": float(np.max(full_time_results.get("recession_throat", [0.0]))),
                }
            else:
                time_varying_summary = {}
            
            burn_candidate_valid = success
            
            progress_bar.empty()
            status_text.empty()
            
            # Store results
            config_obj = optimized_config
            st.session_state["optimized_config"] = optimized_config
            st.session_state["layer2_results"] = {
                "full_time_results": full_time_results,
                "time_varying_summary": time_varying_summary,
                "burn_candidate_valid": burn_candidate_valid,
                # Also store converged tank pressure curves, time base, and summary
                "summary": summary,
                "time_array": time_array,
                "P_tank_O_optimized": P_tank_O_optimized,
                "P_tank_F_optimized": P_tank_F_optimized,
            }
            
            # Update config_dict
            config_dict_updated = optimized_config.model_dump(exclude_none=False)
            st.session_state["config_dict"] = config_dict_updated
            
            if burn_candidate_valid:
                st.success("✅ Layer 2 optimization complete! Burn candidate is VALID.")
            else:
                st.warning("⚠️ Layer 2 optimization complete, but burn candidate may not be fully valid.")
            
            st.rerun()
            
        except Exception as e:
            st.error(f"Layer 2 optimization failed: {e}")
            import traceback
            st.code(traceback.format_exc())
    
    st.markdown("---")
    st.markdown("### Layer 2 Status")
    
    # Check for optimization results
    optimization_results = st.session_state.get("optimization_results", None)
    layer_status = optimization_results.get("layer_status", {}) if optimization_results else {}
    layer2_valid = layer_status.get("layer_2_burn_candidate", None)
    layer2_results = st.session_state.get("layer2_results", None)

    # ----------------------------------------------------------------------
    # Optional: allow user to upload a Layer 2 results YAML produced by the
    # "Download Layer 2 Results (YAML)" button. This enables resuming a
    # Layer 2‑only workflow without re‑running the optimizer.
    # ----------------------------------------------------------------------
    st.markdown("#### Optional: Load Layer 2 Results (YAML)")
    uploaded_layer2_file = st.file_uploader(
        "Upload `layer2_results.yaml`",
        type=["yaml", "yml"],
        key="layer2_results_upload",
        help=(
            "Load a Layer 2 results YAML previously exported from this app. "
            "This will populate the converged pressure curves and time‑varying results "
            "so you can inspect them without re‑running the optimization."
        ),
    )

    if uploaded_layer2_file is not None:
        import yaml

        try:
            uploaded_layer2_dict = yaml.safe_load(uploaded_layer2_file.read())
        except Exception as e:
            st.error(f"Could not parse uploaded Layer 2 YAML: {e}")
            uploaded_layer2_dict = None

        if isinstance(uploaded_layer2_dict, dict):
            # Try to rebuild the optimized PintleEngineConfig from the full mapping.
            try:
                uploaded_layer2_config = PintleEngineConfig(**uploaded_layer2_dict)
                st.session_state["optimized_config"] = uploaded_layer2_config
                st.session_state["config_obj"] = uploaded_layer2_config
                st.session_state["config_dict"] = uploaded_layer2_config.model_dump(exclude_none=False)
                config_obj = uploaded_layer2_config
            except Exception:
                # If config reconstruction fails, continue using the current config_obj.
                uploaded_layer2_config = None

            # If the YAML contains design requirements, update them so metrics match.
            dr = uploaded_layer2_dict.get("design_requirements")
            if isinstance(dr, dict):
                requirements = dr
                st.session_state["design_requirements"] = dr

            # Normalize the embedded Layer 2 payload into the structure expected
            # by the rest of this tab (same keys as when run in‑session).
            layer2_block = uploaded_layer2_dict.get("layer2", {})
            if isinstance(layer2_block, dict):
                # Convert arrays/lists back to NumPy for internal use.
                time_array_s = np.asarray(layer2_block.get("time_array_s", []), dtype=float)
                P_tank_O_pa = np.asarray(layer2_block.get("P_tank_O_pa", []), dtype=float)
                P_tank_F_pa = np.asarray(layer2_block.get("P_tank_F_pa", []), dtype=float)

                # Build a layer2_results dict that downstream UI understands.
                layer2_results_from_yaml = {
                    "summary": layer2_block.get("summary", {}),
                    "time_array": time_array_s,
                    "P_tank_O_optimized": P_tank_O_pa,
                    "P_tank_F_optimized": P_tank_F_pa,
                    "time_varying_summary": layer2_block.get("time_varying_summary", {}),
                    "full_time_results": layer2_block.get("full_time_results", {}),
                    # Assume a successful burn candidate when loading from an exported file.
                    "burn_candidate_valid": True,
                }

                st.session_state["layer2_results"] = layer2_results_from_yaml
                layer2_results = layer2_results_from_yaml
            else:
                st.error("Uploaded Layer 2 YAML is missing the required `layer2` section.")
        else:
            st.error("Uploaded Layer 2 file did not contain a valid YAML mapping/object.")

    if (optimization_results and layer2_valid is not None) or layer2_results:
        # Check validity from either source
        is_valid = layer2_valid if layer2_valid is not None else (layer2_results.get("burn_candidate_valid", False) if layer2_results else False)
        
        if is_valid:
            st.success("✅ Layer 2: Burn Candidate VALID")
        else:
            st.error("❌ Layer 2: Burn Candidate INVALID")
        
        # Show time-varying results if available
        time_varying = None
        if layer2_results and isinstance(layer2_results, dict):
            time_varying = layer2_results.get("time_varying_summary", {})
            if "max_recession_chamber" not in time_varying and "full_time_results" in layer2_results:
                # Extract from full_time_results
                full_results = layer2_results["full_time_results"]
                if isinstance(full_results, dict):
                    time_varying = {
                        "max_recession_chamber": float(np.max(full_results.get("recession_chamber", [0.0]))),
                        "max_recession_throat": float(np.max(full_results.get("recession_throat", [0.0]))),
                    }
        elif optimization_results:
            time_varying = optimization_results.get("time_varying_results", None)
        
        if time_varying:
            # ------------------------------------------------------------------
            # Detailed Layer 2 plots (pressure curves, COPV, thrust, O/F, Pc, objective)
            # ------------------------------------------------------------------
            st.markdown("### Layer 2 Plots")

            layer2_results = st.session_state.get("layer2_results", {})
            full_results = layer2_results.get("full_time_results", {})
            time_array = layer2_results.get("time_array", None)
            P_tank_O_opt = layer2_results.get("P_tank_O_optimized", None)
            P_tank_F_opt = layer2_results.get("P_tank_F_optimized", None)

            if (
                isinstance(full_results, dict)
                and time_array is not None
                and P_tank_O_opt is not None
                and P_tank_F_opt is not None
            ):
                try:
                    PA_TO_PSI = 1.0 / 6894.76
                    times = np.asarray(time_array, dtype=float)
                    n = len(times)

                    # Build DataFrame similar to ui_app.py time-series analysis
                    df_ts = pd.DataFrame(
                        {
                            "time": times,
                            "Thrust (kN)": np.asarray(
                                full_results.get("F", np.full(n, np.nan)), dtype=float
                            )
                            / 1000.0,
                            "Pc (psi)": np.asarray(
                                full_results.get("Pc", np.full(n, np.nan)), dtype=float
                            )
                            * PA_TO_PSI,
                            "mdot_O (kg/s)": np.asarray(
                                full_results.get("mdot_O", np.full(n, np.nan)), dtype=float
                            ),
                            "mdot_F (kg/s)": np.asarray(
                                full_results.get("mdot_F", np.full(n, np.nan)), dtype=float
                            ),
                            "mdot_total (kg/s)": np.asarray(
                                full_results.get("mdot_total", np.full(n, np.nan)), dtype=float
                            ),
                            "MR": np.asarray(full_results.get("MR", np.full(n, np.nan)), dtype=float),
                            "P_tank_O (psi)": np.asarray(P_tank_O_opt, dtype=float) * PA_TO_PSI,
                            "P_tank_F (psi)": np.asarray(P_tank_F_opt, dtype=float) * PA_TO_PSI,
                        }
                    )

                    # Burn summary – use Layer 2 summary (from final pressure curves)
                    layer2_summary = (
                        layer2_results.get("summary", {})
                        if isinstance(layer2_results, dict)
                        else {}
                    )

                    # Burn duration from time base (guard against NaNs)
                    if n > 1 and np.isfinite(times[0]) and np.isfinite(times[-1]):
                        burn_duration = float(times[-1] - times[0])
                    else:
                        burn_duration = 0.0

                    avg_thrust_kN = float(np.nanmean(df_ts["Thrust (kN)"].to_numpy()))
                    max_thrust_kN = float(np.nanmax(df_ts["Thrust (kN)"].to_numpy()))

                    # Total impulse and goal from summary (already N·s)
                    total_impulse_kNs = np.nan
                    required_impulse_kNs = np.nan
                    if isinstance(layer2_summary, dict):
                        try:
                            ti_actual = float(
                                layer2_summary.get("total_impulse_actual", np.nan)
                            )
                        except (TypeError, ValueError):
                            ti_actual = np.nan
                        try:
                            ri_req = float(layer2_summary.get("required_impulse", np.nan))
                        except (TypeError, ValueError):
                            ri_req = np.nan

                        if np.isfinite(ti_actual):
                            total_impulse_kNs = ti_actual / 1000.0
                        if np.isfinite(ri_req):
                            required_impulse_kNs = ri_req / 1000.0

                    # Tank pressure curves (converged pressure candidate)
                    pressure_fig = go.Figure()
                    pressure_fig.add_trace(
                        go.Scatter(
                            x=df_ts["time"],
                            y=df_ts["P_tank_O (psi)"],
                            mode="lines+markers",
                            name="LOX Tank",
                            line=dict(color="blue"),
                        )
                    )
                    pressure_fig.add_trace(
                        go.Scatter(
                            x=df_ts["time"],
                            y=df_ts["P_tank_F (psi)"],
                            mode="lines+markers",
                            name="Fuel Tank",
                            line=dict(color="orange"),
                        )
                    )
                    pressure_fig.update_layout(
                        title="Converged Tank Pressure Curves",
                        xaxis_title="Time [s]",
                        yaxis_title="Tank Pressure [psi]",
                        height=350,
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                    )
                    st.plotly_chart(pressure_fig, use_container_width=True, key="layer2_pressure_curves")

                    # COPV evaluation from converged Layer 2 curves (T0 = Tp = 260 K)
                    try:
                        copv_volume_m3 = float(requirements.get("copv_free_volume_m3") or 0.0)
                    except Exception:
                        copv_volume_m3 = 0.0

                    if copv_volume_m3 > 0.0:
                        opt_config = st.session_state.get("optimized_config", config_obj)
                        if opt_config is None:
                            opt_config = config_obj

                        copv_results = calculate_copv_pressure_curve(
                            time_array=times,
                            mdot_O=df_ts["mdot_O (kg/s)"].to_numpy(dtype=float),
                            mdot_F=df_ts["mdot_F (kg/s)"].to_numpy(dtype=float),
                            P_tank_O=np.asarray(P_tank_O_opt, dtype=float),
                            P_tank_F=np.asarray(P_tank_F_opt, dtype=float),
                            config=opt_config,
                            copv_volume_m3=copv_volume_m3,
                            T0_K=260.0,
                            Tp_K=260.0,
                        )

                        # Store for cross-tab reuse
                        st.session_state["layer2_copv_results"] = copv_results

                        # Dedicated COPV pressure plot for Layer 2-only workflow
                        st.markdown("#### COPV Pressure Curve (Layer 2, T = 260 K)")
                        pressure_curves_l2 = {
                            "time": times,
                            "P_tank_O": np.asarray(P_tank_O_opt, dtype=float),
                            "P_tank_F": np.asarray(P_tank_F_opt, dtype=float),
                        }
                        plot_copv_pressure(copv_results, pressure_curves_l2)

                    # Display metrics – do not recompute impulse in the UI
                    col_ts1, col_ts2, col_ts3, col_ts4 = st.columns(4)
                    col_ts1.metric("Burn duration", f"{burn_duration:.2f} s")
                    col_ts2.metric("Average thrust", f"{avg_thrust_kN:.2f} kN")
                    col_ts3.metric("Peak thrust", f"{max_thrust_kN:.2f} kN")

                    if np.isfinite(total_impulse_kNs) and np.isfinite(required_impulse_kNs):
                        col_ts4.metric(
                            "Total impulse",
                            f"{total_impulse_kNs:.2f} kN·s",
                            delta=f"Goal: {required_impulse_kNs:.2f} kN·s",
                        )
                    elif np.isfinite(total_impulse_kNs):
                        col_ts4.metric("Total impulse", f"{total_impulse_kNs:.2f} kN·s")
                    else:
                        col_ts4.metric("Total impulse", "N/A")

                    # Thrust vs time
                    thrust_fig = go.Figure()
                    thrust_fig.add_trace(
                        go.Scatter(
                            x=df_ts["time"],
                            y=df_ts["Thrust (kN)"],
                            mode="lines+markers",
                            name="Thrust",
                            line=dict(color="#1f77b4"),
                        )
                    )
                    thrust_fig.update_layout(
                        title="Thrust vs Time",
                        xaxis_title="Time [s]",
                        yaxis_title="Thrust [kN]",
                        height=300,
                    )
                    st.plotly_chart(thrust_fig, use_container_width=True, key="layer2_thrust_vs_time")

                    # Mixture ratio vs time
                    of_fig = go.Figure()
                    of_fig.add_trace(
                        go.Scatter(
                            x=df_ts["time"],
                            y=df_ts["MR"],
                            mode="lines",
                            name="O/F",
                            line=dict(color="#2ca02c"),
                        )
                    )
                    of_fig.update_layout(
                        title="Mixture Ratio (O/F) vs Time",
                        xaxis_title="Time [s]",
                        yaxis_title="O/F",
                        height=300,
                    )
                    st.plotly_chart(of_fig, use_container_width=True, key="layer2_of_vs_time")

                    # Chamber pressure vs time (psi)
                    pc_fig = go.Figure()
                    pc_fig.add_trace(
                        go.Scatter(
                            x=df_ts["time"],
                            y=df_ts["Pc (psi)"],
                            mode="lines",
                            name="Pc",
                            line=dict(color="#d62728"),
                        )
                    )
                    pc_fig.update_layout(
                        title="Chamber Pressure vs Time",
                        xaxis_title="Time [s]",
                        yaxis_title="Pc [psi]",
                        height=300,
                    )
                    st.plotly_chart(pc_fig, use_container_width=True, key="layer2_pc_vs_time")

                    # Objective history (from optimization loop), if available
                    history = st.session_state.get("layer2_objective_history", [])
                    if history:
                        df_hist = pd.DataFrame(history)
                        obj_fig = go.Figure()
                        obj_fig.add_trace(
                            go.Scatter(
                                x=df_hist["evaluation"],
                                y=df_hist["objective"],
                                mode="lines+markers",
                                name="Objective",
                                line=dict(color="#1f77b4"),
                            )
                        )
                        obj_fig.add_trace(
                            go.Scatter(
                                x=df_hist["evaluation"],
                                y=df_hist["best_objective"],
                                mode="lines",
                                name="Best Objective",
                                line=dict(color="#ff7f0e", dash="dash"),
                            )
                        )
                        obj_fig.update_layout(
                            title="Layer 2 Objective Function History",
                            xaxis_title="Evaluation",
                            yaxis_title="Objective Value",
                            height=300,
                            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                        )
                        st.plotly_chart(obj_fig, use_container_width=True, key="layer2_objective_history_plot")

                    # ------------------------------------------------------------------
                    # Layer 2 export: download YAML with all Layer 2 outputs
                    # (kept at the bottom, after plots and metrics)
                    # ------------------------------------------------------------------
                    layer2_results_safe = layer2_results if isinstance(layer2_results, dict) else {}
                    layer2_summary = layer2_results_safe.get("summary", {})
                    time_array_s = layer2_results_safe.get("time_array")
                    P_tank_O_opt = layer2_results_safe.get("P_tank_O_optimized")
                    P_tank_F_opt = layer2_results_safe.get("P_tank_F_optimized")

                    if layer2_summary and time_array_s is not None and P_tank_O_opt is not None and P_tank_F_opt is not None:
                        # Start from the optimized PintleEngineConfig as YAML.
                        layer2_cfg = st.session_state.get("optimized_config", config_obj)
                        if hasattr(layer2_cfg, "model_dump"):
                            layer2_config_dict = layer2_cfg.model_dump(exclude_none=False)
                        else:
                            layer2_config_dict = {}

                        # Helper to recursively convert NumPy types into plain Python
                        # types so that YAML stays portable and can be loaded safely.
                        def _sanitize_for_yaml(obj):
                            import numpy as _np

                            if isinstance(obj, _np.ndarray):
                                return obj.tolist()
                            if isinstance(obj, _np.generic):
                                # NumPy scalar → native Python scalar
                                return obj.item()
                            if isinstance(obj, dict):
                                return {k: _sanitize_for_yaml(v) for k, v in obj.items()}
                            if isinstance(obj, (list, tuple)):
                                return [_sanitize_for_yaml(v) for v in obj]
                            return obj

                        # Attach design requirements and all Layer 2 outputs.
                        layer2_config_dict.setdefault("design_requirements", requirements)
                        layer2_config_dict.setdefault("layer2", {})
                        layer2_config_dict["layer2"].update(
                            {
                                "summary": layer2_summary,
                                "time_array_s": list(map(float, np.asarray(time_array_s, dtype=float).tolist())),
                                "P_tank_O_pa": list(map(float, np.asarray(P_tank_O_opt, dtype=float).tolist())),
                                "P_tank_F_pa": list(map(float, np.asarray(P_tank_F_opt, dtype=float).tolist())),
                                "time_varying_summary": time_varying,
                            }
                        )

                        # Optionally attach full time-series results if present (can be large).
                        full_results = layer2_results_safe.get("full_time_results")
                        if isinstance(full_results, dict):
                            # Recursively sanitize all NumPy values
                            layer2_config_dict["layer2"]["full_time_results"] = _sanitize_for_yaml(full_results)

                        import yaml

                        # Final pass: make sure the entire structure is YAML‑friendly
                        safe_layer2_config = _sanitize_for_yaml(layer2_config_dict)
                        layer2_yaml_str = yaml.dump(safe_layer2_config, default_flow_style=False)

                        st.download_button(
                            label="💾 Download Layer 2 Results (YAML)",
                            data=layer2_yaml_str,
                            file_name="layer2_results.yaml",
                            mime="text/yaml",
                            help="Download the optimized Layer 2 PintleEngineConfig plus all Layer 2 outputs (summary, pressure curves, and time-varying results).",
                        )
                except Exception as plot_exc:
                    st.warning(f"Could not render Layer 2 time-series plots: {plot_exc}")
    elif layer2_valid is None:
        st.info("💡 Layer 2 was skipped (time-varying analysis disabled or Layer 1 invalid).")
    else:
        st.info("💡 Layer 2 has not been run yet. Click 'Run Layer 2 Optimization' above or use the Full Engine Optimizer.")
    
    return config_obj


def _layer3_tab(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner]) -> PintleEngineConfig:
    """Layer 3: Thermal Protection Optimization tab."""
    st.subheader("Layer 3: Thermal Protection Optimization")
    st.markdown("""
    **Layer 3** right-sizes thermal protection thicknesses to minimize mass while ensuring survival.
    
    This layer:
    - Uses max recession from Layer 2
    - Optimizes to `max_recession × 1.2` (20% margin)
    - Minimizes thermal protection mass
    - Verifies recession stays below 80% of thickness
    """)
    
    if runner is None:
        st.warning("⚠️ Runner not available. Please load configuration first.")
        return config_obj
    
    requirements = st.session_state.get("design_requirements", {})
    if not requirements:
        st.warning("⚠️ Please set design requirements in the 'Design Requirements' tab first.")
        return config_obj
    
    st.markdown("---")
    st.markdown("### Run Layer 3 Individually")

    # ------------------------------------------------------------------
    # Resolve / load Layer 2 results (prerequisite)
    # ------------------------------------------------------------------
    layer2_results = st.session_state.get("layer2_results") or (
        st.session_state.get("optimization_results", {}).get("time_varying_results")
    )
    layer2_config = st.session_state.get("optimized_config", config_obj)

    # Optional: allow user to upload a Layer 2 results YAML produced by the
    # "Download Layer 2 Results (YAML)" button. This enables a Layer 3‑only
    # workflow without re‑running Layer 2 in the current session.
    st.markdown("#### Optional: Load Layer 2 Results (YAML)")
    uploaded_layer2_file_for_layer3 = st.file_uploader(
        "Upload `layer2_results.yaml`",
        type=["yaml", "yml"],
        key="layer3_layer2_results_upload",
        help=(
            "Load a Layer 2 results YAML previously exported from this app. "
            "This will populate the converged pressure curves and time‑varying "
            "results so you can run Layer 3 without re‑running Layer 2."
        ),
    )

    if uploaded_layer2_file_for_layer3 is not None:
        import yaml

        # Read the uploaded content once so we can try multiple loaders if needed.
        raw_bytes = uploaded_layer2_file_for_layer3.read()

        uploaded_layer2_dict = None

        try:
            # First, try the safe loader.
            uploaded_layer2_dict = yaml.safe_load(raw_bytes)
        except Exception:
            # Some older / external YAMLs may contain Python / NumPy‑specific tags
            # such as `!!python/object/apply:numpy._core.multiarray.scalar`, which
            # `safe_load` cannot construct. In that case, fall back to the
            # unsafe loader and warn the user. This is acceptable here because
            # the file is expected to come from this app.
            try:
                uploaded_layer2_dict = yaml.unsafe_load(raw_bytes)
                st.warning(
                    "Loaded Layer 2 YAML using an unsafe loader due to Python/NumPy‑specific tags. "
                    "Only upload files generated by this app or otherwise trusted sources."
                )
            except Exception as e_unsafe:
                st.error(f"Could not parse uploaded Layer 2 YAML: {e_unsafe}")
                uploaded_layer2_dict = None

        # At this point, uploaded_layer2_dict may have come from either safe or
        # unsafe loading. As long as we have a mapping, normalize it into the
        # expected in‑session structures so that Layer 3 can run even on
        # legacy YAMLs.
        if isinstance(uploaded_layer2_dict, dict):
            # Try to rebuild the optimized PintleEngineConfig from the full mapping.
            try:
                uploaded_layer2_config = PintleEngineConfig(**uploaded_layer2_dict)
                st.session_state["optimized_config"] = uploaded_layer2_config
                st.session_state["config_obj"] = uploaded_layer2_config
                st.session_state["config_dict"] = uploaded_layer2_config.model_dump(exclude_none=False)
                layer2_config = uploaded_layer2_config
            except Exception:
                uploaded_layer2_config = None

            # If the YAML contains design requirements, update them so metrics match.
            dr = uploaded_layer2_dict.get("design_requirements")
            if isinstance(dr, dict):
                requirements = dr
                st.session_state["design_requirements"] = dr

            # Normalize the embedded Layer 2 payload into the structure expected
            # by this tab (same keys as when run in‑session).
            layer2_block = uploaded_layer2_dict.get("layer2", {})
            if isinstance(layer2_block, dict):
                # Convert arrays/lists back to NumPy for internal use.
                time_array_s = np.asarray(layer2_block.get("time_array_s", []), dtype=float)
                P_tank_O_pa = np.asarray(layer2_block.get("P_tank_O_pa", []), dtype=float)
                P_tank_F_pa = np.asarray(layer2_block.get("P_tank_F_pa", []), dtype=float)

                layer2_results_from_yaml = {
                    "summary": layer2_block.get("summary", {}),
                    "time_array": time_array_s,
                    "P_tank_O_optimized": P_tank_O_pa,
                    "P_tank_F_optimized": P_tank_F_pa,
                    "time_varying_summary": layer2_block.get("time_varying_summary", {}),
                    "full_time_results": layer2_block.get("full_time_results", {}),
                    # Assume a successful burn candidate when loading from an exported file.
                    "burn_candidate_valid": True,
                }
                st.session_state["layer2_results"] = layer2_results_from_yaml
                layer2_results = layer2_results_from_yaml
            else:
                st.error("Uploaded Layer 2 YAML is missing the required `layer2` section.")
        elif uploaded_layer2_dict is not None:
            # Parsed but not into a mapping (unexpected structure)
            st.error("Uploaded Layer 2 file did not contain a valid YAML mapping/object.")

    # Re-check Layer 2 prerequisite after optional upload handling.
    if not layer2_results:
        st.warning(
            "⚠️ Layer 2 must be run first. Please run Layer 2 optimization or upload "
            "`layer2_results.yaml` before running Layer 3."
        )
        return config_obj

    # Live objective convergence plot container (persists while optimization runs)
    st.markdown("#### Layer 3 Objective Convergence")
    layer3_objective_plot_container = st.empty()

    # If we have a previous objective history from a prior Layer 3 run, render it
    # so that the convergence plot remains visible even after the run completes
    # or if Layer 3 ultimately fails / is marked INVALID.
    try:
        history = st.session_state.get("layer3_objective_history", [])
        if history:
            df_hist = pd.DataFrame(history)
            fig_hist = go.Figure()
            fig_hist.add_trace(
                go.Scatter(
                    x=df_hist["evaluation"],
                    y=df_hist["objective"],
                    mode="lines+markers",
                    name="Objective",
                    line=dict(color="#1f77b4"),
                )
            )
            fig_hist.add_trace(
                go.Scatter(
                    x=df_hist["evaluation"],
                    y=df_hist["best_objective"],
                    mode="lines",
                    name="Best Objective",
                    line=dict(color="#ff7f0e", dash="dash"),
                )
            )
            fig_hist.update_layout(
                xaxis_title="Evaluation",
                yaxis_title="Objective Value",
                height=300,
                margin=dict(l=40, r=20, t=30, b=40),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                yaxis_type="log",
            )
            layer3_objective_plot_container.plotly_chart(fig_hist, use_container_width=True)
    except Exception:
        # Never let plotting errors break the rest of the tab UI.
        pass

    # Optimization method selector
    st.markdown("#### Optimization Settings")
    layer3_opt_method = st.selectbox(
        "Optimization Method",
        options=["gradient", "cma", "de"],
        index=0,  # Default to gradient (fast)
        key="layer3_opt_method",
        help=(
            "**gradient** (recommended): Fast gradient descent exploiting monotonic "
            "thickness-recession relationship. ~5-15 evaluations, ~30-60 seconds.\n\n"
            "**cma**: CMA-ES global optimizer. More thorough but slower. ~60-80 evaluations.\n\n"
            "**de**: Differential Evolution fallback. Similar to CMA-ES."
        ),
    )
    
    if st.button("🚀 Run Layer 3 Optimization", type="primary", key="run_layer3"):
        try:
            # ------------------------------------------------------------------
            # Pull converged pressure curves and time base directly from Layer 2
            # (Layer 1 no longer owns segmented pressure definitions).
            # ------------------------------------------------------------------
            if not isinstance(layer2_results, dict):
                st.error("❌ Layer 2 results are not available in the expected format. Please re-run Layer 2.")
                return config_obj

            time_array = np.asarray(layer2_results.get("time_array"), dtype=float)
            P_tank_O_array = np.asarray(layer2_results.get("P_tank_O_optimized"), dtype=float)
            P_tank_F_array = np.asarray(layer2_results.get("P_tank_F_optimized"), dtype=float)

            if time_array.size == 0 or P_tank_O_array.size == 0 or P_tank_F_array.size == 0:
                st.error("❌ Layer 2 pressure curves are missing. Please run Layer 2 optimization before Layer 3.")
                return config_obj

            if not (time_array.size == P_tank_O_array.size == P_tank_F_array.size):
                st.error("❌ Layer 2 pressure curve arrays have inconsistent lengths. Please re-run Layer 2.")
                return config_obj

            n_time_points = int(time_array.size)

            # Get full time results from Layer 2 if present; otherwise recompute
            if "full_time_results" in layer2_results and isinstance(layer2_results["full_time_results"], dict):
                full_time_results = layer2_results["full_time_results"]
            else:
                runner_temp = PintleEngineRunner(layer2_config)
                full_time_results = runner_temp.evaluate_arrays_with_time(
                    time_array,
                    P_tank_O_array,
                    P_tank_F_array,
                    track_ablative_geometry=True,
                    use_coupled_solver=False,
                )
            
            progress_bar = st.progress(0, text="Running Layer 3 optimization...")
            status_text = st.empty()

            # Reset any previous objective history
            st.session_state["layer3_objective_history"] = []

            def objective_callback(eval_index: int, objective: float, best_objective: float):
                """Stream Layer 3 objective history into a live-updating convergence plot."""
                try:
                    history = st.session_state.get("layer3_objective_history", [])
                    history.append(
                        {
                            "evaluation": int(eval_index),
                            "objective": float(objective),
                            "best_objective": float(best_objective),
                        }
                    )
                    st.session_state["layer3_objective_history"] = history

                    if not history:
                        return

                    df = pd.DataFrame(history)
                    fig = go.Figure()
                    fig.add_trace(
                        go.Scatter(
                            x=df["evaluation"],
                            y=df["objective"],
                            mode="lines+markers",
                            name="Objective",
                            line=dict(color="#1f77b4"),
                        )
                    )
                    fig.add_trace(
                        go.Scatter(
                            x=df["evaluation"],
                            y=df["best_objective"],
                            mode="lines",
                            name="Best Objective",
                            line=dict(color="#ff7f0e", dash="dash"),
                        )
                    )
                    fig.update_layout(
                        xaxis_title="Evaluation",
                        yaxis_title="Objective Value",
                        height=300,
                        margin=dict(l=40, r=20, t=30, b=40),
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                        yaxis_type="log",
                    )
                    layer3_objective_plot_container.plotly_chart(fig, use_container_width=True)
                except Exception:
                    # Never let plotting errors break the optimization loop
                    pass

            def update_progress(stage: str, progress: float, message: str):
                progress_bar.progress(progress, text=f"{stage}\n{message}")
                status_text.text(f"{stage} | {message}")
            
            def log_status(stage: str, message: str):
                # Surface key log messages in the status text area while the
                # detailed iteration log is written to disk by the core Layer 3
                # implementation.
                status_text.text(f"{stage} | {message}")
            
            # Run Layer 3
            optimized_config, updated_time_results, thermal_results = run_layer3_thermal_protection(
                layer2_config,
                time_array,
                P_tank_O_array,
                P_tank_F_array,
                full_time_results,
                n_time_points,
                update_progress,
                log_status,
                objective_callback=objective_callback,
                optimization_method=layer3_opt_method,
            )
            
            progress_bar.empty()
            status_text.empty()
            
            # Store results (including time base and optimized tank pressures)
            config_obj = optimized_config
            st.session_state["optimized_config"] = optimized_config
            st.session_state["layer3_results"] = {
                "updated_time_results": updated_time_results,
                "thermal_results": thermal_results,
                "time_array": time_array,
                "P_tank_O_array": P_tank_O_array,
                "P_tank_F_array": P_tank_F_array,
            }
            
            # CRITICAL: Save as the "final" optimized config (Layer 3 is the final thermal protection step)
            st.session_state["final_optimized_config"] = optimized_config
            st.session_state["final_chamber_config"] = optimized_config.model_dump(exclude_none=False)
            
            # Update config_dict
            config_dict_updated = optimized_config.model_dump(exclude_none=False)
            st.session_state["config_dict"] = config_dict_updated
            
            if thermal_results.get("thermal_protection_valid", False):
                st.success("✅ Layer 3 optimization complete! Thermal protection is VALID.")
            else:
                st.warning("⚠️ Layer 3 optimization complete, but thermal protection may not be fully valid.")
            
            st.rerun()
            
        except Exception as e:
            st.error(f"Layer 3 optimization failed: {e}")
            import traceback
            st.code(traceback.format_exc())
    
    st.markdown("---")
    st.markdown("### Layer 3 Status")
    
    # Check for optimization results
    optimization_results = st.session_state.get("optimization_results", None)
    layer_status = optimization_results.get("layer_status", {}) if optimization_results else {}
    layer3_valid = layer_status.get("layer_3_thermal_protection", None)
    layer3_results = st.session_state.get("layer3_results", None)
    
    if (optimization_results and layer3_valid is not None) or layer3_results:
        # Prefer the most recent Layer 3 run results when determining validity.
        # Full‑pipeline runs populate optimization_results.layer_status, but a
        # Layer 3‑only run writes its own status into layer3_results.
        thermal_valid = None
        if isinstance(layer3_results, dict):
            thermal_valid = layer3_results.get("thermal_results", {}).get("thermal_protection_valid")
        if thermal_valid is None:
            # Fallback to legacy layer_status flag if present
            thermal_valid = bool(layer3_valid)
        
        if thermal_valid:
            st.success("✅ Layer 3: Thermal Protection VALID")
        else:
            st.error("❌ Layer 3: Thermal Protection INVALID")

        # If we have an objective history from a prior Layer 3 run, keep showing
        # the convergence plot here as well so that users can inspect why a run
        # may have failed or produced an invalid result.
        try:
            history = st.session_state.get("layer3_objective_history", [])
            if history:
                st.markdown("#### Layer 3 Objective Function History")
                df_hist = pd.DataFrame(history)
                obj_fig = go.Figure()
                obj_fig.add_trace(
                    go.Scatter(
                        x=df_hist["evaluation"],
                        y=df_hist["objective"],
                        mode="lines+markers",
                        name="Objective",
                        line=dict(color="#1f77b4"),
                    )
                )
                obj_fig.add_trace(
                    go.Scatter(
                        x=df_hist["evaluation"],
                        y=df_hist["best_objective"],
                        mode="lines",
                        name="Best Objective",
                        line=dict(color="#ff7f0e", dash="dash"),
                    )
                )
                obj_fig.update_layout(
                    title="Layer 3 Objective Function History",
                    xaxis_title="Evaluation",
                    yaxis_title="Objective Value",
                    height=300,
                    legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                    yaxis_type="log",
                )
                st.plotly_chart(obj_fig, use_container_width=True, key="layer3_objective_history_plot")
        except Exception:
            # Plotting is best-effort only; don't break the status panel.
            pass
        
        # Show final thermal protection thicknesses
        # Get thermal_results first (most authoritative source for Layer 3 optimized values)
        thermal_results_data = None
        if isinstance(layer3_results, dict):
            thermal_results_data = layer3_results.get("thermal_results", None)
        
        # CRITICAL: Get optimized config and ensure it has Layer 3 optimized thicknesses
        opt_config = st.session_state.get("optimized_config", config_obj)
        
        # Update opt_config with optimized thicknesses from thermal_results if available
        if opt_config and thermal_results_data:
            import copy as copy_module
            opt_config = copy_module.deepcopy(opt_config)  # Work with a copy to avoid side effects
            
            if "optimized_ablative_thickness" in thermal_results_data:
                if opt_config.ablative_cooling and opt_config.ablative_cooling.enabled:
                    opt_config.ablative_cooling.initial_thickness = thermal_results_data["optimized_ablative_thickness"]
            
            if "optimized_graphite_thickness" in thermal_results_data:
                if opt_config.graphite_insert and opt_config.graphite_insert.enabled:
                    opt_config.graphite_insert.initial_thickness = thermal_results_data["optimized_graphite_thickness"]
        
        if opt_config:
            ablative_cfg = opt_config.ablative_cooling if hasattr(opt_config, 'ablative_cooling') else None
            graphite_cfg = opt_config.graphite_insert if hasattr(opt_config, 'graphite_insert') else None
            
            st.markdown("#### Final Thermal Protection Thicknesses")
            col1, col2 = st.columns(2)
            with col1:
                if ablative_cfg and ablative_cfg.enabled:
                    # Use optimized thickness from thermal_results (already updated in opt_config above)
                    thickness = ablative_cfg.initial_thickness
                    st.metric("Ablative Thickness", f"{thickness * 1000:.2f} mm")
                    st.caption("20% margin over max recession")
            with col2:
                if graphite_cfg and graphite_cfg.enabled:
                    # Use optimized thickness from thermal_results (already updated in opt_config above)
                    thickness = graphite_cfg.initial_thickness
                    st.metric("Graphite Thickness", f"{thickness * 1000:.2f} mm")
                    st.caption("20% margin over max recession")
            
            # ------------------------------------------------------------------
            # Layer 3 export: download YAML that updates Layer 2 config with
            # optimized ablative/graphite thickness (and optional Layer 3 data)
            # ------------------------------------------------------------------
            try:
                import yaml as _yaml
                import numpy as _np

                st.markdown("#### Download Layer 3 Results (YAML)")

                # Start from the Layer 3-optimized PintleEngineConfig as YAML.
                layer3_cfg = opt_config
                if hasattr(layer3_cfg, "model_dump"):
                    layer3_config_dict = layer3_cfg.model_dump(exclude_none=False)
                else:
                    layer3_config_dict = {}

                # Attach design requirements and a compact Layer 3 payload.
                layer3_config_dict.setdefault("design_requirements", requirements)
                layer3_config_dict.setdefault("layer3", {})

                layer3_block = layer3_config_dict["layer3"]

                # Include optimized thicknesses explicitly for clarity.
                layer3_block["thermal_results"] = thermal_results_data or {}

                # Attach time base and tank pressures if available so Layer 4
                # can be run later from this file (optional but very useful).
                time_array_s = layer3_results.get("time_array") if isinstance(layer3_results, dict) else None
                P_tank_O_pa = layer3_results.get("P_tank_O_array") if isinstance(layer3_results, dict) else None
                P_tank_F_pa = layer3_results.get("P_tank_F_array") if isinstance(layer3_results, dict) else None

                if time_array_s is not None and P_tank_O_pa is not None and P_tank_F_pa is not None:
                    layer3_block["time_array_s"] = list(map(float, _np.asarray(time_array_s, dtype=float).tolist()))
                    layer3_block["P_tank_O_pa"] = list(map(float, _np.asarray(P_tank_O_pa, dtype=float).tolist()))
                    layer3_block["P_tank_F_pa"] = list(map(float, _np.asarray(P_tank_F_pa, dtype=float).tolist()))

                # Optionally include updated_time_results in a sanitized form
                updated_time_results = layer3_results.get("updated_time_results") if isinstance(layer3_results, dict) else None

                def _sanitize_for_yaml(obj):
                    """Recursively convert objects to YAML‑safe types.
                    
                    - NumPy arrays/scalars → lists / native scalars
                    - dict / list / tuple → sanitized recursively
                    - Other custom objects (e.g. ValidationResult) → string
                    """
                    if isinstance(obj, _np.ndarray):
                        return obj.tolist()
                    if isinstance(obj, _np.generic):
                        return obj.item()
                    if isinstance(obj, dict):
                        return {k: _sanitize_for_yaml(v) for k, v in obj.items()}
                    if isinstance(obj, (list, tuple)):
                        return [_sanitize_for_yaml(v) for v in obj]
                    # Fallback: stringify any non‑primitive Python object so we
                    # don't emit `!!python/object` tags that break safe loaders.
                    if isinstance(obj, (str, int, float, bool)) or obj is None:
                        return obj
                    return str(obj)

                if isinstance(updated_time_results, dict):
                    layer3_block["updated_time_results"] = _sanitize_for_yaml(updated_time_results)

                # Final pass: make sure the entire structure is YAML‑friendly
                safe_layer3_config = _sanitize_for_yaml(layer3_config_dict)
                layer3_yaml_str = _yaml.dump(safe_layer3_config, default_flow_style=False)

                st.download_button(
                    label="💾 Download Layer 3 Results (YAML)",
                    data=layer3_yaml_str,
                    file_name="layer3_results.yaml",
                    mime="text/yaml",
                    help=(
                        "Download the PintleEngineConfig with Layer 3‑optimized ablative and "
                        "graphite thickness, plus optional Layer 3 time base and data."
                    ),
                )
            except Exception as layer3_export_exc:
                st.warning(f"Could not create Layer 3 YAML export: {layer3_export_exc}")

            # Show recession data
            # Get recession values from thermal_results (primary source) or time_varying (fallback)
            # Note: thermal_results_data was already retrieved above for thickness display
            
            time_varying = None
            if optimization_results:
                time_varying = optimization_results.get("time_varying_results", None)
            elif layer3_results:
                if isinstance(layer3_results, dict):
                    # layer3_results may either be the full result dict or just
                    # the time-varying portion; handle both cases.
                    time_varying = layer3_results.get("time_varying_results", None) or layer3_results.get("updated_time_results", None)
                else:
                    time_varying = layer3_results
            
            # Display recession analysis if we have the data
            if thermal_results_data or time_varying:
                st.markdown("#### Recession Analysis")
                # Prefer thermal_results for recession values (they're the authoritative source from Layer 3)
                if ablative_cfg:
                    max_recess = None
                    if thermal_results_data and "max_recession_chamber" in thermal_results_data:
                        max_recess = thermal_results_data['max_recession_chamber']
                    elif time_varying and "max_recession_chamber" in time_varying:
                        max_recess = time_varying['max_recession_chamber']
                    
                    if max_recess is not None:
                        # Use optimized thickness (already updated in opt_config)
                        thickness = ablative_cfg.initial_thickness
                        margin_pct = ((thickness - max_recess) / thickness * 100) if thickness > 0 else 0
                        st.caption(f"Max Chamber Recession: {max_recess * 1000:.2f} mm | Margin: {margin_pct:.1f}%")
                
                if graphite_cfg:
                    max_recess = None
                    if thermal_results_data and "max_recession_throat" in thermal_results_data:
                        max_recess = thermal_results_data['max_recession_throat']
                    elif time_varying and "max_recession_throat" in time_varying:
                        max_recess = time_varying['max_recession_throat']
                    
                    if max_recess is not None:
                        # Use optimized thickness (already updated in opt_config)
                        thickness = graphite_cfg.initial_thickness
                        margin_pct = ((thickness - max_recess) / thickness * 100) if thickness > 0 else 0
                        st.caption(f"Max Throat Recession: {max_recess * 1000:.2f} mm | Margin: {margin_pct:.1f}%")
            
            # Display final chamber geometry visualization with optimized thermal protection
            # This is the "final" chamber design after Layer 3 optimization
            st.markdown("#### Final Chamber Geometry (Layer 3 Result)")
            try:
                from engine.optimizer.helpers import _display_chamber_geometry_plot
                
                # CRITICAL: Use opt_config which already has optimized thicknesses updated above
                # No need to update again - opt_config was already updated with thermal_results values
                final_config_for_viz = opt_config
                
                # Create a mock optimization_results dict for the visualizer
                # It needs performance data for Cf calculation
                mock_opt_results = {}
                if optimization_results:
                    mock_opt_results = optimization_results.copy()
                elif layer3_results and isinstance(layer3_results, dict):
                    # Try to extract performance from time-varying results
                    time_varying = layer3_results.get("updated_time_results", {})
                    if time_varying:
                        # Calculate average thrust for Cf
                        thrust_array = time_varying.get("F", np.array([0.0]))
                        Pc_array = time_varying.get("Pc", np.array([2e6]))
                        if isinstance(thrust_array, np.ndarray) and len(thrust_array) > 0:
                            avg_thrust = float(np.mean(thrust_array))
                            avg_Pc = float(np.mean(Pc_array))
                            mock_opt_results["performance"] = {
                                "F": avg_thrust,
                                "Pc": avg_Pc,
                            }
                
                # Use the config with optimized thicknesses (already updated above)
                _display_chamber_geometry_plot(final_config_for_viz, mock_opt_results)
                
                # CRITICAL: Save the final optimized config to session state as the "final" chamber
                # This ensures other tabs can access the Layer 3 optimized design
                # opt_config already has the optimized thicknesses from thermal_results
                st.session_state["final_optimized_config"] = opt_config
                st.session_state["final_chamber_config"] = opt_config.model_dump(exclude_none=False)
                
                # Also update the main optimized_config in session state to ensure consistency
                st.session_state["optimized_config"] = opt_config
                st.session_state["config_dict"] = opt_config.model_dump(exclude_none=False)
                
                st.info("✅ Final chamber geometry with Layer 3 optimized thicknesses saved to session state")
            except Exception as e:
                st.warning(f"Could not render final chamber geometry visualization: {e}")
                import traceback
                st.code(traceback.format_exc())
            
            # Display time series analysis plots from Layer 3 final run
            if layer3_results and isinstance(layer3_results, dict):
                time_varying_final = layer3_results.get("updated_time_results", {})
                if time_varying_final and len(time_varying_final) > 0:
                    st.markdown("#### Time Series Analysis (Layer 3 Final Configuration)")
                    
                    # Extract time array
                    time_array = None
                    if "time" in time_varying_final:
                        time_array = np.asarray(time_varying_final["time"])
                    elif isinstance(time_varying_final, dict) and any(isinstance(v, np.ndarray) for v in time_varying_final.values()):
                        # Try to infer time from array length
                        for key, val in time_varying_final.items():
                            if isinstance(val, np.ndarray) and len(val) > 0:
                                time_array = np.linspace(0, 10.0, len(val))  # Default burn time
                                break
                    
                    if time_array is not None and len(time_array) > 0:
                        # Extract data arrays
                        thrust = np.asarray(time_varying_final.get("F", []))
                        Pc = np.asarray(time_varying_final.get("Pc", []))
                        Lstar = np.asarray(time_varying_final.get("Lstar", []))
                        A_throat = np.asarray(time_varying_final.get("A_throat", []))
                        recession_chamber = np.asarray(time_varying_final.get("recession_chamber", []))
                        recession_throat = np.asarray(time_varying_final.get("recession_throat", []))
                        
                        # Extract recession rates from diagnostics if available
                        diagnostics_list = time_varying_final.get("diagnostics", [])
                        ablative_recession_rate = []
                        graphite_recession_rate_thermal = []
                        graphite_recession_rate_oxidation = []
                        
                        for diag in diagnostics_list if isinstance(diagnostics_list, list) else []:
                            if isinstance(diag, dict):
                                cooling = diag.get("cooling", {})
                                ablative = cooling.get("ablative", {}) if isinstance(cooling, dict) else {}
                                if ablative and isinstance(ablative, dict):
                                    rate = ablative.get("recession_rate", 0.0)
                                    ablative_recession_rate.append(rate * 1e6 if rate else 0.0)  # Convert to µm/s
                                else:
                                    ablative_recession_rate.append(0.0)
                                
                                # Graphite recession rates
                                graphite = cooling.get("graphite", {}) if isinstance(cooling, dict) else {}
                                if graphite and isinstance(graphite, dict):
                                    thermal_rate = graphite.get("recession_rate_thermal", 0.0)
                                    oxidation_rate = graphite.get("oxidation_rate", 0.0)
                                    graphite_recession_rate_thermal.append(thermal_rate * 1e6 if thermal_rate else 0.0)
                                    graphite_recession_rate_oxidation.append(oxidation_rate * 1e6 if oxidation_rate else 0.0)
                                else:
                                    graphite_recession_rate_thermal.append(0.0)
                                    graphite_recession_rate_oxidation.append(0.0)
                            else:
                                ablative_recession_rate.append(0.0)
                                graphite_recession_rate_thermal.append(0.0)
                                graphite_recession_rate_oxidation.append(0.0)
                        
                        # Ensure arrays are same length
                        n_points = len(time_array)
                        if len(ablative_recession_rate) == 0:
                            ablative_recession_rate = np.zeros(n_points)
                        else:
                            ablative_recession_rate = np.asarray(ablative_recession_rate[:n_points])
                        
                        if len(graphite_recession_rate_thermal) == 0:
                            graphite_recession_rate_thermal = np.zeros(n_points)
                            graphite_recession_rate_oxidation = np.zeros(n_points)
                        else:
                            graphite_recession_rate_thermal = np.asarray(graphite_recession_rate_thermal[:n_points])
                            graphite_recession_rate_oxidation = np.asarray(graphite_recession_rate_oxidation[:n_points])
                        
                        # Create plots
                        import plotly.graph_objects as go
                        from plotly.subplots import make_subplots
                        
                        # Convert Pa to psi (1 psi = 6894.76 Pa)
                        PA_TO_PSI = 1.0 / 6894.76
                        Pc_psi = Pc * PA_TO_PSI
                        
                        # Calculate cumulative throat recession from thermal ablation and oxidation
                        # Integrate rates over time to get cumulative values
                        dt = np.diff(time_array, prepend=time_array[0] if len(time_array) > 0 else 0.0)
                        # Convert rates from µm/s to m/s, then integrate
                        cumulative_throat_thermal = np.cumsum(graphite_recession_rate_thermal * 1e-6 * dt)  # Convert µm/s to m/s, then integrate
                        cumulative_throat_oxidation = np.cumsum(graphite_recession_rate_oxidation * 1e-6 * dt)  # Convert µm/s to m/s, then integrate
                        
                        # Plot 1: Thrust (own graph)
                        fig1 = go.Figure()
                        fig1.add_trace(go.Scatter(
                            x=time_array, y=thrust/1000, mode="lines", name="Thrust",
                            line=dict(color="blue", width=2)
                        ))
                        fig1.update_layout(
                            title="Thrust vs Time",
                            xaxis_title="Time [s]",
                            yaxis_title="Thrust [kN]",
                            height=300,
                            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
                        )
                        st.plotly_chart(fig1, use_container_width=True, key="layer3_thrust")
                        
                        # Plot 2: Chamber Pressure (own graph, in psi)
                        fig2 = go.Figure()
                        fig2.add_trace(go.Scatter(
                            x=time_array, y=Pc_psi, mode="lines", name="Chamber Pressure",
                            line=dict(color="red", width=2)
                        ))
                        fig2.update_layout(
                            title="Chamber Pressure vs Time",
                            xaxis_title="Time [s]",
                            yaxis_title="Chamber Pressure [psi]",
                            height=300,
                            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
                        )
                        st.plotly_chart(fig2, use_container_width=True, key="layer3_pc")
                        
                        # Plot 3: L* and Throat Area (together)
                        fig3 = make_subplots(specs=[[{"secondary_y": True}]])
                        fig3.add_trace(
                            go.Scatter(x=time_array, y=Lstar*1000, mode="lines", name="L*", line=dict(color="green", width=2)),
                            secondary_y=False,
                        )
                        fig3.add_trace(
                            go.Scatter(x=time_array, y=A_throat*1e6, mode="lines", name="Throat Area", line=dict(color="orange", width=2)),
                            secondary_y=True,
                        )
                        fig3.update_xaxes(title_text="Time [s]")
                        fig3.update_yaxes(title_text="L* [mm]", secondary_y=False)
                        fig3.update_yaxes(title_text="Throat Area [mm²]", secondary_y=True)
                        fig3.update_layout(
                            title="L* and Throat Area Evolution",
                            height=300,
                            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
                        )
                        st.plotly_chart(fig3, use_container_width=True, key="layer3_lstar_throat")
                        
                        # Plot 4: Ablative Recession Rate (own graph)
                        fig4 = go.Figure()
                        fig4.add_trace(go.Scatter(
                            x=time_array, y=ablative_recession_rate, mode="lines", name="Ablative Recession Rate",
                            line=dict(color="purple", width=2)
                        ))
                        fig4.update_layout(
                            title="Ablative Recession Rate vs Time",
                            xaxis_title="Time [s]",
                            yaxis_title="Recession Rate [µm/s]",
                            height=300,
                            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
                        )
                        st.plotly_chart(fig4, use_container_width=True, key="layer3_ablative_recession_rate")
                        
                        # Plot 5: Graphite Thermal Ablation AND Oxidation (together)
                        fig5 = go.Figure()
                        fig5.add_trace(go.Scatter(
                            x=time_array, y=graphite_recession_rate_thermal, mode="lines", name="Graphite Thermal Ablation",
                            line=dict(color="red", width=2, dash="dash")
                        ))
                        fig5.add_trace(go.Scatter(
                            x=time_array, y=graphite_recession_rate_oxidation, mode="lines", name="Graphite Oxidation",
                            line=dict(color="orange", width=2, dash="dot")
                        ))
                        fig5.update_layout(
                            title="Graphite Recession Rates vs Time",
                            xaxis_title="Time [s]",
                            yaxis_title="Recession Rate [µm/s]",
                            height=300,
                            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
                        )
                        st.plotly_chart(fig5, use_container_width=True, key="layer3_graphite_recession_rates")
                        
                        # Plot 6: Cumulative Chamber Recession (own graph)
                        fig6 = go.Figure()
                        fig6.add_trace(go.Scatter(
                            x=time_array, y=recession_chamber*1000, mode="lines", name="Cumulative Chamber Recession",
                            line=dict(color="purple", width=2)
                        ))
                        fig6.update_layout(
                            title="Cumulative Chamber Recession vs Time",
                            xaxis_title="Time [s]",
                            yaxis_title="Cumulative Recession [mm]",
                            height=300,
                            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
                        )
                        st.plotly_chart(fig6, use_container_width=True, key="layer3_cumulative_chamber_recession")
                        
                        # Plot 7: Cumulative Throat Recession (own graph with total, thermal, and oxidation)
                        fig7 = go.Figure()
                        fig7.add_trace(go.Scatter(
                            x=time_array, y=recession_throat*1000, mode="lines", name="Cumulative Throat Recession (Total)",
                            line=dict(color="red", width=2)
                        ))
                        fig7.add_trace(go.Scatter(
                            x=time_array, y=cumulative_throat_thermal*1000, mode="lines", name="Cumulative Throat Recession (Thermal)",
                            line=dict(color="darkred", width=2, dash="dash")
                        ))
                        fig7.add_trace(go.Scatter(
                            x=time_array, y=cumulative_throat_oxidation*1000, mode="lines", name="Cumulative Throat Recession (Oxidation)",
                            line=dict(color="orange", width=2, dash="dot")
                        ))
                        fig7.update_layout(
                            title="Cumulative Throat Recession vs Time",
                            xaxis_title="Time [s]",
                            yaxis_title="Cumulative Recession [mm]",
                            height=300,
                            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
                        )
                        st.plotly_chart(fig7, use_container_width=True, key="layer3_cumulative_throat_recession")
                    else:
                        st.info("Time series data not available for plotting.")
    elif layer3_valid is None:
        st.info("💡 Layer 3 was skipped (time-varying analysis disabled or Layer 2 invalid).")
    else:
        st.info("💡 Layer 3 has not been run yet. Click 'Run Layer 3 Optimization' above or use the Full Engine Optimizer.")
    
    return config_obj


def _layer4_tab(config_obj: PintleEngineConfig, runner: Optional[PintleEngineRunner]) -> PintleEngineConfig:
    """Layer 4: Flight Simulation tab."""
    st.subheader("Layer 4: Flight Simulation")
    st.markdown("""
    **Layer 4** validates trajectory performance and optimizes propellant mass to hit apogee targets.
    
    This layer:
    - Runs flight simulation with the optimized engine
    - Uses backward iteration to find optimal propellant mass
    - Iteratively reduces burn time until apogee matches target
    - Validates system-level performance
    """)
    
    if runner is None:
        st.warning("⚠️ Runner not available. Please load configuration first.")
        return config_obj
    
    requirements = st.session_state.get("design_requirements", {})
    tolerances = st.session_state.get("tolerances", {})
    if not requirements:
        st.warning("⚠️ Please set design requirements in the 'Design Requirements' tab first.")
        return config_obj
    
    # ------------------------------------------------------------------
    # Run Layer 4 individually (UI-only, mirroring full pipeline behavior)
    # ------------------------------------------------------------------
    st.markdown("---")
    st.markdown("### Run Layer 4 Individually")

    # Optional: allow user to upload a Layer 3 results YAML produced by the
    # "Download Layer 3 Results (YAML)" button. This enables resuming a
    # Layer 3+4 workflow without re-running the thermal optimization.
    st.markdown("#### Optional: Load Layer 3 Results (YAML)")
    uploaded_layer3_file = st.file_uploader(
        "Upload `layer3_results.yaml`",
        type=["yaml", "yml"],
        key="layer4_layer3_upload",
        help=(
            "Load a Layer 3 results YAML previously exported from this app. "
            "This will populate the converged time base, tank pressures, and "
            "time-varying results so Layer 4 can run without re-running Layer 3."
        ),
    )

    if uploaded_layer3_file is not None:
        import yaml
        import numpy as np

        # Read raw bytes once so we can try multiple loaders if needed
        raw_bytes = uploaded_layer3_file.read()

        uploaded_layer3_dict = None

        try:
            # First, try the safe loader (no Python object tags)
            uploaded_layer3_dict = yaml.safe_load(raw_bytes)
        except Exception:
            # Fallback: some internally-generated YAMLs may contain Python/NumPy
            # tags (e.g. !!python/object:...). In that case, fall back to the
            # full loader, with a warning since it's only for trusted files.
            try:
                uploaded_layer3_dict = yaml.load(raw_bytes, Loader=yaml.FullLoader)
                st.warning(
                    "Loaded Layer 3 YAML with a permissive loader because it "
                    "contains Python-specific tags. Only upload files produced "
                    "by this app."
                )
            except Exception as e:
                st.error(f"Could not parse uploaded Layer 3 YAML: {e}")
                uploaded_layer3_dict = None

        if isinstance(uploaded_layer3_dict, dict):
            # Try to rebuild the optimized PintleEngineConfig from the full mapping.
            try:
                uploaded_layer3_config = PintleEngineConfig(**uploaded_layer3_dict)
                st.session_state["optimized_config"] = uploaded_layer3_config
                st.session_state["config_obj"] = uploaded_layer3_config
                st.session_state["config_dict"] = uploaded_layer3_config.model_dump(exclude_none=False)
                config_obj = uploaded_layer3_config
            except Exception:
                uploaded_layer3_config = None

            # If the YAML contains design requirements, update them so metrics match.
            dr = uploaded_layer3_dict.get("design_requirements")
            if isinstance(dr, dict):
                requirements = dr
                st.session_state["design_requirements"] = dr

            # Normalize the embedded Layer 3 payload into the structure expected
            # by the rest of this tab (same keys as when run in-session).
            layer3_block = uploaded_layer3_dict.get("layer3", {})
            if isinstance(layer3_block, dict):
                time_array_s = np.asarray(layer3_block.get("time_array_s", []), dtype=float)
                P_tank_O_pa = np.asarray(layer3_block.get("P_tank_O_pa", []), dtype=float)
                P_tank_F_pa = np.asarray(layer3_block.get("P_tank_F_pa", []), dtype=float)
                updated_time_results = layer3_block.get("updated_time_results", {})
                thermal_results = layer3_block.get("thermal_results", {})

                layer3_results_from_yaml = {
                    "time_array": time_array_s,
                    "P_tank_O_array": P_tank_O_pa,
                    "P_tank_F_array": P_tank_F_pa,
                    "updated_time_results": updated_time_results,
                    "thermal_results": thermal_results,
                }

                st.session_state["layer3_results"] = layer3_results_from_yaml
            else:
                st.error("Uploaded Layer 3 YAML is missing the required `layer3` section.")
        else:
            st.error("Uploaded Layer 3 file did not contain a valid YAML mapping/object.")

    if st.button("🚀 Run Layer 4 Flight Simulation", type="primary", key="run_layer4"):
        import numpy as np

        # Pull converged pressure curves and time-varying results from Layer 3.
        # Layer 3 is the final thermal protection step and already runs with the
        # optimized pressure candidate from Layer 2.
        layer3_results = st.session_state.get("layer3_results", None)
        if not isinstance(layer3_results, dict):
            st.error("❌ Layer 3 results are missing. Please run Layer 3 optimization first.")
            return config_obj

        time_array = np.asarray(layer3_results.get("time_array"), dtype=float)
        P_tank_O_array = np.asarray(layer3_results.get("P_tank_O_array"), dtype=float)
        P_tank_F_array = np.asarray(layer3_results.get("P_tank_F_array"), dtype=float)
        full_time_results = layer3_results.get("updated_time_results", {})

        if (
            time_array.size == 0
            or P_tank_O_array.size == 0
            or P_tank_F_array.size == 0
            or not isinstance(full_time_results, dict)
        ):
            st.error(
                "❌ Layer 3 time base, tank pressures, or time-varying results are incomplete. "
                "Please re-run Layer 3 optimization."
            )
            return config_obj

        # Build pressure_curves dict expected by run_flight_simulation
        n = time_array.size
        thrust_array = np.asarray(full_time_results.get("F", np.full(n, 0.0)), dtype=float)
        mdot_O_array = np.asarray(full_time_results.get("mdot_O", np.full(n, 0.0)), dtype=float)
        mdot_F_array = np.asarray(full_time_results.get("mdot_F", np.full(n, 0.0)), dtype=float)

        # Ensure consistent lengths
        min_len = min(len(time_array), len(thrust_array), len(mdot_O_array), len(mdot_F_array))
        if min_len == 0:
            st.error("❌ Time-series arrays for thrust or mass flow are empty. Cannot run flight simulation.")
            return config_obj

        time_array = time_array[:min_len]
        thrust_array = thrust_array[:min_len]
        mdot_O_array = mdot_O_array[:min_len]
        mdot_F_array = mdot_F_array[:min_len]

        pressure_curves = {
            "time": time_array,
            "thrust": thrust_array,
            "mdot_O": mdot_O_array,
            "mdot_F": mdot_F_array,
        }

        # Requirements and tolerances
        target_burn_time = float(requirements.get("target_burn_time", 10.0))
        target_apogee = float(requirements.get("target_apogee", 3048.0))
        apogee_tol = float(tolerances.get("apogee", 0.15))

        optimized_config = st.session_state.get("optimized_config", config_obj)

        progress_bar = st.progress(0, text="Running Layer 4 flight simulation...")
        status_text = st.empty()

        def update_progress(stage: str, progress: float, message: str):
            # Mirror main optimizer behavior: drive a single progress bar and status text
            progress_bar.progress(progress, text=f"{stage} | {message}")
            status_text.text(f"{stage} | {message}")

        def log_status(stage: str, message: str):
            # Surface key status messages in the status text area
            status_text.text(f"{stage} | {message}")

        try:
            flight_sim_result = run_layer4_flight_simulation(
                optimized_config=optimized_config,
                pressure_curves=pressure_curves,
                time_array=time_array,
                P_tank_O_array=P_tank_O_array,
                P_tank_F_array=P_tank_F_array,
                target_burn_time=target_burn_time,
                target_apogee=target_apogee,
                apogee_tol=apogee_tol,
                update_progress=update_progress,
                log_status=log_status,
                run_flight_simulation_func=run_flight_simulation,
            )
            st.session_state["layer4_results"] = flight_sim_result

            # Small bump to show completion
            update_progress("Layer 4: Flight Candidate", 0.90, "Flight simulation complete.")
            st.rerun()
        except Exception as e:
            st.error(f"Layer 4 flight simulation failed: {e}")
            import traceback
            st.code(traceback.format_exc())
            return config_obj

    st.markdown("---")
    st.markdown("### Layer 4 Status")
    
    # Check for optimization results and/or standalone Layer 4 runs
    optimization_results = st.session_state.get("optimization_results", None)
    layer_status = optimization_results.get("layer_status", {}) if optimization_results else {}
    flight_sim_result = optimization_results.get("flight_sim_result", {}) if optimization_results else {}
    layer4_results = st.session_state.get("layer4_results", None)
    
    if (optimization_results and flight_sim_result) or layer4_results:
        if layer4_results:
            flight_sim_result = layer4_results
        
        # Determine validity from either full optimizer or standalone Layer 4 result
        layer4_valid_flag = layer_status.get("layer_4_flight_candidate", None)
        if layer4_valid_flag is None:
            layer4_valid = bool(flight_sim_result.get("flight_candidate_valid", False))
        else:
            layer4_valid = bool(layer4_valid_flag)

        if layer4_valid:
            st.success("✅ Layer 4: Flight Candidate VALID")
        else:
            st.error("❌ Layer 4: Flight Candidate INVALID")
        
        # Show iteration table if available (show regardless of success/failure)
        if "iteration_data" in flight_sim_result and len(flight_sim_result["iteration_data"]) > 0:
            st.markdown("#### Iteration History")
            import pandas as pd
            
            # Get the best iteration number if available
            best_iteration = flight_sim_result.get("best_iteration", None)
            
            # Create DataFrame from iteration data
            df_data = []
            for iter_record in flight_sim_result["iteration_data"]:
                iter_num = iter_record.get("iteration", 0)
                is_best = (best_iteration is not None and iter_num == best_iteration)
                iter_label = f"⭐ {iter_num}" if is_best else str(iter_num)
                
                df_data.append({
                    "Iteration": iter_label,
                    "Burn Time (s)": f"{iter_record.get('burn_time', 0):.2f}",
                    "Apogee (m)": f"{iter_record.get('apogee', 0):.1f}",
                    "Apogee Error (%)": f"{iter_record.get('apogee_error_pct', 100):.1f}",
                    "Max Velocity (m/s)": f"{iter_record.get('max_velocity', 0):.1f}" if iter_record.get('max_velocity') else "N/A",
                    "Success": "✅" if iter_record.get("success", False) else "❌",
                    "Max Thrust (N)": f"{iter_record.get('max_thrust', 0):.0f}",
                    "Initial Thrust (N)": f"{iter_record.get('initial_thrust', 0):.0f}",
                    "Avg Thrust (N)": f"{iter_record.get('avg_thrust', 0):.0f}",
                    "Total Impulse (N·s)": f"{iter_record.get('total_impulse', 0):.0f}",
                    "LOX Mass (kg)": f"{iter_record.get('adjusted_lox_mass', 0):.2f}",
                    "Fuel Mass (kg)": f"{iter_record.get('adjusted_fuel_mass', 0):.2f}",
                    "Error": iter_record.get("error", "")[:80] if iter_record.get("error") else "",
                })
            
            df = pd.DataFrame(df_data)
            st.dataframe(df, use_container_width=True, hide_index=True)
            
            if best_iteration is not None:
                st.info(f"⭐ **Best iteration: {best_iteration}** (lowest apogee error: {flight_sim_result.get('best_apogee_error', 0)*100:.1f}%)")
            
            # Show error details if any iteration failed
            failed_iterations = [r for r in flight_sim_result["iteration_data"] if not r.get("success", False) and r.get("error")]
            if failed_iterations:
                with st.expander("❌ Error Details"):
                    for iter_record in failed_iterations:
                        st.error(f"Iteration {iter_record.get('iteration', 0)}: {iter_record.get('error', 'Unknown error')}")
        
        # Show flight simulation results
        if flight_sim_result.get("success", False):
            st.markdown("#### Flight Simulation Results")
            col1, col2, col3 = st.columns(3)
            with col1:
                apogee = flight_sim_result.get("apogee", 0)
                target_apogee = requirements.get("target_apogee", 3048.0)
                apogee_error = abs(apogee - target_apogee) / target_apogee * 100 if target_apogee > 0 else 100.0
                st.metric("Apogee", f"{apogee:.0f} m", delta=f"Target: {target_apogee:.0f} m")
                st.caption(f"Error: {apogee_error:.1f}%")
            with col2:
                max_velocity = flight_sim_result.get("max_velocity", 0)
                st.metric("Max Velocity", f"{max_velocity:.1f} m/s")
            with col3:
                actual_burn_time = flight_sim_result.get("actual_burn_time", requirements.get("target_burn_time", 10.0))
                st.metric("Actual Burn Time", f"{actual_burn_time:.2f} s")
            
            # Show propellant adjustments
            if "adjusted_lox_mass" in flight_sim_result or "adjusted_fuel_mass" in flight_sim_result:
                st.markdown("#### Propellant Mass Adjustments")
                col1, col2 = st.columns(2)
                with col1:
                    if "adjusted_lox_mass" in flight_sim_result:
                        st.metric("LOX Mass", f"{flight_sim_result['adjusted_lox_mass']:.2f} kg")
                with col2:
                    if "adjusted_fuel_mass" in flight_sim_result:
                        st.metric("Fuel Mass", f"{flight_sim_result['adjusted_fuel_mass']:.2f} kg")

            # Detailed time-series plots using RocketPy Flight object (if available),
            # mirroring the standalone flight_sim_view output.
            flight_obj = flight_sim_result.get("flight_obj", None)
            if flight_obj is not None:
                try:
                    st.markdown("#### Flight Visualizations (Layer 4)")
                    elevation = float(requirements.get("environment", {}).get("elevation", 0.0))
                    flight_time, flight_alt_agl, flight_vz = extract_flight_series(flight_obj, elevation)
                    if flight_time.size > 0:
                        plot_flight_results(flight_time, flight_alt_agl, flight_vz, key_suffix="_layer4")
                        render_rocket_view(flight_obj)
                        plot_additional_rocket_plots(flight_obj, flight_time, key_suffix="_layer4")
                    else:
                        st.info("Flight time series are empty; no plots to display.")
                except Exception as flight_plot_exc:
                    st.warning(f"Could not render Layer 4 flight visualizations: {flight_plot_exc}")
        elif flight_sim_result.get("skipped", False):
            st.warning(f"⚠️ Flight simulation was skipped: {flight_sim_result.get('reason', 'Unknown reason')}")
        else:
            st.error(f"❌ Flight simulation failed: {flight_sim_result.get('error', 'Unknown error')}")

        if flight_sim_result:
            try:
                import yaml as _yaml
                import numpy as _np

                layer4_cfg = st.session_state.get("optimized_config", config_obj)
                if hasattr(layer4_cfg, "model_dump"):
                    layer4_config_dict = layer4_cfg.model_dump(exclude_none=False)
                else:
                    layer4_config_dict = {}

                # Always capture design requirements for downstream consumers.
                layer4_config_dict.setdefault("design_requirements", requirements)

                # Build Layer 4 export block.
                layer4_block = layer4_config_dict.setdefault("layer4", {})
                if tolerances:
                    layer4_block["tolerances"] = tolerances

                def _sanitize_for_yaml(obj):
                    """Recursively convert objects into YAML-safe primitives."""
                    if isinstance(obj, _np.ndarray):
                        return obj.tolist()
                    if isinstance(obj, _np.generic):
                        return obj.item()
                    if isinstance(obj, dict):
                        return {k: _sanitize_for_yaml(v) for k, v in obj.items()}
                    if isinstance(obj, (list, tuple)):
                        return [_sanitize_for_yaml(v) for v in obj]
                    if isinstance(obj, (str, int, float, bool)) or obj is None:
                        return obj
                    return str(obj)

                    # End of _sanitize_for_yaml

                # Copy flight sim result but drop non-serializable objects like RocketPy Flight.
                flight_result_export = dict(flight_sim_result)
                flight_result_export.pop("flight_obj", None)
                layer4_block["flight_sim_result"] = _sanitize_for_yaml(flight_result_export)

                # Attach the Layer 3 inputs that fed Layer 4 so the workflow can be replayed.
                layer3_results_for_layer4 = st.session_state.get("layer3_results")
                if isinstance(layer3_results_for_layer4, dict):
                    inputs_block = {}

                    time_array = layer3_results_for_layer4.get("time_array")
                    P_tank_O_array = layer3_results_for_layer4.get("P_tank_O_array")
                    P_tank_F_array = layer3_results_for_layer4.get("P_tank_F_array")

                    if time_array is not None:
                        inputs_block["time_array_s"] = _np.asarray(time_array, dtype=float).tolist()
                    if P_tank_O_array is not None:
                        inputs_block["P_tank_O_pa"] = _np.asarray(P_tank_O_array, dtype=float).tolist()
                    if P_tank_F_array is not None:
                        inputs_block["P_tank_F_pa"] = _np.asarray(P_tank_F_array, dtype=float).tolist()

                    updated_time_results = layer3_results_for_layer4.get("updated_time_results")
                    if isinstance(updated_time_results, dict):
                        inputs_block["updated_time_results"] = _sanitize_for_yaml(updated_time_results)

                    thermal_results = layer3_results_for_layer4.get("thermal_results")
                    if isinstance(thermal_results, dict):
                        inputs_block["thermal_results"] = _sanitize_for_yaml(thermal_results)

                    if inputs_block:
                        layer4_block["layer3_inputs"] = inputs_block

                safe_layer4_config = _sanitize_for_yaml(layer4_config_dict)
                layer4_yaml_str = _yaml.dump(safe_layer4_config, default_flow_style=False)

                st.download_button(
                    label="💾 Download Layer 4 Results (YAML)",
                    data=layer4_yaml_str,
                    file_name="layer4_results.yaml",
                    mime="text/yaml",
                    help=(
                        "Download the PintleEngineConfig with Layer 4 flight simulation results, "
                        "including tank pressure inputs and iteration history."
                    ),
                )
            except Exception as layer4_export_exc:
                st.warning(f"Could not create Layer 4 YAML export: {layer4_export_exc}")
    else:
        st.info("💡 Layer 4 has not been run yet. Click 'Run Layer 4 Flight Simulation' above to test with generated pressure curves.")
    
    return config_obj
