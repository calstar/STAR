# STAR — Setup & Running Tests

Getting the repo running from scratch on macOS / Linux. **Windows: use WSL.**
Several scripts depend on Unix tools (`lsof`, `pkill`, `fuser`, `ifconfig`,
`/dev/tcp/...`) that don't work in PowerShell or Git Bash.

---

## 1. Clone

```bash
git clone https://github.com/calstar/STAR.git
cd STAR
```

Three top-level trees, all already vendored — no submodule init step:

- `daq-server/` — DAQ server / FSW (C++ + TypeScript backend + Next.js GUI)
- `firmware/` — Arduino / PlatformIO firmware for every board, subtree of `calstar/DiabloAvionics`
- `lib/DAQv2-Comms/` — wire-protocol library, symlinked into `firmware/libraries/DAQv2-Comms`

**Windows users:** that symlink only resolves if you set
`git config --global core.symlinks true` *before* cloning, or use WSL.

---

## 2. Prerequisites for the integration test

### macOS: install modern bash

The test uses `${PIDS[-1]}`, a bash 4.2+ feature. Apple ships bash 3.2 (frozen
over GPL) and SIP prevents replacing `/bin/bash`. Install via Homebrew and call
the new bash explicitly:

```bash
brew install bash
# Apple Silicon: /opt/homebrew/bin/bash
# Intel:        /usr/local/bin/bash
```

Linux can use the system `bash`.

### C++ build dependencies

```bash
# macOS
brew install cmake openssl
# Linux (Debian/Ubuntu)
sudo apt install cmake libssl-dev zlib1g-dev build-essential
```

The integration test runs cmake + make for you on first invocation.

### Elodin DB

Rust binary. Install from `elodin-sys/elodin` (separate repo) and make sure
it's on `$PATH` or at `~/.cargo/bin/elodin-db`. Test fails fast with
`elodin-db not found` if it can't find one.

### Node.js + tsx

```bash
brew install node      # need 20+
```

Backend's `node_modules/` gets installed on first test run.

### Python 3

Already on macOS. On Linux: `sudo apt install python3 python3-pip`. The
script auto-installs `tomli` if missing.

### macOS-only: loopback aliases

The board simulator binds simulated boards to distinct `127.0.0.x` addresses;
macOS doesn't route those without explicit aliases. The test will offer to add
them with `sudo ifconfig lo0 alias 127.0.0.<n> up` on first run — confirm the
sudo prompt. (No-op on Linux.)

---

## 3. Run the integration test

From the repo root:

```bash
# macOS
/opt/homebrew/bin/bash daq-server/test/test_integration.sh
# Linux
bash daq-server/test/test_integration.sh
```

`-v` / `--verbose` for noisier output. First run ~3-5 min (builds C++, installs
node_modules, configures cmake); subsequent ~1-2 min.

Pass looks like:

```
Results: 58 passed, 0 failed
✅ INTEGRATION TEST PASSED
```

Non-zero exit on any failure. Per-service logs at `daq-server/.tmp/integration_*_<pid>.log`.

### What it tests

Five layers, end-to-end:

1. **Sensor data flow** — fake PT/TC/RTD/LC/encoder packets → DAQ bridge → Elodin DB → backend → WebSocket → frontend asserts every channel
2. **Sensor config + Boards pane** — config broadcast, board status updates, SELF_TEST replay on late connect
3. **State machine** — UI → backend → sequencer → confirmed back via WebSocket and Elodin DB
4. **Actuator commands** — open/close round-trip, UDP packets verified on local listener
5. **Controller service** — connects to Elodin as publisher + subscriber, VTables registered, loop ticking

---

## 4. Common failures

**`❌ FAIL: C++ build failed` on first run.** Empty/stale build dir.
`rm -rf daq-server/build` and re-run.

**`Address already in use` on UDP 5008 (or other ports).** Stale process from a
previous run:

```bash
pkill -9 -f 'daq_bridge|sequencer_service|heartbeat_service|config_broadcast_service|calibration_service|controller_service|elodin-db|tsx.*server\.ts|board_simulator'
```

**`connect ECONNREFUSED 127.0.0.1:8181`.** Backend died mid-test, almost
always from a concurrent run or a `pkill` while a test was running. Tests share
fixed ports — don't run two at once.

**`bash: ${PIDS[-1]}: bad array subscript`.** You ran with `/bin/bash` (3.2)
instead of Homebrew bash. Use the explicit path.

**Sequencer / calibration "Cannot open ... CSV".** Services read CSVs from
`firmware/` (post-May-2026 cleanup) — paths like
`firmware/test_guis/state_transitions.csv`. If `firmware/` is missing or partial:
`git checkout HEAD -- firmware/`.

---

## 5. Firmware tests (optional, recommended when touching `firmware/`)

### Install PlatformIO

```bash
pip3 install platformio --user
```

`pio` installs to `~/Library/Python/<ver>/bin/pio` (macOS) or `~/.local/bin/pio`
(Linux). Add to `PATH` or use the absolute path. ESP32 toolchains download on
first build (~500 MB, one-time).

### Host unit tests (fast)

```bash
cd firmware/Hotfire_Code/Hotfire_Tests
pio test -e native
```

Expected: `63 test cases: 63 succeeded`. Covers sensor + actuator state
machines, ADS126X self-test, DAQv2-Comms round-trip, sensor data collection.

### Compile-check all flight firmware (ESP32 toolchain)

```bash
for proj in PT_Hotfire TC_Hotfire RTD_Hotfire LC_Hotfire Actuator_Hotfire; do
  (cd firmware/Hotfire_Code/$proj && pio run)
done
```

Expected: `[SUCCESS]` per project. Catches lib-resolution / link issues that
host tests miss.

---

## 6. Project layout

```
STAR/
├── daq-server/                      # DAQ server / FSW
│   ├── CMakeLists.txt               # daqv2_comms → ../lib/DAQv2-Comms/...
│   ├── config/config.toml           # board IPs, calibration CSV paths, state-machine durations
│   ├── diablo_server/
│   │   ├── daq_bridge/              # C++ source for the services
│   │   ├── services/                #   sequencer · calibration · heartbeat
│   │   │                            #   · config_broadcast · controller
│   │   ├── backend/                 # TypeScript backend (server.ts), WS + REST
│   │   ├── frontend/                # Next.js + React (TypeScript)
│   │   └── lib/                     # shared FSW C++ lib
│   ├── test/test_integration.sh     # the integration test
│   └── build/                       # cmake build dir (auto-created)
│
├── firmware/                        # subtree of calstar/DiabloAvionics
│   ├── libraries/
│   │   ├── ads126X/                 # ADC driver (canonical, post-cleanup)
│   │   ├── DAQv2-Comms → ../../lib/DAQv2-Comms   # symlink
│   │   ├── EthernetHandler/
│   │   ├── STAR_ISM330DH/
│   │   ├── STAR_LIS3DH/
│   │   └── STAR_MCP3201/
│   ├── Hotfire_Code/
│   │   ├── {PT,TC,RTD,LC,Actuator}_Hotfire/      # flight firmware per board
│   │   └── Hotfire_Tests/                        # Unity unit tests (pio test -e native)
│   ├── test_guis/                   # state_transitions.csv, etc.
│   ├── {PT,TC,RTD,LC}_Board/        # per-board calibration CSVs + test sketches
│   └── Archive/                     # deprecated projects parked here
│
└── lib/
    └── DAQv2-Comms/                 # wire-protocol library — single source of truth,
                                     # used by both daq-server and firmware
```

---

## 7. Before pushing

| Changed | Run |
|---|---|
| `daq-server/` (C++, config.toml, backend) | `bash daq-server/test/test_integration.sh` (58/58) |
| `firmware/` unit-testable logic | `pio test -e native` in `Hotfire_Tests` (63/63) |
| `firmware/Hotfire_Code/*/` board firmware | `pio run` in each affected board project |

No CI at the repo root. Local validation is the gate.
