"""Configuration loader for robust DDP controller."""

from pathlib import Path
from typing import Optional
from .data_models import ControllerConfig


def get_default_config() -> ControllerConfig:
    """Get default controller configuration.
    
    Returns:
    -------
    config : ControllerConfig
        Default configuration with reasonable values for LOX/RP-1 engine.
    """
    return ControllerConfig(
        # Prediction horizon (0.5 s at 100 Hz)
        N=50,
        dt=0.01,
        
        # Dwell time (50 ms = 20 Hz max control rate)
        dwell_time=0.05,
        
        # Duty quantization (1% steps for PWM)
        duty_quantization=0.01,
        
        # Cost weights - tuned for good thrust tracking without objective blowup
        qF=100.0,        # Thrust tracking (high priority, normalized by reference to prevent blowup)
        qMR=10.0,        # Mixture ratio (high priority, normalized by reference)
        qGas=0.001,      # Gas consumption (minimal - allow controller to use gas freely)
        qSwitch=0.0001,  # Control switching (minimal - allow very aggressive control changes)
        
        # Constraints
        MR_min=1.5,      # Minimum O/F
        MR_max=3.0,      # Maximum O/F
        injector_dp_frac=0.1,  # 10% minimum pressure drop
        eps_i=1e-3,      # Constraint tolerance
        P_u_max=10e6,    # 1450 psi max upstream pressure
        P_copv_min=1e6,  # 145 psi min COPV pressure
        headroom_dp_min=0.05e6,  # 7.25 psi min headroom
        
        # Robustness
        rho=0.1,         # Disturbance bound
        eta=0.01,        # Robustness margin
        
        # Solver
        max_iterations=20,  # Increased for better convergence
        convergence_tol=1e-3,  # Relaxed to allow more exploration
        
        # Dynamics parameters
        copv_cF=1e5,     # COPV consumption coefficient for fuel [Pa/s per unit u_F]
        copv_cO=1e5,     # COPV consumption coefficient for oxidizer [Pa/s per unit u_O]
        copv_loss=1e3,   # COPV leakage/heat loss [Pa/s]
        reg_setpoint=6.89476e6,  # Regulator setpoint [Pa] = 1000 psi (fixed setpoint regulator)
        reg_ratio=0.8,   # P_reg / P_copv ratio if setpoint not specified (fallback)
        alpha_F=10.0,    # Fuel pressurization flow coefficient [1/s]
        alpha_O=10.0,    # Oxidizer pressurization flow coefficient [1/s]
        rho_F=800.0,     # Fuel density (RP-1) [kg/m³]
        rho_O=1140.0,    # Oxidizer density (LOX) [kg/m³]
        tau_line_F=0.05, # Fuel feed line time constant [s] (increased for hardware-matching damping)
        tau_line_O=0.05, # Oxidizer feed line time constant [s] (increased for hardware-matching damping)
    )


def load_config(filepath: Optional[str] = None) -> ControllerConfig:
    """Load controller configuration from file.
    
    Parameters:
    -----------
    filepath : str, optional
        Path to config file. If None, returns default config.
        Supports .json and .yaml extensions.
    
    Returns:
    -------
    config : ControllerConfig
        Loaded configuration.
    """
    if filepath is None:
        return get_default_config()
    
    path = Path(filepath)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {filepath}")
    
    suffix = path.suffix.lower()
    if suffix == '.json':
        return ControllerConfig.from_json(str(path))
    elif suffix in ['.yaml', '.yml']:
        return ControllerConfig.from_yaml(str(path))
    else:
        raise ValueError(f"Unsupported config file format: {suffix}. Use .json or .yaml")


def save_config(config: ControllerConfig, filepath: str) -> None:
    """Save controller configuration to file.
    
    Parameters:
    -----------
    config : ControllerConfig
        Configuration to save.
    filepath : str
        Path to save config file. Extension determines format (.json or .yaml).
    """
    path = Path(filepath)
    suffix = path.suffix.lower()
    
    if suffix == '.json':
        config.to_json(str(path))
    elif suffix in ['.yaml', '.yml']:
        config.to_yaml(str(path))
    else:
        raise ValueError(f"Unsupported config file format: {suffix}. Use .json or .yaml")

