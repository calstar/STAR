# SITL (Software-In-The-Loop) Scripts

This directory contains scripts for integrating the EngineDesign simulation with the Diablo FSW system.

## Scripts

### `sitl_bridge.py` (TODO)
Main bridge between Diablo FSW and engine simulation.

**Responsibilities:**
- Subscribe to Elodin sensor messages
- Convert to engine simulation `Measurement` format
- Subscribe to navigation messages
- Convert to engine simulation `NavState` format
- Publish actuation commands to Elodin
- Log controller state

### `engine_sim_loop.py` (TODO)
Engine simulation control loop.

**Responsibilities:**
- Initialize engine simulation
- Initialize robust DDP controller
- Run control loop at specified rate
- Apply actuation commands to simulation
- Update simulation state

### `sensor_bridge.py` (TODO)
Sensor data conversion utilities.

**Functions:**
- `convert_pt_message_to_measurement(pt_msg, channel_mapping) -> Measurement`
- `subscribe_to_sensors(elodin_client, channels) -> Iterator[Measurement]`

### `actuation_bridge.py` (TODO)
Actuation command conversion utilities.

**Functions:**
- `convert_actuation_to_fsw_command(actuation_cmd) -> ControlMessage`
- `publish_actuation_command(elodin_client, actuation_cmd)`

### `nav_bridge.py` (TODO)
Navigation data conversion utilities.

**Functions:**
- `convert_nav_message_to_navstate(nav_msg) -> NavState`
- `subscribe_to_navigation(elodin_client) -> Iterator[NavState]`

## Dependencies

- `engine_sim/` - Engine simulation submodule
- `utl/Elodin.hpp` - Elodin client (C++ bindings or Python wrapper)
- `comms/include/` - Message definitions

## Example Usage

```python
from scripts.sitl.sitl_bridge import SITLBridge
from scripts.sitl.sensor_bridge import convert_pt_message_to_measurement
from scripts.sitl.actuation_bridge import convert_actuation_to_fsw_command

# Initialize bridge
bridge = SITLBridge(config_path="config/config_sitl.toml")

# Run SITL loop
bridge.run()
```
