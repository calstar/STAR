# backend-remastered — LEDGER

Single source of truth for the remaster. **After any context loss, read this first.**

## Orientation (what you need to resume)

| what | where |
|---|---|
| integration branch | `backend-remastered` (from `main` @ `15b5a0c5`) |
| orchestrator worktree | `/Users/roshantaneja/Downloads/STAR/.claude/worktrees/remaster` |
| user's checkout | `/Users/roshantaneja/Downloads/STAR` on `main`, uncommitted `CLAUDE.md` + untracked files — **never touch** |
| clang-format 19 (CI pin) | `/private/tmp/claude-501/-Users-roshantaneja-Downloads-STAR/9d2ae253-7a03-416a-8f13-50dcb4443413/scratchpad/cfvenv/bin` — export as `CLANG_FORMAT_19_DIR`, or prefix `PATH` before `./format.sh`. Local brew llvm is 23 and reformats untouched files. |
| gate | `bash daq-server/test/characterization/gate.sh [--fast]` (logs in `daq-server/.tmp/gate/`) |
| stack lock | `bash daq-server/test/characterization/with_stack_lock.sh <cmd>` — every port-binding run |
| new worktree setup | `git checkout -b <branch> backend-remastered`; `npm ci` in `diablo_server/backend` and `diablo_server/frontend`; no submodules (wire protocol is `lib/daq-protocol`, a plain subtree) |
| elodin-db | `~/.cargo/bin/elodin-db` (needed by test_integration.sh) |

Host checked 2026-11-15: `wifi-10-43-41-87.wifi.berkeley.edu`, no `192.168.2.x` address → dev box.

## Decisions

| # | decision | why |
|---|---|---|
| D1 | **No push, no PR.** Commit locally on `backend-remastered` only. | User's own instruction ("just commit on the branch in local, do not push or create a pr") overrides the goal's "push at each milestone"; the "pushed" completion criterion is struck. |
| D2 | **Port collisions: serialise with a lock**, not port offsets. | `test_integration.sh` already takes ports from env and `.tmp/` is per-checkout, but it `lsof|kill`s whatever holds the test ports and hard-codes `kill_port 5008`, so parallel runs kill each other even with offsets. A mkdir lock (`with_stack_lock.sh`) needs no change to anything under test. |
| D3 | Orchestrator works in its own worktree; agents branch from `backend-remastered` inside theirs. | Agent worktrees are created from the main checkout's HEAD (`main`); the user's checkout has uncommitted work and must not be switched. |
| D4 | Warnings are gated against `test/characterization/baseline_warnings.txt` (10 on `main`, clang/macOS), compared without line numbers. | "No new warnings" needs a fixed reference; line numbers move under any refactor. |
| D5 | `lib/daq-protocol` (repo root, shared with firmware) is out of scope; it is the board wire protocol and stays byte-identical by not being touched. Its bytes are still frozen by the packet goldens. | Firmware is out of scope; the contract is frozen. |
| D6 | clang-format 19.1.7 from pip, not brew's 23. | CI pins 19 (`daq-server-ci.yml`); 23 reformats untouched files. |
| D7 | ctest runs under the stack lock too. | Its sequencer tests bind real local UDP ports (`lib/test/BoardListener.hpp`), so ctest in two worktrees can collide. |
| D8 | Lock lives at `<git-common-dir>/daq-stack.lock` and is re-entrant (`DAQ_STACK_LOCK_HELD`). | Agent shells may have different `TMPDIR`s; gate → run.sh → area run.sh nests. |
| D9 | Two empty agent worktrees (`agent-a129babb…`, `agent-af69f3b5…`) from a failed concurrent launch are left in place. | Removing them was declined by the permission layer; they sit at `main` with no changes. Left for the user. |

## Baseline on `main` (this machine)

| suite | result |
|---|---|
| clean build | ok, 10 unique warnings (frozen in `baseline_warnings.txt`) |
| _rest pending_ | |

## Work packages

| id | goal | owner | worktree | status | files owned | depends on |
|---|---|---|---|---|---|---|
| C0 | gate, lock, characterization skeleton, ledger | orchestrator | remaster | merged (158d330d, f0c4b22c) | `test/characterization/{gate,run,with_stack_lock}.sh`, `CMakeLists.txt`, `README.md`, `docs/remaster/` | — |
| C1 | packets (daq-protocol bytes, transport structs) + Elodin schema goldens | agent | worktree, branch `char/packets` | running | `test/characterization/{packets,elodin}/` | C0 |
| C2 | config loaders (C++ + TS), scripts parser, bad configs | agent | `char/config` | running | `test/characterization/config/` | C0 |
| C3 | calibration math (C++, calibration_service, TS) | agent | `char/calibration` | running | `test/characterization/calibration/` | C0 |
| C4 | sequencer/controller UDP streams, TCP replies, aborts | agent | `char/sequencer` | running | `test/characterization/sequencer/` | C0 |
| C5 | pipeline WS frames, HTTP, logger CSV | agent | `char/pipeline` | running | `test/characterization/pipeline/` | C0 |
| C6 | lifecycle: startup, shutdown, reconnect, dup-sub, heartbeat loss, OTA | agent | `char/lifecycle` | running | `test/characterization/lifecycle/` | C0 |
| B0 | bloat-map research (read-only) | agent | none | done → `docs/remaster/BLOAT-MAP.md` | — | — |
| WP1 | delete tracked junk (root node_modules, .cache, build-ci, build-clang-ci, backend/dist, output/lut bins) | — | — | queued (after suite) | see BLOAT-MAP WP1 | C1–C6 merged + mutation check |
| WP2 | delete C++ no target compiles | — | — | queued | BLOAT-MAP WP2 | WP1 |
| WP3 | lib hygiene: PressureStateMachine, move db.hpp, split Parser/DatabaseConfig | — | — | queued | BLOAT-MAP WP3 | WP2 |
| WP4 | dead launchers + superseded test scripts, `--legacy` branch | — | — | queued | BLOAT-MAP WP4 | WP1 |
| WP5 | backend dead TS + line client + slot helper | — | — | queued | BLOAT-MAP WP5 | WP1 |
| WP6 | split server.ts | — | — | queued | BLOAT-MAP WP6 | WP5 |
| WP7 | split api-server.ts | — | — | queued | BLOAT-MAP WP7 | WP5 |
| WP8 | shared C++ service plumbing | — | — | queued | BLOAT-MAP WP8 | WP3 |
| WP9 | split calibration_main.cpp | — | — | queued | BLOAT-MAP WP9 | WP8 |
| WP10 | split sequencer/controller/actuator/bridge god files | — | — | queued | BLOAT-MAP WP10 | WP9 |
| WP11 | tools/: fix broken documented paths only; GUI deletions parked (operator-facing, team decision) | — | — | queued | BLOAT-MAP WP11 (narrowed) | WP4 |
| WP12 | docs | — | — | queued | BLOAT-MAP WP12 | WP2, WP4, WP5, WP11 |

## Merge log

| when | package | merge commit | gate |
|---|---|---|---|

## Parked

- Untracking `scripts/calibration/calibrations/{cubic_calibration.json,abort_thresholds.txt}`: tracked but gitignored live stores; untracking deletes them on every other checkout (the stand included) at the next pull.
- `calibration/*.json`: the backend's live PT-coefficient store (`calibration.ts:348`).
- `elodin-relay.ts` + `npm run relay`: no consumer found, but tools may connect to ws :9090.
- `archive/legacy/python-services/{heartbeat,config_broadcast}_service.py`: systemd/launcher fallbacks.
- B4, replacing hand-rolled PWM/config/abort encoders with `daq::create_*`: the version byte may change on the wire (contract).
- `backend/package.json` `main`/`start` → missing `dist/server.js`: fixing it changes `npm start`.
- Deleting `tools/` operator GUIs (`tools/gui/**`, the orphaned calibration GUIs): operator-facing, the team's decision, not a refactor's.

## Defects found in the original (kept as-is, for the team)

From the bloat map (BLOAT-MAP.md, "Defects found"):
1. `tools/calibration/calibration_server.py:20-31` imports `scripts.calibration.*` (gone): the Python sidecar cannot start.
2. Several launchers pass `--relay-host/--relay-port`, which `calibration_service` rejects or ignores.
3. `test_integration.sh --legacy` launches the missing `src/server-legacy.ts`.
4. `start_tmux_dev.sh:371` starts the Python heartbeat even when the C++ binary exists.
5. Three separate PT calibration stores (backend `calibration/`, C++ `scripts/calibration/calibrations/`, Python `tools/calibration/calibrations/`).
6. Only 4 of 9 services ignore SIGPIPE; most signal handlers do non-async-signal-safe I/O.
7. Controller PWM and abort packets hard-code protocol version 0 rather than `DIABLO_COMMS_VERSION`.
8. `tools/controller_lut/*.sh` invoke `python -m scripts.controller_lut.*` (moved): the documented LUT regeneration fails.
