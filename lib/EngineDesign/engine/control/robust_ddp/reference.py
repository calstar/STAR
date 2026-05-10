"""Reference generation for robust DDP controller.

Supports two modes:
- A) Thrust command: user provides F_des(t) or piecewise schedule
- B) Altitude command: compute desired thrust from PD guidance

Computes feasible reference projection with bounds and slew rate limiting.
"""

from __future__ import annotations

from typing import Optional, Union, List, Tuple, Dict, Any
from dataclasses import dataclass
import numpy as np

from .data_models import NavState, Measurement, Command, CommandType, ControllerConfig
from .engine_wrapper import EngineWrapper, EngineEstimate
from .dynamics import IDX_P_D_F, IDX_P_D_O, IDX_P_REG, IDX_P_U_F, IDX_P_U_O


@dataclass
class Reference:
    """Reference trajectory for DDP controller."""
    F_ref: np.ndarray  # shape (N,) - Reference thrust sequence [N]
    MR_ref: np.ndarray  # shape (N,) - Reference mixture ratio sequence
    F_min: np.ndarray  # shape (N,) - Minimum feasible thrust [N]
    F_max: np.ndarray  # shape (N,) - Maximum feasible thrust [N]
    feasible: np.ndarray  # shape (N,) - Whether reference is feasible at each step


# Constants
GRAVITY = 9.81  # [m/s²]


def build_reference(
    nav: NavState,
    meas: Measurement,
    cmd: Command,
    cfg: ControllerConfig,
    horizon_N: int,
    engine_wrapper: Optional[EngineWrapper] = None,
    F_ref_prev: Optional[float] = None,
    dt: Optional[float] = None,
) -> Reference:
    """
    Build reference trajectory for DDP controller.
    
    Parameters:
    -----------
    nav : NavState
        Current navigation state (altitude, velocity, tilt, mass)
    meas : Measurement
        Current sensor measurements (pressures)
    cmd : Command
        Control command (thrust desired or altitude goal)
    cfg : ControllerConfig
        Controller configuration
    horizon_N : int
        Prediction horizon length
    engine_wrapper : EngineWrapper, optional
        Engine wrapper for estimating feasible thrust bounds
    F_ref_prev : float, optional
        Previous reference thrust (for slew rate limiting)
    dt : float, optional
        Time step [s] (defaults to cfg.dt)
    
    Returns:
    --------
    ref : Reference
        Reference trajectory with F_ref, MR_ref, bounds, and feasibility
    """
    if dt is None:
        dt = cfg.dt
    
    # Initialize arrays
    F_ref = np.zeros(horizon_N, dtype=np.float64)
    MR_ref = np.zeros(horizon_N, dtype=np.float64)
    F_min = np.zeros(horizon_N, dtype=np.float64)
    F_max = np.zeros(horizon_N, dtype=np.float64)
    feasible = np.zeros(horizon_N, dtype=bool)
    
    # Compute desired thrust based on command type
    if cmd.command_type == CommandType.THRUST_DESIRED:
        F_des_seq = _compute_thrust_command(cmd, horizon_N, dt)
    elif cmd.command_type == CommandType.ALTITUDE_GOAL:
        F_des_seq = _compute_altitude_command(
            nav, cmd.altitude_goal, horizon_N, dt, cfg
        )
    else:
        raise ValueError(f"Unknown command type: {cmd.command_type}")
    
    # Compute feasible bounds at each step
    # For now, use current state to estimate bounds (simplified)
    # In full implementation, would propagate state forward
    current_state = _measurement_to_state(meas)
    
    # Estimate current engine performance
    eng_est_current = None
    if engine_wrapper is not None:
        try:
            # Use tank/ullage pressures (P_u) to get engine performance
            # Engine expects tank pressures, not feed pressures
            eng_est_current = engine_wrapper.estimate_from_pressures(
                meas.P_u_fuel, meas.P_u_ox
            )
        except Exception:
            pass
    
    # Compute bounds (simplified - uses current state)
    # In full implementation, would compute time-varying bounds
    F_min_val, F_max_val = _estimate_thrust_bounds(
        current_state, meas, cfg, engine_wrapper, eng_est_current
    )
    
    # Project to feasible reference with slew rate limiting
    F_ref[0] = _project_thrust(
        F_des_seq[0],
        F_min_val,
        F_max_val,
        F_ref_prev if F_ref_prev is not None else F_des_seq[0],
        dt,
        cfg,
    )
    
    # Propagate forward (simplified - assumes bounds constant)
    # In full implementation, would update bounds based on predicted state
    for k in range(1, horizon_N):
        F_ref[k] = _project_thrust(
            F_des_seq[k],
            F_min_val,
            F_max_val,
            F_ref[k - 1],
            dt,
            cfg,
        )
    
    # Set mixture ratio reference (default to mid-band)
    MR_mid = (cfg.MR_min + cfg.MR_max) / 2.0
    MR_ref[:] = MR_mid
    
    # Set bounds (constant for now)
    F_min[:] = F_min_val
    F_max[:] = F_max_val
    
    # Check feasibility
    feasible[:] = (F_ref >= F_min) & (F_ref <= F_max)
    
    return Reference(
        F_ref=F_ref,
        MR_ref=MR_ref,
        F_min=F_min,
        F_max=F_max,
        feasible=feasible,
    )


def _compute_thrust_command(
    cmd: Command,
    horizon_N: int,
    dt: float,
) -> np.ndarray:
    """
    Compute thrust command sequence from Command.
    
    Parameters:
    -----------
    cmd : Command
        Command with thrust_desired
    horizon_N : int
        Horizon length
    dt : float
        Time step [s]
    
    Returns:
    --------
    F_des : np.ndarray, shape (horizon_N,)
        Desired thrust sequence [N]
    """
    if cmd.command_type != CommandType.THRUST_DESIRED:
        raise ValueError("Command must be THRUST_DESIRED")
    
    if cmd.thrust_desired is None:
        raise ValueError("thrust_desired must be provided")
    
    F_des = np.zeros(horizon_N, dtype=np.float64)
    
    if isinstance(cmd.thrust_desired, (int, float)):
        # Constant thrust
        F_des[:] = float(cmd.thrust_desired)
    elif isinstance(cmd.thrust_desired, list):
        # Piecewise schedule: list of (time, thrust) pairs
        times = np.array([t for t, _ in cmd.thrust_desired])
        thrusts = np.array([F for _, F in cmd.thrust_desired])
        
        # Interpolate to horizon
        t_horizon = np.arange(horizon_N) * dt
        
        # Handle extrapolation: use first/last value
        if len(times) == 0:
            raise ValueError("thrust_desired list is empty")
        
        # Simple linear interpolation
        for k in range(horizon_N):
            t_k = t_horizon[k]
            
            # Find interval
            if t_k <= times[0]:
                F_des[k] = thrusts[0]
            elif t_k >= times[-1]:
                F_des[k] = thrusts[-1]
            else:
                # Linear interpolation
                idx = np.searchsorted(times, t_k) - 1
                t0, t1 = times[idx], times[idx + 1]
                F0, F1 = thrusts[idx], thrusts[idx + 1]
                F_des[k] = F0 + (F1 - F0) * (t_k - t0) / (t1 - t0)
    else:
        raise ValueError(f"Unsupported thrust_desired type: {type(cmd.thrust_desired)}")
    
    return F_des


def _compute_altitude_command(
    nav: NavState,
    altitude_goal: float,
    horizon_N: int,
    dt: float,
    cfg: ControllerConfig,
) -> np.ndarray:
    """
    Compute desired thrust from PD guidance for altitude command.
    
    Uses: a_cmd = kp*(h_goal - h) + kd*(vz_goal - vz)
          F_des = m*(a_cmd + g) / cos(theta)
    
    Parameters:
    -----------
    nav : NavState
        Current navigation state
    altitude_goal : float
        Target altitude [m]
    horizon_N : int
        Horizon length
    dt : float
        Time step [s]
    cfg : ControllerConfig
        Controller configuration (for PD gains if available)
    
    Returns:
    --------
    F_des : np.ndarray, shape (horizon_N,)
        Desired thrust sequence [N]
    """
    # PD gains (default values, could be in cfg)
    kp = getattr(cfg, 'altitude_kp', 0.5)  # [1/s²]
    kd = getattr(cfg, 'altitude_kd', 0.3)  # [1/s]
    
    # Target vertical velocity (zero for hover, or computed)
    vz_goal = getattr(cfg, 'altitude_vz_goal', 0.0)  # [m/s]
    
    # Current state
    h = nav.h
    vz = nav.vz
    theta = nav.theta
    
    # Mass estimate (use provided or default)
    if nav.mass_estimate is not None:
        m = nav.mass_estimate
    else:
        # Default mass (could be in cfg)
        m = getattr(cfg, 'vehicle_mass', 100.0)  # [kg]
    
    # Compute acceleration command
    h_error = altitude_goal - h
    vz_error = vz_goal - vz
    a_cmd = kp * h_error + kd * vz_error
    
    # Compute desired thrust
    # F = m * (a_cmd + g) / cos(theta)
    # Protect against division by zero (theta near 90 deg)
    cos_theta = np.cos(theta)
    if abs(cos_theta) < 0.1:  # ~84 deg
        cos_theta = np.sign(cos_theta) * 0.1  # Clamp to prevent extreme values
    
    F_des_base = m * (a_cmd + GRAVITY) / cos_theta
    
    # Clamp to reasonable range
    F_des_base = np.clip(F_des_base, 0.0, 1e6)  # [N]
    
    # For horizon, use constant or decaying command
    # Simple: constant for now (could add trajectory following)
    F_des = np.ones(horizon_N, dtype=np.float64) * F_des_base
    
    return F_des


def _estimate_thrust_bounds(
    state: np.ndarray,
    meas: Measurement,
    cfg: ControllerConfig,
    engine_wrapper: Optional[EngineWrapper],
    eng_est_current: Optional[EngineEstimate],
) -> Tuple[float, float]:
    """
    Estimate feasible thrust bounds [F_min, F_max].
    
    Parameters:
    -----------
    state : np.ndarray
        Current state vector
    meas : Measurement
        Current measurements
    cfg : ControllerConfig
        Controller configuration
    engine_wrapper : EngineWrapper, optional
        Engine wrapper for performance estimation
    eng_est_current : EngineEstimate, optional
        Current engine estimate
    
    Returns:
    --------
    F_min : float
        Minimum feasible thrust [N]
    F_max : float
        Maximum feasible thrust [N]
    """
    # Minimum thrust: near zero (or minimum stable thrust)
    F_min = 0.0
    
    # Maximum thrust: depends on:
    # 1. Current tank/ullage pressures (P_u_F, P_u_O) - used for engine evaluation
    #    Feed pressures (P_d_F, P_d_O) lag behind and are downstream
    # 2. Actuation headroom (P_reg - P_u_i)
    # 3. COPV pressure (for pressurization)
    
    # Estimate from current engine performance
    if eng_est_current is not None:
        F_current = eng_est_current.F
    else:
        # Fallback: estimate from pressures (rough approximation)
        # Note: Using feed pressures here is approximate; ideally would use tank pressures
        # Simple model: F ~ sqrt(P * P) * constant
        F_current = 1000.0 * np.sqrt(meas.P_u_fuel * meas.P_u_ox) / 1e6
    
    # Check headroom for actuation
    headroom_F = meas.P_reg - meas.P_u_fuel
    headroom_O = meas.P_reg - meas.P_u_ox
    
    # If headroom is low, limit maximum thrust
    headroom_factor = 1.0
    if headroom_F < cfg.headroom_dp_min:
        headroom_factor = min(headroom_factor, headroom_F / cfg.headroom_dp_min)
    if headroom_O < cfg.headroom_dp_min:
        headroom_factor = min(headroom_factor, headroom_O / cfg.headroom_dp_min)
    
    # Estimate maximum thrust
    # Conservative: use current thrust * headroom_factor * safety margin
    F_max = F_current * headroom_factor * 1.5  # 50% headroom
    
    # Also check COPV pressure (need enough for pressurization)
    if meas.P_copv < cfg.P_copv_min * 1.5:  # Need some margin
        # Reduce max thrust if COPV is low
        copv_factor = (meas.P_copv - cfg.P_copv_min) / (cfg.P_copv_min * 0.5)
        copv_factor = np.clip(copv_factor, 0.1, 1.0)
        F_max *= copv_factor
    
    # Clamp to reasonable range
    F_max = max(F_max, F_min + 100.0)  # At least 100 N range
    F_max = min(F_max, 1e6)  # Cap at 1 MN (very large engine)
    
    return F_min, F_max


def _project_thrust(
    F_des: float,
    F_min: float,
    F_max: float,
    F_prev: float,
    dt: float,
    cfg: ControllerConfig,
) -> float:
    """
    Project desired thrust to feasible reference with slew rate limiting.
    
    Uses sequential clipping:
    1. Clamp to bounds: F = clip(F_des, [F_min, F_max])
    2. Limit slew rate: F = clip(F, [F_prev - dF_max*dt, F_prev + dF_max*dt])
    
    Parameters:
    -----------
    F_des : float
        Desired thrust [N]
    F_min : float
        Minimum feasible thrust [N]
    F_max : float
        Maximum feasible thrust [N]
    F_prev : float
        Previous reference thrust [N]
    dt : float
        Time step [s]
    cfg : ControllerConfig
        Controller configuration
    
    Returns:
    --------
    F_ref : float
        Projected reference thrust [N]
    """
    # Maximum slew rate (default: 10 kN/s)
    dF_max = getattr(cfg, 'thrust_slew_max', 10000.0)  # [N/s]
    
    # Step 1: Clamp to bounds
    F_clamped = np.clip(F_des, F_min, F_max)
    
    # Step 2: Limit slew rate
    dF_max_step = dF_max * dt
    F_ref = np.clip(F_clamped, F_prev - dF_max_step, F_prev + dF_max_step)
    
    # Step 3: Re-clamp to bounds (in case slew limit pushed out)
    F_ref = np.clip(F_ref, F_min, F_max)
    
    return float(F_ref)


def _measurement_to_state(meas: Measurement) -> np.ndarray:
    """
    Convert measurement to state vector (simplified).
    
    Parameters:
    -----------
    meas : Measurement
        Sensor measurements
    
    Returns:
    --------
    state : np.ndarray, shape (N_STATE,)
        State vector (partial, for bounds estimation)
    """
    from .dynamics import N_STATE
    
    state = np.zeros(N_STATE, dtype=np.float64)
    # Fill in pressure states (others would need additional info)
    # This is a simplified version for bounds estimation
    return state

