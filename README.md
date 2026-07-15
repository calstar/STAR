# STAR

Software monorepo for **Cal STAR** (Space Technologies at Cal) — the avionics,
ground software, and design tools for our liquid-propellant rocket engine
program. Everything from the firmware running on the sensor boards, to the
ground station that records a hotfire, to the optimizer that designed the
engine lives here, in one repository.

- **Published API docs:** https://calstar.github.io/STAR/ (Doxygen, auto-built on every push to `main`)
- **Setup & running tests:** [`SETUP.md`](SETUP.md)

---

## Subprojects

The repo is a collection of mostly-independent projects, each in its own
top-level directory with its own README. Start with the one you're working on.

| Directory | What it is | Stack |
|---|---|---|
| [`daq-server/`](daq-server/README.md) | Ground support **DAQ server / flight software** — receives sensor data over the network, logs it, drives the state machine and actuators, and serves the live web GUI used during hotfires. | C++, TypeScript/Node, Next.js, Elodin DB |
| [`firmware/`](firmware/README.md) | **Board firmware** for every avionics board (PT, TC, RTD, LC, Encoder, Actuator). Reads sensors, talks to the DAQ server over Ethernet, runs the on-board abort logic. Subtree of [`calstar/DiabloAvionics`](https://github.com/calstar/DiabloAvionics). | Arduino / PlatformIO, ESP32-S3, C++ |
| [`lib/DAQv2-Comms/`](lib/DAQv2-Comms/README.md) | The **wire protocol** shared by the firmware and the DAQ server — packet definitions, enums, and (de)serialization. The single source of truth for what goes over the wire. | C++ (Arduino library) |
| [`EngineDesign/`](EngineDesign/README.md) | **Engine design & optimization pipeline** — physics simulation of liquid bipropellant engines (propellants and injector type are configurable) plus a multi-layer optimizer, a control system, and a web UI. Solves chamber pressure, thrust, and Isp from tank pressures. | Python, FastAPI, React |
| [`pid-designer/`](pid-designer/README.md) | Interactive **P&ID (Piping & Instrumentation Diagram) editor** for the propulsion feed system, with git-backed versioning. | FastAPI, React + React Flow |

### How they fit together

```
        design tools                          test / flight pipeline
  ┌────────────────────────┐     ┌──────────────────────────────────────────┐
  │ EngineDesign/           │     │ firmware/  (ESP32 boards: PT/TC/RTD/...)   │
  │   optimizes geometry    │     │      │  sensor data / heartbeat            │
  │   & pressure curves     │     │      ▼  (lib/DAQv2-Comms wire protocol)    │
  │                         │     │ daq-server/                                │
  │ pid-designer/           │     │   DAQ bridge → Elodin DB → backend         │
  │   lays out the P&ID     │     │   → web GUI + state machine + control      │
  └────────────────────────┘     └──────────────────────────────────────────┘
```

`firmware/` and `daq-server/` are the two ends of the same conversation, and
they speak the protocol defined in `lib/DAQv2-Comms/` (the firmware reaches it
through a symlink at `firmware/libraries/DAQv2-Comms`). `EngineDesign/` and
`pid-designer/` are standalone design tools.

---

## Getting started

```bash
git clone https://github.com/calstar/STAR.git
cd STAR
./setup.sh          # one-time bootstrap (deps, venv, C++ build) — macOS / Linux
```

`setup.sh` installs system dependencies, creates the Python virtualenv, and
builds the C++ binaries. For the full walkthrough — prerequisites, the
end-to-end integration test, firmware builds, and common failure modes — see
**[`SETUP.md`](SETUP.md)**.

Each subproject can also be run on its own; see its README for specifics
(`./dev.sh` in `EngineDesign/` and `pid-designer/`, the tmux dev stack in
`daq-server/`, `pio` in `firmware/`).

---

## Repository conventions

**Documentation.** Every subproject directory has a `README.md` as its front
door, following the same shape: a one-line summary, an **Overview**, an
**Architecture** diagram, a **Directory structure** tree, a **Quick start**,
and a **Documentation** index linking the deeper docs under its `docs/`. Keep
docs describing *how the code works now* — design history, "fix" logs, and
completed migration plans don't belong in the tree (that's what git history is
for).

**Formatting.** Run [`./format.sh`](format.sh) before pushing. It applies
`clang-format` to C/C++ (`.clang-format`, 80-col repo-wide, 100-col under
`daq-server/`) and `black` to Python (`pyproject.toml`, 88-col). `setup.sh` can
install an optional pre-push hook; CI also enforces it.

**Continuous integration.** Workflows live in [`.github/workflows/`](.github/workflows):

| Workflow | Triggers on | Does |
|---|---|---|
| `daq-server-ci.yml` | changes under `daq-server/` | builds the C++ stack, runs the integration test, lints |
| `firmware-ci.yml` | changes under `firmware/` | compiles each flight project + host unit tests with PlatformIO |
| `pid-designer-ci.yml` | changes under `pid-designer/` | TypeScript build + backend import check |
| `docs.yml` | push to `main` | builds Doxygen docs and deploys to GitHub Pages |

**Branches.** Work on a feature branch; the test suites described in
[`SETUP.md`](SETUP.md) are the gate before merging to `main`.
