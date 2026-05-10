# Payload Analysis Module

This directory contains tools for analysing cold gas thruster (CGT) performance and their effects on rocket dynamics.

## Cold Gas Thruster Analysis (`cold_gas_thruster.py`)

This module provides a comprehensive physics-based simulation of CO₂ cold-gas thrusters. It handles everything from internal nozzle flow to the resulting angular acceleration of the vehicle.

### Key Features

- **Isentropic Flow Solver**: Uses a robust area-Mach solver to compute nozzle exit conditions (Mach number, velocity, temperature, and pressure).
- **Performance Metrics**: Calculates thrust (momentum + pressure components), mass flow rate, and specific impulse (Isp).
- **Dynamic Analysis**: Estimates the torque and angular acceleration ($\alpha$) applied to the rocket, accounting for the thruster's location and the rocket's moment of inertia.
- **Nozzle Design**: Includes logic to generate Rao bell nozzle contours and automated plotting.

### Physics & Assumptions

- **Gas**: Defaults to CO₂ ($\gamma = 1.289$, $M = 44.01 \text{ g/mol}$).
- **Flow Model**: 1D isentropic flow through a converging-diverging (CD) nozzle.
- **Choking**: Automatically checks the stagnation-to-ambient pressure ratio to determine if the throat is choked ($M=1$).
- **Efficiency**: Applies a nozzle efficiency factor (default 0.95) to the ideal exit velocity.

### Usage

You can run a demo analysis by executing the module directly from the repository root:

```bash
python3 -m payload.cold_gas_thruster
```

To integrate it into your own scripts:

```python
from payload.cold_gas_thruster import ColdGasThruster, ColdGasThrusterConfig

# 1. Define configuration
cfg = ColdGasThrusterConfig(
    throat_diameter=0.005,    # 5 mm
    exit_diameter=0.015,      # 15 mm
    inlet_pressure=800_000,   # 800 kPa
)

# 2. Run analysis
cgt = ColdGasThruster(cfg)
result = cgt.compute()

# 3. View results
print(result.summary())

# 4. (Optional) Generate nozzle contour plot
cgt.generate_nozzle_contour(do_plot=True)
```

### Outputs

- **Console Summary**: A detailed breakdown of areas, exit conditions, and performance totals.
- **`cgt_nozzle.png`**: A visualization of the generated nozzle contour (saved when `do_plot=True` in `generate_nozzle_contour`).
