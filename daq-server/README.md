# Diablo DAQ System

Ground support data acquisition, monitoring, and control system for Diablo Avionics rocket test operations.

The product is a full-stack pipeline: ESP32 sensor boards → UDP → DAQ bridge → Elodin time-series DB → backend → web GUI. Everything lives under `diablo_server/`.

---

## Repo Structure

```
Diablo-FSW/
├── diablo_server/          # All pipeline product code
│   ├── daq_bridge/         # C++ UDP receiver → Elodin DB publisher
│   ├── services/           # C++ background services
│   │   ├── sequencer/      # State machine + actuator UDP (TCP :9998)
│   │   ├── calibration/    # Raw sensor → calibrated sensor (Elodin→Elodin)
│   │   ├── controller/     # RobustDDP controller (Elodin→PWM UDP)
│   │   ├── heartbeat/      # SERVER_HEARTBEAT UDP to boards
│   │   ├── config_broadcast/ # SENSOR_CONFIG / ACTUATOR_CONFIG to boards
│   │   ├── data_logger/    # CSV data logger from Elodin
│   │   └── ota/            # Ethernet OTA firmware flash
│   ├── lib/                # Shared C++ library (fsw_daq_lib.so)
│   │   ├── include/        # Public headers (ElodinClient, StateMachine, …)
│   │   └── src/            # Implementation
│   ├── transport/          # daq_comms C++ packet parsing library
│   │   ├── include/
│   │   └── src/
│   ├── backend/            # Node.js/TypeScript backend (server.ts → WS+HTTP)
│   ├── frontend/           # React/Next.js web GUI
│   └── shared/             # Shared TypeScript types
│
├── config/                 # Runtime config files
│   ├── config.toml         # Main system config (boards, sensors, actuators)
│   ├── config_flight_daq.toml
│   └── config_ground_daq.toml
│
├── external/               # Git submodules
│   ├── DAQv2-Comms/        # ESP32 comms library (daqv2_comms CMake target)
│   ├── DiabloAvionics/     # Board firmware + state machine CSVs
│   └── uWebSockets/        # WebSocket library for C++ services
│
├── deploy/                 # Deployment and operations scripts
│   ├── startup/            # tmux dev stack launchers (start_tmux_dev.sh, etc.)
│   ├── setup/              # One-time setup scripts (Jetson, network, etc.)
│   └── systemd/            # systemd unit files for production Jetson deployment
│
├── test/                   # All test scripts and helpers
│   ├── test_integration.sh # Full-stack integration test (run via `int` alias)
│   ├── ws_data_flow_test.ts  # WebSocket data flow assertions (called by integration test)
│   ├── udp_listener.ts     # Captures actuator UDP commands during integration test
│   └── verify_packet_reception.sh
│
├── sim/                    # Simulators
│   ├── board_simulator.py  # Simulates all ESP32 sensor boards over UDP
│   └── board_startup_sim.py # Simulates board startup handshake (SETUP→SELF_TEST)
│
├── tools/                  # Developer utilities (not part of the runtime pipeline)
│   ├── calibration/        # Python calibration analysis tools and GUIs
│   ├── controller_lut/     # Controller look-up table generation
│   ├── debug/              # Debug and diagnostic scripts
│   ├── gui/                # Standalone GUI tools
│   └── postprocessing/     # Post-flight data analysis
│
├── scripts/                # Build and format scripts
│   ├── build.sh            # CMake build wrapper (used by `build` alias)
│   └── format.sh           # clang-format + prettier
│
├── archive/                # Legacy code kept for reference
│   └── legacy/             # Old Python services, old C++ monolith, nav, SITL
│
└── build/                  # CMake build output (gitignored)
    ├── bin/                # All compiled executables
    └── lib/                # Shared libraries (fsw_daq_lib.so, etc.)
```

---

## Quick Start

### Prerequisites

- CMake 3.16+, a C++17 compiler (GCC or Clang)
- Node.js 20+ with `npm`
- `elodin-db` binary in PATH or `~/.cargo/bin/`
- Python 3 with `tomli` for simulators: `pip install tomli`
- `tmux` for the dev stack

### Clone

```bash
git clone --recursive <repo-url>
cd Diablo-FSW
```

Or if already cloned:

```bash
git submodule update --init --recursive
```

### Build C++

```bash
mkdir build && cd build
cmake ..
make -j$(nproc)
```

Binaries land in `build/bin/`, shared libs in `build/lib/`.

Or use the alias:

```bash
build   # runs scripts/build.sh from repo root
```

### Install Frontend/Backend Dependencies

```bash
cd diablo_server/backend && npm install
cd diablo_server/frontend && npm install
```

---

## Running the Dev Stack

Start the full pipeline (Elodin DB + DAQ bridge + backend + frontend + services):

```bash
gui         # starts deploy/startup/start_tmux_dev.sh in a tmux session
stopgui     # kills the tmux session
guitest     # same as gui but with USE_SIM=1 (board simulator instead of hardware)
```

Navigate to **http://localhost:3000** for the web GUI.

---

## Integration Test

Runs a full pipeline smoke test: board simulator → DAQ bridge → Elodin → backend → WebSocket client → sequencer TCP:

```bash
int         # runs test/test_integration.sh
```

The test builds any missing binaries, starts all services on offset ports, runs ~39 checks, and cleans up. See `CLAUDE.md` for the canonical path.

---

## Configuration

All runtime config lives in `config/config.toml`. Key sections:

- `[database]` — Elodin DB host/port
- `[network]` — UDP sensor_port, actuator_cmd_port, broadcast settings
- `[boards.*]` — Per-board IP, type, sensor channel mappings
- `[actuator_roles]` — Named actuator → board/channel mapping
- `[sensor_roles_*]` — Named sensor → board/channel mapping
- `[state_machine]` — FIRE timing parameters
- `[calibration]` — Calibration service parameters

State machine transitions and actuator positions per state are defined in:
- `firmware/test_guis/state_transitions.csv`
- `firmware/test_guis/state_machine_actuators.csv`

---

## Architecture

```
ESP32 boards (UDP)
       │
       ▼
  daq_bridge  ──────────────────────────────► Elodin DB :2240
  (C++, build/bin/)                               │
                                                  │
  calibration_service  ◄──────────────────────────┤
  (reads raw PT/TC → writes PT_Cal/TC_Cal)         │
                                                  ▼
  controller_service   ◄── Elodin calibrated   backend (server.ts)
  (RobustDDP → PWM UDP)                            │
                                                  ▼
  sequencer_service    ◄── WS SEND_COMMAND   browser WebSocket
  (TCP :9998 state machine + actuator UDP)         │
                                                  ▼
                                             frontend (Next.js :3000)
```

---

## Deployment (Jetson Xavier NX)

Run the one-shot Jetson setup:

```bash
./deploy/setup/setup_jetson.sh
```

For production systemd services, see `deploy/systemd/`. The working directory for all services is the repo root; binaries are resolved as `./build/bin/<name>`.

---

## External dependencies

Most code that used to live in external repos is now vendored in-tree:

| Path | Purpose |
|------|---------|
| `lib/DAQv2-Comms/` | ESP32 Ethernet packet format (CMake: `daqv2_comms`) |
| `firmware/` (PT_Board, RTD_Board, LC_Board, test_guis, …) | Board firmware + state machine CSV definitions (formerly `DiabloAvionics`) |
| `EngineDesign/` | Engine simulator (formerly `engine_sim` submodule; `daq-server/engine_sim` is a symlink to it) |

The one remaining real submodule:

| Submodule | Purpose |
|-----------|---------|
| `daq-server/external/uWebSockets` | C++ WebSocket library used by OTA service |

Initialize / update:

```bash
git submodule update --init --recursive
```
