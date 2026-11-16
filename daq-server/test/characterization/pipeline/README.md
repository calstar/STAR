# pipeline/ — the whole stack, frozen at its WebSocket and HTTP edge

```bash
bash test/characterization/pipeline/run.sh             # both sessions: pt → golden/, boards → golden/boards/
bash test/characterization/pipeline/run.sh pt          # one routed PT board, the full scripted session
bash test/characterization/pipeline/run.sh boards      # every simulated board type at once
CHAR_UPDATE=1 bash test/characterization/pipeline/run.sh   # rewrite goldens (main's behaviour only)
```

`run.sh` takes the stack lock itself (re-entrant under `gate.sh` / `characterization/run.sh`),
refuses to run on the stand, and takes ~50 s once it holds the lock (waiting for the lock can take far longer on a busy machine). Env: `CHAR_BUILD_DIR`
(default `build-gate/`, then `build/`), `ELODIN_DB` (an elodin-db binary; default
`~/.cargo/bin/elodin-db`), `CHAR_KEEP=1` (keep `.tmp/char_pipeline_<pid>/` with every service log),
`CHAR_CAPTURE_ONLY=<file>` (save the raw capture, skip the comparison), `CHAR_HOLD=<s>` (bring the
stack up and leave it for poking).

## What runs

`sim/board_simulator.py --low-noise --skip-startup` → `daq_bridge` → `elodin-db` →
`calibration_service` → `diablo_server/backend/src/server.ts` (the thin backend; production's
`sensor-backend.service` runs the same file via `npm run dev` with `SESSION_SERVICE_MODE=systemd`)
→ WebSocket + HTTP on one port. `sequencer_service` sits behind the backend's command path (TCP).
Start order and readiness waits are `test/test_integration.sh`'s: DB, sequencer, bridge, backend,
calibration, simulator; then `session.ts` waits until a probe client sees a raw and a calibrated PT
sample and lets it settle 3 s.

`api-server.ts` is not a separate server: `createAPIHandler()` is mounted inside `server.ts`'s HTTP
server and owns every `/api/*` path (with `video/routes.ts` for `/api/video/*`); `/stats` is
`server.ts`'s own. Every route registered by those three files is exercised (all GETs, plus the
POST/PUT/DELETE paths a session uses and their 4xx shapes). The two 404 shapes differ: a non-`/api`
path gets a bare 404 with no body or content-type, an unknown `/api/*` path gets
`{"error":"Not found"}`.

**elodin-db must be 0.16.1** (the CI / `setup.sh` / `bootstrap_daq.sh` pin). `run.sh` refuses any
other version: 0.14.2 answers this stack with `VTableNotFound` / `InvalidMsgId` and delivers no data
at all, which would freeze a dead pipeline. The goldens were recorded with the released 0.16.1
binary.

## Isolation — nothing in the checkout is touched

`make_fixture.py` builds `.tmp/char_pipeline_<pid>/`:

- `config/config.toml` — `config/config_base.toml` with every `192.168.2.` rewritten to
  `127.0.0.` (what `service-controller.ts ensureSimConfig()` does), every port moved to 264xx,
  `[gui]` pinned to envelope @ 4 pts/s (as `test_integration.sh` does), `[heartbeat_service]` off
  (the bridge sends SERVER_HEARTBEAT itself). `[state_machine]` keeps production's relative
  `config/*.csv` paths, with the CSVs copied beside it. It is also the backend's `CONFIG_PATH`, so
  `profiles/`, `.active_profile`, `countdown_state.json`, `session_state.json` and `video.json`
  all land beside it.
- `char/backend/` — the backend's cwd. Its legacy state-CSV loaders look in `<cwd>/../../config`,
  exactly as from `diablo_server/backend`. (An absolute `transitions_csv` is not equivalent: those
  loaders `join()` it onto other directories and never find it.) Because they try
  `daq-server/config/*.csv` via `__dirname` first, `run.sh` refuses to run if a deployed copy
  exists there.
- `firmware/Hotfire_Code/` — a fixed PlatformIO tree. The OTA project search
  (`ota-build.ts discoverProjects`) walks up from the backend's cwd to the first
  `firmware/Hotfire_Code`; this one is found before the repo's, which the Linux gate's
  `git archive` export does not contain and which changes with every firmware project.

### Platform neutrality (macOS and Linux produce the same goldens)

- **Backend PT calibration.** `calibration.ts loadPTCalibration` takes the newest
  `daq-server/calibration/calibration*.json` by mtime. Checked-out (and `git archive`d) files share
  one mtime, so the pick fell to directory order: macOS got `calibration_2026-02-25T03-44-09.json`,
  Linux a file with no coefficients (`calibrationFilePath: null`). `run.sh` sets each committed
  file's mtime to the timestamp in its name (content untouched), so both pick the newest by name.
  The unpinned behaviour is a defect: the backend's calibration depends on filesystem order.
- **Self-test results.** The simulator sends each board's SELF_TEST once, at start; the backend
  subscribes to the self-test tables over several request-id-capped passes, and a result
  published before its pass is lost (Linux lost board 21's sensors 2-10). `run.sh` starts the
  simulator only after a subscription pass with nothing left queued.
- `scripts/calibration/calibrations/` — the committed store minus `cubic_calibration.json`,
  `lc_tare.json` and `adjustments.json`. Every C++ service runs with `cwd` = the fixture (all their store
  paths are relative); the backend gets `DAQ_CALIBRATIONS_DIR`. The live JSONs are never parked.
- `home/` — the backend's `HOME`, so session run dirs (`~/.local/share/elodin/daq_*`) stay inside.
- Also pinned: `GUI_PORT=0`, `SESSION_SERVICE_MODE=mock`, `DAQ_OPERATORS_FILE` (one operator),
  `STAR_DHCP_HOSTS` (absent), the video gateway/agent on unused 264xx ports.

Ports: elodin 26401, sensor UDP 26402, backend 26403, actuator UDP 26404, board logs 26405,
sequencer 26406, controller 26407, heartbeat UDP 26408, video 26411-13, OTA 26414. daq_bridge also
hard-codes UDP 5008, which is why the lock matters.

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
`sim/board_startup_sim.py` through SETUP → SENSOR_CONFIG (from `config_broadcast_service`, which
this session also runs) → SELF_TEST, after which it goes silent and is reported lost. The LabJack
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

GET sweep → connect A → 3 s live → unknown `subscribe`, non-JSON, `get_state_transitions` →
four `query_historical` shapes → control commands while locked → `control_unlock` → locally
rejected transitions (unknown id, bad hold) → a transition the sequencer refuses (Idle→Fire) →
Idle→Armed → debug on → actuator open/close/unknown → debug off → `extend_fire` outside Fire →
Armed→Idle → countdown set/clear → a calibration command → an unsupported command →
`session_start` (blocked, forced, again) → GET sweep during the session + session POSTs →
`session_extend` (good, bad) → `session_stop` (twice) → viewer client B (`X-Auth-Email`, not an
operator) → HTTP error shapes → disconnect.

There is no subscription protocol in the thin backend (every client gets every stream); the
`subscribe` step records that an unknown message type gets no reply.

## Goldens

| file | what |
|---|---|
| `ws_handshake.txt` | each client's connect burst, in order (`server.ts` `wss.on('connection')`) |
| `ws_events.txt` | per step: what was sent (`>`) and every event-like frame back (`<`), in arrival order |
| `ws_streams.txt` | the streaming types: channel set, value where the sim fixes it, rate class; distinct normalised payloads of the periodic types; history series per request |
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
| P1 | board-health notifications (`board_lost_<id>`, `Board N (T) connected`) are collected as a set over the run, outside the ordered event log | a 1 Hz stale sweep races the boards' 1 Hz heartbeat; whether a status reset (session start/stop reloads boards from config) shows as "connection lost" depends on which fires first |
| P2 | stream rates are classes: event (<0.25/s), stream (0.25-5/s), fast (>5/s) | counts depend on scheduling and on the outbox's own throttling |
| P3 | `connection_status` `lagMs`/`resolutionPct`/`throttled` → their type | the link's own measurements |
| P4 | `board_status_update` `heartbeatTimes` → `<ts[]>` (or `[]`), `frequencyHz` → `<hz>` | measured |
| P5 | `board_log` sim counter `#N` → `#<n>`, `totals` counts → `<n>` | running counter |
| P6 | a frame belongs to the step it arrived in | |
| P7 | a stream's value is printed when the run saw one value (or a set of ≤4), else `<varies>` | `--low-noise` makes PT raw constant per channel |
| P8 | history: per request, the series keys and the distinct values each carries (not their times or lengths) | lengths depend on uptime |
| P9 | `/stats`, `/api/debug`, `/api/board-logs*` bodies → key/type schema; `/api/cubic_calibration` → sha256 + keys (it reads the committed store via `__dirname`, ignoring `DAQ_CALIBRATIONS_DIR`) | counters / wall clock |
| P10 | the handshake's self-test replay is regrouped by board id (each board's frames keep their order) | `selfTestLatest` replays in Elodin arrival order, a race across boards |

P7 also applies to history series (more than four distinct values → `<varies>`).

Determinism: `CHAR_UPDATE=1` followed by two comparison runs, back to back, all identical; five
earlier captures (before the fixture-cwd change) were identical to each other under the same rules.
No rule beyond P1-P9 / N1-N7 was needed.

## Mutation check

Each applied to the backend source, run, reverted (none committed):

| break | where it went red |
|---|---|
| `server.ts` `broadcastStateUpdate`: payload field `stateName` → `state_name` | `ws_events.txt` (every live `state_update`), `ws_schema.txt` |
| `api-server.ts` `/api/feed-char/results` without a session: 409 → 410 | `http.txt` (three requests) |
| `routes/config-profiles.ts` `readStateCsv`: swap the Idle/Armed columns | `csv.txt` (header and every row of all three CSVs) |

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
