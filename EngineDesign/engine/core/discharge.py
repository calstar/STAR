"""Pintle injector discharge coefficient model Cd(Re)"""

import numpy as np
from engine.pipeline.config_schemas import DischargeConfig


def cd_from_re(
    Re: float,
    config: DischargeConfig,
    P_inlet: float = None,
    T_inlet: float = None
) -> float:
    """
    Calculate discharge coefficient as function of Reynolds number, pressure, and temperature.
    
    Base formula: Cd(Re) = Cd_∞ - a_Re / √Re
    
    With corrections:
    - Pressure correction: Cd(P) = Cd(Re) × [1 + a_P × (P/P_ref - 1)]
      (accounts for compressibility effects at high pressure)
    - Temperature correction: Cd(T) = Cd(Re) × [1 + a_T × (T/T_ref - 1)]
      (accounts for viscosity changes with temperature)
    
    Clamped to [Cd_min, Cd_∞]
    
    Parameters:
    -----------
    Re : float
        Reynolds number
    config : DischargeConfig
        Discharge coefficient configuration
    P_inlet : float, optional
        Inlet pressure [Pa] (for pressure correction)
    T_inlet : float, optional
        Inlet temperature [K] (for temperature correction)
    
    Returns:
    --------
    Cd : float
        Discharge coefficient
    """
    if Re <= 0:
        return config.Cd_min
    
    # Base Reynolds-dependent formula
    # FIXED: Ensure sqrt input is positive
    Cd = config.Cd_inf - config.a_Re / np.sqrt(max(Re, 1e-6))
    
    # Pressure correction (compressibility effects)
    # At high pressures, compressibility reduces effective flow area
    if config.use_pressure_correction and P_inlet is not None and config.P_ref > 0:
        P_correction = 1.0 + config.a_P * (P_inlet / config.P_ref - 1.0)
        Cd *= P_correction
    
    # Temperature correction (viscosity effects)
    # Temperature affects viscosity, which affects flow development and Cd
    if config.use_temperature_correction and T_inlet is not None and config.T_ref > 0:
        T_correction = 1.0 + config.a_T * (T_inlet / config.T_ref - 1.0)
        Cd *= T_correction
    
    # Clamp to bounds
    Cd = np.clip(Cd, config.Cd_min, config.Cd_inf)
    
    return float(Cd)


def calculate_reynolds_number(
    rho: float,
    u: float,
    d_hyd: float,
    mu: float
) -> float:
    """
    Calculate Reynolds number.
    
    Re = (ρ × u × d_hyd) / μ
    
    Parameters:
    -----------
    rho : float
        Density [kg/m³]
    u : float
        Velocity [m/s]
    d_hyd : float
        Hydraulic diameter [m]
    mu : float
        Dynamic viscosity [Pa·s]
    
    Returns:
    --------
    Re : float
    """
    if mu <= 0:
        return 1e6  # Large Re for inviscid flow
    
    Re = (rho * u * d_hyd) / mu
    return float(Re)

