# Standalone Services

Modular services that run alongside the GUI backend. The backend is GUI-only; these handle FSW concerns.

**C++ preferred for flight:** `heartbeat_service` and `config_broadcast_service` have C++ implementations. Start scripts and systemd use C++ when built; Python is fallback.

## heartbeat_service (C++ / Python)

Sends SERVER_HEARTBEAT (type 2) to boards via UDP broadcast. Polls the GUI backend for `engine_state`.

**Run (C++):** `./build/FSW/heartbeat_service --config config/config.toml`  
**Run (Python):** `python scripts/services/heartbeat_service.py`  
**Config:** `[heartbeat_service]` and `[server_heartbeat]` in config.toml

## config_broadcast_service (C++ / Python)

Builds ACTUATOR_CONFIG (type 6) and SENSOR_CONFIG (type 5) from config.toml + calibration JSON, sends via UDP. No backend dependency.

**Run (C++):** `./build/FSW/config_broadcast_service --config config/config.toml`  
**Run (Python):** `python scripts/services/config_broadcast_service.py`  
**Config:** `[config_broadcast_service]` — set `enabled = true` to use

## data_logger_service.py

Connects to backend WebSocket, writes binary `.sensorlog` files. Starts on ARMED, stops on IDLE/EMERGENCY_ABORT.

**Run:** `python scripts/services/data_logger_service.py --ws-url ws://127.0.0.1:8081`  
**Config:** `[data_logger_service]` — set `enabled = true` to use (backend skips DataLogger when enabled)  
**Requires:** `pip install websocket-client`
