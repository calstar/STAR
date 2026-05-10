# Robust DDP Controller - Quick Start

## Installation

The controller is part of the engine design package. No additional installation needed.

## Basic Usage

```python
from engine.control.robust_ddp import (
    RobustDDPController,
    ControllerConfig,
    ControllerLogger,
    Command,
    CommandType,
    Measurement,
    NavState,
)
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.pipeline.io import load_config

# 1. Load engine configuration
engine_config = load_config("configs/your_engine.yaml")

# 2. Create controller configuration
cfg = ControllerConfig(
    N=50,              # Horizon length
    dt=0.01,           # 10 ms time step
    qF=1.0,            # Thrust tracking weight
    qMR=10.0,          # Mixture ratio weight
    # ... other parameters
)

# 3. Create logger (optional)
logger = ControllerLogger("controller_run.json", format="json")

# 4. Initialize controller
controller = RobustDDPController(cfg, engine_config, logger=logger)

# 5. Control loop
for step in range(num_steps):
    # Read sensors
    meas = Measurement(
        P_copv=read_copv_pressure(),
        P_reg=read_regulator_pressure(),
        P_u_fuel=read_fuel_ullage_pressure(),
        P_u_ox=read_ox_ullage_pressure(),
        P_d_fuel=read_fuel_feed_pressure(),
        P_d_ox=read_ox_feed_pressure(),
    )
    
    # Get navigation state
    nav = NavState(
        h=get_altitude(),
        vz=get_vertical_velocity(),
        theta=get_tilt_angle(),
        mass_estimate=get_mass(),
    )
    
    # Set command
    cmd = Command(
        command_type=CommandType.THRUST_DESIRED,
        thrust_desired=5000.0,  # 5 kN
    )
    
    # Controller step
    actuation_cmd, diagnostics = controller.step(meas, nav, cmd)
    
    # Apply to hardware
    set_solenoid_duty("fuel", actuation_cmd.duty_F)
    set_solenoid_duty("oxidizer", actuation_cmd.duty_O)
    
    # Check diagnostics
    if diagnostics["constraint_violations"]:
        print("Warning: Constraint violations detected")

# 6. Analyze results
# Run: python tools/analyze_controller_run.py controller_run.json -o analysis.png
```

## Configuration

See `configs/robust_ddp_default.yaml` for default configuration.

Key parameters:
- `N`: Prediction horizon (50 steps = 0.5 s at 100 Hz)
- `dt`: Time step [s] (0.01 = 100 Hz)
- `qF`, `qMR`, `qGas`, `qSwitch`: Cost weights
- `MR_min`, `MR_max`: Mixture ratio bounds
- `P_u_max`, `P_copv_min`: Pressure constraints

## Command Modes

### Thrust Command
```python
cmd = Command(
    command_type=CommandType.THRUST_DESIRED,
    thrust_desired=5000.0,  # Constant
    # or
    thrust_desired=[(0.0, 1000.0), (0.5, 5000.0), (1.0, 3000.0)],  # Piecewise
)
```

### Altitude Command
```python
cmd = Command(
    command_type=CommandType.ALTITUDE_GOAL,
    altitude_goal=200.0,  # 200 m target
)
```

## Analysis

After running, analyze logs:
```bash
python tools/analyze_controller_run.py controller_run.json -o analysis.png
```

This generates plots of:
- Thrust tracking (F_ref vs F_hat)
- Mixture ratio
- Pressures (COPV, regulator, ullage, feed, chamber)
- Duty cycles
- Constraint margins

## Troubleshooting

- **Constraints violated**: Check safety filter is enabled, adjust bounds
- **Poor tracking**: Tune cost weights (qF, qMR), check reference feasibility
- **Oscillations**: Increase qSwitch, check dwell time settings
- **Slow convergence**: Reduce horizon N, increase max_iterations

## See Also

- Full documentation: `docs/control/`
- Tests: `tests/control/robust_ddp/`
- Code: `engine/control/robust_ddp/`



