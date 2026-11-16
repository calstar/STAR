# WP6 debate — round 1, advocate C: layered dataflow (functional core / imperative shell)

Lines are `server.ts` on `backend-remastered` (= the note's `b2599617`).

## 0. Position and concessions

DESIGN-WP6 rejected C as a `state.ts` god file — rightly. The better cut keeps **A's 16 modules,
A's ownership table (§1.2) and A's step 1 verbatim** (every rule and check of §6.1–6.3). B loses
as the note says: every body gains `this.`, so there is no move-only pass.

C differs in **one rule** and **what step 2 aims at**:

> **Core modules decide; shells send.** `board-status`, `engine-state`, `actuator-mismatch`,
> `mission-time`, `calibration-state`, `config-caches` never import `ws-clients` or
> `notifications`' senders. They take observations and `now`, mutate only their own state, and
> **return** the frames/payloads they want on the wire. The shells — `server.ts`, `ws-connection`,
> `ingest`, `commands`, `ws-clients`, `notifications`, `history`, `elodin-link`,
> `sequencer-client` — are the only code that calls `send`, `broadcast` or
> `broadcastNotification`; `server.ts` holds every `setInterval`.

"Pure-ish" means no socket, no send, no interval — not I/O-free: config reads stay where
`STYLE-S19` puts them (`:154,338,394,577`), logs where they are (`:416,561`); the two
state-driven `setTimeout`s (`:482`, `:1505`) and the `SCRIPTS` poll (`:1253`) stay in their
modules as A has them — shell lines barred from `ws-clients`. `updateBoard` may still
`boardsStatus.set`; it may not `broadcastBoardStatus()`.

This is M1 (`STYLE-S30`) extended from "no effects at import" to "no sends outside the shell";
the tree already does it where it hurt: `linkStatus` (`client-outbox.ts:326-334`, "being pure
is what makes it testable — a setInterval is not"), `FlushPacer` (`:365`), `planBackfillSlices`
and the `DrainableSocket` port (`history-backfill.ts:67,112`), each with a vitest; WP5's
`duePairs` (`D42(d)`). The
research asks it of A's own step 2 (`node-realtime-backend.md:195-197`: the `note*` functions
"only if they take values and return/record decisions, not `ws`"). A writes that as a hope; C
makes it the gate.

## 1. Modules (A's names), direction, state

| module | owns (state) | after step 2 |
|---|---|---|
| `env`, `stats`, `config-caches`, `calibration-state` | knobs, counters, slot maps, host, `lastRawAdc` | core |
| `ws-clients` | sockets, outboxes, keepalive | **shell** (the only `ws.send`) |
| `notifications` | active keys, buffer | shell sink: `raise`/`clear`/`broadcastNotification` |
| `history` | cache, backfill | shell (`planBackfillSlices` core) |
| `mission-time` | T+0, countdown | core: `noteFirstSample(now) → frame \| null` |
| `sensor-stream` | envelopes, throttle gate | `streamBudgetFor`/`saneSampleTimeMs` core; `emitSensor*` shell (per-row loop untouched, §4) |
| `board-status` | boards, sweep edge state, self-test snapshot | core: `updateBoard`, `noteT7Alive`, `staleSweep(now)`, `noteSelfTestResults` **return frames** |
| `engine-state` | state, debug, bitmask, reasons, actuator map | core: `applySequencerState(rows) → frames[]`; the `SCRIPTS` poll is its shell line |
| `actuator-mismatch` | sensed map, 5 s timer | core: `checkActuatorMismatch(state, activeKeys, now) → payload \| null` |
| `elodin-link` | `elodin`, resubscribe timer, `lastIngestMs` | shell (`nextResubscribeDelay(res, now)` core, `:1512-1516`) |
| `ingest`, `commands`, `ws-connection` | nothing | shells: catch at the boundary (`STYLE-S9`), send returned frames |
| `server.ts` | — | composition root: §1.3 rows 1–31 as statements |

Direction: A's DAG, plus one edge rule a grep enforces after step 2:
`grep -l "from './\(ws-clients\|notifications\)\.js'" src/server/{board-status,engine-state,actuator-mismatch,mission-time,calibration-state,config-caches}.ts`
prints nothing. A's DAG lets every layer import `ws-clients`; C, only shells.

## 2. The flows

**Fire command (and GUI abort — same path, abort id).** `ws-connection` → `commands.handleMessage`
→ control gate (`:1270`) → `engine-state.resolveTransitionTarget` ([A3]) → hold check, line → `sequencer-client.sendToSequencer` → `ERROR` to the requester only (`:1322-1327`). As A: `commands` *is* a shell (a TCP `.then`) and stays impure. The difference is the return path: `_SEQUENCER_STATE` → `ingest` (`notePairDelivered` first, [A7]) → `engine-state.applySequencerState(rows)` assigns, counts, and **returns** `[state_update, commanded sensor_update…]` from today's literals (`:1260-1264`, `:461-468`; `history.record` stays inside, it is state); `ingest` broadcasts them in order, then `scheduleActuatorMismatchCheck(currentState)` — today's `:1712-1714`. 5 s later `actuator-mismatch`'s timer line calls `checkActuatorMismatch(state, activeKeys, now)` (`activeKeys` a `ReadonlySet`, [A9b]), which returns the raise or clear payload (`:506-516`) or null; the shell hands it to `notifications`. A sequencer-initiated abort enters at `_SEQUENCER_STATE`, as in A's walkthrough (b).

**Board reconnect.** Heartbeat `[0x10]` → `ingest` → `board-status.updateBoard(low, payload, now)` mutates and returns the `board_status_update` frame when `wasDisconnected` (`:558`), else null; `ingest` broadcasts. The 1 s timer in `server.ts` (row 13) calls `board-status.staleSweep(now)`, which walks `boardsStatus` in insertion order and returns an **ordered list** — per-board notification payloads (`:677-716`), then the status frame if `changed` (`:721`) — that the timer arrow broadcasts in order. Wire order is unchanged; the three 1 s timers stay three `setInterval`s ([A5], research §2). The note's "sweep fits no stage": timer → reducer → frames; the timer was always `server.ts`'s (A's R2 row 13). Self-test rows → `noteSelfTestResults(boardId, rows, now)` returns the `self_test_fail_<id>` payload or null (`:1673-1694`, `break` kept). Connect burst: `ws-connection` asks each owner for its frames (`boardStatusFrame()`: the as-is shape of `:1052-1054`, without the sweep's `dhcp`/`frequencyHz` recompute at `:924-933`; `selfTestReplay()`, …) and does every `send` and counter itself — A's 2.8 has owners send **and** return counts ([A9d]); C's owners never see a socket.

**Calibration save.** HTTP → WP7 → `onCalibrationReload` → `publishCalibrationReload(calibrationHost)`; WS → `commands` → `handleCalibrationCommand(calibrationHost, ws, …)` over `lastRawAdc` (`calibration-state.noteRawAdc`, core). `CalibrationHost` is already an injected port with two users; as A.

## 3. Why C over A (and B)

- **Testability, where the goldens cannot reach.** G1 (`actuator_mismatch`) fires in no golden;
  its first script was infeasible and two candidates await C0 (§7); G2 needs a simulator option,
  G3 a rogue board — yet A ranks G1 MUST before 1.11/1.12. With C, `staleSweep` over a seeded
  `boardsStatus` and edge state pins `board_lost_`, `setup_stuck_`, `unrecognized_` in one
  vitest; `checkActuatorMismatch` pins G1. `D20` allows
  exactly this white-box: "pure functions with stable signatures". A's testability "comes from
  M1", but testing `board-status` still means mocking `ws-clients`.
- **Clarity.** `markStaleBoards` (`:661-722`) interleaves four notification families with `Set`
  mutation and sends; as a reducer the rule is one function with one output.
- **Future fixes land as clauses.** D-SUB's watchdog (research §4, Ideas 4/5) and D-HB are
  PROPOSALS; each becomes one reducer clause plus one unit test.
- **Concessions.** Lines: C's step 2 is net **+20–40 over A**. Fit with characterization: equal
  (same entrypoint, same `lc-tare` re-point). Move-only feasibility: equal — step 1 *is* A's;
  C's shape is reached only in step 2.

## 4. Three objections, answered

1. **D17(d)/STYLE-S34: "frames out" is a single-user abstraction.** No new type. The verdict is
   already in the payload: `ongoing: true` at `:511,677,696,711,1683` is always followed by
   `activeNotificationKeys.add`, `ongoing: false` at `:514,680,702,715` by `delete`, keyless
   `:686` by neither (nine of nine). Shell rule:
   `ongoing === true → raiseNotification(p)`, `false → clearNotification(p)`, else
   `broadcastNotification(p)` ([A9a]). A returned array of today's literals is a carrier
   (`D43(3)`), one caller each.
2. **Step 2 rewrites the least-guarded code and risks G9 key order and timestamps.** Conceded, so
   the C commits run **after** G1–G3 exist (A's gap table unchanged). Payload literals move
   verbatim — only `broadcastNotification(` becomes `out.push(`. Returned payloads still go through
   `notifications.broadcastNotification`, so `at = Date.now()` and the buffer push (`:647-652`)
   happen as today; the stamp moves by one loop's microseconds — the class A's 2.8 accepts for
   `lastOutboundAt`. A `Date.now()` taken at send (the snapshot's `t`, `:1062`) is the shell's,
   passed in.
3. **R7, the ingest hot path.** C touches only timer- and event-driven decisions (sweep, mismatch,
   `_SEQUENCER_STATE`, heartbeats, self-test). The per-row loop (`:1723-1812`) stays verbatim or
   follows A's 2.1; research §5 names R7 as the cost; I own it.
