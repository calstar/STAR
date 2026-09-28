"""c* efficiency: vaporization and mixing (combustion_physics) and heat lost to the wall."""

import numpy as np
import logging
from typing import Optional, Dict, Any, Tuple
from .config_schemas import CombustionEfficiencyConfig
from .constants import (
    DEFAULT_CHAMBER_PRESS_PA,
    DEFAULT_CHAMBER_TEMP_K,
    DEFAULT_CSTAR_IDEAL_M_S,
    DEFAULT_GAMMA_ND,
    DEFAULT_GAS_CONST_J_KG_K,
    DEFAULT_MIXTURE_RATIO_ND,
)


def calculate_Lstar(
    V_chamber: float,
    A_throat: float,
    Lstar_override: Optional[float] = None
) -> float:
    """
    Calculate characteristic length L*.
    
    L* = V_chamber / A_throat
    
    Parameters:
    -----------
    V_chamber : float
        Chamber volume [m³]
    A_throat : float
        Throat area [m²]
    Lstar_override : float, optional
        Override value if provided in config
    
    Returns:
    --------
    Lstar : float [m]
    """
    if Lstar_override is not None:
        return float(Lstar_override)
    
    if A_throat <= 0:
        raise ValueError("A_throat must be positive")
    
    Lstar = V_chamber / A_throat
    return float(Lstar)


# Heat that returns to the propellant is not a c* loss. Regenerative heat goes back to the
# injector with the coolant (Huzel & Huang ch. 4); film coolant, and the enthalpy it picks up, stay
# in the chamber flow. Every other source -- the ablative liner, a heat sink -- leaves for good.
_HEAT_RETURNED_TO_PROPELLANT = ("regen", "film")


def wall_heat_lost_W(cooling_results: Optional[Dict[str, Any]]) -> Tuple[float, Dict[str, float]]:
    """Heat [W] that leaves the propellant through the chamber wall, and its split by source."""
    per: Dict[str, float] = {}
    for name, src in (cooling_results or {}).items():
        if name in _HEAT_RETURNED_TO_PROPELLANT or not isinstance(src, dict):
            continue
        q = float(src.get("heat_removed", 0.0) or 0.0)
        if q > 0.0:
            per[name] = q
    return float(sum(per.values())), per


def heat_loss_cstar_efficiency(
    Q_lost: float,
    m_dot_total: float,
    Tc: float,
    gamma: float,
    R: float,
) -> float:
    """c* retained when Q_lost [W] leaves the gas upstream of the throat.

    c* = sqrt(gamma R T0) / Gamma(gamma) (Sutton & Biblarz eq. 3-32), so at fixed composition
    c* ~ sqrt(T0). Removing Q lowers the stagnation enthalpy by Q/mdot and T0 by Q/(mdot cp):

        eta_HL = sqrt(1 - Q/(mdot cp Tc)),   cp = gamma R/(gamma - 1),  Tc the adiabatic CEA value.

    Against rocketcea with the propellant enthalpy lowered by Q/mdot (LOX/ethanol, 200-800 psia,
    O/F 1.0-2.2, 188 kJ/kg) the loss is 0.94-1.34x CEA's; the excess near stoichiometric is heat
    that recombination returns. The linear 1 - Q/(mdot cp T_eff) it replaces was 1.9-2.7x.
    """
    if Q_lost <= 0.0:
        return 1.0
    for name, v in (("m_dot_total", m_dot_total), ("Tc", Tc), ("R", R)):
        if not (np.isfinite(v) and v > 0):
            raise ValueError(f"heat_loss_cstar_efficiency: invalid {name}={v}")
    if not (np.isfinite(gamma) and gamma > 1.0):
        raise ValueError(f"heat_loss_cstar_efficiency: invalid gamma={gamma}")
    x = Q_lost / (m_dot_total * gamma * R / (gamma - 1.0) * Tc)
    # All of the stagnation enthalpy gone is the physical end of the scale.
    return float(np.sqrt(max(1.0 - x, 0.0)))


def eta_cstar(
    Lstar: float,
    config: CombustionEfficiencyConfig,
    cooling_efficiency: float,
    advanced_params: Dict[str, Any],
    debug: bool = False,
) -> float:
    """c* efficiency, eta_vap * eta_mix * eta_HL.

    eta_vap and eta_mix come from combustion_physics. eta_HL is the heat lost through the wall,
    taken from the cooling results the chamber solver leaves in the spray diagnostics
    (``spray_diagnostics["cooling"]``); ``cooling_efficiency`` is used only when the call carries
    none. The breakdown, with its inputs and assumptions, is written back to
    ``spray_diagnostics["cstar_efficiency"]`` so it reaches the reported diagnostics.

    advanced_params: Pc, Tc (CEA, adiabatic), cstar_ideal, gamma, R, MR, Ac, At, m_dot_total,
    u_fuel, u_lox, spray_diagnostics, fuel_props, and optionally ox_props.
    """
    from .combustion_physics import calculate_combustion_efficiency_advanced

    Pc = advanced_params.get("Pc", DEFAULT_CHAMBER_PRESS_PA)
    Tc = advanced_params.get("Tc", DEFAULT_CHAMBER_TEMP_K)
    cstar_ideal = advanced_params.get("cstar_ideal", DEFAULT_CSTAR_IDEAL_M_S)
    gamma = advanced_params.get("gamma", DEFAULT_GAMMA_ND)
    R = advanced_params.get("R", DEFAULT_GAS_CONST_J_KG_K)
    MR = advanced_params.get("MR", DEFAULT_MIXTURE_RATIO_ND)
    Ac = advanced_params.get("Ac", None)
    At = advanced_params.get("At", None)
    m_dot_total = advanced_params.get("m_dot_total", None)
    spray_diagnostics = advanced_params.get("spray_diagnostics", None)
    if Ac is None or m_dot_total is None:
        raise ValueError("Ac and m_dot_total are required for combustion efficiency calculation")
    if At is None:
        raise ValueError("At is required for combustion efficiency calculation")

    results = calculate_combustion_efficiency_advanced(
        Lstar, Pc, Tc, cstar_ideal, gamma, R, MR, config, Ac, At, m_dot_total,
        u_fuel=advanced_params.get("u_fuel", None),
        u_lox=advanced_params.get("u_lox", None),
        spray_diagnostics=spray_diagnostics,
        fuel_props=advanced_params.get("fuel_props", None),
        ox_props=advanced_params.get("ox_props", None),
        debug=debug,
    )

    cooling_results = spray_diagnostics.get("cooling") if isinstance(spray_diagnostics, dict) else None
    Q_lost, Q_by_source = wall_heat_lost_W(cooling_results)
    if not config.use_cooling_coupling:
        eta_HL = 1.0
    elif isinstance(cooling_results, dict):
        eta_HL = heat_loss_cstar_efficiency(Q_lost, float(m_dot_total), float(Tc), float(gamma), float(R))
    else:
        if not (np.isfinite(cooling_efficiency) and 0.0 <= cooling_efficiency <= 1.0):
            raise ValueError(f"Invalid cooling_efficiency: {cooling_efficiency}. Must be in [0, 1].")
        eta_HL = float(cooling_efficiency)
    if isinstance(cooling_results, dict) and cooling_results.get("film", {}).get("enabled"):
        results["assumptions"].append({
            "name": "combustion.film_cooling_cstar_loss", "value": None, "unit": "",
            "reason": "film coolant stays in the flow; its c* cost (a fuel-rich wall layer) is not modelled"})

    eta = results["eta_total"] * eta_HL
    if not (np.isfinite(eta) and 0.0 <= eta <= 1.0):
        raise ValueError(
            f"Invalid combustion efficiency {eta}: L*={Lstar:.4f} m, eta_vap={results['eta_vaporization']:.4f}, "
            f"eta_mix={results['eta_mixing']:.4f}, eta_HL={eta_HL:.4f}."
        )

    if isinstance(spray_diagnostics, dict):
        spray_diagnostics["cstar_efficiency"] = {
            **results,
            "eta_heat_loss": float(eta_HL),
            "heat_lost_W": float(Q_lost),
            "heat_lost_by_source_W": Q_by_source,
            "eta_cstar": float(eta),
        }
    if debug:
        logging.getLogger("evaluate").info(
            f"[ETA] eta_c*={eta:.4f} = vap {results['eta_vaporization']:.4f} x mix "
            f"{results['eta_mixing']:.4f} x HL {eta_HL:.4f} (Q_lost {Q_lost/1e3:.1f} kW)"
        )
    return float(eta)


def calculate_actual_chamber_temp(
    Tc_ideal: float,
    eta: float,
    gamma: float
) -> float:
    """
    Calculate actual chamber temperature accounting for combustion efficiency.
    
    T_c,actual = T_c,ideal × [η / (1 - (1-η) × (γ-1)/γ)]
    
    Parameters:
    -----------
    Tc_ideal : float
        Ideal chamber temperature from CEA [K]
    eta : float
        Combustion efficiency
    gamma : float
        Specific heat ratio
    
    Returns:
    --------
    Tc_actual : float [K]
    """
    if gamma <= 1:
        return Tc_ideal
    
    denominator = 1.0 - (1.0 - eta) * (gamma - 1.0) / gamma
    if denominator <= 0:
        return Tc_ideal
    
    Tc_actual = Tc_ideal * (eta / denominator)
    return float(Tc_actual)


def calculate_frozen_flow_correction(
    Lstar: float,
    gamma_ideal: float,
    alpha: float = 0.1
) -> float:
    """
    Calculate frozen flow correction factor for gamma.
    
    γ_actual = γ_ideal × [1 - α × (1 - η_c*)]
    
    This accounts for incomplete chemical reactions in the nozzle.
    
    Parameters:
    -----------
    Lstar : float
        Characteristic length [m]
    gamma_ideal : float
        Ideal gamma from CEA
    alpha : float
        Frozen flow parameter (default 0.1)
    
    Returns:
    --------
    correction_factor : float
        Factor to multiply gamma_ideal by
    """
    # Validate inputs
    if Lstar <= 0:
        raise ValueError(f"Invalid Lstar: {Lstar}. Must be positive.")
    if gamma_ideal <= 1.0:
        raise ValueError(f"Invalid gamma_ideal: {gamma_ideal}. Must be > 1.0 for physical gas.")
    if alpha < 0 or alpha > 1:
        raise ValueError(f"Invalid alpha: {alpha}. Must be in [0, 1].")
    
    # Estimate efficiency from L* (simplified)
    # Using default C=0.3, K=0.15
    eta_est = 1.0 - 0.3 * np.exp(-0.15 * Lstar)
    
    correction = 1.0 - alpha * (1.0 - eta_est)
    
    # Validate correction factor - no clipping, raise error if invalid
    if not np.isfinite(correction):
        raise ValueError(f"Invalid frozen flow correction: {correction}. Check Lstar={Lstar}, alpha={alpha}.")
    if correction < 0.5 or correction > 1.1:
        raise ValueError(
            f"Frozen flow correction out of reasonable range: {correction:.4f}. "
            f"Expected [0.5, 1.1] for typical rocket engines. "
            f"Lstar={Lstar:.4f} m, gamma_ideal={gamma_ideal:.4f}, alpha={alpha:.4f}. "
            f"This suggests a fundamental issue with the model or inputs."
        )
    
    return float(correction)
