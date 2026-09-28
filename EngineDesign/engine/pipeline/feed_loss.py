"""Generalized feed system pressure loss model with K_eff(P)

For twin balanced parallel runs each with nominal diameter ``d_line``, set YAML
``A_hydraulic = 2 × π (d_line/2)²`` with ``d_inlet`` omitted (the schema derives the equal-area
bore) so bulk velocity halves vs a single tube at fixed ṁ.

See constants: ``FEED_LINE_DUAL_3_8_EQUIVALENT_D_INLET_M`` and
``FEED_LINE_DUAL_3_8_EQUIVALENT_A_HYDRAULIC_M2`` for two 3/8″ lines.
"""

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

    Δp_feed = K_eff(P) × (ρ/2) × (ṁ/(ρ×A_hyd))²  +  K_exit × (ρ/2) × (ṁ/(ρ×A_exit))²

    where K_eff(P) = K0 + K1 × φ(P), and the second term is the exit bore's velocity head
    dumped into the manifold (Borda-Carnot; K_exit = 1 for a plenum). P_tank minus this is the
    still-manifold pressure that drives the orifices.

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

    # The passage is A_hydraulic (the schema derives it from d_inlet when omitted); the same
    # area sets the chug model's line inertance.
    A_area = float(config.A_hydraulic)
    d_exit = getattr(config, "d_exit", None)
    A_exit = np.pi * (float(d_exit) / 2.0) ** 2 if d_exit else A_area
    K_exit = float(getattr(config, "K_exit", 0.0) or 0.0)

    # Validate inputs
    if A_area <= 0:
        raise ValueError(f"Invalid feed system area: A_area={A_area:.6e} m². Must be > 0. Check d_inlet or A_hydraulic in config.")
    if rho <= 0:
        raise ValueError(f"Invalid fluid density: rho={rho:.2f} kg/m³. Must be > 0.")
    if mdot < 0:
        raise ValueError(f"Invalid mass flow: mdot={mdot:.4f} kg/s. Must be >= 0.")
    
    # Calculate velocity
    velocity = mdot / (rho * A_area)
    v_exit = mdot / (rho * A_exit)

    # Δp_feed = K_eff × (ρ/2) × v² along the line, plus the exit dump at the exit bore
    delta_p = K_eff * (rho / 2) * velocity**2 + K_exit * (rho / 2) * v_exit**2
    
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



