# WP6 round 2 — B (service objects): rebuttal

Lines: `server.ts` @ `backend-remastered` (= `b2599617`).

## 0. Where round 1 left B

Both opponents argued against the B the note rejected — classes, `this.` in every body, "≈ 1500
lines rewritten" (A §3, C §0). Round-1 B disowned that shape in its first paragraph: step 1 is A's
verbatim, factories are closures with collaborators destructured once, bodies byte-identical, the
instance wired at the owner's bottom, `server.ts` untouched, two residue edits (1737, 1748), ≈ +35
lines. Neither file engages that. What follows does engage theirs.

## 1. Against A

**A10 — conceded in full, with credit.** A measured what the note hand-waved: 23 of 32 `server.ts`
imports are elided today and 15 lines pin the first evaluation of 25 modules, so step 1 yields
fifteen bare imports, not one. It separates nothing (step 1 is shared by all three), but it
changes the honest description of the move-only pass: 8 setters + 15 bare imports + the
`_SEQUENCER_STATE` split + a re-pointed test, every one enumerated and machine-checked. I
endorse A10's amended item 6 (a bare import may go only when its closure passes the M1 reading,
the order diff shows modules moving later only, and the log diff is identical). B's bottom-wiring
adds no import edge, so A10 applies to B unchanged.

**A's weakest point is its own gate.** A ranks G1 MUST before commits 1.11/1.12 (§7 table) while
the same note says G1's first script is *infeasible* and both candidates "await C0" — turning
`debug_mode` off clears overrides before publishing (`SequencerService.cpp:949-952`), so nothing
is left to mismatch. A's step 1 is therefore blocked on a black-box test nobody can yet write,
and A's §3 rejects the only alternatives ("constructor fakes add nothing the black-box goldens
lack"). B and C each offer a white-box G1; A must either adopt one or drop the MUST.

**A's testability claim.** O1 says isolation is "M1 + `vi.resetModules()`". That is the cost, not
the answer: `broadcast` dereferences `wss.clients` (905) and `wss` is unassigned until
`attachWebSocketServer`, so an A-shaped test of `markStaleBoards` mocks `ws-clients`, fakes
timers, and resets modules per case — `board-scan-rate.test.ts:12-13` is what that looks like.
O1's precedent list is also wrong in one entry: `countdown-state.ts` holds no module state at
all (no top-level `let`/`Map`); the stateful extractions split six singletons against seven
constructed objects (round 1 §3).

**Stale numbers.** "B adds ≈ 250" and "`boardsStatus` → `this.boards`" describe the class
variant. Against round-1 B the count is two body edits and `server.ts` = A's.

## 2. Against C — and the concession that reshapes B

**Conceded: pure reducers make G1–G3's decisions testable without objects.** `staleSweep(now) →
frames[]` over a seeded `boardsStatus`, `checkActuatorMismatch(…, now) → payload | null`,
`noteSelfTestResults(id, rows, now)`: each pins its notification family in one vitest, no
collaborator needed, and `now` as a *parameter* is cleaner than B's `now` dep. C's shell rule
(`ongoing: true` → `raise`, `false` → `clear`, keyless → `broadcastNotification`; 9 of 9 sites
agree, `:511-515,677-716,1683-1690`) is a carrier, not an abstraction. B drops
`createBoardStatus`, `createActuatorMismatch` and `createNotifications`. Where the thing to test
is a decision, C is right and B was over-built.

**But C's G1 test is not fixture-free as written.** `checkActuatorMismatch` reads
`getExpectedPositions(state)` (489) and `configStateName(state)` (508) from `engine-state`, whose
import chain (`state-csv/state-actuators.ts:79-81`) reads config at import — the limit I conceded
for B in round 1 applies to C's example too. The fix is C's own method applied one step further:
`checkActuatorMismatch(expected, sensed, stateName, activeKeys, now)`, with `engine-state`'s
lookups done by the timer line in the shell. Then G1 needs neither fixture nor mock.

**C under-counts its edits.** "Only `broadcastNotification(` becomes `out.push(`" — but inside C's
core ranges (424-722, 1236-1265, 1673-1720, 1764-1771) there are **17** send sites:
`broadcastNotification` ×10, `broadcastBoardStatus()` ×3 (559, 593, 721), `broadcastStateUpdate()`
(1712), `broadcast({…})` at 464, 1261, 1770, plus `updateBoard`/`noteT7Alive` gaining a `now`
parameter and `markStaleBoards` becoming `staleSweep`. Still a bounded, listable cleanup — but
list it as §6.2 lists the setters, and note that sweep order is wire-identical only because
`broadcast` is a synchronous `ws.send` with no await (905-911); say so in the commit.

**C's weakest point: the rule leaves the shells untested, and the lead defects live in a shell.**
C makes `elodin-link` a shell with one pure extraction, `nextResubscribeDelay` (1512-1516) —
four lines. What D-SUB, D-ECHO and the C6-2 class actually turn on is the loop around them:
the timer dedupe (1504), the `isConnected` guard (1507), `remaining > 0 → 0` (1512), `.catch →
5 s` (1518-1520), and disconnect cancelling the timer then `clearSubscriptionState()` (1629-1630),
the premise of research Idea 3. No test reaches any of it today, and under C none can without
`vi.mock('../elodin-client.js')` or spying the module-level instance. That is the one place a
dependency object earns its keep: the shell *is* the behaviour.

## 3. B's revised step 2

- 2.1–2.9 as A (ownership moves, setters, 2.8 `send…(ws)`, 2.9 `resolveTransitionTarget`).
- **Core/shell per C** for `board-status`, `engine-state`, `actuator-mismatch`, `mission-time`:
  reducers return today's literals verbatim; `now`, and for the mismatch check `expected` and
  `stateName`, by parameter; shells (`ingest`, `ws-connection`, the `server.ts` timer lines)
  send. Lands after G1–G3's vitests exist, as C has it; the 17 sites listed in the commit.
- **One factory, `createElodinLink(d)`**, in `server/elodin-link.ts`, with deps `client`,
  `registerVTables`, `clearSubscriptionState`, `noteSubscriptionRejected`, `pipelineExpected`.
  `const { client: elodin } = d;` keeps 1507, 1508, 1547, 1589-1590 verbatim; **zero** residue
  edits. Production wiring is the owner's last statement, `export const { elodin, noteIngest,
  isSimulated, connectionStatusPayload, broadcastConnectionStatus, syncElodinToSession,
  onElodinConnected, onElodinDbError, onElodinDisconnected, onElodinError } =
  createElodinLink({ client: new ElodinClient(ELODIN_HOST, ELODIN_PORT), …, pipelineExpected:
  () => sessionManager.pipelineExpected() })` — a pure constructor call under S30; `server.ts`,
  the import edges, A10's bare imports and the order diff are untouched. Its second user lands
  in the same commit: a vitest with a fake client (the `isConnected` + `sendRawMessage` shape of
  `vtable-subscriptions.test.ts:36-48`) and fake timers (`elodin-reconnect.test.ts`) pinning
  the five loop facts above and the disconnect path. Fixture-free: `session-manager`'s import is
  env-only (`session-manager.ts:67`, default `'off'`; `service-controller.ts:163` stores the
  mode), correcting round 1's caution.
- No other object. `ws-clients` stays a singleton (38 `send`/`broadcast` call sites).

Net against A: C's reducers (+20–40 lines, C's figure) plus ≈ 15 lines for one deps type and
wrapper. Move-only: unchanged (step 1 shared).

## 4. Remaining disagreements

- **A vs B/C:** whether G1's MUST-before-1.11 stands when the only feasible G1 is white-box.
- **A vs B:** whether a deps type whose two users are the owner's wiring and a vitest passes
  STYLE-S34, as `CalibrationHost`'s harness user does in §3.1.
- **C vs B:** whether `elodin-link` is a shell with a four-line pure core (C) or the one
  factory (B); i.e. whether an untestable shell holding the lead defects is acceptable.
- **C vs B (minor):** C's `checkActuatorMismatch` signature — reads from `engine-state` (C) or
  `expected`/`stateName` by parameter (B), which is what makes the G1 vitest fixture-free.
- **A vs C/B:** whether `now` by parameter in reducers is a cleanup within §6.4 or a new
  signature rule needing a note amendment.
- **All three:** the fifteen bare imports and A10's cleanup rule are shared ground; nobody has
  yet named who runs the order diff on the parent commit (D44(2)).
