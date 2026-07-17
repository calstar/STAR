# Optimization Layers Structure

The modular layers of the full engine optimization pipeline live in
`engine/optimizer/`. The orchestrator
`run_full_engine_optimization_with_flight_sim()` (in `main_optimizer.py`) runs the
layers in sequence. See `optimizer_readme.md` for the design-vector details and
`layer_requirements.md` for the Layer 1 → Layer 2 hand-off contract.

## File Structure

```
engine/optimizer/
├── __init__.py
├── main_optimizer.py             # Orchestrator (run_full_engine_optimization_with_flight_sim)
├── helpers.py                    # Pressure-curve + optimizer-vector conversion
├── feed_pressure_model.py        # Feed-pressure modeling
├── injector_dp_penalty.py        # Injector ΔP penalty terms
├── copv_flight_helpers.py        # COPV / flight coupling helpers
├── display_results.py            # Result formatting
├── utils.py
├── layers/
│   ├── layer1_static_optimization.py   # Layer 1: static design (parallel CMA-ES)
│   ├── layer2_pressure.py              # Layer 2: pressure-curve optimization
│   ├── layer3_thermal_protection.py    # Layer 3: ablative/graphite sizing
│   └── layer4_flight_simulation.py     # Layer 4: flight validation
└── views/                        # UI view/result helpers (tabs.py, helpers.py)
```

## Layer Responsibilities

### Layer 1: Static Optimization
- **File**: `layers/layer1_static_optimization.py`
- **Purpose**: Jointly optimize chamber/nozzle geometry + initial tank pressures via
  parallel CMA-ES, ranking candidates by a feasibility-gated objective (thrust / O-F
  match, stability margins, injector ΔP).
- **Entry**: `run_layer1_optimization()`. Supports `pintle` (10-var) and `impinging`
  (13-var) design vectors.

### Layer 2: Pressure Curve Optimization
- **File**: `layers/layer2_pressure.py`
- **Purpose**: Optimize the LOX/fuel tank-pressure decay curves over the burn for the
  time-series solver. Initial pressures are fixed from Layer 1.
- **Entry**: `run_layer2_pressure()` (with `run_layer2a_minimum_pressures()` for the
  minimum-pressure sub-step).

### Layer 3: Thermal Protection
- **File**: `layers/layer3_thermal_protection.py`
- **Purpose**: Final thermal protection sizing (ablative liner + graphite insert) sized
  against the recession seen over the Layer 2 burn, with margin.
- **Entry**: `run_layer3_thermal_protection()`

### Layer 4: Flight Simulation
- **File**: `layers/layer4_flight_simulation.py`
- **Purpose**: RocketPy trajectory validation and optimal burn-time search for accepted
  candidates.
- **Entry**: `run_layer4_flight_simulation()`

## Helper Functions

`helpers.py`:
- `generate_segmented_pressure_curve()` — build a pressure curve from segments
- `segments_from_optimizer_vars()` — optimizer vector → pressure segments
- `optimizer_vars_from_segments()` — pressure segments → optimizer vector
