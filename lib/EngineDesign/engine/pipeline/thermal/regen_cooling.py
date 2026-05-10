"""Regenerative cooling channel pressure drop model"""

import numpy as np
from typing import Optional, Dict, List
from engine.pipeline.config_schemas import RegenCoolingConfig
from engine.pipeline.constants import (
    STEFAN_BOLTZMANN_W_M2_K4,
    DEFAULT_GAMMA_ND,
    DEFAULT_GAS_CONST_J_KG_K,
    DEFAULT_CHAMBER_LEN_M,
    DEFAULT_THROAT_AREA_M2,
    DEFAULT_COOLANT_SPEC_HEAT_J_KG_K,
    DEFAULT_COOLANT_THERMAL_COND_W_M_K,
    DEFAULT_COOLANT_DENS_KG_M3,
    DEFAULT_COOLANT_TEMP_K,
    DEFAULT_HOT_GAS_VISC_PA_S,
    DEFAULT_HOT_GAS_THERMAL_COND_W_M_K,
    DEFAULT_EMISSIVITY_ND,
    DEFAULT_VIEW_FACTOR_ND,
    NU_LAMINAR_ND,
    NU_TURBULENT_COEFFICIENT_ND,
    NU_TURBULENT_RE_EXPONENT_ND,
    NU_TURBULENT_PR_EXPONENT_ND,
    K_ENTRANCE_SHARP_ND,
    MIN_DENS_KG_M3,
    EPSILON_TINY,
    EPSILON_SMALL,
    DEFAULT_RECOVERY_FACTOR_ND,
    UNIVERSAL_GAS_CONST_J_KMOL_K,
)

# Unit conversion constants for viscosity formula
# Formula uses Rankine and lb/lb-mol, result in lb·s/in²
# Import from constants to avoid duplication
from engine.pipeline.constants import RANKINE_PER_KELVIN, LB_S_PER_IN2_TO_PA_S


def calculate_gas_viscosity_huzel(
    temperature: float,
    molecular_weight: float,
) -> float:
    """
    Calculate gas dynamic viscosity using Huzel's empirical correlation.
    
    Formula: μ = (46.6 × 10^-10) × M^0.5 × T^0.6
    
    Where:
    - M = molecular weight [lb/lb-mol] (same as kg/kmol numerically)
    - T = temperature [°R] (Rankine)
    - Result: μ [lb·s/in²], converted to [Pa·s]
    
    This correlation is specifically for combustion gases and accounts for:
    - Temperature dependence (T^0.6)
    - Molecular weight dependence (M^0.5)
    
    Parameters
    ----------
    temperature : float
        Gas temperature [K]
    molecular_weight : float
        Molecular weight [kg/kmol] (same as lb/lb-mol numerically)
    
    Returns
    -------
    viscosity : float
        Dynamic viscosity [Pa·s]
    
    References
    ----------
    Huzel & Huang, "Design of Liquid Propellant Rocket Engines"
    Equation (4-16) for combustion gas viscosity estimation
    """
    # Convert temperature from Kelvin to Rankine
    T_rankine = temperature * RANKINE_PER_KELVIN
    
    # Molecular weight: lb/lb-mol = kg/kmol (same numerically)
    M_lb_lbmol = molecular_weight
    
    # Calculate viscosity using Huzel's formula
    # μ = (46.6 × 10^-10) × M^0.5 × T^0.6
    # Result is in lb·s/in²
    mu_lb_s_in2 = 46.6e-10 * (M_lb_lbmol ** 0.5) * (T_rankine ** 0.6)
    
    # Convert from lb·s/in² to Pa·s
    viscosity_pa_s = mu_lb_s_in2 * LB_S_PER_IN2_TO_PA_S
    
    return float(viscosity_pa_s)


def calculate_channel_hydraulic_diameter(width: float, height: float) -> float:
    """
    Calculate hydraulic diameter for rectangular channel.
    
    d_hyd = 4 × A / P_wetted
    For rectangle: d_hyd = 2 × w × h / (w + h)
    
    Parameters:
    -----------
    width : float
        Channel width [m]
    height : float
        Channel height [m]
    
    Returns:
    --------
    d_hyd : float
        Hydraulic diameter [m]
    """
    if width <= 0 or height <= 0:
        raise ValueError("Channel dimensions must be positive")
    
    d_hyd = 2 * width * height / (width + height)
    return float(d_hyd)


def calculate_friction_factor(Re: float, d_hyd: float, roughness: float = 0.0) -> float:
    """
    Calculate Darcy-Weisbach friction factor.
    
    For smooth pipes (roughness = 0): Blasius correlation
    f = 0.316 / Re^0.25  (for Re < 10^5)
    
    For rough pipes: Colebrook equation (iterative)
    Or Swamee-Jain approximation
    
    Parameters:
    -----------
    Re : float
        Reynolds number
    d_hyd : float
        Hydraulic diameter [m]
    roughness : float
        Surface roughness [m] (default: 0 = smooth)
    
    Returns:
    --------
    f : float
        Friction factor
    """
    if Re <= 0:
        return 1.0  # Avoid division by zero
    
    if roughness == 0 or roughness / d_hyd < 1e-6:
        # Smooth pipe: Blasius correlation
        if Re < 1e5:
            f = 0.316 / (Re ** 0.25)
        else:
            # For higher Re, use more accurate correlation
            f = 0.184 / (Re ** 0.2)
    else:
        # Rough pipe: Swamee-Jain approximation
        relative_roughness = roughness / d_hyd
        f = 0.25 / (np.log10(relative_roughness / 3.7 + 5.74 / (Re ** 0.9))) ** 2
    
    return float(f)


def delta_p_regen_channels(
    mdot: float,
    rho: float,
    mu: float,
    config: RegenCoolingConfig,
    P_tank: float
) -> float:
    """
    Calculate pressure drop through regenerative cooling channels.
    
    Flow path:
    1. Inlet pipe (3/8" diameter)
    2. Split into N parallel channels
    3. N channels (each with friction)
    4. Merge back
    5. Pipe to injector
    
    Pressure drop is a function of tank pressure:
    - Higher tank pressure → higher mass flow → higher velocity → higher pressure drop
    - This is already captured through mdot(P_tank), but we add explicit pressure scaling
    - Channel length should match chamber length (cooling channels go across the length of the chamber)
    
    Parameters:
    -----------
    mdot : float
        Total mass flow rate [kg/s] (already depends on P_tank)
    rho : float
        Fluid density [kg/m³]
    mu : float
        Dynamic viscosity [Pa·s]
    config : RegenCoolingConfig
        Regenerative cooling configuration
    P_tank : float
        Tank pressure [Pa] - used for pressure-dependent scaling
    
    Returns:
    --------
    delta_p : float
        Total pressure drop [Pa]
    """
    # Note: Pressure dependence is already captured through mdot(P_tank)
    # Higher tank pressure → higher mdot → higher velocity → higher pressure drop
    # No additional scaling factor needed - the physics is already in the equations
    
    # 1. Inlet pipe (3/8" = 9.525 mm)
    d_inlet = config.d_inlet  # m
    A_inlet = np.pi * (d_inlet / 2) ** 2
    u_inlet = mdot / (rho * A_inlet)
    d_hyd_inlet = d_inlet
    Re_inlet = (rho * u_inlet * d_hyd_inlet) / mu
    f_inlet = calculate_friction_factor(Re_inlet, d_hyd_inlet, config.roughness)
    
    # Pressure drop in inlet pipe
    # Δp = f × (L/D) × (ρ/2) × u²
    delta_p_inlet = f_inlet * (config.L_inlet / d_hyd_inlet) * (rho / 2) * u_inlet ** 2
    
    # Add minor loss for inlet (entrance loss)
    delta_p_inlet += K_ENTRANCE_SHARP_ND * (rho / 2) * u_inlet ** 2
    
    # 2. Split loss (manifold)
    # Loss coefficient for flow splitting
    K_split = config.K_manifold_split
    delta_p_split = K_split * (rho / 2) * u_inlet ** 2
    
    # 3. N parallel channels
    # Each channel gets mdot / N
    mdot_channel = mdot / config.n_channels
    
    # Channel geometry
    d_hyd_channel = calculate_channel_hydraulic_diameter(
        config.channel_width,
        config.channel_height
    )
    A_channel = config.channel_width * config.channel_height
    
    # Channel entrance loss (discharge coefficient effect)
    # Flow contracts entering small channel, creating entrance loss
    # Cd varies with Reynolds number (flow contraction depends on Re)
    # Calculate Re for entrance (use channel velocity estimate)
    u_channel_estimate = mdot_channel / (rho * A_channel)
    Re_channel_entrance = (rho * u_channel_estimate * d_hyd_channel) / mu
    
    # Dynamic Cd for entrance: Cd(Re) = Cd_∞ - a_Re/√Re (same model as injector)
    if Re_channel_entrance <= 0:
        Cd_entrance_dynamic = config.Cd_entrance_min
    else:
        # FIXED: Ensure sqrt input is positive
        Cd_entrance_dynamic = config.Cd_entrance_inf - config.a_Re_entrance / np.sqrt(max(Re_channel_entrance, 1e-6))
        Cd_entrance_dynamic = np.clip(Cd_entrance_dynamic, config.Cd_entrance_min, config.Cd_entrance_inf)
    
    # Effective area reduction: A_eff = Cd_entrance × A_channel
    A_eff_entrance = Cd_entrance_dynamic * A_channel
    u_channel_entrance = mdot_channel / (rho * A_eff_entrance)
    
    # Entrance loss: Δp = (1/Cd² - 1) × (ρ/2) × u²
    # This accounts for flow contraction at channel entrance
    K_entrance_channel = (1.0 / (Cd_entrance_dynamic ** 2) - 1.0)
    delta_p_entrance_channel = K_entrance_channel * (rho / 2) * u_channel_entrance ** 2
    
    # Channel flow (after entrance)
    u_channel = mdot_channel / (rho * A_channel)
    Re_channel = (rho * u_channel * d_hyd_channel) / mu
    f_channel = calculate_friction_factor(Re_channel, d_hyd_channel, config.roughness)
    
    # Pressure drop in one channel (friction)
    # Δp = f × (L/D) × (ρ/2) × u²
    # Channel length should be the chamber length (cooling channels go across the length of the chamber)
    delta_p_channel_friction = f_channel * (config.channel_length / d_hyd_channel) * (rho / 2) * u_channel ** 2
    
    # Channel exit loss (discharge coefficient effect)
    # Flow expands exiting channel, creating exit loss
    # Cd varies with Reynolds number (flow expansion depends on Re)
    # Re_channel is already calculated above
    
    # Dynamic Cd for exit: Cd(Re) = Cd_∞ - a_Re/√Re (same model as injector)
    if Re_channel <= 0:
        Cd_exit_dynamic = config.Cd_exit_min
    else:
        # FIXED: Ensure sqrt input is positive
        Cd_exit_dynamic = config.Cd_exit_inf - config.a_Re_exit / np.sqrt(max(Re_channel, 1e-6))
        Cd_exit_dynamic = np.clip(Cd_exit_dynamic, config.Cd_exit_min, config.Cd_exit_inf)
    
    K_exit_channel = (1.0 - Cd_exit_dynamic ** 2)
    delta_p_exit_channel = K_exit_channel * (rho / 2) * u_channel ** 2
    
    # Total channel pressure drop (entrance + friction + exit)
    delta_p_channel = delta_p_entrance_channel + delta_p_channel_friction + delta_p_exit_channel
    
    # All channels are parallel, so same pressure drop
    # (flow splits equally if channels are identical)
    
    # 4. Merge loss (manifold)
    # Loss coefficient for flow merging
    K_merge = config.K_manifold_merge
    delta_p_merge = K_merge * (rho / 2) * u_channel ** 2
    
    # 5. Pipe to injector (after merge)
    # Use d_outlet if specified, otherwise same as inlet
    d_outlet = config.d_outlet if config.d_outlet is not None else d_inlet
    A_outlet = np.pi * (d_outlet / 2) ** 2
    u_outlet = mdot / (rho * A_outlet)
    d_hyd_outlet = d_outlet
    Re_outlet = (rho * u_outlet * d_hyd_outlet) / mu
    f_outlet = calculate_friction_factor(Re_outlet, d_hyd_outlet, config.roughness)
    
    delta_p_outlet = f_outlet * (config.L_outlet / d_hyd_outlet) * (rho / 2) * u_outlet ** 2
    
    # Total pressure drop
    delta_p_total = (
        delta_p_inlet +
        delta_p_split +
        delta_p_channel +
        delta_p_merge +
        delta_p_outlet
    )
    
    return float(delta_p_total)


def calculate_regen_velocity_profile(
    mdot: float,
    rho: float,
    config: RegenCoolingConfig
) -> dict:
    """
    Calculate velocity profile through regen cooling system.
    
    Returns velocities at each section for diagnostics.
    
    Parameters:
    -----------
    mdot : float
        Total mass flow rate [kg/s]
    rho : float
        Fluid density [kg/m³]
    config : RegenCoolingConfig
        Regenerative cooling configuration
    
    Returns:
    --------
    velocities : dict
        Dictionary with velocities at each section [m/s]
    """
    d_inlet = config.d_inlet
    A_inlet = np.pi * (d_inlet / 2) ** 2
    u_inlet = mdot / (rho * A_inlet)
    
    mdot_channel = mdot / config.n_channels
    A_channel = config.channel_width * config.channel_height
    u_channel = mdot_channel / (rho * A_channel)
    
    d_outlet = config.d_outlet if config.d_outlet is not None else d_inlet
    A_outlet = np.pi * (d_outlet / 2) ** 2
    u_outlet = mdot / (rho * A_outlet)
    
    return {
        "u_inlet": float(u_inlet),
        "u_channel": float(u_channel),
        "u_outlet": float(u_outlet),
        "mdot_channel": float(mdot_channel),
    }


def compute_regen_heat_transfer(
    mdot_coolant: float,
    coolant_props: Dict[str, float],
    gas_props: Dict[str, float],
    config: RegenCoolingConfig,
    mdot_total: float,
) -> Dict[str, float]:
    """Calculate heat-transfer coupling for regenerative cooling channels."""

    results = {
        "enabled": config.use_heat_transfer,
        "coolant_outlet_temperature": coolant_props.get("temperature", 0.0),
        "heat_removed": 0.0,
        "heat_flux_convective": 0.0,
        "heat_flux_radiative": 0.0,
        "overall_heat_flux": 0.0,
        "h_hot": 0.0,
        "h_coolant": 0.0,
        "wall_temperature_hot": gas_props.get("Tc", 0.0),
        "wall_temperature_coolant": coolant_props.get("temperature", 0.0),
        "film_effectiveness": 0.0,
        "effective_gas_temperature": gas_props.get("Tc", 0.0),
        "coolant_bulk_temperature": coolant_props.get("temperature", 0.0),
        "segment_wall_temperatures": [],
        "segment_heat_flux": [],
    }

    if not config.use_heat_transfer or mdot_coolant <= 0:
        return results

    cp_c = max(coolant_props.get("cp", DEFAULT_COOLANT_SPEC_HEAT_J_KG_K), 1.0)
    k_c = max(coolant_props.get("thermal_conductivity", DEFAULT_COOLANT_THERMAL_COND_W_M_K), EPSILON_SMALL)
    mu_c = max(coolant_props.get("viscosity", 1e-4), EPSILON_TINY)
    rho_c = max(coolant_props.get("density", DEFAULT_COOLANT_DENS_KG_M3), 1.0)
    T_c_bulk = coolant_props.get("temperature", DEFAULT_COOLANT_TEMP_K)

    channel_area = config.channel_width * config.channel_height
    d_hyd_channel = calculate_channel_hydraulic_diameter(config.channel_width, config.channel_height)
    mdot_channel = mdot_coolant / max(config.n_channels, 1)

    Pc = gas_props.get("Pc", 0.0)
    Tc = gas_props.get("Tc", 0.0)
    gamma = gas_props.get("gamma", DEFAULT_GAMMA_ND)
    R_g = gas_props.get("R", DEFAULT_GAS_CONST_J_KG_K)

    chamber_d_inner = config.chamber_inner_diameter
    if chamber_d_inner is None:
        chamber_area = gas_props.get("chamber_area")
        if chamber_area is not None and chamber_area > 0:
            chamber_d_inner = np.sqrt(4.0 * chamber_area / np.pi)
        else:
            throat_area = gas_props.get("A_throat", DEFAULT_THROAT_AREA_M2)
            chamber_d_inner = np.sqrt(4.0 * throat_area / np.pi)

    # Use chamber_length from gas_props (comes from chamber.length in config)
    # This is the actual physical chamber length, which should match channel_length
    chamber_length = gas_props.get("chamber_length", config.channel_length)
    # Fallback to config.channel_length if not in gas_props
    if chamber_length <= 0:
        chamber_length = config.channel_length
    circumference = np.pi * chamber_d_inner
    segment_count = max(config.n_segments, 1)
    segment_length = chamber_length / segment_count
    segment_area_hot = circumference * segment_length

    A_cross = np.pi * (chamber_d_inner ** 2) / 4.0
    rho_g = max(Pc / (R_g * max(Tc, 1.0)), MIN_DENS_KG_M3)
    V_g = mdot_total / (rho_g * A_cross)
    
    # Get viscosity from config (for reference)
    mu_g_config = config.hot_gas_viscosity
    
    # Calculate viscosity using Huzel's formula if molecular weight is available
    M = gas_props.get("M")  # Molecular weight [kg/kmol]
    if M is not None and M > 0 and Tc > 0:
        mu_g_calculated = calculate_gas_viscosity_huzel(Tc, M)
    else:
        mu_g_calculated = mu_g_config  # Fallback to config if M not available
    
    # Use calculated viscosity for calculations (more accurate)
    mu_g = mu_g_calculated
    
    k_g = config.hot_gas_thermal_conductivity
    cp_g = gamma * R_g / max(gamma - 1.0, EPSILON_SMALL)
    Pr_g = config.hot_gas_prandtl if config.hot_gas_prandtl > 0 else (mu_g * cp_g / max(k_g, EPSILON_SMALL))

    Re_g = rho_g * V_g * chamber_d_inner / max(mu_g, EPSILON_TINY)
    if Re_g < 2000:
        Nu_g = NU_LAMINAR_ND
    else:
        Nu_g = NU_TURBULENT_COEFFICIENT_ND * (Re_g ** NU_TURBULENT_RE_EXPONENT_ND) * (Pr_g ** NU_TURBULENT_PR_EXPONENT_ND)
    # CRITICAL FIX: Remove arbitrary 0.8 exponent - use linear scaling
    turbulence_boost_g = 1.0 + config.gas_turbulence_intensity  # Remove arbitrary 0.8 exponent
    h_g_base = Nu_g * k_g / chamber_d_inner * turbulence_boost_g

    # Calculate adiabatic wall temperature using recovery factor
    # Taw = Tc × recovery_factor (accounts for kinetic energy recovery in boundary layer)
    recovery_factor = config.recovery_factor if config.recovery_factor is not None else DEFAULT_RECOVERY_FACTOR_ND
    Taw = Tc * recovery_factor

    heat_removed_total = 0.0
    heat_flux_conv_total = 0.0
    heat_flux_rad_total = 0.0
    wall_hot_segments: List[float] = []
    wall_cold_segments: List[float] = []
    segment_heat_fluxes: List[float] = []

    for _ in range(segment_count):
        u_channel = mdot_channel / (rho_c * channel_area)
        Re_c = rho_c * u_channel * d_hyd_channel / max(mu_c, 1e-8)
        Pr_c = mu_c * cp_c / max(k_c, 1e-4)

        if Re_c <= 0:
            Nu_c = 0.0
        else:
            f_c = (0.79 * np.log(Re_c) - 1.64) ** -2 if Re_c > 2300 else 64.0 / max(Re_c, 1.0)
            Nu_c = (f_c / 8.0 * (Re_c - 1000.0) * Pr_c) / (1.0 + 12.7 * np.sqrt(f_c / 8.0) * (Pr_c ** (2.0 / 3.0) - 1.0))
            if Nu_c <= 0:
                Nu_c = NU_LAMINAR_ND
        # CRITICAL FIX: Remove arbitrary 0.8 exponent - use linear scaling
        turbulence_boost_c = 1.0 + config.coolant_turbulence_intensity  # Remove arbitrary 0.8 exponent
        h_c = Nu_c * k_c / d_hyd_channel * turbulence_boost_c

        h_g = h_g_base
        U_inv = (1.0 / max(h_g, EPSILON_SMALL)) + (config.wall_thickness / max(config.wall_thermal_conductivity, EPSILON_SMALL)) + (1.0 / max(h_c, EPSILON_SMALL))
        U = 1.0 / U_inv
        # Use adiabatic wall temperature (Taw) instead of chamber temperature (Tc)
        # More accurate: q = h_g × (Taw - Tw) where Taw = Tc × recovery_factor
        delta_T = max(Taw - T_c_bulk, 0.0)
        heat_flux_conv = U * delta_T
        heat_flux_rad = config.radiation_emissivity_hot * config.radiation_view_factor * STEFAN_BOLTZMANN_W_M2_K4 * (Tc ** 4 - T_c_bulk ** 4)
        heat_flux_rad = max(heat_flux_rad, 0.0)
        heat_flux_total = heat_flux_conv + heat_flux_rad

        q_segment = heat_flux_total * segment_area_hot
        heat_removed_total += q_segment
        heat_flux_conv_total += heat_flux_conv * segment_area_hot
        heat_flux_rad_total += heat_flux_rad * segment_area_hot

        T_c_bulk += q_segment / max(mdot_coolant * cp_c, EPSILON_SMALL)

        # Wall temperature calculated from adiabatic wall temperature
        Tw_hot = Taw - heat_flux_conv / max(h_g, EPSILON_SMALL)
        Tw_cold = Tw_hot - heat_flux_conv * config.wall_thickness / max(config.wall_thermal_conductivity, EPSILON_SMALL)

        wall_hot_segments.append(Tw_hot)
        wall_cold_segments.append(Tw_cold)
        segment_heat_fluxes.append(heat_flux_total)

    avg_heat_flux = heat_removed_total / (circumference * chamber_length) if chamber_length > 0 else 0.0

    results.update(
        {
            "coolant_outlet_temperature": float(T_c_bulk),
            "heat_removed": float(heat_removed_total),
            "heat_flux_convective": float(heat_flux_conv_total / max(circumference * chamber_length, EPSILON_SMALL)),
            "heat_flux_radiative": float(heat_flux_rad_total / max(circumference * chamber_length, EPSILON_SMALL)),
            "overall_heat_flux": float(avg_heat_flux),
            "h_hot": float(h_g_base),
            "h_coolant": float(h_c),
            "wall_temperature_hot": float(np.mean(wall_hot_segments) if wall_hot_segments else Taw),
            "wall_temperature_coolant": float(np.mean(wall_cold_segments) if wall_cold_segments else T_c_bulk),
            "gas_viscosity": float(mu_g),  # Viscosity used in calculations (calculated from Huzel if available)
            "gas_viscosity_config": float(mu_g_config),  # Viscosity from config (for reference)
            "gas_viscosity_calculated": float(mu_g_calculated),  # Viscosity from Huzel formula (for reference)
            "effective_gas_temperature": float(Tc),
            "adiabatic_wall_temperature": float(Taw),
            "coolant_bulk_temperature": float(T_c_bulk),
            "segment_wall_temperatures": wall_hot_segments,
            "segment_coolant_wall_temperatures": wall_cold_segments,
            "segment_heat_flux": segment_heat_fluxes,
            "segment_positions": [i * segment_length + segment_length / 2 for i in range(segment_count)],
        }
    )

    return results


def estimate_hot_wall_heat_flux(
    gas_props: Dict[str, float],
    config: Optional[RegenCoolingConfig],
    wall_temperature: float,
    mdot_total: float,
) -> Dict[str, float]:
    """Estimate convective and radiative heat flux from hot gas to wall (no coolant)."""

    Tc = gas_props.get("Tc", 0.0)
    Pc = gas_props.get("Pc", 0.0)
    gamma = gas_props.get("gamma", DEFAULT_GAMMA_ND)
    R_g = gas_props.get("R", DEFAULT_GAS_CONST_J_KG_K)
    # Prioritize chamber_length from gas_props (comes from chamber.length in config)where is h_g 
    # This is the actual physical chamber length, not the regen channel length
    chamber_length = gas_props.get("chamber_length", DEFAULT_CHAMBER_LEN_M)
    # Fallback to regen channel_length only if chamber_length is not in gas_props
    if chamber_length <= 0 and config is not None and config.channel_length > 0:
        chamber_length = config.channel_length
    # Last resort: use default
    if chamber_length <= 0:
        chamber_length = DEFAULT_CHAMBER_LEN_M

    chamber_d_inner = config.chamber_inner_diameter if config is not None else None
    if chamber_d_inner is None:
        chamber_area = gas_props.get("chamber_area")
        if chamber_area is not None and chamber_area > 0:
            chamber_d_inner = np.sqrt(4.0 * chamber_area / np.pi)
        else:
            throat_area = gas_props.get("A_throat", DEFAULT_THROAT_AREA_M2)
            chamber_d_inner = np.sqrt(4.0 * throat_area / np.pi)

    A_cross = np.pi * (chamber_d_inner ** 2) / 4.0
    rho_g = max(Pc / (R_g * max(Tc, 1.0)), MIN_DENS_KG_M3)
    V_g = mdot_total / (rho_g * A_cross)

    # Get viscosity from config (for reference)
    mu_g_config = config.hot_gas_viscosity if config is not None else DEFAULT_HOT_GAS_VISC_PA_S
    
    # Calculate viscosity using Huzel's formula if molecular weight is available
    M = gas_props.get("M")  # Molecular weight [kg/kmol]
    if M is not None and M > 0 and Tc > 0:
        mu_g_calculated = calculate_gas_viscosity_huzel(Tc, M)
    else:
        mu_g_calculated = mu_g_config  # Fallback to config if M not available
    
    # Use calculated viscosity for calculations (more accurate)
    mu_g = mu_g_calculated
    
    k_g = config.hot_gas_thermal_conductivity if config is not None else DEFAULT_HOT_GAS_THERMAL_COND_W_M_K
    cp_g = gamma * R_g / max(gamma - 1.0, EPSILON_SMALL)
    Pr_g_source = config.hot_gas_prandtl if (config is not None and config.hot_gas_prandtl > 0) else None
    Pr_g = Pr_g_source if Pr_g_source is not None else (mu_g * cp_g / max(k_g, EPSILON_SMALL))

    Re_g = rho_g * V_g * chamber_d_inner / max(mu_g, EPSILON_TINY)
    if Re_g < 2000:
        Nu_g = NU_LAMINAR_ND
    else:
        Nu_g = NU_TURBULENT_COEFFICIENT_ND * (Re_g ** NU_TURBULENT_RE_EXPONENT_ND) * (Pr_g ** NU_TURBULENT_PR_EXPONENT_ND)
    h_g = Nu_g * k_g / chamber_d_inner

    # Calculate adiabatic wall temperature using recovery factor
    # Taw = Tc × recovery_factor (accounts for kinetic energy recovery in boundary layer) see Huzel 4-10
    recovery_factor = config.recovery_factor if (config is not None and config.recovery_factor is not None) else DEFAULT_RECOVERY_FACTOR_ND
    Taw = Tc * recovery_factor

    delta_T = max(Taw - wall_temperature, 0.0)
    heat_flux_conv = h_g * delta_T
    emissivity = config.radiation_emissivity_hot if config is not None else DEFAULT_EMISSIVITY_ND
    view_factor = config.radiation_view_factor if config is not None else DEFAULT_VIEW_FACTOR_ND
    heat_flux_rad = emissivity * view_factor * STEFAN_BOLTZMANN_W_M2_K4 * (
        Tc ** 4 - wall_temperature ** 4
    )
    heat_flux_total = heat_flux_conv + max(heat_flux_rad, 0.0)

    A_hot = np.pi * chamber_d_inner * chamber_length

    return {
        "heat_flux_total": float(heat_flux_total),
        "heat_flux_conv": float(heat_flux_conv),
        "heat_flux_rad": float(max(heat_flux_rad, 0.0)),
        "h_hot": float(h_g),
        "surface_area": float(A_hot),
        "adiabatic_wall_temperature": float(Taw),
        "gas_viscosity": float(mu_g),  # Viscosity used in calculations (calculated from Huzel if available)
        "gas_viscosity_config": float(mu_g_config),  # Viscosity from config (for reference)
        "gas_viscosity_calculated": float(mu_g_calculated),  # Viscosity from Huzel formula (for reference)
    }
