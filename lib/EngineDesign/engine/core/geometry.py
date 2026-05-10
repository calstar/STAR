"""Pintle injector geometry calculations"""

import numpy as np
from typing import Tuple
from engine.pipeline.config_schemas import PintleGeometryConfig


def calculate_lox_area(geom: PintleGeometryConfig) -> float:
    """
    Calculate total LOX flow area (sum of all orifices).
    
    A_LOX = N × π × (d_orifice/2)²
    
    Parameters:
    -----------
    geom : PintleGeometryConfig
        Pintle geometry configuration
    
    Returns:
    --------
    A_LOX : float [m²]
    """
    A_single = np.pi * (geom.lox.d_orifice / 2) ** 2
    A_total = geom.lox.n_orifices * A_single
    return float(A_total)


def calculate_fuel_annulus_area(geom: PintleGeometryConfig) -> float:
    """
    Calculate fuel flow area (annulus between pintle tip and reservoir wall).
    
    Uses exact annulus formula: A = π × (R_outer² - R_inner²)
    where R_inner = d_pintle_tip/2, R_outer = R_inner + h_gap
    
    Parameters:
    -----------
    geom : PintleGeometryConfig
        Pintle geometry configuration
    
    Returns:
    --------
    A_fuel : float [m²]
    """
    R_inner = geom.fuel.d_pintle_tip / 2
    R_outer = R_inner + geom.fuel.h_gap
    A_fuel = np.pi * (R_outer ** 2 - R_inner ** 2)
    return float(A_fuel)


def get_effective_areas(geom: PintleGeometryConfig) -> Tuple[float, float]:
    """
    Get effective flow areas for both LOX and fuel.
    
    Parameters:
    -----------
    geom : PintleGeometryConfig
        Pintle geometry configuration
    
    Returns:
    --------
    A_LOX : float [m²]
        LOX flow area
    A_fuel : float [m²]
        Fuel flow area
    """
    A_LOX = calculate_lox_area(geom)
    A_fuel = calculate_fuel_annulus_area(geom)
    return A_LOX, A_fuel


def get_hydraulic_diameters(geom: PintleGeometryConfig) -> Tuple[float, float]:
    """
    Get hydraulic diameters for both LOX and fuel.
    
    Parameters:
    -----------
    geom : PintleGeometryConfig
        Pintle geometry configuration
    
    Returns:
    --------
    d_hyd_O : float [m]
        LOX hydraulic diameter
    d_hyd_F : float [m]
        Fuel hydraulic diameter
    """
    d_hyd_O = geom.lox.d_hydraulic
    d_hyd_F = geom.fuel.d_hydraulic
    return d_hyd_O, d_hyd_F
