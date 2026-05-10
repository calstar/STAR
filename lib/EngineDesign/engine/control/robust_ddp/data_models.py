"""Data models for robust DDP controller."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional, Union, List, Dict, Any
import json
import yaml
from datetime import datetime
import numpy as np

# Import N_STATE for type hints (lazy import to avoid circular dependency)
# N_STATE is defined in dynamics.py, but dynamics.py imports ControllerConfig from here
# So we use a fallback and import it lazily when needed
N_STATE = 11  # Default/fallback (expanded to include gas masses: 8 original + 3 gas masses)


class CommandType(Enum):
    """Type of control command."""
    THRUST_DESIRED = "thrust_desired"
    ALTITUDE_GOAL = "altitude_goal"


@dataclass
class Measurement:
    """Sensor measurement data.
    
    Contains pressure transducer readings and timestamp.
    All pressures in Pascals [Pa].
    """
    # COPV (Composite Overwrapped Pressure Vessel) pressure
    P_copv: float
    
    # Regulator pressure (downstream of regulator)
    P_reg: float
    
    # Upstream pressures (tank side of injector)
    P_u_fuel: float  # Fuel upstream pressure
    P_u_ox: float     # Oxidizer upstream pressure
    
    # Downstream pressures (chamber side of injector)
    P_d_fuel: float   # Fuel downstream pressure
    P_d_ox: float     # Oxidizer downstream pressure
    
    # Timestamp (Unix time in seconds, or datetime object)
    timestamp: Union[float, datetime] = field(default_factory=datetime.now)
    
    def __post_init__(self):
        """Validate measurement data."""
        # Convert datetime to float if needed
        if isinstance(self.timestamp, datetime):
            self.timestamp = self.timestamp.timestamp()
        
        # Validate pressures are non-negative
        pressures = [
            self.P_copv, self.P_reg,
            self.P_u_fuel, self.P_u_ox,
            self.P_d_fuel, self.P_d_ox
        ]
        for i, p in enumerate(pressures):
            if p < 0:
                raise ValueError(f"Pressure {i} is negative: {p} Pa")
            if not np.isfinite(p):
                raise ValueError(f"Pressure {i} is not finite: {p}")
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "P_copv": float(self.P_copv),
            "P_reg": float(self.P_reg),
            "P_u_fuel": float(self.P_u_fuel),
            "P_u_ox": float(self.P_u_ox),
            "P_d_fuel": float(self.P_d_fuel),
            "P_d_ox": float(self.P_d_ox),
            "timestamp": float(self.timestamp),
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Measurement:
        """Create from dictionary."""
        return cls(
            P_copv=float(data["P_copv"]),
            P_reg=float(data["P_reg"]),
            P_u_fuel=float(data["P_u_fuel"]),
            P_u_ox=float(data["P_u_ox"]),
            P_d_fuel=float(data["P_d_fuel"]),
            P_d_ox=float(data["P_d_ox"]),
            timestamp=float(data.get("timestamp", datetime.now().timestamp())),
        )


@dataclass
class NavState:
    """Navigation state (vehicle state).
    
    Contains altitude, velocity, attitude, and mass estimate.
    """
    # Altitude above ground level [m]
    h: float
    
    # Vertical velocity [m/s] (positive = upward)
    vz: float
    
    # Tilt angle [rad] (0 = vertical, positive = leaning forward)
    # Alternative: use quaternion for full 3D attitude
    theta: float = 0.0
    
    # Optional: quaternion for 3D attitude [w, x, y, z]
    quaternion: Optional[List[float]] = None
    
    # Mass estimate [kg] (optional, for adaptive control)
    mass_estimate: Optional[float] = None
    
    def __post_init__(self):
        """Validate navigation state."""
        if self.h < 0:
            raise ValueError(f"Altitude h is negative: {self.h} m")
        if not np.isfinite(self.h):
            raise ValueError(f"Altitude h is not finite: {self.h}")
        if not np.isfinite(self.vz):
            raise ValueError(f"Vertical velocity vz is not finite: {self.vz}")
        if not np.isfinite(self.theta):
            raise ValueError(f"Tilt angle theta is not finite: {self.theta}")
        
        # Validate quaternion if provided
        if self.quaternion is not None:
            if len(self.quaternion) != 4:
                raise ValueError(f"Quaternion must have 4 elements, got {len(self.quaternion)}")
            q_norm = np.linalg.norm(self.quaternion)
            if not np.isclose(q_norm, 1.0, atol=1e-3):
                raise ValueError(f"Quaternion must be normalized, got norm={q_norm}")
        
        # Validate mass if provided
        if self.mass_estimate is not None:
            if self.mass_estimate <= 0:
                raise ValueError(f"Mass estimate must be positive, got {self.mass_estimate} kg")
            if not np.isfinite(self.mass_estimate):
                raise ValueError(f"Mass estimate is not finite: {self.mass_estimate}")
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        result = {
            "h": float(self.h),
            "vz": float(self.vz),
            "theta": float(self.theta),
        }
        if self.quaternion is not None:
            result["quaternion"] = [float(q) for q in self.quaternion]
        if self.mass_estimate is not None:
            result["mass_estimate"] = float(self.mass_estimate)
        return result
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> NavState:
        """Create from dictionary."""
        return cls(
            h=float(data["h"]),
            vz=float(data.get("vz", 0.0)),
            theta=float(data.get("theta", 0.0)),
            quaternion=data.get("quaternion"),
            mass_estimate=data.get("mass_estimate"),
        )


@dataclass
class Command:
    """Control command.
    
    Supports either thrust desired (time-varying) or altitude goal.
    """
    # Command type
    command_type: CommandType
    
    # For THRUST_DESIRED: thrust profile as function of time
    # Stored as list of (time, thrust) pairs, or constant value
    thrust_desired: Optional[Union[float, List[tuple]]] = None
    
    # For ALTITUDE_GOAL: target altitude [m]
    altitude_goal: Optional[float] = None
    
    def __post_init__(self):
        """Validate command."""
        if self.command_type == CommandType.THRUST_DESIRED:
            if self.thrust_desired is None:
                raise ValueError("thrust_desired must be provided for THRUST_DESIRED command")
            if isinstance(self.thrust_desired, float):
                if self.thrust_desired < 0:
                    raise ValueError(f"Thrust desired must be non-negative, got {self.thrust_desired} N")
            elif isinstance(self.thrust_desired, list):
                for t, F in self.thrust_desired:
                    if F < 0:
                        raise ValueError(f"Thrust at t={t} is negative: {F} N")
        elif self.command_type == CommandType.ALTITUDE_GOAL:
            if self.altitude_goal is None:
                raise ValueError("altitude_goal must be provided for ALTITUDE_GOAL command")
            if self.altitude_goal < 0:
                raise ValueError(f"Altitude goal must be non-negative, got {self.altitude_goal} m")
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        result = {
            "command_type": self.command_type.value,
        }
        if self.thrust_desired is not None:
            result["thrust_desired"] = self.thrust_desired
        if self.altitude_goal is not None:
            result["altitude_goal"] = self.altitude_goal
        return result
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Command:
        """Create from dictionary."""
        command_type = CommandType(data["command_type"])
        return cls(
            command_type=command_type,
            thrust_desired=data.get("thrust_desired"),
            altitude_goal=data.get("altitude_goal"),
        )


@dataclass
class ControllerConfig:
    """Controller configuration parameters.
    
    Contains all tunable parameters for the robust DDP controller.
    """
    # Prediction horizon
    N: int = 50                    # Number of time steps in horizon
    dt: float = 0.01               # Time step [s] (10 ms = 100 Hz)
    
    # Dwell time (minimum time between control changes) [s]
    dwell_time: float = 0.05        # 50 ms = 20 Hz max control rate
    
    # Duty quantization (for PWM solenoids)
    duty_quantization: float = 0.01  # 1% duty cycle steps
    
    # Cost function weights
    qF: float = 1000.0            # Thrust tracking weight (VERY high priority - controller MUST track thrust)
    qMR: float = 10.0              # Mixture ratio weight
    qGas: float = 0.001           # Gas consumption weight (minimal - allow controller to use gas freely)
    qSwitch: float = 0.0001        # Control switching cost (minimal - allow very aggressive control changes)
    
    # Constraints
    MR_min: float = 1.5            # Minimum mixture ratio (O/F)
    MR_max: float = 3.0            # Maximum mixture ratio (O/F)
    injector_dp_frac: float = 0.1  # Minimum injector pressure drop fraction
    eps_i: float = 1e-3            # Constraint violation tolerance
    P_u_max: float = 10e6          # Maximum upstream pressure [Pa] (~1450 psi)
    P_copv_min: float = 1e6        # Minimum COPV pressure [Pa] (~145 psi)
    headroom_dp_min: float = 0.05e6  # Minimum headroom pressure drop [Pa] (~7.25 psi)
    
    # Robustness parameters
    rho: float = 0.1               # Robustness parameter (disturbance bound)
    eta: float = 0.01              # Robustness margin
    
    # Additional parameters
    max_iterations: int = 20       # Max DDP iterations (increased for better convergence)
    convergence_tol: float = 1e-3  # Convergence tolerance (relaxed to allow more exploration)
    
    # Dynamics parameters
    # COPV blowdown model: P_copv[k+1] = P_copv[k] - dt*(cF*u_F + cO*u_O + loss)
    copv_cF: float = 1e5            # COPV consumption coefficient for fuel [Pa/s per unit u_F]
    copv_cO: float = 1e5            # COPV consumption coefficient for oxidizer [Pa/s per unit u_O]
    copv_loss: float = 1e3          # COPV leakage/heat loss [Pa/s]
    
    # Regulator model
    reg_setpoint: Optional[float] = None  # Regulator setpoint [Pa] (None = derived from COPV)
    reg_ratio: float = 0.8          # P_reg / P_copv ratio if setpoint not specified
    
    # Ullage pressurization flow coefficients [1/s]
    alpha_F: float = 10.0           # Fuel pressurization flow coefficient
    alpha_O: float = 10.0           # Oxidizer pressurization flow coefficient
    
    # Propellant densities [kg/m³]
    rho_F: float = 800.0            # Fuel density (RP-1)
    rho_O: float = 1140.0           # Oxidizer density (LOX)
    
    # Feed line time constants [s]
    tau_line_F: float = 0.01       # Fuel feed line time constant
    tau_line_O: float = 0.01        # Oxidizer feed line time constant
    
    # Initial ullage volumes [m³] (if not provided, computed from initial conditions)
    V_u_F_init: Optional[float] = None
    V_u_O_init: Optional[float] = None

    # Policy LUT (use precomputed LUT instead of online DDP when True)
    use_policy_lut: bool = False
    policy_lut_path: Optional[str] = None

    # Engine LUT (use precomputed engine performance instead of physics; stems from engine config + tank pressure range)
    engine_lut_path: Optional[str] = None

    def __post_init__(self):
        """Validate configuration."""
        if self.N <= 0:
            raise ValueError(f"N must be positive, got {self.N}")
        if self.dt <= 0:
            raise ValueError(f"dt must be positive, got {self.dt} s")
        if self.dwell_time < 0:
            raise ValueError(f"dwell_time must be non-negative, got {self.dwell_time} s")
        if self.duty_quantization <= 0 or self.duty_quantization > 1:
            raise ValueError(f"duty_quantization must be in (0, 1], got {self.duty_quantization}")
        if self.MR_min >= self.MR_max:
            raise ValueError(f"MR_min ({self.MR_min}) must be < MR_max ({self.MR_max})")
        if self.P_u_max <= 0:
            raise ValueError(f"P_u_max must be positive, got {self.P_u_max} Pa")
        if self.P_copv_min <= 0:
            raise ValueError(f"P_copv_min must be positive, got {self.P_copv_min} Pa")
        if self.rho < 0:
            raise ValueError(f"rho must be non-negative, got {self.rho}")
        if self.eta < 0:
            raise ValueError(f"eta must be non-negative, got {self.eta}")
        
        # Validate dynamics parameters
        if self.copv_cF < 0:
            raise ValueError(f"copv_cF must be non-negative, got {self.copv_cF}")
        if self.copv_cO < 0:
            raise ValueError(f"copv_cO must be non-negative, got {self.copv_cO}")
        if self.copv_loss < 0:
            raise ValueError(f"copv_loss must be non-negative, got {self.copv_loss}")
        if self.reg_ratio <= 0 or self.reg_ratio > 1:
            raise ValueError(f"reg_ratio must be in (0, 1], got {self.reg_ratio}")
        if self.alpha_F <= 0:
            raise ValueError(f"alpha_F must be positive, got {self.alpha_F}")
        if self.alpha_O <= 0:
            raise ValueError(f"alpha_O must be positive, got {self.alpha_O}")
        if self.rho_F <= 0:
            raise ValueError(f"rho_F must be positive, got {self.rho_F}")
        if self.rho_O <= 0:
            raise ValueError(f"rho_O must be positive, got {self.rho_O}")
        if self.tau_line_F <= 0:
            raise ValueError(f"tau_line_F must be positive, got {self.tau_line_F}")
        if self.tau_line_O <= 0:
            raise ValueError(f"tau_line_O must be positive, got {self.tau_line_O}")
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ControllerConfig:
        """Create from dictionary."""
        return cls(**data)
    
    def to_json(self, filepath: str) -> None:
        """Save to JSON file."""
        with open(filepath, 'w') as f:
            json.dump(self.to_dict(), f, indent=2)
    
    @classmethod
    def from_json(cls, filepath: str) -> ControllerConfig:
        """Load from JSON file."""
        with open(filepath, 'r') as f:
            data = json.load(f)
        return cls.from_dict(data)
    
    def to_yaml(self, filepath: str) -> None:
        """Save to YAML file."""
        with open(filepath, 'w') as f:
            yaml.dump(self.to_dict(), f, default_flow_style=False, indent=2)
    
    @classmethod
    def from_yaml(cls, filepath: str) -> ControllerConfig:
        """Load from YAML file."""
        with open(filepath, 'r') as f:
            data = yaml.safe_load(f)
        return cls.from_dict(data)


@dataclass
class ControllerState:
    """Persistent controller state.
    
    Maintains state across control ticks for robust DDP controller.
    """
    # Last control action (upstream pressures) [Pa]
    u_prev: Dict[str, float] = field(default_factory=lambda: {"P_u_fuel": 0.0, "P_u_ox": 0.0})
    
    # Dwell timers (time since last control change) [s]
    dwell_timers: Dict[str, float] = field(default_factory=lambda: {"P_u_fuel": 0.0, "P_u_ox": 0.0})
    
    # Last predicted trajectory (for warm start)
    last_trajectory: Optional[List[Dict[str, Any]]] = None
    
    # Residual bounds (for robustness)
    # Can be dict (legacy) or array (per-state-component)
    w_bar: Dict[str, float] = field(default_factory=lambda: {"thrust": 0.0, "MR": 0.0})
    w_bar_array: Optional[np.ndarray] = None  # Per-state-component bounds [N_STATE]
    
    # Disturbance estimate (bias)
    beta: float = 0.0
    
    # Additional state
    iteration_count: int = 0
    last_cost: float = float('inf')
    
    def reset(self) -> None:
        """Reset controller state to initial values."""
        self.u_prev = {"P_u_fuel": 0.0, "P_u_ox": 0.0}
        self.dwell_timers = {"P_u_fuel": 0.0, "P_u_ox": 0.0}
        self.last_trajectory = None
        self.w_bar = {"thrust": 0.0, "MR": 0.0}
        self.w_bar_array = None
        self.beta = 0.0
        self.iteration_count = 0
        self.last_cost = float('inf')
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        result = {
            "u_prev": self.u_prev.copy(),
            "dwell_timers": self.dwell_timers.copy(),
            "last_trajectory": self.last_trajectory,
            "w_bar": self.w_bar.copy(),
            "beta": float(self.beta),
            "iteration_count": int(self.iteration_count),
            "last_cost": float(self.last_cost) if np.isfinite(self.last_cost) else None,
        }
        if self.w_bar_array is not None:
            result["w_bar_array"] = self.w_bar_array.tolist()
        return result
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ControllerState:
        """Create from dictionary."""
        state = cls(
            u_prev=data.get("u_prev", {"P_u_fuel": 0.0, "P_u_ox": 0.0}),
            dwell_timers=data.get("dwell_timers", {"P_u_fuel": 0.0, "P_u_ox": 0.0}),
            last_trajectory=data.get("last_trajectory"),
            w_bar=data.get("w_bar", {"thrust": 0.0, "MR": 0.0}),
            beta=float(data.get("beta", 0.0)),
            iteration_count=int(data.get("iteration_count", 0)),
            last_cost=float(data.get("last_cost", float('inf'))) if data.get("last_cost") is not None else float('inf'),
        )
        if "w_bar_array" in data and data["w_bar_array"] is not None:
            state.w_bar_array = np.array(data["w_bar_array"], dtype=np.float64)
        return state

