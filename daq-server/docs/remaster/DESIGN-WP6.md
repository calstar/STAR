# DESIGN-WP6 — split `diablo_server/backend/src/server.ts`

Target-design note required by LEDGER D17(a) before the WP6 split. Design only: nothing here has
been executed. Paths are relative to `daq-server/diablo_server/backend/src/` unless stated.

**Baseline.** Line numbers are `server.ts` on `backend-remastered` @ `b2599617` (1885 lines). WP6
runs after WP5 (BLOAT-MAP DAG), which removes `server.ts:1409-1467` (the two `sendTo*Service`
functions → `sequencer-client.ts` [A1]), renames `legacy/` → `state-csv/` and adds one `boardSlot()`
helper to `sensor-config.ts`. Every line after 1467 then moves up by about 59. **Locate code by the
section banners (`// ── … ──`) and symbol names given here; use line numbers only to orient.** Where
this note says `sendToActuatorService` it means `sendToSequencer` from `sequencer-client.ts` after
WP5 [A1].

**Prerequisites.** C1 merged on `backend-remastered`, and `npx tsc --noEmit` in
`diablo_server/backend/` added to `gate.sh` as a merge-gate step (orchestrator). WP5 merged.

**Amendments (design/ts2, 2026-11-16).** The deeper pass (alternatives, interface stubs,
walkthroughs — sections at the end) and the research note `research/node-realtime-backend.md`
changed the following; each changed place is marked with its tag.

- **[A1]** WP5's client is `sequencer-client.ts` / `sendToSequencer` / `SEQUENCER_PORT`
  (DESIGN-WP5 §2), not `service-line-client.ts`. `server/env.ts` no longer lists `ACT_SVC_PORT` or
  `CTRL_SVC_PORT`. `commands` imports it too (the edge was missing from §2).
- **[A2]** R1's evaluation-order argument was textual, and tsc/tsx/vitest **elide** an import whose
  specifiers are unused as values (reproduced with this repo's tsx 4.21; already happens today for
  `api-server.ts` → `elodin-query.ts`). Step 1 now (a) diffs the esbuild bundle's module order before
  and after every commit, (b) turns an import that step 1 leaves without a used specifier into a bare
  `import './x.js';` at the same position, which counts as a move-only edit, and (c) never enables
  `verbatimModuleSyntax`. §6.1 R1, §6.3 item 6, §6.4 item 6.
- **[A3]** Walkthrough (a) found two owners of "what state id N means" (`commands` and
  `engine-state`): new step 2.9 moves the resolution into `engine-state`.
- **[A4]** Walkthroughs (a)-(c) found the connect burst building other modules' messages
  (`state_update` connect shape, commanded snapshot, self-test and notification replays): new step
  2.8 gives each owner a `send…(ws)` (STYLE-S6: `send` = one socket) and leaves `ws-connection`
  only the order.
- **[A5]** The three 1 s timers stay three `setInterval` calls, never one merged tick (a throw in one
  must not skip the others). §8 R3.
- **[A6]** D-SUB's liveness watchdog stays a PROPOSAL; the layering keeps room for it
  (`elodin-link` may import `board-status`, a downward edge). §2.
- **[A7]** LEDGER D42(d): `ingest.handleElodinPacket` keeps `notePairDelivered(high, low)` as its
  **first** statement, before any family dispatch, through step 1 and step 2 (so per-pair delivery
  times can later be one change in the registry — `research/subscription-robustness.md` Idea 4);
  `elodin-link` is the one home of the resubscribe loop and the Elodin listeners, so a later
  subscription-echo (D-ECHO, Idea 2) or liveness check attaches there (PROPOSALS, not WP6). The
  "which pairs are due" decision becomes a pure `duePairs` in the registry — done by **WP5**
  (DESIGN-WP5 commit 5.7), since WP6 does not touch the registry.

- **[A8]** STYLE.md (55d140ef) and LEDGER D43: M1 also allows top-level constants derived from
  `import.meta.url` (STYLE-S30; WP7-S3's `SRC_DIR`); §4.3's "browser message → log, drop, no reply"
  row is relabelled **today, kept** (STYLE-S10: the direction is one answer per request, after a
  golden and a team decision); in the move-only review (§6.3) lines that only re-indent or rewrap a
  moved statement are expected non-dimmed lines; the size targets (`server.ts` < 400, modules
  ~200-300) are per WP, not per pass (STYLE-S33). Rules are cited as `STYLE-S<n>`, `WP6-R1`,
  `WP7-S1`.

- **[A9]** Writing the interface stubs ("Interfaces" at the end): `raiseNotification` /
  `clearNotification` take the payload only; `activeNotificationKeys` becomes `ReadonlySet` after
  step 2.2 (tsc-enforced single owner); two missing downward edges (`calibration-state` →
  `config-caches`, `mission-time` → `env`); step 2.8's functions return frame counts;
  `stats.startTimeMs` is set by `initStats()` at row 14 instead of at import (STYLE-S30).

Research cited: `docs/remaster/research/node-realtime-backend.md` (§1 elided imports, §2 timers,
§3 backpressure, §4 D-SUB, §5 functional core) and `research/subscription-robustness.md` (Ideas
2-5), merged at 963e81b9 (LEDGER D42).

**Orchestrator decisions (design review, 2026-11-16), recorded here:**

- D-a/D-d: the module list of §2 (more modules than BLOAT-MAP's WP6 row, `sensor-stream` in place of
  `gui-stream-config`) is accepted; the orchestrator amends BLOAT-MAP's WP6 file list and DoD.
- D-c: module singletons (§3.1) are accepted **on condition that `tsc --noEmit` is a gate step**. It is
  the only thing that turns a missed setter into a build failure; without it, a missed one fails only
  at runtime — e.g. an un-converted `countdownTargetMs = …` (today 1361) throws `TypeError: Assignment
  to constant variable` inside the WS message try and surfaces only as a `Bad message` log with no
  reply. `tsc --noEmit` exit 0 is required for every commit (§6.3) and at the merge gate.
- `__tests__/lc-tare.test.ts` may be edited under D18's conditions by analogy: assertions unchanged
  except anchors and file paths, its mutations re-run, the orchestrator reviews the diff (§6.1, rows
  1.3 and 1.14).
- Step 2.7 (replacing the source-text test with a real test) leaves WP6: it is a separate test-only
  package.
- Step 1 (the move-only pass) and step 2 (cleanup) are **separate queue items**, each fully gated.

**Contract (frozen, D5/D17).** WS message types and payload field names (`shared/types.ts`, read-only),
the order of the connect burst, event ordering inside one step, every period and delay listed in §6,
TCP :9998 command lines and reply handling, Elodin subscriptions, `/stats`, the `src/server.ts`
entrypoint path, log lines the harnesses grep (§8 R8), process behaviour on SIGTERM/SIGINT (no signal
handler: `lifecycle/golden/shutdown.txt` freezes `exit -15`/`-2 … default action`).

---

## 1. Current responsibilities

`server.ts` is the backend process: WebSocket :8081 (`WS_PORT`) + HTTP on the same port, the Elodin
DB client, the TCP client to the sequencer (:9998), and the static GUI on `GUI_PORT`. All `/api/*`
routes are delegated to `api-server.ts` (WP7).

### 1.1 What lives where

| lines | section | what it does |
|---|---|---|
| 1-57 | header, imports | 33 imports; five more at 298-303 (hoisted, evaluated in source order) |
| 59-79 | Config | env: `WS_PORT`, `ELODIN_HOST/PORT`, `ACT_SVC_PORT`, `CTRL_SVC_PORT`, `THIN_*` log flags; `CONTROL_COMMAND_TYPES` (64); `WsWithControl` socket type (66-72) |
| 81-118 | stream budget | history caps, `BOARD_STATUS_HZ`, `BOARD_HEARTBEAT_STALE_MS` 5000, `BROADCAST_MIN_MS` 50, `streamBudgetFor(high)` |
| 120-129 | history | `history` (`HistoryCache`), `broadcastLastTime`, 60 s prune timer |
| 131-175 | GUI downsampling | `guiStreamConfig`, `envelope`, `encoderEnvelope` initialised from config **at module load** (133-137, logs), `configStateName()` (143-161), `reloadGuiStreamConfig()` |
| 177-227 | sample emit | `saneSampleTimeMs`, `ClientStream`, `clientStreams`, `emitSensorPoint` (immediate broadcast), `emitSensorWindow` (history + per-client outbox) |
| 229-293 | timers | outbox drain + link status (100 ms), outbox stats reset (10 s), envelope flush (50 ms) |
| 295-303 | mission time | `firstPacketTimeMs`, `countdownTargetMs` (disk read at load), 5 late imports |
| 305-384 | calibration state | `ptCalibration`, `calibrationPoints`, `lastRawAdc`, `ptCalibrationFilePath` (disk read 313-320, logs), `calChannelToEntityMap`, hot-path caches `_hpBoardNumbers`, `_t7CalFields`, `_ptSlotToBoardId` (+ the **sixth copy of the slot rule**, 344-345), `_t7SlotToBoardId`, `uniqueIdFromPtEntity`, `calibrationHost` (375-384, copies `ptCalibrationFilePath` **by value**) |
| 386-422 | board status | `boardsStatus`, `loadBoardsFromConfig()` (called at load, 422, logs) |
| 424-470 | state actuator map | `STATE_ACTUATOR_MAP` (CSV read at load, 430), `getExpectedPositions`, `broadcastCommandedActuatorsForState` |
| 472-517 | actuator mismatch | `actuatorSensedState`, 5 s `actuatorMismatchTimer`, `scheduleActuatorMismatchCheck`, `checkActuatorMismatch` |
| 519-618 | board heartbeat | `updateBoard` ([0x10]), `noteT7Alive` (T7 data as heartbeat, 500 ms mark), `hbDiagCount` + 5 s diagnostic log timer (599-613), `countHeartbeat` |
| 620-724 | board notifications | setup-stuck/lost/connected/unrecognized state, `activeNotificationKeys`, `selfTestNotifiedBoards`, `selfTestLatest`, `notificationBuffer` (5 min / 500), `broadcastNotification`, `boardLabel`, `markStaleBoards` + 1 s timer (724) |
| 726-754 | packet stats | `lastIngestMs`, `DATA_FRESH_MS` 3000, `stats` |
| 756-775 | boot state | `configBootStateId()`, `currentState` (config read at load), `debugMode` |
| 777-829 | HTTP wiring | `VideoService` (constructed + started at load), `createAPIHandler({…})` with `getEngineState`, `getDebugInfo`, `onStateCsvUpdated`, `onCalibrationReload`, `onConfigUpdated` |
| 831-874 | config change | `export applyDeployedConfigChange()` — the always-on backend's reload after a deploy |
| 876-917 | servers | `httpServer` (`/stats`, then `apiHandler`, else bare 404), `wss`, `wsConnCounter`, `broadcast`, `send` |
| 919-939 | board status out | `broadcastBoardStatus` (adds `dhcp`, `frequencyHz`), `startDhcpStatusPoller()`, 1 s timer (939) |
| 941-960 | keepalive | 30 s ping/reap |
| 962-1146 | client connection | per-socket auth (`X-Auth-Email`), outbox registration, connect burst (§3.4), `message`/`close`/`error` handlers |
| 1148-1203 | history backfill | `sendHistoricalData` (chunked, capped unless narrowed) |
| 1205-1234 | WS dispatch | `handleMessage` |
| 1236-1265 | sequencer view | `allowedBitmask`, `stateRefusalReasons`, `refreshScriptStatus` (SCRIPTS over :9998), `broadcastStateUpdate` |
| 1267-1407 | commands | `handleCommand`: control gate, state_transition, actuator, debug_mode, extend_fire, countdown, session start/stop/extend |
| 1409-1467 | TCP clients | `sendToActuatorService` (:9998, `OK`/`OK:<ms>`), `sendToControllerService` (:9999, exact `OK`, **no caller**) — moved out by WP5 |
| 1469-1484 | Elodin client | `elodin` (`ElodinClient`), `STATE_TO_CSV_NAME` (used only by `handleCommand`) |
| 1486-1522 | resubscribe | `resubscribeTimer`, `scheduleResubscribe` |
| 1524-1581 | link status | `isSimulated`, `connectionStatusPayload`, `clientStreamStatus`, `broadcastConnectionStatus` + 1 s timer (1581) |
| 1583-1635 | Elodin events | `connected` (register pass, `calibrationHost.elodin`, script status), 15 s script-status timer (1608), `dbError`, `disconnected`, `error` |
| 1637-1816 | ingest | `packet` handler: heartbeat → board status; parse (`expandWithTare(parseElodinPacket(…))` + `applyValveCalibration`); self-test; `_SEQUENCER_STATE`; per-row loop (ball-valve sensed, `actuator_state`, T7 alive, raw ADC, mission T+0, stats/ingest clock, downsample/emit) |
| 1818-1829 | crash guards | `uncaughtException`, `unhandledRejection` → log, keep alive |
| 1831-1885 | start | `syncElodinToSession`, `EADDRINUSE` retry (3 s), `startGuiStaticServer`, `listen` → `sessionManager.init(…)`, `syncElodinToSession()`, `startBoardLogReceiver(broadcast)` |

### 1.2 Shared mutable state — owner after the split, and who reads/writes it today

Read = R, write = W (assignment, or mutation of a Map/Set/object). Line numbers are today's.

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
| `_t7SlotToBoardId` | 351 | 360 (lazy fill in `uniqueIdFromPtEntity`), 577 (lazy fill in `noteT7Alive`), 855 (clear) | 363, 580 | `server/config-caches.ts` — one owner, two lazy fillers today |
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

Process-wide singletons used but not owned here: `sessionManager` (`session-manager.ts`), the
vtable registry's subscription state (`elodin-vtable-registry.ts`), board-scan rates
(`board-scan-rate.ts`), LC tares (`lc-tare.ts`), ball-valve endpoints (`ball-valve-cal.ts`), DHCP
status (`dhcp-status.ts`), board logs (`board-logs.ts`). WP6 leaves them where they are.

### 1.3 Startup effects, in order (the module body is the startup sequence)

| # | line | effect |
|---|---|---|
| 0 | 24-57, 298-303 | import evaluation (`legacy/state-actuators.ts` reads config at import and can log; `session-manager.ts` constructs `sessionManager`) |
| 1 | 129 | `setInterval(prune, 60 000)` |
| 2 | 133-137 | read `[gui]`, build both envelopes, log `GUI downsampling` |
| 3 | 233 | `setInterval(outbox drain, 100)` |
| 4 | 278 | `setInterval(outbox stats reset, 10 000)` |
| 5 | 285 | `setInterval(envelope flush, 50)` |
| 6 | 299 | read countdown target |
| 7 | 313-320 | `loadPTCalibration()`, log |
| 8 | 325, 329, 331 | sensor-role map, HP board set, T7 cal fields (config reads) |
| 9 | 375 | `calibrationHost` (pure) |
| 10 | 422 | `loadBoardsFromConfig()`, log |
| 11 | 430 | `getStateActuatorMap()` (CSV read, logs; a throw here kills the process — crash guards are not yet installed) |
| 12 | 599 | `setInterval(diagnostics, 5000)` |
| 13 | 724 | `setInterval(markStaleBoards, 1000)` |
| 14 | 753 | `stats.startTimeMs = Date.now()` (pure) |
| 15 | 774 | `configBootStateId()` (config read) |
| 16 | 781-782 | `new VideoService()` (reads `video.json`), `video.start()` |
| 17 | 784 | `createAPIHandler(…)` |
| 18 | 876, 901 | `http.createServer`, `new WebSocketServer({ server })` |
| 19 | 938 | `startDhcpStatusPoller()` |
| 20 | 939 | `setInterval(broadcastBoardStatus, 1000)` |
| 21 | 948 | `setInterval(keepalive, 30 000)` |
| 22 | 964 | `wss.on('connection')` |
| 23 | 1471 | `new ElodinClient(…)` (pure) |
| 24 | 1581 | `setInterval(broadcastConnectionStatus, 1000)` |
| 25 | 1583 | `elodin.on('connected')` |
| 26 | 1608 | `setInterval(refreshScriptStatus, 15 000)` |
| 27 | 1614-1637 | `elodin.on('dbError' / 'disconnected' / 'error' / 'packet')` |
| 28 | 1823-1829 | `process.on(uncaughtException / unhandledRejection)` |
| 29 | 1848 | `httpServer.on('error')` (EADDRINUSE → retry 3 s) |
| 30 | 1858-1859 | `startGuiStaticServer(GUI_PORT)` |
| 31 | 1861-1885 | `listen` → logs, `sessionManager.init(broadcast, broadcastNotification, onStopped, applyDeployedConfigChange, onSessionStarted)`, `syncElodinToSession()`, `startBoardLogReceiver(broadcast)` |

Three timers share the 1000 ms period: 13 (`markStaleBoards`), 20 (`broadcastBoardStatus`), 24
(`broadcastConnectionStatus`). Node fires same-period timers in registration order, so within one
second the board-health notifications precede the `board_status_update`, which precedes the
`connection_status`. That ordering is observable on the wire.

---

## 2. Target module boundaries

New directory `src/server/`. `src/server.ts` stays the entrypoint (systemd `npm run dev`,
`pipeline/run.sh:200`, `test_integration.sh:834`, `test/environmental-recovery.integration.ts:97`).

**Rule M1 — no import-time effects in `server/*`.** A `server/*.ts` module's top level holds only
imports, types, constants computed from `process.env`, literals or `import.meta.url` [A8,
STYLE-S30], pure constructors (`new Map`,
`new HistoryCache(…)`, `new ElodinClient(…)`) and function declarations. Every disk read, log line,
timer, listener and socket open happens in a function that `server.ts` calls.

M1 is a rule about the **top level of `server/*` files only**; it does not make their transitive
imports effect-free. `engine-state` and `commands` import `legacy/state-actuators.ts` (`state-csv/`
after WP5), which reads config and can log **at import** (`state-actuators.ts:79-81`:
`ACTUATOR_ABBREV_MAP`, `ACTUATOR_CHANNEL_BY_NAME`, `CSV_ACTUATOR_TO_ENTITY`). So a vitest that imports
`server/*` starts no timer, socket or listener, but whatever imports those two modules (and
`session-manager.ts`, which constructs `sessionManager` at import) reads the config named by the
environment. Any such test — G6 included — supplies a config fixture through the environment
(`CONFIG_PATH` pointing at a temp-dir `config.toml`, as `config-profile-create-calibration.test.ts`
does), never the checkout's `config/config.toml`.

**Rule M2 — the import graph is a DAG.** Each layer imports only from lower layers. ESM tolerates
cycles at import, but a cycle turns into a TDZ `ReferenceError` the moment a `const` is read during
evaluation, which is exactly the startup-order failure this split must not introduce.

| layer | module | single responsibility | public interface |
|---|---|---|---|
| 0 | `server/env.ts` | the process's environment knobs, read once | `WS_PORT`, `GUI_PORT`, `ELODIN_HOST`, `ELODIN_PORT`, `THIN_VERBOSE_CONNECTION_LOG`, `THIN_HEARTBEAT_DIAG_LOG`, `THIN_STATS_LOG` **[A1]** (the :9998 port is `SEQUENCER_PORT`, owned by WP5's `sequencer-client.ts`; `CTRL_SVC_PORT` is deleted by WP5) |
| 0 | `server/stats.ts` | ingest/broadcast counters served by `/stats` and `/api/debug` | `stats` |
| 1 | `server/ws-clients.ts` | the browser-facing socket set: send, broadcast, per-client sensor outboxes, link status, keepalive reaping | `WsWithControl`, `ClientStream`, `wss` (live binding), `attachWebSocketServer(server)`, `broadcast(msg)`, `send(ws, msg)`, `clientStreams`, `clientStreamStatus(ws)`, `flushClientOutboxes()`, `resetOutboxStats()`, `reapUnresponsiveClients()`, `KEEPALIVE_MS` |
| 2 | `server/notifications.ts` | operator notifications and their 5-minute replay buffer | `activeNotificationKeys`, `notificationBuffer`, `pruneNotificationBuffer(now)`, `broadcastNotification(payload)`; step 2 adds `raiseNotification`, `clearNotification` |
| 2 | `server/history.ts` | the rolling history cache and the backfill sent from it | `history`, `pruneHistory()`, `sendHistoricalData(ws, query?, onSent?)` |
| 2 | `server/mission-time.ts` | mission T+0 and the countdown target | `firstPacketTimeMs`, `countdownTargetMs` (live), `initMissionTime()`, `setFirstPacketTimeMs(ms)`, `setCountdownTargetMs(ms)`; step 2: `noteFirstSample(epochNow)`, `setCountdownTarget(ms)` |
| 2 | `server/config-caches.ts` | config-derived lookups on the Elodin hot path, rebuilt after a deploy | `hpBoardNumbersCache`, `t7CalFieldsCache` (live), `initConfigCaches()`, `resetConfigCaches()`, `uniqueIdFromPtEntity(entity)`, `t7BoardIdForSlot(slot)` |
| 3 | `server/sensor-stream.ts` | GUI downsampling and the two sample exits (immediate / windowed) | `guiStreamConfig`, `envelope`, `encoderEnvelope`, `broadcastLastTime` (step 1 only), `streamBudgetFor`, `saneSampleTimeMs`, `initGuiStream()`, `reloadGuiStreamConfig()`, `emitSensorPoint`, `emitSensorWindow`, `flushEnvelopes()`; step 2: `publishSample(high, low, parsed, epochNow)` |
| 3 | `server/calibration-state.ts` | the backend's half of calibration: PT coefficients, raw-ADC tracking, the `CalibrationHost` handed to `calibration-handler.ts` | `calibrationHost` (live), `initCalibrationState()`, `reloadCalibrationEntityMap()`, `lastRawAdc`; step 2: `noteRawAdc(entity, value)`, `setCalibrationElodin(client)` |
| 3 | `server/board-status.ts` | what the backend knows about each board: config baseline, heartbeats, T7 liveness, stale sweep and its notifications, self-test results, diagnostics log | `BOARD_STATUS_HZ`, `boardsStatus`, `loadBoardsFromConfig()`, `updateBoard(low, payload)`, `countHeartbeat(id)`, `noteT7Alive(slot)`, `markStaleBoards()`, `broadcastBoardStatus()`, `boardLabel(status)`, `logDiagnostics()`, `selfTestLatest`, `selfTestNotifiedBoards`; step 2: `noteSelfTestResults(boardId, rows, epochNow)` |
| 3 | `server/engine-state.ts` | the sequencer's state as the backend reports it: current state, debug mode, allowed set, refusal reasons, the CSV-derived commanded positions | `currentState`, `debugMode`, `STATE_ACTUATOR_MAP` (live), `initEngineState()`, `reloadStateActuatorMap()`, `configStateName(id)`, `getExpectedPositions(state)`, `broadcastCommandedActuatorsForState(state)`, `broadcastStateUpdate()`, `refreshScriptStatus()`, `setDebugMode(v)`, `applySequencerState(rows)` |
| 4 | `server/actuator-mismatch.ts` | the 5 s commanded-vs-sensed check | `actuatorSensedState`, `scheduleActuatorMismatchCheck(state)`; step 2: `noteSensedRow(row, rows)` |
| 4 | `server/elodin-link.ts` | the Elodin DB connection: connect/disconnect with the session, subscription passes, link health shown on the status badge | `elodin`, `noteIngest()`, `isSimulated()`, `connectionStatusPayload(extra)`, `broadcastConnectionStatus()`, `syncElodinToSession()`, `onElodinConnected`, `onElodinDbError`, `onElodinDisconnected`, `onElodinError` |
| 5 | `server/ingest.ts` | route each Elodin row to the module that owns what it says | `handleElodinPacket(header, payload)` |
| 5 | `server/commands.ts` | browser → backend messages and engine commands | `handleMessage(ws, msg)` (`handleCommand` stays module-private) |
| 6 | `server/ws-connection.ts` | one browser connection: identity, connect burst, wiring of its handlers | `handleConnection(ws, req)` |
| 7 | `server.ts` | composition root: the startup sequence (every timer, listener and startup read, in today's order), the HTTP server, `createAPIHandler` options, `applyDeployedConfigChange`, crash guards, `listen` | `applyDeployedConfigChange` (kept exported) |

Import edges (all downward): `ws-clients` → `client-outbox`, `shared/types`. `notifications`,
`history`, `mission-time` → `ws-clients`. `sensor-stream` → `ws-clients`, `history`, `stats`.
`calibration-state` → `ws-clients`. `board-status` → `ws-clients`, `notifications`, `stats`,
`config-caches`, `env`. `engine-state` → `ws-clients`, `history`, `stats`, `sequencer-client` [A1].
`actuator-mismatch` → `engine-state`, `notifications`. `elodin-link` → `env`, `ws-clients`,
`calibration-state`, `engine-state`. `ingest` → `elodin-link`, `board-status`, `engine-state`,
`actuator-mismatch`, `sensor-stream`, `mission-time`, `calibration-state`, `config-caches`,
`notifications`, `stats`, `env`. `commands` → `ws-clients`, `engine-state`, `mission-time`,
`history`, `calibration-state`, `elodin-link`, `sequencer-client` [A1: `handleCommand` sends four of
the five :9998 lines; the edge was missing]. `ws-connection` → everything above.

**[A6] Room for the D-SUB watchdog (PROPOSAL only, not in WP6).** A future liveness check ("an
accepted pair that has not delivered within T while its board heartbeats is re-subscribed") needs
`board-status`'s liveness inside `elodin-link`'s resubscribe loop. `elodin-link` (layer 4) importing
`board-status` (layer 3) is a downward edge, so the DAG allows it without restructuring; WP6 does not
add it (D17(d)), and nobody should "simplify" the layers so that it would become a cycle.
`elodin-link` keeps `scheduleResubscribe` and the four listeners verbatim so the watchdog has one
home.
**`server/*` never imports `api-server.ts` or `api/*`, and they never import `server/*`**: the HTTP
side reaches the WS side only through the `createAPIHandler` options, which `server.ts` builds.

The near-cycle this resolves: the connect burst needs the link status (`elodin-link`), which needs
`clientStreamStatus`, and `elodin-link` needs `broadcastConnectionStatus` → `send`. Putting
`clientStreams` and `send` in layer 1 and the connect handler in layer 6 keeps every edge downward.

Expected sizes: `server.ts` ~300 lines (DoD < 400); the largest modules `ingest.ts`,
`board-status.ts`, `ws-connection.ts` ~200-260 each; `env.ts`, `stats.ts` ~30.

---

## 3. Ownership and data flow

### 3.1 How state is passed: module singletons, not a context object

Each piece of state in §1.2 has **exactly one owning module**, which alone assigns it. Other modules
read it through the ESM live binding (`export let currentState`) or an exported function, and change
it only through a function the owner exports. There is no `ServerContext`.

Why, from this codebase:

- Every earlier extraction from `server.ts` already works this way — `board-scan-rate.ts`,
  `elodin-vtable-registry.ts`, `lc-tare.ts`, `ball-valve-cal.ts`, `countdown-state.ts`,
  `sessionManager` are module state plus exported functions. A context object would be a second
  pattern.
- The process holds one instance of everything. A context object would exist only to be threaded
  through ~60 functions, and it would recreate the god file as a type: every module would depend on
  every field, and the import graph would stop saying who touches what.
- Explicit injection is kept exactly where it already exists and breaks a real cycle:
  `createAPIHandler(opts)` (HTTP → WS side) and `sessionManager.init(callbacks)` (session → backend).
  `CalibrationHost` stays as it is: it is `calibration-handler.ts`'s existing interface, with two
  users (the backend and the calibration characterization harness).
- TypeScript enforces the write rule: assigning to an imported binding is a compile error (TS2632).
  `tsc --noEmit` is clean on the baseline (exit 0), and it is a **required gate step** (decision D-c):
  the singleton design is accepted only with it, because esbuild/tsx do not type-check and a missed
  setter would otherwise fail only when its line runs.
- Testability comes from rule M1, not from injection.

### 3.2 A WS command (e.g. `state_transition`)

1. `ws-connection.handleConnection` registered `ws.on('message')`: `inboundMessages++`,
   `JSON.parse`, `commands.handleMessage(ws, msg)`, all in one try/catch (§4.2).
2. `handleMessage` switches on `type`; `SEND_COMMAND` → `handleCommand`.
3. `handleCommand` checks `CONTROL_COMMAND_TYPES` against the socket's `__daqControlAuthorized`
   (set by `CONTROL_UNLOCK`; `WsWithControl` from `ws-clients`), resolves the id through
   `engine-state.configStateName` and the config's `[[states]]`, validates `holdMs`, maps the name
   through `STATE_TO_CSV_NAME`, and calls `sendToSequencer('TRANSITION:<name>[:<ms>]\n')` [A1].
4. Reply: `ok` → log only; not ok → `send(ws, ERROR "State transition failed: <refusalText(reply)>")`
   to the requesting socket only. There is no optimistic update.
5. The real state arrives later as Elodin `_SEQUENCER_STATE` (§3.3) and is broadcast to everyone.

Other commands: `debug_mode` → on `ok`, `engine-state.setDebugMode` + `broadcastStateUpdate()` (the
Elodin path then broadcasts a second identical `state_update` — recorded defect, kept);
`set_countdown_target` → `mission-time.setCountdownTargetMs` + save + broadcast; session commands →
`sessionManager`, then `elodin-link.broadcastConnectionStatus()`; `CALIBRATION_COMMAND` →
`handleCalibrationCommand(calibrationHost, ws, payload)`; `QUERY_HISTORICAL` →
`history.sendHistoricalData`; `get_state_transitions` → `state-csv` loader, re-read on every request.

### 3.3 An Elodin update

1. `elodin-link`'s client emits `packet`; `server.ts` registered `ingest.handleElodinPacket`.
2. `notePairDelivered(high, low)` (registry). `[0x10]` → `board-status.countHeartbeat` +
   `updateBoard` → maybe `broadcastBoardStatus`; return.
3. Parse: `applyValveCalibration(expandWithTare(parseElodinPacket(id, payload, hpBoardNumbersCache,
   t7CalFieldsCache)))` — this exact expression stays at the parse site (`lc-tare.test.ts` guards it).
4. Self-test `[0x60..0x6F]` → `selfTestLatest`; first failure per board → `self_test_fail_<id>`
   notification (board-status in step 2).
5. `_SEQUENCER_STATE` → `engine-state.applySequencerState(rows)` (sets allowed set, state, debug,
   counts, `broadcastStateUpdate`, `broadcastCommandedActuatorsForState`), then
   `actuator-mismatch.scheduleActuatorMismatchCheck(currentState)`; return.
6. Per finite row, in this order (the order is behaviour): ball-valve sensed state →
   `actuatorSensedState` (+ recheck if a mismatch is active); `actuator_state` → same; T7 raw →
   `board-status.noteT7Alive`; `raw_adc_counts` → `lastRawAdc[uniqueIdFromPtEntity]`; first row ever
   → mission T+0 broadcast; `stats` + `elodin-link.noteIngest()` + `recordBoardScanIngest`; then
   `sensor-stream`: budget `null` → `emitSensorPoint` (history + broadcast now); `gui` + throttle mode
   → 50 ms gate → `emitSensorWindow`; else envelope `add` → `emitSensorWindow` on window close.
7. `emitSensorWindow` records to `history` **before** staging to each `clientStreams` outbox; the
   100 ms `flushClientOutboxes` drains outboxes per socket (`ws-clients`). Tare is applied in step 3,
   before both sinks, so live data and reconnect backfill agree.

### 3.4 An HTTP request

`server.ts`'s `http.createServer` handler: `GET /stats` → `stats` + `uptimeMs`; else
`await apiHandler(req, res)` (WP7's router) inside try/catch → 500 `{"error":"Internal server
error"}` if headers are not yet sent; else bare 404. The HTTP side reaches backend state only through
the options `server.ts` passes: `getEngineState` (reads `currentState`), `getDebugInfo` (reads
`elodin`, `wss`, `clientStreams`, `history.size`, `stats`, board-scan rates), `onStateCsvUpdated`
(`reloadStateActuatorMap` + `CONFIG_UPDATED`), `onCalibrationReload` (`publishCalibrationReload`),
`onConfigUpdated` (`applyDeployedConfigChange`). WP7 does not change this seam.

### 3.5 The connect burst (frozen order, `pipeline/golden/ws_handshake.txt`, `lifecycle/golden/startup.txt`)

`connection_status` (with this socket's `connId`, `c<N>`) → `control_status` → `mission_start_time`
(only if T+0 is set) → `countdown_target_update` → `session_update` → `state_update` (**connect
shape: no `allowedBitmask`/`stateRefusalReasons`**, unlike `broadcastStateUpdate`) →
`board_status_update` (if any board) → commanded snapshot `sensor_update`s → self-test replay →
notification replay (pruned first) → `historical_data` chunks (not awaited). `ws-connection.ts`
owns this sequence; it reads the other modules' live bindings and never assigns them.

---

## 4. Error handling

### 4.1 Today, per failure

| failure | today | where after split |
|---|---|---|
| Elodin disconnect | `disconnected`: log `Elodin DB disconnected`, `lastIngestMs = 0`, `broadcastConnectionStatus()` (badge `elodinConnected:false, dataFresh:false`, frozen in `lifecycle/golden/shutdown.txt`), clear resubscribe timer, `clearSubscriptionState()`; `ElodinClient` reconnects on its own unless `disconnect()` was called (session stop in systemd mode) | `elodin-link.onElodinDisconnected`, verbatim |
| Elodin socket error | log `Elodin error: <msg>` only | `elodin-link.onElodinError` |
| subscription refused | `noteSubscriptionRejected` only (no immediate retry) | `elodin-link.onElodinDbError` |
| `registerVTables` rejects on connect | no `.catch` (1590): goes to `unhandledRejection` → logged, process lives; the retry ladder is not started from that pass | unchanged (kept without a catch; recorded) |
| packet handler throws | one try/catch around the whole handler: `Packet error` logged, packet dropped | `ingest.handleElodinPacket`, verbatim |
| non-JSON WS message, or a handler that throws | one try/catch around parse **and** dispatch: `Bad message` logged, **no reply** | `ws-connection` message listener |
| unknown WS `type` | `Unknown message type` warned, no reply | `commands.handleMessage` |
| unknown `commandType` | `ERROR "Command not supported in thin backend: <type>"` to the sender | `commands.handleCommand` |
| control command while locked | `ERROR "Control locked: …"` to the sender | `commands.handleCommand` |
| TCP :9998 refused / closed / 2 s timeout | the line client never rejects: resolves `{ok:false, reply: err.message \| 'connection closed' \| 'timeout'}` and warns `actuator_service connect error`. `state_transition`, `actuator`, `extend_fire` → `ERROR "<Action> failed: <refusalText(reply)>"` to the sender; `debug_mode` → log only, no reply, no state change; `SCRIPTS` poll → swallowed | WP5's `sequencer-client.ts` [A1] + `commands`/`engine-state`, verbatim |
| TCP :9999 | no caller (`sendToControllerService` is dead) | — (see open question Q1) |
| session start/stop/extend fails | `ConfigIssuesError` → `SESSION_START_BLOCKED` to the sender; else `ERROR "Session <verb> failed: <msg>"` | `commands` |
| HTTP: API handler throws past WP7's own catch | 500 `{"error":"Internal server error"}` if headers unsent, logged | `server.ts` |
| HTTP: non-`/api`, non-`/stats` | 404, no body, no content-type | `server.ts` |
| port in use | log, retry `listen` after 3 s, forever | `server.ts` |
| anything uncaught | `UNCAUGHT EXCEPTION` / `UNHANDLED REJECTION` logged, process lives | `server.ts` |
| SIGTERM / SIGINT | no handler: default action (`exit -15` / `-2`, WS clients see 1006) | `server.ts` — **do not add a handler** |
| timer callback throws | uncaught → guard logs; Node re-arms the interval in a `finally`, so it keeps running | unchanged |

### 4.2 Keeping it identical

Every boundary's try/catch moves with its body, unchanged, including what it covers (the WS message
catch covers dispatch too; the packet catch covers the whole handler). No new catch is added in step
1. Promise chains keep their `.then`/`.catch` shape (an added `.catch` changes which guard logs).

### 4.3 One pattern going forward

Errors are caught **at the boundary where input enters**, and nowhere else:

| boundary | module | on error |
|---|---|---|
| browser message | `ws-connection` | **today, kept** [A8, STYLE-S10]: log `[ThinServer] Bad message:`, drop, no reply. Not a pattern for new code; the direction is one `ERROR` per failed request, once G10 freezes today's silence and the team approves |
| browser command | `commands` | reply `ERROR` to the sender only: `"<Action> failed: <reason>"` |
| Elodin row | `ingest` | log `[ThinServer] Packet error:`, drop the packet |
| sequencer line | `sequencer-client` [A1] | never reject; `{ok, reply}` |
| HTTP request | `api-server` (WP7), then `server.ts` | 500 JSON |
| process | `server.ts` | crash guards |

Inner modules (`board-status`, `engine-state`, …) do not catch-and-log unless the catch encodes a
decision (config missing → defaults, as `configStateName` and `configBootStateId` do). The existing
exceptions — `debug_mode` failing silently, the `SCRIPTS` poll swallowing, the uncaught
`registerVTables` rejection — are kept and listed as Parked inconsistencies, not fixed in WP6.

---

## 5. Naming conventions

- **Files:** kebab-case `.ts`, one responsibility each, under `src/server/`. A module is named for
  what it owns (`board-status`, `engine-state`), not for a pattern (`*-manager`, `*-service`,
  `*-handler` — `calibration-handler.ts`, `session-manager.ts` keep their names).
  `server/sensor-stream.ts` is the wiring; `gui-stream.ts` stays the pure envelope library.
- **Functions:** `handle<Input>` for the four input boundaries (`handleConnection`, `handleMessage`,
  `handleCommand`, `handleElodinPacket`); `on<Source><Event>` for event listeners
  (`onElodinConnected`); `init<Thing>()` for a startup read that assigns owned state;
  `reload<Thing>()` / `reset<Thing>()` for the post-deploy rebuild; `broadcast<Thing>()` sends to
  every client, `send` to one; `note<Thing>()` records an observation (the existing
  `notePairDelivered`, `noteT7Alive`); `set<Thing>()` is the owner's single writer for a scalar.
  Inline timer arrows become named functions named for what they do (`flushClientOutboxes`,
  `resetOutboxStats`, `flushEnvelopes`, `logDiagnostics`, `reapUnresponsiveClients`,
  `pruneHistory`).
- **Types:** PascalCase, no prefixes; existing names kept (`ClientStream`, `WsWithControl`,
  `StreamBudget`, `CalibrationHost`).
- **State:** camelCase. Step 2 renames `STATE_ACTUATOR_MAP` → `stateActuatorMap` (it is mutable),
  `_hpBoardNumbers` → `hpBoardNumbersCache`, `_t7CalFields` → `t7CalFieldsCache`,
  `_ptSlotToBoardId` → `ptBoardIdBySlot`, `_t7SlotToBoardId` → `t7BoardIdBySlot`. Constants stay
  SCREAMING_SNAKE.
- **Not renamed** (observable or harness-read): the `[ThinServer]`, `[WS_BACKEND]` log prefixes and
  message texts, the per-socket `__daqOperator` / `__daqControlAuthorized` / `__daqAlive` properties
  (internal, but cheap to keep), env var names, notification keys.

---

## 6. Move-only pass, then cleanup

### 6.1 Step 1 — mechanical moves, no behaviour change

Rules for every commit in step 1:

- **R1 (import order).** `server.ts` keeps **all** of today's import statements, in today's order
  (unused ones included; `tsconfig` has no `noUnusedLocals`), and adds the `./server/*.js` imports
  **after** them. ESM evaluates each module once, at its first import, depth-first in source order;
  every pre-existing module therefore evaluates exactly when it does today, and the new modules
  (M1: no effects) add nothing to the sequence. **Import closure (DoD check):** every module a
  `server/*` file imports must already be in `server.ts`'s import list (directly), so no
  `server/*` import is ever the first import of anything. After WP5 the only permitted exception is
  `sequencer-client.ts` [A1] (already imported by `server.ts` after WP5, so in practice none), and
  only while it stays effect-free. Check:

  ```bash
  cd diablo_server/backend/src
  have=$(grep -oE "from '\./[^']+'" server.ts | sed "s/from '\.\///; s/'$//" | sort -u)
  need=$(grep -ohE "from '\.\./[^']+'" server/*.ts | sed "s/from '\.\.\///; s/'$//" | sort -u)
  comm -13 <(echo "$have") <(echo "$need")   # prints nothing
  ```

  (Imports of `../../shared/*` from `server/*` become `../../../shared/*`; compare those the same
  way against `server.ts`'s `../../shared/*` list.)

  **[A2] R1 amended — the textual rule is necessary, not sufficient.** tsc, tsx/esbuild and vitest
  delete an import declaration none of whose specifiers is used as a value
  (`research/node-realtime-backend.md` §1, reproduced with this repo's tsx 4.21; it already
  happens today: `api-server.ts` → `elodin-query.ts`, `calibration-handler.ts` → `calibration.ts`
  and `ws`). "Today's evaluation order" is therefore the order of the imports that **survive emit**,
  and a step-1 commit that moves the last value user of an import out of `server.ts` silently
  moves that module's evaluation to wherever the first `server/*` file imports it, while the
  import-closure grep above still passes. The live case is `server.ts:39` → `state-csv/state-actuators.ts`
  (builds three config maps and can log **at import**; nothing else imports it): once
  `engine-state`/`commands` hold every use, the line is elided. So, for every step-1 commit:

  - **R1a (bare import).** When a commit leaves an import in `server.ts` with no specifier used as
    a value, rewrite that declaration as a bare side-effect import **at the same position**
    (`import './state-csv/state-actuators.js';`). A bare import is never elided. This is a
    move-only edit (it is the textual form of "this module still evaluates here"); the review rule
    of §6.3 accepts it. Do it **only** for a module the R1b list shows evaluating first at that
    line *before* the commit; never for an import that is already elided today (type-only or
    unused, e.g. `import type { StateActuatorMap }`): a bare import there would **add** a module
    to the evaluation set — a behaviour change.
  - **R1b (runtime order, the check that counts).** Diff the esbuild bundle's module order before
    and after the commit; the only permitted difference is new `server/*` entries (effect-free by
    M1). The command (§6.3 item 6) runs in under 1 s, binds no port and needs no stack lock.
  - **R1c.** Never enable `verbatimModuleSyntax` (or `isolatedModules`-driven `import type`
    rewrites) to "pin" imports: it would add `elodin-query.ts` to today's evaluation set and move
    `calibration.ts` ahead of `calibration-handler.ts` (research §1, remedy 3) — a behaviour change.
- **R2 (startup order).** Every row of §1.3 stays a statement in `server.ts`, in the same order:
  `setInterval(<named fn>, <same ms>)`, `<module>.init…()`, `elodin.on('<event>', <named fn>)`.
  Only pure steps (9, 14, 23) may sit at a module's top level.
- **R3 (bodies verbatim).** A moved function's body is byte-identical except: (a) an assignment to a
  binding now owned by another module becomes that owner's setter call (the complete list is in
  §6.2); (b) the `_SEQUENCER_STATE` block is split as described in step 1.11. Object, `Map` and
  `Set` mutations through imported references (`activeNotificationKeys.add`,
  `calibrationHost.elodin = …`, `actuatorSensedState.set`) stay as they are until step 2.
  So step 1 also exports the containers its moved bodies mutate from other modules:
  `activeNotificationKeys`, `notificationBuffer`, `selfTestLatest`, `selfTestNotifiedBoards`,
  `actuatorSensedState`, `lastRawAdc`, `clientStreams`, `broadcastLastTime`, `envelope`,
  `encoderEnvelope`, and `_t7SlotToBoardId` (which `noteT7Alive` in board-status fills until step
  2.4). `_ptSlotToBoardId` stays private to `config-caches`.
- **R5 (no re-export copies).** Never `export const x = y` (or `export let x = y`) where `y` is an
  imported `let`: that copies the value once and stops following the owner. Re-export with
  `export { y } from './owner.js'`, which keeps the live binding.
- **R4 (one commit per module)**, in the order below, each green on its own (§6.3).

| # | commit: create | cut from `server.ts` (today's lines) | exports | notes |
|---|---|---|---|---|
| 1.1 | `server/env.ts` | 61, 73-79, 1858 (`GUI_PORT`) | env constants | `CONTROL_COMMAND_TYPES` and `WsWithControl` go elsewhere |
| 1.2 | `server/stats.ts` | 740-754 (+ comment 726-733) | `stats` | `lastIngestMs`/`DATA_FRESH_MS` (734-738) go to 1.13 |
| 1.3 | `server/ws-clients.ts` | 66-72 (`WsWithControl`), 187-209 (`ClientStream`, `clientStreams`), 233-274 body → `flushClientOutboxes`, 278-280 body → `resetOutboxStats`, 901 → `attachWebSocketServer(httpServer)` assigning `export let wss`, 904-917 (`broadcast`, `send`), 941-960 body → `reapUnresponsiveClients` + `KEEPALIVE_MS`, 1557-1562 (`clientStreamStatus`) | see §2 | `server.ts` keeps `setInterval(flushClientOutboxes, 100)` at row 3, `setInterval(resetOutboxStats, 10_000)` at row 4, `attachWebSocketServer(httpServer)` at row 18, `setInterval(reapUnresponsiveClients, KEEPALIVE_MS)` at row 21. **Same commit: re-point the drain slice of `__tests__/lc-tare.test.ts:199-202`** to `server/ws-clients.ts`. From this commit on, `server.ts` no longer contains `cs.outbox.drain()`, both `indexOf` calls return -1, the slice is empty and the two `not.toContain` assertions pass vacuously — the test goes silent here, not red at 1.14. Add a non-vacuity assertion that both anchors are found (`indexOf(...) > -1` for `cs.outbox.drain()` and `cs.pacer.noteFlush`). Mutation to re-run: move the tare into the drain (subtract a `force_kg_tared` offset between the two anchors) → red |
| 1.4 | `server/notifications.ts` | 627, 633-652 | see §2 | |
| 1.5 | `server/history.ts` | 81-86, 122-126, 129 body → `pruneHistory`, 1148-1203 | `history`, `pruneHistory`, `sendHistoricalData` | `broadcastLastTime` (127) goes to 1.7 |
| 1.6 | `server/mission-time.ts` | 297-299 → `export let` + `initMissionTime()` | + `setFirstPacketTimeMs`, `setCountdownTargetMs` | `mission-time.ts` imports `countdown-state.js`; **`server.ts` keeps its own `countdown-state.js` import** (R1: it stays at its position, today line 298, so `countdown-state` still evaluates there) |
| 1.7 | `server/sensor-stream.ts` | 90-118, 127, 133-141 → `initGuiStream()` (assigns `guiStreamConfig`, `envelope`, `encoderEnvelope`, logs), 163-185, 211-227, 285-293 body → `flushEnvelopes` | see §2 | 143-161 (`configStateName`) goes to 1.11 |
| 1.8 | `server/config-caches.ts` | 327-373 (+ the T7 map 350-351); 329/331 initialisers → `initConfigCaches()`; 854-857 → `resetConfigCaches()` | see §2 | `noteT7Alive`'s own lazy fill (575-579) moves with `noteT7Alive` in 1.10, unchanged |
| 1.9 | `server/calibration-state.ts` | 305-325 (load → `initCalibrationState()`), 375-384 (host built inside `initCalibrationState()`, after the load), 852-853 → `reloadCalibrationEntityMap()` | see §2 | the host must be built after `loadPTCalibration` (it copies the path by value; frozen in `ws_events.txt` `calibration_command`) |
| 1.10 | `server/board-status.ts` | 87-89, 386-420 (call at 422 stays in `server.ts`), 519-594, 596-618 (timer body → `logDiagnostics`), 622-626, 628-631, 654-722 (timer at 724 stays), 919-936 (937-939 stay: `startDhcpStatusPoller()` and the timer) | see §2 | `logDiagnostics` reads `stats` and `wss.clients.size` (import from 1.2/1.3) |
| 1.11 | `server/engine-state.ts` | 143-161, 424-470 (430 → `reloadStateActuatorMap()`, called at row 11 and from the two callbacks), 756-775 (774 → `initEngineState()`), 1236-1265; **the body of 1697-1720 → `applySequencerState(parsedList)`** without its last two statements | see §2 | in `ingest`: `if (parsedList[0]?.entity === '_SEQUENCER_STATE') { applySequencerState(parsedList); scheduleActuatorMismatchCheck(currentState); return; }` — same order as today. `server.ts` keeps `setInterval(refreshScriptStatus, 15000)` at row 26 |
| 1.12 | `server/actuator-mismatch.ts` | 472-517 | see §2 | |
| 1.13 | `server/elodin-link.ts` | 734-738 (+ `noteIngest()` = `lastIngestMs = Date.now()`), 1471, 1486-1555, 1564-1576, 1583-1602 → `onElodinConnected`, 1610-1635 → `onElodinDbError`, `onElodinDisconnected`, `onElodinError`, 1831-1846 (`syncElodinToSession`) | see §2 | `server.ts` keeps `setInterval(broadcastConnectionStatus, 1000)` at row 24, then `elodin.on('connected', onElodinConnected)`, row 26, then the other `on`s in today's order. Keep the log text `Connected to Elodin, subscriptions sent.` |
| 1.14 | `server/ingest.ts` | 1637-1816 → `handleElodinPacket(header, payload)` | | `server.ts`: `elodin.on('packet', handleElodinPacket)`. **Same commit:** re-point the parse-site assertion of `__tests__/lc-tare.test.ts:196-197` (`expect(src).toContain('expandWithTare(parseElodinPacket(')`) to `server/ingest.ts` (the drain slice was re-pointed in 1.3). Mutation to re-run: drop the `expandWithTare(` wrapper → red. Both lc-tare edits follow D18 by analogy: assertions unchanged except anchors and paths, mutations re-run, orchestrator reviews the diff |
| 1.15 | `server/commands.ts` | 62-64, 1205-1234, 1267-1407, 1473-1484 (`STATE_TO_CSV_NAME`) | `handleMessage` | |
| 1.16 | `server/ws-connection.ts` | 902, 962-1146 → `handleConnection(ws, req)` | | `server.ts` row 22: `wss.on('connection', handleConnection)` |

**Call order for rows 7-9.** `server.ts` calls `initCalibrationState()` (PT load and its log,
sensor-role map, then the host object) and **then** `initConfigCaches()` (`hpBoardNumbers()`,
`t7CalFields()`). Today the host (375) is built after the two cache reads (329, 331); in this order it
is built before them. That is harmless: building the host is pure (an object literal over values
already loaded), and the two cache reads log nothing and do not read the host, so no observable
effect moves. The I/O order — PT file, role map, HP set, T7 fields — is unchanged.

What remains in `server.ts`: header comment, imports (R1), the startup sequence (rows 1-31 as
statements), `video`, `createAPIHandler({…})` with its five options (bodies verbatim, now reading
imported bindings), `applyDeployedConfigChange` (body verbatim with 852-857 replaced by
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
| `currentState =`, `debugMode =`, `allowedBitmask =` (1703, 1710, 1711, `ingest`) | inside `applySequencerState` (moved block) |
| `STATE_ACTUATOR_MAP = getStateActuatorMap()` (817, 861, `server.ts`) | `reloadStateActuatorMap()` (throws through; each caller keeps its try/catch and warning text) |
| `calChannelToEntityMap = …; calibrationHost.channelToEntityMap = …` (852-853) | `reloadCalibrationEntityMap()` |
| `_ptSlotToBoardId.clear(); _t7SlotToBoardId.clear(); _hpBoardNumbers = …; _t7CalFields = …` (854-857) | `resetConfigCaches()` (same four statements, same order) |

`tsc --noEmit` rejects any missed one (TS2632, assignment to an import).

### 6.3 Checks for every step-1 commit

**Every commit** (no ports, no lock unless stated):

1. `npx tsc --noEmit` in `diablo_server/backend/` — exit 0 (required, decision D-c).
2. Backend `npm test`, no failure outside `test/characterization/baseline_vitest_failures.txt`.
3. Cycle grep: no `server/*` file imports `ws-connection`, `commands` or `ingest`, and none imports
   `api-server` or `api/`; plus the import-closure check of R1.
   `grep -lE "from '\./(ws-connection|commands|ingest)\.js'|api-server|\.\./api/" src/server/*.ts`
   prints nothing.
4. **Startup-order script.** Extract, in order, every startup statement in `server.ts`'s top level —
   `setInterval(<fn>, <ms>)`, `elodin.on('<event>'`, `wss.on('<event>'`, `<name>()` calls of
   `init*` / `load*` / `reload*` / `start*` / `attachWebSocketServer`, `video.start()`,
   `httpServer.on` / `listen`, `process.on` — and compare with the expected list derived from §1.3:

   ```bash
   cd diablo_server/backend/src
   grep -E "^(setInterval\(|elodin\.on\('|wss\.on\('|(init|load|reload|start)[A-Za-z]*\(|attachWebSocketServer\(|video\.start\(|httpServer\.(on|listen)\(|process\.on\()" server.ts \
     | sed -E 's/\{.*$//' > /tmp/startup-order.txt
   diff /tmp/startup-order.txt startup-order.expected   # must print nothing
   ```

   WP6's first commit adds `startup-order.expected` (§1.3 rows 1-31 in this form; kept with the
   package's script, not under `src/`); every later step-1 commit must diff empty against it. This is
   what guards G11 and the row order of §1.3; no golden does.
5. **Startup log diff** (G12): start `src/server.ts` alone for 5 s under the stack lock (one short
   hold), with the pipeline fixture's environment (`CONFIG_PATH` = a fixture config with
   127.0.0.x boards, `SESSION_SERVICE_MODE=mock`, `GUI_PORT=0`, 264xx ports, no Elodin), and diff the
   first 60 lines of its output against the same run on `backend-remastered`. Identical after
   normalising timestamps and PIDs.
6. **[A2] Module-evaluation-order diff** (R1b; replaces nothing above — it catches a reordered
   module that happens not to log under the test config, which item 5 cannot see). esbuild's
   bundle concatenates modules in evaluation order with a `// <path>` banner per module and this
   graph has no lazy `__esm` wrappers, so the list is exact:

   ```bash
   cd diablo_server/backend
   order() { npx esbuild src/server.ts --bundle --platform=node --format=esm --packages=external \
     --log-level=error | grep -E '^// (src|\.\./)' \
     | awk '{last[$2]=NR; o[NR]=$2} END{for(i=1;i<=NR;i++) if(last[o[i]]==i) print o[i]}'; }
   order > /tmp/order-after.txt          # and the same on the parent commit → /tmp/order-before.txt
   diff <(grep -v '^src/server/' /tmp/order-before.txt) <(grep -v '^src/server/' /tmp/order-after.txt)   # must print nothing
   ```

   It writes nothing to disk and starts nothing. Whether the list is frozen as a file (a de-facto
   golden) or only diffed per commit is the orchestrator's call (research Q2); this note asks only
   for the per-commit diff.

**At checkpoints only** — after commits 1.7, 1.13 and 1.16 — under the stack lock, within AGENT-RULES
rule 7's hold limit (≤ ~5-10 min per hold; split across holds if needed): `pipeline/run.sh pt`,
`nocal`, `boards`, `lifecycle/run.sh`. `test_integration.sh` (`ws_data_flow_test`) runs in the merge
queue's full gate.

Review with `git diff --color-moved=dimmed-zebra
--color-moved-ws=allow-indentation-change backend-remastered -- diablo_server/backend/src`: every
non-moved line must be an import (including an R1a bare import [A2]), an `export` keyword, a
function wrapper for a former inline arrow, a setter from §6.2, or a startup statement in
`server.ts`. A line that only re-indents or rewraps a moved statement (a timer arrow's body
becoming a named function's body) is an expected non-dimmed line, not a stop [A8, D43(6)].

### 6.4 Step 2 — cleanup toward the target

Each is its own commit, each with the §6.3 checks. Order matters only where noted.

1. **`ingest` becomes a router.** Move each row block into its owner, keeping the per-row order of
   §3.3 step 6: self-test → `board-status.noteSelfTestResults` (the `break` after the first failure
   stays); ball-valve and `actuator_state` → `actuator-mismatch.noteSensedRow`; raw ADC →
   `calibration-state.noteRawAdc`; T+0 → `mission-time.noteFirstSample`; counters →
   `stats`; downsampling → `sensor-stream.publishSample` (then `broadcastLastTime`, `envelope`,
   `encoderEnvelope` stop being exported).
2. **Owner-only mutation.** `notifications.raiseNotification(key, payload)` /
   `clearNotification(key, payload)` replace the 5 broadcast-then-`add` (512, 678, 697, 712, 1690)
   and 4 broadcast-then-`delete` (515, 681, 703, 716) pairs (broadcast first, as today); the one-shot `connected` info stays `broadcastNotification`.
   `calibration-state.setCalibrationElodin`.
3. **Slot rule** (after G6 exists): `config-caches.ts`'s `bid % 10, 0 → 10` (today 344-345) →
   WP5's `boardSlot()`. Allowed only if **either** WP5's `boardSlot()` body is literally
   `const m = id % 10; return m === 0 ? 10 : m;` (then it is the same expression for every number,
   the `typeof bid === 'number'` guard staying in the caller), **or** G6 also freezes negative
   (`-21`), non-integer (`21.5`) and `NaN` board_ids, so that any extra validation in `boardSlot()`
   shows up.
4. **One T7 slot lookup.** `t7BoardIdForSlot(slot)` replaces both lazy fillers (360 and 577). The
   two catches differ (`/* no T7 uid */` vs `return`), but they are equivalent: the only throws come
   from `readConfig()` or `t7Channels()` before the loop sets anything, so after either catch the map
   is empty and the lookup yields `undefined`, which both callers treat as "no board".
5. **Renames** of §5.
6. **Imports last.** ~~Prune `server.ts` to what it uses … only import-time warnings from
   `legacy/state-actuators` may move.~~ **[A2]** Mostly moot: an import with no used specifier is
   already absent at runtime, so pruning a specifier (`resetTareState`, `setRunDir` from a line
   that keeps `expandWithTare`) changes nothing, and R1a's bare imports **stay** (they are the
   evaluation points). Prune only specifiers; never delete a bare import or turn one back into a
   named import that a later edit could leave unused. Gate: §6.3 item 6 diff empty and the 60-line
   log diff (item 5) identical — no warning may move.
7. ~~Replace the `lc-tare.test.ts` source-text check with a real test.~~ **Moved out of WP6**
   (decision): a separate test-only package, after step 1 has merged.
8. **[A4] Connect-burst replays move to their owners** (should; after G9 and G13 exist). Walkthroughs
   (a)-(c) found `ws-connection` building other modules' messages from their live bindings. Each
   owner gets a function that sends its part of the burst to one socket and returns the number of
   frames it sent; the bodies are today's lines verbatim (same literals, same key order):
   `engine-state.sendConnectStateUpdate(ws)` (the **connect** shape, no `allowedBitmask` /
   `stateRefusalReasons` — kept distinct from `broadcastStateUpdate`),
   `engine-state.sendCommandedSnapshot(ws)`, `board-status.sendBoardStatus(ws)` (0 when no board,
   as today; no `dhcp`/`frequencyHz` recompute, as today), `board-status.sendSelfTestReplay(ws)`,
   `notifications.sendNotificationReplay(ws)` (prunes first, as today),
   `mission-time.sendMissionStartTime(ws)` and `mission-time.sendCountdownTarget(ws)`.
   `ws-connection` keeps the order of §3.5, the `control_status` frame (identity is its own), the
   `session_update` frame (`sessionManager` is not WP6's) and the `conn_open`/`conn_close`
   counters: `outboundMessages += n` per call, and **no** increment for `mission_start_time` and
   `session_update`, as today (D-WS quirk, kept). `lastOutboundAt` becomes `Date.now()` after each
   call that sent ≥ 1 frame; today the notification replay stamps the time taken *before* its
   sends and the commanded snapshot stamps after each frame, so the logged value can differ by
   the milliseconds a burst takes — a log-only field that G13 normalises; if G13 is not added,
   skip this step rather than ship an unguarded log change.
9. **[A3] One owner for state-id resolution** (should). Walkthrough (a) found "what state id N
   means" decided in two modules: `engine-state.configStateName` (the name shown in
   `state_update` and the mismatch text) and `commands` (the `[[states]]`-declared check, the
   `SystemState` enum fallback, `STATE_TO_CSV_NAME`). Move the second half into `engine-state` as
   `resolveTransitionTarget(id)`, returning `{ ok: true, stateName, csvName }` or
   `{ ok: false }` (id not declared by a config that declares states). Body verbatim, reads in
   today's order (`configStateName(id)` — the deployed-config cache — then `readConfig().states`);
   `STATE_TO_CSV_NAME` moves with it. `commands` keeps the warn line, the `ERROR` reply text, the
   `holdMs` check (still after the id check, as today) and the line format.

Step 2 is its own queue item, gated in full like step 1; each commit runs the per-commit checks of
§6.3 and the checkpoint runs after 2.1 and at the end.

### 6.5 Deliberately NOT changed (observable)

- Message `type` strings (including the literal `get_state_transitions` / `state_transitions`),
  payload field names and **key order** of every object literal (moved verbatim; see G9).
- The two `state_update` shapes (connect vs broadcast), the double `state_update` on `debug_mode`,
  the connect-burst order (§3.5), `connId` `c<N>` and its counter.
- Error and notification texts, including `Command not supported in thin backend: …`; notification
  keys `board_lost_<id>`, `setup_stuck_<id>`, `unrecognized_<id>`, `self_test_fail_<id>`,
  `actuator_mismatch`.
- Every period and delay: 50 ms throttle and envelope flush, 100 ms outbox drain, 1 s board status /
  stale sweep / connection status (and their firing order), 5 s stale threshold, 4 s setup-stuck,
  5 s mismatch delay, 5 s resubscribe minimum, 15 s script poll, 30 s keepalive, 60 s prune, 10 s
  outbox reset, 500 ms T7 mark, 3 s data-fresh, 60 s sample skew, 2 s TCP timeout, 3 s EADDRINUSE
  retry, 5 min / 500 notification buffer, 3000 points per backfill series.
- `/stats` and `/api/debug` keys (`useRelay: false` included); `CONFIG_UPDATED` after a deploy.
- Fire-and-forget backfill on connect; no optimistic state; the backend never sends FIRE_*.
- No signal handlers; crash guards; the `[ThinServer]` log lines, the conn_open/conn_close JSON
  (including its counters, which skip `mission_start_time` and `session_update` — a log quirk, kept).

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
| tare at the parse site | `__tests__/lc-tare.test.ts:192-203` | re-pointed in 1.14 |
| end to end (calibration capture via `lastRawAdc`, LC tare, ball valve, T7, sample conservation) | `test/ws_data_flow_test.ts` via `test_integration.sh` | gate |

### Gaps — a move could change these and no golden would notice

Each is a test to add **before** the step that touches it. G1-G5, G7-G10 belong in
`test/characterization/**` (C0-owned); G6 is a backend vitest that WP6 adds itself; G11 and G12 are
WP6's own per-commit scripts (§6.3).

| gap | priority (orchestrator) | must exist before |
|---|---|---|
| G7 + G8 | MUST | step 1 |
| G1 | MUST | commits 1.11 / 1.12 (feasibility below) |
| G10 | MUST | commits 1.15 / 1.16 |
| G4 | MUST, owned by WP5 | WP5 lands |
| G11, G12 | MUST (scripts, §6.3 items 4-5) | step 1, first commit |
| G9 | should | step 2 |
| G2, G3 | should | steps 2.1 / 2.2 |
| G6 | should | step 2.3 |
| G5, G13 | nice-to-have | — |

- **G1 Actuator mismatch** never fires in any golden (`grep actuator_mismatch` → nothing in
  pipeline, lifecycle or `ws_data_flow_test.ts`). Its state moves across three modules
  (`actuator-mismatch`, `engine-state`, `notifications`) and step 2.1 moves the sensed-state blocks.
  **The script first proposed here is infeasible:** turning `debug_mode` off calls
  `actuator_commander_.clearAllManualOverrides()` before it publishes state
  (`SequencerService.cpp:949-952`), so the manually opened valve returns to the state's position
  and nothing is left to mismatch. Two candidates, for C0 to confirm before choosing:
  (a) stay in debug: unlock → `debug_mode` on → open a valve the current state expects closed →
  `debug_mode` on **again** (`doSetDebugMode(true)` publishes state without clearing overrides, which
  schedules the 5 s check) → expect `notification actuator_mismatch ongoing=true "Actuator mismatch
  in <state>: <name> (expected CLOSED, sensed OPEN)"` ≥ 5 s later → close the valve (a sensed change
  with the key active reschedules) → `"Actuator positions match expected" ongoing=false` → debug
  off. Needs confirming that the second `DEBUG_MODE:1` reaches `publishState()` and that the
  simulated actuator board reports the opened channel as sensed open. (b) a simulator-side
  sensed-state fault: `board_simulator.py` reports one actuator channel's current-sense opposite to
  its command, so any state publish yields a mismatch 5 s later. (b) does not depend on debug-mode
  semantics but needs a simulator option.
- **G2 `self_test_fail_<id>`** (one notification per board, `break` after the first failure): the
  simulators only pass. Needs a simulator option that fails one sensor.
- **G3 `unrecognized_<id>`**: no board outside config ever heartbeats in a golden.
- **G4 :9998 down / slow**: no golden sends a command with the sequencer stopped or stalled. Add
  (lifecycle): SIGSTOP the sequencer → `state_transition` → `ERROR "State transition failed:
  timeout"` after ~2 s; SIGTERM it → `ERROR "State transition failed: connect ECONNREFUSED
  127.0.0.1:<port>"` (N5 normalises the port; `refusalText` passes any reply without an `ERR:`
  prefix through unchanged); `debug_mode` → no reply. WP5 already moves this code.
- **G5 keepalive reaper**: a client that stops answering pings is reaped within [30, 60] s
  (`KEEPALIVE_MS` 30 000 + one sweep); not covered anywhere.
- **G6 slot 0 → 10** in `uniqueIdFromPtEntity` (today 344-345) and the T7 slot map: no golden has a
  PT board whose `board_id % 10 == 0` that streams (board 60 never does). Not reachable black-box
  before the split; after 1.8, `server/config-caches.ts` imports without side effects, so WP6 adds a
  vitest (a PT board with board_id 20: `PT10.CH3` → 2003; board 21: `PT1_Cal.CH2` → 2102; a slot no
  config board has → the `slot*100+ch` fallback; `T7<n>_Cal.AIN<m>` → `board_id*100+m`) **before** step 2.3 replaces the rule.
- **G7 deploy-driven reload** (`applyDeployedConfigChange`, `onStateCsvUpdated`): only the
  session-start path is frozen (`config_updated` in `session_start_forced`). Add idle-mode
  `POST /api/config` and `POST /api/state-csv` success as an operator, and freeze: `config_updated`,
  the following `board_status_update` board list, and the commanded snapshot a new client then
  receives (proves `STATE_ACTUATOR_MAP` was rebuilt). Shared with WP7's H1.
- **G8 `CONFIG_UPDATED` ordering vs `board_status_update`** in `applyDeployedConfigChange` — covered
  once G7 freezes both frames in order.
- **G9 key order.** All goldens sort JSON keys (`characterize.py:92`, `normalize.py:145`), so
  payload key order on the wire is unguarded. Step 1 moves literals verbatim (safe); any step-2
  helper that rebuilds a payload could reorder. Cheap guard: record one unsorted raw frame per
  message type in the pipeline capture.
- **G10 a JSON message whose handler throws** (e.g. `{"type":"send_command"}` with no payload →
  `TypeError` inside the same try → no reply): not exercised; add one line to `session.ts`'s
  `subscribe` step.
- **G11 timer firing order.** The three 1 s timers (stale sweep → board status → connection status)
  fire in registration order, and that order is on the wire (board-health notification before
  `board_status_update` before `connection_status` within one second). No golden freezes it (P1 takes
  board-health notifications as a set; `connection_status` is a periodic type). Guarded statically by
  the startup-order script (§6.3 item 4).
- **G12 startup log order.** The order of startup log lines (`GUI downsampling`, `Loaded N PT
  calibrations`, `Loaded N boards`, import-time warnings of `state-actuators`, video, `listening on
  port`) is in no golden. Guarded by the 60-line log diff (§6.3 item 5).
- **G13 `[WS_BACKEND]` `conn_open` / `conn_close` lines** (fields, counters, `connId`): log only, not
  frozen. Nice-to-have: a lifecycle line that records their keys and counter values for one scripted
  client.

---

## 8. Risks

- **R1 Shared state.** Mitigated by single ownership (§1.2), setters for the 8 cross-module writes
  (§6.2, checked by `tsc`), and keeping cross-module `Map`/`Set` mutation verbatim until step 2. The
  subtle ones: `calibrationHost` must be built after the PT load (path by value); `wss` is a live
  binding assigned by `attachWebSocketServer` and must never be destructured into a local.
- **R2 Import cycles.** §2's DAG; the WS↔link near-cycle resolved by layering. A cycle check is
  cheap (`npx madge --circular src/server.ts`, or a grep that no `server/*` file imports
  `ws-connection`, `commands` or `ingest`). `server/*` and `api/*` never import each other.
- **R3 Startup order.** R1 (with R1a-c, [A2]) + R2 in §6.1. The three 1 s timers must stay in the
  order stale sweep → board status → connection status, **as three separate `setInterval` calls
  [A5]**: equal-period timers fire in registration order (Node's per-duration timer lists, research
  §2), and a throw in one is caught by the `uncaughtException` guard while the other two still fire
  that second. One merged 1 s `tick()` would skip the rest on a throw, and a try/catch per call
  would change which guard logs: both are behaviour changes. Row 11's CSV read must stay un-caught (a throw at startup kills
  the process before the crash guards exist, as today). `sessionManager.init` → `syncElodinToSession`
  → `startBoardLogReceiver` stay inside the `listen` callback in that order.
- **R4 The `legacy/` (`state-csv/` after WP5) loaders.** `engine-state` imports
  `getStateActuatorMap`, `CSV_ACTUATOR_TO_ENTITY`, `resolveActuator*`; `commands` imports
  `getStateTransitions`. (a) `state-actuators.ts` builds three maps **at import** from config
  (`:79-81`) and can log; R1 keeps that evaluation where it is. (b) They resolve CSV paths with
  `join(__dirname, '..', '..', '..', '..', rel)` — never move them into `server/` (the depth would
  change; WP6 does not own them anyway). (c) `CSV_ACTUATOR_TO_ENTITY` is built once and never
  rebuilt by `applyDeployedConfigChange`; kept (an observation, not fixed). (d) The frozen defect
  that absolute `[state_machine]` paths are never found stays.
- **R5 The duplicated slot helper.** `server.ts:344-345` is a **sixth** copy of `board_id % 10, 0 → 10`
  that BLOAT-MAP §3 does not list (it lists `sensor-config.ts`, the registry, `api-server.ts:97`,
  `legacy/state-actuators.ts`, the frontend). WP5 does not own this file's copy; WP6 replaces it in
  step 2.3, after G6.
- **R6 Live bindings.** `export let` reads are ESM semantics (tsx and vitest preserve them). Never
  `const { currentState } = await import(…)` or copy one into a local that outlives the call, and
  never re-export an imported `let` as `export const x = y` (§6.1 R5); `export { y } from …` is fine.
- **R7 Ingest hot path.** Moving the row blocks into other modules (step 2.1) adds function calls
  per row (~200+ streams). Measure `/stats` `sensorUpdatesBroadcast` against the simulator's sent
  count (`ws_data_flow_test` sample conservation) and the pipeline T1 bound; abandon 2.1 for any
  block where it moves.
- **R8 Harness-read log lines.** `Connected to Elodin, subscriptions sent.` (counted by
  `lifecycle.py:1083`, frozen in `reconnect.txt`) moves with `onElodinConnected` unchanged.
  `VTableStream: sent` / `queued for the next pass` (`pipeline/run.sh:216`) come from
  `elodin-vtable-registry.ts`, which WP6 does not touch.
- **R9 `lc-tare.test.ts`** is a source-text test of `server.ts`. It fails in two different ways: the
  parse-site assertion goes **red** when the parse site leaves (1.14), but the drain-slice assertions
  go **silently vacuous** when the drain loop leaves (1.3), because both `indexOf`s return -1 and the
  empty slice contains nothing. Hence the re-point in 1.3, the non-vacuity assertion, and both
  mutations re-run (§6.1 rows 1.3 and 1.14).
- **R10 `tsx watch` in production** (`npm run dev`, recorded defect): more files under `src/` are
  watched; behaviour unchanged.

---

## Open questions

Q2, Q3 and Q5 are settled by the orchestrator's decisions at the top of this note; Q4 by the gap
priority table in §7. Q1 remains for WP5.

- **Q1** `sendToControllerService` (:9999) has no caller. WP5 plans one `sendLine(port, line, isOk)`
  "preserving both predicates"; with only one live user that is an abstraction with a single user
  (D17d). Recommend WP5 delete the dead :9999 function instead.
- **Q2** BLOAT-MAP suggested "split by passing a context object". This note chooses module
  singletons (§3.1). Orchestrator to confirm.
- **Q3** WP6's file list names `server/gui-stream-config.ts`; this note uses `server/sensor-stream.ts`
  (it owns more than the config, and `gui-stream.ts` already exists) and adds `env`, `stats`,
  `mission-time`, `config-caches`, `calibration-state`, `engine-state`, `ingest`, `ws-connection`.
- **Q4** G1-G5, G7, G9, G10 are characterization tests (C0-owned). Who adds them, and must all land
  before step 1, or only before the step that touches each (G1 before 1.11/1.12, G4 before 1.15,
  G7 before 1.8/1.9/1.11)?
- **Q5** Step 2.7 (replacing the `lc-tare` source-text test) changes a backend test's method;
  acceptable inside WP6, or a separate test-only package?

---

## Alternatives considered (design/ts2, 2026-11-16)

Three genuinely different shapes were compared before keeping §2. "Lines" is the net change in
`src/` over steps 1 and 2 (estimates from the line ranges of §1.1).

### A. Modules split by what they own, module singletons, a layered DAG (§2 — chosen)

16 `server/*` modules, one owner per piece of state (§1.2), state reached through live bindings
and owner-exported setters, `server.ts` as the composition root that registers every timer and
listener in today's order.

### B. Service objects with explicit dependencies

The same concerns as classes — `new BoardStatus(wsClients, notifications, stats)`,
`new EngineState(wsClients, history, sequencer)`, … — constructed in `server.ts` in dependency
order and passed to each other; the shared mutable state becomes instance fields. (BLOAT-MAP's
"split by passing a context object" is the degenerate form: one object holding every field.)

### C. A layered pipeline: ingest → state → broadcast

Four or five files along the data's direction: `ingest.ts` (Elodin rows in), `state.ts` (all
backend state and its mutators), `broadcast.ts` (ws clients, every `broadcast<Thing>`, the connect
burst, the sensor stream), `commands.ts` (browser in), plus `server.ts`.

### Comparison

| | A (chosen) | B service objects | C pipeline |
|---|---|---|---|
| clarity | a reader finds a concern by name (`board-status`, `engine-state`); the import list says who touches what; §1.2's ownership table is the module map | constructors make dependencies explicit, but every method body grows `this.` and the 15-object construction order becomes a second startup sequence to read beside the timer sequence | the data direction is obvious, but `state.ts` (~650 lines, 8 concerns) is a new god file, and one concern is smeared across three files: board health is decided in `state`, worded in `broadcast`, fed by `ingest`, and the stale sweep (a timer that reads state and broadcasts) fits no stage |
| lines (net) | step 1 ≈ +110 (imports/exports/wrappers); step 2 ≈ −70 (notification pairs, T7 lookup, slot copy, replays de-duplicated) | ≈ +250 over A (fields, constructors, `this.`, wiring) | ≈ +40 in step 1 (fewer files), no step-2 deletions beyond A's |
| move-only feasibility (D17a, D39) | yes: bodies byte-identical except the 8 setters of §6.2 (tsc-checked) and R1a bare imports | **no**: every moved body changes (`boardsStatus` → `this.boards`), so `--color-moved` review and the move-only rule both fail; step 1 is a rewrite of ~1500 lines | mostly, but `state.ts` must export ~40 mutators to keep bodies verbatim, which is the context object again |
| testability | M1 makes every module importable without effects; the pure decisions already extracted (`linkStatus`, `FlushPacer`, `planBackfillSlices`, research §5 "functional core") stay pure; G6 is a plain vitest | best in principle (fakes by constructor), but the gate is black-box goldens over HTTP/WS, which gain nothing; unit tests would be new code with a single user (D17d) | worst: `state.ts` cannot be imported for one concern without the others |
| fit with characterization boundaries | goldens are black-box over :8081 (pipeline, lifecycle, `ws_data_flow_test`), untouched by any layout; the path-coupled pieces are `src/server.ts` (launched by `pipeline/run.sh:200`, `test_integration.sh:834`, `environmental-recovery.integration.ts:97`) — kept — and `lc-tare.test.ts`'s source-text anchors, re-pointed under D18 (§6.1 rows 1.3, 1.14) | same entry point; `lc-tare.test.ts` anchors break in more places (the parse site and drain loop change text, not just file) | same entry point; `lc-tare.test.ts` re-pointed once, to `ingest.ts`/`broadcast.ts` |
| risk to the frozen contract / startup order | low and checked: R1a-c + R2 + the startup-order script + the module-order diff (§6.3 items 4, 6) + G12 | high: construction order is new code; a constructor that starts a timer reorders §1.3 rows, and nothing textual pins it | medium: `state.ts`'s initialisers run at its import (or need the same `init*` discipline as A), and the three 1 s timers live in two different files |

**Why A.** It is the only shape that allows a true move-only pass (D17a): bodies keep their text,
and every exception is either type-checked (setters, TS2632) or mechanically listed (R1a bare
imports). It matches the precedent of every module already extracted from `server.ts`
(`board-scan-rate`, `elodin-vtable-registry`, `lc-tare`, `countdown-state`, `sessionManager`), and
it keeps each concern in one file, which the walkthroughs below confirm step by step. **B lost** on
move-only feasibility and on D17(d) (fifteen single-instance classes, the "context object" the
orchestrator already declined in D-c) — research §5 reaches the same verdict. **C lost** because
its central file recreates the god file under a new name and splits board health, the most
stateful concern, across three files.

**No divergence from the reviewed design**; the deeper pass amends it in places ([A1]-[A7] at the
top), none of which changes the module list or the layering.

---

## Walkthroughs (design/ts2, 2026-11-16)

Each flow is traced through the target modules (after step 2 unless a step says "step 1"), with
the one owner of each step. "Owner" means the module whose code decides or does that step; a
module that only passes a value through is not an owner. Findings are at the end of each flow;
fixes are the amendments [A3], [A4] (§6.4 steps 2.8, 2.9).

### (a) A fire command from the GUI to the sequencer on :9998, and the `state_update` back

1. The browser sends `{"type":"send_command","payload":{"commandType":"state_transition","data":{"state":16}}}`.
   **`ws-connection`** (the socket's `message` listener): counts it, `JSON.parse`, calls
   `commands.handleMessage(ws, msg)` inside its one try/catch (a throw → `Bad message`, no reply).
2. **`commands.handleMessage`** switches on `type` → `handleCommand`.
3. Control gate. **`commands`** owns the rule (`CONTROL_COMMAND_TYPES` vs the socket's
   `__daqControlAuthorized`). The flag was set by `commands` on `CONTROL_UNLOCK` from
   `__daqOperator`, which **`ws-connection`** computed at connect from `X-Auth-Email` (identity is
   ws-connection's; arming is commands'). Locked → `ERROR "Control locked: …"` to this socket.
4. State-id resolution: is 16 a state the config declares, and what is its sequencer name?
   **`engine-state.resolveTransitionTarget(16)`** after step 2.9 [A3]. *Before 2.9 this step had
   two owners* (`commands` read `[[states]]` and `STATE_TO_CSV_NAME`, `engine-state` named states
   for `state_update` and the mismatch text) — fixed by 2.9.
5. Hold validation and the line `TRANSITION:Fire[:<ms>]\n`: **`commands`**.
6. The TCP exchange: **`sequencer-client.sendToSequencer`** (WP5). Logs `→ actuator_service`,
   resolves `{ok, reply}`, never rejects.
7. Reply: `ok` → log `State transition Fire → Fire: OK (…)`; not ok → `ERROR "State transition
   failed: <refusalText(reply)>"` to the requester only. **`commands`**. No optimistic update.
8. The sequencer runs Fire and itself sends `FIRE_START` to `controller_service` on :9999 (the
   backend never does, §6.5). It publishes `_SEQUENCER_STATE` [0x50,0x00] to Elodin.
9. The packet arrives: **`elodin-link`** owns the client (`elodin`), whose `packet` event
   `server.ts` wired to **`ingest.handleElodinPacket`**. Its first statement is
   `notePairDelivered(high, low)` [A7]; it parses, sees `_SEQUENCER_STATE`.
10. **`engine-state.applySequencerState(rows)`**: assigns `allowedBitmask`, `currentState`,
    `debugMode`, counts `stats.sequencerStatesReceived`, `broadcastStateUpdate()` (the broadcast
    shape, with `allowedBitmask` and `stateRefusalReasons`), `broadcastCommandedActuatorsForState`.
    Then **`ingest`** calls `actuator-mismatch.scheduleActuatorMismatchCheck(currentState)` and
    returns (order frozen, §6.1 row 1.11).
11. 5 s later **`actuator-mismatch`** compares `engine-state.getExpectedPositions(Fire)` with the
    sensed positions it holds; raises or clears `actuator_mismatch` through
    **`notifications.raiseNotification` / `clearNotification`** (step 2.2).
12. Meanwhile `[0x31]`/`[0x34]` rows update the sensed positions (**`actuator-mismatch.noteSensedRow`**,
    step 2.1), and every row goes to **`sensor-stream.publishSample`** (history, then outboxes;
    `ws-clients` drains them every 100 ms).

Owners per step: one each after [A3]. Two emitters of "a sensor sample goes to history and the
browsers" remain by design — `sensor-stream` (Elodin rows) and `engine-state` (the CSV-derived
commanded snapshot, `broadcastCommandedActuatorsForState`): they differ in the frame timestamp
(`Date.now()` at send vs the snapshot's `epochNow`), so folding one into the other changes a
field. Not a double owner of one step; recorded.

### (b) An abort

GUI abort: the same command with the abort state's id (e.g. `Engine Abort`, 17): steps 1-12 of
(a). Three properties the trace makes explicit:

- **The abort passes the control gate** (step 3). An unarmed browser's abort is refused with
  `Control locked`. That is today's behaviour, frozen in `ws_events.txt` (locked/unlocked), not
  WP6's to change; recorded so nobody "fixes" it in a refactor.
- **A failed send is reported, never retried** (step 7). Sequencer stalled (e.g. C4-1's deadlock)
  → `ERROR "State transition failed: timeout"` after 2 s; down → `…: connect ECONNREFUSED …`. G4
  freezes both.
- **A sequencer-initiated abort** (redline, abort thresholds) never touches `commands` or
  `sequencer-client`: it arrives as `_SEQUENCER_STATE` at step 9 and follows 9-12. The backend's
  only abort-specific behaviour is what `engine-state` and `actuator-mismatch` do for any state.
  The abort's UDP batch, its double `triggerAbort` (C1-10) and the pending-stage race (C4-3) are
  the sequencer's.

Owners per step: as (a). No new finding.

### (c) A board reconnect / board-status change

1. **Heartbeats stop.** The 1 s stale sweep (registered in `server.ts`, row 13) runs
   **`board-status.markStaleBoards`**: past 5 s it sets `connected = false`, raises `board_lost_<id>`
   (**`notifications.raiseNotification`**), and calls `broadcastBoardStatus()` (**`board-status`**).
2. Same second, in registration order [A5]: the 1 s `broadcastBoardStatus` (**`board-status`**),
   then `broadcastConnectionStatus` (**`elodin-link`**). The order is on the wire (G11).
3. **A heartbeat returns.** `[0x10, id]` → **`ingest`** (delivery note first) →
   **`board-status.countHeartbeat` + `updateBoard`**: was disconnected → `broadcastBoardStatus()`
   immediately. A T7 has no heartbeat: its data rows reach **`board-status.noteT7Alive`** via the
   T7 slot lookup (**`config-caches.t7BoardIdForSlot`**, one owner after step 2.4).
4. Next sweep: **`board-status`** clears `board_lost_<id>` (`clearNotification`, `ongoing:false`)
   and emits the one-shot `"… connected"` info (`broadcastNotification`).
5. A board config does not know: `updateBoard` creates it with `expected:false`; the sweep raises
   `unrecognized_<id>`. **`board-status`**.
6. Self-test rows `[0x60..0x6F, id]` → **`board-status.noteSelfTestResults`** (step 2.1): snapshot
   for replay, first failure per board → `self_test_fail_<id>`. *In step 1 this has two owners*
   (`ingest` writes `selfTestLatest` and the notification key, `board-status` owns them) — the
   planned step 2.1 fixes it.
7. **Session stop / start** (the C5-1 flash): `sessionManager` calls the callbacks `server.ts`
   passed in its `listen` callback. Stop → `server.ts`'s arrow: `board-status.loadBoardsFromConfig()`,
   `broadcastBoardStatus()`, `elodin.disconnect()` when no pipeline. Start → `applyDeployedConfigChange()`
   (same reload) and the second arrow (`publishClearAllTares`, `elodin.connect()`). **`server.ts`**
   owns the wiring; each callee owns its effect.
8. **Elodin reconnects**: **`elodin-link.onElodinConnected`** — badge, `setCalibrationElodin`
   (step 2.2), subscription pass via the registry (whose due-pair decision is WP5's pure
   `duePairs`), resubscribe loop, script status.
9. **A new browser** gets the board list in its connect burst: **`board-status.sendBoardStatus(ws)`**
   after step 2.8 [A4]; self-test replay **`board-status.sendSelfTestReplay(ws)`**; notification
   replay **`notifications.sendNotificationReplay(ws)`**. *Before 2.8 these frames were built inside
   `ws-connection` from other modules' bindings* — two places knowing each message's shape —
   fixed by 2.8.

Owners per step: one each after steps 2.1 and 2.8. `loadBoardsFromConfig(); broadcastBoardStatus();`
appears in two `server.ts` callbacks (session stop, deployed config): one owner (`board-status`)
called from two triggers; a combined function would have two users but only saves one line, so it
is not added.

### (d) A calibration save via HTTP

1. `POST /api/calibration_profiles/save` reaches **`server.ts`**'s HTTP handler → `apiHandler`
   (WP7). Nothing in `server/*` runs: the save copies the live store into a profile and returns
   the list (DESIGN-WP7 walkthrough (d)).
2. `POST /api/calibration_profiles/load` (and `new_blank`) additionally call the
   `onCalibrationReload` option, which **`server.ts`** built: `publishCalibrationReload(calibrationHost)`
   (`calibration-handler.ts`, not WP6's) sends Elodin `[0x46,0x00]` cmd 7 through
   `calibrationHost.elodin`.
3. That host is owned by **`calibration-state`**; its `elodin` field is written once per
   connection by `elodin-link.onElodinConnected`. *In step 1 that write is a cross-module object
   mutation*; step 2.2's `calibration-state.setCalibrationElodin(client)` makes the owner the only
   writer. Before the first connect the field is `null`, and `publishCalibrationReload` does
   nothing (frozen, WP7 §3.3).
4. The WS sibling — saving coefficients from the calibration panel — is `CALIBRATION_COMMAND` →
   **`commands.handleMessage`** → `handleCalibrationCommand(calibrationHost, ws, payload)`
   (`calibration-handler.ts`), which writes `calibration/calibration_<ts>.json` (one of the three
   stores, C3-3; Parked) and reads `lastRawAdc`, filled by **`calibration-state.noteRawAdc`**
   (step 2.1) from `ingest`.

Owners per step: one each after step 2.2. No new finding.

### Summary of ownership findings

| step | owners before | fix |
|---|---|---|
| (a) 4 state-id resolution | `commands` + `engine-state` | [A3] step 2.9 |
| (a)/(c) connect-burst frames of other modules | `ws-connection` + each owner | [A4] step 2.8 |
| (a) :9998 port | `server.ts` + WP5 client | [A1] (WP5 owns `SEQUENCER_PORT`) |
| (a) `commands` → sequencer edge | missing from §2 (zero) | [A1] edge added |
| (c) 6 self-test snapshot + notification | `ingest` + `board-status` (step 1) | planned step 2.1 |
| (d) 3 `calibrationHost.elodin` write | `elodin-link` + `calibration-state` (step 1) | planned step 2.2 |
| (c) 3 T7 slot → board lookup | two lazy fillers (step 1) | planned step 2.4 |

---

## Interfaces (design/ts2, 2026-11-16)

The public surface of every module of §2 is written as stubs in
`docs/remaster/design-stubs/ts/src/` — exported types, signatures, and a header comment per
module stating what it owns, what it must not know about or import, its contract surfaces and
the golden that freezes them, its import-time effects, error paths and side effects (STYLE-S36).
Bodies are `throw new Error('stub')` or `declare` only. The stubs are **not** under
`diablo_server/`, are imported by nothing, and are excluded from the product's `tsc` (its
`include` is `src/**/*`). They type-check against the product's real types:

```bash
cd daq-server/docs/remaster/design-stubs/ts
npx --prefix ../../../../diablo_server/backend tsc --noEmit -p .    # exit 0 at 85a02f9a
```

(`src/product-types.ts` re-exports the product types the stubs name; a deliberate wrong name there
goes red, checked.) The surface shown is the **target after step 2**; exports that exist only in
step 1 (containers the moved bodies still mutate, WP6-R3) are marked `[step 1]`, step-2 additions
`[step 2.n]`.

| stub (`src/server/…`) | layer | public surface |
|---|---|---|
| `env.ts` | 0 | `WS_PORT`, `GUI_PORT`, `ELODIN_HOST`, `ELODIN_PORT`, three `THIN_*` flags |
| `stats.ts` | 0 | `IngestStats`, `stats`, `initStats` [A9e] |
| `ws-clients.ts` | 1 | `WsWithControl`, `ClientStream`, `wss`, `clientStreams`, `KEEPALIVE_MS`, `attachWebSocketServer`, `broadcast`, `send`, `clientStreamStatus`, `flushClientOutboxes`, `resetOutboxStats`, `reapUnresponsiveClients` |
| `notifications.ts` | 2 | `activeNotificationKeys` (`ReadonlySet` after 2.2), `notificationBuffer` [step 1], `pruneNotificationBuffer`, `broadcastNotification`, `raiseNotification`, `clearNotification`, `sendNotificationReplay` |
| `history.ts` | 2 | `history`, `pruneHistory`, `sendHistoricalData` |
| `mission-time.ts` | 2 | `firstPacketTimeMs`, `countdownTargetMs`, `initMissionTime`, `setFirstPacketTimeMs`/`setCountdownTargetMs` [step 1], `noteFirstSample`, `setCountdownTarget`, `sendMissionStartTime`, `sendCountdownTarget` |
| `config-caches.ts` | 2 | `hpBoardNumbersCache`, `t7CalFieldsCache`, `initConfigCaches`, `resetConfigCaches`, `uniqueIdFromPtEntity`, `t7BoardIdForSlot` |
| `sensor-stream.ts` | 3 | `StreamBudget`, `guiStreamConfig`, `envelope`/`encoderEnvelope`/`broadcastLastTime` [step 1], `streamBudgetFor`, `saneSampleTimeMs`, `initGuiStream`, `reloadGuiStreamConfig`, `emitSensorPoint`, `emitSensorWindow`, `flushEnvelopes`, `publishSample` |
| `calibration-state.ts` | 3 | `calibrationHost`, `lastRawAdc` [step 1], `initCalibrationState`, `reloadCalibrationEntityMap`, `noteRawAdc`, `setCalibrationElodin` |
| `board-status.ts` | 3 | `BOARD_STATUS_HZ`, `BOARD_HEARTBEAT_STALE_MS`, `boardsStatus`/`selfTestLatest`/`selfTestNotifiedBoards` [step 1], `loadBoardsFromConfig`, `updateBoard`, `countHeartbeat`, `noteT7Alive`, `markStaleBoards`, `broadcastBoardStatus`, `boardLabel`, `logDiagnostics`, `noteSelfTestResults`, `sendBoardStatus`, `sendSelfTestReplay` |
| `engine-state.ts` | 3 | `currentState`, `debugMode`, `stateActuatorMap`, `initEngineState`, `reloadStateActuatorMap`, `configStateName`, `getExpectedPositions`, `broadcastCommandedActuatorsForState`, `broadcastStateUpdate`, `refreshScriptStatus`, `setDebugMode` [step 1], `applySequencerState`, `sendConnectStateUpdate`, `sendCommandedSnapshot`, `TransitionTarget`, `resolveTransitionTarget` |
| `actuator-mismatch.ts` | 4 | `actuatorSensedState` [step 1], `scheduleActuatorMismatchCheck`, `noteSensedRow` |
| `elodin-link.ts` | 4 | `elodin`, `noteIngest`, `isSimulated`, `connectionStatusPayload`, `broadcastConnectionStatus`, `syncElodinToSession`, `onElodinConnected`, `onElodinDbError`, `onElodinDisconnected`, `onElodinError` |
| `ingest.ts` | 5 | `handleElodinPacket` |
| `commands.ts` | 5 | `handleMessage` |
| `ws-connection.ts` | 6 | `handleConnection` |
| `../server.ts` | 7 | `applyDeployedConfigChange` |

Also in the stub tree: WP5's `sequencer-client.ts`, `sensor-config.ts` (delta), `elodin-vtable-registry.ts`
(delta: `duePairs`), `state-csv/*`; WP7's `api/*`, `api-server.ts`.

### What writing the interfaces changed (amendments to §2 / §6.4, marked [A9])

- **[A9a]** `raiseNotification(payload)` / `clearNotification(payload)` take the payload only; the
  key is `payload.key` (§6.4 step 2.2 wrote `(key, payload)`; at all nine sites the two are the
  same value, so one argument removes a way for them to disagree). Behaviour identical.
- **[A9b]** After step 2.2 `activeNotificationKeys` is exported as `ReadonlySet<string>`: `tsc
  --noEmit` then rejects an `add`/`delete` outside `notifications` — the same compile-time
  enforcement of single ownership that TS2632 gives `let` bindings (STYLE-S32). Likewise the
  `[step 1]` containers stop being exported in the step that moves their last outside writer
  (2.1, 2.8), so a stale writer is a build error, not a review catch.
- **[A9c]** Two import edges the step-2 functions need, both downward and missing from §2:
  `calibration-state` → `config-caches` (`noteRawAdc` resolves the uniqueId) and `mission-time` →
  `env` (`noteFirstSample`'s verbose log).
- **[A9d]** The 2.8 functions return the number of frames sent, so `ws-connection` keeps its
  `conn_close` counters without knowing what each owner sent.
- **[A9e]** `stats.startTimeMs = Date.now()` (§1.3 row 14) does not sit at `stats.ts`'s top level
  as §6.1-R2 allowed: STYLE-S30's list of allowed top-level values has no clock read. Step 1.2
  adds `initStats()` and `server.ts` calls it at row 14's position, which also keeps `uptimeMs`'s
  origin exactly where it is today (a top-level read would move it to the import phase). The
  startup-order script's `init[A-Za-z]*\(` pattern already matches it; `startup-order.expected`
  gets the line at row 14.

### STYLE.md conformance (55d140ef; LEDGER D43)

Applied: STYLE-S5 (kebab-case, `server/` = WS-side modules, no new `*-manager`/`*-service`/
`*-handler`); S6 (`handle*` at the four input boundaries, `on<Source><Event>`, `init*`/`reload*`/
`reset*`, `broadcast*` vs `send*` — hence 2.8's `send…(ws)` names rather than the first draft's
`replay…`, `note*`, `set*` as the owner's single writer); S7 (no log text, `type`, key, env var or
`__daq*` property renamed); S9/S10 (catches only at `ws-connection`, `commands`, `ingest`, and the
`server.ts` boundaries; the "log, drop, no reply" row is "today, kept"); S14 (the line client keeps
`{ok, reply}`, never rejects); S15 (harness-read lines named in the headers); S28 (no `.catch` added
to `registerVTables`); S29 (backfill and callback timing named as deliberate); S30 (no import-time
effects; `elodin`'s constructor is the one pure top-level value besides constants, and
`stats.startTimeMs` moved into `initStats()` [A9e]); S31 (no `server/*` ↔ `api/*` edge; injection only at `createAPIHandler`,
`sessionManager.init`, `CalibrationHost`); S32 (live bindings, setters, [A9b]); S33 (sizes per WP);
S34 (no new class, interface with one user, callback type or knob: the types declared are the
existing ones plus `TransitionTarget`, a return type); S36 (every stub opens with the required
header); S40 (2 spaces, single quotes, semicolons in new files; moved code not reformatted).

**Choices that need the orchestrator's check against STYLE:**

1. **STYLE-S20 "the process environment is read once, in one module (`server/env.ts`)".** Two reads
   stay outside it: `SEQUENCER_PORT` in WP5's `sequencer-client.ts` (the port belongs to the module
   that dials it; putting it in `server/env.ts` would make a `src/`-level module import `server/*`,
   an upward edge, or force a port parameter every caller passes identically — STYLE-S34 says
   that is a constant), and `USE_SIM` read **per call** in `elodin-link.isSimulated()` (moved
   verbatim; reading it once at import is equivalent only while nothing mutates `process.env`,
   which no code does, but it is a semantic change a move-only pass does not make). Proposal:
   S20 reads "…in the module that owns the knob, once", or the orchestrator rules otherwise.
2. **2.8's `send…(ws)` functions** are new exported functions with one caller each
   (`ws-connection`). Under STYLE-S34/D43(3) they are one-call-site extractions that only move
   code — not abstractions — but they are listed here because the reviewed note did not have them.
3. **`raiseNotification(payload)` single argument** ([A9a]) departs from the reviewed signature.
