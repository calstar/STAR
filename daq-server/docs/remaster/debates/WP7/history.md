> **History — superseded by [`../../DESIGN-WP7.md`](../../DESIGN-WP7.md)** (the "as decided"
> execution note, LEDGER D63: simplicity review round 1, with the D64 red-team and the security
> findings' ruling). Preserved **verbatim** below, moved out of `DESIGN-WP7.md` at `f13468e2`
> (the blob last changed at `0f665010`): the reviewed note's front matter with amendments B1-B4
> and the orchestrator's design-review decisions, §6.1's rules with the import-closure grep, §6.2
> as reviewed (import pruning and its startup-log diff, the 8-gate H8, the `sendJson` lists that
> missed line 622), §7's gaps as reviewed, the open questions, alternatives A/B/C, the
> walkthroughs (a)-(d) and the interfaces write-up. Line numbers in it are `api-server.ts` at
> `b2599617` (the same blob on `backend-remastered` today). Overridden since by D63: no
> import-closure grep (the esbuild module-order diff covers it, as D49(2) for WP6); no import
> pruning (the bare imports stay, labelled, as D49(8)); H4 is worth writing, not gating (WP5's
> `boardSlot` body is byte-identical to `elodinSlotFromBoardId`, so 2.2 is proven by a diff); the
> move-only check substitutes `SRC_DIR` for `__dirname` on the two candidate lines before
> comparing; the `sendJson` ineligible lists gain 622, 1208 and 1231, and 995 is non-adjacent
> (50 + 37 + 4 = 91 pairs, identified by content); a bare-import table per commit; a named
> cleanup commit for the dead `__dirname`; §4.2's note on the awaits before `req.on('data')`; and
> H8 widened to all 14 HTTP operator gates plus the two ungated OTA routes as a C0 package that
> gates step 1 (SEC-2/SEC-3/SEC-9 recorded as defects WP7 must not change). Where this file and
> `DESIGN-WP7.md` disagree, `DESIGN-WP7.md` wins.

# DESIGN-WP7 — history

There was no WP7 debate (the shape — per-group handler files under `src/api/` — was not
contested; see "Alternatives considered" below). The design-review decisions (D-a, D-b) are in
the front matter.


---

## Front matter: intro, baseline, prerequisites, amendments B1-B4, orchestrator decisions, contract

_Verbatim from `DESIGN-WP7.md` lines 3-56 at `f13468e2`._

Target-design note required by LEDGER D17(a) before the WP7 split. Design only: nothing here has
been executed. Paths are relative to `daq-server/diablo_server/backend/src/` unless stated.

**Baseline.** Line numbers are `api-server.ts` on `backend-remastered` @ `b2599617` (1269 lines).
WP7 runs after WP5 (which adds `boardSlot()` to `sensor-config.ts`) and may run in parallel with WP6;
WP5 does not edit this file, so these line numbers stay valid. Read with `DESIGN-WP6.md` §3.4: the
seam between the two is `createAPIHandler(opts)`.

**Prerequisites.** C1 merged on `backend-remastered`, and `npx tsc --noEmit` in
`diablo_server/backend/` added to `gate.sh` as a merge-gate step (orchestrator). WP5 merged (WP7
appends to WP5's `sensor-config.ts`).

**Amendments (design/ts2, 2026-11-16).** The deeper pass (alternatives, interface stubs,
walkthroughs — sections at the end), the research notes merged at 963e81b9 (LEDGER D42) and
STYLE.md (55d140ef, LEDGER D43) changed the following; each changed place is marked with its tag.
Rules are cited as `STYLE-S<n>`, `WP7-S1`, `WP6-R1`.

- **[B1]** WP7-S2's evaluation-order argument was textual. tsc/tsx/vitest elide an import whose
  specifiers are unused as values (`research/node-realtime-backend.md` §1; today `api-server.ts`
  already loses `elodin-query.ts` and `http` at runtime). When step 1 moves the last value user of
  `sessionManager`, `routes/config-profiles`, `ota-*`, … out of `api-server.ts`, those modules
  start evaluating from inside the first `api/*` file that uses them. WP7-S2 now adds the bare-import
  rule and the esbuild module-order diff (WP6-R1a/R1b, DESIGN-WP6 §6.3 item 6); never
  `verbatimModuleSyntax`.
- **[B2]** Walkthrough (d) found two owners of "where the live cubic store is":
  `routes/calibration-profiles.livePath()` (honours `DAQ_CALIBRATIONS_DIR`) and the four
  `__dirname`/`cwd` candidates of `GET /api/cubic_calibration` (ignore it — C5-5). Unifying them is
  the C5-5 fix, a behaviour change: **kept**, labelled at the site in cleanup (STYLE-S37), Parked.
- **[B3]** Research §5's route-dispatch vitest is adopted as gap **H9** (should, before step 1); its
  ESLint `no-restricted-syntax` guard for `sendJson` is not (STYLE-S40: no linter is tracked; a
  ~20-line grep check in the package's scripts encodes the same eligibility rule instead).
- **[B4]** STYLE conformance (D43): `SRC_DIR` from `import.meta.url` is allowed at module top level
  (STYLE-S30); in the move-only review, lines that only re-indent a moved body (`} else if (COND) {`
  → `if (COND) {` one level shallower) are expected non-dimmed lines (D43(6)); size targets are per
  WP (STYLE-S33). `api/*` and `server/*` never import each other (STYLE-S31).

**Orchestrator decisions (design review, 2026-11-16), recorded here:**

- D-a: route handlers live in `src/api/`, not `src/routes/` (accepted).
- D-b: `buildSensorConfig` and `SensorConfigEntry` go into the existing `sensor-config.ts`; WP7 runs
  after WP5 (accepted). The orchestrator amends BLOAT-MAP's WP7 file list.
- `npx tsc --noEmit` is a merge-gate step and a required check for every WP7 commit (§6.1).
- Step 2.3 (`isOperatorRequest` in `operators.ts`) is done only after both WP6 and WP7 have merged;
  the WS path keeps `authEmail` for `CONTROL_STATUS`.
- Step 1 (move-only) and step 2 (cleanup) are **separate queue items**, each fully gated.

**Contract (frozen, D5/D17).** Every path, method, status code, `Content-Type`,
`Content-Disposition`, the three CORS headers, JSON body shape and error text; first-match routing,
including that a known path with the wrong method is **404 `{"error":"Not found"}`, never 405**
(golden `PUT /api/config`, `DELETE /api/states`) — except `/api/feed-char/results`, which matches
every method and answers 405 itself; the two 404 shapes (bare 404 for non-`/api`, JSON for unknown
`/api/*`); the operator gate (`X-Auth-Email`); what each write does on disk and which callback it
fires, when; the exports `createAPIHandler` (server.ts, `config-profile-create-calibration.test.ts`)
and `buildSensorConfig` + `SensorConfigEntry` (`t7.test.ts`) from `./api-server.js`.


---

## §6.1 — rules S1-S4 (S2 with the import-closure grep and the per-commit bare-import rule), the commit table, the per-commit checks (import closure as item 3), the route-table, dispatch and move-only checks

_Verbatim from `DESIGN-WP7.md` lines 270-385 at `f13468e2`._

### 6.1 Step 1 — mechanical moves, no behaviour change

Rules:

- **S1 (route equivalence).** Each `else if (COND) { BODY }` of the ladder becomes, in its group,
  `if (COND) { BODY return true; }` with `COND` and `BODY` byte-identical. The group ends with
  `return false;`. This is exact because the ladder's predicates are pairwise disjoint: every one is
  an exact `pathname ===` test (with a method), except `startsWith('/api/video/')` (dispatched first,
  as today) and `startsWith('/api/sensors/')`, which no exact path in the ladder satisfies; the
  method-agnostic `/api/feed-char/results` is an exact path. So no request can match two branches,
  and group order cannot change which body runs. Groups are still dispatched in today's
  first-occurrence order: config, states, profiles, history, gui-config, board-logs, debug,
  calibration, feed-char, ota.
- **S2 (imports).** `api-server.ts` keeps all of today's import statements in step 1, in today's
  order (it is imported by `server.ts:35`, early, and pulls in `session-manager`, `routes/*`, `ota-*`
  — keeping its list keeps every module's evaluation order), and adds the new `./api/*.js` imports
  **after** all of them. Group modules import what their bodies use, and (import closure, DoD
  check) every module an `api/*` file imports must already be in `api-server.ts`'s import list, so
  no `api/*` import is ever the first import of anything:

  ```bash
  cd diablo_server/backend/src
  have=$(grep -oE "from '\./[^']+'" api-server.ts | sed "s/from '\.\///; s/'$//" | sort -u)
  need=$(grep -ohE "from '\.\./[^']+'" api/*.ts | sed "s/from '\.\.\///; s/'$//" | sort -u)
  comm -13 <(echo "$have") <(echo "$need")   # prints nothing
  ```

  (`api/*`'s `../../../shared/*` imports are compared the same way against `api-server.ts`'s
  `../../shared/*` list; `api/http.ts`, imported only by `api/*` and `api-server.ts`, is effect-free.)

  **[B1] Necessary, not sufficient.** The closure grep reads source text; the runtime evaluates only
  imports with a specifier used as a value. So, per commit: (a) an import in `api-server.ts` that
  the commit leaves with no value use becomes a bare `import './x.js';` **at the same position** — a
  move-only edit — but only for a module the order list below shows evaluating first at that line
  before the commit (never for `./elodin-query.js` or `http`, which are already elided today:
  a bare import would *add* them); (b) the esbuild module-order diff of DESIGN-WP6 §6.3 item 6
  (entry `src/server.ts`, which imports `api-server.ts`) must print nothing once `src/api/` entries
  are filtered out; (c) no `verbatimModuleSyntax`. Today's order through the router, from research
  §1: `api-server → routes/config-profiles → routes/script-check → session-manager → … → ota-build →
  ota-service-cmd → board-logs → video/*` — after step 1 the same list, with `api/*` entries
  interleaved.
- **S3 (`__dirname`).** The only `__dirname` user is `/api/cubic_calibration` (941-946). In
  `api/calibration.ts` define `const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');`
  and replace the two `path.join(__dirname, …)` candidates with `path.join(SRC_DIR, …)`, same
  strings. Do **not** move them unchanged: one level deeper, candidate 1 points at
  `diablo_server/scripts/…` (absent) and candidate 2 happens to hit the same file — identical output
  today by accident, invisible to the golden (H6).
- **S4 (options).** Each group destructures the `opts` members its bodies name, at its top, so
  bodies are unchanged.

| # | commit: create | cut from `api-server.ts` | notes |
|---|---|---|---|
| 1.1 | `api/http.ts` | 305-361 (types + `isConfigWriteAuthorized` + `readJsonBody`) | `api-server.ts` re-exports the three types |
| 1.2 | `sensor-config.ts` (append) | 47-303 | `api-server.ts`: `export { buildSensorConfig, type SensorConfigEntry } from './sensor-config.js';` — `t7.test.ts` unchanged. No import is added: `sensor-config.ts` already imports `readConfig` (`:6`) and `t7Channels` (`:7`), and `isCurrentLoopBoard` is defined there. The config characterization harness imports named functions from this file; adding exports does not change `config/golden/ts/` |
| 1.3 | `api/config.ts` | 394-507, 685-690 | |
| 1.4 | `api/states.ts` | 508-684 | |
| 1.5 | `api/profiles.ts` | 691-784 | |
| 1.6 | `api/history.ts` | 785-815, 849-877 | |
| 1.7 | `api/gui-config.ts` | 816-848 | imports `buildSensorConfig` from `../sensor-config.js` |
| 1.8 | `api/board-logs.ts` | 878-924 | the local `const history = getBoardLogHistory(…)` keeps its name (module-local; no clash) |
| 1.9 | `api/debug.ts` | 925-932, 1093-1096 | |
| 1.10 | `api/calibration.ts` | 933-998, 1056-1092 | S3 |
| 1.11 | `api/feed-char.ts` | 999-1055 | |
| 1.12 | `api/ota.ts` | 1097-1256 | the `MAX_BODY` constant and SSE closure move inside the body unchanged |

After 1.12 `api-server.ts` is the router (~90 lines): imports, re-exports, `createAPIHandler` with
363-393 verbatim (the `if (video && url.pathname.startsWith('/api/video/'))` guard kept verbatim,
first inside the try), ten `if (await handle…Request(req, res, url, opts)) return true;` lines,
1257-1267 verbatim.

**Checks for every commit** (no ports):

1. `npx tsc --noEmit` in `diablo_server/backend/` — exit 0 (required; merge-gate step).
2. Backend `npm test`, no failure outside `test/characterization/baseline_vitest_failures.txt`
   (`t7.test.ts`, `config-profile-create-calibration.test.ts` exercise the exports).
3. Import closure (S2) and the cycle grep (§8).
4. Route-table check, dispatch check and move-only check, below.

Under the stack lock, at the end of the step (and at most at one midpoint, within AGENT-RULES rule
7's hold limit): `pipeline/run.sh pt nocal boards` and `lifecycle/run.sh` (its `ota` golden drives
`POST /api/ota-flash`). `test_integration.sh` runs in the merge queue's full gate.

**Route-table check** (the WP's DoD "path+method list diff empty"):

```bash
cd daq-server/diablo_server/backend/src
routes() { grep -ohE "url\.pathname( === '[^']+'|\.startsWith\('[^']+'\))( && req\.method === '[A-Z]+')?" "$@" | sort; }
git show backend-remastered:./api-server.ts > /tmp/api-old.ts
diff <(routes /tmp/api-old.ts) <(routes api-server.ts api/*.ts)    # must print nothing
```

The route table cannot see a group that is never dispatched (its routes are still "in the table").
**Dispatch check:** every exported `handle\w+Request` of `api/*.ts` is called exactly once in
`api-server.ts`, in the form `if (await handleX(req, res, url, opts)) return true;`, on a line
between the router's `try {` and its `} catch`:

```bash
try_l=$(grep -n "^    try {" api-server.ts | head -1 | cut -d: -f1)
catch_l=$(grep -n "^    } catch (error: any) {" api-server.ts | head -1 | cut -d: -f1)
for f in $(grep -ohE "export async function handle[A-Za-z]+Request" api/*.ts | awk '{print $4}'); do
  hits=$(grep -n "if (await $f(req, res, url, opts)) return true;" api-server.ts | cut -d: -f1)
  [ "$(echo "$hits" | grep -c .)" = 1 ] && [ "$hits" -gt "$try_l" ] && [ "$hits" -lt "$catch_l" ] \
    || echo "BAD dispatch: $f"
done                                                                    # must print nothing
```

**Move-only check** (scripted; `--color-moved` is a review aid only): split today's ladder
(`api-server.ts` 394-1256 at `backend-remastered`) into branches at each line matching
`^      (} else )?if \(` at the ladder's indentation; for each branch take `COND` (the header without
the leading `} else `) and `BODY` (the lines up to the next header); strip leading whitespace from
every line. Every branch's `[COND] + BODY` must occur as one contiguous run of lines, after the same
stripping, in **exactly one** `api/*.ts` file (and nowhere twice). The only lines of an `api/*.ts`
file outside such runs may be imports, the handler's signature, its `opts` destructuring (S4), the
added `return true;` per branch, `return false;`, closing braces, and S3's `SRC_DIR` line plus its
two candidate lines. A ~40-line Python script; WP7 commits it with the package's checks (outside
`src/`).


---

## §6.2 — step 2 as reviewed (item 1 with the 8-gate H8 and the 50/19/16/3 `sendJson` lists; item 2 "after H4 exists"; item 4 import pruning with the 5 s startup-log diff; item 5)

_Verbatim from `DESIGN-WP7.md` lines 387-437 at `f13468e2`._

### 6.2 Step 2 — cleanup toward the target

1. **`sendJson` and `denyUnlessOperator`** in `api/http.ts`.

   `sendJson(res, status, body)` is **not** a pure refactor in general. Today `res.writeHead(...)`
   runs **before** the body expression of `res.end(JSON.stringify(<expr>))` is evaluated; if `<expr>`
   calls something that throws, the router's catch then fails on `writeHead(500)` (headers already
   sent) and the request hangs. With `sendJson`, `<expr>` is evaluated first, so the same throw
   becomes a clean 500 — a silent defect fix. So `sendJson` may replace **only** a pair whose body
   argument is built from literals and already-evaluated locals (optional-chained reads such as
   `error?.message` included), where nothing in the expression can throw. Eligible (today's line of
   the `res.end`; each is directly preceded by `res.writeHead(<n>, { 'Content-Type':
   'application/json' });`, checked mechanically):

   410, 441, 467, 498, 559, 584, 606, 634, 679, 707, 714, 723, 728, 753, 758, 768, 773, 783, 790,
   810, 822, 848, 854, 874, 890, 905, 919, 928, 932, 936, 968, 984, 1014, 1031, 1038, 1044, 1050,
   1055, 1063, 1073, 1084, 1096, 1100, 1105, 1181, 1188, 1197, 1221, 1249, 1259 (50 sites).

   **Not eligible, keep the raw pair:**
   - the body calls a function after `writeHead`: 398, 404, 426, 690, 695, 720, 750, 765, 780,
     860, 894, 963, 977, 981, 995, 1059, 1069, 1080, 1092;
   - the body reads a property of a local without `?.` (it throws if the local is
     `null`/`undefined`, e.g. a thrown non-Error): 445, 459, 505, 562, 577, 613, 627, 651, 658, 666,
     682, 814, 834, 922, 1254, 1264;
   - not an adjacent pair: 955, 958, 997 (`writeHead` sits before an `if` or `try`);
   - not JSON or not that header set: the CSV, text, SSE and `Content-Disposition` responses.

   `denyUnlessOperator(req, res)` replaces the 14 identical
   `if (!isConfigWriteAuthorized(req)) { 403 …; return true; }` blocks (their bodies are literals).
   **Before 2.1** the 8 gates no golden covers yet get a viewer-403 line (H8): today only
   `http.txt` 1413 (`/api/config`), 1420 (`/import`), 1427 (`/state-csv`), 1462 (`profiles/switch`),
   1504 (`board-log-mode`) and 1539 (`calibration_profiles/save`) are covered.
2. **Slot rule** (after H4 exists): `elodinSlotFromBoardId` (96-100, now in `sensor-config.ts`) →
   WP5's `boardSlot()`. Equivalent for every number; `asBoardId` still guarantees one.
3. **One identity rule — after both WP6 and WP7 have merged** (decision): `isConfigWriteAuthorized`
   (345-348) and the WS control path (`server.ts:978-979`) compute the same thing. Move it to
   `operators.ts` as `isOperatorRequest(headers)` used by both. The WS path still computes and keeps
   `authEmail`, which `CONTROL_STATUS` sends (`email: authEmail || null`). Same result for every
   header value.
4. **Prune `api-server.ts`'s imports** to what the router uses. **Never drop a module with
   import-time effects** (`session-manager.ts`, `legacy/state-actuators.ts` / `state-csv/`, anything
   that reads config, logs or constructs a singleton at import) unless another import still
   evaluates it at the same point. **[B1]** Pruning a specifier is free (an unused specifier is
   already absent at runtime); deleting a bare import made in step 1 is not — keep them, and gate
   on the module-order diff as well as the log diff below. The check: diff the first 60 lines of `backend.log` (a 5 s
   backend-only start under the stack lock, as DESIGN-WP6 §6.3 item 5) before and after; any
   difference beyond timestamps and PIDs fails the commit.
Step 2 is its own queue item, gated in full like step 1.

5. Not in WP7 (Parked): unifying body reading, removing the never-wired `getQueryClient` /
   `getCalibrationStatus` options, renaming `routes/`.


---

## §7 — the gap table and H1-H9 as reviewed (H8 as the 8 unfrozen gates, gating 2.1; H4 gating 2.2)

_Verbatim from `DESIGN-WP7.md` lines 474-533 at `f13468e2`._

### Gaps — a move could change these and no golden would notice

H1-H3, H5 and H8 belong in `test/characterization/pipeline/` (C0-owned); H4 is pure-function
characterization (D20 allows white-box for pure functions with a stable signature).

| gap | priority (orchestrator) | must exist before |
|---|---|---|
| H1, H2 | MUST | step 1 (H2's `flash-all` only against a config with no enabled boards) |
| H8 | MUST | step 2.1 (`denyUnlessOperator`) |
| H4 | should | step 2.2, including negative and non-integer `board_id`s |
| H3 | should, only if `sendJson` survives review | step 2.1 |
| H5 | nice-to-have | — |
| H6, H7 | accepted as documented | — |
| H9 [B3] | should | step 1 |

- **H1 Success paths of the writes and their callbacks.** Only error shapes are frozen for
  `POST /api/config`, `/api/config/import`, `/api/state-csv`, `/api/state-script`,
  `profiles/switch|rename|delete`, `calibration_profiles/save`; `profiles/create` has a vitest.
  Add, idle, as the operator: each write's status/body, the file it changed (normalised), and the WS
  frames that follow (`config_updated`, `board_status_update`). Include import with an invalid TOML
  (400 + rollback: the profile file is unchanged). Shared with WP6's G7.
- **H2 Routes no request ever reaches.** `POST /api/calibration_profiles/load`,
  `POST /api/calibration_profiles/new_blank` and `POST /api/ota-flash/flash-all` appear in no golden,
  so a misrouted or dropped branch would go unnoticed (the route-table check in §6.1 is static
  only). Add `load` and `new_blank` as the viewer (403, no side effect). `flash-all` has **no
  operator gate** and would flash every enabled board; freeze it only against a config with no
  enabled boards (`200 {"success":false,"message":"No enabled boards in config"}`), never against
  the pipeline fixture.
- **H3 Malformed JSON bodies.** Not sent anywhere. Freeze one per style: a `readJsonBody` route that
  answers 500 (`ball_valve_cal`), one that answers 400 (`profiles/rename`), and one hand-parsed route
  (`board-log-mode`, 400 with V8's message — normalise to the error class, as the calibration harness
  does for `JSON.parse`).
- **H4 Slot 0 → 10 in `buildSensorConfig`.** No golden has a PT/TC/RTD/LC board with
  `board_id % 10 == 0` (the boards session's sensor list is PT1, PT2, TC1, RTD1, LC2, T71). Freeze
  `buildSensorConfig` for an injected config with board_ids 10, 20, 21, two RTD and two LC boards
  without roles (`generatedRole` multi-board names), a disabled board, a non-numeric `board_id`
  (`asBoardId` fallbacks 1/51/31/41), negative (`-21`) and non-integer (`21.5`) board_ids, and T7
  channels — before step 2.2.
- **H5 `PUT /api/feed-char/results` during a session (405)**: the no-session 409 (`POST`, `PUT`),
  the in-session `GET` (200, `results: []`) and `POST` (500 `ENOENT`, mock mode) are frozen; the
  405 branch is not.
- **H8 The 8 operator gates without a viewer-403 line**: `POST /api/state-script`,
  `POST /api/config/profiles/create`, `…/rename`, `…/delete`, `POST /api/ball_valve_cal`,
  `POST /api/feed-char/results`, `POST /api/calibration_profiles/load`, `…/new_blank`. Freeze each
  as the viewer (403, no side effect). The `feed-char` one must run **during a session**: without
  one the route answers 409 before it reaches the gate.
- **H6 `cubic_calibration` candidate order** cannot be observed (§6.1 S3); prescribed rather than
  tested.
- **H9 Every route is dispatched** [B3] (`research/node-realtime-backend.md` §5). A backend vitest
  that drives `createAPIHandler` with a temp-dir `CONFIG_PATH` (no enabled boards), a viewer
  `X-Auth-Email` and an empty or invalid body, for every `(method, path)` of a checked-in list
  generated from the route-table check, and asserts the answer is **not** the router's
  `404 {"error":"Not found"}` (and, for `/api/video/*`, that the video branch answered). Viewer
  identity makes every gated write a 403 with no side effect; the ungated OTA routes answer 400
  (missing ip) and, for `flash-all`, `200 {"success":false,"message":"No enabled boards in config"}`
  — the same safe cases as H2. It closes "a group is never dispatched" before the moves instead of
  by the static dispatch check alone, and it imports `api-server.ts` with no stack (no port).
- **H7 SSE headers and framing** of `flash-all` — covered by H2's no-boards case only for the JSON
  branch; the SSE branch stays unguarded (cannot be exercised safely on a shared machine without a
  fake `ota_service`; lifecycle's fake board could host it later).


---

## Open questions, alternatives considered, walkthroughs, interfaces, STYLE conformance (to the end of the note)

_Verbatim from `DESIGN-WP7.md` lines 584-771 at `f13468e2`._

## Open questions

Q1 and Q2 are settled by the orchestrator's decisions at the top of this note (D-b, D-a); Q3 by the
gap priority table in §7; Q4 by the decision that step 2.3 waits until both WP6 and WP7 have merged.

- **Q1** `buildSensorConfig` into the existing `sensor-config.ts` (this note) or a new
  `sensor-config-build.ts` (the WP table)?
- **Q2** `src/api/` (this note) instead of handlers under `src/routes/` (the WP table)?
- **Q3** H1-H3, H5 are characterization tests (C0-owned): before WP7 starts, or before the commit
  that moves each group?
- **Q4** Step 2.3 (one identity rule in `operators.ts`) touches both WP6's and WP7's files; which
  package does it, after both have merged?

---

## Alternatives considered (design/ts2, 2026-11-16)

### A. Per-group handler files, one `handle<Group>Request` each (§2 — chosen)

Eleven `api/*.ts` modules plus `api/http.ts`; the router calls each group in a fixed order inside
its one try; a group answers `true` or `false`. Precedent: `video/routes.ts` `handleVideoRequest`.

### B. A declarative route table

`api-server.ts` holds `const ROUTES: Route[] = [{ method: 'GET', path: '/api/config', handler:
getConfig }, …]` (≈60 entries) and dispatches on the first match; each branch body becomes a named
handler `(req, res, url, opts) => Promise<void>`; the 404 is "no row matched".

### C. Keep one file; extract only the helpers

`buildSensorConfig` and its helpers to `sensor-config.ts`, the types and request helpers to
`api/http.ts`, the OTA block (160 lines) to `api/ota.ts`; the ladder stays in `api-server.ts`
(≈800 lines).

### Comparison

| | A (chosen) | B route table | C helpers only |
|---|---|---|---|
| clarity | a resource's routes are one file named for it; the router is ~90 lines and reads as the dispatch order | the table is the best route index (one line per route, method and path side by side); the bodies scatter into ≈60 named functions whose names add nothing over their paths | the 700-line ladder stays the place to read; above STYLE-S33's god-file line |
| lines (net, steps 1+2) | step 1 ≈ +120 (per-group imports, signatures, `return true`); step 2 ≈ −90 (`sendJson` on 50 sites, `denyUnlessOperator` on 14) | ≈ +60 over A (table rows, a `Route` type, per-handler signatures) | ≈ 0 (moves only) |
| move-only feasibility (WP7-S1) | exact: each `else if (COND) { BODY }` becomes `if (COND) { BODY return true; }`, COND and BODY byte-identical, checked by the scripted move-only check | **no**: COND does not map to `{method, path}` for three branches (the method-agnostic `/api/feed-char/results`, the prefix `/api/sensors/`, the `video &&` guard), and every body changes its exit (`return true` inside nested callbacks becomes `return`) | exact, but only for the few moved blocks |
| testability | each group importable without effects (STYLE-S30); H9 drives the whole router | the table is data a test can enumerate — its one real gain; research §5 notes the same gain is had by H9 without a runtime abstraction | as today |
| fit with characterization boundaries | goldens are black-box HTTP (`pipeline/golden/http.txt`, `boards/`, `nocal/`, `lifecycle/golden/ota.txt`); the path-coupled tests are `t7.test.ts` and `config-profile-create-calibration.test.ts`, which import `./api-server.js` — kept by re-exports; `routes/*.ts` (imported by `config/ts_dump.ts`, `calibration/ts_harness.mts`) untouched | same goldens; the same re-exports | same |
| risk to the frozen contract | low: first-match order is irrelevant because the predicates are pairwise disjoint (WP7-S1), CORS and the single try stay in the router (§4.2), the 404-not-405 rule is the fall-through | medium: a table matcher must reproduce 404-not-405, the method-agnostic 405 of feed-char, and that `/api/video/*` is skipped when `video` is unset; each is a new line of matcher logic that no golden reads directly | none, but the WP's goal (router only) is not met |

**Why A.** It is the only shape that is move-only for every branch and still ends with a router
small enough to read. **B lost** on WP7-S1 (three branches have no `{method, path}` form, and every
body's exit changes) and adds a `Route` type with one user (STYLE-S34); its one gain — a
machine-readable route list — is obtained by H9 and the route-table check without a runtime
abstraction (`research/node-realtime-backend.md` §5 reaches the same verdict, and notes that
Fastify-style routers would also keep 404-not-405, which is reassurance, not a reason to adopt a
framework). **C lost** on the WP's goal and on STYLE-S33.

**Module list unchanged.** The deeper pass amends the reviewed design in places — [B1]-[B4] at
the top (elided imports and bare imports, the kept two-owner cubic-store path, gap H9 and a grep
check instead of ESLint, STYLE conformance); each is marked where it lands.

---

## Walkthroughs (design/ts2, 2026-11-16)

WP7's modules are on the HTTP side only. The WS command path (fire, abort) never enters them; the
walkthroughs below trace what the HTTP side does around each flow and where it hands over to the
WS side, which is only ever through an `APIHandlerOptions` callback built by `server.ts`
(STYLE-S31).

### (a) Around a fire command

1. Before the operator can press Fire, the GUI loads the state panel: `GET /api/states` →
   `server.ts` HTTP handler → **`api-server`** (prefix, CORS, URL) → **`api/states.handleStatesRequest`**
   reads the **active profile**'s `[[states]]` (and `[flow]`) and answers. One owner.
2. The GUI may poll `GET /api/engine_state` → **`api/debug`** → `opts.getEngineState()` →
   `engine-state.currentState` (WP6). The option is the seam; `engine-state` owns the value.
3. The fire command itself is WS (DESIGN-WP6 walkthrough (a)); WP7 is not on it.
4. Editing a dynamic state's script before a run: `POST /api/state-script/check` (no gate, no
   write) and `POST /api/state-script` (operator gate, `checkStateScript` then save) →
   **`api/states`**; the sequencer reads scripts at the next session start. One owner.

Finding (observation, frozen): `/api/states` serves the **active profile** while
`engine-state` resolves ids against the **deployed** config (§6.3 already lists it). During a
session with an unsaved-to-deploy draft the panel and the sequencer can disagree on a state's name;
the sequencer refuses unknown names and the backend rejects undeclared ids, so the failure is a
refusal, not a wrong state. Not two owners of one step: two documents by design.

### (b) Around an abort

1. The abort buttons come from the same `GET /api/states` (`isAbort` from the config); step (a) 1.
2. Abort thresholds live in the config document: edited through `POST /api/config` (walkthrough
   (c) below) and regenerated by `calibration_service` into `abort_thresholds.txt` (not WP7's).
3. The operator gate. HTTP writes check `X-Auth-Email` in **`api/http.isConfigWriteAuthorized`**;
   the WS control path checks the same header in **`ws-connection`** (WP6). *Two owners of one
   identity rule* — already scheduled: step 2.3 moves it to `operators.isOperatorRequest(headers)`
   after both WP6 and WP7 have merged. The abort itself needs the WS arming, not the HTTP rule.

### (c) A board-status change through HTTP

1. The operator enables a board in the config editor: `POST /api/config` → **`api-server`** →
   **`api/config.handleConfigRequest`**: operator gate (403 before the body), body collected in
   `req.on('end')`, PWM check (400), `writeActiveProfile`, and — only when no session is active —
   `deployActiveProfile()` and `setImmediate(onConfigUpdated)`. The response is written before the
   callback runs (STYLE-S29).
2. `onConfigUpdated` is `server.ts`'s `applyDeployedConfigChange()` (WP6): GUI stream, calibration
   entity map, hot-path caches, state-actuator map, then **`board-status.loadBoardsFromConfig()`**
   and `broadcastBoardStatus()`, then `config_updated` to every browser. Owners: `api/config` for
   the write and the deferral; `server.ts` for the reload sequence; `board-status` for the list.
3. During a session the same request is a draft: saved to the profile, not deployed, no callback;
   the board appears at the next session start, when `sessionManager.start` deploys and calls the
   same `applyDeployedConfigChange` (the C5-1 flash). One deploy function
   (`routes/config-profiles.deployActiveProfile`), two triggers.
4. A board's log verbosity: `POST /api/board-log-mode` → **`api/board-logs`** → `patchBoardField`
   writes `config.toml` and the profile directly, even during a session, and fires **no** callback
   (`config_broadcast_service` re-reads the file). `GET /api/board-logs` reads the ring
   `board-logs.ts` fills from daq_bridge's UDP forwarder. One owner each.

No step with zero or two owners.

### (d) A calibration save via HTTP

1. `POST /api/calibration_profiles/save` → **`api-server`** → **`api/calibration.handleCalibrationRequest`**.
2. Operator gate: `denyUnlessOperator(req, res)` (**`api/http`**, step 2.1) writes the literal 403.
3. Body: `readJsonBody(req)` (**`api/http`**). Malformed JSON rejects into the router's catch → 500
   `{"error":"Invalid JSON body"}` (frozen; H3).
4. `saveCalibrationProfile(name)` — **`routes/calibration-profiles`** owns the store: it copies
   `livePath()` (`cubic_calibration.json` under `getCalibrationsDir()`, which is `DAQ_CALIBRATIONS_DIR`
   when set)
   into `profiles/<name>.json`. A throw (bad name) → router catch → 500 `{"error": message}`.
5. 200 with `listCalibrationProfiles()` — a function call in the body, so **not** `sendJson`
   eligible (§6.2 item 1): the raw `writeHead`/`end` pair stays.
6. `…/load` and `…/new_blank` swap the live store and then call `opts.onCalibrationReload()`
   **synchronously, before** the response (STYLE-S29) → `server.ts` → `publishCalibrationReload`
   → Elodin cmd 7 (DESIGN-WP6 walkthrough (d)). `calibration_service` re-reads the store.
7. `GET /api/cubic_calibration` shows the result: **`api/calibration`** reads the live store from
   its own four candidates (WP7-S3's `SRC_DIR`).

Finding **[B2]**: steps 4 and 7 have **two owners of "where the live cubic store is"** —
`livePath()` honours `DAQ_CALIBRATIONS_DIR`, the GET's candidates do not (C5-5: with the variable
set, the panel shows a different file from the one a save copies). Moving the GET onto `livePath()`
is the C5-5 fix and changes what the GET returns under that variable: not done in WP7 (STYLE-S8);
labelled `// Kept: C5-5 (D17)` at the candidates in step 2 (STYLE-S12, S37) and Parked for the team.

### Summary of ownership findings

| step | owners | disposition |
|---|---|---|
| (b) 3 operator identity rule | `api/http` + `ws-connection` | step 2.3 (after WP6 and WP7) |
| (d) 4/7 live cubic store path | `routes/calibration-profiles.livePath` + `api/calibration` | **kept** (C5-5), labelled, Parked [B2] |
| (a) 1 states list vs id resolution | active profile vs deployed config | by design, frozen; observation |

---

## Interfaces (design/ts2, 2026-11-16)

Stubs in `docs/remaster/design-stubs/ts/src/` (how they are type-checked, and that nothing imports
them: DESIGN-WP6 "Interfaces"). Each opens with the STYLE-S36 header: what it owns, what it must not
know about, contract surfaces with their goldens, import-time effects; each group's handler doc
lists its routes with their gates, error paths and callbacks.

| stub | public surface |
|---|---|
| `api/http.ts` | `BoardScanRateHz`, `DebugInfo`, `APIHandlerOptions` (verbatim, with which options are never passed), `isConfigWriteAuthorized`, `readJsonBody`; step 2.1: `sendJson` (restricted to the 50 listed sites), `denyUnlessOperator` |
| `api/config.ts` … `api/ota.ts` (10 groups) | one `handle<Group>Request(req, res, url, opts): Promise<boolean>` each |
| `api-server.ts` | `createAPIHandler(opts?)`; re-exports `buildSensorConfig`, `SensorConfigEntry` (from `sensor-config.ts`), `APIHandlerOptions`, `BoardScanRateHz`, `DebugInfo` (from `api/http.ts`) |
| `sensor-config.ts` (delta) | `SensorConfigEntry`, `buildSensorConfig(config?)` (WP7 1.2), beside WP5's `boardSlot` |

What writing them confirmed or changed:

- The route-group signature stays documentation only (WP7 §2): eleven modules share it, but a
  declared `RouteHandler` type would be a callback type no code consumes generically (STYLE-S34).
- `sendJson`'s body is fixed as `video/routes.ts:38`'s (`writeHead` before `JSON.stringify`), so even
  inside the eligible list a `stringify` throw lands after the header exactly as today
  (research `node-realtime-backend.md` §5); the restriction, not the helper, carries the safety.
- `api/history.ts` keeps `ElodinQueryClient` type-only: it is elided at runtime today and must
  stay elided ([B1]).
- `api/calibration.ts` owns `SRC_DIR` from `import.meta.url` (STYLE-S30, D43(7)).

### STYLE.md conformance (55d140ef; LEDGER D43)

Applied: STYLE-S5 (`api/` = HTTP route handlers, `routes/` = domain libraries the harnesses import
by path, untouched); S6 (`handle<Group>Request`); S7 (every URL, header, text and filename kept,
including the mixed `snake_case`/`kebab-case` paths); S8/S10 (every frozen failure mode listed in
the handlers' docs: the 500-vs-400 malformed-JSON split, the hang paths, the ungated OTA routes,
the 503 stubs); S12/S37 (`// Kept: C5-5 (D17)` at the cubic store candidates in step 2, [B2]); S28
(every group call awaited inside the one try); S29 (`setImmediate` deferral vs synchronous
`onCalibrationReload`); S30, S31, S34, S36, S40 as for WP6.

**Choices that need the orchestrator's check against STYLE:** none beyond DESIGN-WP6's list; the
`sendJson` eligibility is enforced by a grep script rather than ESLint (STYLE-S40: no linter) —
confirm that a ~20-line check script in the package (outside `src/`) is acceptable.
