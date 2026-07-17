# Documentation

Reference docs for the Diablo DAQ server / flight software. For environment
setup and running tests, see the monorepo root [`SETUP.md`](../../SETUP.md) and
the subproject [`README.md`](../README.md).

## Architecture & Protocol

- [adding-sensor-streams.md](adding-sensor-streams.md) — Adding Elodin streams
  (relay, thin parser); includes VTable wire alignment notes (`u32`/`f32` must
  be 4-byte aligned; `CommsMessage` is packed, so add explicit padding after
  `u8`).
- [../../lib/DAQv2-Comms/README.md](../../lib/DAQv2-Comms/README.md) — Wire
  protocol (packet types, 6-byte header, serialize/parse). Single source of
  truth for the on-wire format.
- [DIABLOAVIONICS_NETWORK_CONFIG.md](DIABLOAVIONICS_NETWORK_CONFIG.md) — Board
  network/IP/port configuration for the DAQ bridge.
- [SENSOR_ASSIGNMENT_SYSTEM.md](SENSOR_ASSIGNMENT_SYSTEM.md) — Sensor assignment,
  IP assignment, and configuration distribution.
- [ACTUATOR_PIPELINE_AND_TMUX.md](ACTUATOR_PIPELINE_AND_TMUX.md) — Actuator
  command pipeline and the `start_tmux_dev.sh` dev stack.

## Configuration

- [CONFIGURATION_GUIDE.md](CONFIGURATION_GUIDE.md) — Flight DAQ vs Ground DAQ
  configuration guide.
- [../config/README.md](../config/README.md) — Configuration file reference.

### Flight DAQ (`config_flight_daq.toml`)
- **Network**: `192.168.3.0/24` (IP range 100-150)
- **Sensors**: PT_HP, PT_LP, PT_FUP, PT_FDP, PT_OUP, PT_ODP
- **Use**: Flight operations. During hotfire everything connects to ground DAQ.

### Ground DAQ (`config_ground_daq.toml`)
- **Network**: `192.168.2.0/24` (IP range 100-150)
- **Sensors**: PT_OF, PT_FF, PT_HPF, PT_MPF, PT_LPF
- **Use**: Development, testing, hotfire (all sensors connect here with
  `hotfire.enabled = true`).

```bash
# Ground DAQ (development/hotfire)
./build/bin/daq_bridge config/config_ground_daq.toml

# Flight DAQ (flight operations)
./build/bin/daq_bridge config/config_flight_daq.toml
```

## Operations & Deployment

- Environment setup & build: see the monorepo [`SETUP.md`](../../SETUP.md) and
  the subproject [`README.md`](../README.md).
- [JETSON_DEPLOYMENT.md](JETSON_DEPLOYMENT.md) — Deployment on NVIDIA Jetson
  Xavier NX (ARM64 Ubuntu).
- [ELODIN_GROUNDSTATION_SETUP.md](ELODIN_GROUNDSTATION_SETUP.md) — Elodin
  smoke-test / fake-data setup walkthrough.
- [ADC_AND_ELODIN_DIAGNOSTICS.md](ADC_AND_ELODIN_DIAGNOSTICS.md) — Diagnosing
  ADC distortion and messages not reaching Elodin.

## Controller & Calibration

- [ROBUST_DDP_AND_CALIBRATION.md](ROBUST_DDP_AND_CALIBRATION.md) — Robust DDP
  controller and IMU calibration.
- [CONTROLLER_STACK_AND_DB_WRITES.md](CONTROLLER_STACK_AND_DB_WRITES.md) —
  Controller stack and Elodin DB writes.
- [CONTROLLER_THRUST_CURVE_GUIDE.md](CONTROLLER_THRUST_CURVE_GUIDE.md) — Robust
  DDP thrust-curve matching.
- [CALIBRATION_STACK_ARCHITECTURE.tex](CALIBRATION_STACK_ARCHITECTURE.tex) —
  Calibration stack architecture (LaTeX).
- [PT_Calibration_Writeup.pdf](PT_Calibration_Writeup.pdf) — PT calibration
  writeup.
- [Robust_Dynamic_Thresholding.pdf](Robust_Dynamic_Thresholding.pdf) — Robust
  dynamic thresholding writeup.

## Web GUI

- [web-gui/DATA_FLOW.md](web-gui/DATA_FLOW.md) — Web GUI data flow architecture.
- [web-gui/NETWORK_ACCESS.md](web-gui/NETWORK_ACCESS.md) — Network access
  configuration for the GUI.

## Testing

- [DEBUGGING_AND_TESTING_SCRIPTS.md](DEBUGGING_AND_TESTING_SCRIPTS.md) — Utility
  and diagnostic scripts for verifying the Elodin stack, debugging protocol
  issues, and testing race conditions.
