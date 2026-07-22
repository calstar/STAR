"""Helper to calculate COPV consumption coefficients from physical parameters.

For a COPV system:
- Volume: V_copv [m³]
- Initial pressure: P_copv_0 [Pa]
- Regulated pressure: P_reg [Pa]
- Gas: GN2 (gaseous nitrogen)
- Flow characteristics: depends on regulator and valve sizing
"""

from __future__ import annotations

from typing import Optional
import numpy as np

# Constants
PSI_TO_PA = 6894.76
R_N2 = 296.8  # Gas constant for N2 [J/(kg·K)]
T_N2 = 293.0  # Typical N2 temperature [K]


def estimate_copv_coefficients(
    V_copv_L: float,
    P_copv_psi: float,
    P_reg_psi: float,
    max_flow_rate_kg_s: Optional[float] = None,
    burn_time_s: Optional[float] = None,
) -> dict:
    """
    Estimate COPV consumption coefficients from physical parameters.
    
    Parameters:
    -----------
    V_copv_L : float
        COPV volume [L]
    P_copv_psi : float
        Initial COPV pressure [psi]
    P_reg_psi : float
        Regulated pressure [psi]
    max_flow_rate_kg_s : float, optional
        Maximum expected flow rate from COPV [kg/s]
        If None, estimated from typical values
    burn_time_s : float, optional
        Expected burn time [s]
        If None, estimated from pressure drop
    
    Returns:
    --------
    params : dict
        Dictionary with estimated coefficients:
        - copv_cF: [Pa/s per unit u_F]
        - copv_cO: [Pa/s per unit u_O]
        - copv_loss: [Pa/s]
        - reg_ratio: P_reg / P_copv
    """
    V_copv_m3 = V_copv_L / 1000.0
    P_copv_Pa = P_copv_psi * PSI_TO_PA
    P_reg_Pa = P_reg_psi * PSI_TO_PA
    
    # Calculate regulator ratio
    reg_ratio = P_reg_Pa / P_copv_Pa
    
    # Estimate mass flow rate if not provided
    # For a regulator, flow is approximately: mdot = Cd * A * sqrt(2*rho*deltaP)
    # Simplified: assume typical flow for pressure regulation
    if max_flow_rate_kg_s is None:
        # Estimate from typical regulator sizing
        # For 1000 psi regulated from 2750 psi, typical flow ~0.1-0.5 kg/s
        # This is a rough estimate - should be measured or calculated from regulator specs
        delta_P = P_copv_Pa - P_reg_Pa
        # Rough estimate: mdot ~ 0.001 * sqrt(delta_P) for typical regulator
        max_flow_rate_kg_s = 0.001 * np.sqrt(delta_P)
    
    # Estimate pressure drop rate
    # Using ideal gas law: P = (m*R*T)/V
    # dP/dt = (R*T/V) * (dm/dt)
    # For blowdown: dm/dt is negative (mass leaving)
    
    # Mass in COPV initially
    m0 = (P_copv_Pa * V_copv_m3) / (R_N2 * T_N2)
    
    # Pressure drop rate when flow is maximum
    # dP/dt = -(R*T/V) * mdot
    dP_dt_max = -(R_N2 * T_N2 / V_copv_m3) * max_flow_rate_kg_s
    
    # Convert to consumption coefficient
    # Model: dP_copv/dt = -cF*u_F - cO*u_O - loss
    # When u=1.0, dP/dt = -cF (or -cO)
    # So cF = -dP_dt_max (positive value)
    copv_c = abs(dP_dt_max)
    
    # Split between fuel and oxidizer (assume equal for now)
    copv_cF = copv_c / 2.0
    copv_cO = copv_c / 2.0
    
    # Leakage/heat loss (small, ~0.1% of max consumption)
    copv_loss = copv_c * 0.001
    
    return {
        "copv_cF": float(copv_cF),
        "copv_cO": float(copv_cO),
        "copv_loss": float(copv_loss),
        "reg_ratio": float(reg_ratio),
        "estimated_max_flow_kg_s": float(max_flow_rate_kg_s),
        "estimated_dP_dt_max_Pa_s": float(abs(dP_dt_max)),
    }


def calculate_from_regulator_specs(
    V_copv_L: float,
    P_copv_psi: float,
    P_reg_psi: float,
    regulator_Cv: Optional[float] = None,
    valve_Cv_F: Optional[float] = None,
    valve_Cv_O: Optional[float] = None,
) -> dict:
    """
    Calculate COPV coefficients from regulator and valve Cv values.
    
    Parameters:
    -----------
    V_copv_L : float
        COPV volume [L]
    P_copv_psi : float
        Initial COPV pressure [psi]
    P_reg_psi : float
        Regulated pressure [psi]
    regulator_Cv : float, optional
        Regulator flow coefficient Cv
    valve_Cv_F : float, optional
        Fuel valve flow coefficient Cv
    valve_Cv_O : float, optional
        Oxidizer valve flow coefficient Cv
    
    Returns:
    --------
    params : dict
        Dictionary with calculated coefficients
    """
    V_copv_m3 = V_copv_L / 1000.0
    P_copv_Pa = P_copv_psi * PSI_TO_PA
    P_reg_Pa = P_reg_psi * PSI_TO_PA
    
    # Flow through valve: Q = Cv * sqrt(deltaP / SG)
    # For gas: mdot = Cv * 0.048 * sqrt(deltaP * rho)
    # Simplified model
    
    if regulator_Cv is None:
        # Default: assume regulator can handle flow
        regulator_Cv = 1.0
    
    if valve_Cv_F is None:
        valve_Cv_F = 0.5  # Typical small solenoid valve
    
    if valve_Cv_O is None:
        valve_Cv_O = 0.5
    
    # Calculate flow rates (simplified)
    # mdot = Cv * K * sqrt(P_upstream - P_downstream) * rho
    # For N2 at regulator conditions
    rho_N2_reg = P_reg_Pa / (R_N2 * T_N2)  # Density at regulator pressure
    
    # Flow through fuel valve
    delta_P_F = P_reg_Pa - 3e6  # Assume 3 MPa tank pressure
    mdot_F_max = valve_Cv_F * 0.01 * np.sqrt(max(delta_P_F, 0)) * rho_N2_reg
    
    # Flow through oxidizer valve
    delta_P_O = P_reg_Pa - 3.5e6  # Assume 3.5 MPa tank pressure
    mdot_O_max = valve_Cv_O * 0.01 * np.sqrt(max(delta_P_O, 0)) * rho_N2_reg
    
    # Pressure drop rates
    dP_dt_F = -(R_N2 * T_N2 / V_copv_m3) * mdot_F_max
    dP_dt_O = -(R_N2 * T_N2 / V_copv_m3) * mdot_O_max
    
    copv_cF = abs(dP_dt_F)
    copv_cO = abs(dP_dt_O)
    copv_loss = (copv_cF + copv_cO) * 0.001
    
    reg_ratio = P_reg_Pa / P_copv_Pa
    
    return {
        "copv_cF": float(copv_cF),
        "copv_cO": float(copv_cO),
        "copv_loss": float(copv_loss),
        "reg_ratio": float(reg_ratio),
        "mdot_F_max_kg_s": float(mdot_F_max),
        "mdot_O_max_kg_s": float(mdot_O_max),
    }



