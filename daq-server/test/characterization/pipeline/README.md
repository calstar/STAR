# pipeline/ — the whole stack, frozen at its WebSocket and HTTP edge

```bash
bash test/characterization/pipeline/run.sh             # every session
bash test/characterization/pipeline/run.sh pt          # one routed PT board, the full script → golden/
bash test/characterization/pipeline/run.sh nocal       # the backend with no PT calibration file → golden/nocal/
bash test/characterization/pipeline/run.sh boards      # every simulated board type → golden/boards/
bash test/characterization/pipeline/run.sh stalesub    # D-SUB: a subscription accepted inside a re-registration window → golden/stalesub/
bash test/characterization/pipeline/run.sh operator    # a WS client whose X-Auth-Email is an approved operator → golden/operator/
bash test/characterization/pipeline/run.sh holds       # an accepted timed hold, then :9998 stalled and down → golden/holds/
bash test/characterization/pipeline/run.sh startlog    # the backend alone, its startup log (G12) → golden/startlog/
bash test/characterization/pipeline/run.sh selftest    # one failed self-test connector (G2) → golden/selftest/
bash test/characterization/pipeline/run.sh unrecognized  # a board the backend does not expect (G3) → golden/unrecognized/
bash test/characterization/pipeline/run.sh mismatch    # the ball valve against its CLOSE row (G1) → golden/mismatch/
bash test/characterization/pipeline/run.sh statecsv    # an idle-mode state-CSV deploy (G8) → golden/statecsv/
CHAR_UPDATE=1 bash test/characterization/pipeline/run.sh   # rewrite goldens (main's behaviour only)
```

`run.sh` takes the stack lock itself (re-entrant under `gate.sh` / `characterization/run.sh`) and
refuses to run on the stand. Without a git repository (a `git archive` export, a deployed stand)
it names the lock `$TMPDIR/daq-stack.lock` instead of asking git; nothing else in the harness or the
stack calls git. Once it holds the lock: pt ~75 s, nocal ~20 s, boards ~40 s, stalesub ~60 s,
operator ~20 s. Env:
`CHAR_BUILD_DIR` (default `build-gate/`, then `build/`), `ELODIN_DB` (an elodin-db binary; default
`~/.cargo/bin/elodin-db`), `CHAR_KEEP=1` (keep `.tmp/char_pipeline_<mode>_<pid>/` with every
service log), `CHAR_CAPTURE_ONLY=<file>` (save the raw capture, skip the comparison),
`CHAR_HOLD=<s>` (bring the stack up and leave it for poking).

## What runs

`sim/board_simulator.py --low-noise --skip-startup` → `daq_bridge` → `elodin-db` →
`calibration_service` → `diablo_server/backend/src/server.ts` (the thin backend; production's
`sensor-backend.service` runs the same file via `npm run dev` with `SESSION_SERVICE_MODE=systemd`)
→ WebSocket + HTTP on one port. `sequencer_service` sits behind the backend's command path (TCP).
Start order is production's (the one `lifecycle/` freezes) — DB, sequencer, bridge, calibration,
backend, simulator — with four readiness waits of its own (see "Platform neutrality"), each a wait
on the service's own log line, bounded, never a sleep; then `session.ts` waits until a probe client
sees a raw and a calibrated PT sample and lets it settle 3 s. (`test_integration.sh` starts
calibration_service after the backend; see "Registrars before the backend" for why this harness
does not.)

`api-server.ts` is not a separate server: `createAPIHandler()` is mounted inside `server.ts`'s HTTP
server and owns every `/api/*` path (with `video/routes.ts` for `/api/video/*`); `/stats` is
`server.ts`'s own. Every route registered by those three files is exercised (all GETs, plus the
POST/PUT/DELETE paths a session uses and their 4xx shapes). The two 404 shapes differ: a non-`/api`
path gets a bare 404 with no body or content-type, an unknown `/api/*` path gets
`{"error":"Not found"}`.

**elodin-db must be 0.16.1** (the CI / `setup.sh` / `bootstrap_daq.sh` pin). `run.sh` refuses any
other version: 0.14.2 answers this stack with `VTableNotFound` / `InvalidMsgId` and delivers no data
at all, which would freeze a dead pipeline.

## Isolation — nothing in the checkout is read for data or written

`make_fixture.py` and `run.sh` build `.tmp/char_pipeline_<mode>_<pid>/`:

- `config/config.toml` — `config/config_base.toml` with every `192.168.2.` rewritten to
  `127.0.0.` (what `service-controller.ts ensureSimConfig()` does), every port moved to 264xx,
  `[gui]` pinned to envelope @ 4 pts/s (as `test_integration.sh` does), `[heartbeat_service]` off
  (the bridge sends SERVER_HEARTBEAT itself). `[state_machine]` keeps production's relative
  `config/*.csv` paths, with the CSVs copied beside it. It is also the backend's `CONFIG_PATH`, so
  `profiles/`, `.active_profile`, `countdown_state.json`, `session_state.json` and `video.json`
  all land beside it.
- `srv/` — **the backend runs from a copy of its own source** (`srv/diablo_server/backend/src`,
  `package.json`, `shared/`; `node_modules` and the build dir symlinked), laid out like
  `daq-server/`. Everything the backend resolves relative to its own file then lands in the
  fixture, not the checkout: the state-CSV loaders (`srv/../config` — the fixture's), the
  state-script checker (`srv/build`). The source is copied unchanged at every run, so an edit to
  `diablo_server/backend/src` is what runs. `/api/cubic_calibration` reads the fixture's store
  through `DAQ_CALIBRATIONS_DIR`. The backend's legacy PT store (`calibration.ts`,
  `daq-server/calibration/*.json`) was deleted (C3-2); pt and nocal now start the backend the
  same way, and nocal is kept as the session with no PT calibration anywhere.
- `char/backend/` — the backend's cwd; its CSV loaders also look in `<cwd>/../../config`.
- `firmware/Hotfire_Code/` — a fixed PlatformIO tree. The OTA project search
  (`ota-build.ts discoverProjects`) walks up from the backend's cwd to the first
  `firmware/Hotfire_Code`; this one is found before the repo's, which changes with every firmware
  project and is missing from partial exports.
- `scripts/calibration/calibrations/` — the committed store minus `cubic_calibration.json`,
  `lc_tare.json` and `adjustments.json`. Every C++ service runs with `cwd` = the fixture (all their
  store paths are relative); the backend gets `DAQ_CALIBRATIONS_DIR` too. The live JSONs are never
  parked.
- `home/` — the backend's `HOME`, so session run dirs (`~/.local/share/elodin/daq_*`) stay inside.
- Also pinned: `GUI_PORT=0`, `SESSION_SERVICE_MODE=mock`, `DAQ_OPERATORS_FILE` (one operator),
  `STAR_DHCP_HOSTS` (absent), the video gateway/agent on unused 264xx ports.

Ports: elodin 26401, sensor UDP 26402, backend 26403, actuator UDP 26404, board logs 26405,
sequencer 26406, controller 26407, heartbeat UDP 26408, startup board 26409, video 26411-13,
OTA 26414. daq_bridge also hard-codes UDP 5008, which is why the lock matters.

### Platform neutrality (macOS and Linux must produce the same goldens)

- **Backend PT calibration.** Gone: `calibration.ts loadPTCalibration` used to take the newest
  `daq-server/calibration/calibration*.json` by mtime, so the pick depended on filesystem order
  (C3-3). It was dead (nothing converted with it) and was deleted with its 13 files (C3-2).
- **Self-test results.** The simulator sends each board's SELF_TEST once, at start; the backend
  subscribes to the self-test tables over several request-id-capped passes, and a result
  published before its pass is lost. `run.sh` starts the simulator one pass (5 s) after the first
  subscription pass with nothing left queued: a pass only sends its subscriptions, and on a loaded
  Linux box the self-tests of four boards still beat the DB's processing of them.
- **Sequencer boot transient.** At boot the sequencer publishes every valve de-energized
  (`publishInitialState`: a normally-open Fuel Main reads 1) and then applies the boot state
  (Fuel Main 0). A subscriber that arrives later is handed the table's latest row, and when both
  writes land in one client flush (likely under load) that row is the transient 1. `run.sh` starts
  the backend only after the sequencer has logged the initial publish and two state applications
  after it — the boot one and a 1 Hz republish, its own flush.
- **Connect backfill horizon.** The viewer client connects ~10 s after the first sample, well
  inside the backend's 60 s connect backfill; at ~60 s the one-shot self-test series fell outside
  it on the slower machine.
- **Registrars before the backend.** `daq_bridge` and `calibration_service` each register the
  calibrated tables. The boards fixture's startup board 60 sits on PT slot 10, whose uint8 table
  ids wrap onto PT2.CH1 (`[0x20,0x21]` raw, `[0x20,0x31]` calibrated; the validator's slot-10
  error in `golden/boards/http.txt` is this), so each registrar registers those ids as PT10.CH1
  and, a moment later, as PT2.CH1 again — ~130 ms apart on Linux arm64, ~3 ms on macOS. elodin-db
  binds a VTableStream to the table's components at subscribe time; a backend subscription
  accepted inside that window stays on the PT10 components and delivers nothing for the rest of the
  run, and since it was accepted the backend never retries it (`LEDGER.md` D41, D-SLOT, D-SUB).
  That is how `PT2_Cal.CH1.*` went missing from the Linux boards golden (216 → 213 series) while
  `calibration_service` was started after the backend. `run.sh` now starts the backend only after
  the bridge has logged `[Elodin] Drain complete, ready for TABLE data` (its last registration plus
  its hard-coded 1.5 s drain) and calibration_service `[Cal] Connected to Elodin, registered
  calibrated VTables, subscribed.`; each wait is capped at 30 s (the backend's own port-wait cap;
  both lines come within ~3 s idle) and fails loudly. Board 60 itself stays: moving it would drop
  the golden lines that freeze D-SLOT.

### Why one board

The bridge routes a packet by its source IP. The simulator can only send as a board whose address
it can bind, and on macOS without `lo0` aliases (they need sudo) only 127.0.0.1 exists. So the
fixture puts `pt_board` (board 21, ten ratiometric PT channels) at **127.0.0.1** and the simulator's
own config enables only that board. Every other board stays enabled for the services at its
`127.0.0.x` address, so board lists, sensor config and status echo the whole stand; nothing ever
sends as them. The result is identical on a Linux box with all of 127/8 and on a Mac with none of
it — the golden is host-independent. Per-board-type coverage is `test_integration.sh`'s job (and
the packets/calibration areas'). Side effect, frozen: `/api/config/validate` and the first
`session_start` report `board_id 21 but ip 127.0.0.1` as an error, so the session is started with
`force`.

### The boards session (`run.sh boards` → `golden/boards/`)

The complement: every board type the simulator models, streaming at once from its own
`127.0.0.<board_id>` (config_base's 192.168.2.x → 127.0.0.x, no board moved): PT (21, 22), LC (42),
TC (51), RTD (31), encoder (61), actuator (12, 14), ball valve (71), environmental (25), plus the
startup board 60 (`[boards.integration_startup]`, as test_integration.sh declares it), played by
`sim/board_startup_sim.py` through SETUP → reported stuck in setup (>4 s) → SENSOR_CONFIG → SELF_TEST,
after which it goes silent and is reported lost. `config_broadcast_service` is started by the
session only once the "stuck in setup" notification has arrived: left running from the start,
whether that notification fired depended on where in its 1.5 s cycle the board appeared. The LabJack
T7 (81) stays enabled for the services but not in the simulator, which has no T7 model.

Script: readiness → GET the board/sensor endpoints (`/api/sensor-config`, `/api/ball_valve_cal`,
`/api/lc_tare`, `/api/board-logs*`, `/api/debug`, `/stats`, `/api/config/validate`,
`/api/gui-config`, `/api/pressure-limits`, `/api/engine_state`) → connect → 5 s live → startup
board lifecycle → the same GETs → disconnect. It freezes per board type the entity/component set
and value of every stream, the self-test results, the status lifecycle (`board_status_update`
payloads, setup-stuck / connected / lost notifications) and those endpoints.

On macOS it needs the 16 board_id loopback aliases (`11 12 13 14 21 22 25 31 32 41 42 51 52 60 61
71`, the list test_integration.sh uses). `run.sh boards` checks `ifconfig lo0` first and fails
(exit 7) naming every missing alias; it never skips. Linux has all of 127/8.

### The stalesub session (`run.sh stalesub` → `golden/stalesub/stalesub.txt`)

D-SUB, made deterministic. The race "Registrars before the backend" removes from the other three
sessions is arranged here on purpose, step by step, each step waiting on the service's own log
line, so the defect is characterized instead of merely sidestepped:

1. DB, sequencer, `daq_bridge` as usual (the bridge leaves `[0x20,0x31]` registered as
   `PT2_Cal.CH1`, having registered it as `PT10_Cal.CH1` first).
2. **Registrar A**: `calibration_service` on `registrar_a.toml` — the fixture's config with every
   board but `[boards.integration_startup]` (board 60, slot 10) disabled — in its own cwd
   (`regA/`). It logs the slot-10 `[Config] ERROR` and re-registers `[0x20,0x31]` as
   `PT10_Cal.CH1`; once it has logged `[Cal] Connected to Elodin, registered calibrated VTables,
   subscribed.` it is stopped and reaped. The table outlives its connection.
3. The backend starts and subscribes with every table registered: `[0x20,0x31]` is accepted,
   bound to the PT10 components. `run.sh` waits for its passes as always.
4. The real `calibration_service` starts and registers `PT10_Cal.CH1` then `PT2_Cal.CH1` under
   `[0x20,0x31]` — the re-registration under a live subscription. The simulator (board 22 only,
   from `127.0.0.22`) starts after it.
5. `session.ts stalesub`: wait for `PT2_Cal.CH2` (the control: the startup board never touched
   channel 2's tables) → connect A → watch for 2 × `RESUBSCRIBE_MIN_MS` (`server.ts`, 5000) +
   2 s: a backend re-sending silent pairs at its minimum pass period would have re-sent twice
   → one `query_historical` over those 12 s for `PT2.CH1.raw_adc_counts`,
   `PT2_Cal.CH1.pressure_psi`, `PT2_Cal.CH2.pressure_psi`. (Main's real cadence is longer:
   `scheduleResubscribe` sleeps until the earliest *refused* pair is due, and the T7 tables no
   `t7_bridge` registers here stretch that along their backoff ladder — 5, 10, 20, 40, 60 s — so a
   pass may not fall inside the window at all. It does not matter for main: an accepted pair is
   never re-sent in any pass; only a refusal or a disconnect un-marks it.)

What `stalesub.txt` freezes (`characterize.py stalesub_report`): registrar A's slot-10 error and
its registration count; the bridge's and calibration_service's; how many times elodin-db logged
inserting vtable `[32, 49]` (five: bridge ×2, registrar A, calibration_service ×2) and `[32, 50]`
(two); that the backend never gave up on `[0x20, 0x31]` (the only per-pair line it logs, and only
for refusals); then, per channel of board 22, the live value of the raw stream and of every
calibrated component (`absent` when no frame carried it), the series present in the connect
backfill and in the query. Main's behaviour was: channel 1's raw stream flows, channels 2–4 flow
raw and calibrated, and `PT2_Cal.CH1.*` is **absent** live, from the backfill and from the query —
accepted, never refused, never retried, silent for the whole run. Since the D-SUB watch (#23,
`backend/src/server/subscription-watch.ts`) the backend sees `PT2_Cal.CH1` silent while
`PT2.CH1` and `PT2_Cal.CH2` deliver, flags it after 5 s and reconnects, and the fresh subscription
binds to the live registration: the golden now has `PT2_Cal.CH1` live and in the query, inside the
12 s window. The backfill on connect still predates the reconnect, so it shows the channel absent.
It uses real elodin-db 0.16.1 and the real backend; no product code is touched.

On macOS it needs the `127.0.0.22` alias only. It adds ~1 min to the area.

### The operator session (`run.sh operator` → `golden/operator/`)

The WS operator allowlist's positive half (H8b; LEDGER D84, D63's security review). `server.ts`
reads `X-Auth-Email` at the WebSocket upgrade: no header is the trusted-local case (`operator:
true`, `email: null`), a non-empty header is looked up in `operators.txt` (`operators.ts`,
case-insensitive), and `control_unlock` arms the connection only for an operator. The pt session
freezes the first case (client A) and the viewer (client B, `viewer@example.com`: `operator:
false`, `not_operator`, `Control locked`) but never a header that **is** in the file, so a backend
that treated every non-empty header as a viewer, or whose unlock always refused, stayed green.

Script, on the pt fixture (one routed board, the calibration file present): readiness → connect A
with `X-Auth-Email: operator@example.com` (the fixture's one operator) → `control_unlock` →
disconnect. What it freezes: A's `control_status` `{"email": "operator@example.com", "operator":
true}` (`ws_handshake.txt`) and its `control_unlock_result` `{"ok": true, "reason": "ok"}`
(`ws_events.txt`, `unlock`). Nothing is commanded after the unlock: the reply is the observable,
and a transition would move the sequencer for no further coverage (the armed command path is the
pt session's `transition_armed`). It is its own session because `ws_streams.txt`'s P12 rule
counts every client's handshake replay in its "paths checked" line; another client in the pt
session would change that line. The two mutations below are what it is for; the second also reds
the pt session from its `unlock` step on (client A, no header), the first reds nothing else. ~20 s.

### The holds session (`run.sh holds` → `golden/holds/`)

The backend's `:9998` line client (`sequencer-client.ts sendToSequencer`) has three replies no other
session reaches (DESIGN-WP5 §6 G4, LEDGER D64(1), D70): an **accepted hold** — the sequencer answers
`OK:<ms>` rather than `OK`, and the client's predicate must take it — and the two ways the
sequencer can fail to answer: **stalled** (`State transition failed: timeout` after the client's
2000 ms socket timeout) and **down** (`… connect ECONNREFUSED 127.0.0.1:<port>`). `pt` sends only
an invalid hold (`holdMs: -5`, rejected before the wire), and `test_integration.sh` sends an
accepted one without asserting its errors, so none of the three was frozen.

Fixture: the `pt` fixture (`make_fixture.py pt`), plus a state that takes a hold. The shipped
config has none, so `run.sh` builds one the way `test_integration.sh` does: a `Flow Test` column
appended to copies of the three state-machine CSVs (`config/holds_*.csv` — reachable from Press
Standby and back, the gate valve `Fuel Main` OPEN, staggered 0.4 s on the way in), `[state_machine]`
pointed at them by the same relative form (an absolute path is found by the sequencer only — see
"Frozen behaviour"), and the `[[states]] id = 21 … is_flow = true` + `[flow]` block (800 ms, max
5000, return `Press Standby`) appended to `config.toml` exactly as `test_integration.sh:538-548`
writes it. The sequencer refuses a hold into a state it cannot return from, which is why the CSV
column exists. One step `test_integration.sh` does not take: ten rows of the shipped
`state_transitions.csv` are one cell short (`feed-twin/backend/statemachines/NEEDS-REPAIR.md`;
`StateMachine.cpp` and `state-csv/state-transitions.ts` both read a row left-aligned and a missing
cell as "not allowed"), so a column appended to such a row lands under the previous header —
Press Standby's `1` under Emergency Abort — and the hold is refused `transition rejected`.
`test_integration.sh` enters Flow Test with debug mode on, which bypasses the table
(`SequencerService.cpp` `if (!debug_mode_)`), so it never saw that. Here each transitions row is
first padded with `0` to the header's width, which neither parser can tell from a missing cell;
the actuator and delay CSVs are full width and are not touched.

Script (`session.ts holds`; client A connects as the operator): readiness → connect → unlock →
park on the hub (`Idle → Armed → Press Standby`, the CSV's only route) → **hold_accepted**:
`state_transition {state: 21, holdMs: 800}` — no `error` frame, the `state_update` into 21, the
auto-return `state_update` to 20 after 800 + 400 ms, all inside the step → **sequencer_stalled**:
`SIGSTOP` the sequencer (its PID comes from `run.sh` through `ports.json`'s `sequencer_pid`),
`state_transition {state: 20}` — a self-transition on the hub, so the line changes no state when
it is eventually read — wait for the `timeout` error, note whether it arrived within T2, `SIGCONT`,
settle: the backend destroyed its socket at 2 s but the connection and the line sit in the
sequencer's listen backlog, so the resumed sequencer reads and applies it and its reply write fails
harmlessly (`SIGPIPE` ignored, `MSG_NOSIGNAL`); whatever it publishes lands in this step (D-LATE:
a transition the operator was told failed still happens later) → **sequencer_down**: `SIGTERM`,
wait until `:9998` refuses a connection (not a signal-0 probe: the sequencer is `run.sh`'s child
and stays a zombie until reaped), `state_transition {state: 20}` → `ECONNREFUSED`; `debug_mode` →
no reply at all (its `.catch(() => {})` path) → disconnect. Nothing else, so a change elsewhere in
the WS/HTTP surface cannot fail this golden. ~45 s; it needs nothing a Mac lacks.

What it freezes: the usual six files for its steps. The one timing line is categorical (P13):
`= timeout_reply_within_2800ms: yes`. It is judged on CI (LEDGER D34: this Mac's timer overshoot
can make it `no` under load); the bound is 2000 ms + a margin for that overshoot, narrower than
the next round number, so a 3000 ms socket timeout goes red.
### The startup-log session (`run.sh startlog` → `golden/startlog/backend_startup.txt`)

G12 (`DESIGN-WP6.md` §6.3 "startup-log diff"; LEDGER D96, where it also gates WP5). The backend
is started **alone** on the pt fixture — the same `start_backend` command every session uses,
nothing listening on any of its ports — and stopped once it has logged the last synchronous line
of its `listen` callback, `[ThinServer] Actuator service: localhost:<port>`. `startlog.py` keeps
everything the process wrote up to and including that line, normalised (N1, N4–N6), and nothing
after it. That prefix is one deterministic sequence: ESM import evaluation (the state-CSV loaders'
import-time config reads and their warnings, `session-manager`'s construction), then `server.ts`'s
top level statement by statement — `GUI downsampling`, the PT calibration search, the sensor-role
map, `Loaded N boards`, the state-actuator CSV search with its `Trying:` lines, the GUI static
server — then the three `listen` lines. The lines after the mark are I/O-ordered (the Elodin
connect refusals, the video gateway's, the board-log receiver's bind) and are cut, not frozen.
No `git grep` of the other goldens finds any of these lines: this is the only place a moved import
(`shared-types.ts`'s top-level `await`, WP5 5.4), a reordered startup row (WP6 §1.2) or a loader's
import-time read moving out of import time shows.

### The WP6 gap sessions (`run.sh selftest|unrecognized|mismatch|statecsv` → `golden/<mode>/`)

`DESIGN-WP6.md` §7's G2, G3 and G1 (LEDGER D48): three notifications no other golden raised, each
in a session cut to its one path so a change elsewhere on the WS/HTTP surface cannot fail it, and
each on the pt fixture (one routed PT board at 127.0.0.1) with one deliberate difference. Their
readiness is `waitForData` with its board arguments (`session.ts`): the one probe until the backend lists
board 21 (and 71 in mismatch) connected and, for selftest, has its self-test -- the heartbeat and
self-test tables are later subscription passes than the PT tables, and on a loaded Linux leg they
went live ~3 s after the PT data, so a client connecting on PT data alone saw a board list without
21 and no replay, and the one-shot self-test landed live in a later step. Bounded (20 s): a result
that never arrives is still red.

- **selftest (G2, `self_test_fail_<id>`).** The simulator is started with `--fail-connector 21:3`
  — an opt-in flag this package added to `sim/board_simulator.py`, default off, so every
  existing launch sends the packet it always sent (`sim_selftest_check.py` pins main's SELF_TEST
  bytes for board 21 and runs first, with no ports; a `0` elsewhere or a changed default is red
  there). pt_board's one-shot SELF_TEST then carries `sensor_3 = 0`; `server.ts` raises
  `self_test_fail_21` "Board 21 (PT) failed self-test" once (the `break` after the first failing
  row) during readiness. Client A's connect burst freezes the replay with the 0 (P12, whose expected
  values come from `selftest_expected.py --fail 21:3`: the board's line reads `all 1 but sensor_3 =
  0`) and the notification replay; the unnarrowed `query_historical` freezes the series.
- **unrecognized (G3, `unrecognized_<id>`).** The backend's `CONFIG_PATH` is `config_backend/`, a
  copy of the fixture's config in which pt_board's `board_id = 21` is spelled `id = 21`
  (`make_fixture.py`); every service keeps `config/`. The VTable registry subscribes to board 21
  either way (`elodin-vtable-registry.ts`: `b.board_id ?? b.id`), so its data flows, but
  `loadBoardsFromConfig` (`server.ts`, numeric `board_id` only) never listed it: its first heartbeat
  creates it `expected: false`, and the next 1 Hz sweep raises `unrecognized_21`. Frozen as main
  does it: the board's `ip` and the message's address are the backend's **invented**
  `192.168.2.21` (`updateBoard` hard-codes `192.168.2.<id>` for a board it has no config for),
  `boardNumber` is `null`, its type comes from the heartbeat. Not an empty `[boards]` (that trips
  the registry's 1..255 heartbeat fallback). WS only: the HTTP routes read `board_id` too, with
  their own defaults for a board that lacks it, and those shapes are not what this session freezes.
- **mismatch (G1, `actuator_mismatch`).** The fixture names the ball valve — `"Main Ball Valve" =
  ["NC", 1, 71]` in `[actuator_roles]`, a CLOSE-in-every-state row in the actuators CSV and a 0 row
  in the delays CSV, exactly as `test/test_integration.sh` adds them, as copies beside the
  originals with `[state_machine]` repointed by the same relative form — and the simulator runs
  pt_board plus `ball_valve_board` (71, from 127.0.0.71: that alias is checked first on macOS).
  A ball valve is the one actuator the simulated stack reports a sensed position for
  (`BV1_Cal.CH1.position_pct` → sensed `BV1.CH1`, `ball-valve.ts`; an ACTUATOR board's current is a
  free sine). Unlock → debug on → `actuator "Main Ball Valve" 1` → 4.5 s (3 s of travel,
  `BALL_VALVE_TRAVEL_S`) → debug on **again**: `doSetDebugMode(true)` publishes state without
  clearing overrides (`SequencerService.cpp`), and that `_SEQUENCER_STATE` row is what schedules
  the backend's 5 s check → `actuator_mismatch ongoing: true` "Actuator mismatch in Idle: BV1.CH1
  (expected CLOSED, sensed OPEN)" → `actuator 0`: the valve travels back, each sensed change with
  the key active reschedules the check → "Actuator positions match expected" `ongoing: false` →
  debug off. The two notifications are waited for by predicate with a bound (12 s / 15 s), not by
  quiet, so the 5 s timer cannot straddle a step boundary under load; a late or missing one is a
  frame in the wrong step, which the golden shows. (Debug off first does not work: it clears
  overrides before publishing, so the valve closes before the check runs.) The valve never hears a
  SERVER_HEARTBEAT here (daq_bridge sends them to `broadcast_ip`:hb_udp, the valve listens on
  127.0.0.71:act_udp), so the simulator's failsafe-open never arms.
- **statecsv (G8, LEDGER D105, the idle-mode state-CSV deploy).** Client A connected, the session
  GETs the actuators CSV, flips one cell (Fuel Vent's Idle column, CLOSE → OPEN) and POSTs it back
  as the operator with no session active: `writeStateCsv` writes the active profile and, idle,
  copies it over the deployed file (both under the fixture's `config/`), and `setImmediate` fires
  `onStateCsvUpdated` (`server.ts`), which rebuilds `STATE_ACTUATOR_MAP` and broadcasts one
  `config_updated`. Frozen: that frame is all A gets (its commanded snapshot was sent at connect
  and is never re-sent), the POST's `{"success":true,"deployed":true,…}`, the CSV before and after
  (`csv.txt`, both), and the next client's connect burst — B's snapshot carries `ACT_CMD.B2.CH2`
  (Fuel Vent) `= 1` where A's carried `0`, the one line that shows the map was rebuilt from the
  new file. Nothing reaches the sequencer (it read its CSVs at boot; a deploy reaches the pipeline
  only at session start), so `BV_CMD`/`ACT_CMD` Elodin rows do not change.

## The scripted session (`session.ts`)

GET sweep → connect A → 3 s live → viewer client B (`X-Auth-Email`, not an operator) → unknown `subscribe`, non-JSON, `get_state_transitions` →
four `query_historical` shapes → control commands while locked → `control_unlock` → locally
rejected transitions (unknown id, bad hold) → a transition the sequencer refuses (Idle→Fire) →
Idle→Armed → debug on → actuator open/close/unknown → debug off → `extend_fire` outside Fire →
Armed→Idle → countdown set/clear → a
calibration command → an unsupported command → `session_start` (blocked, forced, again) → GET
sweep during the session + session POSTs → the viewer's operator gates (`http_viewer_gates`, below)
→ `session_extend` (good, bad) → `session_stop` (twice) → HTTP error shapes → the operator's
writes, idle (`http_operator_writes`, below) → disconnect. Inside `transition_armed`, once the
sequencer has answered, `GET /api/engine_state` and `GET /api/debug?values` (D64(3), below).

**Operator gates as the viewer (H8, `DESIGN-WP7.md` §7; LEDGER SEC-*, D63, D72).** `api-server.ts`
has 14 `isConfigWriteAuthorized` gates, each answering 403 `{"error":"Not an approved operator"}`
to a non-empty `X-Auth-Email` that is not in `operators.txt` (the fixture's lists one operator,
`operator@example.com`; the viewer is `viewer@example.com`). `http_errors` freezes six of them
(`POST /api/config`, `/api/config/import`, `/api/state-csv`, `profiles/switch`,
`/api/board-log-mode`, `calibration_profiles/save`); `http_viewer_gates` freezes the other eight,
during the session, in the file's order: `POST /api/state-script`, `profiles/create`, `…/rename`,
`…/delete`, `POST /api/ball_valve_cal`, `POST /api/feed-char/results` (the one that needs a
session: without one it answers 409 before the gate), `calibration_profiles/load`, `…/new_blank`.
Each body is well-formed, so a dropped gate reads as a non-403 -- for most a 200 and a changed
file (rename and delete name the active profile, which their routes refuse with a 400) -- rather
than as a parse error; the five GETs that follow (`/api/config/profiles`, `/api/state-script?name=
viewer.script`, `/api/ball_valve_cal`, `/api/feed-char/results`, `/api/calibration_profiles`)
witness that nothing was written, and `ws_events.txt` shows the step raised no `config_updated`.
The WS half of the same gate is frozen where it already was: client B's `control_status`
`operator: false` (`ws_handshake.txt`), its `control_unlock_result` `not_operator` and the
`Control locked` refusal of its `state_transition` (`ws_events.txt`, `viewer_client`); its
positive half -- a header that is in `operators.txt` -- is the operator session (above). The two
ungated OTA routes (D-OTA / SEC-2) are not here — the pipeline runs no `ota_service`; the viewer's
200 on `POST /api/ota-flash` is `lifecycle/golden/ota.txt`, and `flash-all`'s no-enabled-boards
case is a backend vitest (D72).

**The operator's writes, idle (H1, `DESIGN-WP7.md` §7, the golden half; WP6 G7).** Every other
request at these routes is the viewer's or one the route refuses, so until this step nothing
froze what a write does when it is accepted. `http_operator_writes` runs after the session, as
`operator@example.com`, in the routes' order: `POST /api/config` (the active profile read back
with one extra `[char]` table), `POST /api/config/import` (the deployed file plus a
`[char_import]` table, then `x = [` — 400 and the profile rolled back), `POST /api/state-csv`
(the actuator table cut to its header and two rows), `POST /api/state-script` (`h1.script`,
checked by `state_script_check` from `<srv>/build`), `profiles/create`, `…/rename`, `…/switch`
(to `h1b` and back), `…/delete`, `calibration_profiles/save`. Each is followed by the files it
should have changed, read from the fixture's `config/` tree and printed as `FILE <path>` lines in
`http.txt` (the deployed copy and the profile's; a content already printed is named, not
repeated; `(absent)` for a file that is not there), by a witness GET where the route has one,
and by the frames the backend sends because of it: five `config_updated` in `ws_events.txt`
(`onConfigUpdated` / `onStateCsvUpdated`, which only a deployed write fires — save, import, the
CSV, each switch), while the board list each deploy re-broadcasts is the same config's and lands
in the distinct payloads `ws_streams.txt` already holds. Idle on purpose —
during a session the same writes are drafts and fire nothing; last on purpose — nothing after
the step reads what it changed. That the response is written before the callback runs cannot be
seen on loopback and is a backend vitest instead (`api-write-callback-order.test.ts`, D72).

**Armed over HTTP, and `/api/debug` at value level (D64(3)).** The sweeps read
`/api/engine_state` as 1 (Idle) and `/api/debug` as a schema (P9), so a backend whose HTTP side
stopped following the WS side's state, or whose `ingestConnected` / `useRelay` / `wsClients`
flags read from a stale copy, would stay green. Inside `transition_armed`, after the sequencer's
reply, `GET /api/engine_state` is frozen as 2 and `GET /api/debug?values` (the backend ignores
the query; the harness renders it by P14) as `ingestConnected: true`, `useRelay: false`,
`wsClients: >=1`. The same `?values` request is in both sweeps (`wsClients` 0 before any client,
`>=1` during the session).

**Timing.** A step that sends something lasts its nominal time and then until the event stream
(everything but the streams and board-health notifications) has been quiet for `QUIET_MS` = 1.5 s,
capped at 20 s, so a reply that a loaded machine delivers late still lands in its own step. The
viewer client connects ~10 s after the first sample, well inside the backend's 60 s connect
backfill horizon (`history-backfill.ts HISTORY_CONNECT_SPAN_MS`); at ~60 s, where it used to be,
whether the one-shot self-test series made the cut depended on the machine's speed.

There is no subscription protocol in the thin backend (every client gets every stream); the
`subscribe` step records that an unknown message type gets no reply, and (G10, `DESIGN-WP6.md` §7)
that a well-formed message whose handler throws — `{"type":"send_command"}` with no payload — is
caught at the WS boundary (`Bad message` log) and gets no reply either.

## Goldens

| file | what |
|---|---|
| `ws_handshake.txt` | each client's connect burst, in order (`server.ts` `wss.on('connection')`) |
| `startlog/backend_startup.txt` | the backend's startup log to the end of its synchronous start, normalised (`startlog.py`, G12) |
| `ws_events.txt` | per step: what was sent (`>`) and every event-like frame back (`<`), in arrival order |
| `ws_streams.txt` | the streaming types: channel set and value where the sim fixes it; the timing bound T1; distinct normalised payloads of the periodic types; history series per request |
| `ws_schema.txt` | every key path of every message type, with the JSON types seen |
| `http.txt` | every request: status, content-type and the headers that matter, normalised body; in `http_operator_writes`, `FILE <path>` lines — a fixture file as `session.ts` read it at that point |
| `csv.txt` | the CSV bodies the backend serves (`/api/state-csv`) |

### The CSV

There is **no run/session data-logger CSV in this pipeline.** `[data_logger_service]` in
`config_base.toml` is vestigial: the logger is archived (`archive/legacy/cpp/data_logger`,
`archive/legacy/python-services/data_logger_service.py`, which wrote binary `.sensorlog`, not CSV),
nothing builds or starts it, and the installed elodin-db has no `export` subcommand for
`tools/postprocessing/export_elodin_db.sh` to call. The CSV-format bodies the backend does serve are
the state-machine CSVs (`GET /api/state-csv?name=actuators|delays|transitions`); `csv.txt` freezes
those byte for byte (header, column order, cell format).

## Normalisation rules (`normalize.py`, shared — other areas reuse it)

| rule | what is replaced | why |
|---|---|---|
| N1 | numbers under timestamp keys (`timestamp`, `ts`, `tMs`, `lastHeartbeatMs`, `missionStartTime`, `deadlineMs`, …) and **any number within a day of the run's clock** → `<ts>`; ISO datetimes in strings → `<iso>`; run dir names `daq_YYYYMMDD_HHMMSS` → `daq_<stamp>`; epoch-ms digits in strings → `<ts>` | wall clock. Numbers far from now (a countdown target pinned in 2100) stay. |
| N1s | epoch **seconds** within a day of the run's clock under `updatedAt`/`generated_unix`/`createdAt`/`savedAt`, or with a fractional part → `<ts-s>` | calibration_service's cubic store stamps in seconds; whole numbers elsewhere stay (an ADC count can be ~1.8e9) |
| N2 | `remainingMs`, `uptimeMs`, `lifetimeMs` → `<dur>` | elapsed wall time |
| N3 | `freeDiskBytes` → `<bytes>`, `heapUsedMb` → `<mb>`, `ingestHost` → `<lan-name>` | the machine, not the code |
| N4 | absolute paths given by the harness → `<cfgdir>`, `<home>`, `<fx>`, `<daq>` (longest first) | temp dirs, checkout location |
| N5 | the harness's ports, in strings and under keys containing `port` → `<port:name>` | port range is the harness's choice |
| N6 | `pid 1234` → `pid <pid>` | PIDs |
| N7 | UUIDs → `<uuid>` | request/preview ids |

`Normalizer(now_ms, paths, ports).value(obj)` / `.text(s)`; CLI: `normalize.py --context ctx.json`.

## Per-type rules (`characterize.py`, this area only)

| rule | what | why |
|---|---|---|
| P1 | board-health notifications (`board_lost_<id>`, `Board N (T) connected`) are collected as a set over the run, outside the ordered event log | they come from a 1 Hz sweep, not from the step that is running |
| P1b | a reset flap — `board_lost_<id>` raised and cleared again within 2.5 s, plus the "connected" the clearing sweep raises — is not recorded | session start/stop reloads board status from config; whether the next 1 Hz sweep beats the board's next 1 Hz heartbeat (and so reports a board that never stopped as lost) is a race. A board that really stops stays lost and is recorded |
| P2 | no delivery rates or counts of streaming frames are recorded; the one timing property frozen is T1 | delivery depends on scheduling and on the outbox's throttling |
| P3 | `connection_status` `lagMs`/`resolutionPct`/`throttled` → their type | the link's own measurements |
| P4 | `board_status_update` `heartbeatTimes` → `<ts[]>` (or `[]`), `frequencyHz` → `<hz>` | measured |
| P5 | `board_log` sim counter `#N` → `#<n>`, `totals` counts → `<n>` | running counter |
| P6 | a frame belongs to the step it arrived in | |
| P7 | a stream's value is printed when the run saw one value (or a set of ≤4), else `<varies>` | `--low-noise` makes PT raw constant per channel |
| P8 | history: per request, the series keys and the distinct values each carries (not their times or lengths) | lengths depend on uptime |
| P9 | `/stats`, `/api/debug`, `/api/board-logs*` bodies → key/type schema | counters / wall clock |
| P10 | the handshake's self-test replay is regrouped by board id (each board's frames keep their order) | `selfTestLatest` replays in Elodin arrival order, a race across boards |
| P11 | in a run of consecutive `error` / `state_update` frames within a step, errors are recorded first (each kind keeps its own order) | a command's TCP reply (`error`) and the sequencer's Elodin publish (`state_update`) take independent paths; their order swapped under load |
| P12 | self-test results are one line per board the simulators self-test (expected set from `selftest_expected.py`: adc_good + every active connector; board 60: 0 and 2), written as `<exact result> | not-received (one-shot UDP self-test, defect)`, and a rule line that fails if (a) a received result differs, (b) more than half the boards are not-received, or (c) the run is quiet (`CHAR_UNDER_LOAD` unset) and any board is not-received. The handshake replay and the history series are summarised there. A connector `selftest_expected.py --fail` names (the selftest session) is expected `0`, and the board's line says `all 1 but sensor_<n> = 0`; without `--fail` nothing changes | on a loaded Linux box some boards' one-shot self-test never reaches the backend |
| P12d | in a quiet run every self-test path must carry every expected board exactly, checked separately: each client's handshake replay (A, B, C) and each full history reply (connect A, the unnarrowed query in `history`, viewer B), with the startup board exempt from paths that closed before it self-tested. A late client C (after the session) freezes the notification-buffer replay; its own backfill is past the 60 s horizon and is not frozen | the old golden froze each path line by line |
| P14 | `GET /api/debug?values`: P9's schema, plus the values of `ingestConnected`, `useRelay` and `wsClients` (rendered `>=1` when at least one client is connected, else the number) | D64(3): these say how the backend is wired, not how much it has counted; the plain `/api/debug` line stays P9 |
| A1 | `ACT_CMD.B2.CH7` (Fuel Main) commanded: `{0} \| {0, 1}`, an explicit alternative, only for that series | the sequencer's boot-time de-energized row is replayed by elodin-db on subscribe on a loaded Linux box (defect) |
| P13 | a step's `notes` (lines the session derives from its own `Sent.t` / `Frame.t` stamps) are printed under the step in `ws_events.txt` as `= <text>`, categorical only (`…: yes` / `no`), never a raw ms. Only `holds` writes any; a capture without the key prints nothing | a measured latency drifts; whether it met a bound derived from a config/spec value does not |

P7 also applies to history series (more than four distinct values → `<varies>`).

### Timing bounds (from config or spec, never observed values)

| bound | how | assumption |
|---|---|---|
| T1 | the 10 s `query_historical` of `PT1.CH1.raw_adc_counts`: median spacing of consecutive points within [0.9 W, 2 W], W = 2000 / `[gui] points_per_second` (4 → 500 ms) | the envelope (`gui-stream.ts`) opens a window at a sample and closes it at the first sample ≥ W later, emitting a constant stream's window at its first sample time; samples come every 100 ms (sim 10 Hz). Measured on sample timestamps, so load cannot move it |
| T2 | `holds` `sequencer_stalled`: the `State transition failed: timeout` error frame arrives ≤ 2800 ms after the command was sent (`= timeout_reply_within_2800ms: yes`) | `sequencer-client.ts sendToSequencer` `socket.setTimeout(2000, …)` plus 800 ms for D34's macOS timer overshoot and the WS hop, below the next round number (a 3000 ms timeout fails). CI-judged (D34, D70) |
| — | `QUIET_MS` 1.5 s / cap 20 s per step | a reply arrives within 20 s on a machine under 1× load |

Determinism (final evidence, commit `d4b56670`):

| platform | pt | nocal | boards |
|---|---|---|---|
| macOS, idle | update + 1 check: same | same | same |
| macOS, 14× `yes` (1-min load 15–28) | 2/2 pass | 2/2 pass | 2/2 pass |
| Linux container (arm64, full-tree export), idle | 3/3 pass | 3/3 pass | 3/3 pass |
| Linux container, 14× `yes` (load 9–12) | 1/2 pass | 1/2 pass | 0/2 pass |

Under load on Linux two races remained. They are frozen as the bounded, named alternatives A1 and P12 above; everything else is exact. `CHAR_UNDER_LOAD=1` must be set by whoever starts the synthetic load (an idle run still requires every self-test).

### Open findings: the boards session under load (Linux)

The `boards` session is required exact only while the load average is below the core count (the
gate's load guard provides that). It is the one named exception to "goldens hold under load";
`pt` and `nocal` must hold under 1× synthetic load on macOS and Linux. Under 1× load (14× `yes`,
1-min load ~11) in the Linux container, two cases remain that no rule covers. They are left red on
purpose:

- **Board 22 partial self-test.** The backend received sensors 0–3 of board 22's self-test and not
  sensor 4. The simulator sends all of a board's results in one packet (and re-sends ~1 Hz for 6 s),
  so a partial set suggests rows lost between the DB and the backend, not a lost packet. P12 rule
  (a) treats a partial board as a mismatch.
- **`PT2.CH1` stream missing** (resolved, D41). In loaded runs the raw (`PT2.CH1.raw_adc_counts`)
  and calibrated (`PT2_Cal.CH1.*`) series of PT board 22, connector 1, were absent from both the
  live stream and history, while the board's other channels arrived; the calibrated three went
  missing once on idle Linux too. Root cause: the slot-10 registration window of board 60 (see
  "Registrars before the backend"), not load. `run.sh` starts the backend only after both
  registrars have finished, so the window cannot be hit; the board-22 case above is still open.
- What is known of the remaining case: it appeared only on Linux under load; macOS under the same
  load passes. It looks like Elodin subscription timing (the backend subscribes in
  request-id-capped passes and retries refused pairs with backoff; rows written before a pair's
  subscription takes effect are never delivered), the same mechanism that lost board 21's
  self-test sensors 2–10 before the harness waited for subscriptions. Not proven: the backend logs
  no per-pair subscription acceptance.

Every golden line removed since `backend-remastered` is accounted for in `GOLDEN-AUDIT.md`.

## Mutation check

Each applied to the backend source, run, reverted (none committed):

| break | where it went red |
|---|---|
| `server.ts` `broadcastStateUpdate`: payload field `stateName` → `state_name` | `ws_events.txt` (every live `state_update`), `ws_schema.txt` |
| `api-server.ts` `/api/feed-char/results` without a session: 409 → 410 | `http.txt` (three requests) |
| `routes/config-profiles.ts` `readStateCsv`: swap the Idle/Armed columns | `csv.txt` (header and every row of all three CSVs) |
| `gui-stream.ts` `envelopeWindowMs`: `2000 /` → `1000 /` (double the GUI rate), run under 1× load | `ws_streams.txt` T1 |
| `server.ts`: drop every SELF_TEST row (`[0x60..0x6F]`), idle and under 1× load (boards) | `ws_streams.txt` P12 rule line: all not-received → (c) idle, (b) under load |
| `elodin-vtable-registry.ts` + `server.ts`: un-mark a subscribed pair the DB has not delivered within 4 s so the next pass re-sends it, and run a pass every `RESUBSCRIBE_MIN_MS` regardless of the refused pairs' backoff (stalesub) | `stalesub.txt`: `PT2_Cal.CH1.*` live `value=…` instead of `absent`, present in the backfill and the query. The first half alone stays green: no pass fell inside the 12 s window (see above) |
| `api-server.ts`: delete the `isConfigWriteAuthorized` check of `POST /api/config/profiles/create` (H8) | `http.txt` `http_viewer_gates`: the viewer's create is 200 with `viewer-made` in the profile list, and the witness `GET /api/config/profiles` lists it too |
| `server.ts`: `const isOp = true` at the WS upgrade (every client an operator) (H8) | `ws_handshake.txt` (client B `control_status` `operator: true`), `ws_events.txt` `viewer_client` (`control_unlock_result` `ok`, then B's `state_transition` reaches the sequencer) |
| `server.ts`: `const isOp = authEmail === '' ? true : false` at the WS upgrade (every non-empty header a viewer) (H8b) | `operator/ws_handshake.txt` (client A `control_status` `operator: false`), `operator/ws_events.txt` `unlock` (`control_unlock_result` `not_operator`). pt, nocal, boards, stalesub stay green: no other session sends an operator's header over WS |
| `server.ts`: `const op = false` in the `CONTROL_UNLOCK` handler (unlock always refuses) (H8b) | `operator/ws_events.txt` `unlock` (`not_operator`); also the pt session, from its `unlock` step (client A, no header) through everything A does armed after it (`ws_events.txt`, `http.txt`: no session ever starts) |
| `sequencer-client.ts` `sendToSequencer`: the reply predicate `reply === 'OK' \|\| reply.startsWith('OK:')` → `reply === 'OK'` (holds) | `golden/holds/ws_events.txt` `hold_accepted`: one new line, `error` "State transition failed: OK:800" |
| `sequencer-client.ts` `sendToSequencer`: `socket.setTimeout(2000, …)` → `3000` (holds) | `golden/holds/ws_events.txt` `sequencer_stalled`: `= timeout_reply_within_2800ms: no` |
| `sequencer-client.ts` `sendToSequencer`: `done(false, err.message)` → `done(false, 'connect error')` (holds) | `golden/holds/ws_events.txt` `sequencer_down`: the `ECONNREFUSED` error text |
| `api-server.ts` `/api/engine_state`: answer 1 regardless of `getEngineState` (D64(3)) | `http.txt` `transition_armed`: `{"engineState": 2}` becomes "same as the earlier identical request" |
| `server.ts` `getDebugInfo`: `ingestConnected: false` (D64(3)) | `http.txt`: all three `GET /api/debug?values` lines (P14 values) |
| `api-server.ts` `POST /api/config`: save the profile but never `deployActiveProfile()` (H1) | `http.txt` `http_operator_writes`: `FILE config/config.toml` is the old deployed file, the profile's no longer "same as" it, and every later FILE that copied it moves |
| `server.ts` `applyDeployedConfigChange`: drop its `CONFIG_UPDATED` broadcast (H1) | `ws_events.txt` `http_operator_writes`: four of the five `config_updated` frames gone (the CSV write's own broadcast stays), and `session_start_forced`'s |
| `server.ts`: swap the startup rows `loadBoardsFromConfig()` and the `STATE_ACTUATOR_MAP` read (G12) | `startlog/backend_startup.txt`: `Loaded 11 boards` moves below the `Trying:` lines |
| `server.ts`: `parsed.value === 0` → `=== 2` in the self-test block (never notify) (G2) | `selftest/ws_handshake.txt`: client A's replay loses `self_test_fail_21`; `ws_schema.txt` loses the notification key |
| `sim/board_simulator.py`: `adc_good = 0`; the result byte always 1 (the flag ignored) | `sim_selftest_check.py` (run first by `run.sh selftest`): default bytes differ / the flag changes no byte |
| `server.ts` `loadBoardsFromConfig`: accept `board.id` as the board id (G3) | `unrecognized/ws_handshake.txt`: board 21 listed `expected: true` at `127.0.0.1`, no `unrecognized_21` replay; `ws_streams.txt` `board_status_update` payloads |
| `server.ts`: drop the `scheduleActuatorMismatchCheck` in the `position_pct` block (the reschedule on a sensed change) (G1) | `mismatch/ws_events.txt` `valve_close`: no `Actuator positions match expected` |
| `ball-valve.ts` `ballValveSensedEntity` → `null` (no ball valve is ever sensed) (G1) | `mismatch/ws_events.txt`: neither `actuator_mismatch` frame; `ws_schema.txt` loses the notification keys |
| `server.ts`: reply an `error` from the WS `Bad message` catch (G10) | `ws_events.txt` `subscribe`: two `error` frames (the non-JSON line and the payload-less `send_command`) |
| `server.ts` `onStateCsvUpdated`: drop the `STATE_ACTUATOR_MAP` rebuild (G8) | `statecsv/ws_handshake.txt`: client B's `ACT_CMD.B2.CH2` snapshot stays `0` |
| `server.ts` `onStateCsvUpdated`: drop the `config_updated` broadcast (G8) | `statecsv/ws_events.txt` `state_csv_deploy`: no frame |

## Frozen behaviour that looks like a defect (recorded, not fixed)

- A heartbeating board the backend's config does not list is created with an invented address,
  `192.168.2.<id>` (`updateBoard`), which is what `unrecognized_<id>`'s "Unrecognized board at …"
  then names; on a stand whose boards are not on that subnet the message points at the wrong
  host (the `unrecognized` session).
- Session start and stop reload board status from config (`applyDeployedConfigChange` /
  `onStopped` → `loadBoardsFromConfig`), so a board that is heartbeating can be reported
  "connection lost" and then "connected" a second later (P1).
- In mock mode the run's `dbDir` is never created, so `POST /api/feed-char/results` during a
  session answers 500 `ENOENT`.
- `debug_mode` produces two identical `state_update`s (the TCP-reply path and the Elodin path).
- The state-CSV loaders `join()` `[state_machine]` paths onto fixed directories, so an
  absolute path in config is never found (`get_state_transitions` → `[]`, no commanded snapshot).
- `GET /api/state-script?name=<missing>` is 200 with an empty source; `PUT /api/video/config` with
  no `revision` is 409 "changed since you opened Edit".
- `sensor-backend.service` runs `npm run dev`, i.e. `tsx watch`, in production.
