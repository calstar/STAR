# Robust DDP Controller Documentation Index

## Core Modules

1. **Data Models** (`data_models.py`)
   - `Measurement`: Sensor readings (pressures, timestamp)
   - `NavState`: Navigation state (altitude, velocity, attitude, mass)
   - `Command`: Control commands (thrust desired or altitude goal)
   - `ControllerConfig`: All tunable parameters
   - `ControllerState`: Persistent controller state

2. **Dynamics** (`dynamics.py`)
   - Discrete-time state-space model
   - State: [P_copv, P_reg, P_u_F, P_u_O, P_d_F, P_d_O, V_u_F, V_u_O]
   - Control: [u_F, u_O] in [0, 1]
   - See: `DYNAMICS.md`

3. **Engine Wrapper** (`engine_wrapper.py`)
   - Wraps `PintleEngineRunner` for DDP
   - Provides `EngineEstimate` from feed pressures
   - LRU caching for efficiency
   - See: `ENGINE_WRAPPER.md`

4. **Constraints** (`constraints.py`)
   - Hard constraint checking
   - Soft constraint margins
   - COPV, ullage, MR, injector stiffness constraints
   - See: `CONSTRAINTS.md`

5. **Robustness** (`robustness.py`)
   - Residual bounds (`w_bar`) per state component
   - Disturbance bias (`beta`)
   - Tube propagation for uncertainty
   - See: `ROBUSTNESS.md`

6. **DDP Solver** (`ddp_solver.py`)
   - Finite-horizon DDP (iLQR-style)
   - Forward rollout, backward pass, line search
   - Constraint penalties and robustification
   - See: `DDP_SOLVER.md`

7. **Reference Generation** (`reference.py`)
   - Thrust command mode
   - Altitude command mode (PD guidance)
   - Feasible reference projection with slew rate limiting
   - See: `REFERENCE.md`

8. **Actuation** (`actuation.py`)
   - Duty quantization
   - Dwell time enforcement
   - PWM and binary execution backends
   - See: `ACTUATION.md`

9. **Safety Filter** (`safety_filter.py`)
   - Reachable tube computation
   - Constraint violation checking
   - Safe action selection from discrete candidates
   - See: `SAFETY_FILTER.md`

10. **Parameter Identification** (`identify.py`)
    - Online RLS identification
    - Identifies: alpha_F, alpha_O, tau_line_F, tau_line_O, copv_cF, copv_cO
    - Forgetting factor for adaptation

11. **Logging** (`logging.py`)
    - Structured logging (JSON/CSV)
    - Per-tick data logging
    - Analysis tool integration

12. **Controller** (`controller.py`)
    - Main `RobustDDPController` class
    - Integrates all components
    - See: `README.md`

## Usage Flow

```
1. Initialize: RobustDDPController(cfg, engine_config, logger)
2. For each tick:
   a. Read measurements (pressures)
   b. Get navigation state (altitude, velocity, etc.)
   c. Get command (thrust desired or altitude goal)
   d. Call: actuation_cmd, diagnostics = controller.step(meas, nav, cmd)
   e. Apply actuation_cmd to hardware
   f. Optionally: Update parameters via identifier
3. Analyze: Use tools/analyze_controller_run.py on logs
```

## Integration Points

- **Engine Physics**: `PintleEngineRunner` via `EngineWrapper`
- **Dynamics**: Discrete-time model in `dynamics.py`
- **Hardware**: `ActuationCommand` → solenoid drivers
- **Logging**: `ControllerLogger` → analysis tools



