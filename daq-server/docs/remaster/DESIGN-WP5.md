# DESIGN-WP5 — backend dead TS, the sequencer line client, the slot helper

Target-design note for WP5 (BLOAT-MAP §2a, §3, WP5 row; LEDGER D39, D44, D60, D70). **Design
final** (rounds 1-2: D60, D70). Design only: nothing here has been executed. Paths are relative to
`daq-server/diablo_server/backend/src/` unless stated. Line numbers are `backend-remastered` @
`85a02f9a` (product code equal to `main`), re-verified against `git show backend-remastered:…` @
`7d9436b5` for the simplicity round 1 (D60) and @ `f04c00f7` for round 2 (D70).

WP5 is not a god-file split, but it is the first package to move code out of `server.ts` and it
creates the two helpers WP6 and WP7 build on, so it gets the same treatment: alternatives,
interfaces (`design-stubs/ts/src/`), walkthroughs.

**Contract (frozen, D5/D17).** TCP :9998 command lines, their 2 s timeout and the reply predicate
(`OK` or `OK:<ms>`); the log lines `[ThinServer] → actuator_service: <line>` and
`[ThinServer] actuator_service connect error: <msg>`; every Elodin entity name and subscription pair
derived from a board id; the import-time log lines of the state-CSV loaders and their order in the
startup log (DESIGN-WP6 G12); every export a characterization harness imports by path.

**Prerequisites.** C1 merged; the `tsc --noEmit` gate step (D40); **G4** exists **before** commit
5.6 (it also gates DESIGN-WP6 commit 1.15, `server/commands.ts`); G-W5 (§6) exists before commit
5.5. Both are **C0 test-only packages** that land before WP5 (D44(3), D70), not WP5 commits. G4 is
a **new pipeline mode `holds`** (`test/characterization/pipeline/`, §6) — not lifecycle, which
runs no sequencer (`lifecycle.py:859` "no sequencer, state UNKNOWN"), and not the frozen `pt` /
`boards` / `nocal` sessions. It freezes, black-box, one accepted hold (`OK:<ms>`, no `error` frame,
the following `state_update`), :9998 slow (`… timeout`, with an upper bound on the reply)
and :9998 down (`… connect ECONNREFUSED 127.0.0.1:<port>`). DESIGN-WP6 §7's G4 bullet is amended
to point here.

---

## 1. What WP5 owns

| item | today | source of truth |
|---|---|---|
| dead files | `calibration-sidecar.ts` (143), `ota-flash.ts` (138), `server-types.ts` (40): unreachable from every entrypoint, imported by no test or harness | BLOAT-MAP §2a (re-checked: `grep -rn` over `src`, `frontend`, `shared`, `test/` finds only `api-server.ts`'s URL string `/api/ota-flash`) |
| misplaced test | `operators.test.ts` beside its module (vitest has no config; it collects `**/*.test.ts`, so the move changes nothing it runs) | BLOAT-MAP §2a |
| the `:9998` line client | `server.ts:1411-1441` `sendToActuatorService` (5 call sites: 4 in `handleCommand` — `state_transition`, `actuator`, `debug_mode`, `extend_fire` — and 1 in `refreshScriptStatus`); `server.ts:75` `ACT_SVC_PORT` | BLOAT-MAP §3 |
| the dead `:9999` client | `server.ts:1443-1467` `sendToControllerService` (no caller), `server.ts:76` `CTRL_SVC_PORT` (read only by it) | D39: delete, do not fold |
| the slot rule `board_id % 10, 0 → 10` | **six** copies in the backend: `sensor-config.ts:59`, `:116`; `elodin-vtable-registry.ts:249`; `legacy/state-actuators.ts:122`; `api-server.ts:97` (`elodinSlotFromBoardId`); `server.ts:344` | BLOAT-MAP §3 (five) + DESIGN-WP6 R5 (sixth) |
| `legacy/` | `state-actuators.ts`, `state-transitions.ts`, `state-ids.ts`: live (server.ts:39-41), misnamed | BLOAT-MAP §3 |
| unused exports | `state-actuators.ts` `getActuatorChannel`, `getNumActuatorsFromCSV`; `state-transitions.ts` `buildTransitionMap`, `isTransitionAllowed`; `calibration.ts` `calculatePressure`, `inversePressureToAdc` | BLOAT-MAP §2a — **two of these are not unused, see §1.1** |
| a stale C++ comment | `daq-server/diablo_server/services/ota/ota_service_main.cpp:13` "Protocol (matches ota-flash.ts)" (not under `backend/src/`) | BLOAT-MAP WP5 row |
| a module that goes dead at 5.4 | `shared-types.ts` (23 lines): its one value importer is `legacy/state-transitions.ts:8`, whose only value use of `SystemState` is inside `buildTransitionMap` (`:137`) | found in this note's review (§1.1); re-pointing the two `import type` importers is WP7/WP12's (§7) |

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
- **WP5 touches `elodin-vtable-registry.ts` only at its slot line** (5.5). The `duePairs`
  extraction of D42(d) was **dropped by D60** (simplicity round 1): under D49's test it is
  prospective — D-SUB and D-ECHO are proposals, and no golden or test needs the pure function —
  the same ground D49 used for WP6's 2.10. D42(d) is superseded by D60. DESIGN-WP6 states that WP6
  does not touch the registry either; the "which pairs are due" loop stays inline in
  `subscribeVTables` (`:383-401`). `test/test_duplicate_subscription.ts` (the only C6-2
  reproducer, parked — not deleted — by WP4, D42(e)) is not touched by WP5.
- **`shared-types.ts` goes dead at 5.4.** Its only value importer is `legacy/state-transitions.ts:8`
  (`import { SystemState } from '../shared-types.js'`), and that module's only *value* use of
  `SystemState` is `SystemState[id]` inside `buildTransitionMap` (`:137`); the other uses (`:17-18`,
  the `Transition` interface) are types. Once 5.4 deletes `buildTransitionMap`, the import is
  type-only and the bundler elides it (D42(a)), so `shared-types.ts` leaves the esbuild module
  order. 5.4 makes the import an explicit `import type` and accepts the order change as a reviewed
  cleanup diff (D44(2)); the reason it is safe is in §6. The remaining importers are both
  `import type` (`elodin-query.ts:11`, `api-server.ts:40`), so the file is dead code after 5.4;
  re-pointing them at `../../shared/types.js` and deleting the file is left to WP7/WP12 (§7).
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
Idea 1 (one `boardSlot()` home is the remaster half of making the table-id map injective later);
its Idea 5 (a pure "which pairs are due" function) was adopted as D42(d) and then dropped by D60
(§1.1).

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
| `sequencer-client.ts` (new) | one request/reply exchange with `sequencer_service` on TCP :9998 | `SEQUENCER_PORT`, `sendToSequencer(line): Promise<{ ok: boolean; reply: string }>` (the inline type the verbatim move keeps; no named interface, D60) — `design-stubs/ts/src/sequencer-client.ts` | WebSocket, message types, which commands exist, what a refusal means (`refusal-text.ts` is the caller's), sessions |
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

(4-space indent: `sensor-config.ts`'s own, as at `:59-60`; the new `sequencer-client.ts` is a new
file and takes STYLE-S40's 2 spaces, §8.)

Every caller keeps its own guard (`typeof … === 'number'`, the registry's `Number.isInteger && 1..255`,
`asBoardId`'s fallbacks); `boardSlot` adds no validation. For the record: `-21 → -1`, `21.5 → 1.5`,
`NaN → NaN`, exactly as each copy computes today.

---

## 4. Interfaces

The public surface is written as type-checked stubs in `design-stubs/ts/src/` (see that directory's
`tsconfig.json` and DESIGN-WP6 "Interfaces" for the command; not under `diablo_server/`, imported by
nothing):

- `sequencer-client.ts` — `SEQUENCER_PORT`, `sendToSequencer` (its return type stays the inline
  `{ ok: boolean; reply: string }` of `server.ts:1411`; D60 dropped the `SequencerReply` interface
  the stub had named).
- `sensor-config.ts` — `boardSlot` (and, from WP7, `buildSensorConfig` / `SensorConfigEntry`).
- `state-csv/state-actuators.ts`, `state-csv/state-transitions.ts`, `state-csv/state-ids.ts` — the
  exports that survive WP5.

There is no registry stub: the `duePairs` delta it described was dropped (D60, §1.1).

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
ECONNREFUSED 127.0.0.1:<port>"` within one round trip, or `…: timeout` after 2 s if it is stalled.
G4 — the `holds` pipeline mode (§6) — freezes both before 5.6 moves the code, and the accepted
hold beside them: the one path through steps 3-4 where the reply is `OK:<ms>` rather than `OK`,
which no frozen session takes today (`pipeline/session.ts:236` sends `holdMs: -5`, rejected before
:9998; `ws_data_flow_test.ts:1429-1491` sends an accepted hold but never asserts its `errors`
collector (`:1352`), so `test_integration.sh` does not freeze the predicate either).

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
| 5.1 | delete `calibration-sidecar.ts`, `ota-flash.ts`, `server-types.ts`; reword `daq-server/diablo_server/services/ota/ota_service_main.cpp:13` to name the protocol without the deleted file ("Protocol (board OTA listener):") | the C++ change is a comment; `clang-format` the file per AGENT-RULES 10 |
| 5.2 | `git mv src/operators.test.ts src/__tests__/operators.test.ts`; its `import('./operators.js')` → `'../operators.js'` | test count unchanged |
| 5.3 | `git mv src/legacy src/state-csv`; `server.ts:39-41` and `__tests__/ball-valve.test.ts:22` import paths, **and any C0 test added since this note that imports `legacy/`** (G-W5 imports `legacy/state-actuators.js` for `resolveActuatorBoardSlotAndChannel`; the §6 grep after the commit proves `src` — vitests included — is clean; a C0 harness importing by path would be the Contract's frozen surface, and none does: `git grep -n "legacy/" backend-remastered -- daq-server/test` finds only this row's comments and `archive/legacy/…` paths, a different directory); **in the same commit**, the pipeline harness's comments (D44(7); D18, comments only): the literal paths at `test/characterization/pipeline/run.sh:186-187` (`legacy/state-actuators.ts`, `legacy/state-transitions.ts` → `state-csv/…`), and the prose "the legacy state-CSV loaders" at `run.sh:134` and `pipeline/README.md:57,:279` and "the backend's legacy loaders" at `pipeline/make_fixture.py:121` → "state-CSV loaders" | the loaders' `join(__dirname, '..', '..', '..', '..', rel)` keeps its depth (same nesting), and `join` normalises the directory name away, so the `Trying: <path>` log lines are byte-identical. The harness edits are comments and README prose: no golden, no harness logic. `docs/BALL_VALVE_BOARD_PLAN.md:153` also says `legacy/state-actuators.ts`; it is a design doc, WP12's (§7) |
| 5.4 | drop `getActuatorChannel`, `getNumActuatorsFromCSV`, `buildTransitionMap`, `isTransitionAllowed` (and `_transitionMap`); make `state-transitions.ts:8` an explicit `import type { SystemState } from '../shared-types.js'` | **keep** `ACTUATOR_CHANNEL_BY_NAME` (used by `parseStateActuatorsCSV`; its import-time warning is in the startup log), `buildCSVSearchPaths`, and the `./state-ids.js` import (`csvStateMap` is still called at `:34`). Keep `calibration.ts` as is (§1.1). **Accepted order change, reviewed (D44(2)):** `shared-types.ts` leaves the esbuild module order (§1.1). Safe because (i) its only import-time act is `await import('../../shared/types.js')`, a module already evaluated at position 7 of 46, so nothing new runs and nothing stops running; (ii) `state-transitions.ts` has no top-level statement but its `__filename`/`__dirname` consts and function declarations (no log, no config read), so its body evaluating at its static position (35) instead of after the top-level-`await` deferral is not observable; (iii) with that `await import` gone the graph has no top-level await left, so the static order the check prints *is* the runtime order from 5.4 on |
| 5.5 | add `boardSlot` to `sensor-config.ts`; replace `sensor-config.ts:59`, `:116`, `elodin-vtable-registry.ts:249-250`, `state-csv/state-actuators.ts:122-123` | each replacement is `<name> = boardSlot(<expr>)`, guards untouched; the registry's fold line untouched |
| 5.6 | create `sequencer-client.ts` from `server.ts:1409-1441` (body verbatim, function renamed `sendToSequencer`, return type the inline `{ ok: boolean; reply: string }` as today; `ACT_SVC_PORT` → `export const SEQUENCER_PORT = parseInt(process.env.ACTUATOR_SERVICE_PORT ?? '9998', 10);`, the `:75` line in full, exported, with only the name changed); delete `server.ts:1443-1467` and `:75-76` (`ACT_SVC_PORT`, `CTRL_SVC_PORT`; `:73` `ELODIN_HOST` and `:74` `ELODIN_PORT` stay); `server.ts` imports `{ sendToSequencer, SEQUENCER_PORT }` after its last existing import and uses `SEQUENCER_PORT` in the `Actuator service: localhost:` log | **G4 — the `holds` pipeline mode, a C0 test-only package (D44(3), D70) — must exist first;** it is also the gate for DESIGN-WP6 1.15. The five call sites change name only; the dead `.catch(() => {})` on `debug_mode` and the SCRIPTS poll stay (DESIGN-WP6 §4: promise shapes unchanged). After this commit nothing in `server.ts` uses `net` (its two uses, `:1420` and `:1452`, both move or go), so a cleanup line **may** delete `import * as net from 'net'` (`server.ts:24`): a Node builtin with no import-time effect, so the module order is unchanged. `CONTROLLER_SERVICE_PORT` is then read by nothing; the harnesses that set it (`lifecycle.py:927,1544`, `pipeline/run.sh:194`) stay as they are — an env var no process reads, in no golden |

There is no 5.7: the `duePairs` extraction was dropped by D60 (§1.1).

**Checks for every commit** (no ports): `npx tsc --noEmit` exit 0 (D40); backend `npm test` with no
failure outside `baseline_vitest_failures.txt`;
`grep -rnE "legacy/|server-types|from '\./ota-flash|calibration-sidecar" src` prints nothing after
5.3 (the pattern is `from '\./ota-flash` — or `ota-flash\.[jt]s` — and not `ota-flash'`, which
would match the live URL literal `'/api/ota-flash'` at `api-server.ts:1169`; the `src` scope is
deliberate: the tracked, stale `backend/dist/` — 27 `.js` files whose `server.js:30,34` and
`elodin-relay.js:15` still import `legacy/…` — is WP1's to delete, BLOAT-MAP §2, and a repo-wide
grep would never go clean before it does);
**the esbuild module-order diff** of DESIGN-WP6 §6.3 item 4 (D42(a), D44(2)): the only permitted
changes are the deleted files leaving the list (5.1 — they are unreachable, so in practice none),
`legacy/*` → `state-csv/*` renamed in place (5.3), `shared-types.ts` leaving the list (5.4, the
reviewed cleanup diff of the 5.4 row; every other module keeps its relative position), and
`sequencer-client.ts` appearing (5.6). Two WP5 edits interact with import elision, both
harmlessly: 5.6 leaves `server.ts`'s `import * as net` without a user (a Node builtin; its
evaluation is not observable, whether the cleanup line deletes it or not), and 5.5's new
`sensor-config.js` imports in the registry and the loaders are value imports of a module that is
already evaluated earlier (`server.ts:31`). The same 5.5 edge is harmless in `elodin-relay.ts`
(the parked second entrypoint, BLOAT-MAP §2, type-checked by the same `tsc` since `tsconfig.json`
includes `src/**/*`): it already imports both the registry (`:15`) and `sensor-config` (`:16`)
directly, so the registry gaining a `sensor-config` import adds no module to its graph.

**Mutations** (each must go red, then be reverted):
- 5.3: point `ball-valve.test.ts`'s import at a stub `state-csv/state-actuators.js` whose
  `resolveActuatorCmdEntity` returns `null` → `ball-valve.test.ts` red (proves the re-pointed import
  is exercised, not vacuous).
- 5.5: `boardSlot` returns `m` (drop the 0 → 10) must go red. **No existing test has a
  `board_id % 10 == 0` board on these four paths** (checked: `vtable-subscriptions.test.ts` uses
  21, 22, 12, 41; the pipeline fixture's board 60 never streams). So 5.5 is preceded by **G-W5**, a
  backend vitest that lands as a **C0 test-only package** before WP5 (D44(3); pure functions,
  white-box allowed by D20). Its config fixture follows the established pattern
  `vi.mock('../routes/config.js', () => ({ readConfig: () => config, readDeployedConfig: () => config }))`
  (`__tests__/ball-valve.test.ts:18`), **not** a temp-dir `CONFIG_PATH`: `routes/config.ts:17`
  reads `CONFIG_PATH` once at module load, so an env var set inside a test is too late. It calls
  `hpBoardNumbers(cfg)`, `loadSensorRoleMap()`, `buildVTableStreamSubscriptionList(cfg)` and
  `resolveActuatorBoardSlotAndChannel(name)` for boards 10, 20, 21 and an actuator role on board
  20 (expect slot 10, 10, 1, 10; and the registry's fold turns 10 into 2). Mutation above → red;
  restore → green.
- 5.6: change the predicate to `reply === 'OK'` must go red. **No golden sends a valid hold today**
  (`pipeline/session.ts:236` sends `holdMs: -5`, rejected before :9998; `ws_data_flow_test.ts:1429-1491`
  sends one but never asserts the `errors` collector it attached at `:1352`, so `test_integration.sh`
  would stay green under this mutation). G4's `holds` mode (below) therefore freezes one accepted
  hold (`state_transition` with a valid `holdMs` to a state that takes one: the reply is `OK:<ms>`,
  no `error` frame follows, then the `state_update`). Mutation → an `ERROR "State transition
  failed: OK:<ms>"` line appears → red. `holds` also states an **upper bound on the timeout
  reply**: with the sequencer SIGSTOPped, `ERROR "State transition failed: timeout"` arrives
  **≤ 2.8 s** after the command is sent — the 2000 ms socket timeout plus a margin wide enough for
  D34's macOS timer overshoot but narrower than the next round number. Mutation: change the timeout
  to 3000 → the reply lands after the bound → red. (DESIGN-WP6's G4 bullet said only "after ~2 s",
  which a 3000 would pass.)

**G4 = pipeline mode `holds`** (C0 test-only package, before 5.6 and WP6 1.15; D70). What it is,
fixed here so the C0 agent and the WP5 agent read the same thing:

- *Fixture.* `run.sh` accepts `holds` beside `pt|nocal|boards` (`:45`), maps it to `pt` for
  `make_fixture.py` as `nocal` does (`:126`; `make_fixture.py:55` asserts `pt|boards`), then, after
  `:127`, appends to `$CFG` the `[[states]] … is_flow = true` + `[flow]` block **exactly as
  `test/test_integration.sh:538-548` writes it** (`id = 21`, `name = "Flow Test"`,
  `return_target = "Press Standby"`, `duration_ms = 800`, `max_ms = 5000`, `gate_actuator = "Fuel
  Main"`), and points `transitions_csv` / `actuator_csv` / `actuator_delay_csv` (`:533-535`) at the
  three patched CSV copies that script builds at `:485-531` (the hub ↔ `Flow Test` rows, the gate
  `OPEN`, the 0.4 s gate delay) — the sequencer refuses a hold into a state it cannot return from.
  Golden dir `golden/holds/` (the `:255-256` pattern).
- *Session.* A fourth function in `session.ts` (dispatched at `:461`): unlock (the `:200`
  `control_unlock` send shape, but as operator A with the operator headers, `:231` — `:200` is
  viewer B's, refused `not_operator`), park on the hub (`state_transition` 2 then 20 — `Idle → Armed → Press
  Standby` is the CSV's only route), then **accepted hold:** `state_transition {state: 21, holdMs:
  800}` (valid, ≤ `max_ms`) → frozen: no `error` frame, the `state_update` into 21, and the
  auto-return `state_update` to 20 after 800 + 400 ms, inside the step's `settle`. **Slow half:**
  SIGSTOP the sequencer → `state_transition {state: 20}` (the hub it is parked on; the diagonal is
  `1`, so a drained line changes no state) → `ERROR "State transition failed: timeout"`; the
  harness computes `error.t − sent.t` from the frames it already stamps (`Frame.t`, `Sent.t`,
  `:27-28`) and emits one **categorical** line (`timeout_reply_within_2800ms: yes`, never the raw
  ms — N1/N2 do not cover it and a number would drift) through a per-step `notes: string[]` on
  `Step` (`:33`) that `characterize.py` prints under the step header in `ws_events.txt` (or C0's
  equivalent per-step carrier; the capture has only `frames`/`sent`/`http` today), **judged on CI
  per D34** (this Mac's timer overshoot can make it `no`); → SIGCONT. The backend destroyed its socket at 2 s
  (`server.ts:1439`) but the connection and the line sit in the listen backlog, so the resumed
  sequencer accepts, reads and applies it and its reply write fails harmlessly
  (`sequencer_main.cpp:243` `SIGPIPE` ignored, `:75` `MSG_NOSIGNAL`); whatever `state_update` it
  publishes lands inside the step's `settle` and is frozen, not raced. **Down half** (last; it is
  terminal): SIGTERM, wait for exit → `state_transition {state: 20}` → `ERROR "State transition
  failed: connect ECONNREFUSED 127.0.0.1:<port>"` (N5 → `<port:sequencer>`); `debug_mode` → no
  reply (the `.catch(() => {})` path). Nothing else in the session, so a WS/HTTP change elsewhere
  cannot fail it.
- *PID handoff.* `run.sh` hands `session.ts` the sequencer PID through `ports.json` (`:121`) —
  **rewritten after the spawn at `:164-165`**, since `:121` runs before the sequencer exists and
  `:127` has already consumed the file — under a key `sequencer_pid`, and `:243`'s inversion of
  `ports.json` into N5's `<port:name>` map **excludes** that key, or every 5-digit PID-valued
  number in the capture would be rewritten. The cleanup `kill` on an already-dead PID is
  `2>/dev/null` (`:107`).
- *`all`.* `holds` joins `run.sh all` (`:38-43`). Unlike `boards` on Darwin (`:55-62`, a
  loopback-alias precondition that exits early), it needs nothing this Mac lacks; its one
  CI-judged line is the only reason `all` may be red here.
- *Mutations* (each red, then reverted): predicate `reply === 'OK'`; timeout 3000; and, for the
  down half, `done(false, err.message)` → `done(false, 'connect error')` (the `console.warn` text
  is not a WS frame and would not move a golden) — each must change exactly one golden line.

**Under the stack lock, once at the end** (one hold, AGENT-RULES 7): `pipeline/run.sh pt boards
holds` (G4 lives in `holds`; lifecycle has no sequencer and is not on WP5's path).
`test_integration.sh` in the merge queue's full gate.

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
- The `duePairs` extraction (D42(d)) was dropped by D60: prospective under D49's test. A
  stale-binding or no-delivery clause (D-SUB, D-ECHO; `research/subscription-robustness.md` Ideas
  2, 4) remains a PROPOSAL for the team; whichever package adopts one extracts the decision then.
- `shared-types.ts` is dead after 5.4 (§1.1): its remaining importers are `import type`
  (`elodin-query.ts:11`, `api-server.ts:40`). Re-pointing them at `../../shared/types.js` and
  deleting the file is WP7's (it owns `api-server.ts`) or WP12's; not WP5.
- `CONTROLLER_SERVICE_PORT` is set by `test/characterization/lifecycle/lifecycle.py:927,1544` and
  `pipeline/run.sh:194` and read by nothing after 5.6. They stay as they are: an unread env var,
  in no golden.
- `docs/BALL_VALVE_BOARD_PLAN.md:153` says `legacy/state-actuators.ts:100-136`; a design doc, for
  WP12's docs pass.

## 8. STYLE.md conformance (55d140ef; LEDGER D43)

Applied: STYLE-S5 (`sequencer-client.ts` is named for the peer it owns the exchange with, not a
pattern; `state-csv/` names what the directory holds); S6 (`sendToSequencer` sends to one peer;
`boardSlot` is a pure query); S7 (the env var `ACTUATOR_SERVICE_PORT` and the
`→ actuator_service` / `actuator_service connect error` log texts are kept although the module is
renamed); S14 (the client keeps `{ok, reply}` and never rejects); S15 (the `Trying:` lines
byte-identical); S19 (the state-CSV loaders' import-time config read is frozen, not copied into new
code); S30 (both new exports' modules have no import-time effects); S34 (no new class, interface or
knob — the client's reply type stays the inline `{ ok: boolean; reply: string }`, D60); S35 (the
:9999 sender is deleted, not generalised); S36 (stub headers); S40 (new file: 2 spaces, single
quotes, semicolons). S20 as amended by D44(1): `SEQUENCER_PORT` is read by `sequencer-client.ts`,
the module that owns the knob.
