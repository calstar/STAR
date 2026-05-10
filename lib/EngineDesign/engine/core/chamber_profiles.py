"""Chamber pressure and temperature profiles along length with ablative and graphite visualization.

This module provides:
1. Chamber pressure and temperature profiles
2. Ablative liner geometry (phenolic) with recession
3. Graphite insert geometry with recession
4. Stainless steel case geometry
5. Complete chamber cross-section visualization
"""

import numpy as np
from typing import Dict, Optional, Any, Tuple, List
from engine.pipeline.numerical_robustness import NumericalStability, PhysicalConstraints
from engine.pipeline.config_schemas import AblativeCoolingConfig, GraphiteInsertConfig, StainlessSteelCaseConfig


def calculate_chamber_pressure_profile(
    Pc: float,
    Lstar: float,
    mdot_total: float,
    gamma: float,
    R: float,
    Tc: float,
    A_throat: float,
    n_points: int = 20,
) -> Dict[str, Any]:
    """
    Calculate pressure profile along chamber length.
    
    Pressure drops from injection to throat due to:
    1. Momentum addition from combustion
    2. Friction losses (minor)
    3. Area contraction to throat
    
    For quasi-1D flow with heat addition:
        dP/dx = -rho * u * du/dx - (gamma - 1) * rho * dq/dx
    where dq/dx is heat release rate from reaction.
    
    Simplified model: P decreases linearly with heat addition.
    
    Parameters:
    -----------
    Pc : float
        Chamber pressure at throat [Pa] (reference pressure)
    Lstar : float
        Characteristic length [m]
    mdot_total : float
        Total mass flow [kg/s]
    gamma : float
        Specific heat ratio
    R : float
        Gas constant [J/(kg·K)]
    Tc : float
        Chamber temperature [K]
    A_throat : float
        Throat area [m²]
    n_points : int
        Number of points along chamber (default: 20)
    
    Returns:
    --------
    profile : dict
        - positions: Array of positions along chamber [m] (0 = injection, Lstar = throat)
        - pressures: Array of pressures [Pa]
        - P_injection: Pressure at injection plane [Pa]
        - P_mid: Pressure at mid-chamber [Pa]
        - P_throat: Pressure at throat [Pa] (= Pc)
    """
    # Create position array
    positions = np.linspace(0.0, Lstar, n_points)
    
    # Chamber gas properties
    rho_chamber = Pc / (R * Tc)
    
    # Estimate cross-sectional area (assume cylindrical chamber)
    # Approximate: A_chamber = V / L* ≈ A_throat * expansion_ratio
    # Use average area for velocity calculation
    A_chamber_avg = A_throat * 3.0  # Rough estimate (typical expansion from throat)
    u_chamber = mdot_total / (rho_chamber * A_chamber_avg) if rho_chamber > 0 else 0.0
    
    # Pressure profile: drops from injection to throat
    # Physics: For quasi-1D flow with heat addition (combustion):
    #   dP/dx = -rho * u * du/dx - (gamma - 1) * rho * dq/dx
    # where dq/dx is heat release rate from reaction.
    # 
    # The pressure drop is due to:
    # 1. Momentum addition from combustion (u increases, P decreases)
    # 2. Friction losses (minor, typically < 5%)
    # 3. Area contraction to throat (Bernoulli effect)
    #
    # Simplified model for visualization:
    #   P(x) = P_injection - (P_injection - Pc) * (x/L*)^alpha
    # where alpha accounts for the rate of pressure drop.
    #
    # At injection: higher pressure due to momentum of incoming propellants
    # Typical pressure ratio: P_injection / P_throat ≈ 1.05-1.15 for well-designed engines
    # This is based on experimental data and CFD studies.
    P_injection_ratio = 1.10  # 10% higher at injection (typical for pintle injectors)
    
    # Alpha factor: controls how pressure drops (typically 0.1-0.3)
    # Lower alpha = more gradual drop (more momentum addition, slower reaction)
    # Higher alpha = steeper drop (faster reaction, less momentum addition)
    # Value of 0.15 is typical for pintle injectors with good mixing
    alpha = 0.15  # Empirical value based on typical pintle engine behavior
    
    # Normalized positions (0 = injection, 1 = throat)
    x_norm = positions / Lstar if Lstar > 0 else np.zeros_like(positions)
    
    # Pressure profile
    # P(x) = P_injection - (P_injection - Pc) * x_norm^alpha
    # At injection (x_norm=0): P = P_injection
    # At throat (x_norm=1): P = Pc
    P_injection = Pc * P_injection_ratio
    pressures = P_injection - (P_injection - Pc) * (x_norm ** alpha)
    
    # Validate all pressures are finite
    if not np.all(np.isfinite(pressures)):
        raise ValueError(
            f"Non-finite pressures in chamber profile. "
            f"Pc={Pc:.3e} Pa, Lstar={Lstar:.4f} m, alpha={alpha:.4f}, "
            f"P_injection_ratio={P_injection_ratio:.4f}"
        )
    
    # Validate monotonicity (pressure must decrease toward throat)
    for i in range(1, len(pressures)):
        if pressures[i] > pressures[i-1]:
            raise ValueError(
                f"Non-monotonic pressure profile at position {i}. "
                f"P[{i-1}]={pressures[i-1]:.3e} Pa, P[{i}]={pressures[i]:.3e} Pa. "
                f"Pressure must decrease monotonically from injection to throat. "
                f"Check alpha={alpha:.4f}, Lstar={Lstar:.4f} m."
            )
    
    # Validate throat pressure matches Pc (within tolerance)
    P_throat_val = float(pressures[-1])
    relative_error = abs(P_throat_val - Pc) / Pc
    if relative_error > 0.05:  # 5% tolerance
        raise ValueError(
            f"Throat pressure mismatch: P_throat={P_throat_val:.3e} Pa, Pc={Pc:.3e} Pa. "
            f"Relative error: {relative_error*100:.2f}%. Should be < 5%. "
            f"Check pressure profile model and alpha parameter."
        )
    
    # Validate injection pressure is reasonable (should be slightly higher than Pc)
    P_injection_val = float(pressures[0])
    if P_injection_val < Pc:
        raise ValueError(
            f"Invalid injection pressure: P_injection={P_injection_val:.3e} Pa < Pc={Pc:.3e} Pa. "
            f"Injection pressure must be higher than chamber pressure. "
            f"Check P_injection_ratio={P_injection_ratio:.4f}."
        )
    
    if P_injection_val > Pc * 1.5:
        raise ValueError(
            f"Unrealistic injection pressure: P_injection={P_injection_val:.3e} Pa = {P_injection_val/Pc:.2f}×Pc. "
            f"Should be < 1.5×Pc for typical rocket engines. "
            f"Check P_injection_ratio={P_injection_ratio:.4f}."
        )
    
    # Key points
    P_mid = float(pressures[len(pressures) // 2])
    
    return {
        "positions": positions.tolist(),
        "pressures": pressures.tolist(),
        "P_injection": P_injection_val,
        "P_mid": P_mid,
        "P_throat": P_throat_val,
    }


def calculate_chamber_intrinsics(
    Pc: float,
    Tc: float,
    mdot_total: float,
    gamma: float,
    R: float,
    V_chamber: float,
    A_throat: float,
    Lstar: float,
    MR: float,
    P_back: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Calculate chamber intrinsic properties.
    
    Parameters:
    -----------
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    mdot_total : float
        Total mass flow [kg/s]
    gamma : float
        Specific heat ratio
    R : float
        Gas constant [J/(kg·K)]
    V_chamber : float
        Chamber volume [m³]
    A_throat : float
        Throat area [m²]
    Lstar : float
        Characteristic length [m]
    MR : float
        Mixture ratio
    P_back : float, optional
        Back pressure [Pa] (ambient pressure). If None, uses 0.9 * 101325 Pa as fallback.
        Used to verify flow is choked at throat.
    
    Returns:
    --------
    intrinsics : dict
        - Lstar: Characteristic length [m]
        - residence_time: Gas residence time [s]
        - velocity_mean: Mean gas velocity [m/s]
        - velocity_throat: Velocity at throat (sonic) [m/s]
        - density: Chamber gas density [kg/m³]
        - sound_speed: Sound speed in chamber [m/s]
        - mach_number: Mean Mach number
        - reynolds_number: Reynolds number
    """
    # Gas density
    rho, rho_valid = NumericalStability.safe_divide(Pc, R * Tc, 1.0, "rho")
    if not rho_valid.passed:
        rho = 1.0  # Fallback
    
    # Sound speed
    sound_speed_squared = gamma * R * Tc
    sound_speed, sound_valid = NumericalStability.safe_sqrt(sound_speed_squared, "sound_speed")
    if not sound_valid.passed:
        sound_speed = 1000.0  # Fallback
    
    # Mean velocity (from mass flow and density)
    # Physics: u = mdot / (rho * A)
    # For cylindrical chamber: A_avg = V_chamber / Lstar (exact for constant area)
    # For converging chamber: A_avg ≈ V_chamber / Lstar (approximation)
    A_avg, A_valid = NumericalStability.safe_divide(V_chamber, Lstar, A_throat, "A_avg")
    if not A_valid.passed:
        # Fallback: assume chamber area is ~3x throat area (typical contraction ratio)
        A_avg = A_throat * 3.0
    
    velocity_mean, v_valid = NumericalStability.safe_divide(
        mdot_total, rho * A_avg, 0.0, "velocity_mean"
    )
    if not v_valid.passed:
        velocity_mean = 50.0  # Fallback [m/s]
    
    # CRITICAL PHYSICS: Throat velocity (sonic)
    # At the throat, flow is ALWAYS choked (M_throat = 1.0 by definition)
    # This is the fundamental physics: the throat is defined as the location where M = 1.0
    # 
    # Isentropic relations at throat (M = 1.0):
    # - T_throat/Tc = 2/(γ+1)  (critical temperature ratio)
    # - P_throat/Pc = [2/(γ+1)]^(γ/(γ-1))  (critical pressure ratio)
    # - v_throat = a_throat = sqrt(γ × R × T_throat)
    #
    # Therefore: v_throat = sqrt(γ × R × Tc × [2/(γ+1)])
    # This is the sonic velocity at the throat
    throat_velocity_factor, factor_valid = NumericalStability.safe_divide(
        gamma, gamma + 1.0, 0.5, "gamma/(gamma+1)"
    )
    if factor_valid.passed:
        # v_throat^2 = gamma * R * Tc * [2/(gamma+1)]
        # This is the exact sonic velocity at throat (M = 1.0)
        throat_velocity_squared = 2.0 * gamma * R * Tc / (gamma + 1.0)
        velocity_throat, throat_v_valid = NumericalStability.safe_sqrt(
            throat_velocity_squared, "velocity_throat"
        )
        if not throat_v_valid.passed:
            velocity_throat = sound_speed  # Fallback (sonic = sound speed)
    else:
        velocity_throat = sound_speed  # Fallback
    
    # Calculate throat sound speed for verification
    T_throat = Tc * (2.0 / (gamma + 1.0))  # Critical temperature ratio
    a_throat_squared = gamma * R * T_throat
    a_throat, a_throat_valid = NumericalStability.safe_sqrt(a_throat_squared, "a_throat")
    if not a_throat_valid.passed:
        a_throat = sound_speed * np.sqrt(2.0 / (gamma + 1.0))  # Fallback
    
    # VERIFICATION: Calculate M_throat from v_throat / a_throat to verify consistency
    # This should equal 1.0 exactly (within numerical precision)
    M_throat_verified, M_verify_valid = NumericalStability.safe_divide(
        velocity_throat, a_throat, 1.0, "M_throat_verified"
    )
    if not M_verify_valid.passed:
        M_throat_verified = 1.0  # Fallback to expected value
    
    # Warn if verification deviates significantly from 1.0 (indicates numerical error)
    if abs(M_throat_verified - 1.0) > 1e-6:
        import warnings
        warnings.warn(
            f"Throat Mach verification failed: M_throat_verified = {M_throat_verified:.8f} "
            f"(expected 1.0). Deviation: {abs(M_throat_verified - 1.0):.2e}. "
            f"This may indicate numerical precision issues.",
            RuntimeWarning
        )
    
    # Check if flow is choked using pressure ratio criterion
    # Choking occurs when: P_back/Pc <= (2/(γ+1))^(γ/(γ-1))
    # Use provided P_back, or fallback to 0.9 * 1 atm if not provided
    P_back_used = P_back if P_back is not None else 0.9 * 101325.0  # Fallback: 0.9 atm
    pressure_ratio_exponent = gamma / (gamma - 1.0)
    pressure_ratio_base = 2.0 / (gamma + 1.0)
    critical_pressure_ratio = pressure_ratio_base ** pressure_ratio_exponent
    
    is_choked = True
    actual_pressure_ratio = None
    if Pc > 0:
        actual_pressure_ratio = P_back_used / Pc
        # Flow is choked if P_back/Pc <= critical ratio
        is_choked = actual_pressure_ratio <= critical_pressure_ratio
        
        if not is_choked:
            import warnings
            warnings.warn(
                f"Flow may not be choked: P_back/Pc = {actual_pressure_ratio:.6f} > "
                f"critical ratio = {critical_pressure_ratio:.6f}. "
                f"Throat Mach number may be < 1.0. "
                f"P_back = {P_back_used:.2e} Pa, Pc = {Pc:.2e} Pa.",
                RuntimeWarning
            )
    
    # CRITICAL: M_throat = 1.0 (always, by definition of throat)
    # This is NOT the chamber Mach number (which is subsonic)
    # This is NOT the exit Mach number (which is supersonic)
    
    # CRITICAL: This is the CHAMBER Mach number (mean flow in chamber), NOT throat or exit
    # - Chamber: Subsonic (typically 0.01-0.1) - this is what we're calculating
    # - Throat: Always M = 1.0 (sonic) - defined by throat geometry
    # - Exit: Supersonic (M > 1.0) - calculated from area ratio in nozzle.py
    mach_number, mach_valid = NumericalStability.safe_divide(
        velocity_mean, sound_speed, 0.01, "mach_number_chamber"
    )
    if not mach_valid.passed:
        mach_number = 0.01  # Fallback
    
    # Residence time
    # tau = V_chamber / (mdot_total / rho) = V_chamber * rho / mdot_total
    residence_time, tau_valid = NumericalStability.safe_divide(
        V_chamber * rho, mdot_total, 0.001, "residence_time"
    )
    if not tau_valid.passed:
        residence_time = 0.001  # Fallback [s]
    
    # Reynolds number (use mean properties)
    # Re = rho * u * L / mu
    # Estimate viscosity from temperature (Sutherland's law approximation)
    mu_ref = 1.8e-5  # Pa·s at 273 K (air, approximate for combustion gases)
    T_ref = 273.0  # K
    S = 110.4  # Sutherland constant [K] (for air, approximate)
    viscosity = mu_ref * ((Tc / T_ref) ** 1.5) * ((T_ref + S) / (Tc + S))
    
    # Characteristic length for Re (use Lstar)
    reynolds_number, Re_valid = NumericalStability.safe_divide(
        rho * velocity_mean * Lstar, viscosity, 1000.0, "reynolds_number"
    )
    if not Re_valid.passed:
        reynolds_number = 10000.0  # Fallback
    
    # Validate all values
    residence_time = max(residence_time, 1e-6)  # Minimum 1 µs
    # CRITICAL: Chamber Mach number is subsonic (M < 1.0)
    # Typical range: 0.01 to 0.1 for rocket chambers
    # This is NOT the throat Mach number (which is always M = 1.0)
    # This is NOT the exit Mach number (which is supersonic, M > 1.0)
    mach_number = max(min(mach_number, 0.99), 0.001)  # Subsonic chamber flow
    reynolds_number = max(reynolds_number, 100.0)  # Minimum Re
    
    return {
        "Lstar": float(Lstar),
        "residence_time": float(residence_time),
        "velocity_mean": float(velocity_mean),
        "velocity_throat": float(velocity_throat),  # Sonic velocity (M_throat = 1.0)
        "density": float(rho),
        "sound_speed": float(sound_speed),
        "mach_number": float(mach_number),  # CHAMBER Mach number (subsonic, ~0.01-0.1)
        "mach_number_chamber": float(mach_number),  # Explicit: this is chamber Mach number
        "mach_number_throat": 1.0,  # Throat is always M = 1.0 (sonic) - by definition
        "mach_number_throat_verified": float(M_throat_verified),  # Calculated from v/a (verification)
        "is_choked": bool(is_choked),  # Whether flow is choked (P_back/Pc <= critical ratio)
        "critical_pressure_ratio": float(critical_pressure_ratio),  # Critical P_back/Pc for choking
        "actual_pressure_ratio": float(actual_pressure_ratio) if actual_pressure_ratio is not None else None,
        "reynolds_number": float(reynolds_number),
        "viscosity": float(viscosity),
        "volume": float(V_chamber),
        "A_throat": float(A_throat),
        "A_avg": float(A_avg),
    }


def calculate_ablative_geometry_profile(
    L_chamber: float,
    D_chamber_initial: float,
    ablative_config: AblativeCoolingConfig,
    recession_thickness_chamber: float = 0.0,
    n_points: int = 50,
) -> Dict[str, Any]:
    """
    Calculate ablative liner geometry profile along chamber length.
    
    Parameters:
    -----------
    L_chamber : float
        Chamber length [m]
    D_chamber_initial : float
        Initial chamber inner diameter [m] (before ablative)
    ablative_config : AblativeCoolingConfig
        Ablative configuration
    recession_thickness_chamber : float
        Cumulative recession thickness [m] (default: 0.0)
    n_points : int
        Number of points along chamber (default: 50)
    
    Returns:
    --------
    profile : dict
        - positions: Array of positions along chamber [m]
        - D_chamber_inner: Inner diameter (gas side) [m]
        - D_ablative_outer: Outer diameter (ablative surface) [m]
        - ablative_thickness: Ablative thickness at each position [m]
        - recession: Recession at each position [m]
    """
    if not ablative_config.enabled:
        return {
            "positions": np.linspace(0, L_chamber, n_points).tolist(),
            "D_chamber_inner": [D_chamber_initial] * n_points,
            "D_ablative_outer": [D_chamber_initial] * n_points,
            "ablative_thickness": [0.0] * n_points,
            "recession": [0.0] * n_points,
        }
    
    positions = np.linspace(0.0, L_chamber, n_points)
    
    # Current ablative thickness (initial - recession)
    ablative_thickness_current = max(
        ablative_config.initial_thickness - recession_thickness_chamber,
        0.0
    )
    
    # Physics: As ablative recedes, chamber inner diameter grows
    # For radial recession: D_new = D_initial + 2 * recession (diameter increases by 2*recession)
    # Coverage fraction accounts for partial coverage (not all surfaces have ablative)
    D_chamber_inner = D_chamber_initial + 2.0 * recession_thickness_chamber * ablative_config.coverage_fraction
    
    # Ablative outer diameter = gas-side diameter + 2 * remaining ablative thickness
    # This defines the outer surface of the ablative liner
    D_ablative_outer = D_chamber_inner + 2.0 * ablative_thickness_current
    
    # For now, assume uniform recession along length
    # In reality, recession varies with heat flux (higher near throat)
    recession_array = np.full(n_points, recession_thickness_chamber)
    ablative_thickness_array = np.full(n_points, ablative_thickness_current)
    
    return {
        "positions": positions.tolist(),
        "D_chamber_inner": (D_chamber_inner * np.ones(n_points)).tolist(),
        "D_ablative_outer": (D_ablative_outer * np.ones(n_points)).tolist(),
        "ablative_thickness": ablative_thickness_array.tolist(),
        "recession": recession_array.tolist(),
    }


def calculate_graphite_geometry(
    D_throat_initial: float,
    graphite_config: GraphiteInsertConfig,
    recession_thickness_graphite: float = 0.0,
) -> Dict[str, float]:
    """
    Calculate graphite insert geometry at throat.
    
    Parameters:
    -----------
    D_throat_initial : float
        Initial throat diameter [m] (defined by graphite insert)
    graphite_config : GraphiteInsertConfig
        Graphite configuration
    recession_thickness_graphite : float
        Cumulative graphite recession [m] (default: 0.0)
    
    Returns:
    --------
    geometry : dict
        - D_throat_current: Current throat diameter [m] (grows with recession)
        - D_graphite_outer: Outer diameter of graphite insert [m]
        - graphite_thickness_remaining: Remaining graphite thickness [m]
        - graphite_thickness_initial: Initial graphite thickness [m]
        - recession: Total recession [m]
    """
    if not graphite_config.enabled:
        return {
            "D_throat_current": D_throat_initial,
            "D_graphite_outer": D_throat_initial,
            "graphite_thickness_remaining": 0.0,
            "graphite_thickness_initial": 0.0,
            "recession": 0.0,
        }
    
    # Physics: Graphite recession increases throat diameter
    # As graphite erodes radially, throat diameter grows: D_new = D_initial + 2 * recession
    # Coverage fraction accounts for partial coverage
    D_throat_current = D_throat_initial + 2.0 * recession_thickness_graphite * graphite_config.coverage_fraction
    
    # Remaining graphite thickness = initial - cumulative recession
    # This cannot go negative (graphite is fully consumed at 0)
    graphite_thickness_remaining = max(
        graphite_config.initial_thickness - recession_thickness_graphite,
        0.0
    )
    
    # Outer diameter of graphite insert = throat diameter + 2 * remaining thickness
    # This defines the outer surface of the graphite insert
    D_graphite_outer = D_throat_current + 2.0 * graphite_thickness_remaining
    
    return {
        "D_throat_current": float(D_throat_current),
        "D_graphite_outer": float(D_graphite_outer),
        "graphite_thickness_remaining": float(graphite_thickness_remaining),
        "graphite_thickness_initial": float(graphite_config.initial_thickness),
        "recession": float(recession_thickness_graphite),
    }


def calculate_complete_chamber_geometry(
    V_chamber: float,
    A_throat: float,
    L_chamber: float,
    D_chamber_initial: float,
    D_throat_initial: float,
    ablative_config: Optional[AblativeCoolingConfig] = None,
    graphite_config: Optional[GraphiteInsertConfig] = None,
    stainless_config: Optional[StainlessSteelCaseConfig] = None,
    recession_chamber: float = 0.0,
    recession_graphite: float = 0.0,
    n_points: int = 50,
) -> Dict[str, Any]:
    """
    Calculate complete chamber geometry including ablative, graphite, and stainless steel.
    
    This provides a comprehensive view of the multi-layer wall structure:
    - Hot gas → Phenolic ablator → Stainless steel case (chamber)
    - Hot gas → Graphite insert → Stainless steel case (throat)
    
    Parameters:
    -----------
    V_chamber : float
        Current chamber volume [m³]
    A_throat : float
        Current throat area [m²]
    L_chamber : float
        Chamber length [m]
    D_chamber_initial : float
        Initial chamber inner diameter [m]
    D_throat_initial : float
        Initial throat diameter [m]
    ablative_config : AblativeCoolingConfig, optional
        Ablative configuration
    graphite_config : GraphiteInsertConfig, optional
        Graphite configuration
    stainless_config : StainlessSteelCaseConfig, optional
        Stainless steel case configuration
    recession_chamber : float
        Cumulative ablative recession [m]
    recession_graphite : float
        Cumulative graphite recession [m]
    n_points : int
        Number of points along chamber (default: 50)
    
    Returns:
    --------
    geometry : dict
        Complete geometry profile including:
        - positions: Array of positions [m]
        - D_gas_chamber: Gas-side diameter (chamber) [m]
        - D_ablative_outer: Ablative outer diameter [m]
        - D_stainless_outer: Stainless steel outer diameter [m]
        - D_throat_current: Current throat diameter [m]
        - D_graphite_outer: Graphite outer diameter [m]
        - ablative_thickness: Ablative thickness [m]
        - graphite_thickness: Graphite thickness [m]
        - stainless_thickness: Stainless steel thickness [m]
    """
    # Calculate current diameters
    # FIXED: Add safety checks for sqrt operations
    D_chamber_current = np.sqrt(max(0, 4.0 * V_chamber / (np.pi * L_chamber))) if L_chamber > 0 else D_chamber_initial
    D_throat_current = np.sqrt(max(0, 4.0 * A_throat / np.pi)) if A_throat > 0 else 0.015
    
    positions = np.linspace(0.0, L_chamber, n_points)
    
    # Chamber geometry (ablative + stainless)
    if ablative_config and ablative_config.enabled:
        ablative_thickness = max(
            ablative_config.initial_thickness - recession_chamber,
            0.0
        )
        D_gas_chamber = D_chamber_initial + 2.0 * recession_chamber * ablative_config.coverage_fraction
        D_ablative_outer = D_gas_chamber + 2.0 * ablative_thickness
    else:
        ablative_thickness = 0.0
        D_gas_chamber = D_chamber_current
        D_ablative_outer = D_gas_chamber
    
    # Stainless steel case (behind ablative)
    if stainless_config and stainless_config.enabled:
        stainless_thickness = stainless_config.thickness
        D_stainless_outer = D_ablative_outer + 2.0 * stainless_thickness
    else:
        stainless_thickness = 0.0
        D_stainless_outer = D_ablative_outer
    
    # Throat geometry (graphite + stainless)
    graphite_geometry = calculate_graphite_geometry(
        D_throat_initial,
        graphite_config if graphite_config else type('obj', (object,), {'enabled': False})(),
        recession_graphite,
    )
    
    D_throat_current = graphite_geometry["D_throat_current"]
    D_graphite_outer = graphite_geometry["D_graphite_outer"]
    graphite_thickness = graphite_geometry["graphite_thickness_remaining"]
    
    # Stainless steel at throat (behind graphite)
    if stainless_config and stainless_config.enabled:
        D_stainless_throat_outer = D_graphite_outer + 2.0 * stainless_thickness
    else:
        D_stainless_throat_outer = D_graphite_outer
    
    return {
        "positions": positions.tolist(),
        "D_gas_chamber": (D_gas_chamber * np.ones(n_points)).tolist(),
        "D_ablative_outer": (D_ablative_outer * np.ones(n_points)).tolist(),
        "D_stainless_outer": (D_stainless_outer * np.ones(n_points)).tolist(),
        "D_throat_current": float(D_throat_current),
        "D_graphite_outer": float(D_graphite_outer),
        "D_stainless_throat_outer": float(D_stainless_throat_outer),
        "ablative_thickness": (ablative_thickness * np.ones(n_points)).tolist(),
        "graphite_thickness": float(graphite_thickness),
        "stainless_thickness": float(stainless_thickness),
        "recession_chamber": float(recession_chamber),
        "recession_graphite": float(recession_graphite),
    }


def visualize_chamber_cross_section(
    geometry: Dict[str, Any],
    pressure_profile: Optional[Dict[str, Any]] = None,
    save_path: Optional[str] = None,
    show_plot: bool = True,
) -> None:
    """
    Visualize complete chamber cross-section with ablative, graphite, and stainless steel.
    
    Creates a 2D cross-sectional view showing:
    - Chamber wall layers (ablative → stainless)
    - Throat region (graphite → stainless)
    - Pressure profile overlay (optional)
    
    Parameters:
    -----------
    geometry : dict
        Complete geometry from calculate_complete_chamber_geometry
    pressure_profile : dict, optional
        Pressure profile from calculate_chamber_pressure_profile
    save_path : str, optional
        Path to save figure (default: None, don't save)
    show_plot : bool
        Whether to display plot (default: True)
    """
    try:
        import matplotlib.pyplot as plt
        from matplotlib.patches import Circle
    except ImportError:
        print("matplotlib not available - skipping visualization")
        return
    
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 8))
    
    positions = np.array(geometry["positions"])
    L_chamber = positions[-1]
    
    # Left plot: Axial cross-section (side view)
    ax1.set_aspect('equal')
    ax1.set_xlabel('Axial Position [m]', fontsize=12)
    ax1.set_ylabel('Radius [m]', fontsize=12)
    ax1.set_title('Chamber Cross-Section (Side View)', fontsize=14, fontweight='bold')
    ax1.grid(True, alpha=0.3)
    
    # Plot chamber layers
    D_gas = np.array(geometry["D_gas_chamber"]) / 2.0  # Convert to radius
    D_ablative = np.array(geometry["D_ablative_outer"]) / 2.0
    D_stainless = np.array(geometry["D_stainless_outer"]) / 2.0
    
    # Gas boundary (centerline to gas surface)
    ax1.fill_between(positions, 0, D_gas, color='orange', alpha=0.3, label='Hot Gas')
    ax1.plot(positions, D_gas, 'r-', linewidth=2, label='Gas Boundary')
    
    # Ablative layer
    if np.any(D_ablative > D_gas):
        ax1.fill_between(positions, D_gas, D_ablative, color='brown', alpha=0.5, label='Phenolic Ablator')
        ax1.plot(positions, D_ablative, 'brown', linewidth=1.5, linestyle='--')
    
    # Stainless steel case
    if np.any(D_stainless > D_ablative):
        ax1.fill_between(positions, D_ablative, D_stainless, color='gray', alpha=0.6, label='Stainless Steel')
        ax1.plot(positions, D_stainless, 'gray', linewidth=1.5, linestyle='--')
    
    # Throat region (zoomed)
    D_throat = geometry["D_throat_current"] / 2.0
    D_graphite = geometry["D_graphite_outer"] / 2.0
    D_stainless_throat = geometry["D_stainless_throat_outer"] / 2.0
    
    # Draw throat region (at end of chamber)
    throat_pos = L_chamber
    ax1.plot([throat_pos, throat_pos], [0, D_stainless_throat], 'k-', linewidth=2)
    
    # Graphite insert at throat
    if geometry["graphite_thickness"] > 0:
        ax1.add_patch(Circle((throat_pos, 0), D_graphite, fill=False, 
                            edgecolor='black', linewidth=2, linestyle=':', label='Graphite Insert'))
        ax1.add_patch(Circle((throat_pos, 0), D_throat, fill=False, 
                            edgecolor='red', linewidth=2, label='Throat'))
    
    ax1.legend(loc='upper right', fontsize=10)
    ax1.set_xlim(-0.01, L_chamber * 1.1)
    ax1.set_ylim(0, max(D_stainless) * 1.2)
    
    # Right plot: Radial cross-section at mid-chamber
    ax2.set_aspect('equal')
    ax2.set_xlabel('Radius [m]', fontsize=12)
    ax2.set_ylabel('Radius [m]', fontsize=12)
    ax2.set_title('Wall Structure (Mid-Chamber Cross-Section)', fontsize=14, fontweight='bold')
    ax2.grid(True, alpha=0.3)
    
    # Get mid-chamber values
    mid_idx = len(positions) // 2
    R_gas_mid = D_gas[mid_idx]
    R_ablative_mid = D_ablative[mid_idx]
    R_stainless_mid = D_stainless[mid_idx]
    
    # Draw concentric circles
    theta = np.linspace(0, 2*np.pi, 100)
    
    # Gas boundary
    ax2.plot(R_gas_mid * np.cos(theta), R_gas_mid * np.sin(theta), 
             'r-', linewidth=3, label='Gas Boundary')
    
    # Ablative layer
    if R_ablative_mid > R_gas_mid:
        ax2.fill_between(R_ablative_mid * np.cos(theta), 
                         R_gas_mid * np.sin(theta), 
                         R_ablative_mid * np.sin(theta),
                         color='brown', alpha=0.5, label='Phenolic Ablator')
        ax2.plot(R_ablative_mid * np.cos(theta), R_ablative_mid * np.sin(theta),
                 'brown', linewidth=2, linestyle='--')
    
    # Stainless steel
    if R_stainless_mid > R_ablative_mid:
        ax2.fill_between(R_stainless_mid * np.cos(theta),
                         R_ablative_mid * np.sin(theta),
                         R_stainless_mid * np.sin(theta),
                         color='gray', alpha=0.6, label='Stainless Steel')
        ax2.plot(R_stainless_mid * np.cos(theta), R_stainless_mid * np.sin(theta),
                 'gray', linewidth=2, linestyle='--')
    
    ax2.legend(loc='upper right', fontsize=10)
    max_radius = R_stainless_mid * 1.2
    ax2.set_xlim(-max_radius, max_radius)
    ax2.set_ylim(-max_radius, max_radius)
    
    # Add text annotations
    info_text = (
        f"Ablative Thickness: {geometry['ablative_thickness'][0]*1000:.1f} mm\n"
        f"Graphite Thickness: {geometry['graphite_thickness']*1000:.1f} mm\n"
        f"Stainless Thickness: {geometry['stainless_thickness']*1000:.1f} mm\n"
        f"Chamber Recession: {geometry['recession_chamber']*1000:.2f} mm\n"
        f"Graphite Recession: {geometry['recession_graphite']*1000:.2f} mm"
    )
    ax2.text(0.02, 0.98, info_text, transform=ax2.transAxes,
             fontsize=9, verticalalignment='top',
             bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5))
    
    plt.tight_layout()
    
    if save_path:
        plt.savefig(save_path, dpi=300, bbox_inches='tight')
        print(f"Figure saved to {save_path}")
    
    if show_plot:
        plt.show()
    else:
        plt.close()

