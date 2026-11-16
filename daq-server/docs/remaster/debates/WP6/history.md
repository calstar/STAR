# DESIGN-WP6 — history

The record behind `../../DESIGN-WP6.md`. The design note was republished on 2026-11-16 as a
clean "as decided" note (LEDGER D49: simplicity review, round 1, on top of D39-D48). Everything
below was moved out of it **verbatim** from `DESIGN-WP6.md` at `bcb96252`: the amendment list
A1-A10, the superseded baselines, the struck text and the passages it sat in, the per-commit
checks D49 replaced, step-2 items D49 dropped (2.6 pruning, 2.8, 2.10 except `mismatchVerdict`,
2.11), the settled open questions, the alternatives write-up and the debate summary, the
walkthroughs, and the interface write-up. Line numbers in it are `server.ts` at `b2599617`
(same blob as at `bcb96252`). Where this file and the design note disagree, the note wins.

The debate transcripts and the judge's verdict are beside this file (`round*-*.md`,
`verdict.md`).

---

## Front matter: baseline, prerequisites, amendments A1-A10, verification note, orchestrator decisions, contract

_Verbatim from `DESIGN-WP6.md` lines 3-121 at `bcb96252`._

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

**AMENDMENT (debate verdict) — `debates/WP6/verdict.md`, 2026-11-16.** The WP6 design debate (A
concern modules, B service objects, C pipeline) adopted step 1 unchanged (16 modules, the DAG,
`server.ts` as composition root, §6.1-6.3). Its rulings are applied below, each landing site marked
**AMENDMENT (debate verdict)**; reviewed text the verdict calls wrong is struck through with its
replacement beside it. In short:

- **[A10] Bare imports** (verdict F9): step 1 yields **fifteen** R1a bare imports, not one (§6.1
  R1a lists them); step 2.6 is rewritten as the A10 pruning rule (§6.4 item 6). The step-1 agent
  captures the module-order baseline on the parent commit, in commit 1.1 (D44(2)).
- **Step 2** = 2.1-2.5, 2.8, 2.9 unchanged; 2.6 = A10; new **2.10 pure decisions** (C's idea, B's
  value-level signatures) and **2.11 the test recipe** (B's). **Owners send; decisions return.**
  Not adopted: C's shell/core guard (a module's own timer callback sends, F4) and B's factories
  (STYLE-S34: a vitest is not a second user).
- **No `elodin-link` seam and no clock seam in WP6.** No `createElodinLink` factory, no deps
  object, no `now` dep, no `setClockForTests` in `server/*`; `now` is a parameter of the 2.10 pure
  decisions only; module functions keep `Date.now()` at today's sites; tests fake timers. A later
  D-SUB/D-ECHO package passes `client` as a **parameter at the decision** (`registerVTables(client)`,
  `duePairs(desired, state, now)`), not a factory.
- **Fact corrections** (verdict §1): `broadcast` dereferences `wss` (`:905`), which after row 1.3 is
  an `export let` assigned by `attachWebSocketServer` — a vitest that reaches a sender throws
  unless it mocks `ws-clients` (§3.1, §8 R1); `Date.now()` is read at **9** sites inside the four
  concerns (`:492, 525, 582, 648, 662, 935, 1516, 1549, 1567`; four are `const now =`, `:648` is
  `const at`), and row 1.13's `noteIngest()` adds `:1775`; `activeNotificationKeys.has` is read at
  **8** sites (`:513, 679, 695, 701, 710, 714, 1736, 1747`); the mismatch timer's callback itself
  sends (`:511, 514`); the stale sweep is not pure (it writes `:667, 693, 700, 719`).
- **Gaps** (§7): G1 stays MUST before 1.11/1.12 on a **ball-valve** route with a recorded
  fallback; G2 needs an opt-in simulator flag the orchestrator approves; G3 is a two-config
  fixture, not a sim-config edit.

Line numbers added by this amendment were verified with `git show backend-remastered:…` at
`c3af6e62`, where `diablo_server/`, `sim/` and `test/characterization/pipeline/` are identical to
`b2599617`; `test/test_integration.sh` changed in C1 (+1 line at 239, +7 at 697, +26 at 1092, +1
at 1163), so the verdict's `:516, :674`, which fall in the +1 region, are cited here as `:517,
:675`; later lines of that file moved further, and this amendment does not re-cite them.

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

## §3.1 — the testability bullet and its amendment

_Verbatim from `DESIGN-WP6.md` lines 355-360 at `bcb96252`._

- ~~Testability comes from rule M1, not from injection.~~ **AMENDMENT (debate verdict, F1):** M1
  gives importability, not callability: `wss` is an `export let` assigned by
  `attachWebSocketServer` (row 1.3), and `broadcast` dereferences it (`:905`,
  `wss.clients.size`), so a vitest reaching a sender mocks `ws-clients` (§7, the 2.11 recipe).
  The decisions worth testing alone are extracted as pure functions over values (§6.4 item 10),
  which need no mock, fixture or fake clock.

---

## §6.1 — rules R1 (with the import-closure check), R1a (the fifteen), R1b, R1c, R2, R3, R5, R4

_Verbatim from `DESIGN-WP6.md` lines 505-594 at `bcb96252`._

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

    **AMENDMENT (debate verdict, F9) — the fifteen.** Measured on the 46-module bundle (round-1 A,
    upheld): of `server.ts`'s imports only nine keep a value user once step 1 is done, and fifteen
    of the elided lines are today the first evaluation point of some module, so step 1 turns
    **fifteen** imports into bare imports, not the one this note first discussed. Each becomes bare
    in the commit that moves its last value user out of `server.ts`:

    | line | module | line | module |
    |---|---|---|---|
    | 27 | `elodin-client` | 39 | `legacy/state-actuators` (`state-csv/` after WP5) |
    | 28 | `elodin-protocol` | 41 | `legacy/state-transitions` |
    | 29 | `lc-tare` | 47 | `client-outbox` |
    | 30 | `ball-valve-cal` | 48 | `history-backfill` |
    | 31 | `sensor-config` | 49 | `history-cache` |
    | 32 | `elodin-vtable-registry` | 53 | `calibration` |
    | 33 | `refusal-text` | 298 | `countdown-state` |
    | 34 | `script-status` | | |

    `gui-stream` (`:43-46`) is not on the list: if its line is elided it is still reached at once
    by `client-outbox.ts:37`, the next surviving import. Exactly one module in these closures has
    an import-time effect, `state-actuators.ts:79-81` (config read, can warn). The list is
    mechanical — no judgement about which bare import "matters" in a move-only pass; pruning is
    step 2.6's (A10). The **step-1 agent** captures the module-order baseline (§6.3 item 6) on the
    parent commit, in commit 1.1 (D44(2)), and every later commit diffs against its parent.
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

---

## §6.1 — row 1.1 (baseline capture) and row 1.6

_Verbatim from `DESIGN-WP6.md` lines 596-603 at `bcb96252`._

| # | commit: create | cut from `server.ts` (today's lines) | exports | notes |
|---|---|---|---|---|
| 1.1 | `server/env.ts` | 61, 73-79, 1858 (`GUI_PORT`) | env constants | `CONTROL_COMMAND_TYPES` and `WsWithControl` go elsewhere |
| 1.2 | `server/stats.ts` | 740-754 (+ comment 726-733) | `stats` | `lastIngestMs`/`DATA_FRESH_MS` (734-738) go to 1.13 |
| 1.3 | `server/ws-clients.ts` | 66-72 (`WsWithControl`), 187-209 (`ClientStream`, `clientStreams`), 233-274 body → `flushClientOutboxes`, 278-280 body → `resetOutboxStats`, 901 → `attachWebSocketServer(httpServer)` assigning `export let wss`, 904-917 (`broadcast`, `send`), 941-960 body → `reapUnresponsiveClients` + `KEEPALIVE_MS`, 1557-1562 (`clientStreamStatus`) | see §2 | `server.ts` keeps `setInterval(flushClientOutboxes, 100)` at row 3, `setInterval(resetOutboxStats, 10_000)` at row 4, `attachWebSocketServer(httpServer)` at row 18, `setInterval(reapUnresponsiveClients, KEEPALIVE_MS)` at row 21. **Same commit: re-point the drain slice of `__tests__/lc-tare.test.ts:199-202`** to `server/ws-clients.ts`. From this commit on, `server.ts` no longer contains `cs.outbox.drain()`, both `indexOf` calls return -1, the slice is empty and the two `not.toContain` assertions pass vacuously — the test goes silent here, not red at 1.14. Add a non-vacuity assertion that both anchors are found (`indexOf(...) > -1` for `cs.outbox.drain()` and `cs.pacer.noteFlush`). Mutation to re-run: move the tare into the drain (subtract a `force_kg_tared` offset between the two anchors) → red |
| 1.4 | `server/notifications.ts` | 627, 633-652 | see §2 | |
| 1.5 | `server/history.ts` | 81-86, 122-126, 129 body → `pruneHistory`, 1148-1203 | `history`, `pruneHistory`, `sendHistoricalData` | `broadcastLastTime` (127) goes to 1.7 |
| 1.6 | `server/mission-time.ts` | 297-299 → `export let` + `initMissionTime()` | + `setFirstPacketTimeMs`, `setCountdownTargetMs` | `mission-time.ts` imports `countdown-state.js`; **`server.ts` keeps its own `countdown-state.js` import** (R1: it stays at its position, today line 298, so `countdown-state` still evaluates there). **AMENDMENT (debate verdict, F9):** ~~keeps its own import~~ keeps it **as a bare import** (R1a): `saveCountdownTargetTimeMs` (`:1362`) still uses it until row 1.15 moves `handleCommand`, and that commit rewrites `:298` as `import './countdown-state.js';` — never deletes it |

---

## §6.3 — checks for every step-1 commit (per-commit startup-order and startup-log checks, the 1.1 baseline)

_Verbatim from `DESIGN-WP6.md` lines 644-703 at `bcb96252`._

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
   for the per-commit diff. **AMENDMENT (debate verdict):** the step-1 agent runs `order` on the
   parent commit and records it in commit 1.1 (D44(2)); step 2.6's A10 pruning diffs against it.

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

---

## §6.4 — step 2 as merged (2.2 with the dangling fragment; 2.6 pruning; 2.7; 2.8; 2.10; 2.11)

_Verbatim from `DESIGN-WP6.md` lines 705-840 at `bcb96252`._

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
   that keeps `expandWithTare`) changes nothing~~, and R1a's bare imports **stay** (they are the
   evaluation points). Prune only specifiers; never delete a bare import or turn one back into a
   named import that a later edit could leave unused. Gate: §6.3 item 6 diff empty and the 60-line
   log diff (item 5) identical — no warning may move.~~
   **AMENDMENT (debate verdict) — A10 replaces "never delete a bare import".** Step 1 leaves
   fifteen bare imports (§6.1 R1a). In step 2 a bare import **may** be deleted only when all three
   hold:
   1. every module in its import closure passes the M1 top-level reading (only imports, types,
      constants from `process.env`/literals/`import.meta.url`, pure constructors, functions —
      STYLE-S30);
   2. the §6.3 item 6 module-order diff against the baseline (captured by the step-1 agent on the
      parent commit in commit 1.1, D44(2)) shows those modules **only moving later**, nothing else
      moving;
   3. the §6.3 item 5 startup-log diff is identical.

   `./state-csv/state-actuators.js` (import-time config read and warning, `:79-81`) and
   `./state-csv/state-transitions.js` **stay** bare, each with a comment saying why it is there
   (STYLE-S37). Pruning an unused specifier from a named import is still allowed and changes
   nothing at runtime; never turn a bare import back into a named one.
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
10. **AMENDMENT (debate verdict) — pure decisions** (C's idea, B's value-level signatures; if
    §7 G1's fallback is recorded, `mismatchVerdict` and its vitest land **before** 2.1). Four decisions become functions over **values** that return today's payload
    literals (same text, same key order, G9) or `null`, with no import-time read, no send, no log,
    no clock read and no write. Each lands with a backend vitest and a listed mutation that goes
    red. **Owners send; decisions return:** the owning module calls the function and keeps every
    send, write and log; no carrier type beyond `NotificationPayload`, no dispatcher. Each caller
    keeps its `const now = Date.now()` (or `epochNow`) **where it is** and passes it in.
    - `actuator-mismatch.mismatchVerdict(expected, sensed, stateName, mismatchActive, now):
      NotificationPayload | null` — the decision of `:489-516` (the `expected` empty → `null`
      early-out of `:490` included) minus the sends. `checkActuatorMismatch` (the timer
      callback) fetches `getExpectedPositions(state)`, `configStateName(state) ??
      SystemState[state] ?? 'UNKNOWN'`, `activeNotificationKeys.has('actuator_mismatch')`, keeps
      `const now = Date.now()` (`:492`), calls the verdict, then does today's `console.warn` (on
      raise), `broadcastNotification` and `add`/`delete` (`:510-515`). **Listed non-verbatim
      edits:** `configStateName` is hoisted out of the mismatch branch (today it runs only when
      something mismatches; it reads the deployed-config cache and logs nothing); the warn line
      moves to the caller, its text built from the returned `message`.
    - `board-status.boardHealthEvents(status, prev, firstSeenSetup, activeKeys, now):
      NotificationPayload[]` — the per-board notification decisions of `:671-717`, in today's
      order (lost raise/clear, one-shot connected, setup-stuck raise/clear, unrecognized
      raise/clear). `markStaleBoards` keeps its loop, its `const now` (`:662`), and every write —
      `status.connected = false` (`:667`), `boardFirstSeenSetupMs` set/delete (`:693, 700`), the
      key-set `add`/`delete`, `prevConnectedState.set` (`:719`) — and `broadcastBoardStatus()`
      (`:721`) (verdict F5: the sweep is not a pure reducer, only its per-board verdict is).
      **Listed non-verbatim edit:** the `boardFirstSeenSetupMs` set at `:693` happens in the loop
      before the call, which receives the resulting `first`.
    - `board-status.selfTestFailure(boardId, rows, notified, label, now): NotificationPayload |
      null` — the `self_test_fail_<id>` payload for the first failing row of a board not yet in
      `notified`, else `null` (from `:1679-1689`). `noteSelfTestResults` keeps the `selfTestLatest`
      snapshot writes up to and including the failing row (the `break` stays), the
      `selfTestNotifiedBoards.add`, the send and the key `add`; `epochNow` stays the caller's
      (`:1670`). **Listed non-verbatim edit:** `label` is computed before the call.
    - `elodin-link.nextResubscribeDelay(res, now): number` — `:1512-1516`. `scheduleResubscribe`
      passes `Date.now()`; **listed non-verbatim edit:** the inline `Date.now()` of `:1516`
      becomes the `now` parameter, read at the same moment by the caller. The loop
      (`scheduleResubscribe`, the timer dedupe `:1504`, the `isConnected` guard `:1507`, the
      `.catch` → 5 s `:1518-1520`) and the four listeners stay verbatim (A6 room); there is **no
      `createElodinLink` factory and no deps object** in WP6.

    Return types `selfTestFailure → NotificationPayload | null` and `nextResubscribeDelay →
    number` are this note's reading of the verdict, which gave only the parameters. **Clock:**
    `now` is a parameter of these four pure decisions only. No `now` dep, no `setClockForTests`
    in `server/*`; every other module function keeps `Date.now()` at today's sites (verdict F2:
    nine in the four concerns, `:492, 525, 582, 648, 662, 935, 1516, 1549, 1567`); tests fake
    timers (`elodin-reconnect.test.ts:62`, `board-scan-rate.test.ts:17, 23` already do; the
    registry's `nowFn`/`setClockForTests` at `elodin-vtable-registry.ts:96-99` is the registry's
    own and is not copied). The verdicts read `activeNotificationKeys` only through
    the `mismatchActive`/`activeKeys` values their caller passes (eight `has` reads today: `:513,
    679, 695, 701, 710, 714, 1736, 1747`).
11. **AMENDMENT (debate verdict) — the test recipe** (B's), also written into §7. A vitest of a
    layer ≥ 2 `server/*` module: `vi.mock('../ws-clients.js')` (any sender otherwise throws on
    the unassigned `wss`, `:905`); `vi.useFakeTimers()` + `vi.setSystemTime(…)`; `vi.resetModules()`
    and a dynamic `import()` per case (module singletons); a `CONFIG_PATH` fixture (a temp-dir
    `config.toml`, as `config-profile-create-calibration.test.ts` does) for any closure that
    contains `engine-state`, `commands`, `elodin-link` or `session-manager` (`elodin-link` reaches
    `engine-state` through `onElodinConnected` → `refreshScriptStatus()`, `:1601`, verdict F10).
    The 2.10 pure decisions need none of this.

Step 2 is its own queue item, gated in full like step 1; each commit runs the per-commit checks of
§6.3 and the checkpoint runs after 2.1 and at the end.

---

## §6.5 — the 2.10 bullet

_Verbatim from `DESIGN-WP6.md` lines 860-863 at `bcb96252`._

- **AMENDMENT (debate verdict):** step 2.10 moves no `Date.now()` site and no payload literal: each
  caller keeps its clock read where it is today (`:1516`'s inline read is rewritten in place as the
  `now` argument, which `scheduleResubscribe` reads at that same point in the `.then`), and the returned payloads are today's literals with
  today's key order (G9).

---

## §7 — the vitest amendment, the gap table, G1-G3 with struck text, the C0 list

_Verbatim from `DESIGN-WP6.md` lines 884-972 at `bcb96252`._

**AMENDMENT (debate verdict) — backend vitests (step 2.11's recipe).** A vitest of a layer ≥ 2
`server/*` module uses `vi.mock('../ws-clients.js')`, `vi.useFakeTimers()` + `vi.setSystemTime`,
`vi.resetModules()` with a dynamic import per case, and a `CONFIG_PATH` fixture for any closure
containing `engine-state`, `commands`, `elodin-link` or `session-manager`; the 2.10 pure decisions
need none of it (§6.4 item 11). **Backend vitests do not discharge §7 rows**: the rows below are C0
characterization, black-box. Substituting a vitest for a row is a decision the orchestrator records
per row (as G1's fallback below), never a default.

### Gaps — a move could change these and no golden would notice

Each is a test to add **before** the step that touches it. G1-G5, G7-G10 belong in
`test/characterization/**` (C0-owned); G6 is a backend vitest that WP6 adds itself; G11 and G12 are
WP6's own per-commit scripts (§6.3).

| gap | priority (orchestrator) | must exist before |
|---|---|---|
| G7 + G8 | MUST | step 1 |
| G1 | MUST — **AMENDMENT (debate verdict):** ball-valve route; recorded fallback if C0 cannot land it before 1.10 merges | commits 1.11 / 1.12 (feasibility below) |
| G10 | MUST | commits 1.15 / 1.16 |
| G4 | MUST, owned by WP5 | WP5 lands |
| G11, G12 | MUST (scripts, §6.3 items 4-5) | step 1, first commit |
| G9 | should | step 2 |
| G2, G3 | should — **AMENDMENT (debate verdict):** G2 needs an opt-in simulator flag (orchestrator approval); G3 is a two-config fixture | steps 2.1 / 2.2 |
| G6 | should | step 2.3 |
| G5, G13 | nice-to-have | — |

- **G1 Actuator mismatch** never fires in any golden (`grep actuator_mismatch` → nothing in
  pipeline, lifecycle or `ws_data_flow_test.ts`). Its state moves across three modules
  (`actuator-mismatch`, `engine-state`, `notifications`) and step 2.1 moves the sensed-state blocks.
  **The script first proposed here is infeasible:** turning `debug_mode` off calls
  `actuator_commander_.clearAllManualOverrides()` before it publishes state
  (`SequencerService.cpp:949-952`), so the manually opened valve returns to the state's position
  and nothing is left to mismatch. ~~Two candidates, for C0 to confirm before choosing:
  (a) stay in debug: unlock → `debug_mode` on → open a valve the current state expects closed →
  `debug_mode` on **again** (`doSetDebugMode(true)` publishes state without clearing overrides, which
  schedules the 5 s check) → expect `notification actuator_mismatch ongoing=true "Actuator mismatch
  in <state>: <name> (expected CLOSED, sensed OPEN)"` ≥ 5 s later → close the valve (a sensed change
  with the key active reschedules) → `"Actuator positions match expected" ongoing=false` → debug
  off. Needs confirming that the second `DEBUG_MODE:1` reaches `publishState()` and that the
  simulated actuator board reports the opened channel as sensed open. (b) a simulator-side
  sensed-state fault: `board_simulator.py` reports one actuator channel's current-sense opposite to
  its command, so any state publish yields a mismatch 5 s later. (b) does not depend on debug-mode
  semantics but needs a simulator option.~~
  **AMENDMENT (debate verdict, F7) — neither candidate as written; the ball valve delivers.** No
  sensed `ACTn.CHm.actuator_state` row exists in any pipeline golden (only `ACT_CMD.*_commanded`),
  so `:497` skips every ACT entity: in the simulated stack no sensed `actuator_state` row reaches
  the backend, and the simulator's ACTUATOR current is a free sine (`board_simulator.py:617-623`;
  commands reach only `valve_target`, `:430-441`). That strikes (a)'s ACT-board form and (b). A
  **ball valve** does report a sensed position: `BV1_Cal.CH1.position_pct`
  (`pipeline/golden/boards/ws_streams.txt:100-105`) → sensed entity `BV1.CH1` (`server.ts:1727-1738`),
  and `resolveActuatorTelemetryEntity` maps a ball-valve role to `BV<n>.CH<m>`
  (`state-actuators.ts:140-144`). The script C0 builds:
  - **Fixture:** the `Main Ball Valve` actuator role and a CLOSE-in-every-state CSV row, as
    `test_integration.sh` has them (`"Main Ball Valve" = ["NC", 1, 71]` at `:675`, the CSV row at
    `:517`), in a new pipeline mode or a `ws_data_flow_test` case — **not** the frozen `boards`
    session.
  - **Steps:** unlock → `debug_mode` on → `actuator "Main Ball Valve" 1` → wait > 3 s
    (`BALL_VALVE_TRAVEL_S`, `board_simulator.py:49`) → `debug_mode` on **again**
    (`doSetDebugMode(true)` publishes state without clearing overrides, `SequencerService.cpp:947-954`,
    which schedules the 5 s check) → ≥ 5 s → `notification actuator_mismatch ongoing=true
    "Actuator mismatch in <state>: BV1.CH1 (expected CLOSED, sensed OPEN)"` → close the valve (a
    sensed change with the key active reschedules) → `"Actuator positions match expected"
    ongoing=false` → debug off.
  - **Fallback (recorded):** if C0 cannot land it before row 1.10 merges, the orchestrator records a
    substitution: a `--color-moved` review of `:472-517` and of the 1.11 split, plus step 2.10's
    `mismatchVerdict` vitest landing before 2.1. G1 stays MUST before 1.11/1.12 either way.
- **G2 `self_test_fail_<id>`** (one notification per board, `break` after the first failure): the
  simulators only pass (`board_simulator.py:344, 460-461`). ~~Needs a simulator option that fails
  one sensor.~~ **AMENDMENT (debate verdict):** needs an
  opt-in `--fail-connector <board>:<ch>` in `sim/board_simulator.py`, default unchanged. The file is
  shared: `service-controller.ts:21` also launches it (simulated systemd runs), so the option needs
  the orchestrator's approval (team question 2).
- **G3 `unrecognized_<id>`**: ~~no board outside config ever heartbeats in a golden.~~
  **AMENDMENT (debate verdict, F6):** it is not "one fixture edit" to the sim config. The pipeline
  gives `$CFG` to `daq_bridge` (`pipeline/run.sh:182`) and to the backend (`:195`); only the
  simulator reads `sim_config.toml` (`:223`). `daq_bridge` registers `[0x10, id]` only for its
  config's enabled boards (`daq_bridge_main.cpp:568-571, 590`), and the backend subscribes
  `[0x10, id]` only for its config's boards (`elodin-vtable-registry.ts:242-262, 335-340`; 1..255
  only when none qualify), so a sim-only board is never heard. Dischargeable black-box by C0 with
  a **two-config fixture**: `daq_bridge` and the simulator on `$CFG`; the backend on a copy in which
  one board is still subscribed but not `expected` — spell its id `id =` instead of `board_id =`
  (the registry takes `b.board_id ?? b.id`, `:247`; `loadBoardsFromConfig` needs a numeric
  `board_id`, `server.ts:399`). An empty `[boards]` also works but trips the registry's 1..255
  fallback, which its own comment (`:330-334`) names as the request-id overflow; avoid it. C0
  confirms; before 2.1/2.2.
- **AMENDMENT (debate verdict) — C0 builds:** the G3 fixture, the G2 option and case, the G1
  ball-valve case; G7/G8, G10, G11/G12. [Verdict text as written. This section's preamble and the
  priority table keep G11/G12 as WP6's own per-commit scripts (§6.3 items 4-6), not C0
  characterization; orchestrator to confirm which.]

---

## §8 — risk R1 with its amendment, R2, R3

_Verbatim from `DESIGN-WP6.md` lines 1013-1035 at `bcb96252`._

## 8. Risks

- **R1 Shared state.** Mitigated by single ownership (§1.2), setters for the 8 cross-module writes
  (§6.2, checked by `tsc`), and keeping cross-module `Map`/`Set` mutation verbatim until step 2. The
  subtle ones: `calibrationHost` must be built after the PT load (path by value); `wss` is a live
  binding assigned by `attachWebSocketServer` and must never be destructured into a local.
  **AMENDMENT (debate verdict, F1):** because `wss` becomes an `export let` (row 1.3), every sender
  (`broadcast` dereferences it at `:905`) throws in a test process that never called
  `attachWebSocketServer`; today's `const wss` (`:901`) cannot be unassigned. Backend vitests mock
  `ws-clients` (§6.4 item 11); in production row 18 assigns it in the synchronous startup body,
  before any timer or listener can run (a synchronous send before row 18 would already be a TDZ
  error on today's `const`).
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

---

## Open questions, team questions, alternatives considered, the debate summary, walkthroughs, interfaces, STYLE conformance (to the end of the note)

_Verbatim from `DESIGN-WP6.md` lines 1067-1440 at `bcb96252`._

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

**AMENDMENT (debate verdict) — team questions the verdict leaves open** (`debates/WP6/verdict.md` §6,
verbatim):

1. Sensed `ACTn.CHm.actuator_state` rows are absent in the simulated stack — on the stand too? If
   so, `actuator_mismatch` has never fired for an ACT board (record, don't fix).
2. May C0 add opt-in flags to `sim/board_simulator.py`, which simulated systemd runs also launch?
3. Does a vitest count as S34's second user? Recommend no, unless it produces a gate artifact.
4. D-SUB/D-ECHO: approve the `client`-parameter seam then; reserve Idea 2's `control` event in
   `elodin-link`'s header now?
5. Confirm the step-1 agent owns the order-diff baseline (D44(2)).

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

**Module list and layering unchanged.** The deeper pass amends the reviewed design in places —
[A1]-[A9] at the top (client name and port owner, a missing edge, elided imports, two new step-2
commits 2.8 and 2.9, the timer rule, the D-SUB room, STYLE conformance, the interface
refinements); each is marked where it lands.

### AMENDMENT (debate verdict) — the WP6 design debate (`debates/WP6/`, 2026-11-16)

Three advocates re-argued A, B and C over two rounds; the judge adopted step 1 (A's sixteen
modules, the DAG, `server.ts` as composition root, §6.1-6.3) unchanged. What each side gave up,
and what step 2 took from it:

- **A (prevails).** Kept: the module layout, owners that send, and **A10** (fifteen bare imports
  in step 1; pruning by three conditions in 2.6). Conceded: "testability comes from M1" was
  overstated — importable is not callable once `wss` is an `export let` (`:905`, F1); the comparison
  table's A "testability" cell above is read with that correction.
- **B (loses factories, wins the recipe).** Abandoned in round 2: the per-concern factories
  (`createBoardStatus`, `createActuatorMismatch`, `createNotifications`) and the `now` dep, in favour
  of C's pure decisions with `now` by parameter. Kept to the end and **not adopted**: one
  `createElodinLink(deps)` factory with a fake-client vitest as its second user — STYLE-S34 as the
  tree applies it counts `CalibrationHost`'s second user because it produces
  `calibration/golden/ts.txt`, and a vitest is not a second user; nor is the vitest fixture-free
  (`onElodinConnected` → `refreshScriptStatus()`, `:1601`, reaches `engine-state`, which reads
  config at import; F10). The resubscribe chain B wanted tested (`:1504, 1507, 1512-1513,
  1518-1520, 1629-1630`, F11) is real behaviour no test reaches; deferred to D-SUB (D17(d)), which
  passes `client` at the decision. **Adopted from B:** the value-level signatures of 2.10 (`expected`,
  `stateName` passed in, so the mismatch vitest needs no fixture) and the 2.11 test recipe.
- **C (loses shell/core, wins decisions).** Abandoned in round 2: per-concern objects, and the
  claim that the `elodin-link` chain needs no seam (conceded to B). Kept to the end and **not
  adopted**: the shell/core guard ("the six core files import no sender") and owners returning
  frames for 2.8 — `actuator-mismatch`'s own 5 s timer callback is the sender (`:511, 514`, F4),
  and the guard adds about a dozen new dispatch sites where key order (G9) is unguarded. Also
  ruled false: `staleSweep` as a pure reducer (`:667, 693, 700, 719` are writes, F5). **Adopted
  from C:** pure decisions over values with `now` as a parameter (2.10; the same shape as WP5's
  `duePairs` and the registry's `nowFn`), and the observation that the raise/clear verdict already
  lives in the payload's `ongoing` (nine of nine sites), so no carrier type beyond
  `NotificationPayload` is needed.

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
    **`notifications.raiseNotification` / `clearNotification`** (step 2.2). **AMENDMENT (debate
    verdict):** the timer callback first calls the pure **`mismatchVerdict(expected, sensed,
    stateName, mismatchActive, now)`** (step 2.10), then sends what it returns; the decision is
    `actuator-mismatch`'s, the send stays in its own callback.
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
   **AMENDMENT (debate verdict):** per board the sweep keeps its writes and calls the pure
   **`boardHealthEvents(status, prev, firstSeenSetup, activeKeys, now)`** (step 2.10) and sends
   each returned payload in order.
2. Same second, in registration order [A5]: the 1 s `broadcastBoardStatus` (**`board-status`**),
   then `broadcastConnectionStatus` (**`elodin-link`**). The order is on the wire (G11).
3. **A heartbeat returns.** `[0x10, id]` → **`ingest`** (delivery note first) →
   **`board-status.countHeartbeat` + `updateBoard`**: was disconnected → `broadcastBoardStatus()`
   immediately. A T7 has no heartbeat: its data rows reach **`board-status.noteT7Alive`** via the
   T7 slot lookup (**`config-caches.t7BoardIdForSlot`**, one owner after step 2.4).
4. Next sweep: **`board-status`** clears `board_lost_<id>` (`clearNotification`, `ongoing:false`)
   and emits the one-shot `"… connected"` info (`broadcastNotification`). **AMENDMENT (debate
   verdict):** both payloads come from **`boardHealthEvents`** (step 2.10); `markStaleBoards`
   sends them.
5. A board config does not know: `updateBoard` creates it with `expected:false`; the sweep raises
   `unrecognized_<id>`. **`board-status`**.
6. Self-test rows `[0x60..0x6F, id]` → **`board-status.noteSelfTestResults`** (step 2.1): snapshot
   for replay, first failure per board → `self_test_fail_<id>`. *In step 1 this has two owners*
   (`ingest` writes `selfTestLatest` and the notification key, `board-status` owns them) — the
   planned step 2.1 fixes it. **AMENDMENT (debate verdict):** inside `noteSelfTestResults` the
   pure **`selfTestFailure(boardId, rows, notified, label, now)`** (step 2.10) decides the
   `self_test_fail_<id>` payload; `noteSelfTestResults` keeps the snapshot writes and sends it.
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
| `board-status.ts` | 3 | `BOARD_STATUS_HZ`, `BOARD_HEARTBEAT_STALE_MS`, `boardsStatus`/`selfTestLatest`/`selfTestNotifiedBoards` [step 1], `loadBoardsFromConfig`, `updateBoard`, `countHeartbeat`, `noteT7Alive`, `markStaleBoards`, `broadcastBoardStatus`, `boardLabel`, `logDiagnostics`, `noteSelfTestResults`, `sendBoardStatus`, `sendSelfTestReplay`, `boardHealthEvents`/`selfTestFailure` [step 2.10] |
| `engine-state.ts` | 3 | `currentState`, `debugMode`, `stateActuatorMap`, `initEngineState`, `reloadStateActuatorMap`, `configStateName`, `getExpectedPositions`, `broadcastCommandedActuatorsForState`, `broadcastStateUpdate`, `refreshScriptStatus`, `setDebugMode` [step 1], `applySequencerState`, `sendConnectStateUpdate`, `sendCommandedSnapshot`, `TransitionTarget`, `resolveTransitionTarget` |
| `actuator-mismatch.ts` | 4 | `actuatorSensedState` [step 1], `scheduleActuatorMismatchCheck`, `noteSensedRow`, `mismatchVerdict` [step 2.10] |
| `elodin-link.ts` | 4 | `elodin`, `noteIngest`, `isSimulated`, `connectionStatusPayload`, `broadcastConnectionStatus`, `syncElodinToSession`, `onElodinConnected`, `onElodinDbError`, `onElodinDisconnected`, `onElodinError`, `nextResubscribeDelay` [step 2.10] |
| `ingest.ts` | 5 | `handleElodinPacket` |
| `commands.ts` | 5 | `handleMessage` |
| `ws-connection.ts` | 6 | `handleConnection` |
| `../server.ts` | 7 | `applyDeployedConfigChange` |

Also in the stub tree: WP5's `sequencer-client.ts`, `sensor-config.ts` (delta), `elodin-vtable-registry.ts`
(delta: `duePairs`), `state-csv/*`; WP7's `api/*`, `api-server.ts`.

**AMENDMENT (debate verdict).** The stubs gain step 2.10's four pure decisions —
`actuator-mismatch.mismatchVerdict`, `board-status.boardHealthEvents` and `selfTestFailure`,
`elodin-link.nextResubscribeDelay` — typed over values only (`NotificationPayload`, `BoardStatus`,
`ParsedSensorData`, `SubscriptionPassResult`, all already in `product-types.ts`; no new type). The
`elodin-link` header now says WP6 has no factory or deps object and that D-SUB passes `client` as
a parameter at the decision. Nothing in the stubs had a factory, deps object or clock seam to
remove. Type-check re-run after the change: exit 0.

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
