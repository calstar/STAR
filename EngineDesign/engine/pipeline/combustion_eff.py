"""Combustion efficiency models (L* correction)

This module provides both:
1. Simple efficiency model (eta_cstar) - backward compatible
2. Advanced physics-based model (via combustion_physics module)

THREE SIMILAR NAMES, THREE DIFFERENT QUANTITIES. They have been confused
before, so the distinction is spelled out here:

    eta_combustion  incomplete burning alone: mixing x kinetics x L*.
                    combustion_physics returns this under the key
                    "eta_total" -- "total" there means the total of the
                    combustion sub-efficiencies, NOT the total efficiency.
    eta_cooling     energy carried off by film/ablative/regen cooling alone.
                    Computed by chamber_solver._compute_cooling_efficiency as
                    an ENERGY fraction, which is also the factor on chamber
                    temperature. Its effect on c* is the SQUARE ROOT of that,
                    because c* goes as sqrt(Tc).
    eta_cstar       eta_combustion x sqrt(eta_cooling), and the return value of
                    eta_cstar() below.

eta_cstar is a correct name for the product: c* is reduced by both effects,
and c*_actual = eta_cstar x c*_ideal is the only place it is ever applied.
What it is NOT is "the combustion efficiency" -- this module's docstrings
used to say that, which is how a cooling term ended up hiding inside a
number that reads as combustion-only.

The distinction bites whenever something OTHER than c* is being corrected.
Chamber temperature is the live example: cooling already reaches temperature
through chamber_solver's effective_Tc, so a temperature correction must use
eta_combustion alone. See calculate_actual_chamber_temp.
"""

import numpy as np
import logging
from typing import Optional, Dict, Any, Tuple, Union
from .config_schemas import CombustionEfficiencyConfig
from .constants import (
    DEFAULT_CHAMBER_PRESS_PA,
    DEFAULT_CHAMBER_TEMP_K,
    DEFAULT_CSTAR_IDEAL_M_S,
    DEFAULT_GAMMA_ND,
    DEFAULT_GAS_CONST_J_KG_K,
    DEFAULT_MIXTURE_RATIO_ND,
    DEFAULT_TURBULENCE_INTENSITY_ND,
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


def eta_cstar(
    Lstar: float,
    config: CombustionEfficiencyConfig,
    cooling_efficiency: float,
    advanced_params: Dict[str, Any],
    debug: bool = False,
    return_components: bool = False,
) -> Union[float, Tuple[float, Dict[str, float]]]:
    """
    Calculate the c* efficiency: combustion efficiency x cooling efficiency.

    Despite living in a module named for combustion, the return value is NOT
    the combustion efficiency -- the cooling efficiency is multiplied in before
    returning. Use return_components to get the two factors separately.

    This corrects CEA's infinite-area equilibrium assumption for finite chambers.

    NOTE: CEA uses EQUILIBRIUM flow (not frozen). The correction accounts for:
    - Finite residence time (L*)
    - Incomplete mixing
    - Finite-rate chemistry effects
    - Heat losses (applied externally via cooling_efficiency)

    Parameters:
    -----------
    Lstar : float
        Characteristic length [m]
    config : CombustionEfficiencyConfig
        Efficiency configuration
    cooling_efficiency : float
        Cooling efficiency factor (from heat transfer), applied externally
    advanced_params : dict
        Required parameters for advanced model:
        - Pc: Chamber pressure [Pa]
        - Tc: Chamber temperature [K]
        - cstar_ideal: Ideal c* [m/s]
        - gamma: Specific heat ratio
        - R: Gas constant [J/(kg·K)]
        - MR: Mixture ratio
        - Ac: Chamber cross-sectional area [m²]
        - At: Throat area [m²]
        - m_dot_total: Total mass flow rate [kg/s]
        - chamber_length: Chamber length [m]
        - Dinj: Injector diameter [m] (optional, estimated from Ac if not provided)
        - u_fuel: Fuel injection velocity [m/s] (optional)
        - u_lox: LOX injection velocity [m/s] (optional)
        - spray_diagnostics: Spray diagnostics dict (optional)
        - turbulence_intensity: Turbulence intensity 0-1 (optional)
        - Tc_kinetics: Temperature for kinetics [K] (optional)
        - fuel_props: Fuel properties dict (optional)
    debug : bool
        Enable debug logging
    return_components : bool
        When True, also return the unblended factors. See Returns.

    Returns:
    --------
    eta : float
        Combustion efficiency x cooling efficiency (0-1), applied to c*_ideal.
    (eta, components) : tuple, when return_components is True
        components holds the factors BEFORE they are multiplied together:
            eta_combustion      -- incomplete burning alone (mixing x kinetics x L*)
            eta_cooling_energy  -- cooling as an ENERGY/temperature fraction
            eta_cooling_cstar   -- the same cooling as a c* factor, sqrt of the above
            eta_total           -- eta_combustion x eta_cooling_cstar, i.e. `eta`

    WHY THE SPLIT MATTERS: the two factors describe different physics and are
    not interchangeable. Incomplete combustion means less chemical energy was
    released, so it lowers BOTH c* and the chamber temperature. Cooling removes
    energy downstream of that, and its effect on temperature is already carried
    separately by chamber_solver's `effective_Tc`.

    So a caller correcting chamber temperature for incomplete combustion (Huzel
    & Huang, Sample Calculation 4-3: design (Tc)ns = theoretical x eta_c*^2)
    must use eta_combustion, NOT the blended `eta`. Using the blended value
    would subtract the cooling loss from temperature a second time.
    scripts/validate_chamber.py works around this by passing
    cooling_efficiency=1.0; with return_components a caller no longer has to.
    """
    from .combustion_physics import calculate_combustion_efficiency_advanced
    
    # Extract parameters
    Pc = advanced_params.get("Pc", DEFAULT_CHAMBER_PRESS_PA)
    Tc = advanced_params.get("Tc", DEFAULT_CHAMBER_TEMP_K)
    Tc_kinetics = advanced_params.get("Tc_kinetics", None)
    
    # DEBUG: advanced_params extraction
    if debug:
        logging.getLogger("evaluate").info(
            f"[EFF_DEBUG] Pc={Pc/1e6:.3f} MPa, Tc={Tc:.0f} K, "
            f"Tc_kinetics={Tc_kinetics if Tc_kinetics else 'None'}"
        )
    
    cstar_ideal = advanced_params.get("cstar_ideal", DEFAULT_CSTAR_IDEAL_M_S)
    gamma = advanced_params.get("gamma", DEFAULT_GAMMA_ND)
    R = advanced_params.get("R", DEFAULT_GAS_CONST_J_KG_K)
    MR = advanced_params.get("MR", DEFAULT_MIXTURE_RATIO_ND)
    Ac = advanced_params.get("Ac", None)
    At = advanced_params.get("At", None)
    chamber_length = advanced_params.get("chamber_length", None)
    m_dot_total = advanced_params.get("m_dot_total", None)
    u_fuel = advanced_params.get("u_fuel", None)
    u_lox = advanced_params.get("u_lox", None)
    Dinj = advanced_params.get("Dinj", None)
    spray_diagnostics = advanced_params.get("spray_diagnostics", None)
    turbulence_intensity = advanced_params.get("turbulence_intensity", DEFAULT_TURBULENCE_INTENSITY_ND)
    fuel_props = advanced_params.get("fuel_props", None)
    momentum_ratio_R = advanced_params.get("momentum_ratio_R", None)
    R_opt = advanced_params.get("R_opt", None)
    
    # Validate required parameters
    if Ac is None or m_dot_total is None:
        raise ValueError("Ac and m_dot_total are required for combustion efficiency calculation")
    if At is None:
        raise ValueError("At is required for combustion efficiency calculation")
    if chamber_length is None:
        raise ValueError("chamber_length is required for combustion efficiency calculation")
    
    # Estimate Dinj from chamber area if not provided
    if Dinj is None:
        Dinj = float(np.sqrt(4.0 * Ac / np.pi))
    Dinj = float(max(Dinj, 1e-6))
    
    # Calculate advanced efficiency
    results = calculate_combustion_efficiency_advanced(
        Lstar, Pc, Tc, cstar_ideal, gamma, R, MR, config,
        Ac, At, Dinj, m_dot_total,
        u_fuel=u_fuel, u_lox=u_lox,
        spray_diagnostics=spray_diagnostics,
        turbulence_intensity=turbulence_intensity,
        chamber_length=chamber_length,
        Tc_kinetics=Tc_kinetics,
        fuel_props=fuel_props,
        momentum_ratio_R=momentum_ratio_R,
        R_opt=R_opt,
        debug=debug
    )
    
    # Combustion-only efficiency, before cooling is blended in below. Kept in
    # its own name so the two factors stay separable -- see Returns.
    eta_combustion = float(results["eta_total"])
    eta = eta_combustion

    if debug:
        logging.getLogger("evaluate").info(
            f"[ADV_EFF_DEBUG] eta_total: {eta:.4f} "
            f"(Lstar: {results['eta_Lstar']:.4f}, Kinetics: {results['eta_kinetics']:.4f}, "
            f"Mixing: {results['eta_mixing']:.4f})"
        )
    
    # Apply cooling efficiency (external factor)
    # NOTE: The advanced model does NOT include cooling losses internally.
    # We apply cooling_efficiency here as an external multiplicative factor.
    # This is by design to avoid double-counting and maintain clear separation.
    
    # Validate cooling efficiency - no clipping, raise error if invalid
    if not np.isfinite(cooling_efficiency):
        raise ValueError(f"Invalid cooling_efficiency: {cooling_efficiency}. Must be finite.")
    if cooling_efficiency < 0.0 or cooling_efficiency > 1.0:
        raise ValueError(
            f"Invalid cooling_efficiency: {cooling_efficiency:.4f}. Must be in [0, 1]. "
            f"Check heat transfer calculations and cooling model configuration."
        )
    
    # cooling_efficiency arrives as an ENERGY fraction: 1 - Q_removed/(mdot*cp*Tc),
    # i.e. the fraction of gas enthalpy surviving cooling, which is also the
    # factor on chamber TEMPERATURE. c* is not linear in temperature --
    # c* = sqrt(gamma*R*Tc)/Gamma, so c* goes as sqrt(Tc). Converting currencies
    # here is therefore a square root, not a pass-through.
    #
    # Verified against the CEA cache: reconstructing cstar_ideal from CEA's own
    # Tc/gamma/R reproduces it to 0.07% mean (0.17% worst) over MR 2.4-4.0, and
    # scaling Tc by f scales c* by sqrt(f) to five decimals.
    #
    # This previously multiplied c* by the energy fraction directly, which
    # roughly doubled cooling's penalty on c*: at cooling_eff = 0.9607 it
    # applied 0.9607 where 0.9801 is correct, understating c* by 2.0%.
    cooling_eff = float(cooling_efficiency)
    eta_cooling_on_cstar = float(np.sqrt(cooling_eff))
    eta *= eta_cooling_on_cstar
    
    # Validate final efficiency - no clipping, raise error if invalid
    if not np.isfinite(eta):
        raise ValueError(f"Invalid combustion efficiency: {eta}. Must be finite.")
    if eta < 0.0 or eta > 1.0:
        raise ValueError(
            f"Invalid combustion efficiency: {eta:.4f}. Must be in [0, 1]. "
            f"Check L*={Lstar:.4f} m, mixing quality (eta_mixing={results['eta_mixing']:.4f}), "
            f"kinetics (eta_kinetics={results['eta_kinetics']:.4f}), "
            f"residence time effects (eta_Lstar={results['eta_Lstar']:.4f}), "
            f"and cooling efficiency ({cooling_eff:.4f})."
        )
    
    if return_components:
        return float(eta), {
            "eta_combustion": eta_combustion,
            # Both currencies, because callers need different ones: anything
            # correcting a TEMPERATURE wants eta_cooling_energy, anything
            # correcting c* wants eta_cooling_cstar (its square root).
            "eta_cooling_energy": cooling_eff,
            "eta_cooling_cstar": eta_cooling_on_cstar,
            "eta_total": float(eta),
        }
    return float(eta)


def calculate_actual_chamber_temp(
    Tc_ideal: float,
    eta_combustion: float,
    gamma: Optional[float] = None,
) -> float:
    """
    Chamber temperature corrected for incomplete combustion.

        (Tc)ns,design = (Tc)ns,theoretical x eta_c*^2

    Huzel & Huang, "Design of Liquid Propellant Rocket Engines" (NASA SP-125),
    Sample Calculation 4-3, which carries 6460 degR x 0.975^2 = 6140 degR.

    The exponent is not a fitted constant. c* = sqrt(gamma*R*Tc)/Gamma, so at
    fixed gamma and R, c* is proportional to sqrt(Tc); an efficiency measured
    on c* therefore lands on temperature squared.

    THE ETA MUST BE COMBUSTION-ONLY. Pass eta_cstar(...)'s `eta_combustion`
    component, not its blended return value. The blended value carries the
    cooling efficiency, and chamber_solver already applies cooling to
    temperature separately via `effective_Tc` -- squaring the blend in here
    would deduct the cooling loss from temperature twice.

    Parameters:
    -----------
    Tc_ideal : float
        Theoretical (CEA) chamber temperature [K]
    eta_combustion : float
        Combustion efficiency alone, in (0, 1]
    gamma : float, optional
        Unused. Retained so existing callers keep working; the previous
        implementation here took a gamma because it used an unsourced
        formula, eta / (1 - (1-eta)(gamma-1)/gamma), which disagreed with
        Huzel by ~9% on the multiplier (0.934 vs 0.858 at eta = 0.926) and
        could not be traced to any reference.

    Returns:
    --------
    Tc_actual : float [K]
    """
    del gamma  # deliberately unused; see docstring

    if not np.isfinite(eta_combustion) or eta_combustion <= 0:
        return float(Tc_ideal)

    return float(Tc_ideal * eta_combustion ** 2)


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
