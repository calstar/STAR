# DESIGN-WP6 — split `diablo_server/backend/src/server.ts`

The WP6 design as decided (LEDGER D39, D40, D42-D44, D48, and the simplicity rulings of D49 and
D51). It says what an implementer must do and why. Design only: nothing here has been executed.
Paths are relative to `daq-server/diablo_server/backend/src/` unless stated. How the design got
here — the amendments A1-A10, struck text, superseded baselines and checks, the debate, the
alternatives, the walkthroughs — is in `debates/WP6/history.md`.

**Baseline.** Line numbers are `server.ts` on `backend-remastered` @ `bcb96252` (blob `646524ff`,
1885 lines; the same blob as at `b2599617`), re-verified against
`git show backend-remastered:daq-server/diablo_server/backend/src/server.ts`. WP6 runs after
WP5, which moves `server.ts:1409-1467` out (`sendToActuatorService` becomes `sendToSequencer` in
`sequencer-client.ts`, which owns `SEQUENCER_PORT`; the dead `sendToControllerService` is
deleted), renames `legacy/` → `state-csv/` and adds `boardSlot()` to `sensor-config.ts`. Lines
after 1467 then move up by about 59. **Locate code by the section banners (`// ── … ──`) and
symbol names; use line numbers only to orient.** Below, `sendToSequencer` and `state-csv/` are
the post-WP5 names.

**Prerequisites.** C1 and WP5 merged on `backend-remastered`; `npx tsc --noEmit` in
`diablo_server/backend/` is a merge-gate step (D40); the gaps of §7 that guard a step exist
before it.

**Contract (frozen, D5/D17):** everything in §6.5, plus TCP :9998 command lines and reply
handling, Elodin subscriptions and the `src/server.ts` entrypoint path.

**Shape.** `server.ts` is cut into 16 modules under `src/server/`, one owner per piece of state,
state shared as module singletons, the imports a layered DAG, and `server.ts` left as the
composition root that runs today's startup sequence statement by statement. Step 1 moves code
only; step 2 is a short list of cleanups. They are **separate queue items, each fully gated**.

---

## 1. Current responsibilities

`server.ts` is the backend process: WebSocket + HTTP on :8081 (`/api/*` delegated to
`api-server.ts`, WP7), the Elodin DB client, the TCP client to the sequencer (:9998), and the
static GUI on `GUI_PORT`. §6.1's table maps each line range that moves to its module.

### 1.1 Shared mutable state — owner after the split, and who reads/writes it today

R = read, W = write (assignment, or mutation of a Map/Set/object).

| state | declared | W | R | owner after split |
|---|---|---|---|---|
| `history` | 122 | 214, 224, 462 (`record`), 129 (`prune`) | 798, 1176 | `server/history.ts` |
| `stats` | 740 | 215, 225, 463, 1708, 1774, 1781, 1783 | 611, 796, 882 | `server/stats.ts` |
| `clientStreams` | 209 | 984 (set), 953, 1121 (delete) | 226, 235, 279, 793, 1559 | `server/ws-clients.ts` |
| `wss` | 901 | — | 611, 791, 797, 905-907, 946-949, 1002, 1134, 1568 | `server/ws-clients.ts` |
| `wsConnCounter` | 902 | 965 | 965 | `server/ws-connection.ts` |
| `guiStreamConfig`, `envelope`, `encoderEnvelope` | 133-135 | 172-174 | 287, 290, 1798, 1808 | `server/sensor-stream.ts` |
| `broadcastLastTime` | 127 | 1802 | 1800 | `server/sensor-stream.ts` |
| `firstPacketTimeMs` | 297 | 1766 | 1022-1025, 1768-1770 | `server/mission-time.ts` |
| `countdownTargetMs` | 299 | 1361 | 1032, 1362-1363 | `server/mission-time.ts` |
| `ptCalibration`, `calibrationPoints`, `lastRawAdc`, `ptCalibrationFilePath` | 307-310 | 316-317, 1761; `calibration-handler.ts` via host | via `calibrationHost` | `server/calibration-state.ts` |
| `calChannelToEntityMap`, `calibrationHost` | 325, 375 | 852-853, 1589 (`.elodin`) | 826, 1226, 1878 | `server/calibration-state.ts` |
| `_hpBoardNumbers`, `_t7CalFields` | 329, 331 | 856, 857 | 1661 | `server/config-caches.ts` |
| `_ptSlotToBoardId` | 334 | 345 (lazy fill), 854 (clear) | 371 | `server/config-caches.ts` |
| `_t7SlotToBoardId` | 351 | 360 (lazy fill in `uniqueIdFromPtEntity`), 577 (lazy fill in `noteT7Alive`), 855 (clear) | 363, 580 | `server/config-caches.ts` — one owner, two lazy fillers until 2.4 |
| `boardsStatus` | 388 | 406, 547, 549-555, 588-592, 667, 925, 930 | 416, 537, 585, 664, 920, 1052, 1681 | `server/board-status.ts` |
| `t7LastMark`, `hbDiagCount`, `prevConnectedState`, `boardFirstSeenSetupMs` | 573, 598, 625, 626 | inside board-status functions | same | `server/board-status.ts` |
| `selfTestLatest`, `selfTestNotifiedBoards` | 631, 628 | 1677, 1680 | 1078-1083 | `server/board-status.ts` |
| `activeNotificationKeys` | 627 | 512-515, 678-716, 1690 | 1736, 1747 | `server/notifications.ts` |
| `notificationBuffer` | 637 | 641-643, 649 | 1092-1097 | `server/notifications.ts` |
| `STATE_ACTUATOR_MAP` | 430 | 817, 861 | 438, 455, 1060 | `server/engine-state.ts` |
| `currentState`, `debugMode` | 774-775 | 1710-1711, 1346 | 786, 1046, 1060, 1263, 1698, 1713-1714, 1737, 1748 | `server/engine-state.ts` |
| `allowedBitmask`, `stateRefusalReasons` | 1237, 1239 | 1703, 1255 | 1263 | `server/engine-state.ts` |
| `actuatorSensedState`, `actuatorMismatchTimer` | 476, 478 | 1733-1735, 1745, 481-483 | 496 | `server/actuator-mismatch.ts` |
| `elodin` | 1471 | (client internals) | 795, 1507, 1547, 1589, 1839-1843, 1873, 1880 | `server/elodin-link.ts` |
| `resubscribeTimer` | 1489 | 1504-1506, 1587, 1629 | — | `server/elodin-link.ts` |
| `lastIngestMs` | 737 | 1627, 1775 | 1549 | `server/elodin-link.ts` |

Process-wide singletons used but not owned here, left where they are: `sessionManager`, the vtable
registry's subscription state, board-scan rates, LC tares, ball-valve endpoints, DHCP status,
board logs.

### 1.2 Startup effects, in order (the module body is the startup sequence)

The last column is the statement `server.ts`'s top level holds for the row after step 1 (and
after step 2): read top to bottom, one statement per line, it is the **target list** of the
startup-order check (§6.3). "—" = no line of its own.

| # | today | effect | after step 1 |
|---|---|---|---|
| 0 | 24-57, 298-303 | import evaluation (`state-csv/state-actuators.ts` reads config at import and can log; `session-manager.ts` constructs `sessionManager`) | — (R1) |
| 1 | 129 | history prune, 60 s | `setInterval(pruneHistory, 60_000);` |
| 2 | 133-137 | read `[gui]`, build both envelopes, log `GUI downsampling` | `initGuiStream();` |
| 3 | 233 | outbox drain + link status, 100 ms | `setInterval(flushClientOutboxes, 100);` |
| 4 | 278 | outbox stats reset, 10 s | `setInterval(resetOutboxStats, 10_000);` |
| 5 | 285 | envelope flush, 50 ms | `setInterval(flushEnvelopes, 50);` |
| 6 | 299 | read countdown target | `initMissionTime();` |
| 7 | 313-320 | `loadPTCalibration()`, log | `initCalibrationState();` (with row 8's role map and row 9) |
| 8 | 325, 329, 331 | HP board set, T7 cal fields (config reads); the sensor-role map (325) belongs to `initCalibrationState()` (row 7, see Call order in §6.1) | `initConfigCaches();` |
| 9 | 375 | `calibrationHost` (pure) | — (inside `initCalibrationState()`) |
| 10 | 422 | `loadBoardsFromConfig()`, log | `loadBoardsFromConfig();` |
| 11 | 430 | `getStateActuatorMap()` (CSV read, logs; a throw kills the process — the crash guards are not yet installed) | `reloadStateActuatorMap();` |
| 12 | 599 | diagnostics log, 5 s | `setInterval(logDiagnostics, 5000);` |
| 13 | 724 | stale sweep, 1 s | `setInterval(markStaleBoards, 1000);` |
| 14 | 753 | `stats.startTimeMs = Date.now()` (the `uptimeMs` origin) | `initStats();` |
| 15 | 774 | `configBootStateId()` (config read) | `initEngineState();` |
| 16 | 781-782 | `new VideoService()` (reads `video.json`), `video.start()` | `video.start();` |
| 17 | 784 | `createAPIHandler(…)` | — |
| 18 | 876, 901 | `http.createServer`, `new WebSocketServer({ server })` | `attachWebSocketServer(httpServer);` |
| 19 | 938 | `startDhcpStatusPoller()` | `startDhcpStatusPoller();` |
| 20 | 939 | board status, 1 s | `setInterval(broadcastBoardStatus, 1000 / BOARD_STATUS_HZ);` |
| 21 | 948 | keepalive, 30 s | `setInterval(reapUnresponsiveClients, KEEPALIVE_MS);` |
| 22 | 964 | `wss.on('connection')` | `wss.on('connection', handleConnection);` |
| 23 | 1471 | `new ElodinClient(…)` (pure) | — (top level of `elodin-link`) |
| 24 | 1581 | connection status, 1 s | `setInterval(broadcastConnectionStatus, 1000);` |
| 25 | 1583 | `elodin.on('connected')` | `elodin.on('connected', onElodinConnected);` |
| 26 | 1608 | script status, 15 s | `setInterval(refreshScriptStatus, 15000);` |
| 27 | 1614-1637 | `elodin.on('dbError' / 'disconnected' / 'error' / 'packet')` | `elodin.on('dbError', onElodinDbError);` `elodin.on('disconnected', onElodinDisconnected);` `elodin.on('error', onElodinError);` `elodin.on('packet', handleElodinPacket);` |
| 28 | 1823-1829 | crash guards | `process.on('uncaughtException', (err) =>` `process.on('unhandledRejection', (reason) =>` |
| 29 | 1848 | `httpServer.on('error')` (EADDRINUSE → retry 3 s) | `httpServer.on('error', (err: NodeJS.ErrnoException) =>` |
| 30 | 1858-1859 | `startGuiStaticServer(GUI_PORT)` | `startGuiStaticServer(GUI_PORT);` |
| 31 | 1861-1885 | `listen` → logs, `sessionManager.init(…)`, `syncElodinToSession()`, `startBoardLogReceiver(broadcast)` | `httpServer.listen(WS_PORT, () =>` (callback verbatim) |

Three timers share the 1000 ms period: 13, 20, 24. Node fires same-period timers in registration
order, so within one second the board-health notifications precede the `board_status_update`,
which precedes the `connection_status`. That order is on the wire (G11).

---

## 2. Target module boundaries

New directory `src/server/`. `src/server.ts` stays the entrypoint (systemd `npm run dev`,
`pipeline/run.sh:200`, `test_integration.sh:834`, `test/environmental-recovery.integration.ts:97`).

**Rule M1 — no import-time effects in `server/*`** (STYLE-S30). A `server/*.ts` module's top
level holds only imports, types, constants computed from `process.env`, literals or
`import.meta.url`, pure constructors (`new Map`, `new HistoryCache(…)`, `new ElodinClient(…)`)
and function declarations. Every disk read, clock read, log line, timer, listener and socket open
happens in a function that `server.ts` calls. M1 covers the top level of `server/*` files only,
not their transitive imports: `state-csv/state-actuators.ts` reads config and can log **at
import** (`:79-81`), and `session-manager.ts` constructs `sessionManager` at import, so a vitest
whose closure contains them supplies a config fixture (`TESTING-NOTES.md`).

**Rule M2 — the import graph is a DAG** (STYLE-S31). Each layer imports only from lower layers.
ESM tolerates cycles at import, but a cycle becomes a TDZ `ReferenceError` the moment a `const`
is read during evaluation — exactly the startup-order failure this split must not introduce.

| layer | module | single responsibility | public interface |
|---|---|---|---|
| 0 | `server/env.ts` | the process's environment knobs, read once | `WS_PORT`, `GUI_PORT`, `ELODIN_HOST`, `ELODIN_PORT`, `THIN_VERBOSE_CONNECTION_LOG`, `THIN_HEARTBEAT_DIAG_LOG`, `THIN_STATS_LOG` (the :9998 port is WP5's `SEQUENCER_PORT`) |
| 0 | `server/stats.ts` | ingest/broadcast counters served by `/stats` and `/api/debug` | `stats`, `initStats()` |
| 1 | `server/ws-clients.ts` | the browser-facing socket set: send, broadcast, per-client sensor outboxes, link status, keepalive reaping | `WsWithControl`, `ClientStream`, `wss` (live binding), `attachWebSocketServer(server)`, `broadcast(msg)`, `send(ws, msg)`, `clientStreams`, `clientStreamStatus(ws)`, `flushClientOutboxes()`, `resetOutboxStats()`, `reapUnresponsiveClients()`, `KEEPALIVE_MS` |
| 2 | `server/notifications.ts` | operator notifications and their 5-minute replay buffer | `activeNotificationKeys`, `notificationBuffer`, `pruneNotificationBuffer(now)`, `broadcastNotification(payload)`; step 2: `raiseNotification(payload)`, `clearNotification(payload)` |
| 2 | `server/history.ts` | the rolling history cache and the backfill sent from it | `history`, `pruneHistory()`, `sendHistoricalData(ws, query?, onSent?)` |
| 2 | `server/mission-time.ts` | mission T+0 and the countdown target | `firstPacketTimeMs`, `countdownTargetMs` (live), `initMissionTime()`, `setFirstPacketTimeMs(ms)`, `setCountdownTargetMs(ms)`; step 2: `noteFirstSample(epochNow)`, `setCountdownTarget(ms)` |
| 2 | `server/config-caches.ts` | config-derived lookups on the Elodin hot path, rebuilt after a deploy | `hpBoardNumbersCache`, `t7CalFieldsCache` (live), `initConfigCaches()`, `resetConfigCaches()`, `uniqueIdFromPtEntity(entity)`, `t7BoardIdForSlot(slot)` |
| 3 | `server/sensor-stream.ts` | GUI downsampling and the two sample exits (immediate / windowed) | `guiStreamConfig`, `envelope`, `encoderEnvelope`, `broadcastLastTime` (step 1 only), `BROADCAST_MIN_MS` (read by `ingest`, `server.ts:1801`), `streamBudgetFor`, `saneSampleTimeMs`, `initGuiStream()`, `reloadGuiStreamConfig()`, `emitSensorPoint`, `emitSensorWindow`, `flushEnvelopes()`; step 2: `publishSample(high, low, parsed, epochNow)` |
| 3 | `server/calibration-state.ts` | the backend's half of calibration: PT coefficients, raw-ADC tracking, the `CalibrationHost` handed to `calibration-handler.ts` | `calibrationHost` (live), `initCalibrationState()`, `reloadCalibrationEntityMap()`, `lastRawAdc`; step 2: `noteRawAdc(entity, value)`, `setCalibrationElodin(client)` |
| 3 | `server/board-status.ts` | what the backend knows about each board: config baseline, heartbeats, T7 liveness, stale sweep and its notifications, self-test results, diagnostics log | `BOARD_STATUS_HZ`, `BOARD_HEARTBEAT_STALE_MS`, `boardsStatus`, `loadBoardsFromConfig()`, `updateBoard(low, payload)`, `countHeartbeat(id)`, `noteT7Alive(slot)`, `markStaleBoards()`, `broadcastBoardStatus()`, `boardLabel(status)`, `logDiagnostics()`, `selfTestLatest`, `selfTestNotifiedBoards`; step 2: `noteSelfTestResults(boardId, rows, epochNow)` |
| 3 | `server/engine-state.ts` | the sequencer's state as the backend reports it: current state, debug mode, allowed set, refusal reasons, the CSV-derived commanded positions | `currentState`, `debugMode`, `STATE_ACTUATOR_MAP` (live), `initEngineState()`, `reloadStateActuatorMap()`, `configStateName(id)`, `getExpectedPositions(state)`, `broadcastCommandedActuatorsForState(state)`, `broadcastStateUpdate()`, `refreshScriptStatus()`, `setDebugMode(v)`, `applySequencerState(rows)`; step 2: `resolveTransitionTarget(id)` |
| 4 | `server/actuator-mismatch.ts` | the 5 s commanded-vs-sensed check | `actuatorSensedState`, `scheduleActuatorMismatchCheck(state)`; step 2: `noteSensedRow(row, rows)` (only once G1 has landed, 2.1) |
| 4 | `server/elodin-link.ts` | the Elodin DB connection: connect/disconnect with the session, subscription passes, link health shown on the status badge | `elodin`, `noteIngest()`, `isSimulated()`, `connectionStatusPayload(extra)`, `broadcastConnectionStatus()`, `syncElodinToSession()`, `onElodinConnected`, `onElodinDbError`, `onElodinDisconnected`, `onElodinError` |
| 5 | `server/ingest.ts` | route each Elodin row to the module that owns what it says | `handleElodinPacket(header, payload)` |
| 5 | `server/commands.ts` | browser → backend messages and engine commands | `handleMessage(ws, msg)` (`handleCommand` stays module-private) |
| 6 | `server/ws-connection.ts` | one browser connection: identity, connect burst, wiring of its handlers | `handleConnection(ws, req)` |
| 7 | `server.ts` | composition root: the startup sequence (every timer, listener and startup read, in today's order), the HTTP server, `createAPIHandler` options, `applyDeployedConfigChange`, crash guards, `listen` | `applyDeployedConfigChange` (kept exported) |

**Import edges** (all downward): `ws-clients` → `client-outbox`, `shared/types`.
`notifications`, `history`, `mission-time` → `ws-clients`; `mission-time` → `env`.
`sensor-stream` → `ws-clients`, `history`, `stats`. `calibration-state` → `ws-clients`,
`config-caches`. `board-status` → `ws-clients`, `notifications`, `stats`, `config-caches`, `env`.
`engine-state` → `ws-clients`, `history`, `stats`, `sequencer-client`, `env` (`THIN_VERBOSE_CONNECTION_LOG`,
`server.ts:1705`, in the moved `_SEQUENCER_STATE` block). `actuator-mismatch` →
`engine-state`, `notifications`. `elodin-link` → `env`, `ws-clients`, `calibration-state`,
`engine-state`. `ingest` → `ws-clients` (the mission start time broadcast, `server.ts:1770`),
`elodin-link`, `board-status`, `engine-state`, `actuator-mismatch`,
`sensor-stream`, `mission-time`, `calibration-state`, `config-caches`, `notifications`, `stats`,
`env`. `commands` → `ws-clients`, `engine-state`, `mission-time`, `history`, `calibration-state`,
`elodin-link`, `sequencer-client` (`handleCommand` sends four of the five :9998 lines; an abort
is a `state_transition` and passes the same control gate, frozen in `ws_events.txt`).
`ws-connection` → everything above except `ingest`. **`server/*` never imports `api-server.ts` or `api/*`, and
they never import `server/*`** (STYLE-S31): the HTTP side reaches the WS side only through the
`createAPIHandler` options, which `server.ts` builds.

Why this layering: the connect burst needs the link status (`elodin-link`), which needs
`clientStreamStatus`, and `elodin-link` needs `broadcastConnectionStatus` → `send`. Putting
`clientStreams` and `send` in layer 1 and the connect handler in layer 6 keeps every edge
downward. A future D-SUB liveness watchdog (PROPOSAL, not WP6) would have `elodin-link` (layer 4)
import `board-status` (layer 3) — a downward edge — so nobody should "simplify" the layers in a
way that would turn it into a cycle. `elodin-link` keeps `scheduleResubscribe` and the four
listeners verbatim as that watchdog's one home; WP6 adds no seam there (no factory, no deps
object, no clock seam; D48). `ingest.handleElodinPacket` keeps `notePairDelivered(high, low)` as
its **first** statement through both steps (D42(d)).

Expected sizes (per WP, STYLE-S33): `server.ts` ~300 lines (DoD < 400); the largest modules
`ingest.ts`, `board-status.ts`, `ws-connection.ts` ~200-260 each; `env.ts`, `stats.ts` ~30.

---

## 3. Ownership and data flow

### 3.1 How state is passed: module singletons, not a context object

Each piece of state in §1.1 has **exactly one owning module**, which alone assigns it. Others
read it through the ESM live binding (`export let currentState`) or an exported function, and
change it only through a function the owner exports (STYLE-S32). There is no `ServerContext`:
every earlier extraction from `server.ts` (`board-scan-rate`, `elodin-vtable-registry`, `lc-tare`,
`countdown-state`, `sessionManager`) is module state plus functions; the process holds one
instance of everything; and a context object threaded through ~60 functions would recreate the
god file as a type. Explicit injection stays only where it already breaks a real cycle:
`createAPIHandler(opts)`, `sessionManager.init(callbacks)` and `CalibrationHost`.

TypeScript enforces the write rule (TS2632, assignment to an import), but esbuild/tsx do not
type-check, so the design is accepted **only with `tsc --noEmit` as a gate step** (D40). Without
it a missed setter (say an unconverted `countdownTargetMs = …`, today 1361) throws `TypeError:
Assignment to constant variable` inside the WS message try and surfaces only as a `Bad message`
log with no reply. M1 gives importability, not callability: `wss` becomes an `export let`
assigned by `attachWebSocketServer` (row 1.3) and `broadcast` dereferences it (`:905`), so a
vitest that reaches a sender mocks `ws-clients` (`TESTING-NOTES.md`).

### 3.2 An Elodin update

1. `elodin.on('packet', handleElodinPacket)` (registered in `server.ts`).
2. `notePairDelivered(high, low)` first. `[0x10]` → `board-status.countHeartbeat` +
   `updateBoard` → maybe `broadcastBoardStatus`; return.
3. Parse: `applyValveCalibration(expandWithTare(parseElodinPacket(id, payload, hpBoardNumbersCache,
   t7CalFieldsCache)))` — this exact expression stays at the parse site (`lc-tare.test.ts` guards it).
4. Self-test `[0x60..0x6F]` → `selfTestLatest`; first failure per board → `self_test_fail_<id>`
   notification (in `board-status` after 2.1).
5. `_SEQUENCER_STATE` → `engine-state.applySequencerState(rows)` (sets allowed set, state, debug,
   counts, `broadcastStateUpdate`, `broadcastCommandedActuatorsForState`), then
   `actuator-mismatch.scheduleActuatorMismatchCheck(currentState)`; return.
6. Per finite row, in this order (the order is behaviour): ball-valve sensed state →
   `actuatorSensedState` (+ recheck if a mismatch is active); `actuator_state` → same; T7 raw →
   `noteT7Alive`; `raw_adc_counts` → `lastRawAdc[uniqueIdFromPtEntity]`; first row ever → mission
   T+0 broadcast; `stats` + `noteIngest()` + `recordBoardScanIngest`; then `sensor-stream`: budget
   `null` → `emitSensorPoint` (history + broadcast now); `gui` + throttle mode → 50 ms gate →
   `emitSensorWindow`; else envelope `add` → `emitSensorWindow` on window close.
7. `emitSensorWindow` records to `history` **before** staging to each outbox (drained every
   100 ms); tare is applied at step 3, before both, so live data and backfill agree.

Two emitters of "a sample goes to history and the browsers" remain by design: `sensor-stream`
(Elodin rows) and `engine-state` (the CSV-derived commanded snapshot). Their frame timestamps
differ (`Date.now()` at send vs the snapshot's `epochNow`), so folding one into the other would
change a field.

### 3.3 The connect burst (frozen order: `pipeline/golden/ws_handshake.txt`, `lifecycle/golden/startup.txt`)

`connection_status` (with this socket's `connId`, `c<N>`) → `control_status` → `mission_start_time`
(only if T+0 is set) → `countdown_target_update` → `session_update` → `state_update` (**connect
shape: no `allowedBitmask`/`stateRefusalReasons`**, unlike `broadcastStateUpdate`) →
`board_status_update` (if any board) → commanded snapshot `sensor_update`s → self-test replay →
notification replay (pruned first) → `historical_data` chunks (not awaited). `ws-connection.ts`
owns this sequence and builds every frame of it, in both steps, from the other modules' live
bindings; it never assigns them. (Moving each frame into its owner was 2.8; it is not in WP6, §6.4.)

---

## 4. Error handling

Every boundary's try/catch moves with its body, unchanged, including what it covers: the WS
message catch covers parse **and** dispatch (`Bad message`, no reply), the packet catch covers the
whole handler (`Packet error`, packet dropped). No catch is added in either step, and promise
chains keep their `.then`/`.catch` shape (an added `.catch` changes which guard logs). The rest
stays as today: the :9998 client never rejects (`{ok, reply}`, STYLE-S14) and its callers reply
`ERROR "<Action> failed: <refusalText(reply)>"` to the sender; HTTP throws past WP7's catch →
500; `EADDRINUSE` → retry every 3 s; uncaught → crash guards log and the process lives; a timer
callback that throws is re-armed by Node; **no SIGTERM/SIGINT handler** is added.

Errors are caught **where input enters** and nowhere else (STYLE-S9/S10): `ws-connection` (log,
drop, no reply — **today, kept**; the direction is one `ERROR` per failed request once G10 freezes
today's silence and the team approves), `commands`, `ingest`, `sequencer-client`,
`api-server`/`server.ts`, the crash guards. Inner modules do not catch-and-log unless the catch
encodes a decision (config missing → defaults, as `configStateName` and `configBootStateId` do). The
existing exceptions — `debug_mode` failing silently, the `SCRIPTS` poll swallowing, the uncaught
`registerVTables` rejection at 1590 (STYLE-S28) — are kept and Parked, not fixed in WP6.

---

## 5. Naming conventions

STYLE-S5, S6, S7. Files are kebab-case under `src/server/`, named for what they own, never for a
pattern (`*-manager`, `*-service`, `*-handler`; existing files keep their names).
`server/sensor-stream.ts` is the wiring; `gui-stream.ts` stays the pure envelope library.
Functions: `handle<Input>` at the four input boundaries; `on<Source><Event>` for listeners;
`init*` for a startup read that assigns owned state; `reload*`/`reset*` for the post-deploy
rebuild; `broadcast*` to every client, `send` to one; `note*` records an observation; `set*` is
the owner's single writer. Inline timer arrows become named functions (`flushClientOutboxes`,
`resetOutboxStats`, `flushEnvelopes`, `logDiagnostics`, `reapUnresponsiveClients`,
`pruneHistory`). Types keep their names. Step 2.5 renames `STATE_ACTUATOR_MAP` →
`stateActuatorMap`, `_hpBoardNumbers` → `hpBoardNumbersCache`, `_t7CalFields` →
`t7CalFieldsCache`, `_ptSlotToBoardId` → `ptBoardIdBySlot`, `_t7SlotToBoardId` →
`t7BoardIdBySlot`. **Never renamed:** the `[ThinServer]`/`[WS_BACKEND]` prefixes and message texts,
the `__daq*` socket properties, env var names, notification keys.

---

## 6. Move-only pass, then cleanup

### 6.1 Step 1 — mechanical moves, no behaviour change

Rules for every commit in step 1:

- **R1 (import order).** `server.ts` keeps **all** of today's import statements, in today's order
  (unused ones included; `tsconfig` has no `noUnusedLocals`), and adds the `./server/*.js` imports
  **after** them. ESM evaluates each module once, at its first import, depth-first in source
  order; the new modules (M1: no effects) add nothing to that sequence. But tsc, tsx/esbuild and
  vitest **elide** an import none of whose specifiers is used as a value (D42(a); it already
  happens today for `api-server.ts` → `elodin-query.ts`), so "today's evaluation order" is the
  order of the imports that survive emit. Hence R1a-R1c.
- **R1a (bare import).** When a commit leaves an import in `server.ts` with no specifier used as a
  value, rewrite that declaration as a bare side-effect import **at the same position**
  (`import './state-csv/state-actuators.js';`). A bare import is never elided; this is a
  move-only edit. Do it **only** for a module the R1b list shows evaluating first at that line
  *before* the commit — never for an import already elided today (type-only or unused, e.g.
  `import type { StateActuatorMap }`), where a bare import would **add** a module to the
  evaluation set. Measured on the bundle (46 modules today, `server.ts` included; 47 after WP5 adds
  `sequencer-client`, which changes none of the fifteen), step 1 makes exactly **fifteen** bare
  imports, each in the commit that moves its last value user out of `server.ts`:

  | line | module | line | module |
  |---|---|---|---|
  | 27 | `elodin-client` | 39 | `state-csv/state-actuators` |
  | 28 | `elodin-protocol` | 41 | `state-csv/state-transitions` |
  | 29 | `lc-tare` | 47 | `client-outbox` |
  | 30 | `ball-valve-cal` | 48 | `history-backfill` |
  | 31 | `sensor-config` | 49 | `history-cache` |
  | 32 | `elodin-vtable-registry` | 53 | `calibration` |
  | 33 | `refusal-text` | 298 | `countdown-state` |
  | 34 | `script-status` | | |

  `gui-stream` (`:43-46`) is not on the list: if its line is elided it is still reached at once by
  `client-outbox.ts:37`, the next surviving import. Exactly one module in these closures has an
  import-time effect, `state-actuators.ts:79-81` (config read, can warn). The list is mechanical:
  all fifteen stay bare through step 2 (2.6 only labels them).
- **R1b (runtime order — the check that counts).** Every commit diffs the esbuild bundle's module
  order against its **parent commit** (§6.3 item 4). The only permitted difference is new
  `server/*` entries. There is no stored baseline: each commit equal to its parent makes the end
  of the step equal to the start (D49(4)). The queue item's merge check also runs §6.3 item 4 on
  the item's tip against its base, so the guarantee does not rest only on per-commit discipline
  (D51).
- **R1c.** Never enable `verbatimModuleSyntax` (or `isolatedModules`-driven `import type`
  rewrites) to "pin" imports: it would add `elodin-query.ts` to today's evaluation set and move
  `calibration.ts` ahead of `calibration-handler.ts` — a behaviour change.
- **R2 (startup order).** Every row of §1.2 stays a statement in `server.ts`, in the same order:
  `setInterval(<named fn>, <same ms>)`, `<module>.init…()`, `elodin.on('<event>', <named fn>)`.
  Only row 23 (`new ElodinClient(…)`, pure) moves to a module's top level. Row 9 (the host) is
  built inside `initCalibrationState()`; row 14 becomes `initStats()` at its position (STYLE-S30
  allows no clock read at top level, and this keeps `uptimeMs`'s origin where it is today).
- **R3 (bodies verbatim).** A moved function's body is byte-identical except: (a) an assignment
  to a binding now owned by another module becomes the owner's setter call (the complete list is
  §6.2); (b) the `_SEQUENCER_STATE` block is split as in row 1.11. Object, `Map` and `Set`
  mutations through imported references (`activeNotificationKeys.add`, `calibrationHost.elodin =
  …`, `actuatorSensedState.set`) stay as they are until step 2. So step 1 also exports the
  containers its moved bodies mutate from other modules: `activeNotificationKeys`,
  `notificationBuffer`, `selfTestLatest`, `selfTestNotifiedBoards`, `actuatorSensedState`,
  `lastRawAdc`, `clientStreams`, `broadcastLastTime`, `envelope`, `encoderEnvelope`, and
  `_t7SlotToBoardId` (which `noteT7Alive` fills until 2.4). `_ptSlotToBoardId` stays private.
- **R4 (one commit per module)**, in the order below, each green on its own (§6.3).
- **R5 (no re-export copies).** Never `export const x = y` (or `export let x = y`) where `y` is an
  imported `let`: that copies the value once and stops following the owner. Re-export with
  `export { y } from './owner.js'`.

| # | create | cut from `server.ts` (today's lines) | exports | notes |
|---|---|---|---|---|
| 1.1 | `server/env.ts` | 61, 73-79, 1858 (`GUI_PORT`) | env constants | `CONTROL_COMMAND_TYPES` → 1.15, `WsWithControl` → 1.3; `ACT_SVC_PORT`/`CTRL_SVC_PORT` are WP5's |
| 1.2 | `server/stats.ts` | 740-754 (+ comment 726-733) | `stats`, `initStats()` | `startTimeMs` starts at `0` and `initStats()` sets it (row 14). `lastIngestMs`/`DATA_FRESH_MS` (734-738) go to 1.13 |
| 1.3 | `server/ws-clients.ts` | 66-72 (`WsWithControl`), 187-209 (`ClientStream`, `clientStreams`), 233-274 body → `flushClientOutboxes`, 278-280 body → `resetOutboxStats`, 901 → `attachWebSocketServer(httpServer)` assigning `export let wss`, 904-917 (`broadcast`, `send`), 941-960 body → `reapUnresponsiveClients` + `KEEPALIVE_MS`, 1557-1562 (`clientStreamStatus`) | §2 | `server.ts` keeps `setInterval(flushClientOutboxes, 100)` (row 3), `setInterval(resetOutboxStats, 10_000)` (row 4), `attachWebSocketServer(httpServer)` (row 18), `setInterval(reapUnresponsiveClients, KEEPALIVE_MS)` (row 21). **Same commit: re-point the drain slice of `__tests__/lc-tare.test.ts:199-201`** to `server/ws-clients.ts` (§8 R9), adding a non-vacuity assertion that both anchors are found (`indexOf(...) > -1` for `cs.outbox.drain()` and `cs.pacer.noteFlush`). Mutation: move the tare into the drain (subtract a `force_kg_tared` offset between the anchors) → red |
| 1.4 | `server/notifications.ts` | 627, 633-652 | §2 | |
| 1.5 | `server/history.ts` | 81-86, 122-126, 129 body → `pruneHistory`, 1148-1203 | `history`, `pruneHistory`, `sendHistoricalData` | `broadcastLastTime` (127) → 1.7 |
| 1.6 | `server/mission-time.ts` | 297-299 → `export let` + `initMissionTime()` | + `setFirstPacketTimeMs`, `setCountdownTargetMs` | imports `countdown-state.js`. `server.ts` keeps its own `countdown-state.js` import at `:298`; it becomes **bare** (R1a) in 1.15, when `handleCommand` takes `saveCountdownTargetTimeMs` (`:1362`) — never deleted |
| 1.7 | `server/sensor-stream.ts` | 90-118, 127, 133-141 → `initGuiStream()` (assigns `guiStreamConfig`, `envelope`, `encoderEnvelope`, logs), 163-185, 211-227, 285-293 body → `flushEnvelopes` | §2 | 143-161 (`configStateName`) → 1.11 |
| 1.8 | `server/config-caches.ts` | 327-373 (incl. the T7 map 350-351); 329/331 initialisers → `initConfigCaches()`; 854-857 → `resetConfigCaches()` | §2 | `noteT7Alive`'s own lazy fill (575-579) moves with it in 1.10, unchanged |
| 1.9 | `server/calibration-state.ts` | 305-325 (load → `initCalibrationState()`), 375-384 (host built inside `initCalibrationState()`, after the load), 852-853 → `reloadCalibrationEntityMap()` | §2 | the host must be built after `loadPTCalibration` (it copies the path by value; frozen in `ws_events.txt` `calibration_command`) |
| 1.10 | `server/board-status.ts` | 87-89, 386-420 (call at 422 stays), 519-594, 596-618 (timer body → `logDiagnostics`), 622-626, 628-631, 654-722 (timer at 724 stays), 919-936 (937-939 stay: `startDhcpStatusPoller()` and the timer) | §2 | `logDiagnostics` reads `stats` and `wss.clients.size` |
| 1.11 | `server/engine-state.ts` | 143-161, 424-470 (430 → `reloadStateActuatorMap()`, called at row 11 and from the two callbacks), 756-775 (774 → `initEngineState()`), 1236-1265; **the body of 1697-1720 → `applySequencerState(parsedList)`** without its last two statements | §2 | in `server.ts`'s packet listener (the `elodin.on('packet', …)` body; `ingest.ts` exists only from 1.14): `if (parsedList[0]?.entity === '_SEQUENCER_STATE') { applySequencerState(parsedList); scheduleActuatorMismatchCheck(currentState); return; }` — today's order. `server.ts` keeps `setInterval(refreshScriptStatus, 15000)` (row 26) |
| 1.12 | `server/actuator-mismatch.ts` | 472-517 | §2 | |
| 1.13 | `server/elodin-link.ts` | 734-738 (+ `noteIngest()` = `lastIngestMs = Date.now()`), 1471, 1486-1555, 1564-1576, 1583-1602 → `onElodinConnected`, 1610-1635 → `onElodinDbError`, `onElodinDisconnected`, `onElodinError`, 1831-1846 (`syncElodinToSession`) | §2 | `server.ts` keeps `setInterval(broadcastConnectionStatus, 1000)` (row 24), `elodin.on('connected', onElodinConnected)`, row 26, then the other `on`s in today's order. Log text `Connected to Elodin, subscriptions sent.` unchanged (§8 R8) |
| 1.14 | `server/ingest.ts` | 1637-1816 → `handleElodinPacket(header, payload)` | | `server.ts`: `elodin.on('packet', handleElodinPacket)`. **Same commit:** re-point the parse-site assertion of `__tests__/lc-tare.test.ts:196-197` (`expandWithTare(parseElodinPacket(`) to `server/ingest.ts`. Mutation: drop the `expandWithTare(` wrapper → red |
| 1.15 | `server/commands.ts` | 62-64, 1205-1234, 1267-1407, 1473-1484 (`STATE_TO_CSV_NAME`) | `handleMessage` | |
| 1.16 | `server/ws-connection.ts` | 902, 962-1146 → `handleConnection(ws, req)` | | `server.ts` row 22: `wss.on('connection', handleConnection)` |

Both `lc-tare.test.ts` edits follow D18 by analogy (D39): assertions unchanged except anchors and
paths, the non-vacuity assertion added, mutations re-run, the orchestrator reviews the diff.

**Call order for rows 7-9.** `server.ts` calls `initCalibrationState()` (PT load and its log,
sensor-role map, then the host object) and **then** `initConfigCaches()` (`hpBoardNumbers()`,
`t7CalFields()`). Today the host (375) is built after the two cache reads (329, 331); here before
them. Harmless: building the host is pure, and the two cache reads log nothing and do not read
the host. The I/O order — PT file, role map, HP set, T7 fields — is unchanged.

**What remains in `server.ts`:** header comment, imports (R1), the startup sequence (rows 1-31 of
§1.2 as statements), `video`, `createAPIHandler({…})` with its five options (bodies verbatim,
reading imported bindings), `applyDeployedConfigChange` (body verbatim with 852-857 replaced by
`reloadCalibrationEntityMap(); resetConfigCaches();` and 860-864 by its own try/catch around
`reloadStateActuatorMap()`, warning text unchanged), the `httpServer` handler, crash guards, the
`EADDRINUSE` handler, `startGuiStaticServer`, `listen` (callback verbatim).

### 6.2 The complete list of cross-module writes in step 1 (each becomes a setter call)

| today | becomes |
|---|---|
| `debugMode = newDebug` (1346, `commands`) | `setDebugMode(newDebug)` |
| `countdownTargetMs = …` (1361, `commands`) | `setCountdownTargetMs(…)` |
| `firstPacketTimeMs = epochNow` (1766, `ingest`) | `setFirstPacketTimeMs(epochNow)` |
| `lastIngestMs = Date.now()` (1775, `ingest`) | `noteIngest()` (keeps `Date.now()`, not `epochNow`) |
| `allowedBitmask =`, `currentState =`, `debugMode =` (1703, 1710, 1711, `ingest`) | inside `applySequencerState` (moved block) |
| `STATE_ACTUATOR_MAP = getStateActuatorMap()` (817, 861, `server.ts`) | `reloadStateActuatorMap()` (throws through; each caller keeps its try/catch and warning text) |
| `calChannelToEntityMap = …; calibrationHost.channelToEntityMap = …` (852-853) | `reloadCalibrationEntityMap()` |
| `_ptSlotToBoardId.clear(); _t7SlotToBoardId.clear(); _hpBoardNumbers = …; _t7CalFields = …` (854-857) | `resetConfigCaches()` (same four statements, same order) |

`tsc --noEmit` rejects any missed one (TS2632).

### 6.3 Checks

**Every step-1 and step-2 commit** (no ports, no stack lock):

1. `npx tsc --noEmit` in `diablo_server/backend/` — exit 0 (D40).
2. Backend `npm test`: no failure outside `test/characterization/baseline_vitest_failures.txt`.
3. Cycle grep, in `diablo_server/backend/` — both print nothing (`ws-connection` is the one
   importer of `commands`; nothing imports `ws-connection` or `ingest`; no `api` edge):
   `grep -lE "from '\./(ws-connection|ingest)\.js'|from '\.\./(api-server\.js|api/)" src/server/*.ts` and
   `grep -lE "from '\./commands\.js'" src/server/*.ts | grep -v '/ws-connection\.ts$'`
4. **Module-evaluation order vs the parent commit** (R1b). esbuild's bundle concatenates modules
   in evaluation order with a `// <path>` banner per module, and this graph has no lazy `__esm`
   wrappers, so the list is the exact static order. (Before WP5 lands, `shared-types.ts`'s
   top-level `await import(…)` makes `state-csv/state-transitions` evaluate after its later
   siblings at runtime, with no observable effect; WP5 commit 5.4 makes that import type-only, so
   `shared-types.ts` leaves the bundle and the graph has no top-level await — for WP6 the static
   order *is* the runtime order. G12 covers runtime order either way.) The binary is the backend's own esbuild;
   the scratch checkout of the parent gets this worktree's `node_modules` symlinked in. It runs in
   under 1 s and writes nothing:

   ```bash
   cd diablo_server/backend
   ESB=$PWD/node_modules/.bin/esbuild
   order() { "$ESB" src/server.ts --bundle --platform=node --format=esm --packages=external \
     --log-level=error | grep -E '^// (src|\.\./)' \
     | awk '{last[$2]=NR; o[NR]=$2} END{for(i=1;i<=NR;i++) if(last[o[i]]==i) print o[i]}'; }
   order > /tmp/order-after.txt
   # the same in a scratch checkout of the parent (ln -s "$PWD/node_modules" <scratch>/daq-server/diablo_server/backend/node_modules) → /tmp/order-before.txt
   diff <(grep -v '^src/server/' /tmp/order-before.txt) <(grep -v '^src/server/' /tmp/order-after.txt)   # prints nothing
   ```

   In step 2 the expected diff outside `src/server/` is also empty (nothing in step 2 prunes or
   adds an import outside `server/*`); any diff is a stop, reviewed under D49(4). The queue item's
   merge check runs the same diff on the item's tip against its base (R1b).

**At the end of step 1 and the end of step 2 — startup-order check** (G11 and §1.2's row
order). Extract every top-level startup statement of `server.ts` and diff it against §1.2's last
column, top to bottom (a hand-written list, not a stored file):

```bash
cd diablo_server/backend/src
grep -E "^(setInterval\(|elodin\.on\('|wss\.on\('|(init|load|reload|start)[A-Za-z]*\(|attachWebSocketServer\(|video\.start\(|httpServer\.(on|listen)\(|process\.on\()" server.ts \
  | sed -E 's/ *\{.*$//'
```

An order difference is a stop; a spelling the list did not anticipate is fixed in the list and
reported.

**At checkpoints — after commits 1.7, 1.13 and 1.16, after 2.1, and at the end of step 2** —
under the stack lock, within AGENT-RULES rule 7's hold limit (split across holds if needed):

- **Startup-log diff** (G12; after 1.7, 1.13, 1.16 and at the end of step 2): start
  `src/server.ts` alone for 5 s with the pipeline fixture's environment (`CONFIG_PATH` = a fixture
  config with 127.0.0.x boards, `SESSION_SERVICE_MODE=mock`, `GUI_PORT=0`, 264xx ports, no
  Elodin) and diff the first 60 lines of output against the same run on `backend-remastered`.
  Identical after normalising timestamps and PIDs. It catches a moved log line; the order diff
  (item 4) catches a moved module that does not log under the test config.
- `pipeline/run.sh pt`, `nocal`, `boards`, `lifecycle/run.sh`. `test_integration.sh`
  (`ws_data_flow_test`) runs in the merge queue's full gate.

G11 and G12 are WP6's own scripts, not C0 packages (D48(3)).

**Review** with `git diff --color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change
backend-remastered -- diablo_server/backend/src`: in step 1 every non-dimmed line must be an import
(including an R1a bare import), an `export` keyword, a function wrapper for a former inline arrow, a
setter from §6.2, the `startTimeMs: 0` initialiser and `initStats()` (commit 1.2), a top-level
initialiser split into an `export let` declaration and its assignment inside an
`init*`/`reload*`/`attach*`/`note*` function (`initGuiStream` envelopes, `initMissionTime`,
`initConfigCaches`, the `initCalibrationState` host, `initEngineState`, `attachWebSocketServer`
`wss = …`, `reloadStateActuatorMap`, `noteIngest`), the `_SEQUENCER_STATE` branch left in
`server.ts` at 1.11, `applyDeployedConfigChange`'s replaced try/catch, or a startup statement in
`server.ts`. A line that only re-indents or rewraps a moved statement is expected, not
a stop (D43(6)).

### 6.4 Step 2 — cleanup toward the target

Each is its own commit, with the per-commit checks of §6.3; checkpoints after 2.1 and at the end.
Order matters only where noted. Numbering is kept from the reviewed note (LEDGER cites it).

1. **`ingest` becomes a router.** G2 and G3 should exist first (§7). G1 **must** exist before the
   two sensed-row blocks move — the ball-valve `position_pct` block and the `actuator_state` block
   (`server.ts:1726-1750`), each updating `actuatorSensedState` and rescheduling the mismatch
   check; if G1 has not landed, those two blocks stay in `ingest` (D51). Move each row block
   into its owner, keeping the per-row order of §3.2 step 6: self-test →
   `board-status.noteSelfTestResults` (the `break` after the first failure stays); ball-valve and
   `actuator_state` → `actuator-mismatch.noteSensedRow`; raw ADC → `calibration-state.noteRawAdc`;
   T+0 → `mission-time.noteFirstSample`; counters → `stats`; downsampling →
   `sensor-stream.publishSample`. Measure the hot path (§8 R7); abandon 2.1 for any block where it
   moves.
2. **Owner-only mutation.** `notifications.raiseNotification(payload)` /
   `clearNotification(payload)` — one argument; the key is `payload.key`, which at all nine sites
   is the same value as today's separate key — replace the 5 broadcast-then-`add` (512, 678, 697,
   712, 1690) and 4 broadcast-then-`delete` (515, 681, 703, 716) pairs, broadcast first as today.
   The one-shot "connected" info stays a plain `broadcastNotification`. In the same commit
   `calibration-state.setCalibrationElodin(client)` replaces `onElodinConnected`'s
   `calibrationHost.elodin = elodin` (1589), so `calibration-state` is the host's only writer, and
   `activeNotificationKeys` is exported as `ReadonlySet<string>`, so `tsc` rejects an `add`/`delete`
   outside `notifications` (STYLE-S32).
3. **Slot rule** (after G6). `config-caches.ts`'s `bid % 10, 0 → 10` (today 344-345) → WP5's
   `boardSlot()`. Allowed only if **either** `boardSlot()`'s body is literally
   `const m = id % 10; return m === 0 ? 10 : m;` (the `typeof bid === 'number'` guard staying in
   the caller), **or** G6 also freezes negative (`-21`), non-integer (`21.5`) and `NaN` board_ids,
   so that any extra validation in `boardSlot()` shows up.
4. **One T7 slot lookup.** `t7BoardIdForSlot(slot)` replaces both lazy fillers (360 and 577). The
   two catches differ (`/* no T7 uid */` vs `return`) but are equivalent: the only throws come from
   `readConfig()` or `t7Channels()` before the loop sets anything, so after either catch the map is
   empty and the lookup yields `undefined`, which both callers treat as "no board".
5. **Renames** of §5.
6. **Label the bare imports.** One comment block above the fifteen R1a bare imports in
   `server.ts`, naming what each pins (STYLE-S37): `state-csv/state-actuators` is the effectful
   one (builds three config maps at import, can warn, `:79-81`); the other fourteen pin today's
   evaluation order only. No import is added, deleted, reordered or rewritten; the order diff is
   empty.
9. **One owner for state-id resolution.** "What state id N means" is decided in two modules
   after step 1: `engine-state.configStateName` (the name in `state_update` and the mismatch text)
   and `commands` (the `[[states]]`-declared check, the `SystemState` enum fallback,
   `STATE_TO_CSV_NAME`). Move the second half into `engine-state` as
   `resolveTransitionTarget(id)`, returning `{ ok: true, stateName, csvName }` or `{ ok: false }`
   (id not declared by a config that declares states). Body verbatim, reads in today's order
   (`configStateName(id)` — the deployed-config cache — then `readConfig().states`);
   `STATE_TO_CSV_NAME` moves with it. `commands` keeps the warn line, the `ERROR` reply text, the
   `holdMs` check (still after the id check) and the line format.

**Not in WP6** (D49, D51; reasons in `debates/WP6/history.md`): 2.7, a real test replacing
`lc-tare.test.ts`'s source-text check (a separate test-only package, D39); 2.8, owners sending
their own connect-burst frames (it changes `lastOutboundAt` in the `conn_close` log, an
observable); all of 2.10 (`mismatchVerdict`, `boardHealthEvents`, `selfTestFailure`,
`nextResubscribeDelay`); 2.11, the vitest recipe (now `TESTING-NOTES.md`); the bare-import
pruning 2.6 used to be.

**Exports after step 2.** A `[step 1]` container stops being exported in the commit that moves its
last outside user, so a stale writer is a build error: `selfTestNotifiedBoards`,
`actuatorSensedState` (if G1 let its two blocks move), `lastRawAdc`, `broadcastLastTime`,
`envelope`, `encoderEnvelope` after 2.1; `_t7SlotToBoardId` after 2.4. Because the burst stays in `ws-connection`, `boardsStatus`,
`selfTestLatest` and `notificationBuffer` stay exported for reading, and `activeNotificationKeys`
as a `ReadonlySet`. `clientStreams` stays mutably exported: `ws-connection` registers and removes
its socket (984, 1121), as today.

### 6.5 Deliberately NOT changed (observable)

- Message `type` strings (incl. `get_state_transitions` / `state_transitions`), payload field
  names and the **key order** of every object literal (G9); both `state_update` shapes, the double
  `state_update` on `debug_mode`, the connect-burst order (§3.3), `connId` `c<N>`.
- Error and notification texts and keys (`board_lost_<id>`, `setup_stuck_<id>`,
  `unrecognized_<id>`, `self_test_fail_<id>`, `actuator_mismatch`).
- Every period and delay: 50 ms throttle and envelope flush, 100 ms drain, the three 1 s timers
  and their order, 5 s stale threshold, 4 s setup-stuck, 5 s mismatch delay, 5 s resubscribe
  minimum, 15 s script poll, 30 s keepalive, 60 s prune, 10 s outbox reset, 500 ms T7 mark, 3 s
  data-fresh, 60 s sample skew, 2 s TCP timeout, 3 s EADDRINUSE retry, 5 min / 500 notification
  buffer, 3000 points per backfill series. No `Date.now()` site moves.
- `/stats` and `/api/debug` keys (`useRelay: false` included); `CONFIG_UPDATED` after a deploy;
  fire-and-forget backfill; no optimistic state; the backend never sends FIRE_*.
- No signal handlers (`lifecycle/golden/shutdown.txt` freezes `exit -15`/`-2`); crash guards;
  `[ThinServer]` lines; the `conn_open`/`conn_close` JSON incl. `lastOutboundAt` and the counters
  that skip `mission_start_time` and `session_update`.

---

## 7. Guarding characterization

| part | guarded by | rules |
|---|---|---|
| connect burst order and contents | `pipeline/golden/ws_handshake.txt` (A, B, C), `boards/` and `nocal/` copies, `lifecycle/golden/startup.txt` "WebSocket handshake" | P10, P12, P12d; lifecycle exact |
| command replies, `state_update` shapes, locked/unlocked, TCP-reply path, countdown, session | `pipeline/golden/ws_events.txt` | P6, P11; mutation `stateName → state_name` went red |
| payload key paths and JSON types | `ws_schema.txt` (all three sessions) | — |
| streams, envelope timing, history | `ws_streams.txt` | P2, P7, P8, T1 (mutation `2000/ → 1000/` went red) |
| self-test replay / notifications / per-board stream set | `boards/ws_streams.txt`, `boards/ws_events.txt` | P12 (mutation "drop SELF_TEST rows" went red) |
| setup-stuck raise/clear, connected, lost | `boards/ws_events.txt` (`setup_stuck_60`), board-health set | P1, P1b |
| board lost/recovered timing, (re)subscription count, Elodin down → badge | `lifecycle/golden/{reconnect,hbloss,shutdown}.txt` | bounds from `BOARD_HEARTBEAT_STALE_MS` |
| `/stats`, `/api/debug` | `http.txt` | P9 (schema) |
| SIGTERM/SIGINT behaviour | `lifecycle/golden/shutdown.txt` | exact exit codes |
| calibration host contract | `calibration/golden/ts.txt` (`calibration-handler.ts` with a stub host, incl. `publishCalibrationReload` + `publishClearAllTares` bytes) | 4 ULP |
| tare at the parse site | `__tests__/lc-tare.test.ts:192-203` | re-pointed in 1.3 and 1.14 |
| end to end (calibration capture via `lastRawAdc`, LC tare, ball valve, T7, sample conservation) | `test/ws_data_flow_test.ts` via `test_integration.sh` | gate |

Backend vitests (recipe: `TESTING-NOTES.md`) do not discharge these rows; they are black-box C0
characterization. Substituting a vitest for a row is a decision the orchestrator records per row,
never a default.

### Gaps — a move could change these and no golden would notice

Each is a test added **before** the step that touches it. G1-G5, G7-G10 are C0
(`test/characterization/**`, test-only); G6 is a backend vitest WP6 adds; G11 and G12 are WP6's
own scripts (§6.3, D48(3)).

| gap | priority | must exist before |
|---|---|---|
| G7 + G8 | MUST | step 1 |
| G1 | MUST — ball-valve route | 2.1's two sensed-row blocks (D49(9), D51); without it they stay in `ingest` |
| G10 | MUST | commits 1.15 / 1.16 |
| G4 | MUST, owned by WP5 | WP5 lands |
| G11 | MUST (WP6 script) | end of step 1 |
| G12 | MUST (WP6 script) | checkpoint after 1.7 |
| G9 | should | step 2 |
| G2, G3 | should | step 2.1 |
| G6 | should | step 2.3 |
| G5, G13 | nice-to-have | — |

- **G1 Actuator mismatch** never fires in any golden. Its state is spread over `actuator-mismatch`,
  `engine-state` and `notifications`, and step 2.1 moves the sensed-state blocks. No sensed
  `ACTn.CHm.actuator_state` row reaches the backend in the simulated stack (the simulator's
  ACTUATOR current is a free sine, `board_simulator.py:617-623`), but a **ball valve** reports a
  sensed position: `BV1_Cal.CH1.position_pct` (`pipeline/golden/boards/ws_streams.txt:100-105`) →
  sensed entity `BV1.CH1` (`server.ts:1728-1740`; `state-actuators.ts:140-144` maps a ball-valve
  role to `BV<n>.CH<m>`). The case C0 builds:
  - **Fixture:** the `Main Ball Valve` actuator role and a CLOSE-in-every-state CSV row, as
    `test_integration.sh` has them (`"Main Ball Valve" = ["NC", 1, 71]` at `:675`, the CSV row at
    `:517`), in a new pipeline mode or a `ws_data_flow_test` case — **not** the frozen `boards`
    session.
  - **Steps:** unlock → `debug_mode` on → `actuator "Main Ball Valve" 1` → wait > 3 s
    (`BALL_VALVE_TRAVEL_S`, `board_simulator.py:49`) → `debug_mode` on **again**
    (`doSetDebugMode(true)` publishes state without clearing overrides,
    `SequencerService.cpp:947-954`, which schedules the 5 s check) → ≥ 5 s → `notification
    actuator_mismatch ongoing=true "Actuator mismatch in <state>: BV1.CH1 (expected CLOSED, sensed
    OPEN)"` → close the valve (a sensed change with the key active reschedules) → `"Actuator
    positions match expected" ongoing=false` → debug off. (Turning debug off first does not work:
    it clears manual overrides before publishing state, `SequencerService.cpp:949-952`.)
  - **If C0 cannot land it before step 2.1:** the ball-valve and `actuator_state` blocks
    (`server.ts:1726-1750`) stay in `ingest` and the rest of 2.1 proceeds; there is no substitute
    test (D51).
- **G2 `self_test_fail_<id>`** (one per board, `break` after the first failure): the simulators
  only pass (`board_simulator.py:344, 460-461`). Needs an opt-in `--fail-connector <board>:<ch>` in
  `sim/board_simulator.py`, default off, with a test that the default output is byte-identical
  (D48(1)).
- **G3 `unrecognized_<id>`**: a sim-only board is never heard (`daq_bridge_main.cpp:568-571, 590`;
  `elodin-vtable-registry.ts:242-262, 335-340`). C0 uses a **two-config fixture**: `daq_bridge`
  and the simulator on `$CFG`; the backend on a copy where one board is still subscribed but not
  `expected` — its id spelled `id =` instead of `board_id =` (the registry takes
  `b.board_id ?? b.id`, `:247`; `loadBoardsFromConfig` needs a numeric `board_id`,
  `server.ts:399`). Not an empty `[boards]`, which trips the registry's 1..255 fallback (`:330-334`).
- **G4 :9998 down / slow** (lifecycle, WP5's): SIGSTOP the sequencer → `state_transition` →
  `ERROR "State transition failed: timeout"` after ~2 s; SIGTERM it → `"… connect ECONNREFUSED
  127.0.0.1:<port>"` (N5 normalises the port); `debug_mode` → no reply.
- **G5 keepalive reaper**: a client that stops answering pings is reaped within [30, 60] s.
- **G6 slot 0 → 10** (344-345) and the T7 slot map: no golden streams a PT board with
  `board_id % 10 == 0`. After 1.8 WP6 adds a vitest of `config-caches` (`CONFIG_PATH` fixture):
  board 20: `PT10.CH3` → 2003; board 21: `PT1_Cal.CH2` → 2102; a slot no board has → `slot*100+ch`;
  `T7<n>_Cal.AIN<m>` → `board_id*100+m`.
- **G7 deploy-driven reload** (`applyDeployedConfigChange`, `onStateCsvUpdated`): only the
  session-start path is frozen. Add idle-mode `POST /api/config` and `POST /api/state-csv` as an
  operator and freeze `config_updated`, the following `board_status_update` list, and the
  commanded snapshot a new client then gets (proves `STATE_ACTUATOR_MAP` was rebuilt). Shared
  with WP7's H1. **G8** (`CONFIG_UPDATED` before `board_status_update`) is covered by G7.
- **G9 key order.** Goldens sort JSON keys (`characterize.py:92`, `normalize.py:145`); a step-2
  helper that rebuilt a payload could reorder. Guard: one unsorted raw frame per message type.
- **G10 a JSON message whose handler throws** (`{"type":"send_command"}` without payload → no
  reply): one line in `session.ts`'s `subscribe` step.
- **G11 timer firing order** and **G12 startup log order** (`GUI downsampling`, `Loaded N PT
  calibrations`, `Loaded N boards`, `state-actuators`' warnings, video, `listening on port`) are in
  no golden: the startup-order check and the startup-log diff (§6.3).
- **G13 `[WS_BACKEND]` `conn_open` / `conn_close`** (fields, counters, `connId`): log only.

---

## 8. Risks

(Numbering kept; the reviewed R2 (cycles) and R6 (live bindings) are folded into §6.3 item 3 and
R1.)

- **R1 Shared state.** Single ownership (§1.1), setters checked by `tsc` (§6.2), cross-module
  `Map`/`Set` mutation verbatim until step 2. `calibrationHost` must be built after the PT load
  (path by value). `wss` is a live binding: never destructure it, or any `export let`
  (`const { currentState } = await import(…)`), into a local that outlives the call; row 18
  assigns it in the synchronous startup body, before any timer or listener can run.
- **R3 Startup order.** The three 1 s timers stay **three separate `setInterval` calls**, stale
  sweep → board status → connection status (D42(b)): same-period timers fire in registration
  order, and a throw in one is logged by the `uncaughtException` guard while the other two still
  fire. A merged `tick()` would skip the rest on a throw; a try/catch per call would change which
  guard logs. Row 11's CSV read stays un-caught (a throw at startup kills the process before the
  crash guards exist, as today). `sessionManager.init` → `syncElodinToSession` →
  `startBoardLogReceiver` stay inside the `listen` callback in that order.
- **R4 The `state-csv/` loaders** resolve CSV paths with `join(__dirname, '..', '..', '..', '..',
  rel)` — never move them into `server/`. `CSV_ACTUATOR_TO_ENTITY` is never rebuilt by
  `applyDeployedConfigChange`, and absolute `[state_machine]` paths are never found: both kept.
- **R5 The slot helper** at `server.ts:344-345` is a **sixth** copy of `board_id % 10, 0 → 10` that
  BLOAT-MAP §3 does not list; WP5 does not own it; 2.3 replaces it after G6.
- **R7 Ingest hot path.** 2.1 adds function calls per row (~200+ streams): at the 2.1 checkpoint
  compare `/stats` `sensorUpdatesBroadcast` with the simulator's sent count (`ws_data_flow_test`
  sample conservation) and the pipeline T1 bound.
- **R8 Harness-read log lines.** `Connected to Elodin, subscriptions sent.` (counted by
  `lifecycle.py:1083`, frozen in `reconnect.txt`) moves with `onElodinConnected` unchanged;
  `VTableStream: sent` / `queued for the next pass` (`pipeline/run.sh:216`) are the registry's.
- **R9 `lc-tare.test.ts`** reads `server.ts`'s source. Its parse-site assertion goes **red** at
  1.14, but its drain-slice assertions go **silently vacuous** at 1.3 (both `indexOf`s return -1
  and the empty slice contains nothing) — hence the re-point and non-vacuity assertion in 1.3.
- **R10 `tsx watch` in production** (`npm run dev`, recorded defect) watches more files; no
  behaviour change.

---

## 9. Interface stubs and STYLE

The public surface of every §2 module is written as type-checked stubs in
`docs/remaster/design-stubs/ts/src/` (one header comment per module, STYLE-S36), with WP5's and
WP7's modules beside them. They are imported by nothing and excluded from the product's `tsc`:

```bash
cd daq-server/docs/remaster/design-stubs/ts
npx --prefix ../../../../diablo_server/backend tsc --noEmit -p .    # exit 0
```

**The stubs are frozen as of D49 and are not maintained once step 1 starts.** They were cut back
to D49 and D51 (all 2.10 decisions removed) but still show 2.8's `send…(ws)` functions and
"private after 2.8" comments, which WP6 no longer builds: where a stub and this note disagree,
this note wins.

STYLE beyond the rules cited above: S15 (harness-read lines named in module headers); S20 as
amended by D44(1) (`SEQUENCER_PORT` is read by `sequencer-client.ts`, which dials it; `USE_SIM` is
read per call in `isSimulated()`, verbatim); S34 (no new class, factory, deps object or one-user
interface; `TransitionTarget` is a return type); S38 (2.6's comments land in step 2, not a
move-only commit); S40 (2 spaces, single quotes, semicolons in new files; moved code not
reformatted).
