"""Generalized feed system pressure loss model with K_eff(P)

For twin balanced parallel runs each with nominal diameter ``d_line``, set YAML
``A_hydraulic = 2 × π (d_line/2)²`` with ``d_inlet`` omitted (the schema derives the equal-area
bore) so bulk velocity halves vs a single tube at fixed ṁ.

See constants: ``FEED_LINE_DUAL_3_8_EQUIVALENT_D_INLET_M`` and
``FEED_LINE_DUAL_3_8_EQUIVALENT_A_HYDRAULIC_M2`` for two 3/8″ lines.
"""

import logging
import math
from typing import Optional

import numpy as np
from .config_schemas import FeedSystemConfig

try:  # the reference implementation; EngineDesign does not require it
    from fluids.friction import friction_factor as _fluids_friction_factor
except Exception:  # pragma: no cover - exercised only where fluids is absent
    _fluids_friction_factor = None

_log = logging.getLogger(__name__)
_warned_no_mu = False

#: Laminar/turbulent switch for a pipe, as fluids.friction.LAMINAR_TRANSITION_PIPE (2040,
#: Avila et al. 2011). Below it f = 64/Re; the fallback mirrors fluids so both agree.
LAMINAR_TRANSITION_PIPE = 2040.0


def colebrook_darcy(Re: float, eD: float) -> float:
    """Darcy f from Colebrook-White, 1/sqrt(f) = -2 log10(eD/3.7 + 2.51/(Re sqrt(f))).

    Solved to machine precision by fixed-point iteration on x = 1/sqrt(f) from the Haaland
    (1983) explicit start. This is the fallback for when ``fluids`` is not importable; the
    tests hold it to fluids.friction.Colebrook. Laminar (Re < 2040) returns 64/Re, as
    fluids.friction.friction_factor does.
    """
    if not (Re > 0.0):
        return 0.0
    if Re < LAMINAR_TRANSITION_PIPE:
        return 64.0 / Re
    # Haaland: 1/sqrt(f) = -1.8 log10((eD/3.7)^1.11 + 6.9/Re)
    x = -1.8 * math.log10((eD / 3.7) ** 1.11 + 6.9 / Re)
    for _ in range(100):
        x_new = -2.0 * math.log10(eD / 3.7 + 2.51 * x / Re)
        if abs(x_new - x) <= 1e-15 * abs(x_new):
            x = x_new
            break
        x = x_new
    return 1.0 / (x * x)


def darcy_friction_factor(Re: float, eD: float) -> float:
    """Darcy friction factor: fluids.friction.friction_factor (Clamond's exact Colebrook
    solution) when fluids is installed, colebrook_darcy() otherwise."""
    if not (Re > 0.0):
        return 0.0
    if _fluids_friction_factor is not None:
        return float(_fluids_friction_factor(Re=Re, eD=eD))
    return colebrook_darcy(Re, eD)


def fittings_K(config: FeedSystemConfig) -> float:
    """Sum of the itemised fitting K's (line velocity heads); 0.0 when none are declared.

    engine/accel/params.py folds this into K0 for the kernel, so the order of summation here
    is the order there.
    """
    total = 0.0
    for f in getattr(config, "fittings", None) or ():
        total += float(f.K)
    return total


def delta_p_feed(
    mdot: float,
    rho: float,
    config: FeedSystemConfig,
    P_tank: float,
    mu: Optional[float] = None,
) -> float:
    """
    Calculate feed system pressure loss using generalized K_eff(P) model.

    Δp_feed = K_eff(P) × (ρ/2) × (ṁ/(ρ×A_hyd))²  +  K_exit × (ρ/2) × (ṁ/(ρ×A_exit))²

    where K_eff(P) = K_base + ΣK_fittings + K1 × φ(P), K_base = K0, or (roughness_m set and mu
    given) K_entrance + f L/d_inlet with Darcy f from Colebrook-White at Re = ρ v d_inlet/μ;
    and the second term is the exit bore's velocity head
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
    mu : float, optional
        Liquid dynamic viscosity [Pa s]. Needed only by the friction path (``roughness_m``
        set): K0 is replaced by K_entrance + f L/d_inlet with Colebrook f at
        Re = rho v d_inlet / mu. Without mu that path cannot run and the K0 path is used
        (logged once).

    Fittings (``config.fittings``) add to K_eff on either path.

    Returns:
    --------
    delta_p : float
        Pressure loss [Pa]
    """
    global _warned_no_mu
    roughness = getattr(config, "roughness_m", None)
    use_friction = roughness is not None
    if use_friction and mu is None:
        use_friction = False
        if not _warned_no_mu:
            _warned_no_mu = True
            _log.warning(
                "feed_loss: roughness_m is set but the caller passed no viscosity; using K0 "
                "(the measured-override path) instead of Colebrook friction.")
    if use_friction and not (mu > 0):
        raise ValueError(f"Invalid viscosity for feed friction: mu={mu!r} Pa s. Must be > 0.")

    # Base coefficient: K0 (measured/lumped) or entrance + Colebrook f L/D at this call's Re.
    # Fittings add to either. With no fittings and roughness_m None this is exactly K0.
    if use_friction:
        d = float(config.d_inlet)
        v_line = mdot / (rho * float(config.A_hydraulic)) if rho > 0 else 0.0
        Re = rho * v_line * d / float(mu)
        f = darcy_friction_factor(Re, float(roughness) / d)
        K_base = float(config.K_entrance) + f * float(config.length) / d
    else:
        K_base = config.K0
    if getattr(config, "fittings", None):
        K_base = K_base + fittings_K(config)

    # Calculate effective loss coefficient
    if config.phi_type == "none":
        K_eff = K_base
    elif config.phi_type == "sqrtP":
        # FIXED: Ensure sqrt input is positive
        K_eff = K_base + config.K1 * np.sqrt(max(0, P_tank))
    elif config.phi_type == "logP":
        K_eff = K_base + config.K1 * np.log(P_tank)
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



