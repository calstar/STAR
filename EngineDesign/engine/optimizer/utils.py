"""Utility functions for optimization layers.

Contains parameter extraction and other helper utilities.
"""

from __future__ import annotations

from typing import Dict, Any
import numpy as np

from engine.pipeline.config_schemas import PintleEngineConfig

# Impinging injector bounds (Layer-1 + feasibility scripts): scale with chamber bore.
DEFAULT_IMPINGING_WALL_THICKNESS_M = 0.0254
IMPINGING_JET_PITCH_ESTIMATE_M = 0.004  # heuristic min center-to-center spacing for n_elements ceiling
IMPINGING_N_ELEMENTS_ABSOLUTE_CAP = 200


def extract_all_parameters(config: PintleEngineConfig) -> Dict[str, Any]:
    """Extract all optimized parameters from config."""
    params = {}
    injector_type = getattr(getattr(config, "injector", None), "type", None)
    if injector_type is not None:
        params["injector_type"] = injector_type
    
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
    elif hasattr(config, 'injector') and config.injector.type == "impinging":
        g = config.injector.geometry
        nd = int(min(int(g.oxidizer.n_elements), int(g.fuel.n_elements)))
        params["n_doublets"] = nd
        # Canonical frontend keys for impinging geometry
        params["n_elements_O"] = int(g.oxidizer.n_elements)
        params["d_jet_O"] = g.oxidizer.d_jet
        params["imp_angle_O"] = g.oxidizer.impingement_angle
        params["spacing_O"] = g.oxidizer.spacing
        params["n_elements_F"] = int(g.fuel.n_elements)
        params["d_jet_F"] = g.fuel.d_jet
        params["imp_angle_F"] = g.fuel.impingement_angle
        params["spacing_F"] = g.fuel.spacing
        # Backward-compatible aliases used by older views/scripts.
        params["d_jet_oxidizer"] = g.oxidizer.d_jet
        params["impingement_angle_oxidizer"] = g.oxidizer.impingement_angle
        params["spacing_oxidizer"] = g.oxidizer.spacing
        params["d_jet_fuel"] = g.fuel.d_jet
        params["impingement_angle_fuel"] = g.fuel.impingement_angle
        params["spacing_fuel"] = g.fuel.spacing
    
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


def impinging_chamber_inner_diameter_for_bounds(
    config: PintleEngineConfig,
    *,
    max_chamber_outer_diameter_m: float,
    wall_thickness_m: float = DEFAULT_IMPINGING_WALL_THICKNESS_M,
) -> float:
    """Bore used for impinging packing / n_elements limits.

    Prefer ``chamber_geometry.chamber_diameter``; else frozen outer diameter minus wall;
    else legacy heuristic ``0.5 * max_od - wall`` (underestimates full-OD designs).
    """
    cg = getattr(config, "chamber_geometry", None)
    if cg is not None:
        d = getattr(cg, "chamber_diameter", None)
        if d is not None and float(d) > 0.0:
            return float(d)
    dr = getattr(config, "design_requirements", None)
    if dr is not None:
        fp = getattr(dr, "frozen_parameters", None)
        if fp is not None:
            domm = getattr(fp, "D_chamber_outer_mm", None)
            if domm is not None and float(domm) > 0.0:
                return float(domm) * 1e-3 - wall_thickness_m
    min_outer = float(max_chamber_outer_diameter_m) * 0.5
    return float(max(min_outer - wall_thickness_m, 0.02))


def impinging_n_elements_hi_int(
    chamber_inner_diameter_m: float,
    *,
    pitch_est_m: float = IMPINGING_JET_PITCH_ESTIMATE_M,
    absolute_cap: int = IMPINGING_N_ELEMENTS_ABSOLUTE_CAP,
) -> int:
    """Upper integer count ~ circumference / pitch, capped for optimizer stability."""
    if chamber_inner_diameter_m <= 0.0:
        return 12
    n_circ = int(np.pi * chamber_inner_diameter_m / max(pitch_est_m, 1e-9))
    return int(max(12, min(absolute_cap, n_circ)))


def impinging_d_jet_upper_bound_m(chamber_inner_diameter_m: float) -> float:
    """Allow larger jets on larger bores; keep 4 mm floor for small chambers."""
    d = float(chamber_inner_diameter_m)
    return float(min(0.008, max(0.004, 0.038 * d)))


def impinging_spacing_upper_bound_m(chamber_inner_diameter_m: float) -> float:
    """Wider spacing cap for large injector faces (packing uses π D²/4)."""
    d = float(chamber_inner_diameter_m)
    return float(min(0.14, max(0.06, 0.42 * d)))

