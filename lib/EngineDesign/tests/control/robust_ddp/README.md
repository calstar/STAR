# Robust DDP Controller Tests

This directory contains unit tests and integration tests for the robust DDP controller.

## Test Structure

- **test_robust_ddp_data_models.py** - Data model tests (Measurement, NavState, Command, Config, State)
- **test_robust_ddp_dynamics.py** - Dynamics model tests (step, linearize)
- **test_robust_ddp_engine_wrapper.py** - Engine wrapper tests (caching, estimation)
- **test_robust_ddp_constraints.py** - Constraint checking tests
- **test_robust_ddp_robustness.py** - Robustness tests (bounds, tube propagation)
- **test_robust_ddp_ddp_solver.py** - DDP solver tests (optimization, convergence)
- **test_robust_ddp_reference.py** - Reference generation tests
- **test_robust_ddp_actuation.py** - Actuation tests (quantization, dwell, PWM/binary)
- **test_robust_ddp_safety_filter.py** - Safety filter tests
- **test_robust_ddp_identify.py** - Parameter identification tests
- **test_robust_ddp_controller_integration.py** - Full controller integration test

## Running Tests

```bash
# Run all controller tests
python -m pytest tests/control/robust_ddp/ -v

# Run specific test file
python -m pytest tests/control/robust_ddp/test_robust_ddp_controller_integration.py -v

# Run with coverage
python -m pytest tests/control/robust_ddp/ --cov=engine.control.robust_ddp
```

## Test Coverage

Tests cover:
- Data model validation and serialization
- Dynamics model accuracy (blowdown, pressurization, feed lag)
- Engine wrapper caching and estimation
- Constraint checking (pressures, MR, injector stiffness)
- Robustness bounds and tube propagation
- DDP solver convergence and bounds respect
- Reference generation (thrust and altitude modes)
- Actuation quantization and dwell enforcement
- Safety filtering and constraint violation handling
- Parameter identification convergence
- Full controller integration (200-step simulation)



