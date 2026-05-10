# Robust DDP Controller Documentation

This directory contains documentation for the robust Differential Dynamic Programming (DDP) controller for engine thrust regulation.

## Overview

The robust DDP controller is a complete closed-loop control system that:
- Regulates engine thrust via pressure regulation
- Maintains mixture ratio constraints
- Handles model uncertainty and disturbances
- Provides safety filtering and robustness guarantees

## Documentation Structure

- **README.md** (this file) - Overview and navigation
- **DYNAMICS.md** - Discrete-time dynamics model
- **ENGINE_WRAPPER.md** - Engine physics wrapper and caching
- **CONSTRAINTS.md** - Constraint checking and margins
- **ROBUSTNESS.md** - Residual bounds and tube propagation
- **DDP_SOLVER.md** - DDP optimization algorithm
- **REFERENCE.md** - Reference trajectory generation
- **ACTUATION.md** - Actuation command generation
- **SAFETY_FILTER.md** - Safety filtering and reachable tubes

## Quick Start

See the main controller class: `engine.control.robust_ddp.controller.RobustDDPController`

```python
from engine.control.robust_ddp import RobustDDPController, ControllerConfig
from engine.pipeline.config_schemas import PintleEngineConfig

# Initialize
cfg = ControllerConfig(...)
engine_config = PintleEngineConfig(...)
controller = RobustDDPController(cfg, engine_config)

# Control loop
for step in range(num_steps):
    actuation_cmd, diagnostics = controller.step(meas, nav, cmd)
    # Apply actuation_cmd to hardware
```

## Integration

The controller integrates with:
- **Engine Physics**: Uses `PintleEngineRunner` via `EngineWrapper`
- **Dynamics Model**: Discrete-time state-space model
- **Safety Systems**: Constraint checking and safety filtering
- **Logging**: Structured logging for analysis

## See Also

- Tests: `tests/control/robust_ddp/`
- Code: `engine/control/robust_ddp/`
- Analysis Tools: `tools/analyze_controller_run.py`
