# WP6 round 1 — B: service objects with explicit dependencies

Line numbers: `server.ts` @ `backend-remastered` db1bba07 (same text as the note's b2599617).

**Position.** DESIGN-WP6 rejected B as *classes* — `this.` in every body, ~1500 lines rewritten.
That variant is dead; I do not defend it. The live form is **factory closures**: a concern's state
and functions moved inside `createX(deps)`, collaborators destructured once at the top, bodies
byte-identical. It is a **step-2 target, not a step-1 shape**: step 1 is A's move-only pass
verbatim (§6.1 rows 1.1–1.16, the eight setters of §6.2, R1a bare imports). B changes what the
cleanup aims at, for the four concerns whose gap test is their second user.

## 1. Design

The 16 `server/*` files of §2, same DAG, same ownership table (§1.2), same `server.ts`. Step 2
adds one commit, **2.10 objectify**, for four concerns; the other twelve stay A's singletons.

| factory (in A's file) | closure state | deps — functions or objects only, never a scalar (R6 as a type) |
|---|---|---|
| `createNotifications(d)` | `activeNotificationKeys`, `notificationBuffer` | `broadcast`, `now` |
| `createBoardStatus(d)` | `boardsStatus`, the sweep's edge maps, `hbDiagCount`, self-test snapshot | `broadcast`, `raise`, `clear`, `broadcastNotification`, `stats`, `t7BoardIdForSlot`, `now` |
| `createActuatorMismatch(d)` | `actuatorSensedState`, its timer | `getExpectedPositions`, `configStateName`, `currentState: () => SystemState`, `raise`, `clear`, `now` |
| `createElodinLink(d)` | `elodin`, `resubscribeTimer`, `lastIngestMs` | `client`, `registerVTables`, `clearSubscriptionState`, `noteSubscriptionRejected`, `pipelineExpected`, `now` |

**Wiring.** Not in `server.ts` — the production instance is the owner's last statement:
`export const { boardsStatus, loadBoardsFromConfig, updateBoard, … } = createBoardStatus({
broadcast, raise, clear, broadcastNotification, stats, t7BoardIdForSlot, now: Date.now });`. A pure
constructor call under S30, like A's `new ElodinClient(…)`. Every consumer imports the same names
over the same edges as A; `server.ts` is A's line for line, so §1.3's rows, the startup-order
script and the module-order diff are untouched. I concede the brief's "wired once in `server.ts`":
threading objects through `handleElodinPacket`/`handleConnection` would be the context object, and
a `WsHub` would turn 38 `send`/`broadcast` call sites into `hub.send` — the "+250" the note counted.
`ws-clients` stays A's singleton.

**Bodies.** Destructuring with a rename keeps today's names: `const { client: elodin, now } = d;`
leaves 1507, 1547, 1589–1590 verbatim. §6.3's review already passes
`--color-moved-ws=allow-indentation-change`, so the factory's indent is an expected non-dimmed
line [A8]. **Residue**, listed as §6.2 lists the setters: `scheduleActuatorMismatchCheck(currentState)`
at 1737 and 1748 (inside `noteSensedRow` after 2.1) → `currentState()`. Two sites; a thunk is not a
`SystemState`, so tsc catches a miss. The hot path (`publishSample`, the parse site at 1661, the
drain) stays in singletons: R7 is not exposed.

## 2. The four flows

Identical to walkthroughs (a)–(d) at every step; only where a collaborator comes from differs.
(a) fire: steps 1–9 unchanged; step 10 `applySequencerState`, then `ingest` calls
`scheduleActuatorMismatchCheck(currentState)` as today (1714 passes an argument — not a residue);
step 11 the mismatch closure compares `getExpectedPositions(state)` from its deps and raises
through the `raise`/`clear` it was handed. (b) abort: same path and gate. (c) reconnect:
`markStaleBoards` → `raise(board_lost_…)` → `broadcastBoardStatus()`; `onElodinConnected` uses the
destructured client. (d) calibration save: untouched — `calibrationHost` already *is* a
dependency object with two users (§3.1).

## 3. Why B over A and C

**Testability, on §7's own gap table.** The note calls G1's first script *infeasible* (both
candidates need C0 confirmation or a simulator option), G2 and G3 need simulator options, G5 is
a 30–60 s wall-clock case. Under A a unit test cannot reach them cleanly: `broadcast`
dereferences `wss.clients` (905) and `wss` is an unassigned `export let` until
`attachWebSocketServer`, so `markStaleBoards` needs a `vi.mock` of `ws-clients` or a real
`WebSocketServer`, fake timers, and `vi.resetModules()` per case. Under B: `createBoardStatus({
broadcast: spy, raise, clear, …, now: () => t })`, `updateBoard(99, hb16)` (541–547 creates the
unknown board), `markStaleBoards()` → `unrecognized_99` (G3); a self-test row with value 0 → one
`self_test_fail_21` then `break` (G2); `getExpectedPositions: () => ({ 'ACT1.CH3': 0 })`, sensed
1, `now` advanced 5 s → the exact mismatch text (G1). Honest limits: G2/G3 need no fixture —
`updateBoard` reads no config — but the G1 and D-SUB tests import `actuator-mismatch` /
`elodin-link`, whose bottom wiring imports `engine-state` (→ `state-csv/state-actuators.ts:79-81`,
config at import) and `session-manager` (constructs at import), so they set `CONFIG_PATH` to a
fixture as `config-profile-create-calibration.test.ts:15-19` does, or `vi.mock` that one module.
B's gain there is the injected clock, client and collaborators, not freedom from the fixture.
G5 stays with A's `ws-clients`. These vitests sit beside the goldens; the gate stays black-box.

**Precedent, counted.** §3.1 says "every earlier extraction already works this way". The tree is
split: six singletons (`board-scan-rate.ts:16-19`, `lc-tare.ts:52-55`, `ball-valve-cal.ts:55`,
`dhcp-status.ts:98-101`, `elodin-vtable-registry.ts:58-94`, `board-logs.ts:28-32`) against seven
constructed objects (`elodin-client.ts:37`, `history-cache.ts:40`, `client-outbox.ts:98,365`,
`gui-stream.ts:124`, `session-manager.ts:82`, `video/service.ts:110`). The newest extractions
inject: `VideoService(fixedEndpoint?, fixedApi?)` (`:127-130`) → `video.test.ts`, 18 fakes, no
`vi.mock`; `registerVTables(client, cfg)`
(`elodin-vtable-registry.ts:363`) → `fakeClient` (`vtable-subscriptions.test.ts:33-48`);
`sendBackfill(…, deps)` with `DrainableSocket` (`history-backfill.ts:112-149`);
`sessionManager.init(5 callbacks)` (`:111-122`, `server.ts:1869`); `CalibrationHost`
(`calibration-handler.ts:23`) faked in `test/characterization/calibration/ts_harness.mts:149-160`
to produce `golden/ts.txt`. The singletons paid the other way: `lc-tare.ts` exports
`resetTareState`/`setRunDir` as test hooks (imported at `server.ts:29`, never used there);
`board-scan-rate.test.ts:12-13` needs `vi.resetModules()` plus a dynamic import per case;
`ball-valve-cal.test.ts:13` and `lc-tare.test.ts:3` `vi.mock` a path module.

**Clarity.** A deps type is §2's edge list made checkable: `board-status → ws-clients` names a
module; `BoardStatusDeps` names `broadcast`, `raise`, `clear`, `stats`, `now`. §1.2 stays the
map. **Lines:** A plus ~35 (four deps types and wrappers, minus the `init*` wrappers they
replace); not a deletion win. **Characterization fit:** same entry point, goldens and
`lc-tare.test.ts` re-points (1.3, 1.14 are step 1 = A).

**D-SUB room (research §4, subscription-robustness Idea 4).** The watchdog needs three inputs:
accepted, no delivery within T, board heartbeating. Under [A6] that is `Date.now()` plus a
downward import of `boardsStatus` — testable only by a lifecycle run of length T. Under B
`createElodinLink({ client, …, now, boardAlive })` is a fake-timer vitest in the shape of
`elodin-reconnect.test.ts`, with the client faked as `vtable-subscriptions.test.ts` already does.
Still a PROPOSAL (D17(e)); B only makes it cheap. Research §1 (elision) and §2 (timer FIFO) are
untouched: same imports, same three `setInterval`s in `server.ts`.

## 4. Objections

1. *"Move-only fails: every body changes."* True of classes; false of closures. Bodies name their
   own state as today and collaborators by the destructured name. The residue is two sites,
   listed and tsc-checked like §6.2's setters, in step 2 where A already rewrites that region (2.1).
2. *"D17(d): fifteen single-instance classes; unit tests would be new code with a single user."*
   Four factories, each with two users the day it lands: the owner's wiring and the gap test in
   the same commit — the test §3.1 applies to `CalibrationHost` ("the backend and the calibration
   characterization harness"). And §7 ranks G1–G3 MUST/should while admitting they are
   unreachable black-box without simulator features that do not exist: code the gap table
   requires is not optional, and A's route to it (simulator options, `vi.mock`s) is also new
   code with one user. A `ServerContext` or DI container is rejected here too.
3. *"Construction order is a second startup sequence."* Moot under bottom-of-owner wiring:
   `server.ts` is A's, construction is a pure top-level statement like `new HistoryCache(…)`, and
   the DAG already fixes its order. D-c holds more strongly: a closure `let` cannot be written
   from another module at all, and a missing dep field is a build error.

## 5. Concessions

Step 1 is A's, entirely. `server.ts` is A's. Lines go up. "Wired in `server.ts`" is infeasible
without the context object; it is wired once at the owner's bottom. STYLE-S34's letter counts a
deps interface as an abstraction; I argue only its two-user clause. `engine-state`, `commands`,
`ws-clients` and the hot-path modules stay singletons; G1 and D-SUB tests still need a config
fixture or one `vi.mock`. The two residue edits are real.
