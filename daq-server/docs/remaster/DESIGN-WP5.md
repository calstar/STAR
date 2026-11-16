# DESIGN-WP5 — backend dead TS, the sequencer line client, the slot helper

Target-design note for WP5 (BLOAT-MAP §2a, §3, WP5 row; LEDGER D39). Design only: nothing here has
been executed. Paths are relative to `daq-server/diablo_server/backend/src/` unless stated. Line
numbers are `backend-remastered` @ `85a02f9a` (product code equal to `main`).

WP5 is not a god-file split, but it is the first package to move code out of `server.ts` and it
creates the two helpers WP6 and WP7 build on, so it gets the same treatment: alternatives,
interfaces (`design-stubs/ts/src/`), walkthroughs.

**Contract (frozen, D5/D17).** TCP :9998 command lines, their 2 s timeout and the reply predicate
(`OK` or `OK:<ms>`); the log lines `[ThinServer] → actuator_service: <line>` and
`[ThinServer] actuator_service connect error: <msg>`; every Elodin entity name and subscription pair
derived from a board id; the import-time log lines of the state-CSV loaders and their order in the
startup log (DESIGN-WP6 G12); every export a characterization harness imports by path.

**Prerequisites.** C1 merged; the `tsc --noEmit` gate step (D40); G4 (DESIGN-WP6 §7: :9998 down /
slow, frozen black-box; **extended here with one accepted hold**, §6) exists **before** commit 5.6;
G-W5 (§6) exists before commit 5.5.

---

## 1. What WP5 owns

| item | today | source of truth |
|---|---|---|
| dead files | `calibration-sidecar.ts` (143), `ota-flash.ts` (138), `server-types.ts` (40): unreachable from every entrypoint, imported by no test or harness | BLOAT-MAP §2a (re-checked: `grep -rn` over `src`, `frontend`, `shared`, `test/` finds only `api-server.ts`'s URL string `/api/ota-flash`) |
| misplaced test | `operators.test.ts` beside its module (vitest has no config; it collects `**/*.test.ts`, so the move changes nothing it runs) | BLOAT-MAP §2a |
| the `:9998` line client | `server.ts:1411-1441` `sendToActuatorService` (3 callers: `state_transition`, `actuator`, `debug_mode`, `extend_fire` in `handleCommand`, and `refreshScriptStatus`); `server.ts:74` `ACT_SVC_PORT` | BLOAT-MAP §3 |
| the dead `:9999` client | `server.ts:1443-1467` `sendToControllerService` (no caller), `server.ts:75` `CTRL_SVC_PORT` (read only by it) | D39: delete, do not fold |
| the slot rule `board_id % 10, 0 → 10` | **six** copies in the backend: `sensor-config.ts:59`, `:116`; `elodin-vtable-registry.ts:249`; `legacy/state-actuators.ts:122`; `api-server.ts:97` (`elodinSlotFromBoardId`); `server.ts:344` | BLOAT-MAP §3 (five) + DESIGN-WP6 R5 (sixth) |
| `legacy/` | `state-actuators.ts`, `state-transitions.ts`, `state-ids.ts`: live (server.ts:39-41), misnamed | BLOAT-MAP §3 |
| unused exports | `state-actuators.ts` `getActuatorChannel`, `getNumActuatorsFromCSV`; `state-transitions.ts` `buildTransitionMap`, `isTransitionAllowed`; `calibration.ts` `calculatePressure`, `inversePressureToAdc` | BLOAT-MAP §2a — **two of these are not unused, see §1.1** |
| a stale C++ comment | `services/ota/ota_service_main.cpp:13` "Protocol (matches ota-flash.ts)" | BLOAT-MAP WP5 row |
| the "which pairs are due" decision | inline in `elodin-vtable-registry.ts:383-401` (`subscribeVTables`), mixed with I/O, logging and the fence | LEDGER D42(d), `research/subscription-robustness.md` Idea 5 |

### 1.1 Corrections to BLOAT-MAP found while designing

- **`calculatePressure` and `inversePressureToAdc` stay.** The C3 calibration harness imports them by
  path (`test/characterization/calibration/ts_harness.mts:91,119,130,142`) and
  `calibration/golden/ts.txt` holds their output (sections at lines 2 and 46, plus the per-file
  `psi` lines; the C3 mutation "`C·x` × (1+1e-12)" goes red on them). Deleting them removes golden
  lines, which D20 forbids. They are characterized dead code; their deletion is a contract question
  for the team, recorded in Parked (§7), not a WP5 step.
- **Renaming `legacy/` edits one backend test.** `__tests__/ball-valve.test.ts:22` imports
  `../legacy/state-actuators.js`. The edit is the path only, under D18's conditions by analogy (as
  DESIGN-WP6 does for `lc-tare.test.ts`): assertions untouched, the test re-run red against a
  mutation (§6), the orchestrator reviews the diff.
- **WP5 removes four of the six slot copies, not five.** `api-server.ts:97` moves with
  `buildSensorConfig` in WP7 step 1 and is replaced in WP7 step 2.2 (after H4); `server.ts:344`
  moves to `server/config-caches.ts` in WP6 step 1 and is replaced in WP6 step 2.3 (after G6). Both
  notes already say so; WP5 only provides the helper they call.
- **WP5 owns the registry, so it owns the `duePairs` extraction** (D42(d)). DESIGN-WP6 states that
  WP6 does not touch `elodin-vtable-registry.ts`; BLOAT-MAP lists the file under WP5. The extraction
  is behaviour-preserving (§6, commit 5.7) and gives a later D-SUB/D-ECHO fix one pure function to
  extend instead of the 120-line I/O pass. `test/test_duplicate_subscription.ts` (the only C6-2
  reproducer, parked — not deleted — by WP4, D42(e)) is not touched by WP5.
- **The registry's copy carries a second rule.** `elodin-vtable-registry.ts:249-251` computes the
  slot and then folds it with `((n - 1) % 8) + 1` (the D-SLOT wrap). WP5 replaces only the slot
  expression; the fold stays where it is, as a separate line, untouched (defect, reported).

---

## 2. Alternatives considered

Three genuinely different shapes for "the shared TS helpers".

### A. Two named homes, nothing generic (chosen)

- The slot rule becomes `boardSlot(boardId)` in the existing `sensor-config.ts`, which already holds
  two of the six copies and, after WP7, `buildSensorConfig` (two more).
- The `:9998` client becomes `sequencer-client.ts`: one function, `sendToSequencer(line)`, moved
  verbatim, plus the port it dials (`SEQUENCER_PORT`, read from the same env var).
- `legacy/` is renamed `state-csv/` (`git mv`), the four uncalled exports go, the three dead files
  go, the dead `:9999` client goes.

### B. A helpers package: `src/lib/{board-ids,tcp-line,http-json}.ts`

One directory for everything "shared": `board-ids.ts` (`boardSlot`, plus `asBoardId`,
`isCurrentLoopBoard`, `generatedRole` lifted out of `sensor-config.ts`/`api-server.ts`),
`tcp-line.ts` (a generic `sendLine(host, port, line, isOk, timeoutMs)`), `http-json.ts`
(`sendJson`, `readJsonBody`, `isConfigWriteAuthorized` ahead of WP7).

### C. No WP5 modules: deletions only, helpers ride along with WP6/WP7

WP5 deletes the dead files and the dead `:9999` client and renames `legacy/`; the slot helper is
created by whichever of WP6/WP7 needs it first, and the `:9998` client moves into WP6's
`server/engine-state.ts` with the other sequencer-facing code.

Outside practice consulted (LEDGER D42): `research/node-realtime-backend.md` §5 (keep decisions in
pure functions, I/O at the edge — the backend already does this in `client-outbox.ts` and
`history-backfill.ts`; no DI container, no `ServerContext`) and §1 (elided imports, which decides
whether a new import edge can move a module's evaluation); `research/subscription-robustness.md`
Idea 1 (one `boardSlot()` home is the remaster half of making the table-id map injective later)
and Idea 5 (`duePairs` as a pure function of desired and observed state).

### Comparison

| | A | B | C |
|---|---|---|---|
| clarity | each helper lives with what it is about: the slot rule with the per-board sensor maps, the client named for the process it talks to | "lib/utils" directories name a pattern, not an owner (DESIGN-WP6 §5's own rule); a reader looking for the slot rule must know it is in `lib/` | the client hides inside engine-state, and its second user (`commands`) must import engine-state to send a command |
| lines deleted (net, `src/`) | ≈ −430 (321 dead files, 25 `:9999` client, ≈80 uncalled exports, ≈4 slot lines) | ≈ −400 (as A, minus new module headers and the generic client's parameters) | ≈ −430, but the slot copies stay until WP6/WP7 |
| testability | `boardSlot` pure, importable without effects; `sendToSequencer` reachable black-box through G4 (it has no white-box test today and needs none) | same, plus a generic client invites a unit test of a predicate parameter nobody else passes | same as A, later |
| fit with characterization | no harness imports any moved file; `ts_dump.ts` imports `sensor-config.js` by path and only gains an export; `ts_harness.mts`'s `calibration.ts` exports kept | **breaks** `config/ts_dump.ts`, which imports `isCurrentLoopBoard` from `sensor-config.js` by path (D18/D20: a harness edit to make a refactor fit) unless re-exported, which recreates two homes | as A |
| contract / startup-order risk | none: `sensor-config.ts` is already evaluated at `server.ts:31` (a value import, so it survives emit — research §1), before the registry (`:32`) and the state-CSV loaders (`:39`) that start importing it; `sequencer-client.ts` imports only `net`; checked per commit by the module-order diff (§6) | same; `lib/http-json.ts` pre-empts WP7's `sendJson` decision, which D39 restricts to literal bodies — a shared `sendJson` invites the silent headers-sent fix | WP6 and WP7 run in parallel; both need `boardSlot`, so C makes them race to create it or serialises them |
| D17(d) single-user abstraction | none: two functions, each with ≥2 users (`boardSlot` 6, `sendToSequencer` 5 call sites in 2 future modules) | `sendLine(…, isOk)` has one live caller (the `:9999` caller is dead), exactly what D39 rejected | none |

**Why A.** It deletes as much as B with no new abstraction, keeps every harness path import valid,
and gives WP6 and WP7 a fixed point to depend on before they run in parallel. B loses on D17(d), on a
harness path, and on anticipating WP7's `sendJson` decision. C loses on the parallel schedule (both
WP6 and WP7 want the helper) and on ownership (a TCP client inside a state module).

**Divergence from the existing plan (explicit).** BLOAT-MAP's WP5 row names the module
`service-line-client.ts` and DESIGN-WP6 refers to it by that name. This note names it
`sequencer-client.ts` and its function `sendToSequencer`: DESIGN-WP6 §5's naming rule ("a module is
named for what it owns, not for a pattern") applied to WP5; after D39 deleted the `:9999` sender
there is no second service to be generic over. DESIGN-WP6 is amended to match (marked there).
`ACT_SVC_PORT` moves with the client as `SEQUENCER_PORT`, so WP6's `server/env.ts` no longer lists it
(amendment A1 in DESIGN-WP6).

---

## 3. Target

| module | single responsibility | public interface (stub) | must not know about |
|---|---|---|---|
| `sequencer-client.ts` (new) | one request/reply exchange with `sequencer_service` on TCP :9998 | `SEQUENCER_PORT`, `SequencerReply`, `sendToSequencer(line)` — `design-stubs/ts/src/sequencer-client.ts` | WebSocket, message types, which commands exist, what a refusal means (`refusal-text.ts` is the caller's), sessions |
| `sensor-config.ts` (existing, +1 export) | sensors and boards as config declares them | adds `boardSlot(boardId)` — `design-stubs/ts/src/sensor-config.ts` | Elodin packet decoding (that stays in `elodin-protocol.ts`), the `% 8` fold (registry) |
| `state-csv/` (renamed from `legacy/`) | the backend's reading of the state-machine CSVs: expected actuator positions per state, the transition list, CSV state names | surviving exports only — `design-stubs/ts/src/state-csv/*.ts` | WebSocket, the sequencer, the active profile (it reads `readConfig()` like today) |

Import edges added: `elodin-vtable-registry.ts` → `sensor-config.ts`; `state-csv/state-actuators.ts`
→ `sensor-config.ts`; `server.ts` → `sequencer-client.ts`. No cycle: `sensor-config.ts` imports only
`routes/config.ts` and `shared/config-validation.ts`, neither of which imports any of the three.

`boardSlot`'s body is fixed by this note, because DESIGN-WP6 step 2.3 and DESIGN-WP7 step 2.2 rely
on it being literally the expression every copy uses:

```ts
export function boardSlot(boardId: number): number {
  const m = boardId % 10;
  return m === 0 ? 10 : m;
}
```

Every caller keeps its own guard (`typeof … === 'number'`, the registry's `Number.isInteger && 1..255`,
`asBoardId`'s fallbacks); `boardSlot` adds no validation. For the record: `-21 → -1`, `21.5 → 1.5`,
`NaN → NaN`, exactly as each copy computes today.

---

## 4. Interfaces

The public surface is written as type-checked stubs in `design-stubs/ts/src/` (see that directory's
`tsconfig.json` and DESIGN-WP6 "Interfaces" for the command; not under `diablo_server/`, imported by
nothing):

- `sequencer-client.ts` — `SEQUENCER_PORT`, `SequencerReply`, `sendToSequencer`.
- `sensor-config.ts` — `boardSlot` (and, from WP7, `buildSensorConfig` / `SensorConfigEntry`).
- `elodin-vtable-registry.ts` — `VTablePair`, `PairState`, `duePairs` (commit 5.7).
- `state-csv/state-actuators.ts`, `state-csv/state-transitions.ts`, `state-csv/state-ids.ts` — the
  exports that survive WP5.

Doc comments in the stubs state ownership, what the module must not know about, error paths and side
effects. The summary for the one behavioural surface, `sendToSequencer(line)`:

- connects to `127.0.0.1:SEQUENCER_PORT` (host fixed, port from `ACTUATOR_SERVICE_PORT`, default
  9998), logs `[ThinServer] → actuator_service: <line.trim()>` on connect, writes `line` as given (the
  caller supplies the `\n`);
- resolves on the first `\n` in the reply with `{ ok: reply === 'OK' || reply.startsWith('OK:'),
  reply: <trimmed> }`; on `close` before that with `{ ok: false, reply: <partial> || 'connection
  closed' }`; on `error` with `{ ok: false, reply: err.message }` after warning
  `[ThinServer] actuator_service connect error: <msg>`; after 2 s with `{ ok: false, reply: 'timeout' }`;
- **never rejects**; resolves exactly once (the `resolved` latch); one TCP connection per call; no
  retry, no queue, no reuse.

---

## 5. Walkthroughs

The four flows, end to end, with the WP5 modules on the path. Each step names its single owner;
`server.ts` is today's file (WP5 lands before WP6). Where WP5 is not on a path, the walkthrough says
so — that is a result too: WP5 must not add itself to it.

### (a) A fire command from the GUI

1. Browser sends `{"type":"send_command","payload":{"commandType":"state_transition","data":{"state":16}}}`
   over WS :8081. Owner: `server.ts` connection handler (WP6: `ws-connection`).
2. Dispatch, control gate, state-id resolution, line build `TRANSITION:Fire\n` (or `:<holdMs>`).
   Owner: `server.ts` `handleCommand` (WP6: `commands`). WP5 does not change it.
3. **TCP exchange with :9998.** Owner: `sequencer-client.sendToSequencer`. It logs the `→
   actuator_service` line, writes, reads one line, applies the `OK`/`OK:<ms>` predicate, resolves.
4. Reply handling: `ok` → log `State transition Fire → Fire: OK (OK)`; not ok → `ERROR "State
   transition failed: <refusalText(reply)>"` to that socket only. Owner: `handleCommand`
   (`refusal-text.ts` formats). The client does not interpret the reply beyond `ok`.
5. The sequencer enters Fire, publishes `_SEQUENCER_STATE` [0x50]; the backend's subscription to it
   comes from `elodin-vtable-registry.ts` (not slot-derived: [0x50,0x00]). Owner of the
   `state_update` broadcast: `server.ts` ingest (WP6: `engine-state.applySequencerState`).
6. The commanded-actuator snapshot for Fire names `ACT_CMD.B<slot>.CH<n>` entities. Owner of the
   name: `state-csv/state-actuators.resolveActuatorCmdEntity`, whose slot now comes from
   `sensor-config.boardSlot`. One owner of the rule, one owner of the entity format.

Zero/two owners: none. The port had two owners (server.ts's `ACT_SVC_PORT` for the startup log and
the client's dial); after WP5 the client owns `SEQUENCER_PORT` and `server.ts` imports it for its
log line.

### (b) An abort

The GUI's abort is the same command with an abort state id (e.g. `Engine Abort`, id 17, from the
config's `[[states]]`): steps 1-6 of (a) with `TRANSITION:Engine Abort\n`. There is no separate abort
path in the backend; the sequencer owns the abort batch (and its recorded defects C1-10, C4-3), and a
sequencer-initiated abort (threshold) reaches the backend only as `_SEQUENCER_STATE`, never through
`sequencer-client`. If :9998 is down the operator gets `ERROR "State transition failed: connect
ECONNREFUSED 127.0.0.1:<port>"` within one round trip, or `…: timeout` after 2 s if it is stalled
(G4 freezes both before 5.6 moves the code).

Zero/two owners: none. Observation kept: the backend never retries an abort that failed to reach
:9998; the operator sees the error and presses again. Not WP5's to change.

### (c) A board reconnect / board-status change

1. Board heartbeat `[0x10, board_id]` arrives through Elodin: board status keyed by the raw id, no
   slot. Owner: `server.ts` `updateBoard` (WP6: `board-status`). WP5 not on the path.
2. A session start reconnects Elodin; the backend's subscription pass computes the sensor table pairs
   for every enabled board. Owner of the pair list: `elodin-vtable-registry.buildVTableStreamSubscriptionList`.
   Owner of the slot it uses: `sensor-config.boardSlot` (after 5.5); owner of the `% 8` fold: the
   registry (unchanged).
3. The board's data then decodes to `PT<slot>.CH<n>` etc.: owner `elodin-protocol.ts` (decodes the
   packet id; never computes from a board id, so it does not call `boardSlot`).
4. The PT role names for that board (`PT_Cal.<role>` reverse map) come from
   `sensor-config.loadSensorRoleMap`, now via `boardSlot`. Same owner as the rule.

Zero/two owners after WP5: the rule itself still has three homes until WP6 2.3 and WP7 2.2 replace
`server.ts:344` and `elodinSlotFromBoardId` (plus the frontend copy, out of scope). Those two are
**scheduled** second owners, each with its gap test (G6, H4) before removal. Recorded, not fixed here.

### (d) A calibration save via HTTP

`POST /api/calibration_profiles/save` → `api-server.ts` (WP7: `api/calibration.ts`) → 403 gate →
`readJsonBody` → `routes/calibration-profiles.saveCalibrationProfile(name)` copies the live cubic
store into `profiles/<name>.json` → 200 with the profile list. WP5 is **not** on this path. What WP5
does around it:

- deletes `calibration-sidecar.ts`, a dead client for a Python calibration sidecar on :8100 — a
  would-be second owner of "save calibration" that nothing calls;
- keeps `calibration.ts`'s two harness-held exports (§1.1); `loadPTCalibration` (the backend's
  coefficient loader) is unchanged.

Zero/two owners: none introduced. The pre-existing three calibration stores (C3-3, C5-5, BLOAT-MAP
§3) are Parked, not WP5's.

---

## 6. Steps and checks

One queue item (not a god-file split: D39's pass-1/pass-2 rule does not apply), commits in this
order, each green on its own:

| # | commit | notes |
|---|---|---|
| 5.1 | delete `calibration-sidecar.ts`, `ota-flash.ts`, `server-types.ts`; reword `ota_service_main.cpp:13` to name the protocol without the deleted file ("Protocol (board OTA listener):") | the C++ change is a comment; `clang-format` the file per AGENT-RULES 10 |
| 5.2 | `git mv src/operators.test.ts src/__tests__/operators.test.ts`; its `import('./operators.js')` → `'../operators.js'` | test count unchanged |
| 5.3 | `git mv src/legacy src/state-csv`; `server.ts:39-41` and `__tests__/ball-valve.test.ts:22` import paths | the loaders' `join(__dirname, '..', '..', '..', '..', rel)` keeps its depth (same nesting), and `join` normalises the directory name away, so the `Trying: <path>` log lines are byte-identical. Pipeline harness comments that say `legacy/` (`pipeline/run.sh:134,186-187`, `make_fixture.py:121`, README) are C0-owned comments: reported, not edited |
| 5.4 | drop `getActuatorChannel`, `getNumActuatorsFromCSV`, `buildTransitionMap`, `isTransitionAllowed` (and `_transitionMap`) | **keep** `ACTUATOR_CHANNEL_BY_NAME` (used by `parseStateActuatorsCSV`; its import-time warning is in the startup log) and `buildCSVSearchPaths`. Keep `calibration.ts` as is (§1.1) |
| 5.5 | add `boardSlot` to `sensor-config.ts`; replace `sensor-config.ts:59`, `:116`, `elodin-vtable-registry.ts:249-250`, `state-csv/state-actuators.ts:122-123` | each replacement is `<name> = boardSlot(<expr>)`, guards untouched; the registry's fold line untouched |
| 5.6 | create `sequencer-client.ts` from `server.ts:1409-1441` (body verbatim, function renamed `sendToSequencer`, `ACT_SVC_PORT` → `SEQUENCER_PORT` defined there from the same `process.env.ACTUATOR_SERVICE_PORT ?? '9998'`); delete `server.ts:1443-1467` and `:74-75`; `server.ts` imports `{ sendToSequencer, SEQUENCER_PORT }` after its last existing import and uses `SEQUENCER_PORT` in the `Actuator service: localhost:` log | **G4 must exist first.** The five call sites change name only; the dead `.catch(() => {})` on `debug_mode` and the SCRIPTS poll stay (DESIGN-WP6 §4.2: promise shapes unchanged) |

| 5.7 | extract `duePairs(desired, state, now)` from `subscribeVTables` (`elodin-vtable-registry.ts:386-401`): the loop body verbatim, the three clauses in today's order (subscribed or parked → skip; rejected with `nextAttemptMs > now` → skip; else due), `now` still taken from `nowFn()` once by the caller; `subscribeVTables` calls it with its module sets | D42(d). Pure, exported for tests, no new user. `vtable-subscriptions.test.ts`, `subscription-fence.test.ts`, `elodin-reconnect.test.ts` run **unedited**. Mutation: drop the `subscribedVTableStreamPairs.has` clause → `vtable-subscriptions.test.ts` red. Log lines (`📡 VTableStream: sent …`) unchanged: `skipped` is returned, not recounted |

**Checks for every commit** (no ports): `npx tsc --noEmit` exit 0 (D40); backend `npm test` with no
failure outside `baseline_vitest_failures.txt`; `grep -rn "legacy/\|server-types\|ota-flash'\|calibration-sidecar" src` prints nothing after 5.3;
**the esbuild module-order diff** of DESIGN-WP6 §6.3 item 6 (D42(a)): the only permitted changes
are the deleted files leaving the list (5.1 — they are unreachable, so in practice none),
`legacy/*` → `state-csv/*` renamed in place (5.3), and `sequencer-client.ts` appearing (5.6). Two
WP5 edits interact with import elision, both harmlessly: 5.6 leaves `server.ts`'s `import * as net`
without a user (a Node builtin; its evaluation is not observable), and 5.5's new
`sensor-config.js` imports in the registry and the loaders are value imports of a module that is
already evaluated earlier (`server.ts:31`).

**Mutations** (each must go red, then be reverted):
- 5.3: point `ball-valve.test.ts`'s import at a stub `state-csv/state-actuators.js` whose
  `resolveActuatorCmdEntity` returns `null` → `ball-valve.test.ts` red (proves the re-pointed import
  is exercised, not vacuous).
- 5.5: `boardSlot` returns `m` (drop the 0 → 10) must go red. **No existing test has a
  `board_id % 10 == 0` board on these four paths** (checked: `vtable-subscriptions.test.ts` uses
  21, 22, 12, 41; the pipeline fixture's board 60 never streams). So 5.5 is preceded by **G-W5**, a
  backend vitest WP5 adds itself (pure functions, white-box allowed by D20), with a temp-dir
  `CONFIG_PATH` fixture: `hpBoardNumbers(cfg)`, `loadSensorRoleMap()`,
  `buildVTableStreamSubscriptionList(cfg)` and `resolveActuatorBoardSlotAndChannel(name)` for boards
  10, 20, 21 and an actuator role on board 20 (expect slot 10, 10, 1, 10; and the registry's fold
  turns 10 into 2). Mutation above → red; restore → green.
- 5.6: change the predicate to `reply === 'OK'` must go red. **No golden sends a valid hold today**
  (`pipeline/session.ts:236` sends `holdMs: -5`, rejected before :9998). G4 therefore also freezes
  one accepted hold (`state_transition` with a valid `holdMs` to a state that takes one: the reply
  is `OK:<ms>`, no `ERROR` follows). Mutation → an `ERROR "State transition failed: OK:<ms>"` line
  appears → red. Change the timeout to 3000 → G4's stalled-sequencer bound red.

**Under the stack lock, once at the end** (one hold, AGENT-RULES 7): `pipeline/run.sh pt boards`,
`lifecycle/run.sh` (G4 lives there). `test_integration.sh` in the merge queue's full gate.

---

## 7. Parked / defects (reported, not fixed)

- `calculatePressure` / `inversePressureToAdc` have no production caller but are frozen by the C3
  golden; deleting them is a team decision (it shrinks a golden).
- `elodin-relay.ts` + `npm run relay` (BLOAT-MAP: PARK until WP11 confirms no tool uses ws :9090).
- The frontend's two slot copies (`frontend/lib/sensor-info-entities.ts:13`, `frontend/lib/store.ts:209,279`):
  frontend out of scope; listed so WP12's docs do not claim "one slot rule".
- The registry's `((n - 1) % 8) + 1` fold (D-SLOT) stays.
- Making `state-csv/state-actuators.ts`'s three import-time maps lazy (research
  `node-realtime-backend.md` Q3): it would move a config read and its log lines out of the import
  and into the first call — a startup-log change. Not in WP5; it is why DESIGN-WP6 needs R1a's bare
  import.
- `duePairs` is the place a stale-binding or no-delivery clause would go (D-SUB, D-ECHO;
  `research/subscription-robustness.md` Ideas 2, 4): PROPOSALS for the team, not WP5.

## 8. STYLE.md conformance (55d140ef; LEDGER D43)

Applied: STYLE-S5 (`sequencer-client.ts` is named for the peer it owns the exchange with, not a
pattern; `state-csv/` names what the directory holds); S6 (`sendToSequencer` sends to one peer;
`boardSlot`, `duePairs` are pure queries); S7 (the env var `ACTUATOR_SERVICE_PORT` and the
`→ actuator_service` / `actuator_service connect error` log texts are kept although the module is
renamed); S14 (the client keeps `{ok, reply}` and never rejects); S15 (the `Trying:` and
`📡 VTableStream:` lines byte-identical); S19 (the state-CSV loaders' import-time config read is
frozen, not copied into new code); S30 (both new exports' modules have no import-time effects);
S34 (no new class, interface or knob; `duePairs` is a one-call-site extraction that only moves
code, its `PairState`/`VTablePair` types carry existing values); S35 (the :9999 sender is deleted,
not generalised); S36 (stub headers); S40 (new file: 2 spaces, single quotes, semicolons).

**Choice that needs the orchestrator's check:** STYLE-S20 says the process environment is read once,
in `server/env.ts`. `SEQUENCER_PORT` is read in `sequencer-client.ts` instead (it lands before WP6,
and a `src/`-level module importing `server/env.ts` would be an upward edge). Details and a proposed
wording in DESIGN-WP6 "Interfaces", item 1.
