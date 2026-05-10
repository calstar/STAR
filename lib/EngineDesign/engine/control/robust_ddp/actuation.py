"""Actuation command generation for robust DDP controller.

Converts relaxed controls u~ in [0,1] to actual actuation commands:
- Quantized duty levels
- Dwell time enforcement
- PWM or binary execution backends
"""

from __future__ import annotations

from typing import Optional, Literal
from dataclasses import dataclass
from enum import Enum
import numpy as np

from .data_models import ControllerConfig, ControllerState
from .dynamics import N_CONTROL, IDX_U_F, IDX_U_O


class ExecutionBackend(Enum):
    """Execution backend type."""
    PWM = "pwm"  # Pulse-width modulation
    BINARY = "binary"  # Pure binary (on/off)


@dataclass
class ActuationCommand:
    """Actuation command output."""
    # Binary on/off commands (for binary backend or thresholding)
    u_F_onoff: bool  # Fuel solenoid on/off
    u_O_onoff: bool  # Oxidizer solenoid on/off
    
    # Duty cycle commands (for PWM backend)
    duty_F: float  # Fuel duty cycle [0, 1]
    duty_O: float  # Oxidizer duty cycle [0, 1]
    
    # Quantized relaxed controls (for reference)
    u_F_quantized: float  # Quantized fuel control [0, 1]
    u_O_quantized: float  # Quantized oxidizer control [0, 1]
    
    # Backend used
    backend: ExecutionBackend
    
    # Dwell timer updates (for state update)
    dwell_timer_F: float  # Updated fuel dwell timer [s]
    dwell_timer_O: float  # Updated oxidizer dwell timer [s]


def compute_actuation(
    u_relaxed: np.ndarray,
    state: ControllerState,
    cfg: ControllerConfig,
    dt: Optional[float] = None,
    backend: ExecutionBackend = ExecutionBackend.PWM,
    u_prev_relaxed: Optional[np.ndarray] = None,
    sigma_delta_state: Optional[dict[str, float]] = None,
) -> ActuationCommand:
    """
    Convert relaxed controls to actuation commands.
    
    Parameters:
    -----------
    u_relaxed : np.ndarray, shape (N_CONTROL,)
        Relaxed control vector [u_F, u_O] in [0, 1]
    state : ControllerState
        Controller state (for dwell timers)
    cfg : ControllerConfig
        Controller configuration
    dt : float, optional
        Time step [s] (defaults to cfg.dt)
    backend : ExecutionBackend
        Execution backend (PWM or BINARY)
    u_prev_relaxed : np.ndarray, optional, shape (N_CONTROL,)
        Previous relaxed control (for dwell enforcement)
        If None, uses state.u_prev
    
    Returns:
    --------
    cmd : ActuationCommand
        Actuation command with duty cycles and on/off states
    """
    if dt is None:
        dt = cfg.dt
    
    # Validate input
    if u_relaxed.shape != (N_CONTROL,):
        raise ValueError(f"u_relaxed must have shape ({N_CONTROL},), got {u_relaxed.shape}")
    
    u_F = float(np.clip(u_relaxed[IDX_U_F], 0.0, 1.0))
    u_O = float(np.clip(u_relaxed[IDX_U_O], 0.0, 1.0))
    
    # Get previous controls for dwell enforcement
    if u_prev_relaxed is not None:
        u_F_prev = float(np.clip(u_prev_relaxed[IDX_U_F], 0.0, 1.0))
        u_O_prev = float(np.clip(u_prev_relaxed[IDX_U_O], 0.0, 1.0))
    else:
        # Extract from state (legacy format: P_u_fuel, P_u_ox)
        # For now, assume these are normalized [0, 1] or convert
        u_F_prev = state.u_prev.get("P_u_fuel", 0.0)
        u_O_prev = state.u_prev.get("P_u_ox", 0.0)
        # Normalize if needed (assuming max is 1.0 for now)
        u_F_prev = float(np.clip(u_F_prev, 0.0, 1.0))
        u_O_prev = float(np.clip(u_O_prev, 0.0, 1.0))
    
    # Get current dwell timers
    dwell_timer_F = state.dwell_timers.get("P_u_fuel", 0.0)
    dwell_timer_O = state.dwell_timers.get("P_u_ox", 0.0)
    
    # Step 1: Quantize to duty grid
    u_F_quantized = quantize_duty(u_F, cfg.duty_quantization)
    u_O_quantized = quantize_duty(u_O, cfg.duty_quantization)
    
    # Step 2: Enforce dwell time
    u_F_dwell, dwell_timer_F_new = enforce_dwell(
        u_F_quantized, u_F_prev, dwell_timer_F, cfg.dwell_time, dt
    )
    u_O_dwell, dwell_timer_O_new = enforce_dwell(
        u_O_quantized, u_O_prev, dwell_timer_O, cfg.dwell_time, dt
    )
    
    # Step 3: Generate actuation command based on backend
    if backend == ExecutionBackend.PWM:
        duty_F = u_F_dwell
        duty_O = u_O_dwell
        u_F_onoff = duty_F > 0.0
        u_O_onoff = duty_O > 0.0
    elif backend == ExecutionBackend.BINARY:
        # Binary backend: use sigma-delta modulation or threshold
        sd_state_F = sigma_delta_state.get("F", None) if sigma_delta_state else None
        sd_state_O = sigma_delta_state.get("O", None) if sigma_delta_state else None
        duty_F, u_F_onoff = binary_actuation(u_F_dwell, dt, cfg, sd_state_F)
        duty_O, u_O_onoff = binary_actuation(u_O_dwell, dt, cfg, sd_state_O)
    else:
        raise ValueError(f"Unknown backend: {backend}")
    
    return ActuationCommand(
        u_F_onoff=u_F_onoff,
        u_O_onoff=u_O_onoff,
        duty_F=duty_F,
        duty_O=duty_O,
        u_F_quantized=u_F_quantized,
        u_O_quantized=u_O_quantized,
        backend=backend,
        dwell_timer_F=dwell_timer_F_new,
        dwell_timer_O=dwell_timer_O_new,
    )


def quantize_duty(u: float, duty_quantization: float) -> float:
    """
    Quantize control to duty grid.
    
    Parameters:
    -----------
    u : float
        Control value in [0, 1]
    duty_quantization : float
        Duty quantization step (e.g., 0.01 for 1% steps)
    
    Returns:
    --------
    u_quantized : float
        Quantized control value
    """
    # Clamp to [0, 1]
    u = np.clip(u, 0.0, 1.0)
    
    # Quantize to grid: round to nearest multiple of duty_quantization
    n_steps = round(u / duty_quantization)
    u_quantized = n_steps * duty_quantization
    
    # Clamp again to ensure in [0, 1]
    u_quantized = np.clip(u_quantized, 0.0, 1.0)
    
    return float(u_quantized)


def enforce_dwell(
    u_new: float,
    u_prev: float,
    dwell_timer: float,
    dwell_time: float,
    dt: float,
) -> tuple[float, float]:
    """
    Enforce minimum dwell time between control changes.
    
    If control changed, reset timer. If timer < dwell_time, keep previous control.
    
    Parameters:
    -----------
    u_new : float
        New control value
    u_prev : float
        Previous control value
    dwell_timer : float
        Current dwell timer [s]
    dwell_time : float
        Minimum dwell time [s]
    dt : float
        Time step [s]
    
    Returns:
    --------
    u_output : float
        Output control (may be u_prev if dwell not satisfied)
    dwell_timer_new : float
        Updated dwell timer [s]
    """
    # Check if control changed (with tolerance for quantization)
    control_changed = abs(u_new - u_prev) > 1e-6
    
    if control_changed:
        # Control changed: check if dwell time satisfied
        if dwell_timer >= dwell_time:
            # Dwell satisfied: allow change
            return u_new, 0.0  # Reset timer
        else:
            # Dwell not satisfied: keep previous control
            dwell_timer_new = dwell_timer + dt
            return u_prev, dwell_timer_new
    else:
        # Control unchanged: increment timer
        dwell_timer_new = dwell_timer + dt
        return u_new, dwell_timer_new


def binary_actuation(
    duty_desired: float,
    dt: float,
    cfg: ControllerConfig,
    sigma_delta_state: Optional[float] = None,
) -> tuple[float, bool]:
    """
    Generate binary actuation command using sigma-delta modulation.
    
    Sigma-delta modulation provides average duty matching without high-frequency chatter.
    
    Parameters:
    -----------
    duty_desired : float
        Desired duty cycle [0, 1]
    dt : float
        Time step [s]
    cfg : ControllerConfig
        Controller configuration
    sigma_delta_state : float, optional
        Internal sigma-delta state (accumulator)
        If None, uses threshold method instead
    
    Returns:
    --------
    duty_output : float
        Output duty (0 or 1 for binary)
    onoff : bool
        Binary on/off command
    """
    if sigma_delta_state is None:
        # Simple threshold method (no sigma-delta)
        # Use threshold: if duty > 0.5, turn on
        threshold = getattr(cfg, 'binary_threshold', 0.5)
        onoff = duty_desired > threshold
        duty_output = 1.0 if onoff else 0.0
        return duty_output, onoff
    else:
        # Sigma-delta modulation (first-order)
        # Algorithm:
        #   1. accumulator += duty_desired
        #   2. output = 1 if accumulator >= 1, else 0
        #   3. accumulator -= output
        
        accumulator = sigma_delta_state + duty_desired
        
        # Generate output
        if accumulator >= 1.0:
            onoff = True
            duty_output = 1.0
            accumulator -= 1.0
        else:
            onoff = False
            duty_output = 0.0
        
        return duty_output, onoff


def update_state_dwell_timers(
    state: ControllerState,
    cmd: ActuationCommand,
) -> None:
    """
    Update dwell timers in controller state.
    
    Parameters:
    -----------
    state : ControllerState
        Controller state to update (mutated)
    cmd : ActuationCommand
        Actuation command with updated dwell timers
    """
    state.dwell_timers["P_u_fuel"] = cmd.dwell_timer_F
    state.dwell_timers["P_u_ox"] = cmd.dwell_timer_O
    
    # Also update u_prev with quantized values
    state.u_prev["P_u_fuel"] = cmd.u_F_quantized
    state.u_prev["P_u_ox"] = cmd.u_O_quantized


def create_duty_grid(duty_quantization: float) -> np.ndarray:
    """
    Create duty cycle grid.
    
    Parameters:
    -----------
    duty_quantization : float
        Duty quantization step
    
    Returns:
    --------
    grid : np.ndarray
        Duty grid: [0, step, 2*step, ..., 1.0]
    """
    n_steps = int(1.0 / duty_quantization) + 1
    grid = np.linspace(0.0, 1.0, n_steps)
    return grid

