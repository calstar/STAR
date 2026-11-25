# WP6 debate — verdict

Judge, 2026-11-16. Lines: `server.ts` @ `backend-remastered` 4241556b (= `b2599617`). Step 1 (A's
16 modules, the DAG, `server.ts` as composition root, §6.1-6.3) is conceded by all and adopted.

## 1. Fact rulings

| # | claim | ruling |
|---|---|---|
| F1 | `broadcast` dereferences an unassigned `wss` (B, C) | **True after row 1.3.** Today `const wss` (:901); as `export let` set by `attachWebSocketServer`, `:905` throws in any vitest that sends. A's "testability comes from M1" overstated; conceded. (:901-911) |
| F2 | `Date.now()` inside the four concerns | **9**: :492, 525, 582, 648, 662, 935, 1516, 1549, 1567. Four are `const now =` (A said five; :648 is `const at`); C's seven omitted :935, :1516. 1.13's `noteIngest()` adds :1775. B's `now` dep is dead or ≥ 9 body edits. |
| F3 | `activeNotificationKeys.has` reads | **8**, exactly C's list (:513, 679, 695, 701, 710, 714, 1736, 1747). B's round-1 deps omitted them. |
| F4 | the mismatch timer's callback sends | **True.** `setTimeout` → `checkActuatorMismatch` → `broadcastNotification` :511/:514, set writes :512/:515; :489/:508 read `engine-state`. C's round-2 guard ("six core files import no sender") is broken by its own first module. B's fixture point stands. (:480-517) |
| F5 | `staleSweep` is a pure reducer (C) | **False.** Writes `status.connected` :667, `boardFirstSeenSetupMs` :693/:700, `prevConnectedState` :719, the key set. C's `ongoing` pairing is 9 of 9 (:511/514, 677/680, 696/702, 711/715, 1688; keyless :686). D20's white-box clause is about goldens. (:661-722) |
| F6 | G3 is "one fixture edit": sim config ≠ backend config (A) | **Mechanism wrong.** `run.sh` gives `$CFG` to daq_bridge (:182) and the backend (:195); only the sim reads `sim_config.toml` (:223). daq_bridge registers `[0x10,id]` for its config's enabled boards only (`daq_bridge_main.cpp:568-571, 590`); the backend subscribes `[0x10,id]` only for its config's boards (`elodin-vtable-registry.ts:242-262, 335-340`), 1..255 only when none qualify. A sim-only board is unheard. |
| F7 | G1 / G2 reachability | **Neither G1 candidate as written.** No sensed `ACTn.CHm.actuator_state` row exists in any pipeline golden (only `ACT_CMD.*_commanded`), so :497 skips every entity; the sim's ACTUATOR current is a free sine (`board_simulator.py:617-623`; commands reach only `valve_target`, :430-441). **But the ball valve delivers:** `BV1_Cal.CH1.position_pct` (`boards/ws_streams.txt:100-105`) → `BV1.CH1` (:1727-1738); `test_integration.sh:516, 674` adds `"Main Ball Valve" = ["NC", 1, 71]` and a CLOSE-everywhere CSV row; `resolveActuatorTelemetryEntity` → `BV1.CH1` (`state-actuators.ts:140-144`); `doSetDebugMode(true)` publishes without clearing (`SequencerService.cpp:947-954`). G2: the sim self-test is pass-only (`board_simulator.py:344, 460-461`). |
| F8 | the registry's clock seam (C) | `nowFn`/`setClockForTests` exist (`elodin-vtable-registry.ts:96-99`). `elodin-reconnect.test.ts:62` fakes timers **without** `Date`; `board-scan-rate.test.ts:17,23` fake timers; `video.test.ts:394` spies `Date.now`. No deps-object clock anywhere. |
| F9 | A10: 15 bare imports, one effectful module | **Holds.** Bundle order computed (46 modules): lines 27-34, 39, 41, 47-49, 53, 298 each pin a module nothing earlier reaches; `gui-stream` (:43-46) is pinned by `client-outbox.ts:37`. `state-actuators.ts:79-81` is the one import-time effect. Row 1.6's `countdown-state` import must be bare. |
| F10 | B: a `createElodinLink` vitest is fixture-free | **False.** `onElodinConnected` calls `refreshScriptStatus()` (:1601), `engine-state`'s, whose chain reads config at import. B is right that `session-manager.ts:401` is env-only. |
| F11 | B's five resubscribe-loop facts; `countdown-state` stateless; `broadcast` synchronous | All verified (:1504, 1507, 1512-1513, 1518-1520, 1629-1630; :904-911). |

## 2. Decision

**Step 2, final:**

- **2.1** ingest router; **2.2** owner-only mutation (`raiseNotification(p)`/`clearNotification(p)`,
  `setCalibrationElodin`, `ReadonlySet`); **2.3** slot (after G6); **2.4** one T7 lookup; **2.5**
  renames; **2.8** owners' `send…(ws)` returning counts (after G9/G13); **2.9**
  `resolveTransitionTarget` — unchanged.
- **2.6 imports = A10.** A bare import may go only when every module in its closure passes the M1
  top-level reading, the §6.3-6 order diff shows those modules only moving later, and the item-5
  log diff is identical. `state-actuators` and `state-transitions` stay, commented (S37). The
  step-1 agent captures the baseline on the parent commit in commit 1.1 (D44(2)).
- **2.10 pure decisions** (from C; signatures from B). Verbatim-bodied functions over values that
  return today's literals or null, each with a vitest and a listed mutation:
  `mismatchVerdict(expected, sensed, stateName, mismatchActive, now): NotificationPayload | null`
  (:489-516 minus the sends; the timer callback fetches `getExpectedPositions`, `configStateName`,
  `activeNotificationKeys.has`, then sends — hoisting `configStateName` is a listed non-verbatim
  edit); `boardHealthEvents(status, prev, firstSeenSetup, activeKeys, now): NotificationPayload[]`
  (:671-717 per board; the sweep keeps its loop, writes and `broadcastBoardStatus`);
  `selfTestFailure(boardId, rows, notified, label, now)`;
  `nextResubscribeDelay(res, now)` (:1512-1516). **Owners send.** No carrier type beyond
  `NotificationPayload`; each caller keeps its `const now = Date.now()` where it is.
- **2.11 test recipe** (from B), written into §7. A vitest of a layer ≥ 2 module:
  `vi.mock('../ws-clients.js')`; `vi.useFakeTimers()` + `vi.setSystemTime`; `vi.resetModules()` +
  dynamic import per case; a `CONFIG_PATH` fixture for any closure containing `engine-state`,
  `commands`, `elodin-link` or `session-manager`. Pure decisions need none of it. **Backend vitests
  do not discharge §7 rows** (C0 characterization); a substitution is a recorded decision per row.
- **Not adopted:** C's shell/core guard (F4; a dozen new dispatch sites where G9 is unguarded) and
  B's factories (S34 as the tree applies it: `CalibrationHost`'s second user produces
  `calibration/golden/ts.txt`; a vitest is not a second user).

**Send or return?** Owners send; decisions return.
**elodin-link seam:** none in WP6. `scheduleResubscribe` and the four listeners verbatim (A6 room),
`nextResubscribeDelay` pure. A later D-SUB/D-ECHO package passes `client` as a **parameter at the
decision** (`registerVTables(client)`, `duePairs(desired, state, now)`), not a factory.
**Clock seam:** `now` is a parameter of pure decisions only. No `now` dep, no `setClockForTests`
in `server/*`; module functions keep `Date.now()` at today's sites; tests fake timers.

## 3. G1 / G2 / G3

- **G3** — dischargeable black-box by C0 with a two-config fixture: daq_bridge and the sim on `$CFG`,
  the backend on a copy in which one board is subscribed but not `expected` — spell it `id =`
  (the registry takes `b.board_id ?? b.id`, :247; `loadBoardsFromConfig` needs a numeric `board_id`,
  :398). An empty `[boards]` also works but trips the 1..255 fallback the registry's comment
  (:329-334) names as the request-id overflow; avoid it. C0 confirms; before 2.1/2.2.
- **G2** — needs an opt-in `--fail-connector <board>:<ch>` in `sim/board_simulator.py` (also
  launched by `service-controller.ts:21`; default unchanged, orchestrator to approve).
- **G1** — stays MUST before 1.11/1.12, candidate (a) rewritten on the ball valve, the ACT-board
  form and (b) struck: a fixture with the `Main Ball Valve` role and CSV row (as
  `test_integration.sh` has them; a new pipeline mode or `ws_data_flow_test` case, not the frozen
  `boards` session); unlock → `debug_mode` on → `actuator "Main Ball Valve" 1` → wait > 3 s
  (`BALL_VALVE_TRAVEL_S`) → `debug_mode` on **again** → ≥ 5 s → `actuator_mismatch ongoing=true`
  → close → `ongoing=false` → debug off. If C0 cannot land it before 1.10 merges, the orchestrator
  records a substitution: `--color-moved` review of :472-517 and the 1.11 split, plus 2.10's
  `mismatchVerdict` vitest before 2.1.
- **C0 builds:** the G3 fixture, the G2 option and case, the G1 ball-valve case; G7/G8, G10,
  G11/G12.

## 4. Best arguments

- **A** (prevails): a rule barring a module from sending cannot hold where the output is the
  module's own timer callback (F4); A10 measured what the note hand-waved (F9).
- **B** (loses factories, wins the recipe): importable is not callable (F1); the resubscribe chain is
  behaviour no test reaches (F11) — true; deferred to D-SUB by D17(d).
- **C** (loses shell/core, wins decisions): the raise/clear verdict already lives in the payload
  (F5, 9 of 9); decisions over values with `now` by parameter match `duePairs` and `nowFn` (F8).

## 5. DESIGN-WP6.md edits (not made here)

1. §3.1 last bullet → "M1 gives importability; `wss` is an `export let` (`:905`), so a vitest
   reaching a sender mocks `ws-clients` (§7 recipe)."
2. §6.4: add 2.10 and 2.11 as in §2; rewrite item 6 as A10 (three conditions, kept bare imports,
   baseline owner).
3. §6.1 R1a: list the 15 lines; row 1.6 "keeps its own `countdown-state` import" → "as a bare import".
4. §7 G1: strike the ACT-board script and (b); write the ball-valve script; note that no sensed
   `actuator_state` row reaches the backend in the simulated stack. G3: replace "no board outside
   config ever heartbeats" with F6's mechanism and the `id =` fixture. G2: name the option and its
   shared file. Add 2.11's non-discharge sentence.
5. §8 R1: `wss` as `export let` → senders throw in tests without `attachWebSocketServer`.
6. Interfaces: add 2.10's four functions to the `actuator-mismatch`, `board-status`, `elodin-link`
   stubs; `elodin-link` header: no factory in WP6, D-SUB passes `client` at the decision.
7. Walkthroughs (a) 11, (c) 1/4/6: name the pure function called before the send.
8. Alternatives: record what B and C abandoned and what was adopted.
9. §6.5: 2.10 moves no `Date.now()` site and no payload literal (G9).

## 6. Remaining team questions

1. Sensed `ACTn.CHm.actuator_state` rows are absent in the simulated stack — on the stand too? If
   so, `actuator_mismatch` has never fired for an ACT board (record, don't fix).
2. May C0 add opt-in flags to `sim/board_simulator.py`, which simulated systemd runs also launch?
3. Does a vitest count as S34's second user? Recommend no, unless it produces a gate artifact.
4. D-SUB/D-ECHO: approve the `client`-parameter seam then; reserve Idea 2's `control` event in
   `elodin-link`'s header now?
5. Confirm the step-1 agent owns the order-diff baseline (D44(2)).
