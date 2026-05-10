"""Generalized feed system pressure loss model with K_eff(P)"""

import numpy as np
from .config_schemas import FeedSystemConfig


def delta_p_feed(
    mdot: float,
    rho: float,
    config: FeedSystemConfig,
    P_tank: float
) -> float:
    """
    Calculate feed system pressure loss using generalized K_eff(P) model.
    
    Δp_feed = K_eff(P) × (ρ/2) × (ṁ/(ρ×A_hyd))²
    
    where K_eff(P) = K0 + K1 × φ(P)
    
    Parameters:
    -----------
    mdot : float
        Mass flow rate [kg/s]
    rho : float
        Fluid density [kg/m³]
    config : FeedSystemConfig
        Feed system configuration
    P_tank : float
        Tank pressure [Pa] (used for pressure-dependent K_eff)
    
    Returns:
    --------
    delta_p : float
        Pressure loss [Pa]
    """
    # Calculate effective loss coefficient
    if config.phi_type == "none":
        K_eff = config.K0
    elif config.phi_type == "sqrtP":
        # FIXED: Ensure sqrt input is positive
        K_eff = config.K0 + config.K1 * np.sqrt(max(0, P_tank))
    elif config.phi_type == "logP":
        K_eff = config.K0 + config.K1 * np.log(P_tank)
    else:
        raise ValueError(f"Unknown phi_type: {config.phi_type}")
    
    # Calculate area from inlet diameter if A_hydraulic not explicitly set
    # A_hydraulic should be calculated from d_inlet if not provided
    # Check both attribute access and dict access (config might be dict or object)
    d_inlet = None
    if hasattr(config, 'd_inlet'):
        d_inlet = config.d_inlet
    elif isinstance(config, dict) and 'd_inlet' in config:
        d_inlet = config['d_inlet']
    
    if d_inlet is not None and d_inlet > 0:
        A_area = np.pi * (d_inlet / 2) ** 2
    else:
        # Use A_hydraulic if available
        if hasattr(config, 'A_hydraulic'):
            A_area = config.A_hydraulic
        elif isinstance(config, dict) and 'A_hydraulic' in config:
            A_area = config['A_hydraulic']
        else:
            # Fallback: calculate from d_inlet if it exists but wasn't caught above
            raise ValueError(f"Feed system config must have either d_inlet > 0 or A_hydraulic > 0. Got: d_inlet={d_inlet}, config={config}")
    
    # Validate inputs
    if A_area <= 0:
        raise ValueError(f"Invalid feed system area: A_area={A_area:.6e} m². Must be > 0. Check d_inlet or A_hydraulic in config.")
    if rho <= 0:
        raise ValueError(f"Invalid fluid density: rho={rho:.2f} kg/m³. Must be > 0.")
    if mdot < 0:
        raise ValueError(f"Invalid mass flow: mdot={mdot:.4f} kg/s. Must be >= 0.")
    
    # Calculate velocity
    velocity = mdot / (rho * A_area)
    
    # Calculate pressure loss
    # Δp_feed = K_eff × (ρ/2) × v²
    # This is the standard form for minor losses in pipe flow
    delta_p = K_eff * (rho / 2) * velocity**2
    
    # Ensure non-negative (pressure loss can't be negative)
    delta_p = max(0.0, delta_p)
    
    # Debug output for zero pressure drop
    if delta_p == 0.0 and mdot > 0.01:  # Only warn if there's significant flow
        import warnings
        warnings.warn(
            f"Feed system pressure drop is zero with mdot={mdot:.4f} kg/s, rho={rho:.2f} kg/m³, "
            f"A_area={A_area:.6e} m², K_eff={K_eff:.2f}, velocity={velocity:.2f} m/s. "
            f"Check feed system configuration."
        )
    
    return float(delta_p)



