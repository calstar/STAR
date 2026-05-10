"""Pintle injector shape effects on stability analysis.

This module couples pintle injector geometry to stability calculations,
accounting for:
1. Injector geometry effects on chugging frequency
2. Spray pattern effects on acoustic modes
3. Fuel/oxidizer coupling effects on feed system stability
4. Time-varying injector dynamics
"""

from __future__ import annotations

from typing import Dict, Optional
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig, PintleInjectorConfig


def calculate_pintle_chugging_coupling(
    config: PintleEngineConfig,
    base_chugging_frequency: float,
    chamber_pressure: float,
    oxidizer_mass_flow: float,
    fuel_mass_flow: float,
) -> Dict[str, float]:
    """
    Calculate chugging frequency with pintle injector coupling effects.
    
    Pintle injectors have unique characteristics:
    1. Radial fuel flow creates different coupling than axial flow
    2. LOX orifice pattern affects pressure wave propagation
    3. Pintle tip geometry affects acoustic coupling
    
    Parameters:
    -----------
    config : PintleEngineConfig
        Engine configuration
    base_chugging_frequency : float
        Base chugging frequency [Hz] (without injector coupling)
    chamber_pressure : float
        Chamber pressure [Pa]
    oxidizer_mass_flow : float
        Oxidizer mass flow [kg/s]
    fuel_mass_flow : float
        Fuel mass flow [kg/s]
    
    Returns:
    --------
    coupling_results : dict
        - chugging_frequency: Coupled chugging frequency [Hz]
        - coupling_factor: Injector coupling factor (1.0 = no effect)
        - stability_margin: Updated stability margin
    """
    if not hasattr(config, 'injector') or config.injector.type != "pintle":
        # No coupling for non-pintle injectors
        return {
            "chugging_frequency": base_chugging_frequency,
            "coupling_factor": 1.0,
            "stability_margin": 0.0,
        }
    
    injector_config: PintleInjectorConfig = config.injector
    geometry = injector_config.geometry
    
    # Get pintle geometry parameters
    d_pintle_tip = geometry.fuel.d_pintle_tip
    h_gap = geometry.fuel.h_gap
    n_orifices = geometry.lox.n_orifices
    d_orifice = geometry.lox.d_orifice
    theta_orifice = geometry.lox.theta_orifice  # [deg]
    
    # Calculate injector coupling effects
    
    # 1. Pintle tip size effect
    # Larger pintle tip = more fuel flow area = different coupling
    # Typical chamber diameter ~0.1-0.2 m, pintle tip ~0.01-0.02 m
    # Coupling factor: f_coupling ∝ (d_pintle / D_chamber)
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    try:
        cg = ensure_chamber_geometry(config)
        V_chamber = cg.volume
        L_chamber = cg.length if cg.length else 0.2
        D_chamber = np.sqrt(4 * V_chamber / (np.pi * L_chamber)) if L_chamber > 0 else cg.chamber_diameter
    except (ValueError, AttributeError):
        D_chamber = 0.1  # Default
    
    pintle_ratio = d_pintle_tip / D_chamber if D_chamber > 0 else 0.1
    
    # 2. Orifice pattern effect
    # More orifices = more distributed injection = better stability
    # Fewer orifices = more concentrated = potential instability
    orifice_density = n_orifices / (np.pi * D_chamber) if D_chamber > 0 else 10.0
    orifice_factor = 1.0 + 0.1 * (orifice_density - 10.0) / 10.0  # Normalize around 10 orifices/m
    
    # 3. Spray angle effect
    # Steeper angles (larger theta) = more direct impingement = different coupling
    # Typical angles: 30-60 degrees
    theta_rad = np.deg2rad(theta_orifice)
    angle_factor = 1.0 + 0.05 * (theta_orifice - 45.0) / 45.0  # Normalize around 45 deg
    
    # 4. Fuel gap effect
    # Smaller gap = higher fuel velocity = different coupling
    # Typical gap: 0.1-0.5 mm
    gap_factor = 1.0 + 0.1 * (0.0003 - h_gap) / 0.0003  # Normalize around 0.3 mm
    
    # Combined coupling factor
    # Positive values = destabilizing, negative = stabilizing
    coupling_factor = 1.0 + (
        0.2 * (pintle_ratio - 0.1) +  # Pintle size effect
        0.1 * (orifice_factor - 1.0) +  # Orifice pattern
        0.05 * (angle_factor - 1.0) +  # Spray angle
        0.05 * (gap_factor - 1.0)  # Gap size
    )
    
    # Apply coupling to chugging frequency
    # Coupling can shift frequency up or down
    coupled_frequency = base_chugging_frequency * coupling_factor
    
    # Calculate stability margin (simplified)
    # Higher frequency = typically more stable (further from feed system resonance)
    # Feed system resonance typically ~10-50 Hz
    feed_resonance = 30.0  # Typical feed system frequency [Hz]
    frequency_separation = abs(coupled_frequency - feed_resonance)
    stability_margin = frequency_separation / feed_resonance  # Normalized margin
    
    return {
        "chugging_frequency": coupled_frequency,
        "coupling_factor": coupling_factor,
        "stability_margin": stability_margin,
        "pintle_ratio": pintle_ratio,
        "orifice_factor": orifice_factor,
        "angle_factor": angle_factor,
        "gap_factor": gap_factor,
    }


def calculate_pintle_acoustic_coupling(
    config: PintleEngineConfig,
    base_acoustic_frequencies: Dict[str, float],
    chamber_length: float,
    chamber_diameter: float,
    sound_speed: float,
) -> Dict[str, float]:
    """
    Calculate acoustic mode frequencies with pintle injector coupling.
    
    Pintle injectors affect acoustic modes through:
    1. Radial fuel injection creates different mode shapes
    2. LOX orifice pattern affects mode coupling
    3. Pintle geometry affects boundary conditions
    
    Parameters:
    -----------
    config : PintleEngineConfig
        Engine configuration
    base_acoustic_frequencies : dict
        Base acoustic frequencies [Hz] (without injector coupling)
        Keys: "1L", "2L", "1T", etc.
    chamber_length : float
        Chamber length [m]
    chamber_diameter : float
        Chamber diameter [m]
    sound_speed : float
        Sound speed in chamber [m/s]
    
    Returns:
    --------
    coupled_frequencies : dict
        Coupled acoustic frequencies [Hz]
    """
    if not hasattr(config, 'injector') or config.injector.type != "pintle":
        return base_acoustic_frequencies
    
    injector_config: PintleInjectorConfig = config.injector
    geometry = injector_config.geometry
    
    # Get pintle parameters
    d_pintle_tip = geometry.fuel.d_pintle_tip
    n_orifices = geometry.lox.n_orifices
    
    # Calculate coupling effects
    # Radial injection affects transverse modes more than longitudinal
    # Pintle creates a "soft" boundary condition at injector face
    
    # Longitudinal mode coupling (1L, 2L, etc.)
    # Pintle injector face acts as partially reflecting boundary
    # Effective length slightly longer than physical length
    L_effective = chamber_length * 1.05  # 5% increase due to soft boundary
    
    # Transverse mode coupling (1T, 2T, etc.)
    # Radial injection affects transverse modes
    # More orifices = more distributed = different mode shapes
    transverse_factor = 1.0 + 0.02 * (n_orifices - 16) / 16.0  # Normalize around 16 orifices
    
    coupled_frequencies = {}
    for mode_name, base_freq in base_acoustic_frequencies.items():
        if "L" in mode_name:  # Longitudinal mode
            # Frequency scales with effective length
            coupled_freq = base_freq * (chamber_length / L_effective)
        elif "T" in mode_name:  # Transverse mode
            # Frequency affected by orifice pattern
            coupled_freq = base_freq * transverse_factor
        else:
            # Other modes: minimal coupling
            coupled_freq = base_freq
        
        coupled_frequencies[mode_name] = coupled_freq
    
    return coupled_frequencies

