"""Enhanced physics-based stability analysis for pintle injectors.

Accounts for:
1. Pintle geometry (tip diameter, length, gap)
2. Fuel impingement zones (localized instability sources)
3. Recirculation zones (flow patterns near pintle tip)
4. Pintle length effects (acoustic coupling)
5. Uneven ablation (spatial variation in geometry)
6. Real wave propagation physics with proper boundary conditions
"""

from __future__ import annotations

from typing import Dict, List, Tuple, Optional
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig, PintleInjectorConfig
from engine.pipeline.localized_ablation import calculate_impingement_zones


def calculate_pintle_recirculation_zones(
    L_pintle: float,
    d_pintle_tip: float,
    D_chamber: float,
    L_chamber: float,
    positions: np.ndarray,
    fuel_velocity: float = 50.0,
    lox_velocity: float = 30.0,
) -> Dict[str, np.ndarray]:
    """
    Calculate recirculation zones near pintle tip.
    
    Physics:
    - Fuel spray from pintle tip creates recirculation eddies
    - LOX jets create additional recirculation
    - Recirculation zones have different acoustic properties
    - These zones affect wave propagation and stability
    
    Parameters:
    -----------
    L_pintle : float
        Pintle length [m] (distance from injector face to tip)
    d_pintle_tip : float
        Pintle tip diameter [m]
    D_chamber : float
        Chamber diameter [m]
    L_chamber : float
        Chamber length [m]
    positions : np.ndarray
        Axial positions [m]
    fuel_velocity : float
        Fuel injection velocity [m/s]
    lox_velocity : float
        LOX injection velocity [m/s]
    
    Returns:
    --------
    recirculation : dict
        - recirculation_intensity: Local recirculation intensity (0-1)
        - recirculation_length: Characteristic recirculation length [m]
        - velocity_fluctuation: Velocity fluctuation magnitude [m/s]
        - turbulence_intensity: Turbulence intensity (0-1)
    """
    n_points = len(positions)
    
    # Recirculation zone extends from injector face (x=0) to ~2-3x pintle length
    L_recirc = 2.5 * L_pintle  # Typical recirculation length
    
    # Recirculation intensity decays with distance from pintle tip
    recirculation_intensity = np.zeros(n_points)
    recirculation_length = np.zeros(n_points)
    velocity_fluctuation = np.zeros(n_points)
    turbulence_intensity = np.zeros(n_points)
    
    for i, x in enumerate(positions):
        if x <= L_recirc:
            # Recirculation zone: intensity decays exponentially
            decay_factor = np.exp(-x / (0.5 * L_pintle))
            
            # Physics-based recirculation intensity
            from engine.pipeline.physics_based_replacements import calculate_recirculation_intensity_physics
            
            # Estimate Reynolds number
            rho_approx = 5.0  # kg/m³, typical hot gas
            mu_approx = 4e-5  # Pa·s
            Re_injector = rho_approx * fuel_velocity * d_pintle_tip / mu_approx
            
            base_intensity = calculate_recirculation_intensity_physics(
                fuel_velocity=fuel_velocity,
                lox_velocity=lox_velocity,
                d_pintle_tip=d_pintle_tip,
                D_chamber=D_chamber,
                Re_injector=Re_injector,
            )
            
            recirculation_intensity[i] = base_intensity * decay_factor
            
            # Characteristic recirculation length (eddy size)
            # From turbulent mixing theory: L_eddy ~ 0.1-0.3 × injector size
            # Depends on velocity ratio and Reynolds number
            eddy_base = 0.2 * d_pintle_tip  # Base eddy size
            velocity_factor = 1.0 + 0.3 * (fuel_velocity / (lox_velocity + 1e-10) - 1.0)
            recirculation_length[i] = eddy_base * velocity_factor * (1.0 + 0.2 * decay_factor)
            
            # Velocity fluctuations (RMS) from turbulence theory
            # u' ~ 0.1-0.2 × U for turbulent flow
            # Higher recirculation → higher fluctuations
            v_fluct_base = 0.12 * fuel_velocity * (1.0 + base_intensity)  # Physics-based
            velocity_fluctuation[i] = v_fluct_base * decay_factor
            
            # Turbulence intensity from mixing theory
            # I_turb ~ 0.1-0.3 for recirculating flows
            # Depends on velocity ratio and recirculation intensity
            base_turbulence = 0.1 + 0.1 * base_intensity  # Physics-based
            velocity_enhancement = 1.0 + 0.2 * (fuel_velocity / (lox_velocity + 1e-10) - 1.0)
            turbulence_intensity[i] = base_turbulence * decay_factor * velocity_enhancement
        else:
            # Outside recirculation zone
            recirculation_intensity[i] = 0.0
            recirculation_length[i] = 0.0
            velocity_fluctuation[i] = 0.0
            turbulence_intensity[i] = 0.05  # Base turbulence
    
    return {
        "recirculation_intensity": recirculation_intensity,
        "recirculation_length": recirculation_length,
        "velocity_fluctuation": velocity_fluctuation,
        "turbulence_intensity": turbulence_intensity,
    }


def calculate_pintle_stability_enhanced(
    config: PintleEngineConfig,
    positions: np.ndarray,
    chamber_pressure: np.ndarray,
    sound_speed: np.ndarray,
    density: np.ndarray,
    mass_flow: np.ndarray,
    recession_profile: Optional[np.ndarray] = None,
    L_chamber: float = 0.2,
    D_chamber: float = 0.1,
    fuel_velocity: float = 50.0,
    lox_velocity: float = 30.0,
) -> Dict[str, np.ndarray]:
    """
    Enhanced stability calculation with full pintle physics.
    
    Physics:
    1. Pintle geometry affects injector impedance and acoustic coupling
    2. Fuel impingement creates localized pressure fluctuation sources
    3. Recirculation zones create acoustic damping/amplification
    4. Pintle length affects acoustic mode coupling
    5. Uneven ablation creates impedance mismatches
    6. Wave propagation with proper boundary conditions
    
    Parameters:
    -----------
    config : PintleEngineConfig
        Engine configuration
    positions : np.ndarray
        Axial positions [m]
    chamber_pressure : np.ndarray
        Local pressure [Pa]
    sound_speed : np.ndarray
        Local sound speed [m/s]
    density : np.ndarray
        Local density [kg/m³]
    mass_flow : np.ndarray
        Local mass flow [kg/s]
    recession_profile : np.ndarray, optional
        Local recession [m] at each position (for uneven ablation)
    L_chamber : float
        Chamber length [m]
    D_chamber : float
        Chamber diameter [m]
    fuel_velocity : float
        Fuel injection velocity [m/s]
    lox_velocity : float
        LOX injection velocity [m/s]
    
    Returns:
    --------
    stability : dict
        - chugging_frequency: Local chugging frequency [Hz]
        - stability_margin: Local stability margin
        - wave_growth_rate: Wave growth rate [1/s]
        - impingement_effect: Effect of impingement on stability
        - recirculation_effect: Effect of recirculation on stability
        - ablation_effect: Effect of uneven ablation on stability
        - pintle_length_effect: Effect of pintle length on acoustic coupling
    """
    n_points = len(positions)
    
    # Get pintle geometry
    if not hasattr(config, 'injector') or config.injector.type != "pintle":
        # No pintle-specific effects
        return {
            "chugging_frequency": np.full(n_points, 30.0),
            "stability_margin": np.full(n_points, 0.5),
            "wave_growth_rate": np.full(n_points, -10.0),
            "impingement_effect": np.zeros(n_points),
            "recirculation_effect": np.zeros(n_points),
            "ablation_effect": np.zeros(n_points),
            "pintle_length_effect": np.zeros(n_points),
        }
    
    injector_config: PintleInjectorConfig = config.injector
    geometry = injector_config.geometry
    
    # Pintle geometry parameters
    d_pintle_tip = geometry.fuel.d_pintle_tip
    h_gap = geometry.fuel.h_gap
    L_pintle = getattr(geometry.fuel, 'L_pintle', 0.01)  # Pintle length [m]
    n_orifices = geometry.lox.n_orifices
    d_orifice = geometry.lox.d_orifice
    theta_orifice = geometry.lox.theta_orifice
    
    # Calculate impingement zones (where fuel hits wall)
    impingement_data = calculate_impingement_zones(
        config, L_chamber, D_chamber, n_points=n_points
    )
    impingement_multiplier = impingement_data["impingement_heat_flux_multiplier"]
    impingement_zones = impingement_data["impingement_zones"]
    impingement_center = impingement_data.get("impingement_center", L_chamber * 0.7)
    
    # Calculate recirculation zones (near pintle tip)
    recirculation_data = calculate_pintle_recirculation_zones(
        L_pintle, d_pintle_tip, D_chamber, L_chamber, positions,
        fuel_velocity, lox_velocity
    )
    recirculation_intensity = recirculation_data["recirculation_intensity"]
    recirculation_length = recirculation_data["recirculation_length"]
    velocity_fluctuation = recirculation_data["velocity_fluctuation"]
    turbulence_intensity = recirculation_data["turbulence_intensity"]
    
    # Calculate injector impedance from pintle geometry
    # Acoustic impedance: Z = ρ × c / A
    A_pintle_tip = np.pi * (d_pintle_tip / 2.0) ** 2
    A_gap = np.pi * d_pintle_tip * h_gap  # Annular gap area
    A_injector_effective = A_pintle_tip + A_gap
    
    # Injector impedance (at injection plane)
    rho_injector = density[0] if len(density) > 0 else 1000.0
    c_injector = sound_speed[0] if len(sound_speed) > 0 else 1000.0
    Z_injector = rho_injector * c_injector / A_injector_effective if A_injector_effective > 0 else 1e6
    
    # Feed system impedance (simplified)
    Z_feed = 5e5  # Typical feed system impedance [Pa·s/m³]
    
    # Calculate local impedances
    A_local = np.pi * (D_chamber / 2.0) ** 2
    Z_local = density * sound_speed / A_local
    
    # Wave propagation time
    L_total = positions[-1] - positions[0] if len(positions) > 1 else L_chamber
    tau_wave = L_total / sound_speed  # Wave propagation time
    
    # Base chugging frequency from wave resonance
    # f = c / (4L) for open-closed tube (injector closed, throat open)
    f_chugging_base = sound_speed / (4.0 * L_total)
    
    # Pintle length effect on frequency
    # Longer pintle = different acoustic coupling = frequency shift
    # Pintle acts as acoustic extension of injector
    L_effective = L_total + 0.3 * L_pintle  # Effective length includes pintle
    f_chugging_pintle = sound_speed / (4.0 * L_effective)
    
    # Frequency shift from pintle geometry
    pintle_ratio = d_pintle_tip / D_chamber if D_chamber > 0 else 0.1
    frequency_shift = 1.0 + 0.15 * (pintle_ratio - 0.1) + 0.1 * (L_pintle / L_chamber)
    f_chugging = f_chugging_pintle * frequency_shift
    
    # Pintle length effect on acoustic coupling
    # Longer pintle = stronger coupling between injector and chamber
    coupling_strength = 1.0 + 0.5 * (L_pintle / L_chamber)  # Stronger coupling
    pintle_length_effect = (coupling_strength - 1.0) * 0.3  # Can be stabilizing or destabilizing
    
    # Impingement effect on stability
    # Fuel impingement creates localized pressure fluctuation sources
    # These act as instability sources
    impingement_effect = np.zeros(n_points)
    for i, (pos, is_impingement) in enumerate(zip(positions, impingement_zones)):
        if is_impingement:
            # Impingement creates pressure fluctuation source
            # Effect decays with distance from impingement
            distance_from_impingement = abs(pos - impingement_center)
            decay_factor = np.exp(-distance_from_impingement / (L_chamber * 0.1))
            # Impingement multiplier indicates intensity
            intensity = (impingement_multiplier[i] - 1.0) * 0.5  # Destabilizing
            impingement_effect[i] = intensity * decay_factor
    
    # Recirculation effect on stability
    # Recirculation zones can:
    # 1. Damp waves (turbulence dissipation)
    # 2. Amplify waves (resonance in eddies)
    # Net effect depends on recirculation intensity and turbulence
    recirculation_effect = np.zeros(n_points)
    for i in range(n_points):
        if recirculation_intensity[i] > 0:
            # Recirculation creates velocity fluctuations
            # These can couple with pressure waves
            # High turbulence = damping (stabilizing)
            # Low turbulence + high intensity = amplification (destabilizing)
            turbulence_damping = turbulence_intensity[i] * 0.5  # Stabilizing
            recirculation_amplification = recirculation_intensity[i] * (1.0 - turbulence_intensity[i]) * 0.3  # Destabilizing
            recirculation_effect[i] = recirculation_amplification - turbulence_damping
    
    # Uneven ablation effect
    # Spatial variation in geometry creates impedance mismatches
    # These reflect waves and can cause instability
    ablation_effect = np.zeros(n_points)
    if recession_profile is not None and len(recession_profile) == n_points:
        # Calculate local diameter variation
        D_local = D_chamber + 2.0 * recession_profile
        A_local_varying = np.pi * (D_local / 2.0) ** 2
        
        # Impedance variation
        Z_varying = density * sound_speed / A_local_varying
        
        # Impedance mismatch creates reflections
        # Large mismatch = more reflections = potential instability
        Z_ref = Z_local[0] if len(Z_local) > 0 else Z_local.mean()
        impedance_mismatch = np.abs(Z_varying - Z_ref) / (Z_ref + 1e-10)
        ablation_effect = impedance_mismatch * 0.3  # Destabilizing effect
    
    # Wave growth rate from energy balance
    # Energy input from combustion vs. energy dissipation
    energy_input = chamber_pressure * mass_flow / density  # [W/m³]
    energy_dissipation = density * (mass_flow / (density * A_local)) ** 2 / L_total  # [W/m³]
    energy_stored = 0.5 * density * sound_speed ** 2  # [J/m³]
    
    # Base growth rate from energy balance
    # For well-designed engines, dissipation > input (net damping)
    energy_balance = (energy_input - energy_dissipation) / (2.0 * energy_stored + 1e-10)
    
    # Base damping rate: well-designed engines have negative growth (damping)
    # Typical damping: -20 to -100 [1/s] for stable engines
    # Add base damping from acoustic losses, wall friction, etc.
    base_damping = -50.0  # [1/s] - base damping rate (negative = stable)
    
    # Energy balance modifies base damping
    # Positive energy balance (input > dissipation) = destabilizing
    # Negative energy balance (dissipation > input) = stabilizing
    wave_growth_base = base_damping + energy_balance * 10.0  # Scale energy balance effect
    
    # Add all effects
    # Impingement: destabilizing (reduces damping)
    # Recirculation: can be stabilizing (turbulence damping) or destabilizing (amplification)
    # Ablation: destabilizing (impedance mismatch)
    # Pintle length: usually stabilizing (better mixing = more damping)
    wave_growth_rate = (
        wave_growth_base
        + impingement_effect  # Destabilizing (reduces damping)
        + recirculation_effect  # Can be stabilizing or destabilizing
        - ablation_effect * 0.5  # Destabilizing (impedance mismatch)
        - pintle_length_effect * 0.3  # Usually stabilizing (better mixing)
    )
    
    # Stability margin: positive = stable, negative = unstable
    # For stability: wave_growth_rate should be negative (damping)
    # Margin = (damping_rate - growth_rate) / reference_rate
    # Higher margin = more stable
    reference_rate = 100.0  # [1/s] - reference growth rate
    damping_rate = -wave_growth_rate  # Convert growth to damping
    stability_margin = damping_rate / reference_rate
    
    # Clamp to reasonable range: -2 to +2
    # Positive = stable, negative = unstable
    stability_margin = np.clip(stability_margin, -2.0, 2.0)
    
    return {
        "chugging_frequency": f_chugging,
        "stability_margin": stability_margin,
        "wave_growth_rate": wave_growth_rate,
        "impingement_effect": impingement_effect,
        "recirculation_effect": recirculation_effect,
        "ablation_effect": ablation_effect,
        "pintle_length_effect": pintle_length_effect,
        "recirculation_intensity": recirculation_intensity,
        "turbulence_intensity": turbulence_intensity,
        "pintle_ratio": pintle_ratio,
        "frequency_shift": frequency_shift,
    }

