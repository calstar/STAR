# STAR — Setup & Running Tests

Notes for getting the repo running from scratch on macOS / Linux. Windows users:
use WSL — several scripts depend on Unix tools (`lsof`, `pkill`, `fuser`,
`ifconfig`, `/dev/tcp/...`) that aren't available in PowerShell or Git Bash.

---

## 1. Clone the repo

```bash
git clone https://github.com/calstar/STAR.git
cd STAR
```

The repo is a monorepo of mostly-independent projects, each with its own
top-level directory, its own README, and its own `setup.sh`:

- `daq-server/` — the DAQ server / FSW (C++ + TypeScript backend + Next.js GUI)
- `firmware/` — Arduino/PlatformIO firmware for every board (PT, TC, RTD, LC,
  Encoder, Actuator), subtree of `calstar/DiabloAvionics`
- `EngineDesign/` — engine design & optimization pipeline (Python + FastAPI + React)
- `pid-designer/` — P&ID editor (FastAPI + React Flow)
- `lib/DAQv2-Comms/` — wire-protocol library shared by both `daq-server` and
  `firmware/` (the latter via a symlink at `firmware/libraries/DAQv2-Comms`)

### Windows-only: enable symlinks

`firmware/libraries/DAQv2-Comms` is a relative symlink to `lib/DAQv2-Comms`.
On macOS / Linux this works out of the box; on Windows you need:

```bash
git config --global core.symlinks true
```

before cloning, OR use WSL (recommended — see above).

---

## 2. Run setup

```bash
./setup.sh                        # interactive menu
./setup.sh --daq-server           # single project (non-interactive)
./setup.sh --all --yes            # everything, non-interactive
./setup.sh --list                 # list projects and exit
./setup.sh --help                 # all flags
```

The top-level `setup.sh` is a dispatcher over per-project setup scripts.
Each subproject owns its own steps; you only install what you'll actually use:

| Project | Script | Approx. install time (cold) |
|---|---|---|
| `pid-designer/` | `pid-designer/setup.sh` | ~30s (Python venv + npm) |
| `EngineDesign/` | `EngineDesign/setup.sh` | ~2 min (`--ci` skips rocketcea) |
| `firmware/` | `firmware/setup.sh` | ~30s (PlatformIO CLI only) |
| `daq-server/` | `daq-server/setup.sh` | ~5-10 min (C++ + Rust + Node + Python) |

Any flags the dispatcher doesn't consume are passed through to the sub-scripts,
so e.g. `./setup.sh --engine-design --ci --no-frontend` works. Each sub-script
is also runnable directly (e.g. `bash daq-server/setup.sh --no-build`); run it
with `--help` to see what it accepts.

The shared bits (`black==25.11.0` on the global `$PATH` for `format.sh`, a
Windows-symlink sanity check) run once in the dispatcher.

### Verify a clean install (or debug a broken one)

New to the repo, or is setup misbehaving? `scripts/setup-test/` runs `setup.sh`
in an isolated scratch copy of the tree and then smoke-checks the result — so
you can confirm a fresh install works end-to-end, or reproduce a breakage
without touching your real checkout:

```bash
bash scripts/setup-test/run-macos.sh pid-designer   # quick sanity (~2 min)
bash scripts/setup-test/run-macos.sh all            # every project (~20-30 min)
```

On a brand-new Mac, install Homebrew first (https://brew.sh) — the harness
installs project deps through brew but not brew itself. See
[`scripts/setup-test/README.md`](scripts/setup-test/README.md) for the
Docker/Linux path and full details.

---

## 3. Prerequisites for the integration test

The integration test (`daq-server/test/test_integration.sh`) launches the whole
stack — Elodin DB, DAQ bridge, sequencer / heartbeat / config-broadcast /
calibration / controller services, the Node backend, and a board simulator —
and verifies data flows end-to-end.

`./setup.sh --daq-server` installs everything the test needs on Linux/WSL and
almost everything on macOS. Two things it deliberately does NOT do:

### macOS: install modern bash

The script uses `${PIDS[-1]}` (bash 4.2+). macOS ships `/bin/bash` 3.2 (frozen
in 2007 over GPL licensing). Install via Homebrew:

```bash
brew install bash
```

This installs to `/opt/homebrew/bin/bash` (Apple Silicon) or
`/usr/local/bin/bash` (Intel). **It does not replace `/bin/bash`** — SIP
prevents that. Invoke explicitly when running the integration test (see below).

On Linux you can use the system `bash` directly.

### macOS-only: loopback aliases

The board simulator binds each simulated board to a distinct `127.0.0.x`
address. macOS doesn't route those without explicit aliases. The test script
will offer to add them with `sudo ifconfig lo0 alias 127.0.0.<n> up` the first
time you run it — confirm the sudo prompt. (On Linux all `127.0.0.x` resolve
to `lo` automatically; no action needed.)

### What setup.sh handles for you

For reference — you don't need to run any of this manually if you ran
`./setup.sh --daq-server`:

- C++ build deps: `cmake`, `openssl@3`, `libeigen3-dev`, `build-essential`,
  `ninja-build`, `ccache`, `pkg-config` (list mirrors `daq-server-ci.yml`)
- `elodin-db` (Rust binary) — installed via the upstream prebuilt installer,
  or built from source as a fallback
- Node 20 (from NodeSource on Linux, Homebrew on macOS) + `npm install` for
  both `diablo_server/backend/` and `diablo_server/frontend/`
- Python venv at `daq-server/.venv` with everything in `requirements.txt`
- `cmake` + `make` for the target binaries (skip with `--no-build`)

---

## 4. Run the integration test

From the repo root:

```bash
# macOS
/opt/homebrew/bin/bash daq-server/test/test_integration.sh

# Linux
bash daq-server/test/test_integration.sh
```

Add `-v` / `--verbose` for noisier output. First run takes ~3-5 minutes
(builds C++ binaries, installs Node modules, configures cmake). Subsequent
runs ~1-2 minutes.

### Expected result

```
════════════════════════════════════════════════════════════
  Results: 58 passed, 0 failed
════════════════════════════════════════════════════════════
...
═══════════════════════════════════════════════════════════════
  ✅ INTEGRATION TEST PASSED
═══════════════════════════════════════════════════════════════
```

The test exits non-zero on any failure. Logs are kept under
`daq-server/.tmp/integration_*_<pid>.log` (one per service).

### What it actually tests

Five layers, end-to-end:

1. **Sensor data flow** — fake PT/TC/RTD/LC/encoder packets → DAQ bridge →
   Elodin DB → backend → WebSocket → frontend assertions on every channel
2. **Sensor config + Boards pane** — config broadcast, board status updates,
   SELF_TEST replay on late connect
3. **State machine** — UI sends state change → backend → sequencer →
   confirmed back through the WebSocket and Elodin DB
4. **Actuator commands** — open/close commands round-trip; UDP packets verified
   on local listener
5. **Controller service** — connects to Elodin as publisher + subscriber,
   VTables registered, loop ticking

---

## 5. Common failure modes & fixes

### `❌ FAIL: C++ build failed` on first run

The build subdirectory existed but was empty (e.g. from a stale checkout).
Fix:

```bash
rm -rf daq-server/build
# re-run the test; it will cmake + make from scratch
```

### `Address already in use` on UDP 5008 (or other ports)

Stale process from a previous run still has the port. The script tries to
clean up, but a hard kill is sometimes needed:

```bash
pkill -9 -f daq_bridge
pkill -9 -f sequencer_service
pkill -9 -f heartbeat_service
pkill -9 -f config_broadcast_service
pkill -9 -f calibration_service
pkill -9 -f controller_service
pkill -9 -f elodin-db
pkill -9 -f 'tsx.*server\.ts'
pkill -9 -f board_simulator
```

### Test reports `connect ECONNREFUSED 127.0.0.1:8181`

Backend died mid-test. Almost always because another process killed it —
usually a concurrent run, or your own cleanup `pkill` while a test was
running. Wait for the first test to finish, OR kill everything (above) and
start fresh.

**Do not run two integration tests at the same time.** They share fixed
ports (Elodin 2241, backend WebSocket 8181, etc.).

### `bash: ${PIDS[-1]}: bad array subscript`

You ran the script with `/bin/bash` (bash 3.2) instead of the Homebrew bash.
Use the explicit `/opt/homebrew/bin/bash` path.

### Sequencer / calibration services skip / fail with "Cannot open ... CSV"

The C++ services read state-transition / calibration CSVs from the
`firmware/` subtree (after the May 2026 cleanup) — paths like
`firmware/test_guis/state_transitions.csv`. If your working tree is missing
`firmware/` (e.g. a partial clone or someone deleted it), restore it:

```bash
git checkout HEAD -- firmware/
```

---

## 6. Running the firmware tests (optional, but recommended)

If you change anything in `firmware/`, validate locally before pushing:

### Install PlatformIO

```bash
./setup.sh --firmware
```

`firmware/setup.sh` runs `pip3 install --user platformio` and sanity-checks
the `firmware/libraries/DAQv2-Comms` symlink. The `pio` binary lands at
`~/Library/Python/<ver>/bin/pio` on macOS, or `~/.local/bin/pio` on Linux;
add that dir to your `$PATH` (the script prints the exact line to append to
your shell rc if `pio` isn't already on `$PATH`).

PIO downloads ESP32 toolchains on first build (~500 MB — one-time).
Pass `--with-toolchain` to `firmware/setup.sh` to pre-download them now.

### Run the unit tests (host, fast)

```bash
cd firmware/Hotfire_Code/Hotfire_Tests
pio test -e native
```

Expected: `63 test cases: 63 succeeded`. Covers sensor + actuator state
machines, ADS126X self-test, DAQv2-Comms packet round-trip, sensor data
collection.

### Compile-check all flight projects (ESP32 toolchain)

```bash
for proj in PT_Hotfire TC_Hotfire RTD_Hotfire LC_Hotfire Actuator_Hotfire; do
  (cd firmware/Hotfire_Code/$proj && pio run)
done
```

Expected: `[SUCCESS]` for each. Catches lib-resolution and link issues that
the host tests can't.

---

## 7. Project layout reference

```
STAR/
├── daq-server/                      # DAQ server / FSW
│   ├── CMakeLists.txt               # top-level: daqv2_comms lib → ../lib/...
│   ├── config/config.toml           # board IPs, calibration CSV paths,
│   │                                #   state-machine durations, etc.
│   ├── diablo_server/               # C++ source for daq_bridge, sequencer,
│   │   ├── daq_bridge/              #   heartbeat, config_broadcast,
│   │   ├── services/                #   calibration, controller services
│   │   │   ├── sequencer/           #
│   │   │   ├── calibration/         #
│   │   │   ├── heartbeat/           #
│   │   │   ├── config_broadcast/    #
│   │   │   └── controller/          #
│   │   ├── backend/                 # TypeScript backend (server.ts), WS + REST
│   │   ├── frontend/                # Next.js + React UI (TypeScript)
│   │   └── lib/                     # shared FSW C++ lib
│   ├── test/test_integration.sh     # the integration test (this doc's focus)
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
│   │   ├── PT_Hotfire/              # flight firmware per board
│   │   ├── TC_Hotfire/
│   │   ├── RTD_Hotfire/
│   │   ├── LC_Hotfire/
│   │   ├── Actuator_Hotfire/
│   │   └── Hotfire_Tests/           # Unity unit tests (pio test -e native)
│   ├── test_guis/                   # state_transitions.csv, etc.
│   ├── PT_Board/, TC_Board/, ...    # per-board calibration CSVs + test sketches
│   └── Archive/                     # deprecated projects parked here
│
└── lib/
    └── DAQv2-Comms/                 # wire-protocol library — single source of
                                     # truth, used by both daq-server and firmware
```

---

## 8. Pushing changes

Before pushing anything that touches `daq-server/` or `firmware/`, run the
relevant tests:

| Changed | Test |
|---|---|
| `daq-server/` C++, config.toml, backend | `bash daq-server/test/test_integration.sh` (must pass 58/58) |
| `firmware/` unit-testable logic | `pio test -e native` in `firmware/Hotfire_Code/Hotfire_Tests` (63/63) |
| `firmware/Hotfire_Code/*/` board firmware | `pio run` in each affected board project |

CI runs the same checks on every push (see `.github/workflows/`):
`daq-server-ci.yml`, `firmware-ci.yml`, and `pid-designer-ci.yml` build and
test their respective subprojects, and `docs.yml` publishes the Doxygen docs.
Running the tests above locally before pushing keeps CI green.
