"""Safety filter for robust DDP controller.

Given proposed actuation, computes reachable tube and checks constraint violations.
If unsafe, finds best safe action from discrete candidate set.
"""

from __future__ import annotations

from typing import Optional, Tuple, List
import numpy as np

from .data_models import ControllerConfig, ControllerState
from .dynamics import (
    step, DynamicsParams, N_STATE, N_CONTROL, 
    IDX_U_F, IDX_U_O, IDX_P_U_F, IDX_P_U_O
)
from .robustness import tube_propagate, get_w_bar_array
from .constraints import is_safe, constraint_values
from .engine_wrapper import EngineWrapper, EngineEstimate


def filter_action(
    x: np.ndarray,
    proposed: np.ndarray,
    state: ControllerState,
    cfg: ControllerConfig,
    engine_wrapper: Optional[EngineWrapper] = None,
    F_ref: Optional[float] = None,
    MR_ref: Optional[float] = None,
    num_steps: int = 2,
    dt: Optional[float] = None,
) -> np.ndarray:
    """
    Filter proposed action to ensure safety.
    
    Computes reachable tube from proposed action and checks constraints.
    If unsafe, finds best safe action from discrete candidate set.
    
    Parameters:
    -----------
    x : np.ndarray, shape (N_STATE,)
        Current measured state
    proposed : np.ndarray, shape (N_CONTROL,)
        Proposed relaxed control [u_F, u_O] in [0, 1]
    state : ControllerState
        Controller state (for w_bar)
    cfg : ControllerConfig
        Controller configuration
    engine_wrapper : EngineWrapper, optional
        Engine wrapper for performance estimation
    F_ref : float, optional
        Reference thrust [N] (for cost computation)
    MR_ref : float, optional
        Reference mixture ratio (for cost computation)
    num_steps : int
        Number of steps to propagate tube (default: 2)
    dt : float, optional
        Time step [s] (defaults to cfg.dt)
    
    Returns:
    --------
    safe_action : np.ndarray, shape (N_CONTROL,)
        Safe relaxed control (may be same as proposed if safe)
    """
    if dt is None:
        dt = cfg.dt
    
    # Validate inputs
    if x.shape != (N_STATE,):
        raise ValueError(f"x must have shape ({N_STATE},), got {x.shape}")
    if proposed.shape != (N_CONTROL,):
        raise ValueError(f"proposed must have shape ({N_CONTROL},), got {proposed.shape}")
    
    # Clamp proposed to [0, 1]
    proposed = np.clip(proposed, 0.0, 1.0)
    
    # Get residual bounds
    w_bar = get_w_bar_array(state)
    
    # Check if proposed action is safe
    if _is_action_safe(x, proposed, w_bar, cfg, engine_wrapper, num_steps, dt):
        return proposed
    
    # Proposed action is unsafe: find best safe alternative
    safe_action = _find_best_safe_action(
        x, proposed, w_bar, cfg, engine_wrapper, F_ref, MR_ref, num_steps, dt
    )
    
    return safe_action


def _is_action_safe(
    x: np.ndarray,
    u: np.ndarray,
    w_bar: np.ndarray,
    cfg: ControllerConfig,
    engine_wrapper: Optional[EngineWrapper],
    num_steps: int,
    dt: float,
) -> bool:
    """
    Check if action is safe by propagating tube and checking constraints.
    
    Parameters:
    -----------
    x : np.ndarray
        Current state
    u : np.ndarray
        Control action
    w_bar : np.ndarray
        Residual bounds
    cfg : ControllerConfig
        Controller configuration
    engine_wrapper : EngineWrapper, optional
        Engine wrapper
    num_steps : int
        Number of steps to propagate
    dt : float
        Time step
    
    Returns:
    --------
    safe : bool
        True if action is safe, False otherwise
    """
    # Initialize tube
    x_lo = x.copy()
    x_hi = x.copy()
    
    # Create dynamics parameters
    params = DynamicsParams.from_config(cfg)
    
    # Propagate tube for num_steps
    for _ in range(num_steps):
        # Estimate engine performance for mass flows
        mdot_F, mdot_O = _estimate_mass_flows(x_hi, engine_wrapper)
        
        # Propagate tube
        x_lo, x_hi = tube_propagate(
            x_lo, x_hi, u, w_bar, dt, params, mdot_F, mdot_O
        )
        
        # Check if tube violates constraints
        if _tube_violates_constraints(x_lo, x_hi, cfg, engine_wrapper):
            return False
    
    return True


def _tube_violates_constraints(
    x_lo: np.ndarray,
    x_hi: np.ndarray,
    cfg: ControllerConfig,
    engine_wrapper: Optional[EngineWrapper],
) -> bool:
    """
    Check if uncertainty tube violates hard constraints.
    
    Checks worst-case (upper bound) for each constraint.
    
    Parameters:
    -----------
    x_lo : np.ndarray
        Lower bound of state tube
    x_hi : np.ndarray
        Upper bound of state tube
    cfg : ControllerConfig
        Controller configuration
    engine_wrapper : EngineWrapper, optional
        Engine wrapper
    
    Returns:
    --------
    violates : bool
        True if tube violates any hard constraint
    """
    # Check worst-case (upper bound) for pressure constraints
    # COPV minimum
    if x_hi[0] < cfg.P_copv_min:  # P_copv
        return True
    
    # Ullage maximum
    if x_hi[2] > cfg.P_u_max:  # P_u_F
        return True
    if x_hi[3] > cfg.P_u_max:  # P_u_O
        return True
    
    # Check engine constraints (need engine estimate)
    if engine_wrapper is not None:
        try:
            # Use upper bound feed pressures for worst-case
            # Use tank/ullage pressures (P_u) to get engine performance
            eng_est = engine_wrapper.estimate_from_pressures(x_hi[IDX_P_U_F], x_hi[IDX_P_U_O])
            
            # Check MR bounds
            if eng_est.MR < cfg.MR_min or eng_est.MR > cfg.MR_max:
                return True
            
            # Check injector stiffness
            dp_F = eng_est.injector_dp_F
            dp_O = eng_est.injector_dp_O
            P_ch = eng_est.P_ch
            
            if dp_F < cfg.injector_dp_frac * P_ch:
                return True
            if dp_O < cfg.injector_dp_frac * P_ch:
                return True
        except Exception:
            # If engine estimation fails, assume unsafe
            return True
    
    return False


def _find_best_safe_action(
    x: np.ndarray,
    proposed: np.ndarray,
    w_bar: np.ndarray,
    cfg: ControllerConfig,
    engine_wrapper: Optional[EngineWrapper],
    F_ref: Optional[float],
    MR_ref: Optional[float],
    num_steps: int,
    dt: float,
) -> np.ndarray:
    """
    Find best safe action from discrete candidate set.
    
    Parameters:
    -----------
    x : np.ndarray
        Current state
    proposed : np.ndarray
        Proposed action (unsafe)
    w_bar : np.ndarray
        Residual bounds
    cfg : ControllerConfig
        Controller configuration
    engine_wrapper : EngineWrapper, optional
        Engine wrapper
    F_ref : float, optional
        Reference thrust
    MR_ref : float, optional
        Reference mixture ratio
    num_steps : int
        Number of steps for tube propagation
    dt : float
        Time step
    
    Returns:
    --------
    best_action : np.ndarray
        Best safe action from candidate set
    """
    # Generate discrete candidates
    candidates = _generate_action_candidates(cfg)
    
    # Evaluate each candidate
    best_action = None
    best_cost = float('inf')
    
    for candidate in candidates:
        # Check if candidate is safe
        if not _is_action_safe(x, candidate, w_bar, cfg, engine_wrapper, num_steps, dt):
            continue  # Skip unsafe candidates
        
        # Compute cost
        cost = _compute_action_cost(
            x, candidate, cfg, engine_wrapper, F_ref, MR_ref
        )
        
        # Update best
        if cost < best_cost:
            best_cost = cost
            best_action = candidate.copy()
    
    # If no safe candidate found, return safest (all zeros)
    if best_action is None:
        return np.zeros(N_CONTROL, dtype=np.float64)
    
    return best_action


def _generate_action_candidates(cfg: ControllerConfig) -> List[np.ndarray]:
    """
    Generate discrete action candidates.
    
    For binary backend: {(0,0), (0,1), (1,0), (1,1)}
    For PWM backend: quantized duty pairs based on duty_quantization.
    
    Parameters:
    -----------
    cfg : ControllerConfig
        Controller configuration
    
    Returns:
    --------
    candidates : List[np.ndarray]
        List of candidate actions
    """
    candidates = []
    
    # Binary candidates (always include)
    binary_candidates = [
        np.array([0.0, 0.0]),
        np.array([0.0, 1.0]),
        np.array([1.0, 0.0]),
        np.array([1.0, 1.0]),
    ]
    candidates.extend(binary_candidates)
    
    # PWM candidates (quantized)
    # Generate grid based on duty_quantization
    duty_step = cfg.duty_quantization
    n_steps = int(1.0 / duty_step) + 1
    
    # Sample grid (don't include all combinations to avoid explosion)
    # Use coarser grid for PWM candidates
    pwm_step = max(duty_step * 5, 0.1)  # At least 10% steps
    pwm_values = np.linspace(0.0, 1.0, int(1.0 / pwm_step) + 1)
    
    # Add some PWM candidates (not all combinations)
    for u_F in [0.0, 0.5, 1.0]:
        for u_O in [0.0, 0.5, 1.0]:
            candidate = np.array([u_F, u_O])
            # Check if not already in binary candidates
            if not any(np.allclose(candidate, bc) for bc in binary_candidates):
                candidates.append(candidate)
    
    return candidates


def _compute_action_cost(
    x: np.ndarray,
    u: np.ndarray,
    cfg: ControllerConfig,
    engine_wrapper: Optional[EngineWrapper],
    F_ref: Optional[float],
    MR_ref: Optional[float],
) -> float:
    """
    Compute immediate cost for action.
    
    Cost = tracking error + gas penalty
    
    Parameters:
    -----------
    x : np.ndarray
        Current state
    u : np.ndarray
        Control action
    cfg : ControllerConfig
        Controller configuration
    engine_wrapper : EngineWrapper, optional
        Engine wrapper
    F_ref : float, optional
        Reference thrust
    MR_ref : float, optional
        Reference mixture ratio
    
    Returns:
    --------
    cost : float
        Action cost
    """
    cost = 0.0
    
    # Gas consumption penalty
    P_copv_drop = cfg.copv_cF * u[IDX_U_F] + cfg.copv_cO * u[IDX_U_O] + cfg.copv_loss
    cost += cfg.qGas * P_copv_drop
    
    # Tracking error (if references provided)
    if engine_wrapper is not None and (F_ref is not None or MR_ref is not None):
        try:
            # Use tank/ullage pressures (P_u) to get engine performance
            eng_est = engine_wrapper.estimate_from_pressures(x[IDX_P_U_F], x[IDX_P_U_O])
            
            if F_ref is not None:
                F_error = eng_est.F - F_ref
                cost += cfg.qF * F_error ** 2
            
            if MR_ref is not None:
                MR_error = eng_est.MR - MR_ref
                cost += cfg.qMR * MR_error ** 2
        except Exception:
            # If estimation fails, add penalty
            cost += 1e6
    
    return cost


def _estimate_mass_flows(
    x: np.ndarray,
    engine_wrapper: Optional[EngineWrapper],
) -> Tuple[float, float]:
    """
    Estimate mass flows from state.
    
    Parameters:
    -----------
    x : np.ndarray
        State vector
    engine_wrapper : EngineWrapper, optional
        Engine wrapper
    
    Returns:
    --------
    mdot_F : float
        Fuel mass flow [kg/s]
    mdot_O : float
        Oxidizer mass flow [kg/s]
    """
    if engine_wrapper is not None:
        try:
            # Use tank/ullage pressures (P_u) to get engine performance
            eng_est = engine_wrapper.estimate_from_pressures(x[IDX_P_U_F], x[IDX_P_U_O])
            mdot_F = eng_est.mdot_F if np.isfinite(eng_est.mdot_F) else 0.0
            mdot_O = eng_est.mdot_O if np.isfinite(eng_est.mdot_O) else 0.0
            return mdot_F, mdot_O
        except Exception:
            pass
    
    # Fallback: use simple model or zeros
    return 0.0, 0.0

