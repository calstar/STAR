"""Constraint checking for robust DDP controller.

Provides hard constraint violations and soft constraint margins.
"""

from __future__ import annotations

from typing import Dict, Any, Optional
import numpy as np

from .data_models import ControllerConfig
from .engine_wrapper import EngineEstimate
from .dynamics import (
    IDX_P_COPV,
    IDX_P_REG,
    IDX_P_U_F,
    IDX_P_U_O,
    IDX_P_D_F,
    IDX_P_D_O,
)


def is_safe(
    x: np.ndarray,
    eng_est: EngineEstimate,
    cfg: ControllerConfig,
) -> bool:
    """
    Check if state satisfies all hard constraints.
    
    Parameters:
    -----------
    x : np.ndarray, shape (N_STATE,)
        State vector: [P_copv, P_reg, P_u_F, P_u_O, P_d_F, P_d_O, V_u_F, V_u_O]
    eng_est : EngineEstimate
        Engine performance estimate
    cfg : ControllerConfig
        Controller configuration
    
    Returns:
    --------
    safe : bool
        True if all constraints are satisfied, False otherwise
    """
    constraint_vals = constraint_values(x, eng_est, cfg)
    
    # Check all hard constraints (positive = violation)
    hard_constraints = [
        "copv_min",
        "ullage_max_F",
        "ullage_max_O",
        "MR_min",
        "MR_max",
        "injector_stiffness_F",
        "injector_stiffness_O",
    ]
    
    for key in hard_constraints:
        if key in constraint_vals and constraint_vals[key] > 0:
            return False
    
    return True


def constraint_values(
    x: np.ndarray,
    eng_est: EngineEstimate,
    cfg: ControllerConfig,
) -> Dict[str, float]:
    """
    Compute constraint violation margins and soft constraint distances.
    
    Positive values indicate constraint violations (unsafe).
    Negative values indicate constraint satisfaction with margin.
    
    Parameters:
    -----------
    x : np.ndarray, shape (N_STATE,)
        State vector: [P_copv, P_reg, P_u_F, P_u_O, P_d_F, P_d_O, V_u_F, V_u_O]
    eng_est : EngineEstimate
        Engine performance estimate
    cfg : ControllerConfig
        Controller configuration
    
    Returns:
    --------
    constraints : dict
        Dictionary with constraint values:
        
        Hard constraints (positive = violation):
        - "copv_min": P_copv_min - P_copv [Pa]
        - "ullage_max_F": P_u_F - P_u_max [Pa]
        - "ullage_max_O": P_u_O - P_u_max [Pa]
        - "MR_min": MR_min - MR [dimensionless]
        - "MR_max": MR - MR_max [dimensionless]
        - "injector_stiffness_F": eps_i * P_ch - (P_d_F - P_ch) [Pa]
        - "injector_stiffness_O": eps_i * P_ch - (P_d_O - P_ch) [Pa]
        
        Soft constraints (margins, negative = safe with margin):
        - "copv_margin": P_copv - P_copv_min [Pa] (distance above minimum)
        - "ullage_margin_F": P_u_max - P_u_F [Pa] (distance below maximum)
        - "ullage_margin_O": P_u_max - P_u_O [Pa] (distance below maximum)
        - "MR_margin_low": MR - MR_min [dimensionless] (distance above minimum)
        - "MR_margin_high": MR_max - MR [dimensionless] (distance below maximum)
        - "injector_stiffness_margin_F": (P_d_F - P_ch) - eps_i * P_ch [Pa]
        - "injector_stiffness_margin_O": (P_d_O - P_ch) - eps_i * P_ch [Pa]
        
        Headroom flags (boolean-like, 1.0 = insufficient, 0.0 = sufficient):
        - "headroom_insufficient_F": 1.0 if (P_reg - P_u_F) < dp_min, else 0.0
        - "headroom_insufficient_O": 1.0 if (P_reg - P_u_O) < dp_min, else 0.0
        - "headroom_margin_F": (P_reg - P_u_F) - dp_min [Pa]
        - "headroom_margin_O": (P_reg - P_u_O) - dp_min [Pa]
    """
    # Extract state
    P_copv = x[IDX_P_COPV]
    P_reg = x[IDX_P_REG]
    P_u_F = x[IDX_P_U_F]
    P_u_O = x[IDX_P_U_O]
    P_d_F = x[IDX_P_D_F]
    P_d_O = x[IDX_P_D_O]
    
    # Extract engine estimate
    P_ch = eng_est.P_ch
    MR = eng_est.MR
    
    constraints = {}
    
    # 1. COPV minimum pressure constraint
    # Constraint: P_copv >= P_copv_min
    # Violation: P_copv_min - P_copv (positive if violated)
    copv_violation = cfg.P_copv_min - P_copv
    constraints["copv_min"] = copv_violation
    
    # Soft constraint margin (distance above minimum)
    constraints["copv_margin"] = P_copv - cfg.P_copv_min
    
    # 2. Ullage maximum pressure constraints
    # Constraint: P_u_F <= P_u_max, P_u_O <= P_u_max
    # Violation: P_u_F - P_u_max (positive if violated)
    ullage_violation_F = P_u_F - cfg.P_u_max
    ullage_violation_O = P_u_O - cfg.P_u_max
    constraints["ullage_max_F"] = ullage_violation_F
    constraints["ullage_max_O"] = ullage_violation_O
    
    # Soft constraint margins (distance below maximum)
    constraints["ullage_margin_F"] = cfg.P_u_max - P_u_F
    constraints["ullage_margin_O"] = cfg.P_u_max - P_u_O
    
    # 3. Mixture ratio constraints
    # Constraint: MR_min <= MR <= MR_max
    if np.isfinite(MR):
        # Lower bound violation: MR_min - MR (positive if violated)
        MR_violation_low = cfg.MR_min - MR
        constraints["MR_min"] = MR_violation_low
        
        # Upper bound violation: MR - MR_max (positive if violated)
        MR_violation_high = MR - cfg.MR_max
        constraints["MR_max"] = MR_violation_high
        
        # Soft constraint margins
        constraints["MR_margin_low"] = MR - cfg.MR_min
        constraints["MR_margin_high"] = cfg.MR_max - MR
    else:
        # MR is NaN - treat as violation
        constraints["MR_min"] = np.inf
        constraints["MR_max"] = np.inf
        constraints["MR_margin_low"] = -np.inf
        constraints["MR_margin_high"] = -np.inf
    
    # 4. Injector stiffness constraints
    # Constraint: (P_d_i - P_ch) >= eps_i * P_ch
    # Rearranged: P_d_i >= P_ch * (1 + eps_i)
    # Violation: eps_i * P_ch - (P_d_i - P_ch) (positive if violated)
    if np.isfinite(P_ch) and P_ch > 0:
        # Fuel injector stiffness
        injector_dp_F = eng_est.injector_dp_F
        if np.isfinite(injector_dp_F):
            required_dp_F = cfg.eps_i * P_ch
            stiffness_violation_F = required_dp_F - injector_dp_F
            constraints["injector_stiffness_F"] = stiffness_violation_F
            constraints["injector_stiffness_margin_F"] = injector_dp_F - required_dp_F
        else:
            constraints["injector_stiffness_F"] = np.inf
            constraints["injector_stiffness_margin_F"] = -np.inf
        
        # Oxidizer injector stiffness
        injector_dp_O = eng_est.injector_dp_O
        if np.isfinite(injector_dp_O):
            required_dp_O = cfg.eps_i * P_ch
            stiffness_violation_O = required_dp_O - injector_dp_O
            constraints["injector_stiffness_O"] = stiffness_violation_O
            constraints["injector_stiffness_margin_O"] = injector_dp_O - required_dp_O
        else:
            constraints["injector_stiffness_O"] = np.inf
            constraints["injector_stiffness_margin_O"] = -np.inf
    else:
        # P_ch is invalid - treat as violation
        constraints["injector_stiffness_F"] = np.inf
        constraints["injector_stiffness_O"] = np.inf
        constraints["injector_stiffness_margin_F"] = -np.inf
        constraints["injector_stiffness_margin_O"] = -np.inf
    
    # 5. Headroom constraints (for actuation effectiveness)
    # Constraint: (P_reg - P_u_i) >= dp_min for effective pressurization
    # Flag: 1.0 if insufficient headroom, 0.0 if sufficient
    headroom_F = P_reg - P_u_F
    headroom_O = P_reg - P_u_O
    
    constraints["headroom_insufficient_F"] = 1.0 if headroom_F < cfg.headroom_dp_min else 0.0
    constraints["headroom_insufficient_O"] = 1.0 if headroom_O < cfg.headroom_dp_min else 0.0
    
    # Soft constraint margins (distance above minimum headroom)
    constraints["headroom_margin_F"] = headroom_F - cfg.headroom_dp_min
    constraints["headroom_margin_O"] = headroom_O - cfg.headroom_dp_min
    
    return constraints


def get_constraint_summary(
    constraints: Dict[str, float],
) -> Dict[str, Any]:
    """
    Get human-readable summary of constraint status.
    
    Parameters:
    -----------
    constraints : dict
        Output from constraint_values()
    
    Returns:
    --------
    summary : dict
        Summary with:
        - "safe": bool (all constraints satisfied)
        - "violations": list of violated constraint names
        - "margins": dict of constraint margins
        - "headroom_flags": dict of headroom insufficiency flags
    """
    violations = []
    
    hard_constraints = [
        "copv_min",
        "ullage_max_F",
        "ullage_max_O",
        "MR_min",
        "MR_max",
        "injector_stiffness_F",
        "injector_stiffness_O",
    ]
    
    for key in hard_constraints:
        if key in constraints:
            val = constraints[key]
            if np.isfinite(val) and val > 0:
                violations.append(key)
            elif not np.isfinite(val):
                violations.append(f"{key}_invalid")
    
    safe = len(violations) == 0
    
    # Extract margins
    margins = {
        "copv": constraints.get("copv_margin", np.nan),
        "ullage_F": constraints.get("ullage_margin_F", np.nan),
        "ullage_O": constraints.get("ullage_margin_O", np.nan),
        "MR_low": constraints.get("MR_margin_low", np.nan),
        "MR_high": constraints.get("MR_margin_high", np.nan),
        "injector_stiffness_F": constraints.get("injector_stiffness_margin_F", np.nan),
        "injector_stiffness_O": constraints.get("injector_stiffness_margin_O", np.nan),
        "headroom_F": constraints.get("headroom_margin_F", np.nan),
        "headroom_O": constraints.get("headroom_margin_O", np.nan),
    }
    
    # Extract headroom flags
    headroom_flags = {
        "insufficient_F": constraints.get("headroom_insufficient_F", 0.0) > 0.5,
        "insufficient_O": constraints.get("headroom_insufficient_O", 0.0) > 0.5,
    }
    
    return {
        "safe": safe,
        "violations": violations,
        "margins": margins,
        "headroom_flags": headroom_flags,
    }



