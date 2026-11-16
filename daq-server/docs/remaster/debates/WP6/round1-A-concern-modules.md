# WP6 debate — round 1, advocate A: concern modules (DESIGN-WP6 §2)

**Position.** The reviewed design: 16 `server/*` modules named for the state each owns (§1.2
*is* the module map), singletons read through live bindings and written only by the owner's
setter, a layered DAG (M2), `server.ts` ≈ 300 lines holding every timer and listener in §1.3's
order. One amendment (A10, §4) after measuring a cost the note under-counted. Lines: `server.ts`
@ `b2599617`.

## 1. The design

Layers 0→7, each module importing only below it:

| module | owns |
|---|---|
| `env`, `stats` | env knobs read once (`:61,73-79,1858`); `/stats` counters (`:740-754`), `initStats()` [A9e] |
| `ws-clients` | `wss`, `clientStreams`, `send`/`broadcast` (`:904-917`), drain (`:233-274`), reaper (`:948-960`) |
| `notifications` | `activeNotificationKeys`, replay buffer (`:627,633-652`) |
| `history` | cache, prune, backfill (`:122-129,1170-1203`) |
| `mission-time` | T+0, countdown target + its file (`:297-299`) |
| `config-caches` | hot-path lookups rebuilt on deploy (`:327-373,854-857`) |
| `sensor-stream` | downsampling, two sample exits (`:133-175,211-227,285-293`) |
| `calibration-state` | PT coefficients, `lastRawAdc`, `CalibrationHost` (`:305-325,375-384`) |
| `board-status` | `boardsStatus`, heartbeats, T7, stale sweep, self-test (`:386-420,519-722,919-936`) |
| `engine-state` | `currentState`, `debugMode`, allowed set, CSV positions (`:143-161,424-470,756-775,1236-1265,1697-1720`) |
| `actuator-mismatch` | the 5 s check (`:472-517`) |
| `elodin-link` | client, resubscribe, badge, listeners (`:1471-1635,1837-1846`) |
| `ingest` | routes each row to its owner (`:1637-1816`) |
| `commands` | `handleMessage`/`handleCommand` (`:1207-1234,1267-1407`) |
| `ws-connection` | one socket: identity, burst, handlers (`:964-1146`) |
| `server.ts` | §1.3 rows 1-31 as statements, HTTP handler, API opts, `applyDeployedConfigChange`, guards, `listen` |

Every edge points down (§2, [A9c]). Injection only where a real cycle is broken today:
`createAPIHandler(opts)` (`:784-829`), `sessionManager.init` (`:1869`); `server/*` and `api/*`
never meet. State is assigned by its owner only: §6.2's 8 writes become setters and
`tsc --noEmit` (D40) makes a missed one TS2632 — condition D-c; after 2.2
`activeNotificationKeys` is a `ReadonlySet` [A9b].

## 2. Four flows

- **Fire.** `ws-connection`'s one try (`:1112-1117`) → `commands.handleMessage` (`:1207`) →
  gate (`:1270`) → `engine-state.resolveTransitionTarget` (2.9; today split `:1280-1306` vs
  `:152`) → `sendToSequencer` (`:1322`) → `ERROR` to the sender only (`:1325`). The state returns
  as `_SEQUENCER_STATE`: `ingest` keeps `notePairDelivered` first (`:1642`, [A7]) →
  `applySequencerState` (`:1697-1713`) → `scheduleActuatorMismatchCheck` (`:1714`).
- **Abort.** Same path with the abort id; the gate applies (`:1270`, frozen in
  `pipeline/golden/ws_events.txt`). A sequencer-initiated abort enters at `ingest` only: the
  backend has nothing abort-specific, and the layering shows it.
- **Board reconnect.** `board-status.markStaleBoards` (`:661-722`) flips `connected`, raises
  `board_lost_<id>` via `notifications`; a returning `[0x10]` → `ingest` → `updateBoard`
  (`:519-564`, `:559` broadcasts at once). The three 1 s timers stay three `setInterval`s in
  `server.ts` (`:724,939,1581`, [A5]) so health-notification → `board_status_update` →
  `connection_status` holds (G11). The burst order `pipeline/golden/ws_handshake.txt` freezes is
  `ws-connection`'s; the frames become each owner's `send…(ws)` (2.8).
- **Calibration save.** HTTP handler (`:876-900`) → WP7; `/load` → `onCalibrationReload`
  (`:823-827`) → `publishCalibrationReload(calibrationHost)`. The host is `calibration-state`'s;
  its `.elodin` is written at `:1589` by `elodin-link` — `setCalibrationElodin` in 2.2. The WS
  sibling (`:1225`) reads `lastRawAdc`, filled by `ingest` (`:1759-1761`) → `noteRawAdc` (2.1).

## 3. Why A over B (service objects) and C (ingest→state→broadcast)

- **Clarity.** A concern is found by name, and a *change* touches one file: the stale threshold
  is `board-status`; in C it is `state` + `broadcast` + `ingest`. Sizes from §6.1's ranges:
  `board-status` ≈ 233, `commands`/`ws-connection` ≈ 186, `ingest` ≈ 180, `elodin-link` ≈ 150,
  `engine-state` ≈ 140; tail `mission-time` ≈ 15, `env` ≈ 20, `notifications` ≈ 21. Sixteen is
  the count of distinct owned states in §1.2, not a target.
- **Lines deleted.** Step 2 removes the 9 broadcast-then-`add`/`delete` pairs (`:512-515,
  678-716,1690`), the second T7 filler (`:575-579` vs `:358-362`), the sixth slot copy
  (`:344-345`), the burst's copies of other modules' frames (`:1044-1100`). B adds ≈ 250; C
  deletes nothing beyond A.
- **Testability.** M1 makes every module importable without effects (G6 is a plain vitest); the
  pure core stays pure (`linkStatus`, `client-outbox.ts:334`; `planBackfillSlices`,
  `history-backfill.ts`). B's constructor fakes add nothing the black-box goldens lack, and are
  single-user code (D17d).
- **Characterization fit.** Goldens are black-box over :8081; `src/server.ts` stays the
  entrypoint (`pipeline/run.sh:200`, `test_integration.sh:834`,
  `environmental-recovery.integration.ts:97`). The one path-coupled test,
  `__tests__/lc-tare.test.ts:196-202`, is re-pointed under D18, and row 1.3 catches it going
  *vacuous*, not red, when the drain loop leaves (`indexOf` → −1 twice).
- **Move-only.** Bodies byte-identical except the 8 setters and the `_SEQUENCER_STATE` split,
  reviewed with `--color-moved`. B rewrites ≈ 1500 lines (`boardsStatus` → `this.boards`) and
  fails D17(a); C needs ≈ 40 mutators on `state.ts` — the context object D-c declined.

## 4. Measured: the elision cost, and amendment A10

I ran §6.3 item 6 on `backend-remastered` (46 modules) and resolved from the metafile which
`server.ts` imports keep a value user in §6.1's residual: **9 of 32** (`api-server`,
`video/service`, `board-logs`, `board-scan-rate`, `static-gui`, `dhcp-status`,
`calibration-handler`, `shared/types`, `session-manager`). 23 are elided, and **15** of those
lines (27-34, 39, 41, 47-49, 53, 298) are today the first-evaluation point of **25 modules**
(`sensor-config` alone pins six, `routes/config` and `shared/types` among them). R1a therefore
yields fifteen bare imports in step 1, not the one the note discusses. Exactly one of the 25 has
an import-time effect, `legacy/state-actuators.ts:79-81` (`readConfig` + `console.warn`); the
rest hold Maps, regexes and `__dirname` (`shared-types.ts:7` has a top-level `await import` —
pure, but an async boundary worth pinning).

**A10.** Step 1 stays mechanical: all fifteen, no judgement in a move-only pass. Step 2 item 6 is
amended from "never delete a bare import" to: one may go when every module in its closure passes
the M1 top-level reading, the item-6 order diff shows only those modules moving *later*, and the
item-5 log diff is identical. End state: `server.ts` keeps `./state-csv/state-actuators.js` (and
`state-transitions`, for the async boundary), each commented per S37. Any split pays this cost
(it does not separate A from B or C), but the note under-counted it; D44(2) already allows a
reviewed cleanup diff.

## 5. Research, explicitly

`node-realtime-backend.md` §1: measured above; R1b is the check that counts. §2: three
`setInterval`s, pinned by the startup-order script. §3: the three backpressure policies move
verbatim; `clientStreams` stays a `Map` in connect order (`:209,226,235`); `broadcast` serializes
once (`:905-906`). §4 and `subscription-robustness.md` Ideas 2-4: `elodin-link` is the one home
of `scheduleResubscribe` (`:1503-1522`) and the listeners (`:1583-1635`); `onElodinDisconnected`
keeps `clearSubscriptionState()` (`:1630`), Idea 3's premise; the `elodin-link → board-status`
edge is reserved, not added [A6]. §5: step-2 `publishSample`/`noteSensedRow` take values, not
sockets; R7 measures the hot path.

## 6. Objections, answered

**O1 (B): "module singletons are globals; nothing is testable in isolation."** The process holds
one of everything; a context object threaded through ~60 functions is the god file as a type.
Ownership is compile-checked (TS2632, `ReadonlySet`), isolation is M1 + `vi.resetModules()`, and
every earlier extraction from this file (`board-scan-rate`, `elodin-vtable-registry`, `lc-tare`,
`countdown-state`, `sessionManager`) already works this way.

**O2 (C): "sixteen files; a fire command crosses seven."** Seven because seven decisions are made
(walkthrough (a)), each with one owner. C's `state.ts` (≈ 650 lines, 8 concerns) is the god file
renamed; board health is decided in `state`, worded in `broadcast`, fed by `ingest`.

**O3: "not move-only: 8 setters, 15 bare imports, a split block, a re-pointed test."** Conceded
on the count (§4). Each exception is enumerable and machine-checked: setters by `tsc`, imports by
the order diff, order by the startup script, the rest by `--color-moved`. B has no move-only pass;
C's ≈ 40 mutators are the same exception forty times.

**Concessions.** `config-caches` is the likeliest later merge: `uniqueIdFromPtEntity` serves only
`lastRawAdc` ([A9c]). `mission-time` is 15 lines and stays for its disk file (`countdown-state.js`,
`:298-299`) and two wire frames, not its size. A module with two assigners after step 2 would be
a defect in A, not taste.
