# Dynamics Model Documentation

## Overview

The dynamics model implements discrete-time state-space dynamics for the robust DDP controller. The state vector includes pressures and ullage volumes, and the control inputs are normalized solenoid commands.

## State Vector

```
x = [P_copv, P_reg, P_u_F, P_u_O, P_d_F, P_d_O, V_u_F, V_u_O]
```

Where:
- `P_copv`: COPV (Composite Overwrapped Pressure Vessel) pressure [Pa]
- `P_reg`: Regulator pressure [Pa]
- `P_u_F`: Fuel ullage (upstream) pressure [Pa]
- `P_u_O`: Oxidizer ullage (upstream) pressure [Pa]
- `P_d_F`: Fuel feed (downstream) pressure [Pa]
- `P_d_O`: Oxidizer feed (downstream) pressure [Pa]
- `V_u_F`: Fuel ullage volume [m³]
- `V_u_O`: Oxidizer ullage volume [m³]

## Control Vector

```
u = [u_F, u_O]
```

Where `u_F, u_O ∈ [0, 1]` are normalized solenoid commands (0 = closed, 1 = fully open).

## Dynamics Equations

### 1. COPV Blowdown

```
P_copv[k+1] = P_copv[k] - dt * (cF * u_F + cO * u_O + loss)
```

Where:
- `cF, cO`: Consumption coefficients [Pa/s per unit control]
- `loss`: Leakage/heat loss [Pa/s]

### 2. Regulator Pressure

**Option A: Fixed Setpoint**
```
P_reg[k+1] = reg_setpoint
```

**Option B: Derived from COPV**
```
P_reg[k+1] = reg_ratio * P_copv[k+1]
P_reg[k+1] = min(P_reg[k+1], P_copv[k+1])  // Clamp to not exceed COPV
```

### 3. Ullage Volume Dynamics (Blowdown)

```
V_u_F[k+1] = V_u_F[k] + dt * mdot_F / rho_F
V_u_O[k+1] = V_u_O[k] + dt * mdot_O / rho_O
```

Ullage volume increases as propellant is consumed.

### 4. Ullage Pressure Dynamics

```
P_u_F[k+1] = P_u_F[k] + dt * (pressurization_F - blowdown_F)
P_u_O[k+1] = P_u_O[k] + dt * (pressurization_O - blowdown_O)
```

Where:
- **Pressurization term:**
  ```
  pressurization_i = alpha_i * u_i * max(0, P_reg - P_u_i)
  ```
  - `alpha_i`: Flow coefficient [1/s]
  - Only active when `P_reg > P_u_i` (positive headroom)

- **Blowdown term:**
  ```
  blowdown_i = (P_u_i / V_u_i) * (mdot_i / rho_i)
  ```
  - Pressure decreases as propellant is consumed
  - Proportional to ullage pressure and mass flow rate

### 5. Feed Pressure Dynamics (First-Order Lag)

```
P_d_F[k+1] = P_d_F[k] + dt * (P_u_F - P_d_F) / tau_line_F
P_d_O[k+1] = P_d_O[k] + dt * (P_u_O - P_d_O) / tau_line_O
```

Feed pressures lag behind ullage pressures with time constants `tau_line_F` and `tau_line_O`.

## Mass Flow Estimation

The dynamics model requires mass flow rates `mdot_F` and `mdot_O` as inputs. These should be computed using the existing engine physics pipeline:

```python
from engine.core.runner import PintleEngineRunner

runner = PintleEngineRunner(config)
results = runner.evaluate(P_tank_O=P_u_O, P_tank_F=P_u_F)
mdot_F = results["mdot_F"]
mdot_O = results["mdot_O"]
```

## Usage

### Basic Step

```python
from engine.control.robust_ddp import step, DynamicsParams, ControllerConfig
import numpy as np

# Create config and extract dynamics parameters
config = ControllerConfig()
params = DynamicsParams.from_config(config)

# Initial state
x = np.array([
    30e6,    # P_copv
    24e6,    # P_reg
    3e6,     # P_u_F
    3.5e6,   # P_u_O
    2.5e6,   # P_d_F
    3e6,     # P_d_O
    0.01,    # V_u_F
    0.01,    # V_u_O
])

# Control input
u = np.array([0.5, 0.5])  # 50% open for both

# Mass flows (from engine physics)
mdot_F = 0.5  # kg/s
mdot_O = 1.0  # kg/s

# Step forward
dt = 0.01  # 10 ms
x_next = step(x, u, dt, params, mdot_F, mdot_O)
```

### Linearization

```python
from engine.control.robust_ddp import linearize

# Compute Jacobian matrices for DDP
A, B = linearize(x, u, dt, params, mdot_F, mdot_O)

# A: (8, 8) state Jacobian
# B: (8, 2) control Jacobian
```

## Configuration Parameters

All dynamics parameters are stored in `ControllerConfig`:

```python
config = ControllerConfig(
    # COPV parameters
    copv_cF=1e5,           # [Pa/s per unit u_F]
    copv_cO=1e5,           # [Pa/s per unit u_O]
    copv_loss=1e3,         # [Pa/s]
    
    # Regulator
    reg_setpoint=None,     # [Pa] or None for ratio mode
    reg_ratio=0.8,         # P_reg / P_copv ratio
    
    # Pressurization
    alpha_F=10.0,          # [1/s]
    alpha_O=10.0,          # [1/s]
    
    # Propellant properties
    rho_F=800.0,           # [kg/m³] RP-1
    rho_O=1140.0,          # [kg/m³] LOX
    
    # Feed line dynamics
    tau_line_F=0.01,       # [s]
    tau_line_O=0.01,       # [s]
)
```

## Validation

The dynamics model includes several validation checks:

1. **Blowdown decreases pressure**: When `u=0` and `mdot>0`, ullage pressures decrease
2. **Pressurization increases pressure**: When `u>0` and `P_reg > P_u`, ullage pressures increase
3. **Ullage volume increases**: As propellant is consumed, ullage volumes increase
4. **COPV blowdown**: COPV pressure decreases with control usage and leakage
5. **Feed pressure lag**: Feed pressures follow ullage pressures with time delay

See `tests/test_robust_ddp_dynamics.py` for comprehensive unit tests.

## Notes

1. **Mass flow coupling**: The dynamics model requires mass flow rates as inputs. These should be computed from the engine physics model using current ullage pressures.

2. **Nonlinearity**: The dynamics are nonlinear (especially ullage pressure dynamics). The linearization via finite differences is valid for small perturbations around the operating point.

3. **State constraints**: All pressures and volumes are clamped to be non-negative. In practice, additional constraints (e.g., `P_u_max`, `P_copv_min`) should be enforced by the controller.

4. **Parameter identification**: The dynamics parameters (`copv_cF`, `copv_cO`, `alpha_F`, `alpha_O`, etc.) should be identified from test data or high-fidelity simulations.

5. **Regulator model**: The regulator model is simplified. For more accuracy, use a detailed regulator model if available in the codebase.

