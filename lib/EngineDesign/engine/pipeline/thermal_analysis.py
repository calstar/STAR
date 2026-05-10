"""Comprehensive thermal analysis for multi-layer ablative/graphite system.

This module provides:
1. Multi-layer thermal conduction (stainless steel + phenolic + graphite)
2. Pyrolysis modeling with char layer formation
3. Vaporization at high temperatures
4. Transient thermal response
5. Temperature profiles through wall thickness
6. Back-face temperature limits for structural integrity
"""

from __future__ import annotations

from typing import Dict, Tuple, Optional, List
from dataclasses import dataclass
import numpy as np

from .config_schemas import AblativeCoolingConfig, GraphiteInsertConfig

SIGMA = 5.670374419e-8  # Stefan-Boltzmann constant


@dataclass
class MaterialLayer:
    """Properties of a single material layer."""
    name: str
    thickness: float  # [m]
    thermal_conductivity: float  # [W/(m·K)]
    density: float  # [kg/m³]
    specific_heat: float  # [J/(kg·K)]
    emissivity: float = 0.8  # Surface emissivity
    pyrolysis_temp: Optional[float] = None  # [K] - For ablative materials
    vaporization_temp: Optional[float] = None  # [K] - For high-temp materials


@dataclass
class ThermalBoundaryConditions:
    """Boundary conditions for thermal analysis."""
    T_hot_gas: float  # [K] - Hot gas temperature
    h_hot_gas: float  # [W/(m²·K)] - Hot gas convective coefficient
    q_rad_hot: float  # [W/m²] - Radiative heat flux from hot gas
    T_ambient: float = 300.0  # [K] - Ambient temperature
    h_ambient: float = 10.0  # [W/(m²·K)] - Ambient convective coefficient (natural convection)
    q_rad_ambient: float = 0.0  # [W/m²] - Radiative to ambient (usually negligible)


def calculate_steady_state_temperature_profile(
    layers: List[MaterialLayer],
    bc: ThermalBoundaryConditions,
    n_points_per_layer: int = 10,
) -> Dict[str, np.ndarray]:
    """
    Calculate steady-state temperature profile through multi-layer wall.
    
    Uses thermal resistance network:
        q = (T_hot - T_cold) / R_total
        R_total = R_conv_hot + R_cond_1 + R_cond_2 + ... + R_conv_cold
    
    For each layer:
        R_cond = t / (k * A)  (1D conduction)
    
    Parameters:
    -----------
    layers : List[MaterialLayer]
        Material layers from hot side to cold side
    bc : ThermalBoundaryConditions
        Boundary conditions
    n_points_per_layer : int
        Number of temperature points per layer
    
    Returns:
    --------
    dict
        - positions: np.ndarray [m] - Distance from hot surface
        - temperatures: np.ndarray [K] - Temperature at each position
        - heat_flux: float [W/m²] - Steady-state heat flux
        - T_surface_hot: float [K] - Hot surface temperature
        - T_surface_cold: float [K] - Cold surface temperature
        - layer_boundaries: List[float] - Positions of layer boundaries
    """
    if not layers:
        raise ValueError("layers list cannot be empty")
    
    # Calculate total thermal resistance
    R_conv_hot = 1.0 / max(bc.h_hot_gas, 1e-6)
    
    R_cond_total = 0.0
    for layer in layers:
        if layer.thickness <= 0:
            continue
        R_cond_layer = layer.thickness / max(layer.thermal_conductivity, 1e-6)
        R_cond_total += R_cond_layer
    
    R_conv_cold = 1.0 / max(bc.h_ambient, 1e-6)
    R_total = R_conv_hot + R_cond_total + R_conv_cold
    
    # Calculate total heat flux (convective + radiative)
    # Iterative: need to know surface temp for radiation
    # Start with convective only, then iterate
    T_surface_hot_guess = bc.T_hot_gas * 0.8  # Initial guess
    
    for _ in range(10):  # Iterate for radiation coupling
        q_conv = bc.h_hot_gas * (bc.T_hot_gas - T_surface_hot_guess)
        q_rad = bc.q_rad_hot  # Assume constant for now
        q_total = q_conv + q_rad
        
        # Temperature drop across each resistance
        delta_T_hot = q_total * R_conv_hot
        T_surface_hot = bc.T_hot_gas - delta_T_hot
        
        if abs(T_surface_hot - T_surface_hot_guess) < 1.0:  # Converged
            break
        T_surface_hot_guess = T_surface_hot
    
    # Cold surface temperature
    delta_T_cold = q_total * R_conv_cold
    T_surface_cold = bc.T_ambient + delta_T_cold
    
    # Build temperature profile through layers
    positions = []
    temperatures = []
    layer_boundaries = [0.0]
    
    current_pos = 0.0
    current_temp = T_surface_hot
    
    for i, layer in enumerate(layers):
        if layer.thickness <= 0:
            continue
        
        # Temperature drop across this layer
        R_layer = layer.thickness / max(layer.thermal_conductivity, 1e-6)
        delta_T_layer = q_total * R_layer
        
        # Points within this layer
        x_layer = np.linspace(0, layer.thickness, n_points_per_layer)
        T_layer = current_temp - (delta_T_layer / layer.thickness) * x_layer
        
        positions.extend(current_pos + x_layer)
        temperatures.extend(T_layer)
        
        current_pos += layer.thickness
        current_temp -= delta_T_layer
        layer_boundaries.append(current_pos)
    
    positions = np.array(positions)
    temperatures = np.array(temperatures)
    
    return {
        "positions": positions,
        "temperatures": temperatures,
        "heat_flux": float(q_total),
        "T_surface_hot": float(T_surface_hot),
        "T_surface_cold": float(T_surface_cold),
        "layer_boundaries": layer_boundaries,
        "R_total": float(R_total),
    }


def calculate_pyrolysis_response(
    surface_temperature: float,
    ablative_config: AblativeCoolingConfig,
    heat_flux: float,
    time_step: float = 0.01,
) -> Dict[str, float]:
    """
    Calculate pyrolysis response including char layer formation.
    
    Pyrolysis occurs when T > T_pyrolysis:
    - Material decomposes into char + pyrolysis gases
    - Char layer forms on surface (lower conductivity)
    - Pyrolysis gases flow outward (blowing effect)
    
    Parameters:
    -----------
    surface_temperature : float
        Surface temperature [K]
    ablative_config : AblativeCoolingConfig
        Ablative material configuration
    heat_flux : float
        Incident heat flux [W/m²]
    time_step : float
        Time step [s] for transient calculations
    
    Returns:
    --------
    dict
        - pyrolysis_rate: float [kg/(m²·s)] - Mass flux of pyrolysis gases
        - char_formation_rate: float [m/s] - Char layer growth rate
        - char_thickness: float [m] - Current char layer thickness
        - pyrolysis_active: bool - Whether pyrolysis is occurring
        - energy_consumed: float [J/kg] - Energy consumed by pyrolysis
    """
    if surface_temperature < ablative_config.pyrolysis_temperature:
        return {
            "pyrolysis_rate": 0.0,
            "char_formation_rate": 0.0,
            "char_thickness": 0.0,
            "pyrolysis_active": False,
            "energy_consumed": 0.0,
        }
    
    # Pyrolysis rate increases with temperature above threshold
    # Arrhenius-like behavior: rate ∝ exp(-E_a / (R * T))
    T_excess = surface_temperature - ablative_config.pyrolysis_temperature
    T_normalized = T_excess / (ablative_config.surface_temperature_limit - ablative_config.pyrolysis_temperature)
    T_normalized = np.clip(T_normalized, 0.0, 1.0)
    
    # Pyrolysis rate (empirical model)
    # Typical: 0.1-1.0 kg/(m²·s) at high temperatures
    pyrolysis_rate_max = 1.0  # kg/(m²·s)
    pyrolysis_rate = pyrolysis_rate_max * (T_normalized ** 2.0)
    
    # Char formation rate (char density typically 800-1200 kg/m³)
    char_density = 1000.0  # kg/m³ (typical)
    virgin_density = ablative_config.material_density
    char_formation_rate = pyrolysis_rate * (virgin_density / char_density - 1.0) / virgin_density
    
    # Char thickness (grows over time)
    # Simplified: assume steady-state char thickness based on heat flux
    # In reality, this would be time-integrated
    char_thickness = ablative_config.char_layer_thickness  # Use config value
    
    # Energy consumed by pyrolysis (latent heat + sensible heat)
    # Typical: 1-3 MJ/kg for phenolic pyrolysis
    delta_h_pyrolysis = 2.0e6  # J/kg (typical)
    energy_consumed = pyrolysis_rate * delta_h_pyrolysis
    
    return {
        "pyrolysis_rate": float(pyrolysis_rate),
        "char_formation_rate": float(char_formation_rate),
        "char_thickness": float(char_thickness),
        "pyrolysis_active": True,
        "energy_consumed": float(energy_consumed),
    }


def calculate_vaporization_rate(
    surface_temperature: float,
    material_config: AblativeCoolingConfig | GraphiteInsertConfig,
    heat_flux: float,
    pressure: float = 1e6,  # [Pa]
) -> Dict[str, float]:
    """
    Calculate material vaporization rate at high temperatures.
    
    Vaporization occurs when T > T_vaporization:
    - Material directly sublimates/vaporizes
    - No char formation (unlike pyrolysis)
    - High energy consumption
    
    Parameters:
    -----------
    surface_temperature : float
        Surface temperature [K]
    material_config : AblativeCoolingConfig | GraphiteInsertConfig
        Material configuration
    heat_flux : float
        Incident heat flux [W/m²]
    pressure : float
        Local pressure [Pa]
    
    Returns:
    --------
    dict
        - vaporization_rate: float [kg/(m²·s)] - Mass flux of vaporized material
        - vaporization_active: bool - Whether vaporization is occurring
        - energy_consumed: float [J/kg] - Energy consumed by vaporization
    """
    # Determine vaporization temperature
    if isinstance(material_config, AblativeCoolingConfig):
        T_vap = material_config.surface_temperature_limit * 1.1  # ~10% above limit
    else:  # GraphiteInsertConfig
        T_vap = material_config.surface_temperature_limit * 0.95  # Graphite can handle higher temps
    
    if surface_temperature < T_vap:
        return {
            "vaporization_rate": 0.0,
            "vaporization_active": False,
            "energy_consumed": 0.0,
        }
    
    # Vaporization rate (Clausius-Clapeyron-like)
    # Higher temperature and lower pressure increase rate
    T_excess = surface_temperature - T_vap
    P_effect = (1e6 / max(pressure, 1e3)) ** 0.5  # Lower pressure = higher rate
    
    # Vaporization rate (empirical)
    # Typical: 0.01-0.1 kg/(m²·s) at very high temperatures
    vaporization_rate_max = 0.1  # kg/(m²·s)
    vaporization_rate = vaporization_rate_max * np.exp(-5000.0 / max(surface_temperature, 1000.0)) * P_effect
    
    # Energy consumed (latent heat of vaporization)
    # Typical: 5-15 MJ/kg for high-temperature materials
    delta_h_vaporization = 10.0e6  # J/kg (typical)
    energy_consumed = vaporization_rate * delta_h_vaporization
    
    return {
        "vaporization_rate": float(vaporization_rate),
        "vaporization_active": True,
        "energy_consumed": float(energy_consumed),
    }


def analyze_multi_layer_system(
    layers: List[MaterialLayer],
    bc: ThermalBoundaryConditions,
    ablative_config: Optional[AblativeCoolingConfig] = None,
    graphite_config: Optional[GraphiteInsertConfig] = None,
) -> Dict[str, any]:
    """
    Comprehensive thermal analysis of multi-layer system.
    
    Combines:
    - Steady-state temperature profile
    - Pyrolysis response (if ablative)
    - Vaporization (if high temperature)
    - Back-face temperature check
    
    Parameters:
    -----------
    layers : List[MaterialLayer]
        Material layers (hot to cold)
    bc : ThermalBoundaryConditions
        Boundary conditions
    ablative_config : Optional[AblativeCoolingConfig]
        Ablative configuration (if applicable)
    graphite_config : Optional[GraphiteInsertConfig]
        Graphite configuration (if applicable)
    
    Returns:
    --------
    dict
        Comprehensive thermal analysis results
    """
    # Steady-state temperature profile
    temp_profile = calculate_steady_state_temperature_profile(layers, bc)
    
    T_surface_hot = temp_profile["T_surface_hot"]
    q_total = temp_profile["heat_flux"]
    
    # Pyrolysis response (if ablative)
    pyrolysis_results = {}
    if ablative_config is not None:
        pyrolysis_results = calculate_pyrolysis_response(
            T_surface_hot,
            ablative_config,
            q_total,
        )
    
    # Vaporization (if high temperature)
    vaporization_results = {}
    if ablative_config is not None and T_surface_hot > ablative_config.surface_temperature_limit * 1.05:
        vaporization_results = calculate_vaporization_rate(
            T_surface_hot,
            ablative_config,
            q_total,
        )
    elif graphite_config is not None and T_surface_hot > graphite_config.surface_temperature_limit * 0.9:
        vaporization_results = calculate_vaporization_rate(
            T_surface_hot,
            graphite_config,
            q_total,
        )
    
    # Back-face temperature (last layer cold surface)
    T_backface = temp_profile["T_surface_cold"]
    
    # Compile results
    results = {
        "temperature_profile": temp_profile,
        "T_surface_hot": T_surface_hot,
        "T_backface": T_backface,
        "heat_flux": q_total,
        "pyrolysis": pyrolysis_results,
        "vaporization": vaporization_results,
    }
    
    return results


def calculate_required_ablative_thickness(
    heat_flux: float,
    burn_time: float,
    ablative_config: AblativeCoolingConfig,
    backface_temp_limit: float = 500.0,  # [K] - Max backface temp for stainless steel
    stainless_thickness: float = 0.002,  # [m] - 2mm stainless wall
    stainless_k: float = 15.0,  # [W/(m·K)] - Stainless steel conductivity
) -> Dict[str, float]:
    """
    Calculate required ablative thickness to keep backface below limit.
    
    This is a sizing function to determine how much ablative material is needed.
    
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
    
    Returns:
    --------
    dict
        - required_thickness: float [m] - Required ablative thickness
        - recession_allowance: float [m] - Material lost to recession
        - conduction_thickness: float [m] - Thickness for thermal protection
        - safety_margin: float [m] - Recommended safety margin
    """
    # Estimate surface temperature (iterative, simplified here)
    T_surface_estimate = ablative_config.pyrolysis_temperature * 1.1
    
    # Recession allowance (material consumed during burn)
    # From ablative response model
    delta_T_pyro = max(T_surface_estimate - ablative_config.pyrolysis_temperature, 0.0)
    energy_per_mass = ablative_config.heat_of_ablation + ablative_config.specific_heat * delta_T_pyro
    mass_flux = heat_flux / max(energy_per_mass, 1e-6)
    recession_rate = mass_flux / ablative_config.material_density
    recession_allowance = recession_rate * burn_time
    
    # Conduction thickness (to keep backface cool)
    # Solve: T_backface = T_surface - (q * t_ablative / k_ablative) - (q * t_stainless / k_stainless)
    # Rearrange: t_ablative = (k_ablative / q) * (T_surface - T_backface - q * t_stainless / k_stainless)
    R_stainless = stainless_thickness / stainless_k
    delta_T_stainless = heat_flux * R_stainless
    delta_T_ablative_max = T_surface_estimate - backface_temp_limit - delta_T_stainless
    
    if delta_T_ablative_max <= 0:
        conduction_thickness = 0.0
    else:
        conduction_thickness = (ablative_config.thermal_conductivity / max(heat_flux, 1e-6)) * delta_T_ablative_max
    
    # Safety margin (30% of total)
    total_thickness = recession_allowance + conduction_thickness
    safety_margin = 0.3 * total_thickness
    
    required_thickness = recession_allowance + conduction_thickness + safety_margin
    
    return {
        "required_thickness": float(required_thickness),
        "recession_allowance": float(recession_allowance),
        "conduction_thickness": float(conduction_thickness),
        "safety_margin": float(safety_margin),
        "recession_rate": float(recession_rate),
    }

