"""Utility functions for optimization layers.

Contains parameter extraction and other helper utilities.
"""

from __future__ import annotations

from typing import Dict, Any
import numpy as np

from engine.pipeline.config_schemas import PintleEngineConfig


def extract_all_parameters(config: PintleEngineConfig) -> Dict[str, Any]:
    """Extract all optimized parameters from config."""
    params = {}
    
    # Injector parameters
    if hasattr(config, 'injector') and config.injector.type == "pintle":
        geometry = config.injector.geometry
        if hasattr(geometry, 'fuel'):
            params["d_pintle_tip"] = geometry.fuel.d_pintle_tip
            params["h_gap"] = geometry.fuel.h_gap
            if hasattr(geometry.fuel, 'd_reservoir_inner'):
                params["d_reservoir_inner"] = geometry.fuel.d_reservoir_inner
        if hasattr(geometry, 'lox'):
            params["n_orifices"] = geometry.lox.n_orifices
            params["d_orifice"] = geometry.lox.d_orifice
            params["theta_orifice"] = geometry.lox.theta_orifice
    
    # Chamber parameters
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    cg = ensure_chamber_geometry(config)
    params["A_throat"] = cg.A_throat
    params["Lstar"] = cg.Lstar
    params["chamber_volume"] = cg.volume
    params["chamber_length"] = cg.length
    params["chamber_diameter"] = cg.chamber_diameter
    
    # Nozzle parameters
    params["A_exit"] = cg.A_exit
    params["expansion_ratio"] = cg.expansion_ratio
    
    # Ablative liner parameters
    if hasattr(config, 'ablative_cooling') and config.ablative_cooling and config.ablative_cooling.enabled:
        params["ablative_thickness"] = config.ablative_cooling.initial_thickness
        params["ablative_enabled"] = True
    else:
        params["ablative_thickness"] = 0.0
        params["ablative_enabled"] = False
    
    # Graphite insert parameters
    if hasattr(config, 'graphite_insert') and config.graphite_insert and config.graphite_insert.enabled:
        params["graphite_thickness"] = config.graphite_insert.initial_thickness
        params["graphite_enabled"] = True
    else:
        params["graphite_thickness"] = 0.0
        params["graphite_enabled"] = False
    
    return params

