# Defects and proposals — draft section for REPORT.md

Draft of the "what we found, what we did not fix" part of the refactor's final report, written
for the people who run the stand. Every item below comes from `LEDGER.md` (Defects, Parked,
Proposals, D-decisions) or a debate verdict under `debates/*/verdict.md`; nothing here was
re-diagnosed. Ledger revision read: `backend-remastered` @ `d20852e9`.

## 1. How to read this

- **The refactor fixed none of these.** Its rule (AGENT-RULES 6, D17) is that `main`'s behaviour
  is preserved bit for bit, defects included, so that a change in behaviour is always a decision
  the team made, never a side effect of moving code. The one exception is H-1, a bug in the
  *test harness*, which was fixed because it wrote to the stand's live files.
- **Ids.** `C1`–`C6` are the characterization areas that found the defect (C1 packets, C2 config,
  C3 calibration, C4 sequencer/controller, C5 backend pipeline, C6 service lifecycle). `D-*` are
  finds from the design notes and research. `H-*` is harness. `BM-n` is item *n* of the
  BLOAT-MAP's "Defects found" list. `TQn` and `WPn Qn` are team questions from the debate
  verdicts. `Dnn` is a ledger decision.
- **"Golden."** A golden is a recorded output of `main` that the test suite compares against on
  every run. "Frozen in a golden" means the defect's exact symptom is recorded: fixing the defect
  will turn that test red, and the fix package must change the golden deliberately (D20). "Not
  stated" means the ledger does not say whether a golden pins that symptom.
- **Line numbers** are against `main` @ `15b5a0c5` (product code on `backend-remastered` is
  identical). The STYLE verdict's paths are under `daq-server/diablo_server/` unless prefixed.
  `actuator_config.h` and the board `main.cpp` are ESP32 firmware, outside the refactor.
- **"Proposal"** is a fix direction recorded in the ledger's Team proposals or a verdict. Each one
  changes what the stand does, so each is a team decision and lands as its own package, golden
  first (STYLE S8). "None recorded" means the ledger holds no proposal for that item.

## 2. Lead defects (safety-relevant on the real stand)

Ordered by what they do to an abort, then to board health, then to data integrity, config and
access. All are **not fixed by the refactor** unless the status line says otherwise.

### C4-1 — One refused transition deadlocks the sequencer, aborts included

- **What happens.** Entering a dynamic state that is refused at load deadlocks the command worker
  whenever Elodin is connected: `doTransitionTo` holds `config_mutex_` while `publishState()`
  locks it again. Every later command — aborts included — waits the 10 s timeout and fails.
  SIGTERM does not exit the process.
- **On the stand.** After one refused transition the sequencer accepts nothing more. An operator's
  abort returns `ERR` after 10 s and no valve moves. The boards keep receiving SERVER_HEARTBEAT
  (see D-HB), so their own watchdog does not catch it either.
- **Where.** `SequencerService.cpp`: `config_mutex_` is taken in `doTransitionTo` at
  `:673/:717/:740/:904/:925` (WP10 verdict, fact 7); D42 names "the 716-730 block".
- **Golden.** The wedge is frozen (`ERR` after 10 s, `char_sequencer.py:1011`, session
  `digital-twin__scripts-load.txt`); "SIGTERM does not exit" is documented, not frozen (STYLE
  verdict). Kept sites carry `// Kept: C4-1 (D17)` tags (D45, D46).
- **Proposal.** Move `publishState()` out of the locked block ("the 5-line hoist"); a
  `TimeoutStopSec` for the sequencer unit; Clang thread-safety annotations (compile-time only,
  but a header edit plus a new warning). Open: WP10 Q4.
- **Status.** Not fixed by the refactor.

### D-HB — The boards' watchdog cannot see a wedged sequencer

- **What happens.** SERVER_HEARTBEAT keeps flowing while the sequencer is wedged by C4-1, so the
  boards' heartbeat watchdog — the independent safety layer — never trips while the server cannot
  abort. The boards abort **15 s** after the last SERVER_HEARTBEAT: 5 s timeout plus 10 s grace
  (`actuator_config.h:10-12`; D46 corrected the research's "5 s"). The watchdog is armed per board
  boot (`last_server_heartbeat_ms` resets in `setup()`, firmware `main.cpp:616`), not per server
  start.
- **On the stand.** Two faces of one mechanism. A server that cannot abort looks healthy to the
  boards. Conversely, on a warm stand a heartbeat_service that fails to start, or stops, aborts
  the stand 15 s later.
- **Where.** heartbeat_service (sender); firmware `actuator_config.h:10-12`, `main.cpp:421-425,
  478-483` (STYLE verdict, fact rulings).
- **Golden.** None: board behaviour is firmware, outside the suite. The lifecycle `hbloss.txt`
  golden is the *board*-heartbeat case, not this one (STYLE verdict).
- **Proposal.** Heartbeat only while the sequencer worker is alive. Cost: a stall during a hold
  then aborts the stand at 15 s — that trade is TQ1.
- **Status.** Not fixed by the refactor.

### C4-3 — An abort does not cancel a pending staged command

- **What happens.** Abort entry uses `is_transition=false`, so a staged command from the previous
  state still lands after the abort's batch — 100 ms after it in the golden (the ledger's first
  "+0.2 s" was corrected). The abort batch also skips any role still waiting on its delay
  (`ActuatorCommander.cpp:492-495`) because aborts do not bump `schedule_gen_`.
- **On the stand.** A valve can move 100 ms *after* the abort batch, in the direction the
  pre-abort state asked for; a role whose delayed command was pending is not commanded by the
  abort batch at all.
- **Where.** `ActuatorCommander.cpp:492-495`; the abort entry's `is_transition=false`; "the 835
  call" (D42, D47).
- **Golden.** Yes — the +100 ms stage is in the sequencer goldens.
- **Proposal.** `cancelPendingStages()` on `ActuatorCommander` plus the 835 call (D47, research
  Idea 3); abort precedence — front of the queue, or broadcast ABORT from the connection thread
  before queueing. Open: WP10 Q1, Q2 (does the abort column always win; honour the delays CSV?).
- **Status.** Not fixed by the refactor.

### C1-10 — Every abort is sent twice, and the GUI's abort state lags the valves

- **What happens.** The sequencer calls `triggerAbort` twice per abort transition: each abort
  sends 8 ABORTs (2 × 4 repeats), then 4 ABORT_DONEs. The second call joins the first's
  ABORT_DONE thread, which waits out a 50 ms step, so the abort state is published to Elodin and
  the GUI 37–79 ms after the valves are commanded (non-abort entries: 3–17 ms) (D50).
- **On the stand.** Boards see a doubled ABORT burst; the operator's state display trails the
  actual valve commands by up to one 50 ms step.
- **Where.** Both `triggerAbort` sites (D42); the 50 ms step is `waitAndSendAbortDone`'s (D50).
  The ledger gives no line.
- **Golden.** Yes (C1: each frozen in a golden; D50's harness lookahead encodes the delay).
- **Proposal.** A single `triggerAbort`; latch abort→abort as a no-op. Open: WP10 Q3.
- **Status.** Not fixed by the refactor.

### C1-9 — Boards are never told an abort is cleared

- **What happens.** CLEAR_ABORT is never sent: nothing calls `AbortBroadcaster::sendClearAbort`.
- **On the stand.** After an abort, the boards are never told it is over by the protocol's own
  message.
- **Where.** `AbortBroadcaster::sendClearAbort` has no caller. The ledger gives no line.
- **Golden.** Yes (C1).
- **Proposal.** A CLEAR_ABORT policy. Open: WP10 Q3 — on which edge is CLEAR_ABORT sent?
- **Status.** Not fixed by the refactor.

### C6-3 — Nobody notices when the server heartbeat stops

- **What happens.** Nothing detects loss of the server heartbeat: when heartbeat_service dies,
  daq_bridge does not take over (`send_from_daq_bridge` is fixed at startup).
- **On the stand.** The GUI raises no notification. If the heartbeat stays absent past 15 s the
  actuator boards abort (D-HB); a heartbeat inside the grace returns a board to Active (firmware
  `main.cpp:533-536`, STYLE verdict). heartbeat_service has a `Restart=always` unit (Parked), so
  the usual gap is systemd's restart delay; what an actuator board does under a 5 s service
  restart is uncharacterized (STYLE verdict).
- **Where.** daq_bridge `send_from_daq_bridge`; heartbeat_service. The ledger gives no line.
- **Golden.** Yes for a sensor board: under heartbeat_service SIGTERM the lifecycle golden records
  0 notifications (STYLE verdict).
- **Proposal.** STYLE S14a: the backend does not observe SERVER_HEARTBEAT loss today; raising it
  as a keyed operator status needs plumbing (TQ6). See also D-HB's heartbeat-only-while-alive.
- **Status.** Not fixed by the refactor.

### C6-4 — "Disconnected" while the board's data is still on screen

- **What happens.** A board that sends data but no heartbeats is marked disconnected while its
  data is still shown.
- **On the stand.** The connection indicator and the live data contradict each other; the
  operator cannot tell which to trust.
- **Where.** The ledger gives no line.
- **Golden.** Not stated.
- **Proposal.** None recorded.
- **Status.** Not fixed by the refactor.

### C6-6 — config_broadcast sends nothing unless the survivor is an actuator board

- **What happens.** config_broadcast sends nothing unless an ACTUATOR board is the designated
  survivor.
- **On the stand.** With any other board as survivor, no board receives its configuration from
  config_broadcast — including ACTUATOR_CONFIG, which carries the abort-PT thresholds (C1-7).
- **Where.** config_broadcast. The ledger gives no line.
- **Golden.** Not stated.
- **Proposal.** None recorded.
- **Status.** Not fixed by the refactor.

### C6-1 — The log says SENSOR_CONFIG was sent; nothing was

- **What happens.** daq_bridge logs "✅ Proactive SENSOR_CONFIG sent to N sense boards" but
  `FSWConfigManager` sends nothing (0 packets).
- **On the stand.** An operator reading the log believes the sense boards were configured.
- **Where.** daq_bridge, `FSWConfigManager`. The ledger gives no line.
- **Golden.** Not stated.
- **Proposal.** None recorded.
- **Status.** Not fixed by the refactor.

### D-SLOT — A board in slot > 8 silently lands on another board's pressure channel

- **What happens.** A board configured in slot > 8 only warns (`Config.cpp:49-53`) and its uint8
  table id wraps (`DatabaseConfig.cpp:272/371`, `(slot-1)*0x20+ch`): slot 10 lands on PT2.CH1.
  Related: the backend's `((n-1)%8)+1` fold, and `server.ts:344-345` is a sixth copy of the
  `board_id % 10` slot rule (D-WS); daq_bridge and calibration_service both register the
  calibrated tables; when the collision exists calibration subscribes `[0x20,0x21]` twice
  (PT2.CH1 smoothed twice).
- **On the stand.** A mistyped `board_id` silently corrupts or steals a live pressure channel.
  C6-8 is the same mechanism in the shipped config (`[boards.integration_startup]`, board 60,
  used by `test_integration.sh`); on Linux it made PT2.CH1 go dead in the integration run (D41,
  via D-SUB). H2 moved only the *harness's* startup board to a free slot and fails the run on
  `[Config] ERROR`; the product still accepts the config.
- **Where.** `Config.cpp:49-53`, `DatabaseConfig.cpp:272/371`.
- **Golden.** No product golden. H2's `[Config] ERROR` check is a harness guard (D41). D35's
  pipeline fixture froze board 60 in its goldens — open.
- **Proposal.** Fail-fast config (STYLE S11): collect every config error, print all, exit 78
  before any socket opens, with `RestartPreventExitStatus=78` in the same package — one policy
  for D-SLOT, C2-4, C1-8, C2-5, C2-12. Its own fix package with its own goldens, not WP9 (D56).
- **Status.** Not fixed by the refactor.

### D-SUB — A subscription that is accepted but never delivers

- **What happens.** A backend subscription made while a table is being re-registered is accepted
  but receives 0 packets forever; the backend retries only *refused* subscriptions
  (`elodin-vtable-registry.ts` `noteSubscriptionRejected`). The window is ~130 ms on Linux arm64,
  ~3 ms on macOS (D41).
- **On the stand.** After a startup or reconnect race, a live channel can go permanently dead on
  the GUI with no error — rare, timing-dependent, very hard to diagnose.
- **Where.** `elodin-vtable-registry.ts` `noteSubscriptionRejected`. D-ECHO (unconfirmed):
  elodin-db echoes the bound table layout for each accepted subscription
  (`vtable_stream.rs:160-168`) and `ElodinClient` drops it (`elodin-client.ts:187-203,283-289`) —
  the signal that would detect this.
- **Golden.** Reproduced against elodin-db and predicted every Linux failure (D41); no golden
  pins it. The Elodin-reconnect characterization is an open gap (WP10 Q6).
- **Proposal.** Per-channel liveness and a D-SUB watchdog. STYLE S10's direction: classify by the
  echoed `VTableMsg` (research Idea 2), re-send only a classified-dead pair, recreate the
  connection only when unclassifiable (Idea 3); a dead channel is shown dead. Open: TQ7
  (reconnect during Fire), WP6 Q4 (the `client`-parameter seam; reserving the `control` event).
- **Status.** Not fixed by the refactor.

### C3-3 — The GUI's PT calibration panel can read a different file after a pull

- **What happens.** `loadPTCalibration` falls back to scanning repo directories by mtime when the
  override file yields no coefficients. All 13 `daq-server/calibration/*.json` are tracked, so
  the pick depends on checkout file times (D30).
- **On the stand.** After a git pull / checkout / rsync / deploy the GUI's calibration panel can
  report, and its save-coefficients command can write from, a different file — here one with no
  coefficients — with no config change. **Live PT pressures are not affected:** `calculatePressure`
  has no caller; live conversion is calibration_service's cubic store. Related: C5-5
  (`/api/cubic_calibration` ignores `DAQ_CALIBRATIONS_DIR`; the backend store's coefficients are
  zeros) and BM-5 (three separate PT calibration stores).
- **Where.** `calibration.ts` `loadPTCalibration`; the store is `calibration.ts:348` (Parked).
- **Golden.** The pipeline area now runs on a harness-controlled fixture calibration dir with
  sessions for file present and absent (D30), so its golden no longer depends on checkout
  mtimes; whether the mtime fallback itself is exercised is not stated.
- **Proposal.** None recorded.
- **Status.** Not fixed by the refactor.

### C2-4 — A broken config file starts the service on defaults

- **What happens.** A malformed or missing TOML makes `config::load` log and return a default
  `Config`.
- **On the stand.** A service starts on built-in defaults instead of the stand's configuration,
  with only a log line to say so.
- **Where.** `config::load` (`Config.cpp:442-456` prints only in its `catch`es — WP9 verdict).
- **Golden.** Yes (C2: each frozen in a golden).
- **Proposal.** Fail-fast config, exit 78 (STYLE S11; same package as D-SLOT).
- **Status.** Not fixed by the refactor.

### C2-1 — The digital-twin profile has no fire timer

- **What happens.** `config/profiles/digital-twin` `[fire]` has no `state` → `fire.state=""` →
  the sequencer disables the fire timer for that profile.
- **On the stand.** On the digital-twin profile, Fire has no timer-driven end.
- **Where.** `config/profiles/digital-twin` `[fire]`.
- **Golden.** Yes (C2).
- **Proposal.** None recorded.
- **Status.** Not fixed by the refactor.

### C2-2 — The shipped profiles are never checked for `1_000`-style integers

- **What happens.** `test/check_toml_no_underscore_ints.py` globs `config/profiles/*.toml`, but
  profiles are directories now: the shipped profile configs are never checked.
- **On the stand.** The guard against C2-3 — stacklight's `getTomlValue` + `std::stoi` reads
  `1_000` as 1 and `5_006` as 5 — never runs on the configs the stand actually loads.
- **Where.** `test/check_toml_no_underscore_ints.py`.
- **Golden.** Yes (C2).
- **Proposal.** None recorded.
- **Status.** Not fixed by the refactor.

### D-OTA — Anyone signed in can reflash the boards

- **What happens.** `POST /api/ota-flash` and `POST /api/ota-flash/flash-all` have no operator
  gate (`api-server.ts` A1101, A1169, as the ledger cites them).
- **On the stand.** Behind Caddy a signed-in non-operator can reflash board firmware; `flash-all`
  reflashes every enabled board.
- **Where.** `api-server.ts` A1101, A1169.
- **Golden.** Not stated.
- **Proposal.** None recorded. STYLE S8a classes `/api/ota-flash` as *tooling*: it must never
  touch safety or control. Related: D-OTA2 (ota_service abandons detached client threads on
  SIGTERM mid-flash), C6-10 (reports success when the board closes without replying), D-API3 (an
  exception after `flash-all` sent SSE headers leaves the request unanswered).
- **Status.** Not fixed by the refactor.

### H-1 — An integration run overwrote the stand's live abort thresholds (fixed)

- **What happened.** `test/test_integration.sh` parked `cubic_calibration.json` and
  `lc_tare.json` but not `scripts/calibration/calibrations/abort_thresholds.txt`; its
  `calibration_service` regenerated that tracked file in place (seen 2026-11-15 20:03, ADC values
  858993460→901943133).
- **On the stand.** Running the integration test on the stand overwrote the live abort
  thresholds.
- **Where.** `test/test_integration.sh`.
- **Golden.** The gate now fails on any dirty tracked file after a run; the H1 merge row records
  the file's sha256 identical before and after.
- **Status.** **Fixed in H1** (merged, test harness only): `test_integration.sh` restores the live
  `abort_thresholds.txt`. Product code unchanged.

## 3. Remaining defects by subsystem

Each was recorded, not fixed. "Golden" says whether the ledger states the symptom is frozen.

### Wire protocol and packets

| id | what | where (ledger) | golden |
|---|---|---|---|
| C1-1 | `create_abort_done_packet` writes `version = 1`; every other encoder writes 0 | `create_abort_done_packet` | yes |
| C1-2 | config_broadcast writes abort IPs in ACTUATOR_CONFIG reversed (d,c,b,a); SENSOR_CONFIG `controller_ip` is a,b,c,d | config_broadcast | yes |
| C1-3 | `create_sensor_data_packet`: `uint8_t` loop counter (>255 chunks loops forever); `memcpy`s `num_sensors` datapoints regardless of vector size (over-read) | `create_sensor_data_packet` | yes |
| C1-4 | `parse_sensor_config_packet` / `parse_actuator_config_packet` write partial outputs before failing | those parsers | yes |
| C1-5 | Parsers ignore the version byte and accept trailing bytes (enforced only for ENVIRONMENTAL_DATA) | parsers | yes |
| C1-6 | TS `ElodinClient` never resyncs on an implausible length: waits forever, buffers, re-schedules `setImmediate` every tick | `ElodinClient` (TS) | yes |
| C1-7 | With config_base's cubic models and no thresholds file, ACTUATOR_CONFIG carries no abort-PT thresholds | config_broadcast | yes |
| C1-8 | A malformed board IP (`not-an-ip`) is encoded as 0x00000000: a typo'd IP becomes 0.0.0.0 on the wire | config_broadcast `ipToU32Le` | yes |
| C1-11 | Default profile `[stacklight_service] elodin_port` overrides the `--elodin-port` flag (stacklight connects to 2240 regardless) | stacklight | yes |
| C1-12 | daq_bridge ignores its `bind_port` argument (argv[3]) when the config has `[network] sensor_port` | daq_bridge | yes |
| BM-7 | Controller PWM and abort packets hard-code protocol version 0 rather than `DIABLO_COMMS_VERSION` | controller | — |

### Configuration loading

| id | what | where (ledger) | golden |
|---|---|---|---|
| C2-3 | stacklight `getTomlValue` + `std::stoi` reads `1_000` as 1 and `5_006` as 5 | stacklight | yes |
| C2-5 | Out-of-range ports/ids wrap silently (`sensor_port 70000`→4464, `-1`→65535, `database.port 65536`→0; `active_connectors` cast to uint8) | `config::load` | yes |
| C2-6 | Wrong-typed TOML values silently take the default in C++ (toml++), differently from the TS validator | C++ config | yes |
| C2-7 | config_broadcast prefers a cwd-relative `config/state_machine_actuators.csv` over `[state_machine].actuator_csv` | config_broadcast | yes |
| C2-8 | Short transition rows (e.g. Armed) read left-aligned (known NEEDS-REPAIR) | state-machine CSV | yes |
| C2-9 | Duplicate `[[states]]` name is last-wins; with `[[states]]` loaded, legacy aliases and case-folded names resolve to UNKNOWN | state loader | yes |
| C2-10 | The script parser stops at the first diagnostic | script parser | yes |
| C2-11 | `SensorAssignmentManager::load_assignments_from_config` is declared but never defined | `SensorAssignmentManager` | yes |
| C2-12 | config_broadcast aborts (SIGABRT, exit −6) on an uncaught `std::invalid_argument` for a bad environmental board id; daq_bridge catches the same error and exits 1. config_broadcast re-reads config in duty (`while (g_running)` `:545` → `buildPackets` `:548` → `config::load` `:186`), so a bad id saved mid-run aborts the running service (STYLE verdict) | config_broadcast; `Config.cpp:450-451` rethrows | yes |

### Calibration

| id | what | where (ledger) | golden |
|---|---|---|---|
| C3-1 | Robust-model predictions depend on wall-clock time between calls (bias decays with time), so they are not reproducible from inputs; `predict_pressure_psi` runs on every PT sample even when the PT does not use the robust model | `RobustCalibrationFramework.cpp:326-333, 377-386` (D56) | masked where it shows, not frozen (D56) |
| C3-2 | `calibration.ts` fills agreeing channels 8–10 with `Math.random`: backfilled coefficients differ on every load | `calibration.ts` | not stated |
| C3-4 | TS `parseTareFile` accepts a tare with uid 0; C++ `LcTareStore::load` skips it | both tare loaders | not stated |
| C3-5 | `IMUCalibration.cpp` does not compile on main (`IMUCalibration.hpp:92`, `:203`); commented out of the build (WP2 deletes it) | `IMUCalibration.cpp` | — |
| C5-5 | `/api/cubic_calibration` ignores `DAQ_CALIBRATIONS_DIR`; the backend's PT calibration comes from `daq-server/calibration/*.json`, whose coefficients are zeros | `/api/cubic_calibration` | labelled, kept (D44) |
| C6-9 | calibration_service exits 1 if Elodin is not up yet; no retry | calibration_service startup | planned: C0 package G5 (D56), not yet merged |
| BM-5 | Three separate PT calibration stores (backend `calibration/`, C++ `scripts/calibration/calibrations/`, Python `tools/calibration/calibrations/`) | — | — |

### Sequencer and controller

| id | what | where (ledger) | golden |
|---|---|---|---|
| C4-2 | A script timeout fires twice (HoldTimer and ScriptRunner's deadline); into a self-transitionable state the column is re-sent, nondeterministically | sequencer | not stated |
| C4-4 | With `sequencer_owns_valves=true`, nobody commands the PWM roles during Fire | sequencer / controller | not stated |
| C4-5 | controller_service: does not strip CR (`FIRE_START\r\n` → ERR); with unresolved PWM roles replies "fire gate disabled (sequencer owns the valves)" (wrong cause); can send one more test-duty PWM packet after its FIRE_STOP close; takes >3 s to exit on SIGTERM | controller_service | PWM after FIRE_STOP bounded ≤1 per board (C1 row) |
| C4-6 | `RELOAD_CONFIG` on :9998 replies `ERR:unknown command` (daq-server/CLAUDE.md lists it as a command) | sequencer :9998 | not stated |
| D-CTL | controller_service keeps running with no TCP fire gate when its control port fails to bind (`listen()` result ignored; the control thread logs and returns) | `controller_main.cpp:147` | none yet — gap 6, its only characterization, is C0 work in the D32 batch, not gating (D54) |
| D-SEQ | `notifyControllerFireOnce`'s `send()` lacks `MSG_NOSIGNAL` (harmless only because the sequencer ignores SIGPIPE) | sequencer | — |
| D-EINTR | A SIGTERM during an abort can fail an `AbortBroadcaster` `sendto` with EINTR (socket has `SO_SNDTIMEO`): one ABORT repeat lost; same exposure in `ActuatorCommander` | `AbortBroadcaster.cpp:98-99,115-123`; `ActuatorCommander` `:354,371-379` | — |
| D-FD | After the accept loop ends, the callers `shutdown()` fds that finished-but-unreaped clients already closed: a reused fd number can be cut, realistically a TCP socket another thread opened meanwhile | `sequencer_main.cpp:345-349`, `controller_main.cpp:210-214` | — |
| D-PF | (suspected, unproven) `PressureFeed` re-subscribes every second any table that has delivered nothing; with a board offline it would accumulate duplicate streams | `PressureFeed.cpp:118-146` | — (its own investigation, D49(11)) |

### Backend API and pipeline

| id | what | where (ledger) | golden |
|---|---|---|---|
| C5-1 | Session start and stop reload board status from config: a heartbeating board is reported "connection lost", then "connected" a second later | backend | not stated |
| C5-2 | In mock mode the run directory is never created: `POST /api/feed-char/results` during a session → 500 ENOENT | backend | not stated |
| C5-3 | `debug_mode` emits two identical `state_update` frames | backend | not stated |
| C5-4 | Legacy state-CSV loaders join `[state_machine]` paths onto fixed dirs: an absolute path is never found → empty transition list, no commanded-actuator snapshot | state-CSV loaders | not stated |
| C5-6 | `GET /api/state-script?name=<missing>` → 200 with empty body; `PUT /api/video/config` without a revision → misleading 409 | backend | not stated |
| C5-7 | `sensor-backend.service` runs `npm run dev` (`tsx watch`) in production | `sensor-backend.service`; `package.json:8` | — |
| C6-2 | Duplicate VTableStream subscriptions multiply delivery on elodin-db 0.16.1 (~2× and 5×); `test_duplicate_subscription.ts` exits 1 (the only reproducer; parked, not deleted, D42e) | `test/test_duplicate_subscription.ts` | reproducer only |
| C6-5 | Backend has no SIGTERM/SIGINT handler: exits by signal; WS clients see close 1006 | `server.ts` | not stated |
| D-API1 | `getQueryClient`/`getCalibrationStatus` are never passed in: `/api/query` and `/api/sensors` always 503, `/api/calibration_status` always the error object | `api-server.ts` | — |
| D-API2 | Malformed JSON is 500 on five routes, 400 elsewhere; `GET /api/config/profiles` can write files (`ensureSeeded()`) | `api-server.ts` | — |
| D-API3 | Two paths leave a request unanswered (a throw inside a `req.on('end')` callback outside its try; an exception after `flash-all` sent SSE headers); ~40 handlers evaluate calls after `writeHead`, so a throw there hangs the request (`ERR_HTTP_HEADERS_SENT`) | `api-server.ts` | — |
| D-WS | `registerVTables(...)` on connect has no `.catch`; `conn_close`'s outbound counter skips `mission_start_time` and `session_update`; `server.ts:344-345` is a sixth copy of the `board_id % 10` slot rule | `server.ts` | — |
| D-ECHO | (unconfirmed) elodin-db echoes the bound table layout per accepted subscription; `ElodinClient` drops it — the signal that would detect D-SUB | `vtable_stream.rs:160-168`; `elodin-client.ts:187-203,283-289` | — |

### Service lifecycle and signals

| id | what | where (ledger) | golden |
|---|---|---|---|
| C6-7 | stacklight_service default target is a placeholder (192.168.2.70:5006) and config overrides CLI flags | stacklight | not stated |
| C6-8 | `[boards.integration_startup]` (board 60) collides with another board's slot (daq_bridge's own error log); `test_integration.sh` used it — same mechanism as D-SLOT; H2 moved the harness's board | config / `test_integration.sh` | H2 `[Config] ERROR` guard (harness) |
| C6-10 | ota_service reports success when the board closes without replying | ota_service | not stated |
| D-OTA2 | ota_service abandons its detached client threads when SIGTERM arrives mid-flash | ota_service | — |
| D-BIND | heartbeat and config_broadcast ignore `bindToDaqInterface`'s result (heartbeat: NIC resolve failure returns 1, bind result dropped) | `heartbeat_service_main.cpp:248-251, :252`; config_broadcast `:526` (WP8 verdict) | — |
| D-SL | stacklight `--help` omits `--force-state` | stacklight | — |
| D-ERRNO | Signal handlers do not save/restore `errno` | all services | — |
| D-FORK | ota calls `to_string`/`setenv` between `fork` and `exec` in a multithreaded process | `ota_service_main.cpp:218-245` | — |
| BM-6 | Only 4 of 9 services ignore SIGPIPE (`daq_bridge`, `ota_service`, `sequencer_service`, `t7_bridge`); the other 5 die on a write to a closed socket (see Parked, §5); most signal handlers do non-async-signal-safe I/O | all services | not stated |
| D-FLASH | `flash/flash.sh` uses `${BLUE}` in `log_info`, never set | `flash/flash.sh` | — |

### Tools and launchers

| id | what | where (ledger) | golden |
|---|---|---|---|
| BM-1 | `calibration_server.py` imports `scripts.calibration.*` (gone): the Python sidecar cannot start | `tools/calibration/calibration_server.py:20-31` | — |
| BM-2 | Several launchers pass `--relay-host/--relay-port`, which `calibration_service` rejects or ignores | launchers | — |
| BM-3 | `test_integration.sh --legacy` launches the missing `src/server-legacy.ts` | `test/test_integration.sh` | — (WP4) |
| BM-4 | `start_tmux_dev.sh:371` starts the Python heartbeat even when the C++ binary exists | `start_tmux_dev.sh:371` | — |
| BM-8 | `tools/controller_lut/*.sh` invoke `python -m scripts.controller_lut.*` (moved): the documented LUT regeneration fails | `tools/controller_lut/*.sh` | — (WP11) |

## 4. Team proposals

Every proposal below changes observable behaviour, so none of it is in the refactor. Each is a
candidate fix package: golden first, then code and unit file in one package (STYLE S8). Source:
LEDGER "Team proposals", D46, D47, D54 unless noted.

| proposal | fixes | source |
|---|---|---|
| Move `publishState()` out of the locked block in `doTransitionTo` ("the 5-line hoist") | C4-1 | Team proposals; WP10 Q4 |
| Abort precedence: abort at the front of the command queue, or broadcast ABORT from the connection thread before queueing | C4-1 (an abort that does not wait behind a wedged worker), C4-3 | Team proposals; WP10 Q1 |
| `cancelPendingStages()` on `ActuatorCommander` plus the 835 call, on abort entry | C4-3 | D47 |
| A single `triggerAbort`; latch abort→abort as a no-op | C1-10 | Team proposals; WP10 Q3 |
| A CLEAR_ABORT policy (which edge sends it) | C1-9 | Team proposals; WP10 Q3 |
| Staged command replies / verifiers | sequencer command visibility | Team proposals |
| SERVER_HEARTBEAT only while the sequencer worker is alive | D-HB (lets the boards' watchdog catch C4-1); trade-off is TQ1 | Team proposals; D46 |
| Fail-fast config: collect every config error, print all, exit 78 before any socket opens; `RestartPreventExitStatus=78` in the same package; `--check-config` | D-SLOT, C2-4, C1-8, C2-5, C2-12 | Team proposals; STYLE S11, TQ5 |
| Startup transients get a bounded retry or exit 1 so the unit retries (the inverse of C6-9's exit) | C6-9 | STYLE S11; D56 |
| Per-channel liveness and a D-SUB watchdog: classify by the echoed `VTableMsg` (Idea 2), re-send only a classified-dead pair, recreate the connection only when unclassifiable (Idea 3); show a dead channel dead | D-SUB, D-ECHO | Team proposals; STYLE S10; TQ7; WP6 Q4 |
| Every degraded part becomes a keyed `ongoing` operator status (model: `markStaleBoards`, `server.ts:661-701`); the backend does not yet observe SERVER_HEARTBEAT loss, per-pair liveness or C++ in-duty faults — those need plumbing | C6-3, D-SUB, C++ in-duty rejections | STYLE S14a; TQ6 |
| Self-pipe signal handling | D-ERRNO, non-async-signal-safe handlers (BM-6) | Team proposals; WP8 Q4 |
| `TimeoutStopSec` for the sequencer unit | C4-1 ("SIGTERM does not exit") | Team proposals |
| Clang thread-safety annotations (compile-time only; a header edit plus a new warning) | C4-1 class of bug | Team proposals |
| D-FD shape: the signal handler never closes; the owning `Conn` closes after the shutdown/join loop (`UniqueFd` or an `int` closed at reap — the team's call). FIN moves ≤ 10 ms; its own package | D-FD | D54; WP8 Q3 |
| Uniform SIGPIPE disposition — see Parked, §5 | BM-6 | Parked |

How later fix packages may add structure to the sequencer (D47): free functions and carrier
structs freely; an appended data-only member (e.g. a `CommandQueue`) only when it is the fix;
never an object that owns a thread, an fd, or `config_mutex_`'s state. A new collaborator enters
only in the fix package whose fix is its reason to exist; the publisher waits for the C4-1 hoist.

## 5. Open team questions and decisions the team owns

### Questions from the debates

| id | question | source |
|---|---|---|
| TQ1 | Health-gate SERVER_HEARTBEAT on the sequencer worker (D-HB)? A stall during a hold then aborts the stand at 15 s. | D46 / STYLE verdict |
| TQ2 | After C5-7 is fixed, should an uncaught backend error restart the process (exit), or keep running with a keyed status? | D46 |
| TQ3 | heartbeat / config_broadcast D-BIND: continue unpinned (the verdict ruled so for heartbeat) or exit? | D46 |
| TQ4 | Sequencer re-initialisation after a crash or a board abort — a restart re-sends the boot batch, which moves valves. | D46 |
| TQ5 | The fatal-check list for config `validate()`; a `--check-config` mode. | D46 |
| TQ6 | Where C++ in-duty rejections surface: the Boards-page journal or an Elodin status table. | D46 |
| TQ7 | D-SUB reconnect during Fire. | D46 |
| WP10 Q1 | Is `TRANSITION:<abort>` *the* stop path; abort at the front of the queue or a connection-thread broadcast; is a third ABORT burst acceptable? | D47 |
| WP10 Q2 | C4-3: does the abort column always win over a pending stage; honour the delays CSV? | D47 |
| WP10 Q3 | C1-10 / C1-9: latch abort→abort as a no-op; on which edge is CLEAR_ABORT sent? | D47 |
| WP10 Q4 | C4-1: the 5-line hoist, or Idea 5's static check first — inside the remaster, with one baseline exception? (asked as written; D47 records the hoist as a later fix package) | D47 |
| WP10 Q5 | After `setNavState` goes, `current_nav_` is never written: planned input or dead member? | D47 |
| WP10 Q6 | Who records the Elodin-reconnect characterization (the only test that would see D-SUB)? | D47 |
| WP6 Q1 | Sensed `ACTn.CHm.actuator_state` rows never appear in the simulated stack. If the stand is the same, `actuator_mismatch` has never fired for an ACT board (record, don't fix). | D48 |
| WP6 Q4 | D-SUB / D-ECHO: approve passing `client` as a parameter at the decision; reserve Idea 2's `control` event in `elodin-link` now? | D48 |
| WP8 Q3 | Ratify the D-FD fix shape, and that `UniqueFd` arrives with that package. | D54 |
| WP8 Q4 | Self-pipe: the follower's wake needs `ElodinClient` to expose its fd — in the proposal's scope? | D54 |
| WP8 Q5 | Should `shutdown.txt` gain a db-down follower case? Stacklight's `[0, 1.2] s` shutdown bound holds only with the db up (2 s uninterruptible back-off). | D54 |
| WP9 Q3 | Mask `adj.json`'s θ/cov permanently in the stack golden (rel 1e-2; the predictions carry the contract), once the pre/pre run shows the spread? | D56 |
| D16 | Stand architecture: `uname -m` on star-rfs. Docs say Jetson (arm64); `enp4s0` suggests x86. The Linux test leg covers both until answered. | D16 |

### Parked — decisions that are the team's, not a refactor's

- **SIGPIPE disposition.** 4 services ignore it (`daq_bridge`, `ota_service`, `sequencer_service`,
  `t7_bridge`), 5 die on a broken pipe (`controller_service`, `calibration_service`,
  `heartbeat_service`, `config_broadcast_service`, `stacklight_service`). As today: a write to a
  closed socket kills the service; the four with `Restart=always` units come back after systemd's
  delay with a gap in what they publish (controller: a restart of the PWM-gate owner; heartbeat: a
  gap in SERVER_HEARTBEAT); `stacklight_service` has no unit and stays down. Uniform ignore: those
  five keep running and see `EPIPE` instead — what each then does is not yet characterized. WP8
  keeps each service's current disposition as an explicit per-service setting.
- **Untracking `scripts/calibration/calibrations/{cubic_calibration.json,abort_thresholds.txt}`**:
  tracked but gitignored live stores; untracking deletes them on every other checkout (the stand
  included) at the next pull.
- **`calibration/*.json`**: the backend's live PT-coefficient store (`calibration.ts:348`; see
  C3-3, C5-5, BM-5).
- **`elodin-relay.ts` + `npm run relay`**: no consumer found, but tools may connect to ws :9090.
- **`archive/legacy/python-services/{heartbeat,config_broadcast}_service.py`**: systemd/launcher
  fallbacks.
- **B4**, replacing hand-rolled PWM/config/abort encoders with `daq::create_*`: the version byte
  may change on the wire (see C1-1, BM-7).
- **`backend/package.json` `main`/`start`** point at a missing `dist/server.js`: fixing it
  changes `npm start`.
- **Deleting `tools/` operator GUIs** (`tools/gui/**`, the orphaned calibration GUIs):
  operator-facing.

### Recorded but unproven

- D-ECHO (does elodin-db echo the layout; does the client drop it) — unconfirmed.
- D-PF (PressureFeed duplicate streams with a board offline) — suspected; its own investigation
  (D49(11)).
- OI-1: Linux T7 capture/tare and ENV25 recovery failures in one integration run — suspected
  calibration-reader stall, unproven (D41).
- D35: on Linux under load, board 22 once delivered a partial self-test and the PT2.CH1 stream
  was once missing idle — suspected Elodin subscription timing; likely D-SLOT/D-SUB via the
  fixture's board 60 (D41), open.
