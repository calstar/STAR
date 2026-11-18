# Diablo DAQ System

Ground support data acquisition, monitoring, and control system for Diablo Avionics rocket test operations.

The product is a full-stack pipeline: ESP32 sensor boards → UDP → DAQ bridge → Elodin time-series DB → backend → web GUI. This is the `daq-server/` subproject of the STAR monorepo; the pipeline product code lives under `diablo_server/`.

---

## Repo Structure

```
daq-server/                 # this subproject (inside the STAR monorepo)
├── diablo_server/          # All pipeline product code
│   ├── daq_bridge/         # C++ UDP receiver → Elodin DB publisher
│   │   ├── BoardMap.{hpp,cpp}        # [boards.*] map, source IP → board
│   │   └── BackendLogForwarder.hpp   # board LOG text → backend over loopback UDP
│   ├── services/           # C++ service executables (one main per service)
│   │   ├── sequencer/      # State machine + actuator UDP (TCP :9998); also holds the
│   │   │                   #   sequencer classes (StateMachine, ScriptRunner, HoldTimer, …),
│   │   │                   #   split by concern: SequencerService_{config,controller_notify,elodin}.cpp,
│   │   │                   #   ActuatorCommander_load.cpp
│   │   ├── calibration/    # Raw sensor → calibrated sensor (Elodin→Elodin)
│   │   ├── controller/     # RobustDDP controller (Elodin→PWM UDP)
│   │   ├── heartbeat/      # SERVER_HEARTBEAT UDP to boards
│   │   ├── config_broadcast/ # SENSOR_CONFIG / ACTUATOR_CONFIG to boards
│   │   ├── stacklight/     # stack-light commands from sequencer state
│   │   ├── t7_bridge/      # LabJack T7 stream bridge
│   │   └── ota/            # Ethernet OTA firmware flash
│   ├── lib/                # Shared C++ library (fsw_daq_lib.so)
│   │   ├── include/        # Public headers (ElodinClient, StateMachine, StopSignals, TcpCommandServer, …)
│   │   ├── src/            # Implementation; subdirs by area (elodin/, script/, service/, net/, …)
│   │   │   ├── control/ControllerService_{elodin,pwm}.cpp  # ControllerService, split by concern
│   │   │   ├── elodin/SendMsg.hpp     # encode + send one Elodin db.hpp message
│   │   │   ├── script/Printer.cpp     # canonical printer for state scripts (beside Lexer, Parser, Validate)
│   │   │   ├── service/StopSignals.cpp  # stop flag + SIGINT/SIGTERM/SIGPIPE installer (header in include/service/)
│   │   │   └── net/TcpCommandServer.cpp # accept loop shared by sequencer :9998 and controller :9999
│   │   ├── third_party/elodin/db.hpp  # vendored Elodin DB client header (db.hpp)
│   │   └── test/           # C++ unit tests (ctest)
│   ├── transport/          # daq_comms C++ packet parsing library
│   │   ├── include/
│   │   └── src/
│   ├── backend/            # Node.js/TypeScript backend
│   │   ├── src/server.ts   # entry point: WebSocket + HTTP on :8081 (wiring; state lives in src/server/)
│   │   ├── src/server/     # server state and handlers by owner: env, stats, ws-clients, ws-connection,
│   │   │                   #   notifications, history, mission-time, sensor-stream, config-caches,
│   │   │                   #   calibration-state, board-status, engine-state, actuator-mismatch,
│   │   │                   #   elodin-link, ingest, commands (all .ts)
│   │   ├── src/api-server.ts  # HTTP API wiring
│   │   ├── src/api/        # HTTP handlers by area (config, calibration, ota, history, states, …)
│   │   ├── src/routes/     # route modules (calibration/config profiles, script check)
│   │   ├── src/sequencer-client.ts  # TCP :9998 client to sequencer_service
│   │   ├── src/state-csv/  # State-machine CSV readers (state-ids, state-actuators, state-transitions)
│   │   ├── src/video/      # Video gateway
│   │   ├── src/__tests__/  # backend unit tests (vitest)
│   │   └── test/           # backend integration tests
│   ├── frontend/           # React/Vite SPA web GUI (static build served by backend :3000)
│   └── shared/             # Shared TypeScript types
│
├── config/                 # Runtime config files
│   ├── config_base.toml    # Base system config (boards, sensors, actuators)
│   ├── config_flight_daq.toml
│   ├── config_ground_daq.toml
│   └── profiles/           # Per-profile config.toml + the three state-machine CSVs
│                           # (default/, digital-twin/, server/)
│
├── deploy/                 # Deployment and operations scripts
│   ├── startup/            # tmux dev stack launchers (start_tmux_dev.sh, etc.)
│   ├── setup/              # One-time setup scripts (Jetson, network, etc.)
│   ├── dhcp/               # Board-LAN DHCP generator and installer
│   └── systemd/            # systemd unit files for production Jetson deployment
│
├── test/                   # Test scripts and helpers
│   ├── test_integration.sh # Full-stack integration test (run via `int` alias)
│   ├── ws_data_flow_test.ts  # WebSocket data flow assertions (called by integration test)
│   ├── udp_listener.ts     # Captures actuator UDP commands during integration test
│   └── characterization/   # Behaviour-freezing harness for the remaster: goldens per area
│       ├── run.sh          # runs every area (CHAR_AREAS=a,b limits it)
│       ├── gate.sh         # the merge gate (build, ctest, vitest, goldens, integration)
│       └── linux/          # Dockerfile + linux_gate.sh: the same goldens on Linux
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
├── scripts/                # Build & developer-tooling scripts
│   ├── build.sh            # CMake build wrapper (used by `build` alias)
│   └── ...                 # export_sensor_config.py, setup_pre_commit.sh, test_udp.py
│                           # (clang-format/prettier: ../format.sh at the monorepo root)
│
├── docs/                   # Guides; docs/remaster/ holds the refactor's ledger and REPORT.md
├── archive/                # Legacy code kept for reference
│   └── legacy/             # Old Python services (python-services/)
│
└── build/                  # CMake build output (gitignored)
    ├── bin/                # All compiled executables
    └── lib/                # Shared libraries (fsw_daq_lib.so, etc.)
```

The data-logger service and the repo-level `node_modules/`, `build-ci/` and
`.cache/clangd/` that older checkouts carried are gone: build output and editor
caches are no longer tracked.

---

## Quick Start

### Prerequisites

- CMake 3.16+, a C++17 compiler (GCC or Clang)
- Node.js 20+ with `npm`
- `elodin-db` binary in PATH or `~/.cargo/bin/`
- Python 3 with `tomli` for simulators: `pip install tomli`
- `tmux` for the dev stack

### Clone

`daq-server/` is part of the STAR monorepo. Clone the monorepo and follow the
repo-root [`SETUP.md`](../SETUP.md) for full environment setup (toolchains,
Node, Elodin, tmux). In short:

```bash
git clone https://github.com/calstar/STAR.git
cd STAR/daq-server
```

The wire-protocol library, firmware, and engine simulator are sibling trees in
the monorepo (`../lib/DAQv2-Comms/`, `../firmware/`, `../EngineDesign/`) and are
already vendored — the repo has **no git submodules**, so a plain clone gets you
everything. (The optional `fsw_web_bridge` build looks for uWebSockets at
`external/uWebSockets/`, behind an `if(EXISTS …)` guard; vendor it there
manually only if you need that target.)

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
cd diablo_server/backend && npm ci
cd diablo_server/frontend && npm ci
```

---

## Running the Dev Stack

Start the full pipeline (Elodin DB + DAQ bridge + backend + frontend + services):

```bash
./dev.sh --sim           # simulated boards — no test stand needed
./dev.sh                 # real hardware
./dev.sh --attach        # watch it; Ctrl-B then arrows to switch panes, D to detach
./dev.sh --status        # up? which ports are listening?
./dev.sh --logs backend  # follow one process
./dev.sh --stop
```

Navigate to **http://localhost:3000** for the web GUI.

The session starts detached, so the stack keeps running after you close the
terminal — ssh back in later and `--attach` to debug. `./dev.sh` is the same
interface every STAR project has; it is a front door onto
`deploy/startup/start_tmux_dev.sh`, which still does the actual work of
sequencing the eleven processes and is unchanged.

The `daq-gui` / `daq-guitest` / `daq-stopgui` aliases still work — they now call
`./dev.sh --attach`, `--sim-attach` and `--stop`, and `daq-status`, `daq-logs`
and `daq-sim` are new. They moved to the repo-root
[`scripts/aliases.sh`](../scripts/aliases.sh), which covers every project;
`tools/aliases.sh` is a shim so an existing `~/.bashrc` line keeps working. Run
`star-help` for the list.

---

## Integration Test

Runs a full pipeline smoke test: board simulator → DAQ bridge → Elodin → backend → WebSocket client → sequencer TCP:

```bash
int         # runs test/test_integration.sh
```

The test builds any missing binaries, starts all services on offset ports, runs 167 checks, and cleans up. See `CLAUDE.md` for the canonical path.

---

## Configuration

Runtime config is `config/config.toml`, generated from the active profile in `config/profiles/<profile>/` (the profile directory also holds the state-machine CSVs). Key sections:

- `[database]` — Elodin DB host/port
- `[network]` — UDP sensor_port, actuator_cmd_port, broadcast settings
- `[boards.*]` — Per-board IP, type, sensor channel mappings
- `[actuator_roles]` — Named actuator → board/channel mapping
- `[sensor_roles_*]` — Named sensor → board/channel mapping
- `[state_machine]` — FIRE timing parameters
- `[calibration]` — Calibration service parameters

State machine transitions and actuator positions per state are defined in:
- `config/state_transitions.csv`
- `config/state_machine_actuators.csv`
- `config/state_machine_actuator_delays.csv`

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
                                             frontend (Vite SPA :3000)
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
| `../lib/DAQv2-Comms/` | ESP32 Ethernet wire protocol (CMake: `daqv2_comms`) |
| `../firmware/` (PT_Board, RTD_Board, LC_Board, …) | Board firmware (formerly `DiabloAvionics`). Note: the state-machine CSVs the server reads live in `config/`, not here. |
| `../EngineDesign/` | Engine simulator (formerly the `engine_sim` submodule; `daq-server/engine_sim` is now a symlink to it) |

The repo has no git submodules. One optional, non-vendored dependency remains:

| Path | Purpose |
|------|---------|
| `daq-server/external/uWebSockets` | C++ WebSocket library for the optional `fsw_web_bridge` target. Not checked in; the CMake block that uses it is guarded by `if(EXISTS …)`, so the rest of the build is unaffected. Vendor it manually only if you build that target. |
