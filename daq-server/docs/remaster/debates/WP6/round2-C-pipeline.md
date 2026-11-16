# WP6 debate — round 2, advocate C: rebuttal

All three rounds-1 agree: step 1 is A's move-only pass, the 16 files are A's, `server.ts` is A's.
Round 2 is a fight over step 2 only. Lines are `server.ts` on `backend-remastered`.

## 1. A's weakest point: "testability comes from M1"

A §3 and O1: "M1 makes every module importable without effects … isolation is M1 +
`vi.resetModules()`." Importable, yes; *callable*, no. `broadcast` dereferences `wss.clients`
at `:905`, and after row 1.3 `wss` is an `export let` assigned only by `attachWebSocketServer`.
A vitest that imports `board-status` and calls `markStaleBoards()` (`:661-722`) or
`checkActuatorMismatch()` (`:488-517`) reaches `:677`/`:511` → `broadcastNotification` →
`broadcast` → `TypeError` on `undefined.clients`, unless `ws-clients` is `vi.mock`ed. So A's
route to G1–G3 is a mock of the layer-1 module in every test, or the simulator options §7 admits
do not exist. B lands this blow too; C's version is cheaper than either: a reducer that
**returns** its payloads is asserted on its return value, no mock, no fake timer.

A already half-concedes it. A §5: "step-2 `publishSample`/`noteSensedRow` take values, not
sockets." That is C's rule applied to two functions. A owes a reason why `noteSelfTestResults`
(`:1673-1694`, which broadcasts at `:1683`), the sweep and the mismatch check are exempt.

A O2 and §3's "≈ 40 mutators on `state.ts`" rebut DESIGN-WP6's C, which round 1 abandoned; they
do not touch this one. A10 (prune a bare import only under the three conditions) is right and
C adopts it.

## 2. B's weakest point: the deps tables do not carry the bodies

B's claim is "bodies byte-identical, collaborators destructured once." Two gaps, with lines.

**No `has`.** `createBoardStatus` takes `broadcast, raise, clear, broadcastNotification, stats,
t7BoardIdForSlot, now`; `createActuatorMismatch` takes `raise, clear`. The bodies read
`activeNotificationKeys.has` at `:513, 679, 695, 701, 710, 714` and, in the row loop after 2.1,
`:1736, 1747`. Either the set is still imported from `notifications` (then "a deps type is §2's
edge list made checkable" is false — the real edge is outside the type), or a ninth dep is
added (the table is incomplete), or the bodies change. B gets to pick one; none is the round-1
text.

**The clock is dead or the bodies change.** B's `now` dep meets bodies that call `Date.now()`
at `:492, 525, 582, 662` (sweep, heartbeat, T7, mismatch), `:648` (the buffer stamp),
`:1549, 1567` (badge). Either each becomes `now()` — residue ≥ 7 sites, not the two B lists —
or the injected clock is never read and B's G1 test ("`now` advanced 5 s → the exact mismatch
text") cannot advance the clock the body consults. "Byte-identical" and "injected clock" cannot
both hold. B's own precedent has no clock seam either: `elodin-reconnect.test.ts:62` fakes
`setTimeout`/`setInterval` with a `toFake` list that excludes `Date`, so the chain test the tree
already has leaves `Date` real.

**`createElodinLink({ client, now })` injects one layer above the decision.**
`registerVTables(client, cfg)` (`elodin-vtable-registry.ts:363`) already takes the client —
`vtable-subscriptions.test.ts:36-73` fakes it today — and the registry already has
`nowFn`/`setClockForTests` (`:97-99`). D-SUB is a *verdict* bug (accepted ≠ delivering,
`:136` retries only refusals); its clause belongs in WP5's pure `duePairs` (D42(d)), where the
clock is already injectable, not in a closure around `scheduleResubscribe`.

B's precedent count (six singletons, seven constructed objects) is fair and I accept it; it
shows the tree injects *at the decision* (`registerVTables(client)`, `sendBackfill(…, deps)`,
`linkStatus(o)`), which is C's seam, not a per-concern factory.

## 3. Concessions

**2.10 objectify, per concern.**
- `notifications`: B is right that it is the sink and the sole writer ([A9b]); a factory with
  deps `broadcast, now` adds a type and nothing else. No.
- `board-status`: B is right that the sweep needs a clock seam. C's is `staleSweep(now)` — a
  parameter, one call lower than B's dep, no deps type; the caller passes `Date.now()`.
- `actuator-mismatch`: B's `currentState()` thunk residue (`:1737, 1748`) exists only because B
  made the state a dep; C reads the live binding downward as A does and passes
  `(state, activeKeys, now)`.
- `elodin-link`: **conceded.** The resubscribe *chain* (`:1503-1522`) reads module `elodin` at
  `:1507` and re-arms itself; C makes only the verdict testable. If the team wants the chain
  unit-tested, a `client` parameter or B's dep is the only route, and B's bottom-of-owner wiring
  is sound: it leaves §1.3, the startup-order script and the module-order diff untouched.

**The injected clock.** Right in principle; C adopts it as a `now` parameter on every reducer.
C's own residue, counted as §6.2 counts setters: the four `const now = Date.now()` lines
(`:492, 525, 582, 662`) move to the caller; nine `broadcastNotification(` become `out.push(`;
`broadcastBoardStatus()` at `:559, 593, 721` becomes a returned frame. Nothing else in those
bodies changes.

**A's 2.3, 2.4, 2.9 and A10**: adopted unchanged. R7: the per-row loop stays A's 2.1 or verbatim.

## 4. Revised step 2

A's list with these substitutions, each commit under §6.3's checks, sequenced **after G1–G3
exist** and after A's 2.3/2.4:

1. **2.1′** `note*` functions return decisions: `noteSelfTestResults(boardId, rows, now) →
   NotificationPayload | null`; `noteSensedRow` returns whether a recheck is due (the two
   `:1736/1747` sites); `publishSample` as A.
2. **2.2′** `notifications.raiseNotification(p)` / `clearNotification(p)` ([A9a]), driven by
   the returned payload's `ongoing` — `true` → raise, `false` → clear, absent → one-shot; nine
   of nine sites follow it (`:511-515, 677-716, 1683-1690`).
3. **2.5′** `updateBoard(low, payload, now)`, `noteT7Alive(slot, now)` return the recomputed
   status frame (`:919-936`, `dhcp`/`frequencyHz`) or null; `staleSweep(now, activeKeys)`
   returns the ordered list (payloads in board order, that frame last, `:721`);
   `checkActuatorMismatch(state, activeKeys, now)` returns one payload or null. `activeKeys` is
   `notifications`' `ReadonlySet` ([A9b]) — the `has` reads at `:513, 679-714` stay verbatim,
   which is the hole §2 charges B with and C does not have. The timer arrows in `server.ts` and
   the 5 s callback send what comes back, in order.
4. **2.8′** owners return frames (`boardStatusFrame()` the as-is `:1052-1054` shape,
   `selfTestReplay()`, `notificationReplay(now)`, `connectStateUpdate()`,
   `commandedSnapshot(t)`); `ws-connection` sends and counts. [A9d] is dropped.
5. **Guard**, narrowed from module to specifier: the six core files import no *sender*
   (`send`, `broadcast`, `broadcastNotification`, `raiseNotification`, `clearNotification`) from
   `ws-clients`/`notifications`; reading `wss.clients.size` for the diagnostics line (`:611`) and
   the `ReadonlySet` is allowed. One named exception: `calibrationHost` captures `send`/`broadcast`
   at `:381-382` as the port `calibration-handler` already consumes — `server.ts` passes them to
   `initCalibrationState(send, broadcast)`, so the module itself imports no sender. The G1–G3
   vitests assert on return values, one mutation each (`!status.connected` → `status.connected`
   at `:676` must go red on `board_lost_`).

## 5. Remaining disagreements

- Owner sends vs owner returns (A vs C): A keeps `broadcast` calls inside concern modules.
- 2.8's shape (A vs C): `send…(ws)` with frame counts, or frames out and `ws-connection` sends.
- The seam for a fake (B vs C): a deps object per concern, or call parameters at the decision.
- Whether a vitest is a second user under D17(d) (B vs C): B needs it; C's extractions are
  D43(3) one-call-site moves and do not.
- Whether the resubscribe chain needs a unit test at all (B vs A/C).
- Whether M1 alone gives testability (A vs B and C): `:905` says no.
