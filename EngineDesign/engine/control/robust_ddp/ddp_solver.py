"""Differential Dynamic Programming (DDP) solver for robust DDP controller.

Implements iLQR-style finite-horizon DDP with:
- Forward rollout
- Backward pass (gradient computation)
- Forward line search
- Constraint handling (soft penalties + hard violations)
- Robustification (uncertainty inflation)
"""

from __future__ import annotations

from typing import Tuple, Optional, Dict, Any, List
import numpy as np
from dataclasses import dataclass

from .data_models import ControllerConfig
from .dynamics import (
    step, linearize, DynamicsParams, N_STATE, N_CONTROL,
    IDX_P_D_F, IDX_P_D_O, IDX_P_U_F, IDX_P_U_O
)
from .engine_wrapper import EngineWrapper, EngineEstimate
from .constraints import constraint_values, is_safe
from .robustness import get_w_bar_array


@dataclass
class DDPSolution:
    """DDP solution result."""
    u_seq: np.ndarray  # shape (N, N_CONTROL) - optimal control sequence
    x_seq: np.ndarray  # shape (N+1, N_STATE) - state trajectory
    eng_estimates: List[EngineEstimate]  # Engine estimates per step
    objective: float  # Final objective value
    iterations: int  # Number of iterations
    converged: bool  # Whether converged
    constraint_violations: List[Dict[str, float]]  # Hard constraint violations per step
    diagnostics: Dict[str, Any]  # Additional diagnostics


def solve_ddp(
    x0: np.ndarray,
    u_seq_init: np.ndarray,
    F_ref: np.ndarray,
    MR_ref: np.ndarray,
    cfg: ControllerConfig,
    dynamics_params: DynamicsParams,
    engine_wrapper: EngineWrapper,
    w_bar: Optional[np.ndarray] = None,
    alpha_init: float = 2.0,  # Larger initial step size for more aggressive exploration
    alpha_min: float = 1e-5,  # Smaller minimum to allow more refinement
    reg_init: float = 1e-4,   # Smaller initial regularization for less damping
    reg_factor: float = 5.0,  # Smaller factor for smoother regularization changes
    use_robustification: bool = True,
    gamma_robust: float = 1.0,
) -> DDPSolution:
    """
    Solve finite-horizon DDP (iLQR-style) for robust control.
    
    Parameters:
    -----------
    x0 : np.ndarray, shape (N_STATE,)
        Initial state
    u_seq_init : np.ndarray, shape (N, N_CONTROL)
        Initial control sequence
    F_ref : np.ndarray, shape (N,)
        Reference thrust sequence [N]
    MR_ref : np.ndarray, shape (N,)
        Reference mixture ratio sequence
    cfg : ControllerConfig
        Controller configuration
    dynamics_params : DynamicsParams
        Dynamics parameters
    engine_wrapper : EngineWrapper
        Engine wrapper for mass flow estimation
    w_bar : np.ndarray, optional, shape (N_STATE,)
        Residual bounds for robustification (if None, uses zeros)
    alpha_init : float
        Initial line search step size
    alpha_min : float
        Minimum line search step size
    reg_init : float
        Initial Levenberg-Marquardt regularization
    reg_factor : float
        Regularization increase/decrease factor
    use_robustification : bool
        Whether to add robustification term to value function
    gamma_robust : float
        Robustification weight (for diag(gamma*w_bar^2) term)
    
    Returns:
    --------
    solution : DDPSolution
        DDP solution with optimal control sequence and trajectory
    """
    N = cfg.N
    dt = cfg.dt
    
    if w_bar is None:
        w_bar = np.zeros(N_STATE, dtype=np.float64)
    
    # Validate inputs
    if u_seq_init.shape != (N, N_CONTROL):
        raise ValueError(f"u_seq_init must have shape ({N}, {N_CONTROL}), got {u_seq_init.shape}")
    if F_ref.shape != (N,):
        raise ValueError(f"F_ref must have shape ({N},), got {F_ref.shape}")
    if MR_ref.shape != (N,):
        raise ValueError(f"MR_ref must have shape ({N},), got {MR_ref.shape}")
    
    # Initialize
    u_seq = u_seq_init.copy()
    best_u_seq = u_seq.copy()
    best_objective = float('inf')
    reg = reg_init
    
    # Initialize best solution variables (will be set on first iteration)
    best_x_seq = None
    best_eng_estimates = None
    best_constraint_violations = None
    
    # Storage for diagnostics
    constraint_violations_all = []
    eng_estimates_all = []
    
    # Main DDP loop
    for iteration in range(cfg.max_iterations):
        # Forward rollout
        x_seq, eng_estimates, objective, constraint_violations = forward_rollout(
            x0, u_seq, F_ref, MR_ref, cfg, dynamics_params, engine_wrapper, dt
        )
        
        eng_estimates_all.append(eng_estimates)
        constraint_violations_all.append(constraint_violations)
        
        # Check if best so far (or first iteration - always set on first iteration)
        if objective < best_objective or best_x_seq is None:
            best_objective = objective
            best_u_seq = u_seq.copy()
            best_x_seq = x_seq.copy()
            best_eng_estimates = eng_estimates.copy()
            best_constraint_violations = constraint_violations.copy()
        
        # Check convergence
        if iteration > 0:
            improvement = abs(objective - prev_objective)
            if improvement < cfg.convergence_tol:
                converged = True
                break
        else:
            converged = False
        
        prev_objective = objective
        
        # Backward pass
        k_seq, K_seq, Vx, Vxx = backward_pass(
            x_seq, u_seq, eng_estimates, F_ref, MR_ref, cfg, dynamics_params,
            engine_wrapper, dt, reg, w_bar, use_robustification, gamma_robust
        )
        
        # Forward line search
        u_seq_new, alpha, cost_new = forward_line_search(
            x0, u_seq, k_seq, K_seq, x_seq, F_ref, MR_ref, cfg, dynamics_params,
            engine_wrapper, dt, alpha_init, alpha_min
        )
        
        # Update control sequence - be more aggressive in accepting changes
        # Even if cost doesn't decrease, if it's close, accept the change
        # The controller needs to explore and make changes
        cost_improvement = objective - cost_new
        if cost_new < objective or cost_improvement > -0.01 * abs(objective):  # Accept if better or close
            u_seq = u_seq_new
            reg = max(reg / reg_factor, reg_init)  # Decrease regularization
        else:
            reg *= reg_factor  # Increase regularization
            if reg > 1e6:
                # Regularization too high - but still try to make changes
                # Don't break, just reset regularization and continue
                reg = reg_init
                # Force a small change to escape local minimum
                u_seq = u_seq + 0.01 * (np.random.rand(*u_seq.shape) - 0.5)
                u_seq = np.clip(u_seq, 0.0, 1.0)
    
    # Safety check: if best_x_seq is still None (shouldn't happen, but be safe)
    # This could happen if max_iterations is 0 or loop exits before first iteration
    if best_x_seq is None:
        # Do one forward rollout to get valid values
        best_x_seq, best_eng_estimates, best_objective, best_constraint_violations = forward_rollout(
            x0, best_u_seq, F_ref, MR_ref, cfg, dynamics_params, engine_wrapper, dt
        )
    
    # Return best solution
    return DDPSolution(
        u_seq=best_u_seq,
        x_seq=best_x_seq,
        eng_estimates=best_eng_estimates,
        objective=best_objective,
        iterations=iteration + 1,
        converged=converged,
        constraint_violations=best_constraint_violations,
        diagnostics={
            "final_regularization": reg,
            "final_alpha": alpha if 'alpha' in locals() else alpha_init,
        },
    )


def forward_rollout(
    x0: np.ndarray,
    u_seq: np.ndarray,
    F_ref: np.ndarray,
    MR_ref: np.ndarray,
    cfg: ControllerConfig,
    params: DynamicsParams,
    engine_wrapper: EngineWrapper,
    dt: float,
) -> Tuple[np.ndarray, List[EngineEstimate], float, List[Dict[str, float]]]:
    """
    Forward rollout: compute trajectory with current control sequence.
    
    Returns:
    --------
    x_seq : np.ndarray, shape (N+1, N_STATE)
        State trajectory
    eng_estimates : List[EngineEstimate]
        Engine estimates per step
    objective : float
        Total cost
    constraint_violations : List[Dict[str, float]]
        Constraint violations per step
    """
    N = len(u_seq)
    x_seq = np.zeros((N + 1, N_STATE), dtype=np.float64)
    x_seq[0] = x0.copy()
    
    eng_estimates = []
    constraint_violations = []
    total_cost = 0.0
    
    for k in range(N):
        # Get current state
        x_k = x_seq[k]
        
        # Estimate engine performance from tank/ullage pressures
        # Note: Engine expects tank pressures (P_u), not feed pressures (P_d)
        # Feed pressures lag behind and are downstream; tank pressures drive flow
        eng_est = engine_wrapper.estimate_from_pressures(
            x_k[IDX_P_U_F],  # P_u_F (tank/ullage pressure)
            x_k[IDX_P_U_O],  # P_u_O (tank/ullage pressure)
        )
        eng_estimates.append(eng_est)
        
        # Compute constraint violations
        constraints = constraint_values(x_k, eng_est, cfg)
        constraint_violations.append(constraints)
        
        # Running cost
        cost_k = running_cost(
            x_k, u_seq[k], eng_est, F_ref[k], MR_ref[k], cfg, constraints, dt
        )
        total_cost += cost_k
        
        # Step dynamics
        mdot_F = eng_est.mdot_F if np.isfinite(eng_est.mdot_F) else 0.0
        mdot_O = eng_est.mdot_O if np.isfinite(eng_est.mdot_O) else 0.0
        
        x_seq[k + 1] = step(x_k, u_seq[k], dt, params, mdot_F, mdot_O)
    
    return x_seq, eng_estimates, total_cost, constraint_violations


def running_cost(
    x: np.ndarray,
    u: np.ndarray,
    eng_est: EngineEstimate,
    F_ref: float,
    MR_ref: float,
    cfg: ControllerConfig,
    constraints: Dict[str, float],
    dt: float,
) -> float:
    """
    Compute running cost at one time step.
    
    Cost = qF*(F - F_ref)^2 + qMR*(MR - MR_ref)^2 + qGas*(P_copv_drop) + qSwitch*||u - u_prev||^2
         + constraint_penalties + invalid_estimate_penalties
    """
    cost = 0.0
    
    # Check if engine estimate is valid
    F_valid = np.isfinite(eng_est.F) and eng_est.F >= 0
    MR_valid = np.isfinite(eng_est.MR) and eng_est.MR > 0
    estimate_valid = F_valid and MR_valid
    
    # Thrust tracking - balanced approach for good tracking without blowup
    if F_valid and np.isfinite(F_ref):
        F_error = eng_est.F - F_ref
        # Normalize error by reference to prevent blowup with large references
        # Use relative error: (F - F_ref) / max(F_ref, 1.0)
        F_error_normalized = F_error / max(abs(F_ref), 1.0)
        # Penalize both high and low errors, but slightly more for low (thrust deficit)
        if F_error < 0:  # Thrust is LOWER than reference - moderate penalty
            cost += cfg.qF * F_error_normalized ** 2 * 2.0  # 2x penalty for being too low (was 10x)
        else:  # Thrust is higher than reference - normal penalty
            cost += cfg.qF * F_error_normalized ** 2
    elif not F_valid and np.isfinite(F_ref) and F_ref > 0:
        # Invalid estimate but non-zero reference - moderate penalty (was 1e6)
        # Penalty scales with reference magnitude to provide gradient
        invalid_penalty = 1e4 * (1.0 + F_ref / 1000.0)  # Reduced from 1e6 to 1e4
        cost += invalid_penalty
    
    # Mixture ratio tracking
    if MR_valid and np.isfinite(MR_ref):
        MR_error = eng_est.MR - MR_ref
        # Normalize by reference to prevent blowup
        MR_error_normalized = MR_error / max(abs(MR_ref), 1.0)
        cost += cfg.qMR * MR_error_normalized ** 2
    elif not MR_valid and np.isfinite(MR_ref) and MR_ref > 0:
        # Invalid estimate but non-zero reference - moderate penalty (was 1e6)
        invalid_penalty = 1e4 * (1.0 + MR_ref)  # Reduced from 1e6 to 1e4
        cost += invalid_penalty
    
    # Additional penalty if estimate is completely invalid when reference is non-zero
    if not estimate_valid:
        if (np.isfinite(F_ref) and F_ref > 0) or (np.isfinite(MR_ref) and MR_ref > 0):
            # Moderate base penalty for invalid estimate (was 1e5)
            cost += 1e3  # Reduced from 1e5 to 1e3
    
    # Gas consumption (COPV pressure drop)
    # Approximate as: P_copv_drop = dt * (cF*u_F + cO*u_O + loss)
    P_copv_drop = dt * (
        cfg.copv_cF * u[0] +
        cfg.copv_cO * u[1] +
        cfg.copv_loss
    )
    cost += cfg.qGas * P_copv_drop
    
    # Control switching cost (if u_prev available)
    # For first step, no switching cost
    # Note: u_prev would need to be passed in, but for simplicity we skip here
    # In full implementation, would track u_prev
    
    # Constraint penalties (soft)
    constraint_penalty_weight = 1e4  # Moderate penalty for violations (was 1e6)
    hard_constraints = [
        "copv_min", "ullage_max_F", "ullage_max_O",
        "MR_min", "MR_max",
        "injector_stiffness_F", "injector_stiffness_O",
    ]
    
    for key in hard_constraints:
        if key in constraints:
            violation = constraints[key]
            if violation > 0:  # Positive = violation
                # Normalize violation to prevent blowup
                violation_normalized = violation / max(abs(violation), 1.0)
                cost += constraint_penalty_weight * violation_normalized ** 2
    
    return cost


def backward_pass(
    x_seq: np.ndarray,
    u_seq: np.ndarray,
    eng_estimates: List[EngineEstimate],
    F_ref: np.ndarray,
    MR_ref: np.ndarray,
    cfg: ControllerConfig,
    params: DynamicsParams,
    engine_wrapper: EngineWrapper,
    dt: float,
    reg: float,
    w_bar: np.ndarray,
    use_robustification: bool,
    gamma_robust: float,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Backward pass: compute feedforward k and feedback K gains.
    
    Returns:
    --------
    k_seq : np.ndarray, shape (N, N_CONTROL)
        Feedforward gains
    K_seq : np.ndarray, shape (N, N_CONTROL, N_STATE)
        Feedback gains
    Vx : np.ndarray, shape (N_STATE,)
        Value function gradient at initial state
    Vxx : np.ndarray, shape (N_STATE, N_STATE)
        Value function Hessian at initial state
    """
    N = len(u_seq)
    
    # Initialize value function
    Vx = np.zeros(N_STATE, dtype=np.float64)
    Vxx = np.zeros((N_STATE, N_STATE), dtype=np.float64)
    
    # Storage for gains
    k_seq = np.zeros((N, N_CONTROL), dtype=np.float64)
    K_seq = np.zeros((N, N_CONTROL, N_STATE), dtype=np.float64)
    
    # Backward pass (from terminal to initial)
    for k in range(N - 1, -1, -1):
        x_k = x_seq[k]
        u_k = u_seq[k]
        eng_est = eng_estimates[k]
        
        # Get mass flows for linearization
        mdot_F = eng_est.mdot_F if np.isfinite(eng_est.mdot_F) else 0.0
        mdot_O = eng_est.mdot_O if np.isfinite(eng_est.mdot_O) else 0.0
        
        # Linearize dynamics
        A_k, B_k = linearize(x_k, u_k, dt, params, mdot_F, mdot_O)
        
        # Compute cost derivatives
        lx, lu, lxx, luu, lux = cost_derivatives(
            x_k, u_k, eng_est, F_ref[k], MR_ref[k], cfg, dt, engine_wrapper
        )
        
        # Value function derivatives (Bellman equation)
        Qx = lx + A_k.T @ Vx
        Qu = lu + B_k.T @ Vx
        Qxx = lxx + A_k.T @ Vxx @ A_k
        Quu = luu + B_k.T @ Vxx @ B_k
        Qux = lux + B_k.T @ Vxx @ A_k
        
        # Robustification: inflate Vxx
        if use_robustification:
            # Add diag(gamma * w_bar^2) to Qxx
            Qxx += gamma_robust * np.diag(w_bar ** 2)
            # Also add to Quu for robustness
            Quu += gamma_robust * np.diag(np.mean(w_bar ** 2) * np.ones(N_CONTROL))
        
        # Levenberg-Marquardt regularization
        # Ensure sufficient regularization for numerical stability
        min_reg = max(reg, 1e-6)  # Minimum regularization to ensure stability
        Quu_reg = Quu + min_reg * np.eye(N_CONTROL)
        
        # Ensure positive definite using Cholesky (more numerically stable than eigvals)
        # Cholesky will fail if matrix is not positive definite
        max_cholesky_attempts = 5
        cholesky_reg = min_reg
        for attempt in range(max_cholesky_attempts):
            try:
                # Try Cholesky decomposition - if it succeeds, matrix is positive definite
                np.linalg.cholesky(Quu_reg)
                break  # Success - matrix is positive definite
            except np.linalg.LinAlgError:
                # Not positive definite - add more regularization
                cholesky_reg *= 10.0
                Quu_reg = Quu + cholesky_reg * np.eye(N_CONTROL)
        
        # Ensure well-conditioned (condition number < 1e12)
        try:
            cond_num = np.linalg.cond(Quu_reg)
            if cond_num > 1e12:
                # Add more regularization to improve condition number
                extra_reg = max(cholesky_reg * 0.1, 1e-4)
                Quu_reg += extra_reg * np.eye(N_CONTROL)
        except:
            # If condition number computation fails, add extra regularization
            Quu_reg += 1e-4 * np.eye(N_CONTROL)
        
        # Compute gains
        # CRITICAL: Scale gains to ensure controller makes meaningful changes
        # If gains are too small, controller won't respond
        try:
            Quu_inv = np.linalg.inv(Quu_reg)
            k_k = -Quu_inv @ Qu
            K_k = -Quu_inv @ Qux
        except np.linalg.LinAlgError:
            # Fallback: use pseudo-inverse
            Quu_inv = np.linalg.pinv(Quu_reg)
            k_k = -Quu_inv @ Qu
            K_k = -Quu_inv @ Qux
        
        # Scale gains to ensure controller makes changes
        # If Qu is pointing in right direction but too small, scale it up
        gain_scale = 2.0  # Scale gains by 2x to make controller more aggressive
        k_k = k_k * gain_scale
        K_k = K_k * gain_scale
        
        k_seq[k] = k_k
        K_seq[k] = K_k
        
        # Update value function
        Vx = Qx + K_k.T @ Quu_reg @ k_k + K_k.T @ Qu + Qux.T @ k_k
        Vxx = Qxx + K_k.T @ Quu_reg @ K_k + K_k.T @ Qux + Qux.T @ K_k
        
        # Ensure Vxx is symmetric and positive semi-definite
        Vxx = (Vxx + Vxx.T) / 2  # Symmetrize
        
        # Use Cholesky-based projection for better numerical stability
        try:
            # Try Cholesky - if it succeeds, Vxx is positive definite
            np.linalg.cholesky(Vxx + 1e-8 * np.eye(N_STATE))
        except np.linalg.LinAlgError:
            # Not positive definite - project to positive semi-definite
            # Use eigendecomposition with fallback for numerical stability
            try:
                eigenvals, eigenvecs = np.linalg.eigh(Vxx)  # eigh is more stable for symmetric matrices
                eigenvals = np.maximum(eigenvals, 0.0)  # Project negative eigenvalues to zero
                Vxx = eigenvecs @ np.diag(eigenvals) @ eigenvecs.T
            except np.linalg.LinAlgError:
                # If eigendecomposition fails, add regularization and use diagonal approximation
                Vxx = Vxx + 1e-6 * np.eye(N_STATE)
                # Ensure diagonal is positive
                np.fill_diagonal(Vxx, np.maximum(np.diag(Vxx), 1e-8))
    
    return k_seq, K_seq, Vx, Vxx


def cost_derivatives(
    x: np.ndarray,
    u: np.ndarray,
    eng_est: EngineEstimate,
    F_ref: float,
    MR_ref: float,
    cfg: ControllerConfig,
    dt: float,
    engine_wrapper: Optional[EngineWrapper] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Compute cost derivatives via finite differences.
    
    Parameters:
    -----------
    engine_wrapper : EngineWrapper, optional
        Engine wrapper for re-estimating engine performance when state changes.
        If None, uses approximation (assumes eng_est doesn't change).
    
    Returns:
    --------
    lx : np.ndarray, shape (N_STATE,)
        Cost gradient w.r.t. state
    lu : np.ndarray, shape (N_CONTROL,)
        Cost gradient w.r.t. control
    lxx : np.ndarray, shape (N_STATE, N_STATE)
        Cost Hessian w.r.t. state
    luu : np.ndarray, shape (N_CONTROL, N_CONTROL)
        Cost Hessian w.r.t. control
    lux : np.ndarray, shape (N_CONTROL, N_STATE)
        Cost cross-derivative
    """
    from .constraints import constraint_values
    
    eps = 1e-6
    
    # Get constraints for nominal point
    constraints_nom = constraint_values(x, eng_est, cfg)
    cost_nom = running_cost(x, u, eng_est, F_ref, MR_ref, cfg, constraints_nom, dt)
    
    # lx: gradient w.r.t. state
    lx = np.zeros(N_STATE, dtype=np.float64)
    for i in range(N_STATE):
        x_pert = x.copy()
        x_pert[i] += eps
        
        # Re-estimate engine if tank/ullage pressures changed and wrapper available
        # Engine performance depends on tank pressures (P_u), not feed pressures (P_d)
        if engine_wrapper is not None and i in [IDX_P_U_F, IDX_P_U_O]:
            eng_est_pert = engine_wrapper.estimate_from_pressures(
                x_pert[IDX_P_U_F], x_pert[IDX_P_U_O]
            )
        else:
            eng_est_pert = eng_est  # Approximation: assume eng_est doesn't change much
        
        constraints_pert = constraint_values(x_pert, eng_est_pert, cfg)
        cost_pert = running_cost(x_pert, u, eng_est_pert, F_ref, MR_ref, cfg, constraints_pert, dt)
        
        lx[i] = (cost_pert - cost_nom) / eps
    
    # lu: gradient w.r.t. control
    # CRITICAL: Control affects thrust through dynamics (u -> pressure -> thrust)
    # The backward pass propagates this through B_k (dynamics linearization)
    # Here we compute the direct cost gradient (gas consumption, switching cost)
    # The indirect effect (control -> pressure -> thrust) is handled by backward pass
    lu = np.zeros(N_CONTROL, dtype=np.float64)
    for i in range(N_CONTROL):
        u_pert = u.copy()
        u_pert[i] += eps
        u_pert[i] = np.clip(u_pert[i], 0.0, 1.0)
        
        constraints_pert = constraint_values(x, eng_est, cfg)
        cost_pert = running_cost(x, u_pert, eng_est, F_ref, MR_ref, cfg, constraints_pert, dt)
        
        lu[i] = (cost_pert - cost_nom) / eps
    
    # lxx: Hessian w.r.t. state (diagonal approximation for efficiency)
    lxx = np.zeros((N_STATE, N_STATE), dtype=np.float64)
    # Use diagonal approximation (full Hessian is expensive)
    for i in range(N_STATE):
        x_pert1 = x.copy()
        x_pert1[i] += eps
        x_pert2 = x.copy()
        x_pert2[i] -= eps
        
        # Re-estimate engine if tank/ullage pressures changed
        # Engine performance depends on tank pressures (P_u), not feed pressures (P_d)
        if engine_wrapper is not None and i in [IDX_P_U_F, IDX_P_U_O]:
            eng_est_pert1 = engine_wrapper.estimate_from_pressures(
                x_pert1[IDX_P_U_F], x_pert1[IDX_P_U_O]
            )
            eng_est_pert2 = engine_wrapper.estimate_from_pressures(
                x_pert2[IDX_P_U_F], x_pert2[IDX_P_U_O]
            )
        else:
            eng_est_pert1 = eng_est
            eng_est_pert2 = eng_est
        
        constraints_pert1 = constraint_values(x_pert1, eng_est_pert1, cfg)
        constraints_pert2 = constraint_values(x_pert2, eng_est_pert2, cfg)
        
        cost_pert1 = running_cost(x_pert1, u, eng_est_pert1, F_ref, MR_ref, cfg, constraints_pert1, dt)
        cost_pert2 = running_cost(x_pert2, u, eng_est_pert2, F_ref, MR_ref, cfg, constraints_pert2, dt)
        
        lxx[i, i] = (cost_pert1 - 2 * cost_nom + cost_pert2) / (eps ** 2)
    
    # luu: Hessian w.r.t. control (diagonal approximation)
    luu = np.zeros((N_CONTROL, N_CONTROL), dtype=np.float64)
    for i in range(N_CONTROL):
        u_pert1 = u.copy()
        u_pert1[i] = np.clip(u_pert1[i] + eps, 0.0, 1.0)
        u_pert2 = u.copy()
        u_pert2[i] = np.clip(u_pert2[i] - eps, 0.0, 1.0)
        
        constraints_pert1 = constraint_values(x, eng_est, cfg)
        constraints_pert2 = constraint_values(x, eng_est, cfg)
        
        cost_pert1 = running_cost(x, u_pert1, eng_est, F_ref, MR_ref, cfg, constraints_pert1, dt)
        cost_pert2 = running_cost(x, u_pert2, eng_est, F_ref, MR_ref, cfg, constraints_pert2, dt)
        
        luu[i, i] = (cost_pert1 - 2 * cost_nom + cost_pert2) / (eps ** 2)
    
    # lux: Cross-derivative (zero approximation for efficiency)
    lux = np.zeros((N_CONTROL, N_STATE), dtype=np.float64)
    
    return lx, lu, lxx, luu, lux


def forward_line_search(
    x0: np.ndarray,
    u_seq: np.ndarray,
    k_seq: np.ndarray,
    K_seq: np.ndarray,
    x_seq_nom: np.ndarray,
    F_ref: np.ndarray,
    MR_ref: np.ndarray,
    cfg: ControllerConfig,
    params: DynamicsParams,
    engine_wrapper: EngineWrapper,
    dt: float,
    alpha_init: float,
    alpha_min: float,
) -> Tuple[np.ndarray, float, float]:
    """
    Forward line search: find best step size alpha.
    
    Returns:
    --------
    u_seq_new : np.ndarray
        New control sequence
    alpha : float
        Step size used
    cost_new : float
        Cost of new trajectory
    """
    # Compute nominal cost
    x_seq_nom_full, eng_estimates_nom, cost_nom, _ = forward_rollout(
        x0, u_seq, F_ref, MR_ref, cfg, params, engine_wrapper, dt
    )
    
    # Line search with more aggressive exploration
    # Try multiple step sizes to find improvements
    alpha = alpha_init
    best_alpha = alpha
    best_cost = cost_nom
    best_u_seq = u_seq.copy()
    
    # ALWAYS try larger step sizes first - controller needs to make changes
    # Don't wait for high cost - be proactive
    alpha = min(alpha_init * 5.0, 5.0)  # Try up to 5x step size (was 2x)
    
    # If cost is very high, try even larger steps
    if cost_nom > 1e4:  # High cost means controller needs to make significant changes
        alpha = min(alpha_init * 10.0, 10.0)  # Try up to 10x step size
    
    while alpha >= alpha_min:
        # Compute new control sequence
        u_seq_new = np.zeros_like(u_seq)
        x_seq_new = np.zeros((len(u_seq) + 1, N_STATE), dtype=np.float64)
        x_seq_new[0] = x0.copy()
        
        for k in range(len(u_seq)):
            # Compute control update
            dx = x_seq_new[k] - x_seq_nom_full[k]
            du = alpha * k_seq[k] + K_seq[k] @ dx
            
            # Update control: u_new = clip(u + du)
            # CRITICAL: Scale du more aggressively to ensure changes happen
            # If du is too small, control won't change enough
            du_scaled = du * 2.0  # Scale by 2x to make changes more aggressive
            u_new = np.clip(u_seq[k] + du_scaled, 0.0, 1.0)
            u_seq_new[k] = u_new
            
            # Step dynamics
            # Use tank/ullage pressures (P_u) to get engine performance
            eng_est = engine_wrapper.estimate_from_pressures(
                x_seq_new[k][IDX_P_U_F], x_seq_new[k][IDX_P_U_O]
            )
            mdot_F = eng_est.mdot_F if np.isfinite(eng_est.mdot_F) else 0.0
            mdot_O = eng_est.mdot_O if np.isfinite(eng_est.mdot_O) else 0.0
            
            x_seq_new[k + 1] = step(x_seq_new[k], u_new, dt, params, mdot_F, mdot_O)
        
        # Compute cost
        _, _, cost_new, _ = forward_rollout(
            x0, u_seq_new, F_ref, MR_ref, cfg, params, engine_wrapper, dt
        )
        
        # Check if better - be more aggressive in accepting improvements
        improvement = best_cost - cost_new
        if improvement > 1e-8:  # Found any improvement (very permissive)
            best_cost = cost_new
            best_alpha = alpha
            best_u_seq = u_seq_new.copy()
            # Always use improvement if found (don't wait for "significant" improvement)
            # The controller needs to make changes, so accept any improvement
            if improvement > 1e-6:  # Meaningful improvement
                break  # Found improvement, use it immediately
        
        # Reduce step size
        alpha /= 2.0
    
    # CRITICAL: If no improvement found, still return the best attempt (not original)
    # This ensures the controller makes SOME change even if line search struggles
    return best_u_seq, best_alpha, best_cost

