# Software-In-The-Loop (SITL) Integration Guide

## Overview

This document describes the integration of the EngineDesign simulation software with the Diablo FSW sensor system to create a Software-In-The-Loop (SITL) testing environment. This allows testing the flight software control algorithms against a high-fidelity engine simulation before hardware deployment.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Diablo FSW System                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Sensors    │  │   Control    │  │   Elodin     │     │
│  │   (DAQ)      │→ │   System     │→ │   Database   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│         ↓                  ↓                  ↓            │
└─────────┼──────────────────┼──────────────────┼────────────┘
          │                  │                  │
          │                  │                  │
┌─────────┼──────────────────┼──────────────────┼────────────┐
│         │                  │                  │            │
│  ┌──────▼──────┐    ┌──────▼──────┐   ┌──────▼──────┐    │
│  │   Sensor    │    │  Actuation  │   │   Logging   │    │
│  │   Bridge    │    │   Bridge    │   │   Bridge    │    │
│  └──────┬──────┘    └──────┬──────┘   └──────┬──────┘    │
│         │                  │                  │            │
│         └──────────────────┼──────────────────┘            │
│                            │                               │
│                   ┌────────▼────────┐                      │
│                   │  Engine Sim     │                      │
│                   │  Controller     │                      │
│                   │  (Robust DDP)   │                      │
│                   └────────┬────────┘                      │
│                            │                               │
│                   ┌────────▼────────┐                      │
│                   │  PintleEngine    │                      │
│                   │  Runner          │                      │
│                   │  (Physics Sim)   │                      │
│                   └──────────────────┘                      │
│                                                             │
│              EngineDesign Simulation                        │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. Engine Simulation (engine_sim/)

Located at `engine_sim/`, this is the EngineDesign repository on the `christmas` branch.

**Key Components:**
- `engine/core/runner.py` - `PintleEngineRunner` - Core physics simulation
- `engine/control/robust_ddp/` - Robust DDP controller
  - `controller.py` - Main controller class
  - `data_models.py` - Measurement, NavState, Command, ActuationCommand
  - `engine_wrapper.py` - Wraps PintleEngineRunner for controller
  - `ddp_solver.py` - DDP optimization algorithm
  - `safety_filter.py` - Safety filtering and constraints
  - `dynamics.py` - System dynamics model

**Controller Interface:**
```python
from engine.control.robust_ddp import RobustDDPController, Measurement, NavState, Command

# Controller step
actuation_cmd, diagnostics = controller.step(meas, nav, cmd)
```

### 2. Sensor Bridge

Maps Diablo DAQ sensor messages to engine simulation `Measurement` format.

**Required Sensor Mappings:**
- `P_copv` - COPV pressure (from PT sensor)
- `P_reg` - Regulator pressure (from PT sensor)
- `P_u_fuel` - Fuel upstream pressure (from PT sensor)
- `P_u_ox` - Oxidizer upstream pressure (from PT sensor)
- `P_d_fuel` - Fuel downstream pressure (from PT sensor)
- `P_d_ox` - Oxidizer downstream pressure (from PT sensor)

### 3. Actuation Bridge

Maps engine simulation `ActuationCommand` to Diablo FSW control commands.

**ActuationCommand Fields:**
- `duty_F` - Fuel solenoid duty cycle [0-1]
- `duty_O` - Oxidizer solenoid duty cycle [0-1]
- `execution_backend` - PWM or Binary

### 4. Navigation Bridge

Maps Diablo navigation messages to engine simulation `NavState` format.

**Required NavState Fields:**
- `h` - Altitude [m]
- `vz` - Vertical velocity [m/s]
- `ax` - Acceleration [m/s²]
- `ay` - Acceleration [m/s²]
- `az` - Acceleration [m/s²]

## Integration Points

### Sensor Data Flow

1. **DAQ System** → Reads PT sensors → Publishes to Elodin
2. **Sensor Bridge** → Subscribes to Elodin → Converts to `Measurement`
3. **Engine Controller** → Receives `Measurement` → Computes control

### Actuation Data Flow

1. **Engine Controller** → Computes `ActuationCommand`
2. **Actuation Bridge** → Converts to FSW control messages
3. **FSW Control System** → Publishes to Elodin → Applies to hardware/sim

### Logging

All data flows through Elodin database:
- Sensor measurements
- Controller state
- Actuation commands
- Engine performance estimates
- Diagnostics

## Implementation Plan

### Phase 1: Basic Integration
- [ ] Create sensor bridge (DAQ → Measurement)
- [ ] Create actuation bridge (ActuationCommand → FSW)
- [ ] Create navigation bridge (FSW Nav → NavState)
- [ ] Basic SITL loop (measure → control → actuate)

### Phase 2: Real-time Integration
- [ ] Real-time simulation loop
- [ ] Synchronization with Elodin timestamps
- [ ] Performance optimization

### Phase 3: Advanced Features
- [ ] Controller parameter tuning interface
- [ ] Simulation visualization
- [ ] Logging and analysis tools
- [ ] Hardware-in-the-loop (HITL) preparation

## Usage

### Starting SITL

```bash
# Start Elodin database
./scripts/startup/startup_daq_db.sh

# Start SITL bridge
python scripts/sitl/sitl_bridge.py --config config/config_sitl.toml

# Start engine simulation
python scripts/sitl/engine_sim_loop.py --config config/config_sitl.toml
```

### Configuration

Create `config/config_sitl.toml`:

```toml
[sitl]
elodin_host = "127.0.0.1"
elodin_port = 2240
simulation_rate_hz = 100.0
controller_config_path = "engine_sim/configs/controller_default.yaml"

[sensors]
copv_pt_channel = 0
reg_pt_channel = 1
fuel_upstream_pt_channel = 2
ox_upstream_pt_channel = 3
fuel_downstream_pt_channel = 4
ox_downstream_pt_channel = 5

[actuation]
fuel_solenoid_id = 0
ox_solenoid_id = 1
```

## References

- EngineDesign Repository: https://github.com/KushMahajan/EngineDesign/tree/christmas
- Controller Documentation: `engine_sim/docs/control/`
- DDP Solver: `engine_sim/docs/control/DDP_SOLVER.md`
- Controller Summary: `engine_sim/docs/control/CONTROLLER_SUMMARY.md`
