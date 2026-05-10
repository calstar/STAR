"""Comprehensive ablative material sizing tool.

Determines required ablative thickness based on:
- Heat flux (convective + radiative)
- Burn time
- Material properties
- Back-face temperature limits
- Recession allowance
- Safety margins
"""

from __future__ import annotations

from typing import Dict, Optional
import numpy as np

from engine.pipeline.config_schemas import AblativeCoolingConfig
from engine.pipeline.thermal_analysis import (
    calculate_required_ablative_thickness,
    MaterialLayer,
    ThermalBoundaryConditions,
    analyze_multi_layer_system,
)


def size_ablative_system(
    heat_flux: float,
    burn_time: float,
    ablative_config: AblativeCoolingConfig,
    backface_temp_limit: float = 500.0,  # [K] - Max backface for stainless steel
    stainless_thickness: float = 0.002,  # [m] - 2mm stainless wall
    stainless_k: float = 15.0,  # [W/(m·K)]
    stainless_density: float = 8000.0,  # [kg/m³]
    stainless_cp: float = 500.0,  # [J/(kg·K)]
    T_hot_gas: float = 3500.0,  # [K]
    h_hot_gas: float = 5000.0,  # [W/(m²·K)]
    q_rad_hot: float = 0.0,  # [W/m²]
) -> Dict[str, any]:
    """
    Comprehensive ablative system sizing.
    
    Parameters:
    -----------
    heat_flux : float
        Design heat flux [W/m²]
    burn_time : float
        Burn time [s]
    ablative_config : AblativeCoolingConfig
        Ablative material configuration
    backface_temp_limit : float
        Maximum backface temperature [K]
    stainless_thickness : float
        Stainless steel wall thickness [m]
    stainless_k : float
        Stainless steel thermal conductivity [W/(m·K)]
    stainless_density : float
        Stainless steel density [kg/m³]
    stainless_cp : float
        Stainless steel specific heat [J/(kg·K)]
    T_hot_gas : float
        Hot gas temperature [K]
    h_hot_gas : float
        Hot gas convective coefficient [W/(m²·K)]
    q_rad_hot : float
        Radiative heat flux [W/m²]
    
    Returns:
    --------
    dict
        Comprehensive sizing results including:
        - required_thickness: Required ablative thickness [m]
        - recession_allowance: Material lost to recession [m]
        - conduction_thickness: Thickness for thermal protection [m]
        - safety_margin: Safety margin [m]
        - thermal_analysis: Full thermal analysis results
        - backface_temp: Calculated backface temperature [K]
        - meets_requirements: bool - Whether design meets all requirements
    """
    # Calculate required thickness
    sizing_results = calculate_required_ablative_thickness(
        heat_flux,
        burn_time,
        ablative_config,
        backface_temp_limit,
        stainless_thickness,
        stainless_k,
    )
    
    required_thickness = sizing_results["required_thickness"]
    
    # Build material layers for thermal analysis
    ablative_layer = MaterialLayer(
        name="Phenolic Ablator",
        thickness=required_thickness,
        thermal_conductivity=ablative_config.thermal_conductivity,
        density=ablative_config.material_density,
        specific_heat=ablative_config.specific_heat,
        emissivity=0.85,
        pyrolysis_temp=ablative_config.pyrolysis_temperature,
    )
    
    stainless_layer = MaterialLayer(
        name="Stainless Steel",
        thickness=stainless_thickness,
        thermal_conductivity=stainless_k,
        density=stainless_density,
        specific_heat=stainless_cp,
        emissivity=0.3,
    )
    
    layers = [ablative_layer, stainless_layer]  # Hot to cold
    
    # Boundary conditions
    bc = ThermalBoundaryConditions(
        T_hot_gas=T_hot_gas,
        h_hot_gas=h_hot_gas,
        q_rad_hot=q_rad_hot,
        T_ambient=300.0,
        h_ambient=10.0,
    )
    
    # Full thermal analysis
    thermal_results = analyze_multi_layer_system(
        layers,
        bc,
        ablative_config=ablative_config,
    )
    
    # Check if backface temperature meets requirements
    T_backface = thermal_results["T_backface"]
    meets_requirements = T_backface <= backface_temp_limit
    
    # Compile results
    results = {
        "required_thickness": required_thickness,
        "recession_allowance": sizing_results["recession_allowance"],
        "conduction_thickness": sizing_results["conduction_thickness"],
        "safety_margin": sizing_results["safety_margin"],
        "recession_rate": sizing_results["recession_rate"],
        "thermal_analysis": thermal_results,
        "backface_temp": T_backface,
        "backface_temp_limit": backface_temp_limit,
        "meets_requirements": meets_requirements,
        "T_surface_hot": thermal_results["T_surface_hot"],
        "heat_flux": thermal_results["heat_flux"],
    }
    
    return results


def size_graphite_insert(
    peak_heat_flux: float,
    surface_temperature: float,
    recession_rate: float,
    burn_time: float,
    graphite_config: any,  # GraphiteInsertConfig
    backface_temp_limit: float = 500.0,
    stainless_thickness: float = 0.002,
    stainless_k: float = 15.0,
) -> Dict[str, any]:
    """
    Size graphite insert using existing graphite_geometry module.
    
    This is a wrapper that uses the comprehensive sizing from graphite_geometry.py
    and adds thermal analysis.
    """
    from engine.pipeline.thermal.graphite_geometry import size_graphite_insert as size_graphite
    
    # Use existing graphite sizing
    sizing = size_graphite(
        peak_heat_flux=peak_heat_flux,
        surface_temperature=surface_temperature,
        recession_rate=recession_rate,
        burn_time=burn_time,
        thermal_conductivity=graphite_config.thermal_conductivity,
        backface_temperature_max=backface_temp_limit,
        throat_diameter=0.020,  # 20 mm (from config)
        density=graphite_config.material_density,
        specific_heat=graphite_config.specific_heat,
        mechanical_thickness=0.001,
        safety_factor=0.3,
        transient=True,
    )
    
    # Build layers for thermal analysis
    graphite_layer = MaterialLayer(
        name="Graphite Insert",
        thickness=sizing.initial_thickness,
        thermal_conductivity=graphite_config.thermal_conductivity,
        density=graphite_config.material_density,
        specific_heat=graphite_config.specific_heat,
        emissivity=0.9,
    )
    
    stainless_layer = MaterialLayer(
        name="Stainless Steel",
        thickness=stainless_thickness,
        thermal_conductivity=stainless_k,
        density=8000.0,
        specific_heat=500.0,
        emissivity=0.3,
    )
    
    layers = [graphite_layer, stainless_layer]
    
    # Boundary conditions (throat conditions)
    bc = ThermalBoundaryConditions(
        T_hot_gas=surface_temperature * 1.1,  # Slightly above surface
        h_hot_gas=10000.0,  # High at throat
        q_rad_hot=0.0,
        T_ambient=300.0,
        h_ambient=10.0,
    )
    
    # Thermal analysis
    thermal_results = analyze_multi_layer_system(
        layers,
        bc,
        graphite_config=graphite_config,
    )
    
    return {
        "sizing": sizing,
        "thermal_analysis": thermal_results,
        "backface_temp": thermal_results["T_backface"],
        "meets_requirements": thermal_results["T_backface"] <= backface_temp_limit,
    }

