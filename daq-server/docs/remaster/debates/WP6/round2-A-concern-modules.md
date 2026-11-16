# WP6 debate — round 2, advocate A: rebuttal

Both opponents concede step 1, the 16 modules, the DAG and `server.ts` to A. The fight is what
step 2 aims at: B adds four `createX(deps)` factories, C bars six modules from sending. Lines:
`server.ts` @ `b2599617`.

## 1. Against B — the factory's bodies are not byte-identical, and its second user is a test

**The `now` dep is either dead or a body edit.** B lists `now` in every deps object and claims
bodies verbatim. Inside B's four concerns the clock is read nine times as `Date.now()` (`:492,
525, 582, 648, 662, 935, 1516, 1549, 1567`); five are `const now = Date.now();`, which *shadows*
a destructured `now`. Either every site becomes `now()` — nine body edits B's residue list omits
— or the injected clock is never called. B's own sketch ("`now` advanced 5 s") needs the edits.
The tree does not: `board-scan-rate.test.ts:17,23` uses `vi.useFakeTimers` + `vi.setSystemTime`,
`video.test.ts:394` `vi.spyOn(Date, 'now')`, `elodin-reconnect.test.ts:62` fake timers on a real
`ElodinClient`.

**The deps interface fails S34 as the tree applies it.** B's second user for `BoardStatusDeps` is
the vitest that lands with it. `CalibrationHost`'s second user produces a gate artifact
(`ts_harness.mts:149-160` → `calibration/golden/ts.txt`). Of B's seven "constructed" precedents,
five are *multi-instance* types (`HistoryCache`, `ClientOutbox` × N, `FlushPacer` × N,
`EnvelopeAccumulator` × 2, `ElodinClient`), where a class is simply right; the single-instance
injected ones are `VideoService` (`video/service.ts:127-130`) and `sendBackfill(…, deps)`
(`history-backfill.ts:112`) — against six module singletons plus `sessionManager`, constructed at
import (`:401`) as A does. Split, not B's.

**What B gains over A is one line.** B is right that `broadcast` dereferences `wss.clients`
(`:905`) while `wss` is unassigned until `attachWebSocketServer`, so an A vitest of
`markStaleBoards` throws unless it mocks `ws-clients`. That mock is `vi.mock('../ws-clients.js',
…)` — the idiom six backend tests already use for a path module (`ball-valve-cal.test.ts:13`,
`lc-tare.test.ts:22`, `ball-valve.test.ts:18`, `environmental.test.ts:7`,
`session-config-gate.test.ts:24`, `running-config.test.ts:35`). Four factories, four deps types
and nine clock edits replace one line per test file; and B concedes G1 and D-SUB still need a
config fixture or a mock.

## 2. Conceded to B

`:905` is real: §3.1's "testability comes from M1" overstated. M1 gives *importability*;
exercising a sender needs `vi.mock('../ws-clients.js')` and fake timers, and A's §7 should say
so in one sentence. `VideoService` and `DrainableSocket` are genuine injecting precedents. B's
`createElodinLink({client, now, boardAlive})` is the cheapest shape for a D-SUB watchdog test —
and D-SUB is a PROPOSAL (D17(e)); when the team approves it, *that* package may introduce the
factory with the watchdog as its second user. Not WP6.

## 3. Against C — the rule contradicts itself in the first module it names

**`actuator-mismatch` cannot be core and own its timer.** C's table has it owning "sensed map,
5 s timer" as a core module that never imports `notifications`. But the timer's callback is the
send: `scheduleActuatorMismatchCheck` (`:480-486`) arms a `setTimeout` whose body is
`checkActuatorMismatch(state)`, which raises or clears at `:511, 514`. If the module may not
send, the callback must be handed a sink (that is B's injection) or the timer must move to a
shell (then the owner of the sensed map does not own when it is judged). C's walkthrough says
"the shell hands it to `notifications`" without saying which shell holds the `setTimeout`.
Same shape in `engine-state`: the `SCRIPTS` poll (`:1249-1258`) is kept as "its shell line", so
the rule has an exception in two of its six modules before step 2 starts.

**Every shell grows a dispatcher.** Today's core-to-wire calls that C must turn into "return,
then dispatch": `updateBoard` `:559`, `noteT7Alive` `:593`, the sweep's nine notifications and
`:721`, mismatch `:511/514`, `broadcastCommandedActuatorsForState` `:464`, `broadcastStateUpdate`
(`:1347`, `:1712`), self-test `:1683`, T+0 `:1770`, the two `loadBoardsFromConfig();
broadcastBoardStatus();` callers (`:869-870, 1870-1871`), the burst. A dozen new dispatch sites
across `server.ts`, `ingest`, `commands`, `ws-connection`, each reading `ongoing` or a frame
`type` to pick `raise`/`clear`/`broadcast` — new code exactly where G9 is unguarded (goldens
sort keys, `characterize.py:92`). C concedes the risk and defers to G1–G3; see §4.

**The reducers are not pure.** `staleSweep(now)` mutates `boardsStatus`, `prevConnectedState`
and `boardFirstSeenSetupMs` (`:667, 693, 700, 719`); `updateBoard` writes `boardsStatus`. D20's
white-box allowance is "pure functions with stable signatures" — `linkStatus`
(`client-outbox.ts:334`) qualifies; a reducer over module state does not. C's vitests are
white-box tests of mutable singletons, the same class as A's with `vi.mock`.

## 4. Conceded to C — decisions should be pure; G3 is reachable black-box; G1/G2 are not

C is right that the research (`node-realtime-backend.md:195-197`) asks A's step 2 to make
`note*` take values, and that the pure core is this tree's best idea. Where a block already *is* a
decision with one output, A adopts the extraction (§5): the mismatch comparison (`:495-504` →
`mismatchedActuators(expected, sensed): string[]`), the resubscribe wait (`:1512-1516` →
`nextResubscribeDelay(res, now)`), the per-board health verdict inside the sweep. The owner
still sends. "Core decides" yes; "shell sends" no — see §3.

On the gap table, honestly: **G1 and G2 are unreachable black-box today for all three designs.**
`board_simulator.py` only ever passes (`_send_self_test`, "pass all active connectors",
`:332-344`); G2 needs a simulator option, G1 needs C0's candidate (a) or (b). **G3 is not**: the
pipeline starts the simulator from `$FX/sim_config.toml` and the backend from a separate `$CFG`
(`pipeline/run.sh:195, 222-223`), so a board present in the sim config and absent from the
backend's config heartbeats as a stranger — `unrecognized_<id>` is one fixture edit, no
simulator feature. And neither C's nor B's vitests discharge §7: they can exist only *after*
step 1 moves the function, while G1 is required *before* 1.11/1.12. If C0 cannot land G1, those
rows are blocked for A, B and C alike — the orchestrator's call, not a design's.

## 5. Revised step 2

Unchanged: 2.1 ingest router, 2.2 owner-only mutation (`raiseNotification`/`clearNotification`),
2.3 slot (after G6), 2.4 one T7 lookup, 2.5 renames, 2.6 imports with round-1 A10 (prune bare
imports whose closure is effect-free; keep `state-actuators`, `state-transitions`), 2.8
owners' `send…(ws)`, 2.9 `resolveTransitionTarget`. Added:

- **2.10 pure decisions** (from C): `mismatchedActuators`, `nextResubscribeDelay`, and the
  sweep's per-board verdict as a function returning today's payload literals in today's order;
  bodies moved verbatim, each with a vitest, the owner keeps the send. No carrier type, no
  dispatcher, no `now` parameter where `Date.now()` is in the body today.
- **2.11 the test recipe, written down** (from B): §7 states that a vitest of a layer ≥ 2
  module uses `vi.mock('../ws-clients.js')` for `send`/`broadcast`, `vi.useFakeTimers` for the
  clock, and a `CONFIG_PATH` fixture for anything importing `engine-state` or `session-manager`.
  No deps types; `:905` stays as is.
- **Not added:** B's factories (S34, as argued) and C's shell dispatchers.

## 6. Remaining disagreements

- B: whether a deps interface whose second user is a vitest satisfies STYLE-S34 (A: no — `CalibrationHost`'s second user makes a golden).
- B: whether nine `Date.now()` → `now()` edits are "residue" or a body rewrite (A: a rewrite; fake timers cost zero edits).
- C: whether sending belongs to the state's owner or to the shell that called it (A: the owner — otherwise `actuator-mismatch`'s timer has no sender).
- C: whether reducer vitests discharge G1–G3 (A: no — white-box, post-move; the gap table stays black-box and G3 is a fixture edit).
- Both: whether WP6 step 2 should build seams for parked proposals such as D-SUB (A: no, D17(d); the approving package builds them).
