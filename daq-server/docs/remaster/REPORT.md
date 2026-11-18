# backend-remastered — REPORT (draft)

What the `backend-remastered` refactor of `daq-server` did, how it proved the stand's software
still behaves as `main` does, and what it found and did not fix. Written for the people who run
the stand.

Every statement below cites a ledger decision (`Dnn`), a defect id (`C4-1`, `D-SLOT`, `SEC-1`,
`BM-n`, `H-1`) or a package id; nothing here was re-diagnosed. Sources: `LEDGER.md` at
`backend-remastered` @ `8118fff1` (2026-11-17), `REPORT-DEFECTS-DRAFT.md` (the long form of §4,
with consequences and proposals per defect), `BLOAT-MAP.md`, `WP1-EVIDENCE.md`,
`WP2-EVIDENCE.md` and the `DESIGN-WP*.md` notes. The security review's full text
(`SECURITY-REVIEW.md`) is **uncommitted** — its commit was denied in the reviewer's session and
it sits on the `docs/security-review` branch's working tree only — so SEC-1…SEC-12 are cited
from the ledger's summary of it. File:line references are the ledger's, against `main` @
`15b5a0c5` (product code on the tag is identical).

**The rule the refactor worked under.** `main`'s behaviour is preserved bit for bit, defects
included (D17; AGENT-RULES 6). A change in what the stand does is a team decision made in its own
package, never a side effect of moving code. The one exception is H-1, a *test-harness* bug fixed
because it overwrote a live stand file. Everything in §1 and §4 is therefore still in the code.

---

## 1. Read these first

Stand-safety and security items, in the order the team should look at them. Not fixed unless the
line says so.

1. **SEC-1 (CRITICAL).** Direct `:8081` is "operator". The backend treats an absent `X-Auth-Email`
   as operator (`server.ts:978-979` WS, `api-server.ts:345-347` HTTP), listens on all interfaces
   (`server.ts:1861`), and `deploy/bootstrap_daq.sh:199-202` opens 8081 (and 3000) to any
   source. Any device that can route to the stand host — including one on the `192.168.2.0/24`
   board LAN — gets full control, bypassing Caddy's login.

2. **SEC-3 (CRITICAL).** OTA `projectPath` is code execution. `api-server.ts:1200-1206` passes a
   caller-supplied path to `ota_service`, which runs `pio run` on it
   (`ota_service_main.cpp:232-243`); a `platformio.ini` `extra_scripts` runs arbitrary code as
   the service user. Latent on a systemd stand (no OTA unit, `install_services.sh:10-12`); live
   on the tmux/dev stack and on flash days.

3. **SEC-4 (HIGH).** The sequencer `:9998`, controller `:9999` and OTA `:9997` command ports
   bind `INADDR_ANY` with no authentication (`sequencer_main.cpp:264`,
   `controller_main.cpp:139`, `ota_service_main.cpp:422`). With the host firewall off, a LAN
   device can command states and fire.

4. **SEC-2 = D-OTA (CRITICAL, ledger lead).** `POST /api/ota-flash` (`api-server.ts:1169`) and
   `POST /api/ota-flash/flash-all` (`:1101`) have no operator gate: behind Caddy a signed-in
   non-operator can reflash board firmware; `flash-all` reflashes every enabled board. H8
   freezes the viewer's 200 on `ota-flash` so the hole stays visible to the suite (D84).

5. **D-CTRLSTOP — S1 if the stand runs `controller_service` under systemd with elodin-db up at
   stop time.** With elodin-db up, `controller_service` never exits on SIGTERM or SIGINT:
   `ControllerService::stop()` joins the Elodin subscriber thread, which blocks in
   `TCPClient::read_exact()` on a socket with no receive timeout (`TCPClient::connect` sets only
   `SO_SNDTIMEO`; the controller never calls `set_recv_timeout_ms` on `elodin_subscriber_`).
   Reproduced 3/3 on macOS and on the Linux legs, both signals. Under systemd every stop ends in
   a `TimeoutStopSec` SIGKILL; the controller is one of the four services with a
   `Restart=always` unit (Parked, SIGPIPE entry). With the db unreachable it exits 0 within 1 s.
   Kept, not fixed (D17); its exit code and the SIGKILL-or-timeout outcome are frozen as-is
   (D89). The ledger does not record the unit's `TimeoutStopSec` value.

6. **What the controller leaves on the wire when SIGKILLed mid-PWM** — the ledger does not settle
   this (D-CTRLSTOP entry, star-f9 note). **To verify against the stand config:** whether the
   stop path is reachable there, and what PWM the boards hold after the kill.

7. **D-WP9-FMA — abort-threshold math depends on the compiler's inlining (S1-adjacent, numerics).** `invert_abort_psi_to_adc` and `select_pt_psi` in `services/calibration/calibration_main.cpp` turn abort thresholds into ADC counts. On Linux gcc-12, how many multiply-adds the compiler fuses in them changes when unrelated code in the file moves: taking a sensor-model global out of its anonymous namespace took `invert_abort_psi_to_adc` from 4 fused ops to 2. Fused and unfused arithmetic can differ in the last bits, so any future edit to that file can silently change abort thresholds. The refactor therefore left calibration_main.cpp unsplit (WP9 parked; LEDGER D111-D113). The service publishes float32 values compared at 4 ULP, so ordinary output cannot reveal it; the risk is where a double result is rounded to an integer ADC count at a boundary. Recommendation: pin the numerics, preferably with an explicit contraction policy for the calibration build (a value golden needs exact boundary codes per platform), or with a value golden that drives these functions with inputs where fused and unfused results differ (C0 G1 is the start) or with an explicit contraction policy for the calibration build.
8. **D-LATE.** A transition the operator was told failed can still happen later. When the
   sequencer stalls, the backend's `:9998` request times out and the GUI shows "State transition
   failed: timeout", but the sequencer keeps the backlogged `TRANSITION:` line and executes it
   when it resumes (SIGPIPE ignored, `sequencer_main.cpp:243`; the reply to the dead peer uses
   `MSG_NOSIGNAL`, `:75`). After a stall the stand changes state on a command the operator
   believes was rejected. Characterized in pipeline mode `holds` via a self-transition only, so
   the golden does not move the rig (D70, D85).

9. **C4-1.** Entering a dynamic state refused at load deadlocks the sequencer's command worker
   whenever Elodin is connected: `doTransitionTo` holds `config_mutex_` while `publishState()`
   locks it again (the 716-730 block, D42). Every later command — aborts included — waits the
   10 s timeout and fails; SIGTERM does not exit it. Frozen (`ERR` after 10 s). Proposal: move
   `publishState()` out of the locked block (Team proposals; D47).

10. **D-HB.** SERVER_HEARTBEAT keeps flowing while the sequencer is wedged by C4-1, so the boards'
   heartbeat watchdog — the independent safety layer, abort 15 s after the last heartbeat (5 s
   timeout + 10 s grace, `actuator_config.h:10-12`; D46 corrected the research's "5 s") — never
   trips while the server cannot abort. The watchdog is armed per board boot, so on a warm stand
   a `heartbeat_service` that fails to start aborts the stand at 15 s (D46). Proposal: heartbeat
   only while the sequencer worker is alive; the trade is TQ1 (D46).

11. **C4-3.** An abort does not cancel a pending staged command: abort entry uses
    `is_transition=false`, so the previous state's stage lands +100 ms after the abort's batch
    (golden; the ledger's first "+0.2 s" was corrected), and the abort batch skips any role still
    waiting on its delay (`ActuatorCommander.cpp:492-495`) because aborts do not bump
    `schedule_gen_`. A valve can move after the abort, in the pre-abort state's direction.
    Proposal: `cancelPendingStages()` on abort entry plus the 835 call (D47).

12. **C1-10.** Each abort sends 8 ABORTs (2 × 4 repeats) then 4 ABORT_DONEs: `triggerAbort` runs
    twice. The second call joins the first's ABORT_DONE thread, which waits out a 50 ms step, so
    the abort state reaches Elodin and the GUI 37–79 ms after the valves are commanded (non-abort
    entries 3–17 ms) (D50). Frozen.

13. **C1-9.** CLEAR_ABORT is never sent: nothing calls `AbortBroadcaster::sendClearAbort`. Boards
    are never told the abort is cleared. Frozen.

14. **D-SLOT.** A board configured in slot > 8 only warns (`Config.cpp:49-53`) and its uint8 table
    id wraps (`DatabaseConfig.cpp:272/371`, `(slot-1)*0x20+ch`): slot 10 lands on PT2.CH1.
    `ControllerService.cpp:772-775` subscribes calibrated PT tables for boards 1-10 × ch 1-10, so
    slots 9-10 wrap onto PT1/PT2 at run time. A mistyped `board_id` silently corrupts or steals a
    live pressure channel. C6-8 is the same mechanism in the shipped config (board 60,
    `[boards.integration_startup]`); H2 moved only the *harness's* board to a free slot and fails
    the run on `[Config] ERROR` — the product still accepts the config (D41). Proposal:
    fail-fast config, exit 78 with `RestartPreventExitStatus=78` (STYLE S11; D46, D56).

15. **D-SUB.** A backend subscription made while a table is being re-registered is accepted but
    receives 0 packets forever; the backend retries only *refused* subscriptions
    (`elodin-vtable-registry.ts` `noteSubscriptionRejected`). Window ~130 ms on Linux arm64,
    ~3 ms on macOS (D41). After a startup or reconnect race a live channel can go permanently
    dead on the GUI with no error. It was the root cause of the Linux `PT2_Cal.CH1` integration
    miss (D41). D-ECHO (unconfirmed) names the signal that would detect it.

16. **C6-3.** Nothing detects loss of the server heartbeat: when `heartbeat_service` dies,
    `daq_bridge` does not take over (`send_from_daq_bridge` fixed at startup). Past 15 s the
    actuator boards abort (D-HB).

17. **C6-6.** `config_broadcast` sends nothing unless an ACTUATOR board is the designated
    survivor — including ACTUATOR_CONFIG, which carries the abort-PT thresholds (C1-7).

18. **C6-1.** `daq_bridge` logs "✅ Proactive SENSOR_CONFIG sent to N sense boards" but
    `FSWConfigManager` sends nothing (0 packets).

19. **C6-4.** A board that sends data but no heartbeats is marked disconnected while its data is
    still shown.

20. **SEC-5 (HIGH).** WS `CALIBRATION_COMMAND` has no operator gate (`server.ts:1225`): a
    non-operator can alter calibration mid-test. **SEC-6 (HIGH).** Cross-site WS hijack /
    `Access-Control-Allow-Origin: *` on direct `:8081` (`server.ts:901`, `api-server.ts:376`).
    **SEC-8 (MED).** `set_countdown_target` skips the arm gate (`server.ts:1360`).

21. **Lead-marked data and configuration items (S2, full table in §4.2):** C3-3 — the backend
    picks its PT calibration file by mtime among 13 tracked files, so after a pull/checkout/rsync
    the GUI's calibration panel can report, and its save command write from, a different file;
    live PT pressures are not affected (`calculatePressure` has no caller). C2-4 — a malformed or
    missing TOML starts a service on defaults. C2-1 — the digital-twin profile has no `[fire]
    state`, so its fire timer is disabled. C2-2 — the underscore-integer check never runs on the
    shipped profile configs (they are directories now), so C2-3 (`1_000` read as 1) is
    unguarded.

22. **H-1 (fixed; harness).** `test/test_integration.sh` parked `cubic_calibration.json` and
    `lc_tare.json` but not `scripts/calibration/calibrations/abort_thresholds.txt`; its
    `calibration_service` regenerated the live tracked file in place (2026-11-15, ADC values
    858993460→901943133). On the stand, an integration run overwrote the live abort thresholds.
    Fixed in H1 (merged): the script restores the file; the gate fails on any dirty tracked file
    after a run; sha256 identical before and after.

---

## 2. What the refactor did

Status as of the ledger at `backend-remastered` @ `6a08e869` (D142, 2026-11-17): every bloat-map
package is merged or parked.

The order is the DAG (BLOAT-MAP:345, D91): `C0 → WP1 → {WP2, WP4, WP5}`; `WP2 → WP3 → WP8 →
WP9 → WP10`; `WP5 → {WP6, WP7}`; `WP4 → WP11`; `{WP2, WP4, WP5, WP11} → WP12`. Product-code
packages merge strictly one at a time, each after a full gate, the Linux leg and CI (D19, D25);
test-only packages may batch (D32). Implementation runs in parallel upstream of the queue (D91).

### 2.1 Phase 1 — characterization (merged; baseline tagged)

Before anything moved, `main`'s behaviour was recorded as goldens: outputs the suite compares
against on every run, reached black-box through the built binaries and their UDP/TCP/WS/HTTP
interfaces (D20). The baseline is `main` @ `15b5a0c5`, frozen as tag `remaster-baseline` after
CI run 44011896743 went green (D77).

| area | what it freezes | evidence | mutations |
|---|---|---|---|
| C0 harness | `gate.sh`, `run.sh`, stack lock, Linux leg, ctest retry, ledger | lock self-test (D14); retry script unit-tested, 5 cases (D31) | — |
| C1 packets + Elodin | daq-protocol bytes, transport structs, Elodin schema per profile, single-board PWM, "PWM open after FIRE_STOP" ≤ 1 per board | 14/14 + elodin identical on macOS, arm64 gcc-12, arm64 clang-18, amd64 gcc-12: **no ABI/layout/encoding difference across platforms** (C1L) | +3-extra-opens red |
| C2 config | C++ and TS config loaders, scripts parser, bad configs; `golden/bin/` from the real daq_bridge, stacklight and config_broadcast binaries (+84) | black-box rework removed 0 golden lines | 7 |
| C3 calibration | calibration math (C++, calibration_service, TS); one golden per output for every build type, OS and arch at ≤ 4 ULP, named limits for ill-conditioned families (D22) | passes on 6 build variants incl. Linux amd64 (D28) | 3; stack M1 2 red, M2 16 red; lib M1 202 red (D28) |
| C4 / C4b / C4L sequencer | UDP command streams, TCP replies, aborts; the destination board of every command (one listener per `127.0.0.<board_id>`) | 64 sessions; 64/64 at 1× load on Linux; holds + flow 3/3 (C4L) | C4 4 (incl. delay, swapped abort order); C4b wrong board; C4L republish period ×2 under load |
| C5 / C5b pipeline | WS frames, HTTP, the three state CSVs byte for byte (D21); all board types; modes `pt`, `nocal`, `boards`, `stalesub`, later `holds` and `operator` | 6 goldens; exact on Linux (D30 ended) | 3 |
| C6 / C6L lifecycle | startup, shutdown, reconnect, duplicate subscription, heartbeat loss, OTA | 7 goldens; 7/7 at 1× and 2× load | 6 (+7 at load incl. two doubled periods) |

Harness fixes merged alongside: H1 (restores `abort_thresholds.txt`; H-1), H2 (the integration
harness's startup board moved off slot 10; the run fails on `[Config] ERROR`; D41), the load guard
(D27), bounded ctest retry (D31), the leftover-process and port check (D33), "a run the machine
slept through is void" (D37), explicit ctest timeouts (D38), `--areas` (D36), per-Dockerfile Linux
image tag (D36), the Linux leg's own lock (D90). First CI run of the branch: 43822614402, green
under D24.

### 2.2 Phase 3 — work packages

**Merged**

- **WP1 — tracked junk** (D81). 6,103 files untracked (D81; WP1-EVIDENCE's groups sum to 6,101, the CHECKPOINT's figure); only `.gitignore` and `WP1-EVIDENCE.md`
  added or modified; 0 goldens. Root `node_modules/` 5,886 files / 775,203 lines, clangd
  `.cache` 172, `build-ci`/`build-clang-ci` 14, `backend/dist` 27, two LUT outputs
  (WP1-EVIDENCE). The tracked-but-gitignored live stores were **not** touched (Parked). macOS and
  Linux arm64 full gates PASS, integration 167/167.
- **WP2 — dead C++** (D82). 43 files, +488/−6744: 37 files no target compiles deleted, 5 edited;
  `build/bin`, `build/lib`, the warning set and `ctest -N` identical before and after
  (WP2-EVIDENCE). CI 44032367993 green (48/48).
- **WP4 — dead launchers and superseded tests** (D80, D86). 33 files, +31/−2842; 28 deletions
  (7 launchers, 2 sim network scripts, 17 broken or superseded tests, `test_stacklight.sh` per
  D68, `data_logger_service.py`). `test_integration.sh` loses its `--legacy` branch, which was
  unrunnable (`set -u` + undefined `$TEST_RELAY_WS_PORT`, D67), byte-identical otherwise; and it
  now exits non-zero naming the missing macOS loopback alias instead of `|| true` + a false ✅
  (stubbed-`sudo` mutation red, D80). Integration 167/167 with `abort_thresholds.txt` unchanged.
- **H8 — operator gates frozen** (D84, D88; test-only). The eight HTTP operator gates not yet frozen return 403
  for a viewer, with witness GETs showing nothing was written, so all 14 are now pinned (D63); the two OTA routes' viewer 200 is
  frozen (SEC-2). +201/−7, golden additions only; mutations M1–M3 red. CI 44057282047 green.

- **WP3 — C++ library hygiene** (D83, D117): 5 commits plus queue-time edits, 13 files +287/−1233,
  0 goldens. PressureStateMachine deleted (−1017; compiled, zero callers); `db.hpp` moved byte for
  byte from `archive/legacy/utl/` to `lib/third_party/elodin/` as a `SYSTEM PRIVATE` include; one
  `send_msg` (`lib/src/elodin/SendMsg.hpp`); the Parser's canonical printer in its own TU
  (`lib/src/script/Printer.cpp`; D45, D62, D71). CI 44120121401 green.
- **WP5 — backend dead TS, sequencer line client, slot helper** (D78, D122): deletes
  `calibration-sidecar.ts`, `ota-flash.ts`, `server-types.ts` and the uncalled `:9999` client
  (D39); `boardSlot()` replaces six copies of the `board_id % 10` rule; new `sequencer-client.ts`;
  `legacy/` → `state-csv/`. CI 44145497033 green. Security review D93.
- **WP11 — `tools/` path fixes** (D92, D123): 10 files, ±24, nothing deleted.
- **WP12 — docs** (D124): 12 doc files, one `setup.sh` echo message (D-SETUPCAL); no executable
  logic. CI 44161813655 green (also covers WP11).
- **WP7 step 1 — split `api-server.ts`** (D128): 1269 → 81 lines plus ten route groups under
  `src/api/`; every viewer 403 and the ota-flash 200 unchanged; Linux full PASS; CI 44179934430
  green apart from Formatting. Step 2 (cleanup) is a separate later item, not done.
- **WP8 — shared C++ service plumbing** (D132): `lib/include/service/StopSignals.hpp` for the
  services, `lib/include/net/TcpCommandServer.hpp` for the sequencer and controller accept loops;
  each service's SIGPIPE disposition kept as an explicit per-service setting (D17, Parked).
  macOS and Linux full PASS; CI 44190415220 green.
- **WP9-lite** (D136): one commit, 6 lines deleted; per-symbol FMA census equal on macOS and
  Linux (D116). CI 44194860517: Run Tests 48/48 green.
- **WP10 — split the sequencer, controller, actuator and bridge files, move-only** (D138):
  `SequencerService_*.cpp`, `ControllerService_*.cpp`, `ActuatorCommander_load.cpp`, and
  `BoardMap.{hpp,cpp}` / `BackendLogForwarder.hpp` in `daq_bridge/`. Linux PASS except
  `script_runtime` (D34); CI 44199861379 green. The §6.2 cleanup is deferred, not done.
- **WP6 — split `server.ts`** (D142): steps 1 and 2, `server.ts` to 332 lines plus 16
  `src/server/*.ts` modules. macOS PASS except the D34 `script_positions` ctest (WP6 is
  TypeScript only); Linux PASS except `script_runtime`; all 11 pipeline modes, lifecycle and
  integration PASS on both.
- **C0 test-only packages, all merged:** H8b (D103), G-W5 + G4 (D108), WP8-gaps (D109), G12 (D119),
  C0 WP7 (D126), C0 WP6 G1-G3/G8/G10 (D139). **H3 harness** (D121).

**Parked: WP9 — split `calibration_main.cpp`** (D113; star-f9 ruling). It stays unsplit (S33
waiver); WP10's DAG edge was relaxed to WP8 only. C0 WP9 is parked with it (D120, branch
`char/c0-wp9` kept; D-CALLOG-RESIDUE). D-WP9-FMA stays a lead: abort-threshold numerics depend on
gcc's inlining, and a fused-vs-unfused value golden is the recommendation (D113).

**Parked — the team's decisions, not a refactor's** (Parked section): SIGPIPE disposition (4 of 9
services ignore it); untracking the live calibration stores; `calibration/*.json`;
`elodin-relay.ts` + `npm run relay` (`tools/postprocessing/replay_past_db.sh:99` runs it, D67);
the Python heartbeat/config_broadcast fallbacks; B4 (library wire encoders may change the version
byte); `backend/package.json` `main`/`start`; deleting `tools/` operator GUIs.

### 2.3 How the designs were made

Design over speed (D17). Each split got a target-design note (module boundaries, ownership, data
flow, error handling, naming), a review by a fresh agent (D39), a debate between three advocates
with a separate judge (D46–D48, D54, D56), and then adversarial simplicity rounds — "the simplest
design that keeps every golden; where is it over-engineered?" — until a round found nothing
substantive (D49–D52, D57–D73). Every design is final (D73). Two rules did most of the cutting:
no abstraction with a single user (D17d, STYLE-S34) and "a new shared behaviour needs two users
that agree observably" (D43). Every split lands as two separately gated queue items, move-only
then cleanup (D12e). A style guide, STYLE.md, was ratified the same way; its error-handling
section (criticality classes, fail-fast startup with exit 78, no in-duty exit from safety or
control paths) directs new structure and team fixes only, never the refactor (D43, D46).

---

### 2.4 Lines and files before and after, per component

Counted with `git ls-tree -r` and `wc -l`-equivalent newline counts over text blobs, at `main` @
`15b5a0c5` and `backend-remastered` @ `6a08e869` (2026-11-17, after the last merge). Everything under `daq-server/`, plus the repo-root
`node_modules/` that `main` tracked. Binary blobs count as files, not lines. Grouping rules:
*tests* = `test/` (except the harness), `__tests__/`, `lib/test/`; *characterization harness* =
`test/characterization/` (mostly goldens, so its lines are not code); *vendored/junk* =
`node_modules/`, `.cache/`, `build-ci/`, `archive/`, `external/`, `lib/third_party/`, and the
vendored `nlohmann`/`toml++` headers; *tools* = `tools/`, `sim/`, `scripts/`, `deploy/`,
`githooks/`; *other* = config, calibration data, flash, video, build files, so totals reconcile.

| Component | main files | main lines | remastered files | remastered lines |
|---|---:|---:|---:|---:|
| backend TS | 100 | 25,515 | 96 | 19,624 |
| frontend | 130 | 30,747 | 130 | 30,747 |
| C++ services | 22 | 10,356 | 29 | 10,369 |
| C++ lib | 94 | 20,507 | 96 | 18,949 |
| transport | 32 | 2,834 | 28 | 2,352 |
| tests | 147 | 29,089 | 135 | 27,969 |
| characterization harness | 0 | 0 | 810 | 181,042 |
| tools | 176 | 40,047 | 167 | 39,182 |
| docs | 51 | 7,494 | 164 | 28,643 |
| vendored/junk | 6,100 | 828,046 | 7 | 48,019 |
| other (config, calibration data, flash, video, build files) | 50 | 7,806 | 45 | 6,493 |
| **Total** | 6,902 | 1,002,441 | 1,707 | 413,389 |

Almost all of the drop in totals is junk leaving the tree (tracked root `node_modules/`,
`build-ci/` binaries, `.cache/clangd/` index: BLOAT-MAP §1; WP1 D81). The product rows are flat
or smaller (backend TS -5.9k lines, C++ lib -1.6k, services flat); this table does not
attribute those, see the ledger's merge log per package. The harness and docs are the additions.

## 3. How behaviour was proven unchanged

The principle: the suite is not evidence about itself. Goldens were recorded on unchanged product
code, never on a WP branch (D74); a line set may only grow, and every removed golden line must be
reproduced black-box or accounted for in the area README (D20); harness edits that reach into
moved code are allowed only with goldens byte-identical, mutations re-run and the diff reviewed
(D18).

### Goldens

- Black-box wherever the refactor will move internals: built binaries, TCP/UDP/WS/HTTP, public
  library APIs; white-box only for pure functions (D20). The two remaining white-box harness files
  are named and bounded (C2, D18).
- Floats: one golden per output for every build type, OS and arch, compared at ≤ 4 ULP; exact for
  integers, codes, ids and bytes; named, value-scoped limits for ill-conditioned families, each
  proven by a mutation in its family; never a per-variant golden, never SKIP (D22, D28).
- Timing: ordering, counts and content exact; periods and latencies as bounds derived from the
  configured or specified value, never the observed one; goldens must hold at 1× synthetic load
  on their own (D27). The stress pass over every area found one red, `default/aborts`, root-caused
  to the harness's boundary window and fixed without changing a golden or assertion (D50).
- The normaliser replaces timestamps and IDs only — never sorts, drops fields or rounds — and is
  itself a mutation target (D12c).
- Platform: every golden passes in an `ubuntu:24.04` arm64 container (full suite) and, where a
  real elodin-db is not needed, under emulated amd64; native x86_64 is judged by CI (D15, D16,
  D55). Rule learned: any macOS-vs-clean-export diff is a harness bug until proven otherwise
  (D30).

### Gates

- `gate.sh` steps: build (no new warnings vs `baseline_warnings.txt`, D4), ctest (timing tests
  with a bounded, printed retry, D31), backend vitest, video gateway, frontend vitest/lint/build,
  `tsc --noEmit` (D40), shared types, characterization (every area), integration (167/167 on
  elodin-db 0.16.1), clang-format-19 and black on what the remaster owns (D11), tree-unchanged.
  `--fast` skips integration and is never a merge check for product code (D19).
- Merge protocol: a package is merged into a scratch `queue/<id>` cut from the current tip, gated
  there, and only on green fast-forwarded; a queue branch that fails any leg is deleted and the
  package re-cut from the then-current tip (D19, D25). `backend-remastered` never holds an ungated
  commit, with one logged early exception (C2, D19).
- Every port-binding run holds the stack lock (D2, D7, D8, D14); the Linux leg has its own (D90);
  a straggler process or a bound test port fails the area that leaked (D33); a run the machine
  slept through is void (D37); every characterization ctest has an explicit timeout (D38); a port
  handed from a listener to a child is confirmed bindable first (D36).

### Running the characterization suite

Off the stand only (`daq-server/CLAUDE.md`; `gate.sh` refuses on `star-rfs` or a 192.168.2.x
address; the other entry points do not check, so you do). Build first (`bash scripts/build.sh`).

```bash
bash test/characterization/run.sh                      # every area: ctest half + each area's run.sh
CHAR_AREAS=config,packets bash test/characterization/run.sh   # only these areas
bash test/characterization/gate.sh                     # the full merge gate (integration included)
bash test/characterization/gate.sh --fast              # no integration; never a merge check (D19)
bash test/characterization/linux/linux_gate.sh         # the same goldens in an ubuntu:24.04 container (D15, D90)
```

`CHAR_UPDATE=1` rewrites goldens and is only for `main`'s behaviour, never to make a change pass.
Areas that bind ports hold the stack lock (D2, D7, D8, D14); a bound test port or a straggler
process fails the area (D33). Per-area detail is in each `test/characterization/<area>/README.md`.

### Mutations

A test that cannot fail is not a test. Every area shipped with mutations that must go red: break
the thing a golden guards, see it fail, restore (per-area counts in §2.1). Timing-bearing areas
each carry a mutation that doubles a period and must still go red under load (D27). Prospective
guards that could not fail were found and replaced before use: WP3's "no new warning proves
SYSTEM survived" (D71), WP8 gap 7's refused-subscribe half (D57), WP9's G3 reconnect and `after
sweep` snapshot (D73), `test_stacklight.sh`'s premise (D68). Red-team passes over the TS and C++
goldens produced the C0 packages that now gate each WP step (D64, D65, D75).

### CI

`daq-server-ci.yml` runs on every push to `backend-remastered` through draft PR #229, which is for
reading only — never merged or marked ready without the user (D59). Runs recorded: 43822614402
(first push, green under D24), 44011896743 (tag candidate; Run Tests 48/48, Integration,
ASan+UBSan, TSan, Playwright E2E, Session Control E2E green; D77), 44032367993 (WP2), 44057282047
(H8). The Code Formatting job is judged by "no offender under `daq-server/`": it is red on `main`
itself from `firmware/` (D11, D24). Later runs: 44120121401 (WP3), 44145497033 (WP5), 44161813655
(WP12), 44179934430 (WP7), 44190415220 (WP8), 44194860517 (WP9-lite), 44199861379 (WP10) (D117,
D122, D124, D128, D132, D136, D138).

### What the proof does not cover

- **No data-logger CSV exists to freeze**: the logger is archived, `[data_logger_service]` is
  unused, elodin-db 0.16.1 has no export command. The only CSV frozen is `/api/state-csv` (D21).
- **Two integration checks are vacuous on macOS**: `timeout` is absent, so the bad-PWM listener and
  FIRE_START send never run and "no PWM emitted while unresolved" prints green unconditionally;
  "refused with a reason" passes on startup log lines alone. Both are live on Linux and CI, which
  judge them (D61a). H3 fixes the harness.
- **The integration `[Flow]` assertions never exercise the transition table**: debug mode is on
  before the Flow block and `SequencerService.cpp:765` skips `isAllowed` under it; and
  `test_integration.sh:505-511` pads short transition rows, which silently allows the wrong edge
  in the integration config (D-INTFLOW, D-INTPAD). The `holds` golden now freezes a real edge.
- **Three of `main`'s timing ctests** (`actuator_delays`, `script_positions`, `script_runtime`)
  are judged on CI only: this Mac's sleep timer overshoots, and the local Linux leg is a VM on
  the same Mac (D34, D76). Native x86_64 is CI's alone; elodin-db cannot run under qemu (D55).
- **The stand's architecture is unconfirmed** (Jetson arm64 per the docs; `enp4s0` suggests x86);
  both are tested until `uname -m` on star-rfs answers (D16).
- **Firmware and `lib/daq-protocol` are out of scope**; the wire protocol stays byte-identical by
  not being touched and its bytes are frozen by the packet goldens (D5). Board-side behaviour
  (D-HB's watchdog) is not in the suite.
- **No backend test or golden pinned any 403/operator gate** until H8/H8b; a refactor that dropped
  a gate would have stayed green (security-review coverage hole; D63, D84, D87).
- **OI-1** (one Linux run's T7 capture/tare and ENV25 recovery failures) recurred nowhere in 11
  later legs and is unexplained; diagnosing a recurrence needs the backend and t7_bridge logs kept
  (D41, D61f).
- `t7_integration`'s `> 300` threshold sits inside its macOS spread (277–300): `main`'s test,
  report only (D61e).

---

## 4. Defects found

Grouping rule (this report's, not the ledger's — the ledger marks "lead" items and the security
review grades CRITICAL/HIGH/MED/LOW, both kept in the tables): **S1** can move a valve, defeat an
abort, or hand control or firmware to an unauthenticated or non-operator party; **S2** wrong data,
configuration or state is shown, loaded or sent; **S3** robustness and maintainability; **S4**
tooling, harness and docs. Every item is recorded, not fixed (D17), except H-1. "Frozen" means a
golden pins the symptom, so a fix must change the golden deliberately (D20); "—" means the ledger
does not say. Long form, with operator consequence and proposal per item: `REPORT-DEFECTS-DRAFT.md`.

### 4.1 S1 — stand safety and control

| id | symptom | where (ledger) | frozen |
|---|---|---|---|
| SEC-1 (CRITICAL) | absent `X-Auth-Email` = operator; backend on all interfaces; 8081/3000 open to any source | `server.ts:978-979`, `api-server.ts:345-347`, `server.ts:1861`, `deploy/bootstrap_daq.sh:199-202` | — (H8/H8b freeze the viewer- and operator-header paths, not the absent-header case) |
| SEC-2 / D-OTA (CRITICAL) | OTA flash and flash-all ungated | `api-server.ts:1169`, `:1101` | viewer 200 frozen (D84) |
| SEC-3 (CRITICAL) | OTA `projectPath` → `pio run` → code execution as the service user | `api-server.ts:1200-1206`, `ota_service_main.cpp:232-243` | — |
| SEC-4 (HIGH) | `:9998`/`:9999`/`:9997` on `INADDR_ANY`, no auth | `sequencer_main.cpp:264`, `controller_main.cpp:139`, `ota_service_main.cpp:422` | — |
| SEC-5 (HIGH) | WS `CALIBRATION_COMMAND` ungated | `server.ts:1225` | — |
| SEC-6 (HIGH) | cross-site WS hijack; `Access-Control-Allow-Origin: *` on direct :8081 | `server.ts:901`, `api-server.ts:376` | — |
| SEC-8 (MED) | `set_countdown_target` skips the arm gate | `server.ts:1360` | — |
| SEC-10 (MED) | fail-open empty-email identity | `auth/main.py:356` | — |
| D-CTRLSTOP | controller never exits on SIGTERM/SIGINT with the db up; every systemd stop ends in SIGKILL | `TCPClient::connect` (SO_SNDTIMEO only), `ControllerService::stop()` | outcome frozen as-is (D89) |
| D-LATE | a timed-out transition executes later when the sequencer resumes | `sequencer_main.cpp:243`, `:75` | `holds` golden, self-transition (D85) |
| C4-1 | refused dynamic state deadlocks the command worker; aborts fail after 10 s; SIGTERM does not exit | `doTransitionTo` / `publishState()`, the 716-730 block (D42) | `ERR` after 10 s |
| D-HB | SERVER_HEARTBEAT flows while the sequencer is wedged; the boards' 15 s watchdog never trips | heartbeat_service; firmware `actuator_config.h:10-12` | none (firmware) |
| C4-3 | abort does not cancel a pending stage (+100 ms after the abort batch); delayed roles skipped by the abort batch | `ActuatorCommander.cpp:492-495`; the 835 call | yes |
| C1-10 | `triggerAbort` twice per abort: 8 ABORTs + 4 ABORT_DONEs; state publish lags the valves 37–79 ms | both `triggerAbort` sites; `waitAndSendAbortDone` 50 ms step (D50) | yes |
| C1-9 | CLEAR_ABORT never sent | `AbortBroadcaster::sendClearAbort` has no caller | yes |
| C4-4 | with `sequencer_owns_valves=true`, nobody commands the PWM roles during Fire | sequencer / controller | — |
| C4-5 | controller: no CR strip; wrong refusal cause with unresolved PWM roles; one more test-duty PWM after its FIRE_STOP close; > 3 s to exit on SIGTERM (sharpened by D-CTRLSTOP) | controller_service | PWM after FIRE_STOP ≤ 1 per board (C1) |
| D-CTL | controller keeps running with no TCP fire gate when its control port fails to bind | `controller_main.cpp:147` | gap 6, C0 work, not gating (D54) |
| D-SLOT | slot > 8 only warns; uint8 table id wraps onto another board's PT channel | `Config.cpp:49-53`, `DatabaseConfig.cpp:272/371`, `ControllerService.cpp:772-775` | H2 harness guard only (D41) |
| D-SUB | subscription during re-registration accepted, delivers 0 packets forever | `elodin-vtable-registry.ts` `noteSubscriptionRejected` | reproduced, not frozen (D41) |
| C6-3 | server-heartbeat loss undetected; daq_bridge does not take over | daq_bridge `send_from_daq_bridge` | sensor-board case only (lifecycle) |
| C6-6 | config_broadcast silent unless an ACTUATOR board is survivor | config_broadcast | — |
| C6-1 | log claims SENSOR_CONFIG sent; 0 packets | daq_bridge `FSWConfigManager` | — |
| C6-4 | board shown disconnected while its data displays | — | — |
| C1-7 | no abort-PT thresholds in ACTUATOR_CONFIG with cubic models and no thresholds file | config_broadcast | yes |
| D-EINTR | SIGTERM during an abort can lose one ABORT repeat (`sendto` EINTR under `SO_SNDTIMEO`) | `AbortBroadcaster.cpp:98-99,115-123`; `ActuatorCommander.cpp:354,371-379` | — |
| H-1 (**fixed**, H1) | integration run overwrote the live `abort_thresholds.txt` | `test/test_integration.sh` | gate fails on any dirty tracked file |

### 4.2 S2 — data, configuration and operational correctness

| id | symptom | where (ledger) | frozen |
|---|---|---|---|
| C3-3 (lead) | PT calibration file picked by mtime among 13 tracked files; panel/save can use a different file after a pull; live pressures unaffected | `calibration.ts` `loadPTCalibration` (store `:348`) | pipeline runs on a fixture dir (D30) |
| C2-4 (lead) | malformed/missing TOML → service starts on defaults | `config::load` | yes |
| C2-1 (lead) | digital-twin `[fire]` has no `state` → fire timer disabled | `config/profiles/digital-twin` | yes |
| C2-2 (lead) | underscore-int check globs `profiles/*.toml`; profiles are directories; shipped configs never checked | `test/check_toml_no_underscore_ints.py` | yes |
| C2-3 | stacklight reads `1_000` as 1, `5_006` as 5 | stacklight `getTomlValue` + `std::stoi` | yes |
| C2-5 | out-of-range ports/ids wrap silently (`70000`→4464, `-1`→65535, `65536`→0) | `config::load` | yes |
| C2-6 | wrong-typed TOML silently takes the default in C++, unlike the TS validator | C++ config | yes |
| C2-7 | config_broadcast prefers a cwd-relative actuator CSV over `[state_machine].actuator_csv` | config_broadcast | yes |
| C2-8 | short transition rows read left-aligned (NEEDS-REPAIR) | state-machine CSV | yes |
| C2-9 | duplicate `[[states]]` last-wins; aliases and case-folded names → UNKNOWN | state loader | yes |
| C2-12 | bad environmental board id: config_broadcast SIGABRTs (exit −6), daq_bridge exits 1 | config_broadcast | yes |
| C1-8 | malformed board IP encodes as `0.0.0.0` | config_broadcast `ipToU32Le` | yes |
| C1-2 | abort IPs in ACTUATOR_CONFIG reversed (d,c,b,a); SENSOR_CONFIG `controller_ip` is a,b,c,d | config_broadcast | yes |
| C1-1 | `create_abort_done_packet` writes `version = 1`; every other encoder 0 | `create_abort_done_packet` | yes |
| C1-5 | parsers ignore the version byte and accept trailing bytes (except ENVIRONMENTAL_DATA) | parsers | yes |
| C1-11 | profile `elodin_port` overrides `--elodin-port` (stacklight → 2240 regardless) | stacklight | yes |
| C1-12 | daq_bridge ignores `bind_port` argv when `[network] sensor_port` is set | daq_bridge | yes |
| BM-7 | PWM and abort packets hard-code protocol version 0, not `DIABLO_COMMS_VERSION` | controller; `AbortBroadcaster.cpp:74-78` | — |
| C3-1 | robust-model predictions depend on wall-clock time; `predict_pressure_psi` runs for every PT | `RobustCalibrationFramework.cpp:326-333, 377-386` (D56) | masked, not frozen |
| C3-2 | `calibration.ts` backfills channels 8–10 with `Math.random` | `calibration.ts` | — |
| C3-4 | TS `parseTareFile` accepts uid 0; C++ `LcTareStore::load` skips it | both tare loaders | — |
| C5-5 | `/api/cubic_calibration` ignores `DAQ_CALIBRATIONS_DIR`; backend store coefficients are zeros | `/api/cubic_calibration` | labelled, kept (D44) |
| BM-5 | three separate PT calibration stores | backend `calibration/`, `scripts/calibration/calibrations/`, `tools/calibration/calibrations/` | — |
| C5-1 | session start/stop reload board status: "connection lost" then "connected" | backend | — |
| C5-3 | `debug_mode` emits two identical `state_update` frames | backend | — |
| C5-4 | legacy state-CSV loaders never find an absolute `[state_machine]` path → empty transitions | state-CSV loaders | — |
| C4-2 | script timeout fires twice; column re-sent nondeterministically | sequencer | — |
| C6-2 | duplicate VTableStream subscriptions multiply delivery (~2× and 5×) | `test/test_duplicate_subscription.ts` (parked reproducer, D42e) | reproducer only |
| C6-7 | stacklight default target is a placeholder (192.168.2.70:5006); config overrides CLI | stacklight | — |
| C6-8 | shipped `[boards.integration_startup]` (board 60) collides with another slot (= D-SLOT) | config | H2 harness guard |
| C6-9 | calibration_service exits 1 if Elodin is not up; no retry | calibration_service | G5 worth writing (D58) |
| C6-10 | ota_service reports success when the board closes without replying | ota_service | — |
| D-API1 | `/api/query`, `/api/sensors` always 503; `/api/calibration_status` always the error object | `api-server.ts` | — |
| SEC-7 (MED) | video routes ungated; camera credentials reachable via previews | `video/routes.ts:77,144`; `service.ts:192-202` | — |
| D-PF (suspected) | `PressureFeed` re-subscribes every second any silent table; duplicate streams with a board offline | `PressureFeed.cpp:118-146` | its own investigation (D49) |
| D-ECHO (unconfirmed) | elodin-db echoes the bound layout per subscription; `ElodinClient` drops it — the D-SUB signal | `vtable_stream.rs:160-168`; `elodin-client.ts:187-203,283-289` | — |
| WP6 Q1 (record) | sensed `ACTn.CHm.actuator_state` rows never appear in the simulated stack; `actuator_mismatch` may never have fired for an ACT board | — | — (D48) |

### 4.3 S3 — robustness and maintainability

| id | symptom | where (ledger) |
|---|---|---|
| C1-3 | `uint8_t` chunk counter loops forever past 255; `memcpy` over-reads `num_sensors` | `create_sensor_data_packet` |
| C1-4 | config parsers write partial outputs before failing | `parse_sensor_config_packet`, `parse_actuator_config_packet` |
| C1-6 | TS `ElodinClient` never resyncs on an implausible length; re-schedules `setImmediate` every tick | `ElodinClient` |
| C2-10 | script parser stops at the first diagnostic | script parser |
| C2-11 | `load_assignments_from_config` declared, never defined | `SensorAssignmentManager` |
| C3-5 | `IMUCalibration.cpp` does not compile; commented out of the build (deleted by WP2) | `IMUCalibration.hpp:92`, `:203` |
| C5-2 | mock mode never creates the run directory → `POST /api/feed-char/results` 500 | backend |
| C5-6 | `GET /api/state-script?name=<missing>` → 200 empty; `PUT /api/video/config` → misleading 409 | backend |
| C5-7 | `sensor-backend.service` runs `npm run dev` (`tsx watch`) in production | `sensor-backend.service` |
| C6-5 | backend has no SIGTERM/SIGINT handler; WS clients see close 1006 | `server.ts` |
| D-OTA2 | ota_service abandons detached client threads on SIGTERM mid-flash | ota_service |
| D-BIND | heartbeat and config_broadcast ignore `bindToDaqInterface`'s result | heartbeat / config_broadcast mains |
| D-SEQ | `notifyControllerFireOnce` `send()` lacks `MSG_NOSIGNAL` (harmless only because SIGPIPE is ignored) | sequencer |
| D-FD | after the accept loop ends, callers `shutdown()` fds that finished clients already closed; a reused fd can be cut | `sequencer_main.cpp:345-349`, `controller_main.cpp:210-214` |
| D-ERRNO | signal handlers do not save/restore `errno` | all services |
| D-FORK / SEC-12 (LOW) | `to_string`/`setenv` between `fork` and `exec` in a multithreaded process | `ota_service_main.cpp:218-245` (`:237-238`) |
| BM-6 | 4 of 9 services ignore SIGPIPE; most handlers do non-async-signal-safe I/O | all services |
| D-API2 | malformed JSON is 500 on five routes, 400 elsewhere; `GET /api/config/profiles` can write files | `api-server.ts` |
| D-API3 | two paths leave a request unanswered; ~40 handlers evaluate after `writeHead`, so a throw hangs the request | `api-server.ts` |
| D-WS | `registerVTables` has no `.catch`; `conn_close` counter skips two message types; sixth copy of the slot rule | `server.ts:344-345` |
| SEC-9 (MED) | `/api/state-script/check` ungated, unbounded body, a process per call | `api-server.ts:669` |
| SEC-11 (LOW) | identity computed once at WS upgrade, never re-checked | `server.ts:978-980,1217` |

### 4.4 S4 — tooling, harness and docs

| id | symptom | where (ledger) |
|---|---|---|
| D-INTFLOW (harness) | integration `[Flow]` assertions bypass the transition table under debug mode; 167/0 is vacuous for that edge | `ws_data_flow_test.ts:1370`, `SequencerService.cpp:765` |
| D-INTPAD (harness) | integration script pads short transition rows, silently allowing the wrong edge | `test_integration.sh:505-511` |
| D61a (harness) | two integration checks vacuous on macOS (`timeout` absent) | `test_integration.sh:972-1012` |
| D61d (harness) | `ctest -R <area>` exits 0 with "No tests were found"; `-R pipeline` also matches `char_packets_pipeline_decode` | `run.sh` |
| D83 / D62 (CI) | `daq-server-ci.yml:325` "missing includes" step is vacuous (always warns; `head`'s status) | `.github/workflows/daq-server-ci.yml:325` |
| D83 (docs) | the per-area mutation list `test/characterization/README.md:30` claims exists is missing | `test/characterization/README.md:30` |
| BM-1 | `calibration_server.py` imports `scripts.calibration.*` (gone); the Python sidecar cannot start | `tools/calibration/calibration_server.py:20-31` |
| BM-2 | launchers pass `--relay-host/--relay-port`, which `calibration_service` rejects or ignores | legacy launchers (deleted by WP4) |
| BM-3 | `test_integration.sh --legacy` launched the missing `server-legacy.ts` | removed by WP4 |
| BM-4 | `start_tmux_dev.sh:371` starts the Python heartbeat even when the C++ binary exists | `start_tmux_dev.sh:371` |
| BM-8 | `tools/controller_lut/*.sh` invoke moved `scripts.controller_lut.*` modules | `tools/controller_lut/*.sh` (WP11) |
| C4-6 | `RELOAD_CONFIG` on `:9998` replies `ERR:unknown command` though `daq-server/CLAUDE.md` lists it | sequencer `:9998` |
| D-SL | stacklight `--help` omits `--force-state` | stacklight |
| D-FLASH | `flash/flash.sh` uses `${BLUE}` in `log_info`, never set | `flash/flash.sh` |
| D43(10) | `.pre-commit-config.yaml` pins are stale | for WP12 |
| BLOAT-MAP §7 | stale docs: five MOSTLY STALE (relay-era architecture, sidecar, Next.js), ten PARTLY STALE | for WP12 |

---

## 5. Open items

**Decisions the ledger is waiting on**
- Stand architecture: `uname -m` on star-rfs (D16). Until answered both arm64 and amd64 are
  tested; CI is the native x86_64 evidence (D55).
- SIGPIPE disposition for the five services that die on a broken pipe (Parked; team decision).
- Which of §1 the team takes up, and in what order. Every fix changes observable behaviour, so
  each is its own package: golden first, then code and unit file (STYLE S8; Team proposals).
- The `remaster-baseline` tag: cut on CI run 44011896743 (D77). D77 records it as local only,
  pending the user; D79 records the push as already done on the user's answer (D79 is the later entry).
- Draft PR #229 stays a draft: never merged or marked ready without the user (D59).
- The two tracked-but-gitignored live stores need a stand-side procedure (copy aside, pull,
  restore) before anyone untracks them (Parked; BLOAT-MAP §1).

**Team questions from the debates** (verdicts under `debates/*/verdict.md`; summarised in
REPORT-DEFECTS-DRAFT.md §5)
- TQ1 health-gate SERVER_HEARTBEAT on the sequencer worker (D-HB) — a stall during a hold then
  aborts the stand at 15 s. TQ2 after C5-7, should an uncaught backend error restart the
  process or keep running with a keyed status. TQ3 D-BIND: continue unpinned or exit. TQ4
  sequencer re-initialisation after a crash re-sends the boot batch, which moves valves. TQ5 the
  fatal-check list for config `validate()` and a `--check-config` mode. TQ6 where C++ in-duty
  rejections surface. TQ7 D-SUB reconnect during Fire (D46).
- WP10 Q1–Q6 (abort precedence, C4-3's column vs pending stage, CLEAR_ABORT edge, the C4-1
  hoist, `current_nav_`, who records the Elodin-reconnect characterization) (D47); WP6 Q1, Q4
  (D48); WP8 Q3–Q5 (D-FD fix shape, self-pipe scope, a db-down follower shutdown case) (D54);
  WP9 Q3 (mask θ/cov permanently) (D56).

**Recorded but unproven**
- D-ECHO, D-PF, OI-1, and D35's two Linux signatures (board 22 partial self-test; PT2.CH1 stream
  missing once idle — likely D-SLOT/D-SUB via the fixture's board 60) (D35, D41, D49).

**Packages still to land**
- None: every package is merged or parked (D142). WP9 is parked (D113). WP7 step 2 and WP10's §6.2
  cleanup are deferred items, not queued. The final §5 delta review of WP6, WP9-lite and WP10
  and Phase 4 (fresh-clone gate, `dev.sh --sim`, e2e Playwright) are tracked in D133.
- H3 harness fixes merged (D121); the D12a golden-diff gate step against the tag is not recorded
  as done.
- WP3's six path-only lines outside `daq-server/` were applied at queue time (D115, D117); WP4's
  no-op CI step (`daq-server-ci.yml:569-576`) is still the orchestrator's (D86).

**Ledger housekeeping noticed while writing** (for the orchestrator, not the team)
- The CHECKPOINT block is dated 2026-11-16 ~13:00 and still shows C1 in flight, the tag not
  started and "D1–D53"; D77–D91 supersede it.
- The Work packages table shows WP1, WP2 and WP4 as "queued" and the Merge log has no rows for
  WP1, WP2, WP4 or H8; D81, D82, D86 and D88 record the merges.
- Tag push: D77 "local only, waits on the user" vs D79 "already done".
- WP11 count: D67 says 11 edits; D68 corrects to 10 files / 24 line edits.
- WP1 count: D81 says 6,103 files; the CHECKPOINT and WP1-EVIDENCE's groups give 6,101.

---

## 6. Before you deploy

Deploying is the team's decision. This refactor was gated off the stand only and nothing in it
has been run against the stand's hardware; a build that passes the gate is evidence about
behaviour on a dev box, not permission to restart a service (D59, D77; `daq-server/CLAUDE.md`).

- **Nothing in §1 or §4 is fixed.** `main`'s behaviour is preserved bit for bit, so SEC-1 (an
  absent `X-Auth-Email` is operator; 8081 and 3000 open to any source), the OTA operator gate and
  the S1 items are still live after a deploy (D17).
- **Check for a run first.** `systemctl --user is-active sensor-elodin sensor-daq sensor-actuator
  sensor-calibration`: if any is `active`, a run is in progress; do not restart the backend
  under a live session (`daq-server/CLAUDE.md`).
- **Do not run the integration or e2e scripts on the stand.** `test_integration.sh` deletes the
  live calibration store (H-1 fixed the harness's copy, not the stand's procedure); the two
  tracked-but-gitignored live stores need a copy-aside procedure first (Parked; BLOAT-MAP §1).
- **Answer D16 first**: `uname -m` on star-rfs. Until then arm64 and amd64 are both tested and CI
  is the only native x86_64 evidence (D55).
- **Known unproven points** (§5): D-ECHO, D-PF, OI-1 and D35's two Linux signatures.
- **Team decisions waiting** (§5): SIGPIPE disposition, TQ1-TQ7 and which §1 items to fix; each is
  its own golden-first package. Draft PR #229 is for reading only (D59).

