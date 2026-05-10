"""Robustness bounds and tube propagation for robust DDP controller.

Maintains residual bounds w_bar for each state component and propagates
uncertainty tubes for robust control.
"""

from __future__ import annotations

from typing import Tuple, Optional
import numpy as np

from .data_models import ControllerConfig, ControllerState
from .dynamics import step, DynamicsParams, N_STATE
from .engine_wrapper import EngineWrapper


def update_bounds(
    state: ControllerState,
    x_prev: np.ndarray,
    x_meas: np.ndarray,
    u_prev: np.ndarray,
    cfg: ControllerConfig,
    engine_wrapper: Optional[EngineWrapper] = None,
    mdot_F: Optional[float] = None,
    mdot_O: Optional[float] = None,
    dt: Optional[float] = None,
) -> None:
    """
    Update residual bounds w_bar and disturbance bias beta.
    
    Computes residual between measured and predicted state, then updates
    bounds using exponential moving average with inflation.
    
    Parameters:
    -----------
    state : ControllerState
        Controller state (mutated in place)
    x_prev : np.ndarray, shape (N_STATE,)
        Previous state x[k-1]
    x_meas : np.ndarray, shape (N_STATE,)
        Measured state x_meas[k]
    u_prev : np.ndarray, shape (N_CONTROL,)
        Previous control u[k-1]
    cfg : ControllerConfig
        Controller configuration (contains rho, eta)
    engine_wrapper : EngineWrapper, optional
        Engine wrapper for computing mass flows (if not provided, uses mdot_F/mdot_O)
    mdot_F : float, optional
        Fuel mass flow [kg/s] (required if engine_wrapper not provided)
    mdot_O : float, optional
        Oxidizer mass flow [kg/s] (required if engine_wrapper not provided)
    dt : float, optional
        Time step [s] (defaults to cfg.dt)
    
    Notes:
    ------
    Mutates state.w_bar and state.beta in place.
    
    Algorithm:
    1. Compute predicted state: x_pred = f(x_prev, u_prev)
    2. Compute residual: residual = x_meas - x_pred
    3. Update bounds: w_bar = rho * w_bar + (1 - rho) * abs(residual)
    4. Inflate: w_bar *= eta
    5. Update bias (optional): beta = rho_beta * beta + (1 - rho_beta) * residual
    """
    if dt is None:
        dt = cfg.dt
    
    # Get mass flows
    if engine_wrapper is not None:
        # Estimate from current tank/ullage pressures
        # Engine performance depends on tank pressures (P_u), not feed pressures (P_d)
        from .dynamics import IDX_P_U_F, IDX_P_U_O
        eng_est = engine_wrapper.estimate_from_pressures(
            x_meas[IDX_P_U_F],  # P_u_F (tank/ullage pressure)
            x_meas[IDX_P_U_O],  # P_u_O (tank/ullage pressure)
        )
        mdot_F = eng_est.mdot_F
        mdot_O = eng_est.mdot_O
    
    if mdot_F is None or mdot_O is None:
        raise ValueError("Must provide either engine_wrapper or both mdot_F and mdot_O")
    
    # Create dynamics parameters
    from .dynamics import DynamicsParams
    params = DynamicsParams.from_config(cfg)
    
    # Compute predicted state: x_pred = f(x_prev, u_prev)
    x_pred = step(x_prev, u_prev, dt, params, mdot_F, mdot_O)
    
    # Compute residual: residual = x_meas - x_pred
    residual = x_meas - x_pred
    
    # Initialize w_bar as array if not already (for backward compatibility)
    if not hasattr(state, 'w_bar_array') or state.w_bar_array is None:
        # Initialize from dict or zeros
        if isinstance(state.w_bar, dict):
            # Convert from dict format (legacy)
            state.w_bar_array = np.zeros(N_STATE, dtype=np.float64)
        else:
            state.w_bar_array = np.zeros(N_STATE, dtype=np.float64)
    
    # Update bounds: w_bar = rho * w_bar + (1 - rho) * abs(residual)
    state.w_bar_array = cfg.rho * state.w_bar_array + (1 - cfg.rho) * np.abs(residual)
    
    # Inflate: w_bar *= (1 + eta)
    # eta is robustness margin, so multiply by (1 + eta) to add margin
    state.w_bar_array *= (1.0 + cfg.eta)
    
    # Ensure non-negative
    state.w_bar_array = np.maximum(state.w_bar_array, 0.0)
    
    # Update disturbance bias beta (optional, as EWMA of residuals)
    # Use same rho for bias update (could use different parameter)
    rho_beta = cfg.rho  # Could be separate parameter
    state.beta = rho_beta * state.beta + (1 - rho_beta) * np.mean(residual)
    
    # Also update dict format for backward compatibility
    # Store per-state-component bounds in dict with state names
    state_names = [
        "P_copv", "P_reg", "P_u_F", "P_u_O",
        "P_d_F", "P_d_O", "V_u_F", "V_u_O"
    ]
    state.w_bar = {name: float(state.w_bar_array[i]) for i, name in enumerate(state_names)}


def tube_propagate(
    x_lo: np.ndarray,
    x_hi: np.ndarray,
    u: np.ndarray,
    w_bar: np.ndarray,
    dt: float,
    params: DynamicsParams,
    mdot_F: float,
    mdot_O: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Propagate uncertainty tube through dynamics.
    
    Computes lower and upper bounds of state uncertainty after one step:
    - x_lo_next = f(x_lo, u) - w_bar
    - x_hi_next = f(x_hi, u) + w_bar
    
    Parameters:
    -----------
    x_lo : np.ndarray, shape (N_STATE,)
        Lower bound of state uncertainty
    x_hi : np.ndarray, shape (N_STATE,)
        Upper bound of state uncertainty
    u : np.ndarray, shape (N_CONTROL,)
        Control input
    w_bar : np.ndarray, shape (N_STATE,)
        Residual bounds (uncertainty per state component)
    dt : float
        Time step [s]
    params : DynamicsParams
        Dynamics parameters
    mdot_F : float
        Fuel mass flow [kg/s]
    mdot_O : float
        Oxidizer mass flow [kg/s]
    
    Returns:
    --------
    x_lo_next : np.ndarray, shape (N_STATE,)
        Lower bound of next state uncertainty
    x_hi_next : np.ndarray, shape (N_STATE,)
        Upper bound of next state uncertainty
    
    Notes:
    ------
    This implements a simple interval propagation. For more sophisticated
    methods (e.g., zonotopes, polytopes), see advanced robust control literature.
    """
    # Validate inputs
    if x_lo.shape != (N_STATE,) or x_hi.shape != (N_STATE,):
        raise ValueError(f"State bounds must have shape ({N_STATE},), got {x_lo.shape} and {x_hi.shape}")
    if w_bar.shape != (N_STATE,):
        raise ValueError(f"w_bar must have shape ({N_STATE},), got {w_bar.shape}")
    
    # Validate x_lo <= x_hi
    if not np.all(x_lo <= x_hi):
        raise ValueError("x_lo must be <= x_hi element-wise")
    
    # Propagate lower bound: x_lo_next = f(x_lo, u) - w_bar
    x_lo_next = step(x_lo, u, dt, params, mdot_F, mdot_O) - w_bar
    
    # Propagate upper bound: x_hi_next = f(x_hi, u) + w_bar
    x_hi_next = step(x_hi, u, dt, params, mdot_F, mdot_O) + w_bar
    
    # Ensure x_lo_next <= x_hi_next (may be violated due to nonlinearity)
    # Clamp to maintain valid interval
    x_lo_next = np.minimum(x_lo_next, x_hi_next)
    x_hi_next = np.maximum(x_lo_next, x_hi_next)
    
    # Ensure non-negative for pressures and volumes
    x_lo_next = np.maximum(x_lo_next, 0.0)
    
    return x_lo_next, x_hi_next


def get_w_bar_array(state: ControllerState) -> np.ndarray:
    """
    Get w_bar as numpy array (per-state-component bounds).
    
    Parameters:
    -----------
    state : ControllerState
        Controller state
    
    Returns:
    --------
    w_bar : np.ndarray, shape (N_STATE,)
        Residual bounds for each state component
    """
    if hasattr(state, 'w_bar_array') and state.w_bar_array is not None:
        return state.w_bar_array.copy()
    
    # Convert from dict format if needed
    if isinstance(state.w_bar, dict):
        state_names = [
            "P_copv", "P_reg", "P_u_F", "P_u_O",
            "P_d_F", "P_d_O", "V_u_F", "V_u_O"
        ]
        w_bar_array = np.zeros(N_STATE, dtype=np.float64)
        for i, name in enumerate(state_names):
            w_bar_array[i] = state.w_bar.get(name, 0.0)
        return w_bar_array
    
    # Default: zeros
    return np.zeros(N_STATE, dtype=np.float64)


def set_w_bar_array(state: ControllerState, w_bar: np.ndarray) -> None:
    """
    Set w_bar from numpy array.
    
    Parameters:
    -----------
    state : ControllerState
        Controller state (mutated in place)
    w_bar : np.ndarray, shape (N_STATE,)
        Residual bounds for each state component
    """
    if w_bar.shape != (N_STATE,):
        raise ValueError(f"w_bar must have shape ({N_STATE},), got {w_bar.shape}")
    
    state.w_bar_array = w_bar.copy()
    
    # Also update dict format for backward compatibility
    state_names = [
        "P_copv", "P_reg", "P_u_F", "P_u_O",
        "P_d_F", "P_d_O", "V_u_F", "V_u_O"
    ]
    state.w_bar = {name: float(w_bar[i]) for i, name in enumerate(state_names)}

