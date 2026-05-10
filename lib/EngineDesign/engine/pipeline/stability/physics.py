"""Physics-based stability analysis for pintle injectors.

Accounts for:
1. Pintle geometry (tip diameter, length, gap)
2. Fuel impingement zones (localized instability sources)
3. Uneven ablation (spatial variation in geometry)
4. Real wave propagation physics
"""

from __future__ import annotations

from typing import Dict, List, Tuple, Optional
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig, PintleInjectorConfig
from engine.pipeline.localized_ablation import calculate_impingement_zones


def calculate_pintle_stability_with_geometry(
    config: PintleEngineConfig,
    positions: np.ndarray,
    chamber_pressure: np.ndarray,
    sound_speed: np.ndarray,
    density: np.ndarray,
    mass_flow: np.ndarray,
    recession_profile: Optional[np.ndarray] = None,
    L_chamber: float = 0.2,
    D_chamber: float = 0.1,
) -> Dict[str, np.ndarray]:
    """
    Calculate stability with pintle geometry and impingement effects.
    
    Physics:
    1. Pintle geometry affects injector impedance
    2. Fuel impingement creates localized instability sources
    3. Uneven ablation creates spatial variation in geometry
    4. Wave propagation affected by all of the above
    
    Parameters:
    -----------
    config : PintleEngineConfig
        Engine configuration
    positions : np.ndarray
        Axial positions [m]
    chamber_pressure : np.ndarray
        Local pressure [Pa]
    sound_speed : np.ndarray
        Local sound speed [m/s]
    density : np.ndarray
        Local density [kg/m³]
    mass_flow : np.ndarray
        Local mass flow [kg/s]
    recession_profile : np.ndarray, optional
        Local recession [m] at each position (for uneven ablation)
    L_chamber : float
        Chamber length [m]
    D_chamber : float
        Chamber diameter [m]
    
    Returns:
    --------
    stability : dict
        - chugging_frequency: Local chugging frequency [Hz]
        - stability_margin: Local stability margin
        - wave_growth_rate: Wave growth rate [1/s]
        - impingement_effect: Effect of impingement on stability
        - ablation_effect: Effect of uneven ablation on stability
    """
    n_points = len(positions)
    
    # Get pintle geometry
    if not hasattr(config, 'injector') or config.injector.type != "pintle":
        # No pintle-specific effects
        return {
            "chugging_frequency": np.full(n_points, 30.0),
            "stability_margin": np.full(n_points, 0.5),
            "wave_growth_rate": np.full(n_points, -10.0),
            "impingement_effect": np.zeros(n_points),
            "ablation_effect": np.zeros(n_points),
        }
    
    injector_config: PintleInjectorConfig = config.injector
    geometry = injector_config.geometry
    
    # Pintle geometry parameters
    d_pintle_tip = geometry.fuel.d_pintle_tip
    h_gap = geometry.fuel.h_gap
    L_pintle = getattr(geometry.fuel, 'L_pintle', 0.01)  # Pintle length
    n_orifices = geometry.lox.n_orifices
    d_orifice = geometry.lox.d_orifice
    theta_orifice = geometry.lox.theta_orifice
    
    # Calculate impingement zones
    impingement_data = calculate_impingement_zones(
        config, L_chamber, D_chamber, n_points=n_points
    )
    impingement_multiplier = impingement_data["impingement_heat_flux_multiplier"]
    impingement_zones = impingement_data["impingement_zones"]
    
    # Calculate injector impedance from pintle geometry
    # Acoustic impedance: Z = ρ × c / A
    # Pintle creates impedance based on tip area and gap
    A_pintle_tip = np.pi * (d_pintle_tip / 2.0) ** 2
    A_gap = np.pi * d_pintle_tip * h_gap  # Annular gap area
    A_injector_effective = A_pintle_tip + A_gap  # Effective injector area
    
    # Injector impedance (at injection plane)
    rho_injector = density[0] if len(density) > 0 else 1000.0
    c_injector = sound_speed[0] if len(sound_speed) > 0 else 1000.0
    Z_injector = rho_injector * c_injector / A_injector_effective if A_injector_effective > 0 else 1e6
    
    # Feed system impedance (simplified)
    Z_feed = 5e5  # Typical feed system impedance [Pa·s/m³]
    
    # Calculate local impedances
    A_local = np.pi * (D_chamber / 2.0) ** 2  # Local chamber area
    Z_local = density * sound_speed / A_local
    
    # Wave propagation time
    L_total = positions[-1] - positions[0] if len(positions) > 1 else L_chamber
    tau_wave = L_total / sound_speed  # Wave propagation time
    
    # Chugging frequency from wave resonance
    # f = c / (4L) for open-closed tube (injector closed, throat open)
    f_chugging_base = sound_speed / (4.0 * L_total)
    
    # Pintle geometry effect on frequency
    # Larger pintle = different coupling = frequency shift
    pintle_ratio = d_pintle_tip / D_chamber if D_chamber > 0 else 0.1
    frequency_shift = 1.0 + 0.2 * (pintle_ratio - 0.1)  # Shift based on pintle size
    f_chugging = f_chugging_base * frequency_shift
    
    # Impingement effect on stability
    # Fuel impingement creates localized pressure fluctuations
    # These act as instability sources
    impingement_effect = np.zeros(n_points)
    for i, (pos, is_impingement) in enumerate(zip(positions, impingement_zones)):
        if is_impingement:
            # Impingement creates pressure fluctuation source
            # Effect decays with distance from impingement
            distance_from_impingement = abs(pos - impingement_data["impingement_center"])
            decay_factor = np.exp(-distance_from_impingement / (L_chamber * 0.1))
            impingement_effect[i] = (impingement_multiplier[i] - 1.0) * decay_factor * 0.5  # Destabilizing
    
    # Uneven ablation effect
    # Spatial variation in geometry creates impedance mismatches
    # These reflect waves and can cause instability
    ablation_effect = np.zeros(n_points)
    if recession_profile is not None and len(recession_profile) == n_points:
        # Calculate local diameter variation
        D_local = D_chamber + 2.0 * recession_profile
        A_local_varying = np.pi * (D_local / 2.0) ** 2
        
        # Impedance variation
        Z_varying = density * sound_speed / A_local_varying
        
        # Impedance mismatch creates reflections
        # Large mismatch = more reflections = potential instability
        Z_ref = Z_local[0] if len(Z_local) > 0 else Z_local.mean()
        impedance_mismatch = np.abs(Z_varying - Z_ref) / (Z_ref + 1e-10)
        ablation_effect = impedance_mismatch * 0.3  # Destabilizing effect
    
    # Wave growth rate from energy balance
    # Energy input from combustion vs. energy dissipation
    energy_input = chamber_pressure * mass_flow / density  # [W/m³]
    energy_dissipation = density * (mass_flow / (density * A_local)) ** 2 / L_total  # [W/m³]
    energy_stored = 0.5 * density * sound_speed ** 2  # [J/m³]
    
    # Base growth rate
    wave_growth_base = (energy_input - energy_dissipation) / (2.0 * energy_stored + 1e-10)
    
    # Add impingement and ablation effects
    wave_growth_rate = wave_growth_base + impingement_effect - ablation_effect * 0.5
    
    # Stability margin
    reference_rate = 100.0  # [1/s]
    stability_margin = -wave_growth_rate / reference_rate
    
    return {
        "chugging_frequency": f_chugging,
        "stability_margin": stability_margin,
        "wave_growth_rate": wave_growth_rate,
        "impingement_effect": impingement_effect,
        "ablation_effect": ablation_effect,
        "pintle_ratio": pintle_ratio,
        "frequency_shift": frequency_shift,
    }

