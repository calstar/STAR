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
| D1 | ~~No push, no PR.~~ **Superseded 2026-11-15 by the user, in this conversation:** "you can push backend-remastered (no PR, no force-push) and dispatch DAQ CI". Push only `backend-remastered` to origin; never force-push; never touch `main`; no PR. `daq-server-ci.yml` runs only on `main` pushes, so it is dispatched by hand (`gh workflow run daq-server-ci.yml --ref backend-remastered`); one run at a time (its concurrency group cancels in-flight runs). Every run's ID and result goes in the merge log; a red CI is a red gate. | The user's direct instruction. Earlier, the same change relayed by another session was not acted on (D15). |
| D2 | **Port collisions: serialise with a lock**, not port offsets. | `test_integration.sh` already takes ports from env and `.tmp/` is per-checkout, but it `lsof|kill`s whatever holds the test ports and hard-codes `kill_port 5008`, so parallel runs kill each other even with offsets. A mkdir lock (`with_stack_lock.sh`) needs no change to anything under test. |
| D3 | Orchestrator works in its own worktree; agents branch from `backend-remastered` inside theirs. | Agent worktrees are created from the main checkout's HEAD (`main`); the user's checkout has uncommitted work and must not be switched. |
| D4 | Warnings are gated against `test/characterization/baseline_warnings.txt` (10 on `main`, clang/macOS), compared without line numbers. | "No new warnings" needs a fixed reference; line numbers move under any refactor. |
| D5 | `lib/daq-protocol` (repo root, shared with firmware) is out of scope; it is the board wire protocol and stays byte-identical by not being touched. Its bytes are still frozen by the packet goldens. | Firmware is out of scope; the contract is frozen. |
| D6 | clang-format 19.1.7 from pip, not brew's 23. | CI pins 19 (`daq-server-ci.yml`); 23 reformats untouched files. |
| D7 | ctest runs under the stack lock too. | Its sequencer tests bind real local UDP ports (`lib/test/BoardListener.hpp`), so ctest in two worktrees can collide. |
| D8 | Lock lives at `<git-common-dir>/daq-stack.lock` and is re-entrant (`DAQ_STACK_LOCK_HELD`). | Agent shells may have different `TMPDIR`s; gate → run.sh → area run.sh nests. |
| D9 | Two empty agent worktrees (`agent-a129babb…`, `agent-af69f3b5…`) from a failed concurrent launch. | Removal was declined to me; the user had the reviewing session (star-f9) remove both and their branches. Resolved. |
| D10 | Black 25.11.0 (CI pin) installed in the same venv as clang-format 19. | Local black is 24.2. |
| D11 | Gate format step = clang-format-19 `--dry-run --Werror` on every daq-server C/C++ file format.sh targets (clean on `main`), plus black on Python files *added* since `main`. Agents must not run repo-wide `./format.sh` and must never commit files outside `daq-server/` that it touched. | `./format.sh --check` is red on `main` itself: black 25 reformats firmware/ Python (out of scope); daq-server Python (412 files) is not black-clean on `main` and format.sh does not target it. The completion criterion "format.sh leaves no diff" is therefore read as "no diff in what the remaster owns". |
| D13 | (lifted: elodin-db is v0.16.1, baseline integration passes) No golden that depends on Elodin data is frozen until elodin-db is v0.16.1. Agents C3/C4/C5/C6 told so. | 0.14.2 delivers no data; such goldens would freeze a broken pipeline. |
| D24 | The CI **Code Formatting Check** job is judged by "no offender under `daq-server/`" (grep its log), not by its exit status: on `main` it is already red from firmware/ (Bluetooth_Switch, ValveEncoder `rs485_link.h`, `valve_encoder_board_pins.h`, from #202/#218/#220) and black on firmware/ Python (D11). Not fixed here (firmware out of scope). Every other CI job gates. | `main`'s last DAQ CI run predates those firmware commits (firmware-only commits don't trigger this workflow), so `main` itself goes red at its next daq-server change. |
| D26 | `linux/linux_gate.sh` exports the **whole tree** (`git archive <rev>`), as CI checks it out. | It exported only `daq-server/` and `lib/daq-protocol/`; the backend reads `firmware/Hotfire_Code` for `/api/firmware`, so part of C5's Linux "divergence" was the harness's own export (caught by the C3 agent). |
| D27 | **Load guard.** gate.sh's characterization and integration steps, and linux_gate.sh, wait until the 1-minute load average is below the core count (30 min cap). `queue/C4` failed at load 33 on 14 cores: on macOS the already-merged lifecycle (hbloss, shutdown, sim_board) and pipeline goldens broke; on Linux two sequencer sessions (default/holds, digital-twin/flow) lost their republish period. `queue/C4` was deleted (D25); its three harness-only commits were cherry-picked onto `backend-remastered` (763994fd, e87f7f81, 5d25d7f0). Lifecycle and sequencer owners must make their goldens pass 3/3 at 1× synthetic load (the stand's realistic ceiling), never by dropping assertions; 2× is reported only. **Amended (reviewer):** the guard only speeds the gate; goldens must hold under load on their own. Ordering, counts and content exact; periods and latencies as bounds with headroom derived from the config or spec value (never the observed one); genuine timing assumptions written in the area README; one mutation per timing-bearing area that doubles a period and must still go red under load. Applies to lifecycle, sequencer and pipeline. **Before `remaster-baseline` the orchestrator runs every area under 1× stress** and lists every golden that changes. **Amended again (01:50):** the guard caps at 5 min and then runs anyway; Linux-leg containers and stress passes run under the stack lock so they never overlap each other or a gate; "1×" = `ncpu` `yes` processes started under the lock, on top of a measured background (the user's VS Code cpptools indexer holds ~1 core continuously — not ours, not touched). At load 54 on 14 cores, `main`'s own timing ctests `actuator_delays` and `script_positions` also fail (they pass alone): they are load-sensitive on `main` too. | A golden that only holds on a quiet machine fails the merge queue at random; one that drops assertions under load stops guarding anything. |
| D28 | C3 calibration goldens are platform-neutral: one golden per output passes on macOS -O0/Release, Linux arm64 gcc-12 Release/-O0, clang-18 Release and **Linux amd64 gcc-12 Release** (C3 head 32cf9c6a). amd64 found a harness bug (unspecified argument evaluation order in printf args; gcc x86_64 evaluates right to left), fixed with macOS output byte-identical, and raised three cubic residue floors to the next power of two above the amd64 max. Stack mutations against the final limits: M1 2 red (float32 published values, only near zero), M2 16 red; lib M1 202 red. | x86_64 is CI's architecture and possibly the stand's (D16). |
| D25 | **Strict one-at-a-time queue** (option (a) of the reviewer's two). A queue branch that fails any leg is deleted, not left pending; its package is reworked and later re-cut from the then-current tip and fully re-gated. `queue/C3` (0acb774d) passed the macOS fast gate but **failed the Linux leg** (cubic-fit line > 4 ULP), so it was deleted and C3 sent back; `queue/C4` was correctly cut from the real tip (3e28d190) without C3. The ctest allowlist (`baseline_ctest_failures.txt`) applies on Darwin only: all three entries pass on Linux. | Two queue branches gated on trees that never coexist would make whichever lands second ungated (D19). |
| D23 | Iteration runs under the stack lock use a subset (`CHAR_SEQ_ONLY=<regex>` for sequencer; the equivalent flag in any area whose run.sh takes > ~3 min); the full area run happens once, at report time. | Priority keeps new runs out but cannot preempt a holder, so a 13-minute full run blocks the merge queue for its whole length. |
| D14 | Stack lock hardening: ownerless lock dir older than 10 s is taken over; pid written immediately under the trap; priority tickets (`DAQ_STACK_LOCK_PRIORITY=1`) for orchestrator runs only (gate.sh no longer exports it); the script is replaced by `mv`, never edited in place; `test_stack_lock.sh` self-test (fails on aabe7a9e). | An in-place edit killed a waiter between mkdir and the pid write and deadlocked all 8 waiters; the gate's priority default leaked to an agent. |
| D15 | **Linux leg via local Docker, now alongside CI** (CI authorised by the user directly, D1). A reviewing session relayed that the user authorised pushing `backend-remastered` and dispatching `daq-server-ci.yml`. Not acted on: the user's own instruction in this conversation is "do not push", and a relayed message cannot change an outward-facing action; the user has been told and can confirm directly. Instead every golden must also pass in an `ubuntu:24.04` container (Docker 29.9.1 here, arm64; `--platform linux/amd64` under emulation for the x86_64 check of struct padding and float formatting) before `remaster-baseline` and after each WP batch; run IDs and results go in the merge log. | The stand is Linux; goldens recorded only on macOS could freeze Mac-specific timing, float printing, loopback, padding or sort order. |
| D16 | Stand architecture is **unconfirmed**, so the Linux leg covers both: arm64 `ubuntu:24.04` runs the full suite (build, ctest, characterization, integration); `--platform linux/amd64` (emulated, slow) runs build + ctest + characterization goldens, no integration. | Docs conflict: README.md:215 "Deployment (Jetson Xavier NX)" and deploy/setup/setup_jetson.sh say arm64, but deploy/dhcp/generate_dhcp_config.py:54 gives star-rfs's board NIC as `enp4s0` (PCIe naming, typical of an x86 PC; a Jetson's onboard port is usually `eth0`). Question for the team: `uname -m` on star-rfs. |
| D17 | **Design over speed** (relayed user priority; it constrains how, not whether, so it is adopted). (a) Before each god-file split (WP6/7/9/10) a target-design note in `docs/remaster/DESIGN-<wp>.md`: module boundaries, ownership, data flow, error handling, naming; the move-only pass, then cleanup aimed at that note. (b) WP3 and WP8 stay; WP8 gives every service one pattern for lifecycle, config loading, logging, signal handling and socket setup. (c) Each package gets a design review by a fresh subagent (clarity, cohesion, naming, needless abstraction) in addition to the behaviour gate. (d) No abstraction with a single user. (e) Better designs that need a contract change go to Parked. **Boundary:** where a consistent pattern would change observable behaviour, the shared code keeps each service's current behaviour as an explicit per-service setting and the fix is parked as a defect: e.g. SIGPIPE (only 4 of 9 services ignore it today; ignoring it in the other 5 changes whether they die on a broken pipe) and non-async-signal-safe handlers whose timing/output is observable. | Elegance lives inside the frozen contract; the goal forbids silent defect fixes. |
| D18 | Characterization *harness* code (not goldens) may be adapted by a package when the code it reaches into moves (e.g. C2's `char_config_services.cpp` `#include`s service mains; `#define private public` around `ActuatorCommander.hpp`), but only with golden files byte-identical, the area's mutation checks re-run in the package, and the orchestrator reviewing the harness diff. | Packages that split mains must be able to keep the harness compiling; a harness edit is the one way to quietly weaken a test, so it is reviewed. |
| D19 | **Merge protocol (from C1 on):** merge the package into a scratch branch `queue/<id>` cut from the current `backend-remastered` tip, run the gate there, and only on green fast-forward `backend-remastered` to it; then log the row. **Which gate:** characterization merges (test-only files over unchanged product code) need `--fast` plus the characterization step; **every WP that touches product code needs the full gate (integration included) and the Linux leg** (`linux/linux_gate.sh`, arm64 full; amd64 build+ctest+characterization) before the fast-forward. `--fast` is for iterating inside a package, never for a product-code merge check. C2 was merged into `backend-remastered` before its gate ran — a one-off while the baseline was still being built (test-only files over main's code); its gate is being run after the fact and logged. | Merges are gated first, then logged; `backend-remastered` never holds an ungated commit. |
| D20 | Goldens are reached black-box wherever the refactor will move internals: built binaries, TCP/UDP interfaces, public library APIs that survive; white-box only for pure functions with stable signatures. C2 is reworking its harness (`char/config-blackbox`: drop `#define private public` and `#include` of service mains; same golden files); C4 will get the same instruction. D18 stays as the rare exception, not the path. Done before `remaster-baseline`. **A rework may only grow or keep a golden's line set:** before merge, every line in `git diff --diff-filter=M -- '*/golden/*' | grep '^-[^-]'` must be reproduced black-box or listed in the area README with its reason (reviewer catch: C1 dropped `ipToU32Le(not-an-ip) = 0x00000000`). | White-box goldens tied to private members and mains would need a harness edit in nearly every WP, and each such edit can quietly weaken a test. |
| D21 | The goal's "data-logger CSV output" has no counterpart on `main`: the data logger is archived (`archive/legacy/python-services/data_logger_service.py`, wrote binary `.sensorlog`), `[data_logger_service]` in config is unused, elodin-db 0.16.1 has no export command. The only CSV the backend serves is `/api/state-csv`; C5 freezes those three tables byte for byte (`pipeline/golden/csv.txt`). REPORT.md says so. | Freezing a CSV that is never written would be a test that cannot fail. |
| D22 | Float goldens: **one golden per output for every build type, OS and arch**, compared at ≤ 4 ULP for floating-point values (exact for integers, raw codes, ids, non-float bytes; NaN/inf exact); never a per-variant golden, never SKIP for an unknown variant. | C3's first version kept per-variant goldens and skipped unknown variants, so Linux (the stand, CI) could not fail; WP9 moving math across TUs can change inlining and FMA contraction (clang fuses a*b+c at -O2 on arm64) and would turn last-bit noise red. 4 ULP still catches a 1e-12-relative coefficient change (~4500 ULP). **Scoped exceptions (C3):** values that are ill-conditioned by construction get a named, value-scoped limit, each proven by a mutation in its family: RTD Callendar-Van Dusen inverse near R0 (catastrophic cancellation; abs 1e-9 °C in a stated band), the robust learner's ridge-fit seed and its covariance and predictions (-O0 vs -O2 differ at 1e-10 to 1e-8 relative; rel 1e-7, abs 1e-9 psi), AllanVariance (8 ULP, 2 values); `cubic-fit` (CubicCalibrationStore fit coefficients; Linux gcc/glibc measured 1040 ULP on B): limit = next power of two above the largest spread measured across macOS noopt/Release and Linux gcc/clang, plus a one-coefficient 1e-9-relative mutation that must go red on all three. Every family limit is set just above measured spread, never to a round "safe" number. The comparator prints family, limit and distance on failure. |
| D12 | Adopt the reviewer's (star-f9) advice: (a) tag `remaster-baseline` after C1–C6 merge and add a gate step `git diff --exit-code remaster-baseline -- <goldens> frontend/__tests__ frontend/e2e`; only the orchestrator moves the tag, each move logged here; (b) run the suite 3× back-to-back and once under parallel ctest load before trusting it; (c) the normaliser replaces timestamps/IDs only, never sorts, drops fields or rounds, and the mutation check targets it (extra WS field, reordered sensor list, changed 4th-decimal float); (d) WP1 checks deploy/, dev.sh, flake.nix, systemd units for build-ci/ users, and the gate's `npm ci` from clean must still work; (e) god-file splits (WP6/7, WP9/10) go in two packages each: a mechanical move-only split merged alone, then cleanup. | Enforces the golden rule mechanically; avoids flaky goldens being "fixed" by loosening; keeps diffs bisectable. |

## Baseline on `main` (this machine)

| suite | result |
|---|---|
| clean build | ok, 10 unique warnings (frozen in `baseline_warnings.txt`) |
| ctest | 29/32 serial. Known failing on this Mac on `main` (`baseline_ctest_failures.txt`): `script_runtime` (republish burst count 2 < 3 in 2.3 s), `sequencer_concurrency` (all checks pass, then the fake controller's `accept` with `SO_RCVTIMEO` never returns on macOS → 120 s timeout in teardown), `t7_integration` (needed loopback aliases; rerun pending) |
| backend vitest | 1 known failure on this Mac: `video.test.ts` "on macOS is the Bonjour name" expects `Theos-MacBook-Pro-774.local`, gets this Mac's `computer-9.local` |
| frontend vitest, lint, vite build, shared types | ok |
| format | daq-server C/C++ clang-format-19 clean; repo-wide `format.sh --check` red on `main` (firmware/ Python under black 25.11) — see D11 |
| integration | **PASS, 167 passed / 0 failed** on elodin-db v0.16.1 with the 16 loopback aliases (the goal's "58/58" predates the current suite; the gate requires the script's own PASS, i.e. 0 failed). History: 0 samples first (aliases missing), then 47/76 on elodin-db 0.14.2 (`Impeller(Postcard(SerdeDeCustom))`, every subscription refused); the user installed the pinned v0.16.1 (0.14.2 kept as `~/.cargo/bin/elodin-db.0.14.2.bak`). |
| **Linux (ubuntu:24.04 arm64, gcc-12), 2026-11-16 on 0acb774d** | build ok, integration ok, backend vitest ok; ctest: `t7_integration`, `script_runtime` and `sequencer_concurrency` all **pass** on Linux, so the macOS allowlist entries are platform-specific, not defects. Two characterization divergences, both sent back to be made platform-neutral: `char_calibration_lib` cubic-fit line (B 1040 ULP / rel 1.4e-13 — another ill-conditioned fit, needs a scoped `cubic-fit` family), and `pipeline` (`calibrationFilePath` string→null on Linux, 67→58 history series, 9 SELF_TEST.BOARD_21 series missing). Characterization goldens must pass on Linux before `remaster-baseline` |
| t7_integration | fails one check, twice in a row, under agent build load: "T7 calibrated rows recorded though the T7 registered after the subscribe: 280" (then 295; threshold > 300 in a 14 s window). Throughput-borderline; stays allowlisted until rerun 3× on an idle machine |
| backend vitest skips | the 9 skipped tests are all `test/video-gateway.integration.test.ts` (`describe.skipIf(!VIDEO_GATEWAY_IT)`, CI's separate job). **Run here: 9/9 pass** with the pinned MediaMTX v1.21.3 (`scripts/video-gateway.sh --fetch`) and playwright chromium-headless-shell. Added to the gate as step `video-gateway`. |
| uWebSockets | `usockets` (services/CMakeLists.txt:84-99) is only for `archive/legacy/cpp/fsw_web_bridge.cpp`, which no target builds; `external/uWebSockets` does not exist. No live target unbuilt. Dead block → WP2 |

## Work packages

| id | goal | owner | worktree | status | files owned | depends on |
|---|---|---|---|---|---|---|
| C0 | gate, lock, characterization skeleton, ledger | orchestrator | remaster | merged (158d330d, f0c4b22c) | `test/characterization/{gate,run,with_stack_lock}.sh`, `CMakeLists.txt`, `README.md`, `docs/remaster/` | — |
| C1 | packets (daq-protocol bytes, transport structs) + Elodin schema goldens | agent | worktree, branch `char/packets` | D20 rework done a380166b: all service goldens black-box (real binaries over UDP / stand-in Elodin), both ipToU32Le lines reproduced, single-board PWM case added, `service_packets.txt` deleted (unreachable lines accounted in packets/README.md), schema accounting line by line in elodin/README.md; config_broadcast 10/10 alone; PWM "open after FIRE_STOP" bounded at ≤1 per board before the close and 0 after (C4-5), +3-extra-opens mutation red. Queued for merge after C4 and C2-blackbox | `test/characterization/{packets,elodin}/` | C0 |
| C2 | config loaders (C++ + TS), scripts parser, bad configs | agent | `char/config` → `char/config-blackbox` | merged 041a5246 (gate after the fact, D19). Black-box rework reported (5 commits, 0 golden lines removed, +84 `golden/bin/` from the real daq_bridge / stacklight / config_broadcast binaries; ActuatorCommander tables via public lookups; 7 mutations). **Remaining white-box (D18, documented in config/README.md):** `char_config_services.cpp` `#include`s the daq_bridge, stacklight and config_broadcast mains for file-static parse internals (`golden/cpp/{daq_bridge,stacklight,config_broadcast}`); `char_ac_private.cpp` keeps `#define private public` for ActuatorCommander's resolved roles and bind address. WP8–10 may re-point only these two harness files, goldens byte-identical, mutations re-run, orchestrator reviews the diff. Queued for merge after C4 | `test/characterization/config/` | C0 |
| C3 | calibration math (C++, calibration_service, TS) | agent | `char/calibration` | reported (black-box stack vs stand-in Elodin, lib public API, TS; 3 mutations); sent back: one golden for all builds/platforms with a 4-ULP float comparator, never skip (D22) | `test/characterization/calibration/` | C0 |
| C4 | sequencer/controller UDP streams, TCP replies, aborts | agent | `char/sequencer` | reported 28e8f5db (64 sessions, 4 mutations incl. delay and swapped order, black-box, 3× identical); queued for merge. Follow-up C4b |
| C4b | freeze the **destination board** of every actuator command: one listener per `127.0.0.<board_id>`; fails without the lo0 aliases; mutation sends a role to the wrong board | agent | `char/sequencer-boards` | reported e289204a: every command line carries its board and role; LOX Main moved 12→14 goes red (was byte-identical before); new rules N3c (loop first pass vs Fire's 0.001 s stage race, both orders seen in the old goldens), N5 per-board republish, N7 continuing PWM stream; 62/64 sessions identical to C4 after projection, 2 differ only by those rules. Queued for merge with C4 (includes it) | `test/characterization/sequencer/` | C4 | `test/characterization/sequencer/` | C0 |
| C5 | pipeline WS frames, HTTP, logger CSV | agent | `char/pipeline` | **merged** a8aae82f (6 goldens, 3 mutations, black-box). Follow-up C5b running |
| C5b | all board types through the pipeline (LC, TC, RTD, encoder, actuator, ball valve, environmental): WS frame shapes per type; needs the lo0 aliases and **fails, never skips**, without them (as test_integration.sh) | agent | `char/pipeline-boards` | queued | `test/characterization/pipeline/` (new files only) | C5 | `test/characterization/pipeline/` | C0 |
| C6 | lifecycle: startup, shutdown, reconnect, dup-sub, heartbeat loss, OTA | agent | `char/lifecycle` | **merged** 9d846bd6 (7 goldens, 6 mutations incl. normaliser, black-box) | `test/characterization/lifecycle/` | C0 |
| B0 | bloat-map research (read-only) | agent | none | done → `docs/remaster/BLOAT-MAP.md` | — | — |
| WP1 | delete tracked junk (root node_modules, .cache, build-ci, build-clang-ci, backend/dist, output/lut bins) | — | — | queued (after suite) | see BLOAT-MAP WP1 | C1–C6 merged + mutation check |
| WP2 | delete C++ no target compiles | — | — | queued | BLOAT-MAP WP2 | WP1 |
| WP3 | lib hygiene: PressureStateMachine, move db.hpp, split Parser/DatabaseConfig | — | — | queued | BLOAT-MAP WP3 | WP2 |
| WP4 | dead launchers + superseded test scripts, `--legacy` branch; park and restore `abort_thresholds.txt` like the other live stores (H-1); make test_integration.sh fail loudly (non-zero, listing them) when a macOS loopback alias is missing instead of `|| true` + a false ✅ (reviewer suggestion) | — | — | queued | BLOAT-MAP WP4 | WP1 |
| WP5 | backend dead TS + line client + slot helper | — | — | queued | BLOAT-MAP WP5 | WP1 |
| WP6 | split server.ts | — | — | queued | BLOAT-MAP WP6 | WP5 |
| WP7 | split api-server.ts | — | — | queued | BLOAT-MAP WP7 | WP5 |
| WP8 | shared C++ service plumbing | — | — | queued | BLOAT-MAP WP8 | WP3 |
| WP9 | split calibration_main.cpp — **constraint (C3, revised after the Linux leg):** the robust seed's θ differs by up to 2e-3 relative between compilers, so θ/covariance are now held only at rel 1e-2 and the **robust predictions** carry the contract (abs 1e-9 psi; 8e-10 measured across platforms — a thin margin). WP9 must still move `calculate_pressure` and the robust path without reordering arithmetic; a red `robust-prediction` family is a contract change until proven otherwise | — | — | queued | BLOAT-MAP WP9 | WP8 |
| WP10 | split sequencer/controller/actuator/bridge god files | — | — | queued | BLOAT-MAP WP10 | WP9 |
| WP11 | tools/: fix broken documented paths only; GUI deletions parked (operator-facing, team decision) | — | — | queued | BLOAT-MAP WP11 (narrowed) | WP4 |
| WP12 | docs | — | — | queued | BLOAT-MAP WP12 | WP2, WP4, WP5, WP11 |

## Merge log

| when | package | merge commit | gate |
|---|---|---|---|
| 2026-11-15 | **first push** of `backend-remastered` (2243fccc: main's code + harness + H1) | — | **CI run 43822614402: GREEN under D24** — 14/15 jobs pass (gcc-12 + clang-18 builds, Run Tests, Integration Test, ASan+UBSan full stack, TSan, video gateway, web GUI, Playwright E2E, systemd session E2E, security, docker, code quality, summary). Code Formatting Check red with 12 offenders, all under `firmware/`, 0 under `daq-server/` (pre-existing on main, D11/D24) |
| 2026-11-15 | C5 char/pipeline (queue/C5, ff) | a8aae82f | `--fast` PASS incl. characterization and tree-unchanged |
| 2026-11-15 | H1 harness: test_integration.sh restores the live `abort_thresholds.txt` (H-1); lock `--status` | queue/H1 ff | **full gate PASS** (integration 167/0; abort_thresholds.txt sha256 f8270df7… identical before/after; tree-unchanged flagged only the orchestrator's ledger edit, now exempt) |
| 2026-11-15 | C6 char/lifecycle (queue/C6, ff) | 9d846bd6 | `--fast` PASS incl. characterization (LIFECYCLE PASS) |
| 2026-11-15 | C2 char/config (merged before gate — one-off, D19) | 041a5246 | `--fast` PASS on 78aff6cd (after gate fixes: Ninja build, vitest allowlist); full integration on main code PASS 167/0 earlier |

## Parked

- **SIGPIPE disposition — team decision pending (user decision, relayed).** Today 4 services ignore SIGPIPE (`daq_bridge`, `ota_service`, `sequencer_service`, `t7_bridge`) and 5 take the default (die): `controller_service`, `calibration_service`, `heartbeat_service`, `config_broadcast_service`, `stacklight_service`. WP8's shared plumbing keeps each service's current disposition as an explicit per-service setting, bit for bit. Operator consequences: *as today* — a write to a closed socket kills the service; the four with `Restart=always` units (controller, calibration, heartbeat, config-broadcast) come back after systemd's restart delay, with a gap in what they publish (for `controller_service` a restart of the PWM-gate owner, for `heartbeat_service` a gap in SERVER_HEARTBEAT); `stacklight_service` has no unit in `deploy/` and stays down. *Uniform ignore* — those five keep running and see `EPIPE` from the write instead, so whatever each does on a failed send becomes the behaviour (not yet characterized per service).
- Untracking `scripts/calibration/calibrations/{cubic_calibration.json,abort_thresholds.txt}`: tracked but gitignored live stores; untracking deletes them on every other checkout (the stand included) at the next pull.
- `calibration/*.json`: the backend's live PT-coefficient store (`calibration.ts:348`).
- `elodin-relay.ts` + `npm run relay`: no consumer found, but tools may connect to ws :9090.
- `archive/legacy/python-services/{heartbeat,config_broadcast}_service.py`: systemd/launcher fallbacks.
- B4, replacing hand-rolled PWM/config/abort encoders with `daq::create_*`: the version byte may change on the wire (contract).
- `backend/package.json` `main`/`start` → missing `dist/server.js`: fixing it changes `npm start`.
- Deleting `tools/` operator GUIs (`tools/gui/**`, the orphaned calibration GUIs): operator-facing, the team's decision, not a refactor's.

## Defects found in the original (kept as-is, for the team)

- H-1 (harness, found by the orchestrator; **fixed in H1**, merged) `test/test_integration.sh` parks `cubic_calibration.json` and `lc_tare.json` but **not** `scripts/calibration/calibrations/abort_thresholds.txt`; its `calibration_service` regenerates that tracked file in place (seen 2026-11-15 20:03, ADC values 858993460→901943133). On the stand an integration run overwrites the live abort thresholds. Fix belongs in WP4 (park and restore it like the others); the gate now fails on any dirty tracked file after a run.

**Lead REPORT.md with these (safety-relevant on the real stand), each with its operator-visible consequence:** H-1 (fixed), C2-2 (shipped profile TOMLs never checked for underscore ints), C6-3 (server-heartbeat loss undetected; daq_bridge never takes over), C6-4 (board shown disconnected while its data still displays), C6-1 (log claims SENSOR_CONFIG sent, 0 packets), C6-6 (config_broadcast silent unless an actuator board is designated survivor), C4-1 (sequencer deadlock: aborts fail after entering a refused dynamic state), C4-3 (abort does not cancel a pending stage: a valve can move after the abort batch), C1-9 (CLEAR_ABORT is never sent: boards are never told the abort is cleared), C1-10 (each abort sends 8 ABORTs then 4 ABORT_DONEs: `triggerAbort` runs twice), C2-1 (digital-twin fire timer disabled), C2-4 (bad/missing TOML → service starts on defaults).

From C1 (packets/Elodin; each frozen in a golden):
- C1-1 `create_abort_done_packet` writes `version = 1`; every other encoder writes 0.
- C1-2 config_broadcast writes abort IPs in ACTUATOR_CONFIG reversed (d,c,b,a) via `memcpy` of `a<<24|…`; SENSOR_CONFIG `controller_ip` is a,b,c,d.
- C1-3 `create_sensor_data_packet`: `uint8_t` loop counter (>255 chunks loops forever) and `memcpy`s `num_sensors` datapoints regardless of the vector's size (over-read).
- C1-4 `parse_sensor_config_packet` / `parse_actuator_config_packet` write partial outputs before failing.
- C1-5 Parsers ignore the version byte and accept trailing bytes (the pipeline enforces both only for ENVIRONMENTAL_DATA).
- C1-6 TS `ElodinClient` never resyncs on an implausible length: waits forever, buffers, re-schedules `setImmediate` every tick.
- C1-9 CLEAR_ABORT is never sent: nothing calls `AbortBroadcaster::sendClearAbort`.
- C1-10 The sequencer calls `triggerAbort` twice per abort transition: each abort sends 8 ABORTs (2 × 4 repeats), then 4 ABORT_DONEs.
- C1-11 In the default profile `[stacklight_service] elodin_port` overrides the `--elodin-port` CLI flag (stacklight connects to 2240 regardless).
- C1-12 daq_bridge ignores its `bind_port` argument (argv[3]) when the config has `[network] sensor_port`.
- C1-8 A malformed board IP in config (`not-an-ip`) is encoded as 0x00000000 — a typo'd IP silently becomes 0.0.0.0 on the wire (config_broadcast `ipToU32Le`).
- C1-7 With config_base's cubic models and no thresholds file, ACTUATOR_CONFIG carries no abort-PT thresholds.

From C3 (calibration):
- C3-1 Robust-model predictions depend on wall-clock time between calls (bias decays with time), so they are not reproducible from inputs; `predict_pressure_psi` runs on every PT sample even when the PT does not use the robust model.
- C3-2 `calibration.ts` fills agreeing channels 8–10 with `Math.random`: the backend's backfilled coefficients differ on every load.
- C3-3 `loadPTCalibration` falls back to scanning repo directories by mtime when the override file yields no coefficients.
- C3-4 TS `parseTareFile` accepts a tare with uid 0; C++ `LcTareStore::load` skips it.
- C3-5 `IMUCalibration.cpp` does not compile on main (default argument at `IMUCalibration.hpp:92`, unqualified `SensorType` at `:203`); it is commented out of the build (WP2 deletes it).

From C5 (pipeline):
- C5-1 Session start and stop reload board status from config: a heartbeating board is reported "connection lost", then "connected" a second later.
- C5-2 In mock mode the run directory is never created: `POST /api/feed-char/results` during a session → 500 ENOENT.
- C5-3 `debug_mode` emits two identical `state_update` frames.
- C5-4 Legacy state-CSV loaders join `[state_machine]` paths onto fixed dirs: an absolute path is never found → empty transition list, no commanded-actuator snapshot.
- C5-5 `/api/cubic_calibration` ignores `DAQ_CALIBRATIONS_DIR`; the backend's PT calibration comes from `daq-server/calibration/*.json`, whose coefficients are zeros.
- C5-6 `GET /api/state-script?name=<missing>` → 200 with empty body; `PUT /api/video/config` without a revision → misleading 409.
- C5-7 `sensor-backend.service` runs `npm run dev` (`tsx watch`) in production.

From C4 (sequencer):
- C4-1 **Entering a dynamic state refused at load deadlocks the command worker whenever Elodin is connected**: `doTransitionTo` holds `config_mutex_` while `publishState()` locks it again; every later command — aborts included — waits the 10 s timeout and fails; SIGTERM does not exit it.
- C4-2 A script timeout fires twice (HoldTimer and ScriptRunner's deadline); into a self-transitionable state the column is re-sent, nondeterministically.
- C4-3 **An abort does not cancel a pending stage**: abort entry uses `is_transition=false`, so the previous state's +0.2 s stage lands after the abort's batch.
- C4-4 With `sequencer_owns_valves=true`, nobody commands the PWM roles during Fire.
- C4-5 controller_service: does not strip CR (`FIRE_START\r\n` → ERR); with unresolved PWM roles replies "fire gate disabled (sequencer owns the valves)" (wrong cause); can send one more test-duty PWM packet after its FIRE_STOP close; takes >3 s to exit on SIGTERM.
- C4-6 `RELOAD_CONFIG` on :9998 replies `ERR:unknown command` (daq-server/CLAUDE.md lists it as a command).

From C6 (lifecycle):
- C6-1 daq_bridge logs "✅ Proactive SENSOR_CONFIG sent to N sense boards" but `FSWConfigManager` sends nothing (0 packets).
- C6-2 Duplicate VTableStream subscriptions multiply delivery on elodin-db 0.16.1 (~2× and 5×); `test_duplicate_subscription.ts` exits 1.
- C6-3 Nothing detects loss of the server heartbeat: when heartbeat_service dies, daq_bridge does not take over (`send_from_daq_bridge` fixed at startup).
- C6-4 A board that sends data but no heartbeats is marked disconnected while its data is still shown.
- C6-5 Backend has no SIGTERM/SIGINT handler: exits by signal; WS clients see close 1006.
- C6-6 config_broadcast sends nothing unless an ACTUATOR board is the designated survivor.
- C6-7 stacklight_service default target is a placeholder (192.168.2.70:5006) and config overrides CLI flags.
- C6-8 `[boards.integration_startup]` (board 60) collides with another board's slot (daq_bridge's own error log); test_integration.sh uses it.
- C6-9 calibration_service exits 1 if Elodin is not up yet; no retry.
- C6-10 ota_service reports success when the board closes without replying.

From C2 (config characterization; each frozen in a golden):
- C2-1 `config/profiles/digital-twin` `[fire]` has no `state` → `fire.state=""` → sequencer disables the fire timer for that profile.
- C2-2 `test/check_toml_no_underscore_ints.py` globs `config/profiles/*.toml`, but profiles are directories now: the shipped profile configs are never checked.
- C2-3 stacklight `getTomlValue` + `std::stoi` reads `1_000` as 1 and `5_006` as 5.
- C2-4 A malformed or missing TOML makes `config::load` log and return a default `Config`: a service starts on defaults.
- C2-5 Out-of-range ports/ids wrap silently (`sensor_port 70000`→4464, `-1`→65535, `database.port 65536`→0; `active_connectors` cast to uint8).
- C2-6 Wrong-typed TOML values silently take the default in C++ (toml++), differently from the TS validator.
- C2-7 config_broadcast prefers a cwd-relative `config/state_machine_actuators.csv` over `[state_machine].actuator_csv`.
- C2-8 Short transition rows (e.g. Armed) read left-aligned (known NEEDS-REPAIR).
- C2-9 A duplicate `[[states]]` name is last-wins; with `[[states]]` loaded, legacy aliases and case-folded names resolve to UNKNOWN.
- C2-10 The script parser stops at the first diagnostic.
- C2-12 config_broadcast aborts on an uncaught `std::invalid_argument` (SIGABRT, exit −6) for a bad environmental board id; daq_bridge catches the same error and exits 1.
- C2-11 `SensorAssignmentManager::load_assignments_from_config` is declared but never defined.

From the bloat map (BLOAT-MAP.md, "Defects found"):
1. `tools/calibration/calibration_server.py:20-31` imports `scripts.calibration.*` (gone): the Python sidecar cannot start.
2. Several launchers pass `--relay-host/--relay-port`, which `calibration_service` rejects or ignores.
3. `test_integration.sh --legacy` launches the missing `src/server-legacy.ts`.
4. `start_tmux_dev.sh:371` starts the Python heartbeat even when the C++ binary exists.
5. Three separate PT calibration stores (backend `calibration/`, C++ `scripts/calibration/calibrations/`, Python `tools/calibration/calibrations/`).
6. Only 4 of 9 services ignore SIGPIPE; most signal handlers do non-async-signal-safe I/O.
7. Controller PWM and abort packets hard-code protocol version 0 rather than `DIABLO_COMMS_VERSION`.
8. `tools/controller_lut/*.sh` invoke `python -m scripts.controller_lut.*` (moved): the documented LUT regeneration fails.
