# Research: long-lived Node/TypeScript WS + HTTP telemetry server (WP5/WP6/WP7)

Scope: how to structure `diablo_server/backend/src/server.ts` (1885 lines) and `api-server.ts`
(1269 lines) as they are split by WP6/WP7, measured against outside practice. Line numbers are
`backend-remastered` @ `85a02f9a` (same as the designs' `b2599617` baseline for these two files).
Paths are relative to `daq-server/diablo_server/backend/src/` unless stated. Every idea is labelled
**ADOPTABLE** (inside the remaster, behaviour-preserving) or **PROPOSAL** (changes something
observable; goes to Parked / the team, never into a remaster commit).

Toolchain facts used below (checked in this worktree): `package.json` `"type": "module"`,
`dev` = `tsx watch src/server.ts` (production, WP6 R10), `start` = `node dist/server.js` (tsc
emit); tsx 4.21.0 → esbuild 0.27.3; Node 24.21.0; `ws` ^8.19; `tsconfig.json` has **no**
`verbatimModuleSyntax` / `isolatedModules`.

---

## 1. The evaluation-order guarantee in WP6 R1 / WP7 S2 is textual; the runtime elides imports (lead)

**What it is.** TypeScript's emit — and esbuild, which tsx and vitest use — deletes an import
declaration whose specifiers are all unused as values. esbuild's docs: *"By default, the TypeScript
compiler will delete unused imports when converting TypeScript to JavaScript … [verbatimModuleSyntax]
allow[s] you to disable this behavior and preserve unused imports, which can be useful if for example
the imported file has useful side-effects"* (https://esbuild.github.io/content-types/#typescript-caveats;
TS: https://www.typescriptlang.org/tsconfig/#verbatimModuleSyntax). A bare `import './x.js'` is
never elided. ESM evaluates each module once, depth-first post-order over the imports that
*survive emit* (https://tc39.es/ecma262/#sec-innermoduleevaluation).

**Reproduced here** (temp dir, this repo's tsx and tsc): `a.ts` with `import { bx } from './b.js'`
(unused), `import { cx } from './c.js'` (used), `import './b2.js'` → both `tsx a.ts` and `tsc`+`node`
print `C evaluated`, `B2 evaluated`, never `B evaluated`; tsc's emitted `a.js` has no `./b.js` line.

**It already happens in this tree.** Emitting the backend with and without `--verbatimModuleSyntax`
and diffing the import lines: `api-server.js` today drops `import … from './elodin-query.js'` and
`'http'`; `calibration-handler.js` drops `'ws'` and `'./calibration.js'`; `elodin-vtable-registry.js`
drops the `ElodinClient` specifier. So "today's evaluation order" is the order of *used* imports.

**How it maps onto our code.**
- DESIGN-WP6 §6.1 R1 says `server.ts` "keeps **all** of today's import statements, in today's order
  (unused ones included)" so every pre-existing module "evaluates exactly when it does today".
  That holds only while `server.ts` still *uses* a value from each. Step 1 moves the users out. The
  clearest case: `server.ts:39` imports `getStateActuatorMap, CSV_ACTUATOR_TO_ENTITY,
  resolveActuator*` from `legacy/state-actuators.js`, which builds three maps from config **at
  import** and can log (`legacy/state-actuators.ts:79-81`). Nothing else imports it (grep). Once
  `engine-state`/`commands` own every use, the line at :39 is elided and `state-actuators` first
  evaluates when `server/engine-state.ts` is imported — after `session-manager`, `config-validation`,
  `ball-valve`, `shared/config-validation` instead of before `board-scan-rate`. Its import-time
  warnings move in `backend.log` (G12 territory), and any module it pulls in moves with it.
- The §6.1 "import closure" check (`grep -oE "from '\./[^']+'" server.ts`) reads source text, so it
  passes in exactly this case. Same for WP7 S2's check on `api-server.ts`: when the router stops using
  `sessionManager`, `routes/config-profiles`, `ota-*`, those modules evaluate from inside the first
  `api/*` file instead, reordering them against `api-server.ts`'s other imports (today's esbuild order:
  `api-server → routes/config-profiles → routes/script-check → session-manager → … → ota-build →
  ota-service-cmd → board-logs → video/*`).
- DESIGN-WP6 §6.4 item 6 ("pruning imports … can reorder import-time evaluation") is the converse
  and is mostly moot: an import with no used specifier is already gone at runtime; pruning
  `resetTareState`/`setRunDir` (`server.ts:29`, line still has `expandWithTare`) changes nothing.

**Remedy (ADOPTABLE, tooling + one source rule, no behaviour change).**
1. *Measure the runtime order, not the text.* esbuild's bundle concatenates modules in evaluation
   order with a `// <path>` banner per module, and there are no `__esm`/`__commonJS` lazy wrappers
   in this graph today (count 0), so the order is exact:
   ```bash
   cd diablo_server/backend
   npx esbuild src/server.ts --bundle --platform=node --format=esm --packages=external \
     --log-level=error | grep -E '^// (src|\.\./)' \
     | awk '{last[$2]=NR; o[NR]=$2} END{for(i=1;i<=NR;i++) if(last[o[i]]==i) print o[i]}'
   ```
   (keeps each module's last banner = its body.) Diff this list before/after every step-1 and step-2
   commit; the only allowed change is new `server/*` / `api/*` entries (effect-free by M1). Runs in
   < 1 s, binds no port, needs no stack lock. It replaces neither G12 (log diff) nor `tsc --noEmit`;
   it covers what both miss: a reordering of a module that happens not to log under the test config.
2. *When step 1 leaves an import with no used specifier, turn it into a bare side-effect import at the
   same position* (`import './legacy/state-actuators.js';`). Identical evaluation point under tsc,
   tsx and vitest, and it states why it is there. Only for modules the order list says are evaluated
   *first* at that line.
3. **Not** `verbatimModuleSyntax`: per the diff above it would *add* `elodin-query` to today's
   evaluation set and move `calibration.ts` ahead of `calibration-handler.ts` (today it evaluates
   after it, via `server.ts`'s own import), and it makes `tsc` fail on 12
   type-imported-as-value sites (10 in `frontend/lib/video/layout.ts`). Behaviour change → PROPOSAL
   at most, and not a useful one.

**Cost.** One script (~5 lines) in WP6/WP7's per-commit checks (§6.3 / §6.1), and a few bare imports.

**Goldens touched.** None directly; `lifecycle/golden/startup.txt` freezes only the WS handshake, and
G12 (startup log order) is a per-commit diff, not a golden. This is why it needs its own check.

---

## 2. Same-period timers: FIFO is a property of Node's timer lists (supports G11)

**What it is.** `lib/internal/timers.js` (https://github.com/nodejs/node/blob/main/lib/internal/timers.js):
*"Object maps are kept which contain linked lists keyed by their duration in milliseconds"* and
*"Any timer added later will always have been scheduled to timeout later, thus only needing to be
appended."* A re-armed interval is re-appended, so order among equal-duration intervals is stable.
The public docs (https://nodejs.org/api/timers.html) do not promise this; it is implementation.

**Mapping.** The three 1 s timers are `server.ts:724` (`markStaleBoards`), `:939`
(`broadcastBoardStatus`, `1000 / BOARD_STATUS_HZ` with `BOARD_STATUS_HZ = 1` at `:87`, so the same
list) and `:1581` (`broadcastConnectionStatus`). All are registered synchronously in the module body,
so they share libuv's cached loop time and the same start; DESIGN-WP6 §1.3's claim holds.

**Consequences for WP6.**
- ADOPTABLE: keep the three `setInterval` calls as three calls in `server.ts`, in this order — the
  composition-root design already does. The startup-order script (§6.3 item 4) is the right guard;
  a runtime test is not worth it (it needs the composition root's sockets).
- Do **not** fold them into one 1 s `tick()` that calls the three: an exception in
  `markStaleBoards` today is caught by the `uncaughtException` guard and the other two still fire
  that second (§4.1 "timer callback throws"); in one tick they would not. Wrapping each in try/catch
  changes which guard logs. Either variant is a behaviour change → not in the remaster.
- `RESUBSCRIBE_MIN_MS` / `setTimeout` chains (`server.ts:1503`) are not in that list and have no
  ordering constraint against the 1 s group.

---

## 3. Backpressure for WS fan-out: we already coalesce; the control path is unbounded

**Outside practice.**
- *Skip / close past a cap:* uWebSockets.js `maxBackpressure` — *"Slow receivers with too high
  backpressure will be skipped until they catch up or timeout"*; `closeOnBackpressureLimit` closes
  them; `drain` + `getBufferedAmount()` drive throttling
  (https://unetworking.github.io/uWebSockets.js/generated/interfaces/WebSocketBehavior.html).
- *Drop if not writable:* Socket.IO volatile events *"will not be sent if the underlying connection
  is not ready"*, intended for latest-value data such as positions
  (https://socket.io/docs/v4/emitting-events/#volatile-events).
- *Pause the producer:* Node streams (`write()` → false, wait for `'drain'`)
  (https://nodejs.org/en/learn/modules/backpressuring-in-streams). Doesn't fit fan-out: one slow
  client must not pause ingest for all of them.
- `ws` itself has no policy: `send()` queues into the socket and `bufferedAmount` reports it; its
  README recommends ping/pong reaping and keeps permessage-deflate *"disabled by default on the
  server"* (https://github.com/websockets/ws#how-to-detect-and-close-broken-connections).

**Mapping — three paths, three policies today.**
| path | code | policy |
|---|---|---|
| downsampled sensor windows | `emitSensorWindow` `server.ts:222` → `ClientOutbox` → 100 ms drain `:233-276`; `FlushPacer.shouldFlush` `client-outbox.ts:387`, `SOCKET_IDLE_BYTES` 4 KiB `:312`, `DEFAULT_TARGET_LAG_MS` 1500 `:316` | coalesce: a min/max ladder that loses *resolution*, not *time*. Stronger than uWS skip or Socket.IO volatile, because a spike survives at its true timestamp |
| historical backfill | `sendHistoricalData` `:1170` → `history-backfill.ts:120` `waitForSocketDrain` (30 s, then abandon tail) | pause this one producer, per socket |
| control/events + immediate streams | `broadcast` `:904`, `send` `:914`, `emitSensorPoint` `:213` | **none**: `ws.send` regardless of `bufferedAmount`; bounded only by the keepalive reaper (`:947-960`, 30 s, so ≤ ~60 s of backlog) |

**Verdict.**
- ADOPTABLE: nothing to change in WP6. Move the three policies verbatim into `ws-clients` (outbox +
  pacer), `history` (backfill) and `ws-clients.broadcast/send`. Two things to preserve that no
  golden names: (a) `clientStreams` is a `Map`, iterated in insertion order (= connect order) by the
  drain loop and by `emitSensorWindow`; keep it a `Map` owned by `ws-clients`; (b) `broadcast`
  serializes once and checks `wss.clients.size === 0` first (cheap path when no GUI is open).
- PROPOSAL (team): a hard cap on the control path, uWS-style — if `bufferedAmount` exceeds N MB,
  `terminate()` the client instead of waiting up to 60 s for the reaper. Changes which frames a
  stalled client receives and when it is dropped → contract change. Do **not** make control frames
  volatile: `client-outbox.ts:30-35` already explains why state transitions and abort notifications
  must never be dropped silently. Termination (client reconnects and gets the connect burst, which
  replays state, notifications and history) is the only acceptable degradation.

**Cost of the proposal.** ~10 lines in `ws-clients.broadcast/send`, a lifecycle case (SIGSTOP a
scripted client) and a golden line; would also close part of WP6 gap G5 (keepalive reaper untested).

---

## 4. Subscription lifecycle: liveness, not acceptance (D-SUB)

**What it is.** OPC UA (industrial telemetry's reference model) never treats an accepted subscription
as proof of delivery: the server sends a keep-alive when a subscription has nothing to say,
*"This keep-alive Message informs the Client that the Subscription is still active"*, and a lifetime
counter closes it with `Bad_Timeout` when it expires
(https://reference.opcfoundation.org/Core/Part4/v105/docs/5.14.1). The client therefore detects a
silent subscription by absence and re-creates it.

**Mapping.** Our liveness signal is `notePairDelivered` (`elodin-vtable-registry.ts:108`, set
`deliveredPairs` `:87`); the retry ladder (`scheduleResubscribe` `server.ts:1503`, `MAX_PAIR_ATTEMPTS`
12) re-sends only pairs the DB *refused* (`noteSubscriptionRejected` `:136`). LEDGER D-SUB: a
subscription made while a table is being re-registered is accepted and then delivers 0 packets
forever; nothing trips. Elodin offers no keep-alive, so the client-side half is all we can do: a pair
that was accepted, has not delivered within T, and whose board is heartbeating (`boardsStatus`
live) is un-marked and re-subscribed on the next pass.

**Verdict: PROPOSAL only.** It changes the number and timing of subscription messages
(`lifecycle/golden/reconnect.txt` freezes the (re)subscription count) and turns a dead GUI channel into
a live one — a defect fix, which D5/D17(e) forbid inside the remaster. Record under D-SUB. WP6's
job is only not to make it harder: `elodin-link.ts` should own `scheduleResubscribe` and the
connect/disconnect listeners verbatim (as §2 plans), so that the future watchdog has one home. The
"board heartbeating" input lives in `board-status` (layer 3); `elodin-link` (layer 4) may import it
without a cycle, but §2's edge list does not have that edge today. Adding it later is cheap; it is
noted so nobody "fixes" the layering in a way that forbids it.

---

## 5. Functional core / ports, routing tables, and the `sendJson` ordering trap

**Functional core, imperative shell** (Bernhardt,
https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell) and **ports
and adapters** (Cockburn, https://alistair.cockburn.us/hexagonal-architecture/): decisions in pure
functions over values; I/O at the edge behind narrow interfaces. **This backend already does it where
it mattered:** `linkStatus` (`client-outbox.ts:334`, pure "because a setInterval is not [testable]"),
`FlushPacer`, `planBackfillSlices` and the `DrainableSocket` port (`history-backfill.ts:67,112`),
each with a vitest (`__tests__/client-outbox.test.ts`, `history-backfill.test.ts`). WP6's module
singletons are the shell; the pure pieces are the core.
- ADOPTABLE: WP6 step 2's `publishSample`, `noteSensedRow`, `noteSelfTestResults` continue this only
  if they take values and return/record decisions, not `ws`. Costs, already named in the note: R7
  (per-row calls on ~200 streams — measure against `ws_data_flow_test` sample conservation) and G9
  (goldens sort keys, so a helper that rebuilds a payload can reorder keys unseen).
- Not recommended: a `ServerContext` object or DI container — DESIGN-WP6 §3.1 is right that one
  instance of everything plus live bindings is the honest model here, and D17(d) forbids
  single-user abstractions. Test isolation for singleton modules comes from M1 plus
  `vi.resetModules()` (https://vitest.dev/api/vi.html#vi-resetmodules) — and note vitest here runs vite
  8.1.5, whose TS transform is oxc; oxc follows TS's import elision by default (not verified in this
  repo), so a test's import list does not guarantee evaluation either.

**Routing.** Mainstream routers would keep our frozen 404-not-405 rule: Fastify/find-my-way answers
404 for a known path with the wrong method unless a plugin such as `fastify-405`
(https://github.com/Eomm/fastify-405) is added. That is reassurance, not a reason to adopt a
framework: Fastify/Express change headers (`content-length`, `X-Powered-By`, ETag), 404 bodies and
CORS handling, all frozen → PROPOSAL-only and not recommended. Between WP7's per-group
`handleXRequest(): Promise<boolean>` (precedent `video/routes.ts`) and a declarative
`[{method, path, handler}]` table: the table's only real gain is a machine-readable route list for
the DoD's "identical route table" diff and the "group never dispatched" risk (§8). ADOPTABLE middle
path, no product change: a vitest that drives `createAPIHandler` with a stub `res` for every
`(method, path)` in a checked-in list and asserts *which group answered* (not the body) — two users
(DoD diff, regression), no new runtime abstraction. Keep `if (await handleX(…)) return true;` inside
the single try (`api-server.ts` router `:390`ff); `return handleX(…)` unawaited turns a 500 into a
hang and `tsc` will not catch it — an ESLint `no-floating-promises`/`no-restricted-syntax` rule
(https://eslint.org/docs/latest/rules/no-restricted-syntax) can, mechanically.

**`sendJson` evaluation order** (DESIGN-WP7 §6.2 item 1). Node: `writeHead` commits the header
(`headersSent` true), a second `writeHead` throws `ERR_HTTP_HEADERS_SENT`
(https://nodejs.org/api/http.html#responsewriteheadstatuscode-statusmessage-headers). Frameworks
avoid the trap by serializing the handler's return value *before* touching the response (Fastify
`reply.send`, https://fastify.dev/docs/latest/Reference/Reply/). Two additions to the note:
- Even after the restriction, `video/routes.ts:38-41` `sendJson` calls `writeHead` **then**
  `JSON.stringify(body)`, so a stringify throw (BigInt, cycle, a throwing `toJSON`) still lands after
  the header, exactly as today. For the 50 eligible literal/local sites that cannot happen, so the
  restriction is sufficient; but a "stringify first" variant is ruled out because WP7 §5 requires the
  same body as `video/routes.ts`.
- ADOPTABLE: replace the hand-checked eligible-site list with an AST check — an ESLint
  `no-restricted-syntax` selector that rejects `CallExpression[callee.name='sendJson']` whose third
  argument contains a `CallExpression` or a non-optional `MemberExpression` on a non-literal. It
  encodes the eligibility rule so step-2 reviewers and later edits cannot drift from it.

---

## Summary table

| # | idea | status | touches |
|---|---|---|---|
| 1 | runtime import elision breaks R1/S2's textual guarantee; esbuild-order diff + bare imports | ADOPTABLE (check + bare imports) | WP6 §6.1 R1/§6.4.6, WP7 S2/§6.2.4, G12 |
| 2 | equal-period timer FIFO is Node internals; keep three `setInterval`s, no merged tick | ADOPTABLE (confirms design) | WP6 G11, R3 |
| 3 | three backpressure policies; control path unbounded | ADOPTABLE move verbatim; cap = PROPOSAL | WP6 `ws-clients`, `history`; G5 |
| 4 | subscription liveness watchdog | PROPOSAL (D-SUB) | `elodin-link`, registry, `lifecycle/reconnect.txt` |
| 5 | functional core exists; route-dispatch vitest; AST guard for `sendJson`/awaits | ADOPTABLE (tests/lint only) | WP6 step 2, WP7 §6.1/§6.2, H3 |

## Questions for the debate advocates

1. Is replacing an import that step 1 leaves unused with a bare `import './x.js'` an acceptable
   "move-only" edit, or must step 1 keep a used specifier in `server.ts` to pin the evaluation point?
2. Who owns the esbuild evaluation-order diff — WP6/WP7 per-commit checks, or C0 as a gate step next
   to `tsc --noEmit`? Should its listing be frozen as a file (a de-facto golden) or only diffed?
3. `legacy/state-actuators` (→ `state-csv/`) evaluating at import is the reason most of §1 matters.
   Should WP5's rename make its three maps lazy? (That moves its config read and log lines → it is a
   behaviour change, so: Parked, or accepted with G12 updated?)
4. D-SUB's watchdog needs "board is heartbeating" inside the subscription logic. Should WP6's layering
   (`board-status` and `elodin-link` as siblings) leave room for that now, or is designing for a
   parked fix a D17(d) violation?
5. Control-path cap (§3): terminate at N MB `bufferedAmount`, or keep the 30 s reaper as the only
   bound? What N would the stand's worst link (iPad on site Wi-Fi) tolerate during a connect burst
   plus backfill?
6. Should the route-dispatch vitest (§5) be a precondition for WP7 step 1, closing the "group never
   dispatched" risk before the moves instead of by review?
