"""Advanced combustion physics models for realistic performance prediction.

This module provides physics-based corrections to CEA equilibrium results
to account for:
1. Finite residence time effects (L*)
2. Mixing quality (spray, turbulence)
3. Reaction kinetics (pressure, temperature dependent)
4. Finite-rate chemistry
5. Heat loss effects
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple
import numpy as np
import warnings
import logging
from engine.pipeline.config_schemas import CombustionEfficiencyConfig


def compute_combustion_state(
    Pc: float,
    Tc: float,
    R: float,
    Ac: float,
    At: float,
    Lstar: float,
    m_dot_total: float,
    Dinj: float,
    u_fuel: Optional[float] = None,
    u_lox: Optional[float] = None,
    C_L: float = 0.1,
    C_u: float = 0.5,
    U_rms_cap: float = 200.0,
) -> Dict[str, float]:
    """
    Compute consistent combustion state for all sub-models.
    
    This helper ensures τ_res remains purely geometric and provides
    consistent velocity scales for mixing and evaporation models.
    
    Parameters
    ----------
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    R : float
        Gas constant [J/(kg·K)]
    Ac : float
        Chamber cross-sectional area [m²]
    At : float
        Throat area [m²]
    Lstar : float
        Characteristic length [m]
    m_dot_total : float
        Total mass flow rate [kg/s]
    Dinj : float
        Characteristic injector diameter [m]
    u_fuel : float, optional
        Fuel injection velocity [m/s]
    u_lox : float, optional
        LOX injection velocity [m/s]
    C_L : float
        Near-field length scale coefficient (default 0.1)
    C_u : float
        RMS velocity contribution coefficient (default 0.5)
    U_rms_cap : float
        Cap on RMS velocity to prevent artificial η→1 [m/s] (default 200)
    
    Returns
    -------
    dict
        Combustion state with keys:
        - rho_ch: Gas density [kg/m³]
        - U_bulk: Bulk chamber velocity [m/s]
        - G_throat: Throat mass flux [kg/(m²·s)]
        - tau_res: Geometric residence time [s] (NEVER scale by efficiency)
        - L_mix: Near-field mixing length scale [m]
        - U_rms: RMS injection velocity [m/s]
        - U_rms_eff: Capped RMS velocity [m/s]
        - dU: Velocity difference |u_F - u_O| [m/s]
        - U_mix: Mixing velocity scale [m/s]
    """
    # Validate required parameters - no fallback defaults
    if R <= 0:
        raise ValueError(f"Invalid gas constant R={R}. Must be positive.")
    if Tc <= 0:
        raise ValueError(f"Invalid chamber temperature Tc={Tc}. Must be positive.")
    if Ac <= 0:
        raise ValueError(f"Invalid chamber area Ac={Ac}. Must be positive.")
    if At <= 0:
        raise ValueError(f"Invalid throat area At={At}. Must be positive.")
    if Dinj <= 0:
        raise ValueError(f"Invalid injector diameter Dinj={Dinj}. Must be positive.")
    if Lstar <= 0:
        raise ValueError(f"Invalid characteristic length Lstar={Lstar}. Must be positive.")
    if m_dot_total <= 0:
        raise ValueError(f"Invalid mass flow rate m_dot_total={m_dot_total}. Must be positive.")
    
    # Injection velocities are REQUIRED - no fallback
    if u_fuel is None:
        raise ValueError("Fuel injection velocity (u_fuel) is required. Cannot fall back to default.")
    if u_lox is None:
        raise ValueError("LOX injection velocity (u_lox) is required. Cannot fall back to default.")
    
    # Gas density
    rho_ch = Pc / (R * Tc)
    
    # Bulk velocity
    U_bulk = m_dot_total / (rho_ch * Ac)
    
    # Throat mass flux
    G_throat = m_dot_total / At
    
    # Residence time - PURELY GEOMETRIC, never scale by efficiency
    tau_res = (Lstar * rho_ch) / G_throat
    
    # Near-field mixing length scale (~1mm for typical 10mm injector)
    L_mix = C_L * Dinj
    
    # Injection velocity scales (already validated above)
    u_f = float(u_fuel)
    u_o = float(u_lox)
    
    # RMS injection velocity
    U_rms = np.sqrt(0.5 * (u_f**2 + u_o**2))
    
    # Validate U_rms
    if not np.isfinite(U_rms):
        raise ValueError(f"Non-finite U_rms. u_fuel={u_f} m/s, u_lox={u_o} m/s")
    
    if U_rms < 0:
        raise ValueError(f"Negative U_rms={U_rms} m/s. This is physically impossible.")
    
    # Check if U_rms_cap parameter is being used to hide unrealistic velocities
    if U_rms > U_rms_cap:
        raise ValueError(
            f"RMS injection velocity U_rms={U_rms:.1f} m/s exceeds cap={U_rms_cap:.1f} m/s. "
            f"This indicates unrealistic injection velocities: u_fuel={u_f:.1f} m/s, u_lox={u_o:.1f} m/s. "
            f"Check injector model and pressure drops. Do NOT artificially cap velocities."
        )
    
    U_rms_eff = U_rms  # No capping - use actual value
    
    # Velocity difference (shear)
    dU = abs(u_f - u_o)
    
    # Mixing velocity scale: combines shear and turbulent contributions
    U_mix = np.sqrt(dU**2 + C_u * U_rms_eff**2)
    
    # Validate U_mix
    if not np.isfinite(U_mix):
        raise ValueError(
            f"Non-finite U_mix. dU={dU} m/s, U_rms_eff={U_rms_eff} m/s, C_u={C_u}"
        )
    
    if U_mix <= 0:
        raise ValueError(
            f"U_mix={U_mix:.4f} m/s is too low. This indicates stagnant flow or zero injection velocities. "
            f"u_fuel={u_f:.1f} m/s, u_lox={u_o:.1f} m/s, dU={dU:.1f} m/s. "
            f"Check injector configuration and pressure drops."
        )
    
    return {
        "rho_ch": float(rho_ch),
        "U_bulk": float(U_bulk),
        "G_throat": float(G_throat),
        "tau_res": float(tau_res),
        "L_mix": float(L_mix),
        "U_rms": float(U_rms),
        "U_rms_eff": float(U_rms_eff),
        "dU": float(dU),
        "U_mix": float(U_mix),
    }


def calculate_eta_Lstar(
    Tc: float,
    Pc: float,
    R: float,
    m_dot_total: float,
    Ac: float,
    At: float,
    SMD: float,
    L_star: float,
    Dinj: float = 0.01,
    mu: float = 7e-5,
    Bm: float = None,
    phi: float = 3.0,
    D0: float = 2e-5,
    rho_l: float = 800.0,
    gamma: float = None,
    fuel_props: dict = None,
    u_fuel: Optional[float] = None,
    u_lox: Optional[float] = None,
    debug: bool = False,
) -> Tuple[float, float]:
    """
    Compute evaporation-based efficiency using FINITE-RATE GASIFICATION model.
    
    This function replaces the Spalding d²-law evaporation model for transcritical/
    supercritical rocket combustor conditions where vapor-pressure equilibrium fails.
    
    NOTE: Spalding code is retained below for diagnostics but does NOT contribute
    to the efficiency calculation. This is a regime correction, not a tuning change.

    Parameters
    ----------
    Tc : float
        Chamber temperature [K]
    Pc : float
        Chamber pressure [Pa]
    R : float
        Gas constant of mixture [J/(kg·K)]
    m_dot_total : float
        Total mass flow rate [kg/s]
    Ac : float
        Chamber cross-sectional area [m^2]
    At : float
        Geometric throat area [m^2]
    SMD : float
        Sauter mean diameter d32 [m]
    L_star : float
        Characteristic length (L*) [m]
    Dinj : float, optional
        Characteristic injector diameter [m]
    mu : float, optional
        Dynamic viscosity [Pa·s]
    Bm : float, optional
        Spalding mass number [-] (DIAGNOSTIC ONLY - not used for efficiency)
    phi : float, optional
        LOX penalty constant [-] (DIAGNOSTIC ONLY)
    D0 : float, optional
        Reference diffusivity at 300 K, 1 atm [m^2/s]
    rho_l : float, optional
        Liquid fuel density [kg/m^3]
    gamma : float, optional
        Specific heat ratio for calculating cp_gas
    fuel_props : dict, optional
        Fuel properties from config. Required keys:
        - "latent_heat" or "L_vap": Latent heat [J/kg]
        - "specific_heat": Liquid specific heat [J/(kg·K)]
        - "temperature": Fuel injection temperature [K]
    u_fuel : float, optional
        Fuel injection velocity [m/s]
    u_lox : float, optional
        LOX injection velocity [m/s]

    Returns
    -------
    eta_Lstar : float
        Evaporation efficiency associated with length L* [-]
    Da_L : float
        Damköhler number for evaporation [-]
    """
    from engine.pipeline.physics_constants import PRANDTL_DEFAULT
    
    # Use shared helper for consistent state
    state = compute_combustion_state(
        Pc=Pc, Tc=Tc, R=R, Ac=Ac, At=At, Lstar=L_star,
        m_dot_total=m_dot_total, Dinj=Dinj,
        u_fuel=u_fuel, u_lox=u_lox
    )
    
    rho_g = state["rho_ch"]
    U_bulk = state["U_bulk"]
    tau_res = state["tau_res"]  # Pure geometric, from helper
    U_mix = state["U_mix"]
    
    # Droplet slip velocity: use max of bulk and mixing scales
    U_slip = max(U_bulk, U_mix)
    
    # =========================================================================
    # FINITE-RATE GASIFICATION MODEL (ACTIVE)
    # Replaces Spalding d²-law for transcritical/supercritical regime
    # =========================================================================
    
    # Validate fuel_props
    if fuel_props is None:
        raise ValueError(
            "fuel_props is required for gasification efficiency. "
            "Expected dict with keys 'latent_heat', 'specific_heat', 'temperature'."
        )
    
    # Extract required fuel properties
    L_eff = fuel_props.get("L_vap") or fuel_props.get("latent_heat")
    if L_eff is None:
        raise ValueError(
            f"fuel_props must contain 'L_vap' or 'latent_heat'. "
            f"Got keys: {list(fuel_props.keys())}"
        )
    
    cp_l = fuel_props.get("specific_heat", 2000.0)  # Default for RP-1
    T_inj = fuel_props.get("temperature", 293.0)    # Default injection temp
    
    # Gas cp from gamma and R: cp = gamma * R / (gamma - 1)
    if gamma is not None and gamma > 1.0:
        cp_g = gamma * R / (gamma - 1.0)
    else:
        cp_g = 2200.0  # Default for hot combustion gas [J/(kg·K)]
    
    # Call gasification efficiency model
    eta_Lstar, gasif_diagnostics = calculate_gasification_efficiency(
        Tc=Tc,
        Pc=Pc,
        tau_res=tau_res,
        SMD=SMD,
        rho_l=rho_l,
        cp_l=cp_l,
        L_eff=L_eff,
        T_inj=T_inj,
        cp_g=cp_g,
        rho_g=rho_g,
        mu_g=mu,
        U_slip=U_slip,
        D_m=None,  # Auto-compute from T, P scaling
        Pr=PRANDTL_DEFAULT,
        fuel_props=fuel_props,  # Pass fuel props for T_star_fuel_cap_K
        debug=debug,
    )
    
    # Compute Da_L for diagnostics (tau_res / tau_vap)
    tau_vap = gasif_diagnostics["tau_vap"]
    Da_L = tau_res / tau_vap if tau_vap > 0 else np.inf
    
    # =========================================================================
    # SPALDING MODEL (DISABLED - RETAINED FOR DIAGNOSTICS ONLY)
    # This code does NOT contribute to eta_Lstar.
    # Kept for future subcritical mode support and validation.
    # =========================================================================
    SPALDING_DIAGNOSTIC_ENABLED = False  # Set to True to run Spalding for comparison
    
    if SPALDING_DIAGNOSTIC_ENABLED:
        if debug:
            logging.getLogger("evaluate").info("[SPALDING_DIAGNOSTIC] Running Spalding model for comparison (does NOT affect efficiency)...")
        
        # Effective diffusivity at Tc, Pc (molecular)
        D_eff = D0 * (Tc / 300.0)**1.75 * (101325.0 / Pc)
        
        # Dimensionless groups
        Sc = mu / max(rho_g * D_eff, 1e-10)
        Re = rho_g * U_slip * float(SMD) / mu
        Sh = 2.0 + 0.6 * Re**0.5 * Sc**(1.0/3.0)
        
        # Calculate Spalding number if not provided
        if Bm is None:
            from engine.pipeline.spalding import solve_spalding_coupled
            
            W_F = fuel_props.get("W") or fuel_props.get("molecular_weight", 170.0)
            L_vap = fuel_props.get("L_vap") or fuel_props.get("latent_heat", 300e3)
            
            try:
                result = solve_spalding_coupled(
                    T_inf=Tc,
                    P=Pc,
                    W_F=W_F,
                    L_vap=L_vap,
                    gamma=gamma,
                    R_gas=R,
                    fuel="RP-1",
                )
                Bm_calc = result["B_M"]
                T_s = result["T_s"]
                if debug:
                    logging.getLogger("evaluate").info(f"[SPALDING_DIAGNOSTIC] Converged: Bm={Bm_calc:.4f}, T_s={T_s:.1f} K")
            except Exception as e:
                if debug:
                    logging.getLogger("evaluate").info(f"[SPALDING_DIAGNOSTIC] Solver failed: {e}")
                Bm_calc = 0.5  # Fallback
        else:
            Bm_calc = Bm
        
        # Evaporation constant K [m^2/s]
        K = ((8.0 * D_eff * rho_g) / rho_l) * Sh * np.log1p(Bm_calc)
        K_eff = K / (1.0 + phi)
        tau_evap_spalding = SMD**2 / K_eff if K_eff > 0 else np.inf
        Da_L_spalding = tau_res / tau_evap_spalding if tau_evap_spalding > 0 else 0.0
        eta_Lstar_spalding = 1.0 - np.exp(-Da_L_spalding)
        
        if debug:
            logging.getLogger("evaluate").info(f"[SPALDING_DIAGNOSTIC] tau_evap={tau_evap_spalding*1e3:.4f} ms, "
                  f"Da_L={Da_L_spalding:.4f}, eta_Spalding={eta_Lstar_spalding:.4f}")
            logging.getLogger("evaluate").info(f"[SPALDING_DIAGNOSTIC] vs Gasification: tau_vap={tau_vap*1e3:.4f} ms, "
                  f"Da_L={Da_L:.4f}, eta_Gasif={eta_Lstar:.4f}")
    
    return eta_Lstar, Da_L




def calculate_gasification_efficiency(
    Tc: float,
    Pc: float,
    tau_res: float,
    SMD: float,
    rho_l: float,
    cp_l: float,
    L_eff: float,
    T_inj: float,
    cp_g: float,
    rho_g: float,
    mu_g: float,
    U_slip: float,
    D_m: Optional[float] = None,
    Pr: float = 0.8,
    fuel_props: Optional[dict] = None,
    debug: bool = False,
) -> Tuple[float, Dict[str, float]]:
    """
    Calculate evaporation efficiency using finite-rate gasification model.
    
    This model treats liquid-to-gas conversion as a TIME-LIMITED process,
    not a surface-equilibrium constraint. Appropriate for transcritical/
    supercritical injection where Spalding formulation fails.
    
    η_vap = 1 - exp(-τ_res / τ_vap)
    
    where τ_vap = τ_heat + τ_gasify
    
    Parameters
    ----------
    Tc : float
        Chamber/gas temperature [K]
    Pc : float
        Chamber pressure [Pa]
    tau_res : float
        Residence time [s]
    SMD : float
        Sauter mean diameter [m]
    rho_l : float
        Liquid fuel density [kg/m³]
    cp_l : float
        Liquid fuel specific heat [J/(kg·K)]
    L_eff : float
        Effective gasification energy [J/kg] (includes sensible + latent)
    T_inj : float
        Fuel injection temperature [K]
    cp_g : float
        Gas specific heat [J/(kg·K)]
    rho_g : float
        Gas density [kg/m³]
    mu_g : float
        Gas dynamic viscosity [Pa·s]
    U_slip : float
        Droplet slip velocity [m/s] (capped internally to prevent mixing smuggling)
    D_m : float, optional
        Molecular diffusivity [m²/s]. If None, computed from T^1.75/P scaling.
    Pr : float, optional
        Prandtl number for gas thermal conductivity calculation. Default 0.8.
    
    Returns
    -------
    eta_vap : float
        Gasification efficiency (0-1)
    diagnostics : dict
        Intermediate values for debugging:
        - tau_heat: Heating timescale [s]
        - tau_gasify: Gasification timescale [s]
        - tau_vap: Total gasification timescale [s]
        - T_star: Transition temperature [K]
        - Nu: Nusselt number [-]
        - Sh: Sherwood number [-]
        - Phi: Energy-driven gasification factor [-]
        - k_g: Gas thermal conductivity [W/(m·K)]
        - D_m: Molecular diffusivity [m²/s]
        - U_slip_capped: Capped slip velocity [m/s]
        - Re: Reynolds number [-]
        - Sc: Schmidt number [-]
    
    Notes
    -----
    This replaces the Spalding d²-law evaporation model for high-pressure
    rocket combustor applications where vapor-pressure equilibrium assumptions
    do not hold.
    """
    from engine.pipeline.physics_constants import (
        D_M_REF, D_M_T_REF, D_M_P_REF, U_SLIP_CAP, D_MIN_GASIFICATION
    )
    
    # Input validation
    if Tc <= 0 or Pc <= 0 or tau_res <= 0:
        raise ValueError(f"Invalid inputs: Tc={Tc}, Pc={Pc}, tau_res={tau_res}")
    if SMD <= 0:
        raise ValueError(f"Invalid SMD: {SMD}")
    
    # =========================================================================
    # STEP 1: Compute D (droplet diameter) with minimum clamp
    # =========================================================================
    D = max(SMD, D_MIN_GASIFICATION)  # [m]
    D_sq = D ** 2  # [m²]
    
    # =========================================================================
    # STEP 2: Compute T_* (transition temperature)
    # T_star is an effective INTERFACE temperature cap (wet-bulb/pyrolysis onset),
    # NOT gas temperature tracking. This represents the scale at which
    # evaporation/gasification enters its high-rate regime.
    # For RP-1, this is typically 800-1200 K (NOT ~3000 K like Tc).
    # =========================================================================
    # Get fuel interface cap from config (default 1000 K for RP-1)
    T_star_fuel_cap_K = fuel_props.get("T_star_fuel_cap_K", 1000.0) if fuel_props else 1000.0
    
    # Numerical safety margins
    dT_min = 200.0  # Minimum safety margin [K]
    dT_frac = 0.10 * Tc  # Fractional safety margin (10% of Tc)
    dT_safe = max(dT_min, dT_frac)  # Use whichever is larger
    
    # Compute upper bound: min of fuel cap and (Tc - safety margin)
    T_star_upper = min(T_star_fuel_cap_K, Tc - dT_safe)
    
    # Compute lower bound: ensure log term is well-defined
    T_star_lower = T_inj + 50.0
    
    # Clamp T_star between bounds
    T_star = np.clip(T_star_upper, T_star_lower, Tc - dT_safe)
    
    # Warnings for pathological cases
    if T_star_upper <= T_star_lower:
        warnings.warn(
            f"[GASIFICATION] T_star bounds invalid: T_star_upper={T_star_upper:.1f} K <= "
            f"T_star_lower={T_star_lower:.1f} K. Fuel cap ({T_star_fuel_cap_K:.1f} K) may be "
            f"too low or Tc ({Tc:.1f} K) too low. Using T_star={T_star:.1f} K.",
            RuntimeWarning, stacklevel=2
        )
    
    if Tc - T_star < dT_safe:
        warnings.warn(
            f"[GASIFICATION] T_star={T_star:.1f} K too close to Tc={Tc:.1f} K "
            f"(margin {Tc-T_star:.1f} K < {dT_safe:.1f} K). This may cause numerical issues.",
            RuntimeWarning, stacklevel=2
        )
    
    # =========================================================================
    # STEP 3: Gas thermal conductivity from k_g = μ·cp/Pr
    # =========================================================================
    k_g = mu_g * cp_g / Pr  # [W/(m·K)]
    
    # =========================================================================
    # STEP 4: Molecular diffusivity (if not provided)
    # D_m ∝ T^1.75 / P scaling
    # =========================================================================
    if D_m is None:
        D_m = D_M_REF * (Tc / D_M_T_REF) ** 1.75 * (D_M_P_REF / max(Pc, 1e3))
    
    # =========================================================================
    # STEP 5: Cap U_slip to prevent mixing smuggling
    # =========================================================================
    U_slip_capped = min(abs(U_slip), U_SLIP_CAP)
    U_slip_capped = max(U_slip_capped, 0.1)  # Minimum for Re calculation
    
    # =========================================================================
    # STEP 6: Dimensionless numbers (Re, Pr, Sc, Nu, Sh)
    # =========================================================================
    # Reynolds number based on capped slip velocity
    Re = rho_g * U_slip_capped * D / max(mu_g, 1e-10)
    
    # Schmidt number: Sc = ν/D_m = μ/(ρ·D_m)
    Sc = mu_g / (rho_g * max(D_m, 1e-12))
    
    # Nusselt number: Nu = 2 + 0.6·Re^0.5·Pr^(1/3) (Ranz-Marshall)
    Nu = 2.0 + 0.6 * np.sqrt(max(Re, 0.0)) * (Pr ** (1.0 / 3.0))
    
    # Sherwood number: Sh = 2 + 0.6·Re^0.5·Sc^(1/3)
    Sh = 2.0 + 0.6 * np.sqrt(max(Re, 0.0)) * (Sc ** (1.0 / 3.0))
    
    # =========================================================================
    # STEP 7: Heating timescale τ_heat (lumped capacitance)
    # τ_heat = (ρ_l·cp_l·D²) / (6·Nu·k_g) · ln((Tc - T_inj) / (Tc - T_*))
    # =========================================================================
    dT_initial = Tc - T_inj  # Temperature difference at start
    dT_final = Tc - T_star   # Temperature difference at transition
    
    # Safety: ensure log argument is positive and > 1
    if dT_final <= 0 or dT_initial <= dT_final:
        warnings.warn(
            f"[GASIFICATION] Invalid temperature profile: dT_initial={dT_initial:.1f}, "
            f"dT_final={dT_final:.1f}. Using tau_heat = 0.",
            RuntimeWarning, stacklevel=2
        )
        tau_heat = 1e-9  # Near-zero
    else:
        log_arg = dT_initial / dT_final
        log_term = np.log(log_arg)
        tau_heat = (rho_l * cp_l * D_sq) / (6.0 * Nu * k_g) * log_term
    
    # =========================================================================
    # STEP 8: Energy-driven gasification factor Φ
    # Φ = cp_g·(Tc - T_*) / [cp_g·(Tc - T_*) + L_eff]
    # =========================================================================
    energy_available = cp_g * (Tc - T_star)  # Energy from hot gas cooling
    energy_required = energy_available + L_eff  # Total energy needed
    
    # Phi is bounded [0, 1] by construction
    Phi = energy_available / max(energy_required, 1e-6)
    Phi = np.clip(Phi, 1e-6, 1.0)  # Safety clamp
    
    # =========================================================================
    # STEP 9: Gasification timescale τ_gasify
    # τ_gasify = (ρ_l·D²) / (6·ρ_g·D_m·Sh·Φ)
    # =========================================================================
    denominator = 6.0 * rho_g * D_m * Sh * Phi
    if denominator <= 0:
        tau_gasify = np.inf
    else:
        tau_gasify = (rho_l * D_sq) / denominator
    
    # =========================================================================
    # STEP 10: Combined timescale and efficiency
    # Use effective rate combination (concurrent processes, not sequential):
    # 1/tau_eff = 1/tau_heat + 1/tau_gasify
    # This reflects that heating and gasification happen simultaneously,
    # not as a strict "heat fully then gasify" sequence.
    # η_vap = 1 - exp(-τ_res / τ_vap)
    # =========================================================================
    # Guard against zero/negative timescales
    tau_heat_safe = max(tau_heat, 1e-12)
    tau_gasify_safe = max(tau_gasify, 1e-12)
    
    # Effective rate combination
    tau_vap = 1.0 / (1.0/tau_heat_safe + 1.0/tau_gasify_safe)
    
    # Compute efficiency (bounded [0, 1] by exp mapping)
    if tau_vap <= 0 or not np.isfinite(tau_vap):
        eta_vap = 1.0  # Instantaneous gasification if tau_vap is invalid
    else:
        eta_vap = 1.0 - np.exp(-tau_res / tau_vap)
    
    # =========================================================================
    # DEBUG OUTPUT AND PATHOLOGICAL CASE WARNINGS
    # =========================================================================
    # Calculate log term for diagnostics
    dT_initial = Tc - T_inj
    dT_final = Tc - T_star
    log_term = np.log(dT_initial / dT_final) if dT_final > 0 and dT_initial > dT_final else 0.0
    
    # Warnings for numerical issues (once per call)
    if log_term > 3.0 and not debug:
        warnings.warn(
            f"[GASIFICATION] Large log_term={log_term:.2f} detected. T_star={T_star:.0f} K may be "
            f"too close to Tc={Tc:.0f} K. This indicates potential numerical issues.",
            RuntimeWarning, stacklevel=2
        )
    
    if tau_vap > 10.0 * tau_res and not debug:
        warnings.warn(
            f"[GASIFICATION] tau_vap={tau_vap*1e3:.2f} ms >> tau_res={tau_res*1e3:.2f} ms. "
            f"Very low vaporization efficiency expected. Consider increasing L* or reducing SMD.",
            RuntimeWarning, stacklevel=2
        )
    
    if debug:
        logger = logging.getLogger("evaluate")
        logger.info(f"[GASIFICATION_DEBUG] === Finite-Rate Gasification Model ===")
        logger.info(f"[GASIFICATION_DEBUG] Inputs: Tc={Tc:.0f} K, Pc={Pc/1e6:.2f} MPa, tau_res={tau_res*1e3:.3f} ms")
        logger.info(f"[GASIFICATION_DEBUG] Inputs: D={D*1e6:.1f} μm, T_inj={T_inj:.0f} K, L_eff={L_eff/1e3:.1f} kJ/kg")
        logger.info(f"[GASIFICATION_DEBUG] T_star={T_star:.0f} K (fuel interface cap, NOT Tc tracking)")
        logger.info(f"[GASIFICATION_DEBUG] T_margins: (Tc - T_star)={Tc-T_star:.0f} K, log_term={log_term:.3f}")
        logger.info(f"[GASIFICATION_DEBUG] Gas props: k_g={k_g:.4f} W/(m·K), D_m={D_m:.2e} m²/s, Pr={Pr:.2f}")
        logger.info(f"[GASIFICATION_DEBUG] U_slip_capped={U_slip_capped:.1f} m/s (input was {U_slip:.1f} m/s)")
        logger.info(f"[GASIFICATION_DEBUG] Dimensionless: Re={Re:.1f}, Sc={Sc:.1f}, Nu={Nu:.2f}, Sh={Sh:.2f}")
        logger.info(f"[GASIFICATION_DEBUG] Phi={Phi:.4f} (energy ratio)")
        logger.info(f"[GASIFICATION_DEBUG] Timescales: tau_heat={tau_heat*1e3:.4f} ms, tau_gasify={tau_gasify*1e3:.4f} ms")
        logger.info(f"[GASIFICATION_DEBUG] tau_vap={tau_vap*1e3:.4f} ms (CONCURRENT, not sum) -> eta_vap={eta_vap:.4f}")
        logger.info(f"[GASIFICATION_DEBUG] Efficiency ratio: tau_res/tau_vap={tau_res/tau_vap if tau_vap > 0 else np.inf:.3f}")
    
    diagnostics = {
        "tau_heat": float(tau_heat),
        "tau_gasify": float(tau_gasify),
        "tau_vap": float(tau_vap),
        "T_star": float(T_star),
        "Nu": float(Nu),
        "Sh": float(Sh),
        "Phi": float(Phi),
        "k_g": float(k_g),
        "D_m": float(D_m),
        "U_slip_capped": float(U_slip_capped),
        "Re": float(Re),
        "Sc": float(Sc),
        "D": float(D),
    }
    
    return float(eta_vap), diagnostics


def calculate_residence_time(
    Lstar: float,
    Pc: float,
    cstar: float,
    gamma: float,
    R: float,
    Tc: float,
    Ac: float,
    At: float,
    m_dot_total: float,
) -> float:
    """
    Calculate characteristic residence time in chamber.
    
    τ_res = V_chamber * rho / mdot = (L* * At) * rho / mdot
    
    Parameters:
    -----------
    Lstar : float
        Characteristic length [m]
    Pc : float
        Chamber pressure [Pa]
    cstar : float
        Characteristic velocity [m/s]
    gamma : float
        Specific heat ratio
    R : float
        Gas constant [J/(kg·K)]
    Tc : float
        Chamber temperature [K]
    Ac : float
        Chamber area (m^2)
    At : float
        Throat area (m^2)
    m_dot_total : float
        Total mass flow rate (kg/s)
    
    Returns:
    --------
    tau_res : float
        Residence time [s]
    """
    # Gas density at chamber conditions (Chamber approximation)
    rho_ch = Pc / (R * Tc) if R > 0 and Tc > 0 else 1.0
    
    # Residence time = Volume * rho / mdot
    # Since L* = Volume / At, then Volume = L* * At
    # tau_res = (L* * At * rho_ch) / mdot = L* * rho_ch / (mdot/At) = L* * rho_ch / G_throat
    G_throat = m_dot_total / At if At > 0 else 1.0
    tau_res = (Lstar * rho_ch) / G_throat if G_throat > 0 else 0.001
    
    return float(tau_res)


def calculate_reaction_time_scale(
    Pc: float,
    Tc: float,
    MR: float,
    gamma: float,
    tau_ref: float = 1e-5,  # Reference time [s], default 10 μs for LOX/RP-1
    P_ref: float = 4.0e6,   # Reference pressure [Pa]
    T_ref: float = 3500.0,  # Reference temperature [K]
    n_pressure: float = 0.8,  # Pressure exponent
) -> float:
    """
    Estimate chemical reaction time scale for rocket combustion.
    
    Uses Arrhenius-like scaling with pressure and temperature.
    Higher pressure → faster reactions (collision frequency)
    Higher temperature → faster reactions (activation energy)
    
    τ_chem ≈ τ_ref × (P_ref / P)^n × exp(Ea_norm × (T_ref / T - 1))
    
    NOTE: tau_ref is a calibrated surrogate parameter for rocket combustion,
    not a measured universal constant. For LOX/RP-1 at ~3300K, typical
    chemical timescales are O(10-100 μs), so tau_ref defaults to 10 μs.
    
    Parameters
    ----------
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K] - should be ideal/CEA Tc, not degraded
    MR : float
        Mixture ratio
    gamma : float
        Specific heat ratio (unused, kept for signature compatibility)
    tau_ref : float
        Reference reaction time [s] at P_ref, T_ref (default 10 μs = 1e-5)
    P_ref : float
        Reference pressure [Pa] (default 4 MPa)
    T_ref : float
        Reference temperature [K] (default 3500 K)
    n_pressure : float
        Pressure exponent (default 0.8)
    
    Returns
    -------
    tau_chem : float
        Chemical reaction time scale [s]
    """
    # Normalized activation energy (dimensionless)
    # Higher for more complex reactions (e.g., hydrocarbon combustion)
    # Lower for simpler reactions (e.g., H2/O2)
    if MR < 1.5:  # Fuel-rich (more complex chemistry)
        Ea_norm = 12.0
    elif MR > 3.0:  # Oxidizer-rich (simpler chemistry)
        Ea_norm = 8.0
    else:  # Near-stoichiometric
        Ea_norm = 10.0
    
    # Pressure effect (higher pressure → faster reactions)
    pressure_factor = (P_ref / max(Pc, 1e5)) ** n_pressure
    
    # Temperature effect with clamped exponent to prevent numerical overflow
    exp_arg = Ea_norm * (T_ref / max(Tc, 1000.0) - 1.0)
    exp_arg_clamped = np.clip(exp_arg, -20.0, 20.0)  # Prevent exp overflow
    temp_factor = np.exp(exp_arg_clamped)
    
    tau_chem = tau_ref * pressure_factor * temp_factor
    
    # Warning if tau_chem seems unrealistically high for rocket conditions
    # (indicates miscalibration of tau_ref)
    if tau_chem > 1e-3 and Tc > 2500 and Pc > 0.5e6:
        warnings.warn(
            f"[KINETICS_WARN] tau_chem={tau_chem*1e3:.2f} ms is high for "
            f"Tc={Tc:.0f} K, Pc={Pc/1e6:.2f} MPa. Consider reducing tau_ref "
            f"(current: {tau_ref*1e6:.1f} μs). Typical LOX/RP-1: 10-100 μs."
        )
    
    return float(tau_chem)



def calculate_damkohler_number(
    tau_res: float,
    tau_chem: float,
) -> float:
    """
    Calculate Damköhler number (ratio of residence time to reaction time).
    
    Da = τ_res / τ_chem
    
    Da >> 1: Fast chemistry (equilibrium achieved)
    Da ~ 1: Finite-rate chemistry (partial equilibrium)
    Da << 1: Slow chemistry (far from equilibrium)
    
    Parameters:
    -----------
    tau_res : float
        Residence time [s]
    tau_chem : float
        Chemical reaction time scale [s]
    
    Returns:
    --------
    Da : float
        Damköhler number
    """
    if tau_chem <= 0:
        return np.inf  # Instantaneous reactions
    
    Da = tau_res / tau_chem
    return float(Da)


def calculate_mixing_efficiency(
    Tc: float,
    Pc: float,
    R: float,
    Ac: float,
    At: float,
    Dinj: float,
    m_dot_total: float,
    Lstar: float,
    u_fuel: Optional[float] = None,
    u_lox: Optional[float] = None,
    turbulence_intensity: float = 0.08,
    debug: bool = False,
) -> float:
    """
    Calculate mixing efficiency based on near-field stirring physics.
    
    This function models STIRRING/MIXING ONLY (no evaporation penalties).
    Uses near-field length scale L_mix = C_L × Dinj (~1mm) instead of
    macro chamber recirculation length (~30mm).
    
    Parameters
    ----------
    Tc : float
        Chamber temperature [K]
    Pc : float
        Chamber pressure [Pa]
    R : float
        Gas constant [J/(kg·K)]
    Ac : float
        Chamber area [m²]
    At : float
        Throat area [m²]
    Dinj : float
        Characteristic injector diameter [m]
    m_dot_total : float
        Total mass flow rate [kg/s]
    Lstar : float
        Characteristic length [m]
    u_fuel : float, optional
        Fuel injection velocity [m/s]
    u_lox : float, optional
        LOX injection velocity [m/s]
    turbulence_intensity : float
        User-provided turbulence intensity (0-1)
    
    Returns
    -------
    eta_mix : float
        Mixing efficiency (0-1)
    """
    # Require injection velocities for mixing physics
    if u_fuel is None or u_lox is None:
        raise ValueError(
            f"u_fuel and u_lox are required for mixing efficiency calculation. "
            f"Got u_fuel={u_fuel}, u_lox={u_lox}."
        )
    
    # Use shared helper for consistent state
    state = compute_combustion_state(
        Pc=Pc, Tc=Tc, R=R, Ac=Ac, At=At, Lstar=Lstar,
        m_dot_total=m_dot_total, Dinj=Dinj,
        u_fuel=u_fuel, u_lox=u_lox
    )
    
    rho_ch = state["rho_ch"]
    tau_res = state["tau_res"]  # Pure geometric, from helper
    L_mix = state["L_mix"]  # Near-field shear-layer thickness: C_L × Dinj (~1mm)
    U_mix = state["U_mix"]  # Near-field mixing velocity (capped)
    
    # === NEAR-FIELD SHEAR-LAYER TURBULENCE CLOSURE ===
    # (Replaces pipe-flow correlations which are not appropriate for impingement region)
    
    # A) Turbulence intensity from user input with physical bounds validation
    # In injector near-field, turbulence is dominated by jet/sheet breakup and shear,
    # not internal fully-developed pipe turbulence. Use provided value with bounds check.
    I_min, I_max = 0.01, 0.30
    if turbulence_intensity < I_min or turbulence_intensity > I_max:
        warnings.warn(
            f"[MIXING_WARN] turbulence_intensity={turbulence_intensity:.4f} outside physical range "
            f"[{I_min}, {I_max}]. Clamping for stability."
        )
    I_eff = float(np.clip(turbulence_intensity, I_min, I_max))
    
    # B) Integral length scale = near-field mixing region thickness
    # The eddies driving turbulent diffusion are constrained by the shear-layer/impingement
    # sheet thickness, which is exactly what L_mix represents.
    Lt = max(L_mix, 1e-5)  # [m]
    
    # C) k-ε closure anchored to near-field scales
    C_mu = 0.09
    k = 1.5 * (U_mix * I_eff) ** 2  # Turbulent kinetic energy [m²/s²]
    epsilon = C_mu ** 0.75 * k ** 1.5 / Lt  # Dissipation rate [m²/s³]
    epsilon = max(epsilon, 1e-12)  # Numerical safety only, not physics boost
    
    # Turbulent kinematic viscosity: nu_t = C_mu * k² / ε
    nu_t = C_mu * (k ** 2) / epsilon
    
    # Turbulent diffusivity (Schmidt_t ≈ 1)
    D_t = nu_t  # [m²/s]
    
    # D) Molecular diffusivity (surrogate for gas-phase species diffusion)
    D_m = 2.0e-5 * (Tc / 300.0) ** 1.75 * (101325.0 / max(Pc, 1e3))  # [m²/s]
    
    # Effective diffusivity (no artificial floor that accelerates mixing)
    D_eff = D_m + D_t
    
    # === TIMESCALES WITH SINGULARITY PROTECTION ===
    # Clamp timescales, not diffusivity, to prevent division-by-zero without
    # forcing diffusion to be faster than physics.
    tiny = 1e-12
    tau_conv = max(L_mix / U_mix, 1e-8)  # Convective time [s]
    tau_diff = max(L_mix ** 2 / max(D_eff, tiny), 1e-8)  # Diffusive time [s]
    
    # Harmonic blend (limiting process dominates)
    tau_mix = 1.0 / (1.0 / tau_conv + 1.0 / tau_diff)
    
    # Damköhler number for mixing
    Da_mix = tau_res / tau_mix
    
    # Efficiency (no floor per user requirements)
    eta_mix = 1.0 - np.exp(-Da_mix)
    
    # === DIAGNOSTIC WARNINGS FOR SANITY CHECKS ===
    # Warn if D_t is unrealistically large relative to molecular diffusivity
    D_t_D_m_ratio = D_t / max(D_m, 1e-12)
    if D_t_D_m_ratio > 1e6:
        warnings.warn(
            f"[MIXING_WARN] D_t/D_m = {D_t_D_m_ratio:.2e} is extremely high. "
            f"Check turbulence_intensity={turbulence_intensity:.4f} or U_mix={U_mix:.1f} m/s."
        )
    
    # Warn if tau_diff is suspiciously small for mm-scale L_mix
    if tau_diff < 1e-7 and L_mix > 1e-4:
        warnings.warn(
            f"[MIXING_WARN] tau_diff={tau_diff:.2e} s is very small for L_mix={L_mix*1e3:.2f} mm. "
            f"This may indicate unrealistic turbulence estimate. D_t={D_t:.2e} m²/s."
        )
    
    # Debug output showing near-field turbulence variables explicitly
    if debug:
        logger = logging.getLogger("evaluate")
        logger.info(f"[MIXING_DEBUG] === Near-Field Shear-Layer Mixing Model ===")
        logger.info(f"[MIXING_DEBUG] State: rho_ch={rho_ch:.4f} kg/m³, tau_res={tau_res*1e3:.3f} ms")
        logger.info(f"[MIXING_DEBUG] Velocities: U_mix={U_mix:.2f} m/s, dU={state['dU']:.2f} m/s, U_rms_eff={state['U_rms_eff']:.2f} m/s")
        logger.info(f"[MIXING_DEBUG] Near-field scales: L_mix={L_mix*1e3:.3f} mm, Lt={Lt*1e3:.3f} mm")
        logger.info(f"[MIXING_DEBUG] Turbulence: I_eff={I_eff:.4f}, k={k:.2f} m²/s², ε={epsilon:.2e} m²/s³, ν_t={nu_t:.2e} m²/s")
        logger.info(f"[MIXING_DEBUG] Diffusivity: D_m={D_m:.2e}, D_t={D_t:.2e}, D_eff={D_eff:.2e} m²/s, D_t/D_m={D_t_D_m_ratio:.1f}")
        logger.info(f"[MIXING_DEBUG] Times: tau_conv={tau_conv*1e3:.4f} ms, tau_diff={tau_diff*1e3:.4f} ms, tau_mix={tau_mix*1e3:.4f} ms")
        logger.info(f"[MIXING_DEBUG] Da_mix={Da_mix:.4f} -> eta_mix={eta_mix:.4f}")
    
    return float(eta_mix)




def calculate_combustion_efficiency_advanced(
    Lstar: float,
    Pc: float,
    Tc: float,
    cstar_ideal: float,
    gamma: float,
    R: float,
    MR: float,
    config: CombustionEfficiencyConfig,
    Ac: float,
    At: float,
    Dinj: float,
    m_dot_total: float,
    u_fuel: Optional[float] = None,
    u_lox: Optional[float] = None,
    spray_diagnostics: Optional[Dict] = None,
    turbulence_intensity: float = 0.08,
    chamber_length: Optional[float] = None,
    Tc_kinetics: Optional[float] = None,
    fuel_props: Optional[Dict] = None,
    debug: bool = False,
) -> Dict[str, float]:
    """
    Advanced combustion efficiency calculation with physics-based corrections.
    
    Accounts for:
    1. Finite residence time (L*)
    2. Chemical reaction kinetics (pressure, temperature dependent)
    3. Mixing quality (spray, evaporation)
    4. Turbulence effects
    
    Model:
    η_c* = η_L* × η_kinetics × η_mixing × η_turbulence
    
    where:
    - η_L*: L*-based efficiency (finite residence time)
    - η_kinetics: Reaction kinetics efficiency (Damköhler number)
    - η_mixing: Mixing efficiency (spray quality)
    - η_turbulence: Turbulence enhancement
    
    NOTE: Cooling losses (η_cooling) are NOT applied in this function.
    They are applied externally in eta_cstar() to avoid double-counting.
    
    Parameters:
    -----------
    Lstar : float
        Characteristic length [m]
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K] (Used for residence time - Ideal is conservative)
    cstar_ideal : float
        Ideal c* from CEA [m/s]
    gamma : float
        Specific heat ratio
    R : float
        Gas constant [J/(kg·K)]
    MR : float
        Mixture ratio
    config : CombustionEfficiencyConfig
        Efficiency configuration
    Ac : float
        Chamber area [m^2]
    At : float
        Throat area [m^2]
    Dinj : float
        Characteristic injector diameter [m]
    m_dot_total : float
        Total mass flow rate [kg/s]
    spray_diagnostics : dict, optional
        Spray diagnostics (SMD, evaporation length, etc.)
    turbulence_intensity : float
        Turbulence intensity (0-1)
    chamber_length : float, optional
        Physical chamber length [m]
    Tc_kinetics : float, optional
        Temperature to use for reaction kinetics [K]. If None, uses Tc.
        (Actual/Effective is conservative)
    
    Returns:
    --------
    results : dict
        - eta_total: Total combustion efficiency
        - eta_Lstar: L*-based efficiency
        - eta_kinetics: Kinetics efficiency
        - eta_mixing: Mixing efficiency
        - eta_turbulence: Turbulence efficiency
        - Da: Damköhler number
        - tau_res: Residence time [s]
        - tau_chem: Chemical reaction time [s]
    """
    # Validate required parameters - no fallbacks
    if u_fuel is None:
        raise ValueError(
            "u_fuel (fuel injection velocity) is required for advanced efficiency calculation. "
            "Check that diagnostics contains 'u_F' key."
        )
    if u_lox is None:
        raise ValueError(
            "u_lox (LOX injection velocity) is required for advanced efficiency calculation. "
            "Check that diagnostics contains 'u_O' key."
        )
    
    # Use Tc_kinetics for reaction-rate limited processes if provided
    T_react = Tc_kinetics if Tc_kinetics is not None else Tc


    # 1. L*-based efficiency (finite residence time)
    # Uses Tc (Ideal) for conservative residence time (shorter)
    if config.model == "constant":
        eta_Lstar = 1.0 - config.C
    elif config.model == "linear":
        eta_Lstar = 1.0 - config.C * (1.0 - Lstar / 1.0)
        eta_Lstar = np.clip(eta_Lstar, 0.0, 1.0)
    else:  # exponential (default)
        # SMD is REQUIRED - no fallback
        if spray_diagnostics is None:
            raise ValueError(
                "spray_diagnostics is required for eta_Lstar calculation in exponential model. "
                "Expected dict with 'D32_O' or 'D32_F' keys."
            )
        
        SMD = spray_diagnostics.get("D32_O") or spray_diagnostics.get("D32_F")
        if SMD is None or SMD <= 0:
            raise ValueError(
                f"spray_diagnostics must contain non-zero 'D32_O' or 'D32_F' for SMD. "
                f"Got keys: {list(spray_diagnostics.keys())}, D32_O={spray_diagnostics.get('D32_O')}, D32_F={spray_diagnostics.get('D32_F')}"
            )

        
        # Use Tc (Ideal) for residence time, call with new signature
        eta_Lstar, Da_L = calculate_eta_Lstar(
            Tc=Tc, Pc=Pc, R=R, m_dot_total=m_dot_total, Ac=Ac, At=At,
            SMD=SMD, L_star=Lstar, Dinj=Dinj, gamma=gamma, fuel_props=fuel_props,
            u_fuel=u_fuel, u_lox=u_lox, debug=debug
        )

    if config.model != "exponential":
        # Back-calculate Da_L for logging if using non-exponential models
        Da_L = np.inf if eta_Lstar > 0.999 else -np.log(max(1.0 - eta_Lstar, 1e-10))

    # Log warning if eta_Lstar is low (no clamp per user requirements)
    if eta_Lstar < 0.5:
        warnings.warn(f"[PHYSICS_WARN] eta_Lstar={eta_Lstar:.4f} is low, check evaporation model inputs.")
    
    # 2. Reaction kinetics efficiency (Damköhler number)
    # =========================================================================
    # PRINCIPLE: "Da inputs come from baseline state only"
    # =========================================================================
    # To avoid circular dependency where efficiency → degraded state → lower Da → lower efficiency:
    #   - tau_res: Uses Tc_ideal (CEA), Pc (solver guess), m_dot_total (upstream from injector flows)
    #   - tau_chem: Uses Tc_ideal (CEA), config kinetics params
    #   - rho_ch = Pc / (R * Tc_ideal)  ← NOT from degraded T_react
    #   - G_throat = m_dot_total / At   ← m_dot_total is upstream injector supply, NOT back-solved from c*
    # =========================================================================
    tau_res = calculate_residence_time(Lstar, Pc, cstar_ideal, gamma, R, Tc, Ac, At, m_dot_total)
    
    # tau_chem uses IDEAL Tc to break circular dependency (per user requirement)
    # Config provides calibrated kinetics parameters for LOX/RP-1
    tau_chem = calculate_reaction_time_scale(
        Pc=Pc,
        Tc=Tc,  # Use ideal Tc, not T_react, to decouple from efficiency
        MR=MR,
        gamma=gamma,
        tau_ref=config.tau_ref,
        P_ref=config.tau_ref_P,
        T_ref=config.tau_ref_T,
        n_pressure=config.n_pressure,
    )
    Da = calculate_damkohler_number(tau_res, tau_chem)
    
    # Efficiency based on Damköhler number (no clamp per user requirements)
    eta_kinetics = 1.0 - np.exp(-np.sqrt(Da))
    
    # DEBUG: Kinetics detail showing state sourcing
    if debug and (Da < 5.0 or eta_kinetics < 0.9):
        logging.getLogger("evaluate").info(f"[KINETICS_DEBUG] Da: {Da:.4f} | tau_res: {tau_res*1e3:.3f} ms | tau_chem: {tau_chem*1e6:.1f} µs | eta: {eta_kinetics:.4f}")
        logging.getLogger("evaluate").info(f"[KINETICS_DEBUG] Using Tc_ideal={Tc:.0f} K (not T_react={T_react:.0f} K) to break circular coupling")
    
    # 3. Mixing efficiency - uses near-field model (pure stirring, no evap penalties)
    eta_mixing = calculate_mixing_efficiency(
        Tc=Tc, Pc=Pc, R=R, Ac=Ac, At=At, Dinj=Dinj,
        m_dot_total=m_dot_total, Lstar=Lstar,
        u_fuel=u_fuel, u_lox=u_lox,
        turbulence_intensity=turbulence_intensity,
        debug=debug
    )
    
    # Sanity warning for implausibly low mixing (no clamp per user requirements)
    if eta_mixing < 0.2 and Pc > 2e6:
        u_f = u_fuel or 0
        u_o = u_lox or 0
        if u_f > 10 and u_o > 10:
            warnings.warn(
                f"[PHYSICS_CHECK] Low mixing η={eta_mixing:.2%} at Pc={Pc/1e6:.1f}MPa "
                f"with injection speeds u_F={u_f:.0f}, u_O={u_o:.0f} m/s. "
                f"Check L_mix scale."
            )
    
    # 4. Turbulence efficiency (enhancement)
    if turbulence_intensity < 0.05:
        eta_turbulence_raw = 0.9
    elif turbulence_intensity < 0.15:
        eta_turbulence_raw = 0.95 + 0.05 * (turbulence_intensity / 0.15)
    else:
        eta_turbulence_raw = 1.0 - 0.1 * ((turbulence_intensity - 0.15) / 0.35)
    
    eta_turbulence = np.clip(eta_turbulence_raw, 0.85, 1.0)
    
    # 5. Combined efficiency (no final clamp per user requirements)
    eta_total = eta_Lstar * eta_kinetics * eta_mixing * eta_turbulence
    
    # Get SMD for debug output (may not be available)
    SMD = 100e-6  # default
    if spray_diagnostics is not None:
        SMD = spray_diagnostics.get("D32_O", 0.0) or spray_diagnostics.get("D32_F", 0.0) or 100e-6
    
    if debug:
        logger = logging.getLogger("evaluate")
        logger.info(f"[ETA_DEBUG] INPUTS: Pc={Pc/1e6:.3f} MPa, Tc_ideal={Tc:.0f} K, T_react={T_react:.0f} K, Lstar={Lstar:.3f} m")
        logger.info(f"[ETA_DEBUG] INPUTS: SMD={SMD*1e6:.1f} µm, Ac={Ac*1e6:.2f} mm², At={At*1e6:.2f} mm², Dinj={Dinj*1e3:.2f} mm")
        logger.info(f"[ETA_DEBUG] INPUTS: m_dot_total={m_dot_total:.4f} kg/s, u_fuel_inj={u_fuel if u_fuel else 0:.1f} m/s, u_lox_inj={u_lox if u_lox else 0:.1f} m/s")
        
        rho_ch = Pc / (R * Tc)
        U_bulk = m_dot_total / (rho_ch * Ac)
        G_throat = m_dot_total / At
        
        logger.info(f"[ETA_DEBUG] DERIVED: rho_ch={rho_ch:.4f} kg/m³, U_bulk={U_bulk:.2f} m/s, G_throat={G_throat:.1f} kg/m²s")
        logger.info(f"[ETA_DEBUG] DERIVED: tau_res_ch={tau_res*1e3:.3f} ms, Da_kinetics={Da:.4f}, Da_L={Da_L:.4f}")
        logger.info(f"[ETA_DEBUG] OUTPUTS: eta_Lstar={eta_Lstar:.4f}, eta_kinetics={eta_kinetics:.4f}, eta_mixing={eta_mixing:.4f}, eta_turbulence={eta_turbulence:.4f}")
        logger.info(f"[ETA_DEBUG] eta_total={eta_total:.4f}")
    
    return {
        "eta_total": float(eta_total),
        "eta_Lstar": float(eta_Lstar),
        "eta_kinetics": float(eta_kinetics),
        "eta_mixing": float(eta_mixing),
        "eta_turbulence": float(eta_turbulence),
        "Da": float(Da),
        "tau_res": float(tau_res),
        "tau_chem": float(tau_chem),
    }


def calculate_equilibrium_shift(
    Pc: float,
    Tc: float,
    MR: float,
    Lstar: float,
) -> Dict[str, float]:
    """
    Calculate how far from equilibrium the combustion is.
    
    Returns metrics for:
    - Equilibrium completeness (0-1)
    - Reaction progress
    - Composition shift
    
    Parameters:
    -----------
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    MR : float
        Mixture ratio
    Lstar : float
        Characteristic length [m]
    
    Returns:
    --------
    results : dict
        - equilibrium_completeness: How close to equilibrium (0-1)
        - reaction_progress: Progress of main reactions (0-1)
        - composition_shift: Shift from ideal composition
    """
    # Estimate equilibrium completeness based on residence time
    # Higher pressure and temperature → faster approach to equilibrium
    # Longer L* → more time to reach equilibrium
    
    # Normalized pressure (relative to typical 4 MPa)
    P_norm = Pc / 4.0e6
    
    # Normalized temperature (relative to typical 3500 K)
    T_norm = Tc / 3500.0
    
    # Normalized L*
    Lstar_norm = Lstar / 1.0  # Relative to 1 m
    
    # Equilibrium completeness factor
    # Higher P, T, L* → closer to equilibrium
    completeness = 1.0 - np.exp(-0.5 * P_norm * T_norm * Lstar_norm)
    completeness = np.clip(completeness, 0.0, 1.0)
    
    # Reaction progress (simplified)
    # Assumes main reactions are 80% complete at typical conditions
    progress = 0.8 * completeness
    
    # Composition shift (how much composition differs from equilibrium)
    # Lower completeness → larger shift
    shift = 1.0 - completeness
    
    return {
        "equilibrium_completeness": float(completeness),
        "reaction_progress": float(progress),
        "composition_shift": float(shift),
    }

