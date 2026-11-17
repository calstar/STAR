# pipeline/ — the whole stack, frozen at its WebSocket and HTTP edge

```bash
bash test/characterization/pipeline/run.sh             # all three sessions
bash test/characterization/pipeline/run.sh pt          # one routed PT board, the full script → golden/
bash test/characterization/pipeline/run.sh nocal       # the backend with no PT calibration file → golden/nocal/
bash test/characterization/pipeline/run.sh boards      # every simulated board type → golden/boards/
CHAR_UPDATE=1 bash test/characterization/pipeline/run.sh   # rewrite goldens (main's behaviour only)
```

`run.sh` takes the stack lock itself (re-entrant under `gate.sh` / `characterization/run.sh`) and
refuses to run on the stand. Without a git repository (a `git archive` export, a deployed stand)
it names the lock `$TMPDIR/daq-stack.lock` instead of asking git; nothing else in the harness or the
stack calls git. Once it holds the lock: pt ~75 s, nocal ~20 s, boards ~40 s. Env:
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
  fixture, not the checkout: its PT calibration (`calibration.ts`: `srv/calibration/*.json`, the
  newest by mtime), `/api/cubic_calibration` (`srv/scripts/calibration/calibrations`, the
  fixture's store), the legacy state-CSV loaders (`srv/../config` — the fixture's), the
  state-script checker (`srv/build`). The source is copied unchanged at every run, so an edit to
  `diablo_server/backend/src` is what runs. pt and boards put exactly one file in
  `srv/calibration/` (`calibration_2026-02-25T03-44-09.json`, chosen by name); nocal puts none.
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

- **Backend PT calibration.** `calibration.ts loadPTCalibration` takes the newest
  `daq-server/calibration/calibration*.json` **by mtime**, and all 13 are committed. A checkout or
  `git archive` gives them one mtime, so the pick was directory order: macOS got
  `calibration_2026-02-25T03-44-09.json`, a Linux export a file with no coefficients
  (`calibrationFilePath: null`). The backend honours no override for this path, so the fixture
  gives it its own copy of the source and a calibration directory it controls (above). The
  file-present case is the pt session, the file-absent case the nocal session. The search itself
  is a defect: the calibration a backend loads depends on filesystem order.
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

## The scripted session (`session.ts`)

GET sweep → connect A → 3 s live → viewer client B (`X-Auth-Email`, not an operator) → unknown `subscribe`, non-JSON, `get_state_transitions` →
four `query_historical` shapes → control commands while locked → `control_unlock` → locally
rejected transitions (unknown id, bad hold) → a transition the sequencer refuses (Idle→Fire) →
Idle→Armed → debug on → actuator open/close/unknown → debug off → `extend_fire` outside Fire →
Armed→Idle → countdown set/clear → a
calibration command → an unsupported command → `session_start` (blocked, forced, again) → GET
sweep during the session + session POSTs → `session_extend` (good, bad) → `session_stop` (twice) →
HTTP error shapes → disconnect.

**Timing.** A step that sends something lasts its nominal time and then until the event stream
(everything but the streams and board-health notifications) has been quiet for `QUIET_MS` = 1.5 s,
capped at 20 s, so a reply that a loaded machine delivers late still lands in its own step. The
viewer client connects ~10 s after the first sample, well inside the backend's 60 s connect
backfill horizon (`history-backfill.ts HISTORY_CONNECT_SPAN_MS`); at ~60 s, where it used to be,
whether the one-shot self-test series made the cut depended on the machine's speed.

There is no subscription protocol in the thin backend (every client gets every stream); the
`subscribe` step records that an unknown message type gets no reply.

## Goldens

| file | what |
|---|---|
| `ws_handshake.txt` | each client's connect burst, in order (`server.ts` `wss.on('connection')`) |
| `ws_events.txt` | per step: what was sent (`>`) and every event-like frame back (`<`), in arrival order |
| `ws_streams.txt` | the streaming types: channel set and value where the sim fixes it; the timing bound T1; distinct normalised payloads of the periodic types; history series per request |
| `ws_schema.txt` | every key path of every message type, with the JSON types seen |
| `http.txt` | every request: status, content-type and the headers that matter, normalised body |
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
| P12 | self-test results are one line per board the simulators self-test (expected set from `selftest_expected.py`: adc_good + every active connector; board 60: 0 and 2), written as `<exact result> | not-received (one-shot UDP self-test, defect)`, and a rule line that fails if (a) a received result differs, (b) more than half the boards are not-received, or (c) the run is quiet (`CHAR_UNDER_LOAD` unset) and any board is not-received. The handshake replay and the history series are summarised there | on a loaded Linux box some boards' one-shot self-test never reaches the backend |
| P12d | in a quiet run every self-test path must carry every expected board exactly, checked separately: each client's handshake replay (A, B, C) and each full history reply (connect A, the unnarrowed query in `history`, viewer B), with the startup board exempt from paths that closed before it self-tested. A late client C (after the session) freezes the notification-buffer replay; its own backfill is past the 60 s horizon and is not frozen | the old golden froze each path line by line |
| A1 | `ACT_CMD.B2.CH7` (Fuel Main) commanded: `{0} \| {0, 1}`, an explicit alternative, only for that series | the sequencer's boot-time de-energized row is replayed by elodin-db on subscribe on a loaded Linux box (defect) |

P7 also applies to history series (more than four distinct values → `<varies>`).

### Timing bounds (from config or spec, never observed values)

| bound | how | assumption |
|---|---|---|
| T1 | the 10 s `query_historical` of `PT1.CH1.raw_adc_counts`: median spacing of consecutive points within [0.9 W, 2 W], W = 2000 / `[gui] points_per_second` (4 → 500 ms) | the envelope (`gui-stream.ts`) opens a window at a sample and closes it at the first sample ≥ W later, emitting a constant stream's window at its first sample time; samples come every 100 ms (sim 10 Hz). Measured on sample timestamps, so load cannot move it |
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

## Frozen behaviour that looks like a defect (recorded, not fixed)

- Session start and stop reload board status from config (`applyDeployedConfigChange` /
  `onStopped` → `loadBoardsFromConfig`), so a board that is heartbeating can be reported
  "connection lost" and then "connected" a second later (P1).
- In mock mode the run's `dbDir` is never created, so `POST /api/feed-char/results` during a
  session answers 500 `ENOENT`.
- `debug_mode` produces two identical `state_update`s (the TCP-reply path and the Elodin path).
- The legacy state-CSV loaders `join()` `[state_machine]` paths onto fixed directories, so an
  absolute path in config is never found (`get_state_transitions` → `[]`, no commanded snapshot).
- `/api/cubic_calibration` ignores `DAQ_CALIBRATIONS_DIR`; the backend's own PT calibration and
  `calibration_status.calibrationFilePath` come from `daq-server/calibration/*.json` via `__dirname`.
- `GET /api/state-script?name=<missing>` is 200 with an empty source; `PUT /api/video/config` with
  no `revision` is 409 "changed since you opened Edit".
- `sensor-backend.service` runs `npm run dev`, i.e. `tsx watch`, in production.
