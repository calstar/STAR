"""Graphite throat insert cooling and recession model - Physics-based with oxidation heat feedback"""

from __future__ import annotations

from typing import Dict, Optional
import numpy as np
from engine.pipeline.config_schemas import GraphiteInsertConfig

SIGMA = 5.670374419e-8  # Stefan-Boltzmann constant
R_GAS = 8.314  # J/(mol·K) - universal gas constant
MW_C = 0.012  # kg/mol - molar mass of carbon
MW_O2 = 0.032  # kg/mol - molar mass of oxygen


def calculate_throat_heuristic_multiplier(
    chamber_pressure: float,
    chamber_velocity: float,
    throat_velocity: float,
    chamber_heat_flux: float,
    gamma: float = 1.2,
) -> float:
    """
    Calculate throat recession multiplier based on local flow conditions using a heuristic scaling.
    
    Throat recession is typically 1.2-2.5x higher than chamber due to:
    1. Higher velocity → Higher convective heat transfer
    2. Sonic conditions → Maximum heat flux
    3. Pressure gradient → Enhanced mass transfer
    4. Turbulence amplification near throat
    
    Heuristic scaling for heat flux ratio:
        q_throat / q_chamber ∝ (V_throat / V_chamber)^0.8 × (P_throat / P_chamber)^0.2
    
    WARNING: This is not a formal Bartz correlation. Real throat heat transfer depends on 
    geometry (D_t, curvature), viscosity/Pr, and boundary layer state. If 
    heat_transfer_coefficient at the throat is already available from a CFD or 
    boundary-layer code, this heuristic multiplier should not be used.
    
    Parameters:
    -----------
    chamber_pressure : float
        Chamber pressure [Pa]
    chamber_velocity : float
        Chamber gas velocity [m/s]
    throat_velocity : float
        Throat gas velocity (sonic) [m/s]
    chamber_heat_flux : float
        Chamber wall heat flux [W/m²] (used for validation, not in calculation)
    gamma : float
        Specific heat ratio
    
    Returns:
    --------
    multiplier : float
        Throat recession multiplier (typically 1.2-2.5)
    """
    if chamber_velocity <= 0 or throat_velocity <= 0:
        return 1.3  # Default fallback
    
    # Velocity ratio effect (dominant factor)
    velocity_ratio = throat_velocity / chamber_velocity
    velocity_factor = velocity_ratio ** 0.8
    
    # Pressure ratio effect (throat is at critical pressure)
    # P_throat / P_chamber ≈ (2/(γ+1))^(γ/(γ-1))
    pressure_ratio = (2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0))
    pressure_factor = pressure_ratio ** 0.2
    
    # Heuristic heat flux ratio
    heat_flux_ratio = velocity_factor * pressure_factor
    
    # Recession rate is proportional to heat flux
    # Add a base factor for enhanced turbulence at throat
    turbulence_enhancement = 1.1
    
    multiplier = heat_flux_ratio * turbulence_enhancement
    
    # Clamp to reasonable bounds (1.2 to 2.5)
    multiplier = float(np.clip(multiplier, 1.2, 2.5))
    
    return multiplier


def compute_graphite_recession(
    net_heat_flux: float,
    throat_temperature: float,
    gas_temperature: float,
    graphite_config: GraphiteInsertConfig,
    throat_area: float,
    pressure: float,
    gas_density: Optional[float] = None,
    gas_viscosity: Optional[float] = None,
    oxygen_mass_fraction: Optional[float] = None,
    characteristic_length: Optional[float] = None,
    gas_velocity: Optional[float] = None,
    heat_transfer_coefficient: Optional[float] = None,
    backside_temperature: Optional[float] = None,
    effective_thickness: Optional[float] = None,
) -> Dict[str, float]:
    """
    Calculate graphite throat insert recession rate using physics-based models with oxidation heat feedback.
    
    Implements the theory from graphite_oxidation_feedback.tex:
    - Energy balance: q''_in + q''_fb - q''_rad = q''_cond + m''_th H*_th
    - Oxidation kinetics: kinetic-limited and diffusion-limited rates
    - Feedback fraction: f_fb based on Damköhler number and blowing parameter
    - Iterative solution for surface temperature
    
    Graphite recession is driven by:
    1. Chemical oxidation (C + O2 -> CO/CO2) - dominant mechanism
    2. Thermal ablation (sublimation) - only at very high temperatures (>2800 K)
    
    Parameters:
    -----------
    net_heat_flux : float
        Reference convective heat flux [W/m²] at initial T_s (used to estimate h_g if not provided)
    throat_temperature : float
        Initial guess for throat surface temperature [K]
    gas_temperature : float
        Free-stream gas temperature [K]
    graphite_config : GraphiteInsertConfig
        Graphite insert configuration
    throat_area : float
        Throat area [m²]
    pressure : float
        Chamber/throat pressure [Pa]
    gas_density : float, optional
        Gas density [kg/m³]. If None, estimated from ideal gas law.
    gas_viscosity : float, optional
        Gas dynamic viscosity [Pa·s]. If None, estimated (~4e-5 Pa·s for combustion products).
    oxygen_mass_fraction : float, optional
        Oxygen mass fraction in free stream. If None, estimated (~0.3 for LOX/RP-1).
    characteristic_length : float, optional
        Characteristic length for Sherwood number [m]. If None, uses throat diameter.
    gas_velocity : float, optional
        Gas velocity [m/s]. If None, estimated from sonic conditions.
    heat_transfer_coefficient : float, optional
        Convective heat transfer coefficient h_g [W/(m²·K)]. If None, estimated from net_heat_flux.
    backside_temperature : float, optional
        Backside temperature for conduction [K]. If None, uses default 300 K.
    effective_thickness : float, optional
        Effective thickness for conduction [m]. If None, uses char_layer_thickness + 0.001 m.
    
    Returns:
    --------
    dict
        Recession metrics including recession rate [m/s], mass flux [kg/(m²·s)],
        surface temperature [K], and detailed heat transfer breakdown.
    """
    if not graphite_config.enabled or throat_area <= 0:
        return {
            "enabled": False,
            "recession_rate": 0.0,
            "mass_flux": 0.0,
            "surface_temperature": throat_temperature,
            "heat_removed": 0.0,
            "oxidation_rate": 0.0,
            "oxidation_mass_flux": 0.0,
            "thermal_mass_flux": 0.0,
            "feedback_fraction": 0.0,
            "q_feedback": 0.0,
            "q_radiation": 0.0,
            "q_conduction": 0.0,
        }
    
    # Graphite throats absolutely can recede, especially under high heat flux 
    # and oxidizing species. sizing_only_mode allows suppressing this recession 
    # for initial design phases where only thermal soak is being evaluated.
    sizing_only_mode = getattr(graphite_config, "sizing_only_mode", False)
    # If sizing_only_mode is True, we calculate physics but return zero recession_rate.
    # Otherwise (default), we return the physical recession rate.

    # Simplified oxidation mode: constant 0.01 mm/s radial recession
    simplified_mode = getattr(graphite_config, "simplified_graphite_oxidation", False)
    if simplified_mode:
        # Constant 0.01 mm/s = 1e-5 m/s
        m_dot_ox_simple = 1e-5 * graphite_config.material_density
        
        # Return simplified metrics immediately
        # Still calculate basic thermal metrics if needed, but for simplified mode we skip the complex loop
        recession_rate_report = 0.0 if sizing_only_mode else 1e-5
        return {
            "enabled": True,
            "recession_rate": float(recession_rate_report),
            "recession_rate_calculated": 1e-5,
            "mass_flux": float(0.0 if sizing_only_mode else m_dot_ox_simple),
            "mass_flux_calculated": float(m_dot_ox_simple),
            "surface_temperature": float(throat_temperature),
            "effective_heat_flux": float(net_heat_flux),
            "radiative_relief": 0.0,
            "conduction_loss": 0.0,
            "heat_removed": 0.0,
            "oxidation_rate": 1e-5,
            "oxidation_mass_flux": float(m_dot_ox_simple),
            "thermal_mass_flux": 0.0,
            "recession_rate_thermal": 0.0,
            "mass_flux_thermal": 0.0,
            "coverage_area": float(throat_area * graphite_config.coverage_fraction),
            "feedback_fraction": 0.0,
            "q_feedback": 0.0,
            "q_radiation": 0.0,
            "q_conduction": 0.0,
            "q_convective": float(net_heat_flux),
            "damkohler_number": 0.0,
            "blowing_parameter": 0.0,
            "sizing_only_mode": sizing_only_mode,
            "simplified_mode": True,
        }
    
    # -------------------------------------------------------------------------
    # STRICT INPUT VALIDATION: no hidden defaults
    # -------------------------------------------------------------------------
    missing: list[str] = []
    # Required gas/transport inputs (caller must provide)
    if gas_density is None:
        missing.append("gas_density")
    if gas_viscosity is None:
        missing.append("gas_viscosity")
    if oxygen_mass_fraction is None:
        missing.append("oxygen_mass_fraction")
    if characteristic_length is None:
        missing.append("characteristic_length")
    if gas_velocity is None:
        missing.append("gas_velocity")
    if heat_transfer_coefficient is None:
        missing.append("heat_transfer_coefficient")
    if backside_temperature is None:
        missing.append("backside_temperature")
    if effective_thickness is None:
        missing.append("effective_thickness")

    # Required config fields that were previously defaulted
    emissivity = getattr(graphite_config, "emissivity", None)
    if emissivity is None:
        missing.append("graphite_config.emissivity")
    T_env = getattr(graphite_config, "ambient_temperature", None)
    if T_env is None:
        missing.append("graphite_config.ambient_temperature")
    f_fb_min = getattr(graphite_config, "feedback_fraction_min", None)
    if f_fb_min is None:
        missing.append("graphite_config.feedback_fraction_min")
    f_fb_max = getattr(graphite_config, "feedback_fraction_max", None)
    if f_fb_max is None:
        missing.append("graphite_config.feedback_fraction_max")
    pressure_exponent = getattr(graphite_config, "oxidation_pressure_exponent", None)
    if pressure_exponent is None:
        missing.append("graphite_config.oxidation_pressure_exponent")
    mixture_mw = getattr(graphite_config, "mixture_mw", None)
    if mixture_mw is None:
        missing.append("graphite_config.mixture_mw")
    stoichiometry_ratio = getattr(graphite_config, "oxidation_stoichiometry_ratio", None)
    if stoichiometry_ratio is None:
        missing.append("graphite_config.oxidation_stoichiometry_ratio")
    oxidation_enthalpy = getattr(graphite_config, "oxidation_enthalpy", None)
    if oxidation_enthalpy is None:
        missing.append("graphite_config.oxidation_enthalpy")
    T_abl = getattr(graphite_config, "ablation_surface_temperature", None)
    if T_abl is None:
        missing.append("graphite_config.ablation_surface_temperature")

    if missing:
        raise ValueError(
            "compute_graphite_recession: missing required inputs/config (strict mode, no defaults): "
            + ", ".join(missing)
        )

    # Now that inputs are validated, cast/clamp only for numerical safety (not physics defaults)
    gas_density = float(gas_density)
    gas_viscosity = float(gas_viscosity)
    oxygen_mass_fraction = float(oxygen_mass_fraction)
    characteristic_length = float(characteristic_length)
    gas_velocity = float(gas_velocity)
    heat_transfer_coefficient = float(heat_transfer_coefficient)
    emissivity = float(emissivity)
    T_env = float(T_env)
    f_fb_min = float(f_fb_min)
    f_fb_max = float(f_fb_max)
    pressure_exponent = float(pressure_exponent)
    mixture_mw = float(mixture_mw)
    stoichiometry_ratio = float(stoichiometry_ratio)
    oxidation_enthalpy = float(oxidation_enthalpy)
    T_abl = float(T_abl)
    T_back = float(backside_temperature)
    effective_thickness = float(effective_thickness)

    # minimal numeric safety guards (do not invent values)
    gas_density = max(gas_density, 1e-6)
    gas_viscosity = max(gas_viscosity, 1e-12)
    characteristic_length = max(characteristic_length, 1e-9)
    gas_velocity = max(gas_velocity, 1e-6)
    heat_transfer_coefficient = max(heat_transfer_coefficient, 1e-6)
    effective_thickness = max(effective_thickness, 1e-6)
    
    # Material properties
    rho_s = graphite_config.material_density  # kg/m³
    k_s = graphite_config.thermal_conductivity  # W/(m·K)
    cp_s = graphite_config.specific_heat  # J/(kg·K)
    # Backside temperature and conduction thickness are provided by caller in strict mode.
    
    # Oxidation kinetics parameters
    Ea = graphite_config.activation_energy  # J/mol
    T_ref = graphite_config.oxidation_reference_temperature  # K
    P_ref = graphite_config.oxidation_reference_pressure  # Pa
    
    # Diffusivity parameters
    D_ref = getattr(graphite_config, "reference_diffusivity", None) or 1e-4
    T_D_ref = getattr(graphite_config, "reference_diffusivity_temperature", 1500.0)
    P_D_ref = getattr(graphite_config, "reference_diffusivity_pressure", 1.0e6)
    
    # Reference mass flux at (T_ref, P_ref)
    # Convert recession rate to mass flux
    j_ref = graphite_config.oxidation_rate * rho_s  # kg/(m²·s) at reference conditions
    
    # Calculate Reynolds number once (flow property, independent of oxidation)
    Re = gas_density * gas_velocity * characteristic_length / gas_viscosity
    
    # Skin friction coefficient (used only for blowing parameter B_m)
    # WARNING: This is a rough heuristic. Throat Cf is complex due to pressure gradients.
    Cf_override = getattr(graphite_config, "friction_coefficient_override", None)
    if Cf_override is not None:
        Cf = Cf_override
    else:
        Cf = 0.026 * (Re ** -0.25)  # Turbulent pipe correlation fallback
        Cf = max(Cf, 0.001)  # Minimum
    
    # Initialize variables for return values
    Da = 0.0
    B_m = 0.0
    
    # Iterative solution for surface temperature
    T_s = throat_temperature  # Initial guess
    max_iter = 50
    tol = 1.0  # K - convergence tolerance
    damp = 0.5  # Damping factor for Newton step
    feedback_max_iter = 10  # Max iterations for feedback loop convergence
    feedback_tol = 1e-6  # Relative tolerance for feedback loop convergence
    
    for iter in range(max_iter):
        T_s_old = T_s
        
        # 1. CONVECTIVE HEAT FLUX: q''_in = h_g * (T_g - T_s)
        # Note: q_in can be negative if T_s > T_g (physically valid - wall cooling gas)
        q_in = heat_transfer_coefficient * (gas_temperature - T_s)
        
        # 2. RADIATIVE COOLING
        q_rad = emissivity * SIGMA * (T_s**4 - T_env**4)
        q_rad = max(q_rad, 0.0)
        
        # 3. OXIDATION KINETICS
        m_dot_ox = 0.0
        k_m_molar = 0.0
        X_O2 = 0.0
        p_O2 = 0.0
        
        if T_s > graphite_config.oxidation_temperature:
            # Convert oxygen mass fraction to mole fraction (with validation)
            # Preference: 1. Direct mole fraction config, 2. mass fraction conversion
            X_O2_cfg = getattr(graphite_config, "oxygen_mole_fraction", None)
            if X_O2_cfg is not None:
                X_O2 = float(X_O2_cfg)
            else:
                # Physics check: this conversion is only valid if mixture_mw and O2 fraction are consistent
                X_O2 = oxygen_mass_fraction * (mixture_mw / MW_O2)
            
            if X_O2 > 1.001:
                import warnings
                warnings.warn(f"Calculated O2 mole fraction {X_O2:.3f} > 1.0. Inputs (Y_O2={oxygen_mass_fraction:.3f}, MW_mix={mixture_mw:.4f}) may be inconsistent.")
            X_O2 = np.clip(X_O2, 0.0, 1.0)
            
            # Oxygen partial pressure
            p_O2 = X_O2 * pressure
            p_O2 = max(p_O2, 1.0)  # Minimum to avoid numerical issues
            
            # Kinetic-limited rate using reference mass flux
            # m''_ox,kin = j_ref * exp(-Ea/R * (1/T_s - 1/T_ref)) * (p_O2/P_ref)^n
            theta = np.exp(-Ea / R_GAS * (1.0 / T_s - 1.0 / T_ref))
            m_dot_ox_kin = j_ref * theta * (p_O2 / P_ref) ** pressure_exponent
            m_dot_ox_kin = max(m_dot_ox_kin, 0.0)
            
            # Diffusion-limited rate (molar basis)
            # Use film temperature for transport properties to keep Re, Sc, Sh, k_m, C_tot consistent
            T_film = 0.5 * (gas_temperature + T_s)
            
            # Estimate oxygen diffusivity: D_O2 ~ D_ref at (T_D_ref, P_D_ref), scales with T^1.5/P
            # WARNING: Binary diffusion in rocket exhaust is an approximation (OH/H2O also oxidize)
            D_O2 = D_ref * (T_film / T_D_ref) ** 1.5 * (P_D_ref / pressure)
            
            # Schmidt number: Sc = mu / (rho * D)
            Sc = gas_viscosity / (gas_density * D_O2)
            Sc = max(Sc, 0.1)  # Reasonable bounds
            
            # Sherwood number (combined laminar/turbulent)
            Sh_lam = 0.664 * (Re ** 0.5) * (Sc ** (1.0/3.0))
            Sh_turb = 0.023 * (Re ** 0.8) * (Sc ** (1.0/3.0))
            Sh = (Sh_lam**3 + Sh_turb**3) ** (1.0/3.0)
            Sh = max(Sh, 2.0)  # Low-Re floor (stagnant diffusion)
            
            # Molar mass transfer coefficient [m/s]
            k_m_molar = Sh * D_O2 / characteristic_length
            
            # Total molar concentration [mol/m³] - use film temperature
            C_tot = pressure / (R_GAS * T_film)
            C_tot = max(C_tot, 1.0)  # Minimum
            
            # Surface oxygen mole fraction (assume zero at surface due to reaction)
            X_O2_s = 0.0
            
            # Molar flux of O2 [mol/(m²·s)] - use driving force (X_O2 - X_O2_s)
            N_O2 = k_m_molar * (X_O2 - X_O2_s) * C_tot
            N_O2 = max(N_O2, 0.0)
            
            # Convert to carbon mass flux: m''_ox,diff = nu_C_per_O2 * MW_C * N_O2
            m_dot_ox_diff = stoichiometry_ratio * MW_C * N_O2  # kg/(m²·s)
            m_dot_ox_diff = max(m_dot_ox_diff, 0.0)
            
            # Oxidation rate is minimum of kinetic and diffusion limits
            m_dot_ox = min(m_dot_ox_kin, m_dot_ox_diff)
            m_dot_ox = max(m_dot_ox, 0.0)
        else:
            m_dot_ox = 0.0
        
        # 4. INITIALIZE FEEDBACK LOOP VARIABLES
        # The feedback loop couples: f_fb ↔ q_fb ↔ m_dot_th ↔ B_m ↔ f_fb
        # We need to iterate this until convergence within each T_s iteration
        f_fb = f_fb_min
        q_fb = 0.0
        m_dot_th = 0.0
        Da = 0.0
        B_m = 0.0
        
        # Calculate Damköhler number (practical definition: ratio of kinetic to diffusion limits)
        if m_dot_ox > 0 and T_s > graphite_config.oxidation_temperature:
            # Da = mass_flux_kinetic / mass_flux_diffusion
            # High Da (>1): Diffusion-limited (kinetics are fast)
            # Low Da (<1): Kinetic-limited (diffusion is fast)
            if m_dot_ox_diff > 1e-12:
                Da = m_dot_ox_kin / m_dot_ox_diff
            else:
                Da = 1e6  # Effectively diffusion-limited
            Da = max(Da, 1e-6)
        else:
            Da = 0.0
        
        # 5. CONDUCTION INTO SOLID (depends only on T_s)
        q_cond = k_s * (T_s - T_back) / max(effective_thickness, 0.001)
        
        # 6. ITERATE FEEDBACK LOOP: f_fb ↔ q_fb ↔ m_dot_th ↔ B_m ↔ Sh_corrected
        # This inner loop converges the coupling between feedback, blowing, and thermal ablation
        is_ablating = False
        H_star_th = graphite_config.heat_of_ablation
        T_trans_width = getattr(graphite_config, "ablation_transition_width", 200.0)
        
        # Save base Sherwood number (uncorrected)
        Sh_0 = Sh
        
        for fb_iter in range(feedback_max_iter):
            f_fb_old = f_fb
            m_dot_th_old = m_dot_th
            m_dot_ox_old = m_dot_ox
            
            # 6a. Calculate blowing parameter and blowing correction for mass transfer
            m_dot_tot = m_dot_ox + m_dot_th
            v_tau = gas_velocity * np.sqrt(Cf / 2.0)
            v_tau = max(v_tau, 1.0)
            B_m = m_dot_tot / (gas_density * v_tau)
            B_m = max(B_m, 0.0)
            
            # Blowing correction to mass transfer coefficient (thickens boundary layer)
            if B_m > 0.01:
                blowing_correction = np.log(1.0 + B_m) / B_m
            else:
                # Taylor expansion: ln(1+B)/B ≈ 1 - B/2 + B²/3...
                blowing_correction = 1.0 - 0.5 * B_m
            
            Sh = Sh_0 * blowing_correction
            k_m_molar = Sh * D_O2 / characteristic_length
            
            # 6b. Recalculate diffusion-limited oxidation with blowing correction
            N_O2 = k_m_molar * (X_O2 - 0.0) * C_tot
            m_dot_ox_diff = stoichiometry_ratio * MW_C * max(N_O2, 0.0)
            m_dot_ox = min(m_dot_ox_kin, m_dot_ox_diff)
            
            # 6c. Update feedback fraction and Damköhler
            if m_dot_ox > 0 and Da > 0:
                # Update Da with blowing-corrected diffusion limit
                if m_dot_ox_diff > 1e-12:
                    Da = m_dot_ox_kin / m_dot_ox_diff
                else:
                    Da = 1e6
                
                # f_fb is reduced by blowing and kinetic limitations
                f_fb = f_fb_min + (f_fb_max - f_fb_min) * (Da / (1.0 + Da)) * (1.0 / (1.0 + B_m))
                f_fb = float(np.clip(f_fb, f_fb_min, f_fb_max))
            else:
                f_fb = 0.0
            
            # Calculate feedback heat flux
            q_fb = f_fb * m_dot_ox * oxidation_enthalpy
            
            # ENERGY BALANCE: q''_in + q''_fb - q''_rad = q''_cond + m''_th * H*_th
            q_net_available = q_in + q_fb - q_rad - q_cond
            
            # 6d. THERMAL ABLATION LOGIC (with smooth transition)
            # ablation_onset_factor: 0.0 at low T, 1.0 at T_s >> T_abl
            if T_trans_width > 0:
                ablation_onset_factor = 1.0 / (1.0 + np.exp(-(T_s - T_abl) / (T_trans_width / 4.0)))
            else:
                ablation_onset_factor = 1.0 if T_s >= T_abl else 0.0
            
            if q_net_available > 0:
                # Pin surface temperature at ablation temperature if heavily ablating
                if ablation_onset_factor > 0.9 and not is_ablating:
                    is_ablating = True
                    T_s = T_abl
                    # Recalculate heat fluxes at pinned temperature
                    q_in = heat_transfer_coefficient * (gas_temperature - T_s)
                    q_rad = emissivity * SIGMA * (T_s**4 - T_env**4)
                    q_rad = max(q_rad, 0.0)
                    q_cond = k_s * (T_s - T_back) / max(effective_thickness, 0.001)
                    # Note: m_dot_ox and f_fb will be updated in next fb_iter
                    continue 

                # Calculate thermal ablation mass flux
                delta_T = max(T_s - 300.0, 0.0)
                H_star_th = graphite_config.heat_of_ablation + cp_s * delta_T
                H_star_th = max(H_star_th, 1e6)
                
                # Apply smooth onset factor
                m_dot_th = (q_net_available / H_star_th) * ablation_onset_factor
                m_dot_th = max(m_dot_th, 0.0)
            else:
                m_dot_th = 0.0
            
            # Check convergence of feedback loop
            if fb_iter > 0:
                f_fb_change = abs(f_fb - f_fb_old) / max(abs(f_fb_old), f_fb_min, 1e-10)
                m_dot_th_change = abs(m_dot_th - m_dot_th_old) / max(abs(m_dot_th_old), 1e-10)
                m_dot_ox_change = abs(m_dot_ox - m_dot_ox_old) / max(abs(m_dot_ox_old), 1e-10)
                if f_fb_change < feedback_tol and m_dot_th_change < feedback_tol and m_dot_ox_change < feedback_tol:
                    break
        
        # 9. ENERGY BALANCE RESIDUAL
        # If ablating, residual should be zero (T_s is pinned, m_dot_th balances energy)
        if is_ablating:
            residual = 0.0
        else:
            residual = q_in + q_fb - q_rad - q_cond - m_dot_th * H_star_th
        
        # 10. NEWTON-RAPHSON UPDATE FOR T_s
        # Skip Newton update if ablating (T_s is pinned)
        if iter > 0 and not is_ablating:
            # Derivatives for Newton step
            dq_in_dT = -heat_transfer_coefficient  # d/dT_s [h_g * (T_g - T_s)]
            dq_rad_dT = 4.0 * emissivity * SIGMA * T_s**3
            dq_cond_dT = k_s / max(effective_thickness, 0.001)
            
            # Derivative of oxidation feedback (simplified - assume f_fb and m_dot_ox change slowly)
            dq_fb_dT = 0.0
            if m_dot_ox > 0:
                # Simplified: d(m_dot_ox)/dT_s ~ m_dot_ox * (Ea / (R_GAS * T_s^2))
                dm_dot_ox_dT = m_dot_ox * (Ea / (R_GAS * T_s**2)) * 0.1  # Small factor for stability
                dq_fb_dT = f_fb * oxidation_enthalpy * dm_dot_ox_dT
            
            # Derivative of thermal ablation term
            dm_dot_th_dT = 0.0
            if m_dot_th > 0:
                # d(m_dot_th * H_star_th)/dT_s = m_dot_th * cp_s + (dm_dot_th/dT_s) * H_star_th
                # For stability, approximate dm_dot_th/dT_s as small
                dm_dot_th_dT = m_dot_th * cp_s * 0.1  # Small factor for stability
            
            # Total derivative
            dresidual_dT = dq_in_dT + dq_fb_dT - dq_rad_dT - dq_cond_dT - dm_dot_th_dT
            
            # Newton step with damping for stability
            if abs(dresidual_dT) > 1e-6:
                T_s = T_s - damp * residual / dresidual_dT
            else:
                # Fallback: simple bisection
                if residual > 0:
                    T_s = T_s + 10.0
                else:
                    T_s = T_s - 10.0
        
        # Bound surface temperature
        T_s = np.clip(T_s, 300.0, graphite_config.surface_temperature_limit)
        
        # Check convergence
        if abs(T_s - T_s_old) < tol:
            break
    
    # Final calculations with converged T_s
    # Recalculate with final T_s for consistency
    q_in = heat_transfer_coefficient * (gas_temperature - T_s)
    q_rad = emissivity * SIGMA * (T_s**4 - T_env**4)
    q_rad = max(q_rad, 0.0)
    
    # Recalculate oxidation with final T_s
    m_dot_ox = 0.0
    m_dot_ox_kin = 0.0
    m_dot_ox_diff = 0.0
    X_O2 = 0.0
    p_O2 = 0.0
    k_m_molar = 0.0
    C_tot = 0.0
    
    if T_s > graphite_config.oxidation_temperature:
        X_O2_cfg = getattr(graphite_config, "oxygen_mole_fraction", None)
        if X_O2_cfg is not None:
            X_O2 = float(X_O2_cfg)
        else:
            X_O2 = oxygen_mass_fraction * (mixture_mw / MW_O2)
        X_O2 = np.clip(X_O2, 0.0, 1.0)
        p_O2 = X_O2 * pressure
        p_O2 = max(p_O2, 1.0)
        
        theta = np.exp(-Ea / R_GAS * (1.0 / T_s - 1.0 / T_ref))
        m_dot_ox_kin = j_ref * theta * (p_O2 / P_ref) ** pressure_exponent
        m_dot_ox_kin = max(m_dot_ox_kin, 0.0)
        
        # Use film temperature for transport properties
        T_film = 0.5 * (gas_temperature + T_s)
        D_O2 = D_ref * (T_film / T_D_ref) ** 1.5 * (P_D_ref / pressure)
        Sc = gas_viscosity / (gas_density * D_O2)
        Sc = max(Sc, 0.1)
        
        # Sherwood number (combined laminar/turbulent)
        Sh_lam = 0.664 * (Re ** 0.5) * (Sc ** (1.0/3.0))
        Sh_turb = 0.023 * (Re ** 0.8) * (Sc ** (1.0/3.0))
        Sh_0 = (Sh_lam**3 + Sh_turb**3) ** (1.0/3.0)
        Sh_0 = max(Sh_0, 2.0)
        
        k_m_molar_0 = Sh_0 * D_O2 / characteristic_length
        C_tot = pressure / (R_GAS * T_film)
        C_tot = max(C_tot, 1.0)
        
        # Surface oxygen mole fraction (assume zero at surface due to reaction)
        X_O2_s = 0.0
        
        # Initial estimate for m_dot_ox_diff
        N_O2 = k_m_molar_0 * (X_O2 - X_O2_s) * C_tot
        m_dot_ox_diff = stoichiometry_ratio * MW_C * max(N_O2, 0.0)
        m_dot_ox = min(m_dot_ox_kin, m_dot_ox_diff)
    
    # Recalculate feedback fraction and thermal ablation with converged T_s
    # Use same feedback loop logic for consistency
    f_fb = f_fb_min
    q_fb = 0.0
    m_dot_th = 0.0
    Da = 0.0
    B_m = 0.0
    q_cond = k_s * (T_s - T_back) / max(effective_thickness, 0.001)
    
    # Final feedback loop iteration (should converge quickly since T_s is converged)
    H_star_th = graphite_config.heat_of_ablation
    T_trans_width = getattr(graphite_config, "ablation_transition_width", 200.0)
    
    for fb_iter in range(feedback_max_iter):
        f_fb_old = f_fb
        m_dot_th_old = m_dot_th
        m_dot_ox_old = m_dot_ox
        
        # Calculate blowing parameter and blowing correction for mass transfer
        m_dot_tot = m_dot_ox + m_dot_th
        v_tau = gas_velocity * np.sqrt(Cf / 2.0)
        v_tau = max(v_tau, 1.0)
        B_m = m_dot_tot / (gas_density * v_tau)
        B_m = max(B_m, 0.0)
        
        # Blowing correction
        if B_m > 0.01:
            blowing_correction = np.log(1.0 + B_m) / B_m
        else:
            blowing_correction = 1.0 - 0.5 * B_m
            
        Sh = Sh_0 * blowing_correction
        k_m_molar = Sh * D_O2 / characteristic_length
        
        # Recalculate diffusion-limited oxidation
        N_O2 = k_m_molar * (X_O2 - 0.0) * C_tot
        m_dot_ox_diff = stoichiometry_ratio * MW_C * max(N_O2, 0.0)
        m_dot_ox = min(m_dot_ox_kin, m_dot_ox_diff)
        
        # Update Da with blowing-corrected diffusion limit
        if m_dot_ox_diff > 1e-12:
            Da = m_dot_ox_kin / m_dot_ox_diff
        else:
            Da = 1e6
        
        if m_dot_ox > 0 and Da > 0:
            f_fb = f_fb_min + (f_fb_max - f_fb_min) * (Da / (1.0 + Da)) * (1.0 / (1.0 + B_m))
            f_fb = float(np.clip(f_fb, f_fb_min, f_fb_max))
        else:
            f_fb = 0.0
            B_m = 0.0
        
        q_fb = f_fb * m_dot_ox * oxidation_enthalpy
        q_net_available = q_in + q_fb - q_rad - q_cond
        
        # Thermal ablation with smooth transition
        if T_trans_width > 0:
            ablation_onset_factor = 1.0 / (1.0 + np.exp(-(T_s - T_abl) / (T_trans_width / 4.0)))
        else:
            ablation_onset_factor = 1.0 if T_s >= T_abl else 0.0
            
        if q_net_available > 0:
            delta_T = max(T_s - 300.0, 0.0)
            H_star_th = graphite_config.heat_of_ablation + cp_s * delta_T
            H_star_th = max(H_star_th, 1e6)
            m_dot_th = (q_net_available / H_star_th) * ablation_onset_factor
            m_dot_th = max(m_dot_th, 0.0)
        else:
            m_dot_th = 0.0
        
        # Check convergence
        if fb_iter > 0:
            f_fb_change = abs(f_fb - f_fb_old) / max(abs(f_fb_old), f_fb_min, 1e-10)
            m_dot_th_change = abs(m_dot_th - m_dot_th_old) / max(abs(m_dot_th_old), 1e-10)
            m_dot_ox_change = abs(m_dot_ox - m_dot_ox_old) / max(abs(m_dot_ox_old), 1e-10)
            if f_fb_change < feedback_tol and m_dot_th_change < feedback_tol and m_dot_ox_change < feedback_tol:
                break
    
    # TOTAL RECESSION RATE
    recession_rate_ox = m_dot_ox / rho_s
    recession_rate_th = m_dot_th / rho_s
    recession_rate_total_phys = recession_rate_ox + recession_rate_th
    
    # If sizing_only_mode is enabled, suppress the reported recession rate
    recession_rate_report = 0.0 if sizing_only_mode else recession_rate_total_phys
    
    # Total mass flux
    mass_flux_phys = m_dot_ox + m_dot_th
    mass_flux_report = 0.0 if sizing_only_mode else mass_flux_phys
    
    # Heat removed - ONLY count feedback fraction and thermal ablation
    # Do NOT count full oxidation enthalpy as "heat removed from solid"
    heat_removed_ablation = (q_fb + m_dot_th * graphite_config.heat_of_ablation) * throat_area * graphite_config.coverage_fraction
    heat_removed_conduction = q_cond * throat_area * graphite_config.coverage_fraction
    heat_removed_total = heat_removed_ablation + heat_removed_conduction
    
    return {
        "enabled": True,
        "recession_rate": float(recession_rate_report),
        "recession_rate_calculated": float(recession_rate_total_phys),
        "mass_flux": float(mass_flux_report),
        "mass_flux_calculated": float(mass_flux_phys),
        "surface_temperature": float(T_s),
        "effective_heat_flux": float(q_net_available),
        "radiative_relief": float(q_rad),
        "conduction_loss": float(q_cond),
        "heat_removed": float(heat_removed_total),
        "oxidation_rate": float(recession_rate_ox),
        "oxidation_mass_flux": float(m_dot_ox),
        "thermal_mass_flux": float(m_dot_th),
        "recession_rate_thermal": float(recession_rate_th),
        "mass_flux_thermal": float(m_dot_th),
        "coverage_area": float(throat_area * graphite_config.coverage_fraction),
        "feedback_fraction": float(f_fb),
        "q_feedback": float(q_fb),
        "q_radiation": float(q_rad),
        "q_conduction": float(q_cond),
        "q_convective": float(q_in),
        "damkohler_number": float(Da),
        "blowing_parameter": float(B_m),
        "sizing_only_mode": sizing_only_mode,
    }

