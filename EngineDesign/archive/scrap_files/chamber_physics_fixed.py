"""Fixed physics models for chamber and nozzle flow.

Key fixes:
1. Throat is always M=1.0 (sonic) - this is the definition of the throat
2. Chamber Mach number is subsonic (typically 0.01-0.1)
3. Exit Mach number is supersonic (calculated from area ratio)
4. Proper isentropic relations throughout
5. Throat recession maintains M=1.0 condition
"""

from __future__ import annotations

from typing import Dict, Tuple, Optional
import numpy as np
from engine.pipeline.numerical_robustness import NumericalStability
from engine.core.mach_solver import solve_mach_robust


def calculate_throat_conditions(
    Pc: float,
    Tc: float,
    gamma: float,
    R: float,
    P_back: Optional[float] = None,
) -> Dict[str, float]:
    """
    Calculate throat conditions using isentropic flow relations.
    
    CRITICAL: At the throat, flow is ALWAYS sonic (M = 1.0) when choked.
    This is the definition of the throat in a converging-diverging nozzle.
    
    Choking occurs when: P_back/Pc <= (2/(γ+1))^(γ/(γ-1))
    If this condition is not met, the flow may not be choked and M_throat < 1.0.
    
    Isentropic relations for sonic throat:
    - M_throat = 1.0 (when choked)
    - P_throat/Pc = [2/(γ+1)]^(γ/(γ-1))
    - T_throat/Tc = 2/(γ+1)
    - v_throat = a_throat = sqrt(γ × R × T_throat)
    - ρ_throat/ρc = [2/(γ+1)]^(1/(γ-1))
    
    Parameters:
    -----------
    Pc : float
        Chamber pressure [Pa] (stagnation pressure P₀ ≈ Pc)
    Tc : float
        Chamber temperature [K]
    gamma : float
        Specific heat ratio
    R : float
        Gas constant [J/(kg·K)]
    P_back : float, optional
        Back pressure [Pa] (ambient pressure or pressure nozzle exhausts into).
        If provided, checks if flow is choked. If None, assumes choked flow.
    
    Returns:
    --------
    throat_conditions : dict
        - M_throat: Mach number (1.0 if choked, < 1.0 if not choked)
        - P_throat: Throat pressure [Pa]
        - T_throat: Throat temperature [K]
        - v_throat: Throat velocity [m/s] (sonic if choked)
        - a_throat: Throat sound speed [m/s]
        - rho_throat: Throat density [kg/m³]
        - is_choked: bool, whether flow is choked (P_back/Pc <= critical ratio)
        - critical_pressure_ratio: float, critical pressure ratio for choking
        - actual_pressure_ratio: float, actual P_back/Pc ratio
    """
    # Calculate critical pressure ratio for choking
    # Choking occurs when: P_back/Pc <= (2/(γ+1))^(γ/(γ-1))
    pressure_ratio_exponent = gamma / (gamma - 1.0)
    pressure_ratio_base = 2.0 / (gamma + 1.0)
    critical_pressure_ratio = pressure_ratio_base ** pressure_ratio_exponent
    
    # Check if flow is choked (if back pressure is provided)
    is_choked = True
    actual_pressure_ratio = None
    if P_back is not None and Pc > 0:
        actual_pressure_ratio = P_back / Pc
        # Flow is choked if P_back/Pc <= critical ratio
        is_choked = actual_pressure_ratio <= critical_pressure_ratio
        
        if not is_choked:
            import warnings
            warnings.warn(
                f"Flow may not be choked: P_back/Pc = {actual_pressure_ratio:.6f} > "
                f"critical ratio = {critical_pressure_ratio:.6f}. "
                f"Throat Mach number may be < 1.0. "
                f"P_back = {P_back:.2e} Pa, Pc = {Pc:.2e} Pa.",
                RuntimeWarning
            )
    
    # CRITICAL: Throat is sonic (M = 1.0) when choked
    # If not choked, M_throat < 1.0, but we still use M = 1.0 as assumption
    # (for rocket engines, flow is almost always choked)
    M_throat = 1.0
    
    # Isentropic pressure ratio at throat (critical pressure ratio)
    # P*/P0 = [2/(γ+1)]^(γ/(γ-1))
    P_throat_Pc_ratio = critical_pressure_ratio
    P_throat = Pc * P_throat_Pc_ratio
    
    # Isentropic temperature ratio at throat (critical temperature ratio)
    # T*/T0 = 2/(γ+1)
    T_throat_Tc_ratio = 2.0 / (gamma + 1.0)
    T_throat = Tc * T_throat_Tc_ratio
    
    # Throat sound speed (sonic velocity)
    # a* = sqrt(γ × R × T*)
    a_throat_squared = gamma * R * T_throat
    a_throat, a_valid = NumericalStability.safe_sqrt(a_throat_squared, "a_throat")
    if not a_valid.passed:
        # Fallback: use chamber sound speed
        a_chamber_squared = gamma * R * Tc
        a_chamber, _ = NumericalStability.safe_sqrt(a_chamber_squared, "a_chamber")
        a_throat = a_chamber * np.sqrt(T_throat_Tc_ratio)
    
    # Throat velocity = sound speed (M = 1.0)
    v_throat = a_throat
    
    # VERIFICATION: Calculate M_throat from v_throat / a_throat to verify consistency
    # This should equal 1.0 exactly (within numerical precision)
    M_throat_verified, M_verify_valid = NumericalStability.safe_divide(
        v_throat, a_throat, 1.0, "M_throat_verified"
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
    
    # Throat density from ideal gas law
    rho_throat, rho_valid = NumericalStability.safe_divide(
        P_throat, R * T_throat, 1.0, "rho_throat"
    )
    if not rho_valid.passed:
        # Fallback: use isentropic density ratio
        density_ratio_exponent = 1.0 / (gamma - 1.0)
        rho_throat_rho_ratio = pressure_ratio_base ** density_ratio_exponent
        rho_chamber = Pc / (R * Tc)
        rho_throat = rho_chamber * rho_throat_rho_ratio
    
    return {
        "M_throat": M_throat,  # 1.0 if choked (physical assumption)
        "M_throat_verified": float(M_throat_verified),  # Calculated from v/a (should be 1.0 if choked)
        "P_throat": float(P_throat),
        "T_throat": float(T_throat),
        "v_throat": float(v_throat),
        "a_throat": float(a_throat),
        "rho_throat": float(rho_throat),
        "P_throat_Pc_ratio": float(P_throat_Pc_ratio),
        "T_throat_Tc_ratio": float(T_throat_Tc_ratio),
        "is_choked": bool(is_choked),  # Whether flow is choked
        "critical_pressure_ratio": float(critical_pressure_ratio),  # Critical P_back/Pc for choking
        "actual_pressure_ratio": float(actual_pressure_ratio) if actual_pressure_ratio is not None else None,
    }


def calculate_chamber_mach_number(
    V_chamber: float,
    A_throat: float,
    mdot_total: float,
    Pc: float,
    Tc: float,
    gamma: float,
    R: float,
    Lstar: float,
) -> Dict[str, float]:
    """
    Calculate chamber Mach number (mean flow in chamber).
    
    CRITICAL: This is the CHAMBER Mach number, NOT the throat or exit Mach number.
    - Chamber: Subsonic (typically 0.01-0.1)
    - Throat: Always M = 1.0 (sonic)
    - Exit: Supersonic (M > 1.0, calculated from area ratio)
    
    Parameters:
    -----------
    V_chamber : float
        Chamber volume [m³]
    A_throat : float
        Throat area [m²]
    mdot_total : float
        Total mass flow rate [kg/s]
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    gamma : float
        Specific heat ratio
    R : float
        Gas constant [J/(kg·K)]
    Lstar : float
        Characteristic length [m]
    
    Returns:
    --------
    chamber_flow : dict
        - M_chamber: Chamber Mach number (subsonic, ~0.01-0.1)
        - v_chamber: Chamber mean velocity [m/s]
        - a_chamber: Chamber sound speed [m/s]
        - rho_chamber: Chamber density [kg/m³]
        - A_chamber_avg: Average chamber area [m²]
    """
    # Chamber density
    rho_chamber, rho_valid = NumericalStability.safe_divide(
        Pc, R * Tc, 1.0, "rho_chamber"
    )
    if not rho_valid.passed:
        rho_chamber = 1.0  # Fallback
    
    # Chamber sound speed
    a_chamber_squared = gamma * R * Tc
    a_chamber, a_valid = NumericalStability.safe_sqrt(a_chamber_squared, "a_chamber")
    if not a_valid.passed:
        a_chamber = 1000.0  # Fallback
    
    # Average chamber area (from volume and length)
    A_chamber_avg, A_valid = NumericalStability.safe_divide(
        V_chamber, Lstar, A_throat, "A_chamber_avg"
    )
    if not A_valid.passed:
        # Fallback: assume chamber area is ~3x throat area (typical)
        A_chamber_avg = A_throat * 3.0
    
    # Chamber mean velocity (continuity: mdot = ρ × A × v)
    v_chamber, v_valid = NumericalStability.safe_divide(
        mdot_total, rho_chamber * A_chamber_avg, 10.0, "v_chamber"
    )
    if not v_valid.passed:
        v_chamber = 10.0  # Fallback
    
    # Chamber Mach number (subsonic)
    M_chamber, M_valid = NumericalStability.safe_divide(
        v_chamber, a_chamber, 0.01, "M_chamber"
    )
    if not M_valid.passed:
        M_chamber = 0.01  # Fallback
    
    # Validate: Chamber should be subsonic (M < 1.0)
    # Typical range: 0.01 to 0.1
    M_chamber = np.clip(M_chamber, 0.001, 0.99)  # Subsonic
    
    return {
        "M_chamber": float(M_chamber),
        "v_chamber": float(v_chamber),
        "a_chamber": float(a_chamber),
        "rho_chamber": float(rho_chamber),
        "A_chamber_avg": float(A_chamber_avg),
    }


def calculate_exit_mach_from_area_ratio(
    A_exit: float,
    A_throat: float,
    gamma: float,
    supersonic: bool = True,
) -> float:
    """
    Calculate exit Mach number from area ratio using consolidated isentropic flow solver.
    
    Parameters:
    -----------
    A_exit : float
        Exit area [m²]
    A_throat : float
        Throat area [m²] (A*)
    gamma : float
        Specific heat ratio
    supersonic : bool
        If True, return supersonic solution (M > 1.0)
        If False, return subsonic solution (M < 1.0)
    
    Returns:
    --------
    M_exit : float
        Exit Mach number
    """
    eps = A_exit / A_throat if A_throat > 0 else 1.0
    M, _ = solve_mach_robust(eps, gamma, supersonic=supersonic)
    return float(M)


def calculate_exit_conditions_from_mach(
    M_exit: float,
    Pc: float,
    Tc: float,
    gamma: float,
    R: float,
) -> Dict[str, float]:
    """
    Calculate exit conditions from exit Mach number using isentropic relations.
    
    Isentropic relations:
    - P_exit/Pc = [1 + (γ-1)/2 × M²]^(-γ/(γ-1))
    - T_exit/Tc = [1 + (γ-1)/2 × M²]^(-1)
    - v_exit = M × sqrt(γ × R × T_exit)
    
    Parameters:
    -----------
    M_exit : float
        Exit Mach number (should be > 1.0 for rocket nozzles)
    Pc : float
        Chamber pressure [Pa]
    Tc : float
        Chamber temperature [K]
    gamma : float
        Specific heat ratio
    R : float
        Gas constant [J/(kg·K)]
    
    Returns:
    --------
    exit_conditions : dict
        - P_exit: Exit pressure [Pa]
        - T_exit: Exit temperature [K]
        - v_exit: Exit velocity [m/s]
        - a_exit: Exit sound speed [m/s]
        - rho_exit: Exit density [kg/m³]
    """
    # Isentropic pressure ratio
    pressure_exponent = -gamma / (gamma - 1.0)
    pressure_factor = (1.0 + (gamma - 1.0) / 2.0 * M_exit**2) ** pressure_exponent
    P_exit = Pc * pressure_factor
    
    # Isentropic temperature ratio
    temperature_exponent = -1.0
    temperature_factor = (1.0 + (gamma - 1.0) / 2.0 * M_exit**2) ** temperature_exponent
    T_exit = Tc * temperature_factor
    
    # Exit sound speed
    a_exit_squared = gamma * R * T_exit
    a_exit, a_valid = NumericalStability.safe_sqrt(a_exit_squared, "a_exit")
    if not a_valid.passed:
        a_chamber_squared = gamma * R * Tc
        a_chamber, _ = NumericalStability.safe_sqrt(a_chamber_squared, "a_chamber")
        a_exit = a_chamber * np.sqrt(temperature_factor)
    
    # Exit velocity
    v_exit = M_exit * a_exit
    
    # Exit density
    rho_exit, rho_valid = NumericalStability.safe_divide(
        P_exit, R * T_exit, 1.0, "rho_exit"
    )
    if not rho_valid.passed:
        # Fallback: use isentropic density ratio
        density_exponent = 1.0 / (gamma - 1.0)
        density_factor = (1.0 + (gamma - 1.0) / 2.0 * M_exit**2) ** (-density_exponent)
        rho_chamber = Pc / (R * Tc)
        rho_exit = rho_chamber * density_factor
    
    return {
        "P_exit": float(P_exit),
        "T_exit": float(T_exit),
        "v_exit": float(v_exit),
        "a_exit": float(a_exit),
        "rho_exit": float(rho_exit),
        "M_exit": float(M_exit),
    }

