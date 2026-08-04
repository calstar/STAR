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
./setup.sh                        # interactive menu — pick which projects
./setup.sh --pid-designer         # or set up a single project
./setup.sh --all --yes            # or install everything, non-interactive
```

The top-level `setup.sh` is a thin dispatcher over per-project setup scripts.
Each subproject owns its own install steps
(`daq-server/setup.sh`, `firmware/setup.sh`, `EngineDesign/setup.sh`,
`pid-designer/setup.sh`), so you only pay for what you use — cloning the
repo just to edit the P&ID shouldn't force you to build Rust + `elodin-db`.

The `daq-server/` project has the most dependencies (C++ + Rust +
Python + Node); the others are much lighter. Run `./setup.sh --list` to see
available projects, or `./setup.sh --help` for all flags. For the full
walkthrough — prerequisites, the end-to-end integration test, firmware
builds, and common failure modes — see **[`SETUP.md`](SETUP.md)**.

Each subproject's setup script is also runnable directly
(e.g. `bash daq-server/setup.sh --no-build`); see its `--help` for options
specific to that project.

### Running something

Every project has a `./dev.sh` at its root, and they all take the same flags:

```bash
cd EngineDesign && ./dev.sh          # start it
./dev.sh --attach                    # ...and look at it (Ctrl-B, D to leave)
./dev.sh --status                    # is it up? which ports are listening?
./dev.sh --logs backend              # follow one process
./dev.sh --stop
```

`./dev.sh` starts a **detached** tmux session, so the stack survives closing
the terminal — ssh back in later and `--attach` to debug. `--foreground` runs
it in the terminal instead. `./dev.sh --help` lists everything.

| Project | Command | Ports |
| --- | --- | --- |
| `EngineDesign/` | `./dev.sh` | UI 5173, API 8000 |
| `pid-designer/` | `./dev.sh` | UI 5174, API 8001 |
| `landing/` | `./dev.sh` | 5175 |
| `auth/` | `./dev.sh` | 5000 |
| `daq-server/` | `./dev.sh --sim` | GUI 3000, API+WS 8081 |

They use different ports on purpose — all five can run at once. Each is
overridable (`ENGINE_DESIGN_UI_PORT`, `THIN_WS_PORT`, …); see the project's
`./dev.sh --help`.

`daq-server` is the exception in substance if not in interface: it drives
eleven coordinated processes with real ordering constraints, so its `dev.sh`
is a front door onto `deploy/startup/start_tmux_dev.sh` rather than a
reimplementation. `--sim` runs the whole pipeline against simulated boards, so
you need no test stand.

**No login appears in dev.** Auth is enforced by Caddy in production only
(see [Deployment](#deployment)), and `dev.sh` never runs Caddy.

### Aliases

Optional, and they save the `cd`:

```bash
echo "source ~/STAR/scripts/aliases.sh" >> ~/.bashrc   # adjust to your clone path
```

Every project gets the same verbs — `engine-dev`, `pid-attach`, `daq-logs`,
`landing-stop`, `auth-status` — plus `star-status` and `star-stop` across all
of them at once, and the daq-server build/test shortcuts. Run **`star-help`**
for the full list.

To confirm a clean install works — or to reproduce a broken setup in isolation
— use the setup-test harness (`bash scripts/setup-test/run-macos.sh
pid-designer`); see [`scripts/setup-test/README.md`](scripts/setup-test/README.md).

---

## Deployment

The tools are served together at `*.starberkeley.org`, behind a single Google
login restricted to `@berkeley.edu`. Caddy checks every request with the auth
service before forwarding it, so the apps carry no auth code of their own —
and local development, which never runs Caddy, never sees a login screen.

```bash
cp .env.example .env && cp auth/.env.example auth/.env   # fill both in
docker compose up -d --build
```

See **[`deploy/README.md`](deploy/README.md)** for the full picture: how the
auth handoff works, the Let's Encrypt and Cloudflare Tunnel options, why the
DAQ server runs natively rather than in a container, and how to add an app.

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
