"""Robust Differential Dynamic Programming (DDP) controller for thrust regulation.

This module implements a robust DDP-based controller that regulates engine thrust
via pressure regulation while maintaining mixture ratio constraints and handling
disturbances.
"""

from .data_models import (
    Measurement,
    NavState,
    Command,
    CommandType,
    ControllerConfig,
    ControllerState,
)
from .config_loader import load_config, save_config, get_default_config
from .dynamics import step, linearize, DynamicsParams, N_STATE, N_CONTROL
from .engine_wrapper import EngineWrapper, EngineEstimate, estimate_from_pressures
from .constraints import is_safe, constraint_values, get_constraint_summary
from .robustness import (
    update_bounds,
    tube_propagate,
    get_w_bar_array,
    set_w_bar_array,
)
from .ddp_solver import solve_ddp, DDPSolution
from .reference import build_reference, Reference
from .actuation import (
    compute_actuation,
    ActuationCommand,
    ExecutionBackend,
    quantize_duty,
    enforce_dwell,
    binary_actuation,
    update_state_dwell_timers,
    create_duty_grid,
)
from .safety_filter import filter_action
from .controller import RobustDDPController
from .logging import ControllerLogger
from .identify import ParameterIdentifier, update_params
from .policy_lut import PolicyLUT

__all__ = [
    "Measurement",
    "NavState",
    "Command",
    "CommandType",
    "ControllerConfig",
    "ControllerState",
    "load_config",
    "save_config",
    "get_default_config",
    "step",
    "linearize",
    "DynamicsParams",
    "N_STATE",
    "N_CONTROL",
    "EngineWrapper",
    "EngineEstimate",
    "estimate_from_pressures",
    "is_safe",
    "constraint_values",
    "get_constraint_summary",
    "update_bounds",
    "tube_propagate",
    "get_w_bar_array",
    "set_w_bar_array",
    "solve_ddp",
    "DDPSolution",
    "build_reference",
    "Reference",
    "compute_actuation",
    "ActuationCommand",
    "ExecutionBackend",
    "quantize_duty",
    "enforce_dwell",
    "binary_actuation",
    "update_state_dwell_timers",
    "create_duty_grid",
    "filter_action",
    "RobustDDPController",
    "ControllerLogger",
    "ParameterIdentifier",
    "update_params",
    "PolicyLUT",
]

