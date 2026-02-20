# SITL Architecture Documentation

## Overview

This document describes the Software-In-The-Loop (SITL) architecture for the Diablo FSW system, following the Betaflight SITL pattern. The SITL system integrates the engine simulation with the flight software to enable testing of control algorithms before hardware deployment.

## Architecture Pattern (Betaflight-style)

The SITL follows a similar pattern to Betaflight SITL:

```
┌─────────────────────────────────────────────────────────────┐
│                    Elodin Database                          │
│              (Central Message Bus)                          │
└───────────────┬─────────────────────────────────────────────┘
                │
        ┌───────┴───────┐
        │               │
┌───────▼──────┐  ┌─────▼──────┐
│   SITL       │  │   FSW       │
│  Simulator   │  │  Control    │
│  (C++)       │  │  System     │
└───────┬──────┘  └─────┬───────┘
        │               │
        │               │
┌───────▼───────────────▼───────┐
│   Engine Simulation Bridge    │
│         (Python)               │
│  ┌─────────────────────────┐  │
│  │ PintleEngineRunner      │  │
│  │ RobustDDPController    │  │
│  └─────────────────────────┘  │
└───────────────────────────────┘
```

## Components

### 1. SITL Simulator (C++)

**Location:** `FSW/src/sitl/SITLSimulator.cpp`

**Responsibilities:**
- Runs simulation loop at fixed rate (100 Hz default)
- Generates sensor data from simulation state
- Publishes sensor data to Elodin (PT, IMU, GPS, Barometer)
- Subscribes to control commands from Elodin
- Applies control commands to simulation
- Runs EKF navigation filter on simulated sensor data
- Publishes navigation state to Elodin

**Key Methods:**
- `simulation_loop()` - Main simulation loop
- `update_physics()` - Physics integration
- `publish_sensor_data()` - Publish sensor messages
- `process_control_commands()` - Handle actuator commands
- `update_ekf()` - Update EKF navigation filter

### 2. Engine Simulation Bridge (Python)

**Location:** `scripts/sitl/engine_sim_bridge.py`

**Responsibilities:**
- Interfaces with Python engine simulation
- Receives evaluation requests from C++ SITL
- Runs PintleEngineRunner for physics simulation
- Runs RobustDDPController for control
- Returns engine state and performance metrics

**Communication Protocol:**
- TCP socket on port 5555 (configurable)
- Simple text protocol:
  - `EVAL <P_fuel> <P_ox>` - Evaluate engine at tank pressures
  - `GET_STATE` - Get current engine state
- Returns JSON responses

### 3. EKF Navigation Filter

**Location:** `FSW/nav/src/EKFNavigation.cpp`

**Integration:**
- Processes simulated IMU measurements
- Processes simulated GPS measurements
- Processes simulated barometer measurements
- Processes engine measurements (thrust, mass flow)
- Estimates vehicle state (position, velocity, attitude)
- Publishes navigation state to Elodin

**State Vector (20 dimensions):**
- Position (x, y, z)
- Velocity (vx, vy, vz)
- Attitude quaternion (qw, qx, qy, qz)
- Accelerometer bias (3)
- Gyroscope bias (3)
- Accelerometer scale factor
- Gyroscope scale factor
- Engine thrust
- Vehicle mass

### 4. Control System Integration

The Robust DDP controller from engine_sim can be integrated:

1. **Sensor Bridge:** Convert Elodin PT messages → `Measurement`
2. **Navigation Bridge:** Convert Elodin Nav messages → `NavState`
3. **Command Bridge:** Convert FSW commands → `Command`
4. **Actuation Bridge:** Convert `ActuationCommand` → FSW control messages

## Data Flow

### Sensor Data Flow

```
Engine Simulation → SITL Simulator → Elodin → FSW EKF → Navigation State
```

1. Engine simulation computes pressures, thrust, etc.
2. SITL simulator generates sensor messages (PT, IMU, GPS, Baro)
3. Messages published to Elodin
4. EKF processes measurements
5. Navigation state published back to Elodin

### Control Data Flow

```
FSW Control System → Elodin → SITL Simulator → Engine Simulation → Actuation
```

1. FSW control system computes actuator commands
2. Commands published to Elodin
3. SITL simulator receives commands
4. Commands applied to engine simulation
5. Simulation updates state

## Real-time Operation

The SITL runs in real-time mode by default:

- Simulation loop runs at fixed rate (100 Hz)
- Physics integration at smaller timestep (10 ms)
- Real-time synchronization ensures simulation matches wall-clock time
- Can be disabled for faster-than-real-time simulation

## Usage

### Starting SITL

```bash
# Start everything (Elodin + Engine Bridge + SITL)
./scripts/sitl/start_sitl.sh

# Or manually:
# 1. Start Elodin database
./scripts/startup/startup_daq_db.sh 2240 sitl_db

# 2. Start engine simulation bridge
python3 scripts/sitl/engine_sim_bridge.py

# 3. Start SITL simulator
./build/FSW/sitl_simulator config/config_sitl.toml
```

### Configuration

Edit `config/config_sitl.toml`:

```toml
[sitl]
simulation_rate_hz = 100.0
realtime = true

[sensors]
copv_pt_channel = 0
# ... other sensor mappings

[ekf]
position_process_noise = 0.1
# ... EKF tuning parameters
```

## Integration with FSW

The SITL integrates seamlessly with existing FSW:

1. **Same Message Types:** Uses same Elodin message types as hardware
2. **Same EKF:** Uses same EKFNavigation filter as flight software
3. **Same Control:** Can use same control algorithms
4. **Same Logging:** All data flows through Elodin for analysis

## Testing Workflow

1. **Develop Control Algorithm:** Write/test in simulation
2. **Validate with SITL:** Test against high-fidelity engine simulation
3. **Test with EKF:** Verify navigation filter performance
4. **Hardware Testing:** Deploy to hardware when validated

## References

- Betaflight SITL: https://github.com/elodin-sys/elodin/tree/main/examples/betaflight-sitl
- Engine Simulation: `engine_sim/docs/`
- EKF Navigation: `FSW/nav/include/EKFNavigation.hpp`
- Controller: `engine_sim/docs/control/`



