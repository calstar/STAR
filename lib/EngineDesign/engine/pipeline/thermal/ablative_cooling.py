"""Ablative cooling response model with proper physics-based ablation."""

from __future__ import annotations

from typing import Dict, Union, List, Optional

import numpy as np

from engine.pipeline.config_schemas import AblativeCoolingConfig
from engine.pipeline.constants import STEFAN_BOLTZMANN_W_M2_K4, EPSILON_SMALL


def compute_ablative_heat_flux_profile(
    gas_props: Dict[str, float],
    ablative_config: AblativeCoolingConfig,
    mdot_total: float,
    L_chamber: float,
    D_chamber: float,
    D_throat: float,
    n_segments: int = 20,
    L_nozzle: Optional[float] = None,
    D_exit: Optional[float] = None,
    include_nozzle: bool = True,
) -> Dict[str, List[float]]:
    """
    Compute heat flux profile along chamber AND nozzle for ablative/radiative cooling.
    
    This function samples axial stations from injector through throat to nozzle exit,
    computing incident and net heat flux using quasi-1D flow and Bartz-like correlations.
    
    Coordinate system: x=0 at throat, negative towards injector, positive towards exit.
    
    Parameters
    ----------
    gas_props : dict
        Gas properties including Tc, Pc, gamma, R, M (molecular weight)
    ablative_config : AblativeCoolingConfig
        Ablative cooling configuration
    mdot_total : float
        Total mass flow rate [kg/s]
    L_chamber : float
        Chamber length [m] (injector to throat)
    D_chamber : float
        Chamber inner diameter [m]
    D_throat : float
        Throat diameter [m]
    n_segments : int
        Number of axial segments for chamber (default: 20)
    L_nozzle : float, optional
        Nozzle length [m] (throat to exit). If None, nozzle is not included.
    D_exit : float, optional
        Nozzle exit diameter [m]. Required if L_nozzle is provided.
    include_nozzle : bool
        Whether to include nozzle section in profile (default: True)
    
    Returns
    -------
    profile : dict
        - segment_x: Axial positions [m] (0 = throat, negative = chamber, positive = nozzle)
        - segment_q_incident: Incident heat flux [W/m²] (conv + rad)
        - segment_q_conv: Convective heat flux [W/m²]
        - segment_q_rad: Radiative heat flux [W/m²]
        - segment_q_net: Net heat flux after relief [W/m²]
        - throat_index: Index of throat position in arrays
    """
    if not ablative_config.enabled or L_chamber <= 0 or D_throat <= 0:
        return {
            "segment_x": [],
            "segment_q_incident": [],
            "segment_q_conv": [],
            "segment_q_rad": [],
            "segment_q_net": [],
            "throat_index": -1,
        }
    
    # Extract gas properties
    Tc = gas_props.get("Tc", 3000.0)
    Pc = gas_props.get("Pc", 2e6)
    gamma = gas_props.get("gamma", 1.2)
    R_gas = gas_props.get("R", 350.0)
    M_mol = gas_props.get("M", 24.0)  # Molecular weight [kg/kmol]
    
    # Wall temperature (fixed surface temperature limit for ablative)
    T_wall = ablative_config.surface_temperature_limit
    
    # Determine if we include nozzle
    has_nozzle = include_nozzle and L_nozzle is not None and L_nozzle > 0 and D_exit is not None and D_exit > D_throat
    
    # Create axial position array
    # Chamber: from -L_chamber (injector) to 0 (throat)
    # Nozzle: from 0 (throat) to +L_nozzle (exit)
    n_chamber = n_segments
    segment_x_chamber = np.linspace(-L_chamber, 0, n_chamber, endpoint=False)  # Don't include throat (added with nozzle)
    
    if has_nozzle:
        n_nozzle = max(n_segments // 2, 10)  # Fewer points in nozzle, but at least 10
        segment_x_nozzle = np.linspace(0, L_nozzle, n_nozzle)  # Includes throat at x=0
        segment_x = np.concatenate([segment_x_chamber, segment_x_nozzle])
        throat_index = n_chamber  # Throat is at the start of nozzle section
    else:
        # Chamber only - add throat point at end
        segment_x = np.append(segment_x_chamber, 0.0)
        throat_index = len(segment_x) - 1
    
    n_total = len(segment_x)
    
    # Arrays for results
    segment_q_conv = np.zeros(n_total)
    segment_q_rad = np.zeros(n_total)
    segment_q_incident = np.zeros(n_total)
    segment_q_net = np.zeros(n_total)
    
    # Throat area and chamber area
    A_throat = np.pi * (D_throat / 2) ** 2
    A_chamber = np.pi * (D_chamber / 2) ** 2
    A_exit = np.pi * (D_exit / 2) ** 2 if has_nozzle else A_throat
    
    # Gas viscosity using Huzel formula: μ = 46.6e-10 × M^0.5 × T^0.6 [lb·s/in²]
    # Convert to Pa·s: multiply by 6894.76
    def calc_viscosity(T_K, M_kg_kmol):
        T_R = T_K * 1.8  # Kelvin to Rankine
        mu_imperial = 46.6e-10 * (M_kg_kmol ** 0.5) * (T_R ** 0.6)
        return mu_imperial * 6894.76  # Convert to Pa·s
    
    # Supersonic Mach number from area ratio using Newton-Raphson
    def mach_from_area_ratio_supersonic(area_ratio, gamma, tol=1e-6, max_iter=50):
        """Solve for supersonic M given A/A* using Newton-Raphson."""
        # Initial guess for supersonic branch
        M = 1.5 + 0.5 * (area_ratio - 1.0)
        
        for _ in range(max_iter):
            # Area-Mach relation: A/A* = (1/M) * [(2/(γ+1)) * (1 + (γ-1)/2 * M²)]^((γ+1)/(2(γ-1)))
            gp1 = gamma + 1.0
            gm1 = gamma - 1.0
            term = (2.0 / gp1) * (1.0 + gm1 / 2.0 * M ** 2)
            exp = gp1 / (2.0 * gm1)
            f = (1.0 / M) * (term ** exp) - area_ratio
            
            # Derivative
            df = -term ** exp / M ** 2 + (1.0 / M) * exp * (term ** (exp - 1.0)) * (gm1 / gp1) * M
            
            if abs(df) < 1e-12:
                break
            
            M_new = M - f / df
            if M_new <= 1.0:
                M_new = 1.01  # Keep supersonic
            
            if abs(M_new - M) < tol:
                return M_new
            M = M_new
        
        return M
    
    # Gas thermal conductivity estimate: k ≈ μ × cp / Pr
    # Typical Pr for combustion gases: 0.7-0.8
    Pr_gas = 0.75
    cp_gas = gamma * R_gas / (gamma - 1.0)
    
    # Recovery factor for adiabatic wall temperature
    # Typical value for turbulent flow: r ≈ Pr^(1/3) ≈ 0.9
    recovery_factor = 0.9
    
    for i, x in enumerate(segment_x):
        # Determine region and calculate local area
        # x < 0: chamber (subsonic), x = 0: throat (M=1), x > 0: nozzle (supersonic)
        
        if x < 0:
            # Chamber region: linear contraction from injector to throat
            # At x = -L_chamber: A = A_chamber, at x = 0: A = A_throat
            xi_chamber = (x + L_chamber) / L_chamber  # 0 at injector, 1 at throat
            A_local = A_chamber - (A_chamber - A_throat) * xi_chamber
            is_supersonic = False
        elif x == 0:
            # Throat
            A_local = A_throat
            is_supersonic = False  # M = 1 at throat
        else:
            # Nozzle region: expansion from throat to exit
            # At x = 0: A = A_throat, at x = L_nozzle: A = A_exit
            if has_nozzle and L_nozzle > 0:
                xi_nozzle = x / L_nozzle  # 0 at throat, 1 at exit
                A_local = A_throat + (A_exit - A_throat) * xi_nozzle
            else:
                A_local = A_throat
            is_supersonic = True
        
        D_local = np.sqrt(4.0 * A_local / np.pi)
        area_ratio = A_local / A_throat
        
        # Calculate Mach number based on region
        if area_ratio < 1.01:
            # At or very near throat
            M_local = 1.0
        elif is_supersonic:
            # Supersonic (nozzle): solve for M > 1
            M_local = mach_from_area_ratio_supersonic(area_ratio, gamma)
        else:
            # Subsonic (chamber): M ≈ A*/A for low Mach
            M_local = 1.0 / area_ratio
            M_local = min(M_local, 0.99)
        
        # Local temperature (isentropic): T_local/Tc = 1 / [1 + (γ-1)/2 × M²]
        temp_factor = 1.0 / (1.0 + (gamma - 1.0) / 2.0 * M_local ** 2)
        T_local = Tc * temp_factor
        
        # Local pressure (isentropic): P_local/Pc = [1 + (γ-1)/2 × M²]^(-γ/(γ-1))
        pressure_exp = -gamma / (gamma - 1.0)
        P_local = Pc * (1.0 + (gamma - 1.0) / 2.0 * M_local ** 2) ** pressure_exp
        
        # Local density: ρ = P / (R × T)
        rho_local = P_local / (R_gas * max(T_local, 1.0))
        
        # Local velocity: V = M × sqrt(γ × R × T)
        a_local = np.sqrt(gamma * R_gas * T_local)
        V_local = M_local * a_local
        
        # Adiabatic wall temperature: Taw = T_local × [1 + r × (γ-1)/2 × M²]
        Taw = T_local * (1.0 + recovery_factor * (gamma - 1.0) / 2.0 * M_local ** 2)
        
        # Gas properties at local temperature
        mu_local = calc_viscosity(T_local, M_mol)
        k_local = mu_local * cp_gas / Pr_gas
        
        # Reynolds number based on local diameter
        Re_local = rho_local * V_local * D_local / max(mu_local, 1e-8)
        
        # Nusselt number: Dittus-Boelter for turbulent flow
        if Re_local > 2300:
            Nu_local = 0.023 * (Re_local ** 0.8) * (Pr_gas ** 0.4)
        else:
            Nu_local = 4.36  # Laminar pipe flow
        
        # Convective heat transfer coefficient
        h_local = Nu_local * k_local / max(D_local, 1e-6)
        
        # Bartz-like throat correction factor
        # Heat flux peaks at throat due to thinner boundary layer and high velocity
        # Use Gaussian-like peak centered at throat
        throat_distance = abs(x)
        characteristic_length = L_chamber / 4.0  # Spread of throat effect
        throat_factor = 1.0 + 1.5 * np.exp(-(throat_distance / characteristic_length) ** 2)
        
        # Convective heat flux: q_conv = h × (Taw - Tw)
        q_conv = h_local * throat_factor * max(Taw - T_wall, 0.0)
        
        # Radiative heat flux: q_rad = ε × σ × (Tg⁴ - Tw⁴)
        emissivity = ablative_config.surface_emissivity
        q_rad = emissivity * STEFAN_BOLTZMANN_W_M2_K4 * (T_local ** 4 - T_wall ** 4)
        q_rad = max(q_rad, 0.0)  # Only positive (gas → wall)
        
        # Incident heat flux (total from gas to wall)
        q_incident = q_conv + q_rad
        
        # Store results
        segment_q_conv[i] = q_conv
        segment_q_rad[i] = q_rad
        segment_q_incident[i] = q_incident
    
    # Compute net heat flux (after blowing/relief)
    # Relief model: f_relief = clip(a + b × q_incident, f_min, 1)
    # Simple first-pass: constant relief factor based on blowing efficiency
    f_relief_base = 1.0 - ablative_config.blowing_efficiency
    
    # Scale relief with incident flux (higher flux → more pyrolysis → more blowing)
    # f_relief(x) = clip(f_base - k × (q_incident / q_max), f_min, 1)
    q_max = np.max(segment_q_incident) if np.max(segment_q_incident) > 0 else 1.0
    f_relief_scaling = 0.2  # How much relief increases with heat flux
    
    for i in range(n_total):
        q_norm = segment_q_incident[i] / q_max
        # Higher flux → lower f_relief (more cooling from blowing)
        f_relief = f_relief_base - f_relief_scaling * q_norm
        f_relief = np.clip(f_relief, ablative_config.blowing_min_reduction_factor, 1.0)
        segment_q_net[i] = segment_q_incident[i] * f_relief
    
    # throat_index was set earlier based on array construction
    
    return {
        "segment_x": segment_x.tolist(),
        "segment_q_incident": segment_q_incident.tolist(),
        "segment_q_conv": segment_q_conv.tolist(),
        "segment_q_rad": segment_q_rad.tolist(),
        "segment_q_net": segment_q_net.tolist(),
        "throat_index": throat_index,
    }


def compute_ablative_response(
    net_heat_flux: float,
    surface_temperature: float,
    ablative_config: AblativeCoolingConfig,
    surface_area: float,
    turbulence_intensity: float,
    heat_flux_conv: float = None,
    heat_flux_rad: float = None,
    gas_mass_flow_rate: float = None,
) -> Dict[str, Union[float, bool]]:
    """Estimate ablative recession rate and heat balance with proper physics.

    This function models:
    1. Ablation only occurs when surface temperature exceeds pyrolysis temperature
    2. Proper radiative heat transfer (radiation FROM wall surface to environment)
    3. Energy balance accounting for all heat transfer mechanisms
    
    Heat Flux Definitions and Sign Conventions:
    - heat_flux_conv: NET convective flux from gas to wall [W/m²]
      Formula: q_conv = h_g × (Taw - Tw)
      Sign: Positive = heat flows INTO wall (gas → wall)
      This is already the net flux (gas → wall)
    
    - heat_flux_rad: NET radiative flux from gas to wall [W/m²]
      Formula: q_rad = ε × σ × (T_gas⁴ - T_wall⁴)
      Sign: Positive = heat flows INTO wall (gas → wall)
      This is already the net flux (gas → wall), accounting for wall temperature
      NOTE: If T_wall > T_gas, this will be negative (wall radiates to gas)
    
    - radiative_relief: Radiative flux from wall to environment [W/m²]
      Formula: q_relief = ε × σ × (T_wall⁴ - T_sink⁴)
      Sign: Always non-negative (clamped to ≥ 0)
      This is a separate cooling term (wall → environment), reduces net heat into wall
      Always subtracted from total heat flux (cooling effect)
    
    Energy Balance:
    effective_heat_flux = (q_conv_effective + q_rad_net) - q_relief
    where q_conv_effective includes turbulence and blowing effects
    
    Parameters
    ----------
    net_heat_flux : float
        Total heat flux incident on ablative surface [W/m²].
        This includes both convective and radiative components from the hot gas.
    surface_temperature : float
        Current surface temperature [K].
    ablative_config : AblativeCoolingConfig
        Ablation model configuration.
    surface_area : float
        Surface area of ablative material [m²].
    turbulence_intensity : float
        Gas turbulence intensity (0-1).
    heat_flux_conv : float, optional
        NET convective heat flux from gas to wall [W/m²].
        Formula: h_g × (Taw - Tw). Already accounts for wall temperature.
        Sign convention: Positive = heat flows INTO wall (gas → wall).
    heat_flux_rad : float, optional
        NET radiative heat flux from gas to wall [W/m²].
        Formula: ε × σ × (T_gas⁴ - T_wall⁴). Already accounts for wall temperature.
        Sign convention: Positive = heat flows INTO wall (gas → wall).
        Can be negative if T_wall > T_gas (wall radiates to gas), but this is unusual.
    gas_mass_flow_rate : float, optional
        External gas mass flow rate [kg/s] (for physics-based blowing calculation).
        If provided and use_physics_based_blowing=True, computes blowing parameter B.

    Returns
    -------
    dict
        Response metrics including recession rate [m/s] and mass flux [kg/(m²·s)].
    """
    if not ablative_config.enabled or surface_area <= 0:
        return {
            "enabled": False,
            "recession_rate": 0.0,
            "mass_flux": 0.0,
            "surface_temperature": surface_temperature,
            "cooling_power": 0.0,
            "heat_removed": 0.0,  # Backward compatibility
            "turbulence_multiplier": 1.0,
            "radiative_relief": 0.0,
            "heat_flux_from_gas_radiative": 0.0,
            "heat_flux_from_gas_convective": 0.0,
        }

    # ========================================================================
    # TURBULENCE EFFECTS
    # ========================================================================
    turb_multiplier = 1.0
    if turbulence_intensity > 0 and ablative_config.turbulence_reference_intensity > 0:
        ratio = (turbulence_intensity / ablative_config.turbulence_reference_intensity) ** ablative_config.turbulence_exponent
        turb_multiplier = 1.0 + ablative_config.turbulence_sensitivity * ratio
    turb_multiplier = float(np.clip(turb_multiplier, 1.0, ablative_config.turbulence_max_multiplier))

    # ========================================================================
    # CHECK IF ABOVE PYROLYSIS TEMPERATURE
    # ========================================================================
    # Ablation only occurs when surface temperature exceeds pyrolysis temperature
    # Below pyrolysis: no ablation → no pyrolysis gases → no blowing effect
    below_pyrolysis = surface_temperature < ablative_config.pyrolysis_temperature

    # ========================================================================
    # BLOWING EFFECT (pyrolysis gases reduce convective heat transfer)
    # ========================================================================
    # Physics-based: B = m_dot_pyrolysis / m_dot_external
    # Empirical function: f(B) = 1/(1 + c*B) where c is blowing_coefficient
    # Legacy: constant factor based on blowing_efficiency
    #
    # Note: If below pyrolysis, there's no pyrolysis gases, so no blowing effect
    if below_pyrolysis:
        # No ablation → no pyrolysis gases → no blowing effect
        convective_reduction = 1.0
        use_physics_blowing = False
    elif ablative_config.use_physics_based_blowing and gas_mass_flow_rate is not None and gas_mass_flow_rate > 0:
        # Physics-based blowing will be computed later (after we have heat fluxes)
        use_physics_blowing = True
        # convective_reduction will be computed in the physics-based block
    else:
        # Legacy constant factor
        use_physics_blowing = False
        convective_reduction = 1.0 - np.clip(ablative_config.blowing_efficiency, 0.0, 1.0)

    # ========================================================================
    # RADIATIVE SINK TEMPERATURE
    # ========================================================================
    # Use fallback temperature if ambient is too low (represents heated steel layer behind ablator)
    if ablative_config.ambient_temperature < ablative_config.radiative_sink_minimum_threshold:
        T_rad_sink = ablative_config.radiative_sink_fallback_temperature
    else:
        T_rad_sink = ablative_config.ambient_temperature

    # ========================================================================
    # RADIATIVE RELIEF (Wall → Environment)
    # ========================================================================
    # Radiation FROM the hot wall surface TO the environment (reduces net heat flux into wall)
    # This is SEPARATE from heat_flux_rad (which is gas → wall)
    # Formula: q_rad_wall_to_env = ε × σ × (T_surf⁴ - T_sink⁴)
    # Note: heat_flux_rad is already NET (gas → wall), so this is an additional cooling term
    radiative_relief = (
        ablative_config.surface_emissivity
        * STEFAN_BOLTZMANN_W_M2_K4
        * (surface_temperature ** 4 - T_rad_sink ** 4)
    )
    radiative_relief = max(radiative_relief, 0.0)

    # ========================================================================
    # EFFECTIVE HEAT FLUX
    # ========================================================================
    # Separate convective and radiative components (turbulence/blowing only affect convective)
    if heat_flux_conv is not None and heat_flux_rad is not None:
        q_conv_incident = heat_flux_conv
        q_rad_incident = heat_flux_rad
    else:
        # Estimate: typically 20% radiative, 80% convective
        q_conv_incident = net_heat_flux * 0.8
        q_rad_incident = net_heat_flux * 0.2
    
    # Compute physics-based blowing if enabled (only when NOT below pyrolysis)
    if use_physics_blowing:  # We already know not below_pyrolysis from earlier check
        # Step 1: Provisional mass flux assuming no blowing reduction
        # (only turbulence applied)
        q_conv_provisional = q_conv_incident * turb_multiplier
        q_rad_provisional = q_rad_incident
        q_total_provisional = max(q_conv_provisional + q_rad_provisional - radiative_relief, 0.0)
        
        if q_total_provisional > 0:
            delta_T_pyro = max(surface_temperature - ablative_config.pyrolysis_temperature, 0.0)
            energy_per_mass = ablative_config.heat_of_ablation + ablative_config.specific_heat * delta_T_pyro
            
            if energy_per_mass > 0:
                # Provisional mass flux [kg/(m²·s)]
                mass_flux_provisional = q_total_provisional / max(energy_per_mass, EPSILON_SMALL)
                # Pyrolysis gas mass flow rate [kg/s]
                m_dot_pyrolysis = mass_flux_provisional * surface_area
                
                # Step 2: Compute blowing parameter B = m_dot_pyrolysis / m_dot_external
                B = m_dot_pyrolysis / max(gas_mass_flow_rate, EPSILON_SMALL)
                
                # Step 3: Apply empirical function f(B) = 1/(1 + c*B)
                # This gives the fraction of convective heat transfer that remains
                blowing_reduction_factor = 1.0 / (1.0 + ablative_config.blowing_coefficient * B)
                # Cap reduction to prevent unrealistic blowing effectiveness
                # Maximum reduction = 1 - blowing_min_reduction_factor
                # (e.g., min_reduction=0.1 means max 90% reduction)
                convective_reduction = max(
                    blowing_reduction_factor,
                    ablative_config.blowing_min_reduction_factor
                )
            else:
                convective_reduction = 1.0
        else:
            convective_reduction = 1.0
    elif not use_physics_blowing:
        # Legacy constant factor already computed above
        pass
    
    # Apply turbulence and blowing ONLY to convective component
    q_conv_effective = q_conv_incident * turb_multiplier * convective_reduction
    
    # Total effective heat flux = (convective + radiative) - radiative relief
    effective_heat_flux = max(q_conv_effective + q_rad_incident - radiative_relief, 0.0)

    # ========================================================================
    # ABLATION PHYSICS
    # ========================================================================
    # Ablation only occurs when surface temperature exceeds pyrolysis temperature
    # (below_pyrolysis already computed earlier)
    if below_pyrolysis or effective_heat_flux <= 0:
        recession_rate = 0.0
        mass_flux = 0.0
        cooling_power = 0.0
    else:
        # Energy required per unit mass: heat of ablation + sensible heat
        delta_T_pyro = max(surface_temperature - ablative_config.pyrolysis_temperature, 0.0)
        energy_per_mass = ablative_config.heat_of_ablation + ablative_config.specific_heat * delta_T_pyro
        
        if energy_per_mass <= 0:
            recession_rate = 0.0
            mass_flux = 0.0
            cooling_power = 0.0
        else:
            # Mass flux: ṁ'' = q_effective / H_ablation
            mass_flux = effective_heat_flux / max(energy_per_mass, EPSILON_SMALL)
            # Recession rate: ṙ = ṁ'' / ρ (safe division)
            if ablative_config.material_density > 0:
                recession_rate = mass_flux / ablative_config.material_density
            else:
                recession_rate = 0.0  # Invalid density
            # Cooling power: P = q_effective × A [W]
            cooling_power = effective_heat_flux * surface_area

    # Build result dict
    result = {
        "enabled": True,
        "recession_rate": float(recession_rate),
        "mass_flux": float(mass_flux),
        "surface_temperature": float(surface_temperature),
        "effective_heat_flux": float(effective_heat_flux),
        "radiative_relief": float(radiative_relief),
        "cooling_power": float(cooling_power),  # Power [W], not energy
        "heat_removed": float(cooling_power),  # Backward compatibility alias
        "turbulence_multiplier": turb_multiplier,
        "below_pyrolysis": below_pyrolysis,
        "heat_flux_from_gas_radiative": float(q_rad_incident),
        "heat_flux_from_gas_convective": float(q_conv_incident),
        "pyrolysis_temperature": float(ablative_config.pyrolysis_temperature),
    }
    
    # Add optional fields
    if not below_pyrolysis and cooling_power > 0:
        result["mass_flow"] = float(mass_flux * surface_area)
        result["coverage_area"] = float(surface_area)
    
    return result
