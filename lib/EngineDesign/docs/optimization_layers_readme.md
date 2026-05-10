# Optimization Layers Structure

This directory contains the modular layers of the full engine optimization pipeline, split from the monolithic `design_optimization_view.py` file.

## File Structure

```
optimization_layers/
├── __init__.py              # Package exports
├── helpers.py               # Shared helper functions (pressure curves, variable conversion)
├── layer0_pre_optimization.py  # Layer 0: Coupled geometry + pintle pre-optimization
├── layer1_static_optimization.py  # Layer 1: Static optimization (geometry + pressure curves)
├── layer2_pressure.py             # Layer 2: Pressure curve optimization
├── layer3_thermal_protection.py  # Layer 3: Thermal protection optimization
├── layer4_flight_simulation.py   # Layer 4: Flight simulation and validation
└── display_functions.py          # Display and plotting functions for results
```

## Layer Responsibilities

### Layer 0: Pre-Optimization
- **File**: `layer0_pre_optimization.py`
- **Purpose**: Coupled pintle + chamber geometry optimization
- **Function**: `run_layer0_pre_optimization()`

### Layer 1: Static Optimization  
- **File**: `layer1_static_optimization.py`
- **Purpose**: Jointly optimize geometry + pressure curve parameters
- **Function**: `create_layer1_objective()`, `validate_layer1_results()`
- **Note**: This is where pressure curves are iterated over

### Layer 2: Pressure Curve Optimization
- **File**: `layer2_pressure.py`
- **Purpose**: Optimize fuel and oxidizer pressure curves for time series solver
- **Function**: `run_layer2_pressure()`

### Layer 3: Thermal Protection
- **File**: `layer3_thermal_protection.py`
- **Purpose**: Final thermal protection sizing (ablative + graphite)
- **Function**: `run_layer3_thermal_protection()`

### Layer 4: Flight Simulation
- **File**: `layer4_flight_simulation.py`
- **Purpose**: Flight trajectory validation
- **Function**: `run_layer4_flight_simulation()`

## Helper Functions

- **File**: `helpers.py`
- Contains:
  - `generate_segmented_pressure_curve()` - Generate pressure curves from segments
  - `segments_from_optimizer_vars()` - Convert optimizer vars to segments
  - `optimizer_vars_from_segments()` - Convert segments to optimizer vars

## Display Functions

- **File**: `display_functions.py`
- Contains all plotting and visualization functions for optimization results

