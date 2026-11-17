# DESIGN-WP7 — split `diablo_server/backend/src/api-server.ts`

The WP7 design as decided (LEDGER D39, D40, D42-D44, the simplicity rulings of D63, the D64
red-team and the security findings' ruling). It says what an implementer must do and why. Design
only: nothing here has been executed. Paths are relative to `daq-server/diablo_server/backend/src/`
unless stated. How the design got here — the amendments B1-B4, the import-closure grep, the
import-pruning item, the open questions, the alternatives, the walkthroughs, the interfaces
write-up — is in `debates/WP7/history.md`.

**Baseline.** Line numbers are `api-server.ts` on `backend-remastered` @ `b2599617` (1269 lines; the
same blob at `f13468e2`), re-verified against
`git show backend-remastered:daq-server/diablo_server/backend/src/api-server.ts`. WP7 runs after WP5
(which adds `boardSlot()` to `sensor-config.ts` and renames `legacy/` → `state-csv/`) and may run in
parallel with WP6; WP5 does not edit this file, so these line numbers stay valid. The seam between
WP6 and WP7 is `createAPIHandler(opts)` (DESIGN-WP6 §2 import edges, §3.1).

**Prerequisites.** C1 and WP5 merged on `backend-remastered`; `npx tsc --noEmit` in
`diablo_server/backend/` is a merge-gate step (D40) and a required check for every WP7 commit; the
gaps of §7 that guard a step exist before it — in particular the operator-gate package (H8, widened
by the security ruling) before step 1.

**Contract (frozen, D5/D17).** Every path, method, status code, `Content-Type`,
`Content-Disposition`, the three CORS headers, JSON body shape and error text; first-match routing,
including that a known path with the wrong method is **404 `{"error":"Not found"}`, never 405**
(golden `PUT /api/config`, `DELETE /api/states`) — except `/api/feed-char/results`, which matches
every method and answers 405 itself; the two 404 shapes (bare 404 for non-`/api`, JSON for unknown
`/api/*`); the operator gate (`X-Auth-Email`) on exactly the 14 routes that have it today and its
absence on the two OTA routes (SEC-2); what each write does on disk and which callback it fires,
when; the exports `createAPIHandler` (server.ts, `config-profile-create-calibration.test.ts`) and
`buildSensorConfig` + `SensorConfigEntry` (`t7.test.ts`) from `./api-server.js`.

**Shape.** The 860-line route ladder is cut into ten route-group modules under `src/api/`, one
`handle<Group>Request` each, plus `api/http.ts` for what they share; `buildSensorConfig` goes to
the existing `sensor-config.ts`; `api-server.ts` is left as the router (~90 lines). Step 1 moves
code only; step 2 is a short list of cleanups. They are **separate queue items, each fully gated**.
Route handlers live in `src/api/`, not `src/routes/` (D-a); `buildSensorConfig` goes into the
existing `sensor-config.ts` (D-b); step 2.3 waits until both WP6 and WP7 have merged.

---

## 1. Current responsibilities

`api-server.ts` is not a server: `createAPIHandler(opts)` returns the handler `server.ts:888`
awaits for every request that is not `/stats`. It owns every `/api/*` path except `/api/video/*`,
which it hands to `video/routes.ts`.

### 1.1 What lives where

| lines | part | what it does |
|---|---|---|
| 1-14 | header | imports, and an explicit `__dirname` (14) for the dist layout |
| 15-45 | imports | 18 modules, notably `routes/config.js`, `routes/config-profiles.js`, `routes/calibration-profiles.js`, `routes/script-check.js` (domain libraries despite the directory name), `session-manager.js`, `ota-*.js`, `video/routes.js` |
| 47-71 | `SensorConfigEntry` | the `/api/sensor-config` row type (exported) |
| 73-100 | helpers | `enabledBoardCount`, `generatedRole`, `asBoardId`, `elodinSlotFromBoardId` (**a copy of the slot rule**, 96-100) |
| 102-303 | `buildSensorConfig(config = readConfig())` | config → sorted sensor list: PT (107-148), TC (150-180), RTD (182-227), LC (229-274), LabJack T7 (276-294), sort (296-300). Exported; pure when a config is passed |
| 305-337 | types | `BoardScanRateHz`, `DebugInfo`, `APIHandlerOptions` (8 optional members) |
| 339-361 | request helpers | `isConfigWriteAuthorized(req)` (empty header → operator, else allowlist), `readJsonBody(req)` (rejects `Invalid JSON body`) |
| 363-386 | router prelude | `createAPIHandler`: destructure options; non-`/api/` → `false`; set CORS on every `/api/*` response; `OPTIONS` → 200 empty; parse `URL` |
| 388-393 | video | `/api/video/*` → `handleVideoRequest` (only when `opts.video` is set) |
| 394-507 | config | `GET /api/config` (active profile), `GET /api/config/running`, `POST /api/config` (403 gate, PWM check → 400, save profile, deploy when idle, `setImmediate(onConfigUpdated)`), `GET /api/config/export`, `POST /api/config/import` (403, write, parse, PWM check, rollback on error, deploy when idle) |
| 508-684 | states | `GET /api/states` (+ `[flow]`), `GET`/`POST /api/state-csv` (deploy when idle → `setImmediate(onStateCsvUpdated)`), `GET`/`POST /api/state-script` (checked by `checkStateScript` before save), `POST /api/state-script/check` (no gate, SEC-9) |
| 685-690 | config | `GET /api/config/validate` |
| 691-784 | profiles | `GET /api/config/profiles` (calls `ensureSeeded()` — a GET that may write), `POST …/switch` (409 during a session, `setImmediate(onConfigUpdated)`), `…/create` (with optional calibration profile, rolled back if the config create fails), `…/rename`, `…/delete` |
| 785-815 | history | `GET /api/query` → 503 without `getQueryClient` |
| 816-848 | GUI config | `GET /api/pressure-limits`, `GET /api/gui-config` (deployed-config cache), `GET /api/sensor-config` (`buildSensorConfig()`) |
| 849-877 | history | `GET /api/sensors` (503 without a query client), `GET /api/sensors/<entity>` (placeholder) |
| 878-924 | board logs | `GET /api/board-logs`, `GET /api/board-logs/stats`, `POST /api/board-log-mode` (403, validate, `patchBoardField`) |
| 925-932 | debug | `GET /api/debug` (`getDebugInfo`), `GET /api/engine_state` (`getEngineState`) |
| 933-998 | calibration | `GET /api/calibration_status` (no provider → error object), `GET /api/cubic_calibration` (**`__dirname`-relative** candidates, 941-946), `GET`/`POST /api/ball_valve_cal`, `GET /api/lc_tare` |
| 999-1055 | feed characterization | `/api/feed-char/results`: no session → 409 (any method); `GET` reads the run's JSONL; `POST` (403 gate) appends; else 405 |
| 1056-1092 | calibration profiles | `GET /api/calibration_profiles`, `POST …/save`, `…/load` (`onCalibrationReload`), `…/new_blank` (`onCalibrationReload`) |
| 1093-1096 | stub | `GET /api/config_packets` → `{packets: []}` |
| 1097-1256 | OTA | `GET /api/ota-flash/projects`, `POST /api/ota-flash/flash-all` (Server-Sent Events, sequential `otaBuildFlash` per enabled board; **no gate**, SEC-2), `POST /api/ota-flash` (4 MB cap, `projectPath` build+flash or base64 file flash through a temp dir; **no gate**, SEC-2; the caller's `projectPath` reaches `pio run`, SEC-3) |
| 1257-1260 | fallthrough | 404 `{"error":"Not found"}` |
| 1261-1265 | catch-all | 500 `{"error": <message>}`, logged `API error:` |
| 1267 | | `return true` |

The 14 operator gates (`if (!isConfigWriteAuthorized(req)) {`, each writing the literal 403):
408 `POST /api/config`, 465 `POST /api/config/import`, 582 `POST /api/state-csv`, 632
`POST /api/state-script`, 705 `profiles/switch`, 726 `…/create`, 756 `…/rename`, 771 `…/delete`,
903 `POST /api/board-log-mode`, 966 `POST /api/ball_valve_cal`, 1036 `POST /api/feed-char/results`,
1061 `calibration_profiles/save`, 1071 `…/load`, 1082 `…/new_blank`. Today's goldens freeze a
viewer 403 on six of them (`http.txt` 1414, 1421, 1428, 1463, 1505, 1540); §7 H8 freezes all 14.

### 1.2 Shared mutable state

The file holds **no mutable module state**. Everything it reads or writes belongs to someone else:

| state | owner | read by | written by |
|---|---|---|---|
| options closures (`getEngineState`, `getDebugInfo`, `onConfigUpdated`, `onStateCsvUpdated`, `onCalibrationReload`, `video`) | `server.ts` (built once, `server.ts:784-829`) | debug, config, states, profiles, calibration routes | — |
| `getQueryClient`, `getCalibrationStatus` | **never passed** by `server.ts` | `/api/query`, `/api/sensors` → always 503; `/api/calibration_status` → always the error object (frozen in `http.txt`) | — |
| session status | `sessionManager` (singleton) | config save/import, state-csv, state-script, profiles, feed-char (`dbDir`) | — |
| active profile, `config.toml`, state CSVs, scripts | `routes/config-profiles.ts`, `routes/config.ts` (files) | GET routes | config, import, state-csv, state-script, profiles, board-log-mode |
| calibration profiles and the live store | `routes/calibration-profiles.ts` (files) | `GET /api/calibration_profiles` | save, load, new_blank, profiles/create |
| `cubic_calibration.json` | `calibration_service` (sole writer) | `/api/cubic_calibration` | — |
| ball-valve endpoints, live position | `ball-valve-cal.ts` | `/api/ball_valve_cal` | `POST /api/ball_valve_cal` |
| LC tares | `lc-tare.ts` (file) | `/api/lc_tare` | — |
| board-log ring, counters | `board-logs.ts` | board-logs routes | — |
| run directory `feed_characterization.jsonl` | the session's `dbDir` | `GET` | `POST` (append) |
| OTA temp dirs | `os.tmpdir()/diablo-ota-*` | — | `POST /api/ota-flash` (removed in `finally`) |

The only cross-request ordering inside the file is the `setImmediate` deferral of the three
callbacks: the response is written first, the callback (→ WS `CONFIG_UPDATED`) runs after.

---

## 2. Target module boundaries

New directory `src/api/`, mirroring the precedent `video/routes.ts` (`handleVideoRequest`). Each
route-group module exports one handler with the same signature, returning `true` if it answered.

```ts
type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL,
                     opts: APIHandlerOptions) => Promise<boolean>;
```

(That type is documentation; nothing new needs to be declared beyond `APIHandlerOptions` —
STYLE-S34.)

| module | single responsibility | public interface | routes (today's lines) |
|---|---|---|---|
| `api-server.ts` | the router: `/api` prefix, CORS, `OPTIONS`, URL parse, dispatch in a fixed order, 404, the catch-all 500 | `createAPIHandler(opts)`; re-exports `buildSensorConfig`, `SensorConfigEntry`, `APIHandlerOptions`, `DebugInfo`, `BoardScanRateHz` | 363-393, 1257-1267 |
| `api/http.ts` | what every route group shares about HTTP | `APIHandlerOptions`, `DebugInfo`, `BoardScanRateHz`, `isConfigWriteAuthorized(req)`, `readJsonBody(req)`; step 2 adds `sendJson(res, status, body)` and `denyUnlessOperator(req, res)` | 305-361 |
| `api/config.ts` | the editor's config document: read, save, export, import, validate | `handleConfigRequest` | 394-507, 685-690 |
| `api/profiles.ts` | named config profiles | `handleProfilesRequest` | 691-784 |
| `api/states.ts` | the state machine as files: state list, state CSVs, dynamic-state scripts | `handleStatesRequest` | 508-684 |
| `api/history.ts` | Elodin historical queries (all three depend on `getQueryClient`) | `handleHistoryRequest` | 785-815, 849-877 |
| `api/gui-config.ts` | deployed config as the GUI lays it out | `handleGuiConfigRequest` | 816-848 |
| `api/board-logs.ts` | board diagnostic logs and their verbosity | `handleBoardLogsRequest` | 878-924 |
| `api/debug.ts` | diagnostics and the legacy stub | `handleDebugRequest` | 925-932, 1093-1096 |
| `api/calibration.ts` | calibration as files and live state: status, cubic store, ball-valve endpoints, LC tares, calibration profiles | `handleCalibrationRequest` | 933-998, 1056-1092 |
| `api/feed-char.ts` | feed-characterization results stored with the run | `handleFeedCharRequest` | 999-1055 |
| `api/ota.ts` | firmware projects and over-the-air flashing | `handleOtaRequest` | 1097-1256 |
| `sensor-config.ts` (existing) | sensors as config declares them — gains `buildSensorConfig`, `SensorConfigEntry` and their helpers | `buildSensorConfig`, `SensorConfigEntry` (added) | 47-303 |

`buildSensorConfig` goes into the existing `sensor-config.ts`, not a new `sensor-config-build.ts`
(the WP table's name): that module already holds `isCurrentLoopBoard`, the per-board role maps and,
after WP5, `boardSlot()`; a second "sensor config" module would split one concern in two and hide
the overlap BLOAT-MAP §3 points at ("both read config, both build sensor/board maps").

Import edges: `api-server.ts` → `api/*`, `video/routes.ts`, `sensor-config.ts` (re-export).
`api/*` → `api/http.ts` and existing domain modules. **`api/*` never imports `api-server.ts`**
(types live in `api/http.ts`, so not even a type-only cycle), and never imports `server/*` (WP6);
the WS side is reached only through `opts` (STYLE-S31). `api/*` modules have no import-time effects
(DESIGN-WP6 rule M1, STYLE-S30); `api/calibration.ts`'s `SRC_DIR` from `import.meta.url` is allowed
at module top level.

**Why `api/` and not `routes/`** (the WP table's directory): `routes/config.ts`,
`routes/config-profiles.ts`, `routes/calibration-profiles.ts`, `routes/script-check.ts` are domain
libraries, imported by the config and calibration characterization harnesses by path
(`config/ts_dump.ts:53-69`, `calibration/ts_harness.mts:95`). Handlers named `routes/states.ts`
beside library `routes/config.ts` would make the directory mean two things; renaming the libraries
would edit two harnesses (D18/D20). `api/` matches `api-server.ts` and the `/api/*` paths.

Expected sizes (per WP, STYLE-S33): `api-server.ts` ~90 lines; the largest group `api/ota.ts`
~170; `sensor-config.ts` grows to ~570.

---

## 3. Ownership and data flow

### 3.1 State passing

No new state and no context object. The one injected bundle is the existing `APIHandlerOptions`,
built once by `server.ts` and passed through to each group handler unchanged; a group destructures
only the members its bodies use (`const { onConfigUpdated } = opts;`), so moved bodies keep their
identifiers. Domain state stays in its owning module (`sessionManager`, `routes/*`, `ball-valve-cal`,
`board-logs`, `lc-tare`), reached by import, exactly as today. Why: `opts` is the existing seam that
keeps the HTTP side from importing the WS side (it breaks what would otherwise be an
`api-server` ↔ `server` cycle); everything else is a process singleton that every route already
imports directly.

### 3.2 An HTTP request

1. `server.ts` handler: `GET /stats` answered there; otherwise `await apiHandler(req, res)` inside
   `server.ts`'s try (→ 500 `Internal server error` only if WP7's own catch throws, e.g. writing
   headers twice); `false` → bare 404.
2. `createAPIHandler`'s handler: non-`/api/` → `false`. Set the three CORS headers. `OPTIONS` → 200
   empty. Parse `url`.
3. Inside **one** `try`: `/api/video/*` (when `video` is set) → `await handleVideoRequest`; then
   `if (await handleConfigRequest(req, res, url, opts)) return true;` for each group, in the order of
   §6.1; then 404 JSON. `catch` → 500 `{"error": message}`. `return true`.
4. A group handler tests its `(path, method)` pairs; on a match it runs the moved body and returns
   `true`; otherwise `false`. A body that answers inside a `req.on('end')` callback still returns
   `true` synchronously, as today.

### 3.3 A WS command and an Elodin update

Neither passes through WP7's modules. They touch the HTTP side only through state both read
(`sessionManager`, config files) and through the callbacks an HTTP write fires into the WS side:

| HTTP write | callback | effect on the WS / Elodin side (DESIGN-WP6 §2, `server.ts`'s `applyDeployedConfigChange`) |
|---|---|---|
| `POST /api/config`, `POST /api/config/import` (idle), `POST /api/config/profiles/switch` | `setImmediate(onConfigUpdated)` | `applyDeployedConfigChange()`: GUI stream, calibration entity map, hot-path caches, state-actuator map, board list reloaded; `board_status_update`; `config_updated` broadcast |
| `POST /api/state-csv` (deployed) | `setImmediate(onStateCsvUpdated)` | state-actuator map rebuilt; `config_updated` broadcast |
| `POST /api/calibration_profiles/load`, `…/new_blank` | `onCalibrationReload()` (synchronous) | `publishCalibrationReload(calibrationHost)` → Elodin `[0x46,0x00]` cmd 7 (no-op if Elodin is not connected) |
| `GET /api/debug`, `/api/engine_state` | `getDebugInfo()`, `getEngineState()` | read-only |

WP7 must not change when these fire (deferred vs synchronous) or under which condition
(`deployed` for state-csv, `!sessionActive` for config). H1 records the frames before the response
to see the deferral (D64(15)).

---

## 4. Error handling

### 4.1 Today

| case | today |
|---|---|
| non-`/api/` path | `false` → `server.ts` bare 404 |
| unknown `/api/*` path, or known path with the wrong method | 404 `{"error":"Not found"}` |
| not an operator on a gated write | 403 `{"error":"Not an approved operator"}` before reading the body |
| validation in a route that parses its own body in `req.on('end')` | that callback's own try/catch → **400** `{"error": message \|\| <default>}`; malformed JSON there → 400 with V8's `SyntaxError` text |
| malformed JSON on a `readJsonBody` route (`profiles/*`, `ball_valve_cal`, `feed-char`, `calibration_profiles/*`) | `profiles/*` catch locally → **400**; the others reject into the router catch → **500** `{"error":"Invalid JSON body"}` |
| a domain function throws on an awaited path (e.g. `saveCalibrationProfile`) | router catch → 500 `{"error": message}`, logged `API error:` |
| a throw inside a `req.on('end')` callback outside its own try | escapes every catch → `uncaughtException` guard in `server.ts`; the request never gets a response |
| exception after `flash-all` wrote its SSE headers | router catch's `writeHead(500)` throws → `server.ts` catch sees headers sent → nothing written; response left open |
| session conflict | 409 (`profiles/switch`, `feed-char` with no session, `ball_valve_cal` with no live position) |
| `/api/query`, `/api/sensors` | 503 `Query client not available` (no provider wired) |
| OTA | 413 over 4 MB; 400 for missing ip / wrong port / neither payload; 200 `{success:false, error}` when the flash fails; 500 on an unexpected throw |

### 4.2 Keeping it identical

- The router keeps **one** try/catch around the whole dispatch, and every group call is
  `if (await handleX(…)) return true;` **inside** it. Returning the promise unawaited
  (`return handleX(…)`) would let a rejection escape the catch — a 500 would become a hang.
- Bodies move verbatim, including their inner try/catch, their `req.on('data'|'end')` structure and
  their `readJsonBody` vs hand-parse choice, so the 400/500 split above is unchanged.
- **Awaits before a body attaches its listeners.** Today every `req.on('data', …)` (and every
  `readJsonBody`) is registered synchronously in the same tick that `server.ts` awaited the handler.
  After the split, up to nine resolved `await`s precede it (a group that does not match returns
  `false` from an `async` function; the OTA group is dispatched tenth). This is safe twice over:
  each `await` of an already-resolved promise is a microtask, and the whole chain drains before the
  event loop can run an I/O callback; and independently an `IncomingMessage` starts paused and
  buffers anything that arrives before a `'data'` listener attaches — `'data'`/`'end'` are emitted
  from the I/O phase (macrotasks), never from the microtask queue, and `'end'` cannot fire before
  the buffer has been drained by a listener. No chunk is lost and no status changes.
- CORS headers stay set in the router before dispatch (every golden `/api/*` response carries them,
  including 404, 403 and 500).

### 4.3 One pattern going forward

For new routes (and for an existing route only when a golden freezes the result first): validation
and parse errors → 400 `{"error": …}`; operator gate → 403 `Not an approved operator`, checked before
the body is read; conflict with session state → 409; anything unexpected → throw to the router → 500
`{"error": message}`. Bodies are read with `readJsonBody` and the read is awaited inside the route's
own try/catch. The existing inconsistencies (500 vs 400 for malformed JSON, three body-reading
styles, the hang paths) are **kept** and listed in Parked; unifying them changes status codes no
golden freezes yet (gap H3).

---

## 5. Naming conventions

- **Files:** `src/api/<group>.ts`, kebab-case, named for the resource group (`states`, `profiles`,
  `calibration`, `ota`), not for the URL prefix. `api/http.ts` for the shared request helpers
  (STYLE-S5).
- **Functions:** one exported `handle<Group>Request(req, res, url, opts)` per module, as
  `handleVideoRequest` (STYLE-S6); private helpers camelCase verbs (`readJsonBody`,
  `isConfigWriteAuthorized`). Step 2: `sendJson(res, status, body)` (same name and body as
  `video/routes.ts:38`), `denyUnlessOperator(req, res): boolean` (writes the 403 and returns `true`
  when it denied).
- **Types:** existing names kept (`APIHandlerOptions`, `DebugInfo`, `SensorConfigEntry`,
  `BoardScanRateHz`).
- **Not renamed** (STYLE-S7): every URL (including the mixed `snake_case` / `kebab-case` ones such
  as `/api/ball_valve_cal` vs `/api/feed-char/results`), error texts, `Content-Disposition`
  filenames, log texts (`📝 Config save → …`, `❌ OTA flash error:`, `API error:`).

---

## 6. Move-only pass, then cleanup

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
- **S2 (imports and evaluation order).** `api-server.ts` keeps all of today's import statements in
  step 1, in today's positions, and adds the new `./api/*.js` imports **after** all of them. But
  tsc, tsx/esbuild and vitest **elide** an import none of whose specifiers is used as a value
  (D42(a); today `api-server.ts` already loses `elodin-query.ts` and `http` at runtime), so the
  text alone does not pin the order: when a commit moves the last value user of a module out of
  `api-server.ts`, that module would start evaluating from inside the first `api/*` file that uses
  it — after `video/*`, instead of at its line today. Hence S2a-S2c. There is no import-closure
  grep (D63(1), as D49(2) for WP6): it reads source text, the runtime does not, and the order diff
  below is the check that counts.
- **S2a (bare import).** When a commit leaves an import in `api-server.ts` with no specifier used as
  a value, rewrite that declaration as a bare side-effect import **at the same position**
  (`import './session-manager.js';`). A bare import is never elided; this is a move-only edit. Do it
  **only** for a module the measured order shows evaluating first at that line today — never for an
  import already elided today (type-only or unused), where a bare import would **add** a module to
  the evaluation set. Measured on the bundle (46 modules today, `api-server.ts` at position 31;
  `server.ts:29-31` have already evaluated `routes/calibration-profiles`, `lc-tare`,
  `ball-valve-cal`, `routes/config`, `sensor-config` and `shared/config-validation` before
  `server.ts:35` imports `api-server.ts`), step 1 makes exactly **seven** bare imports, each in the
  commit that moves its last value user out:

  | line | module | last value user → commit | first evaluated here today? |
  |---|---|---|---|
  | 16-22 | `routes/config-profiles` | `profiles` (693-780) → **1.5** | yes (position 16) |
  | 23 | `routes/script-check` | `states` (648, 677) → **1.4** | yes (17) |
  | 33 | `session-manager` | `feed-char` (1009) → **1.11** | yes (21; its subtree brings `service-controller`, `session-state`, `config-validation`) |
  | 35 | `operators` | `isConfigWriteAuthorized` (347) → **1.1** | yes (22) |
  | 36 | `ota-build` | `ota` → **1.12** | yes (23) |
  | 37 | `ota-service-cmd` | `ota` → **1.12** | yes (24) |
  | 39 | `board-logs` | `board-logs` (885, 894) → **1.8** | yes (25; `server.ts:37` imports it later) |

  Every other import needs **no** bare import, and must not get one:

  | line | module | why not |
  |---|---|---|
  | 15 | `routes/config` | already evaluated (11) via `sensor-config` at `server.ts:31`; last user `board-logs` (917) → 1.8 |
  | 24-31 | `routes/calibration-profiles` | already evaluated (3) via `lc-tare` at `server.ts:29`; last user `calibration` → 1.10 |
  | 32 | `sensor-config` (`isCurrentLoopBoard`) | already evaluated (12) at `server.ts:31`; last user `buildSensorConfig` → 1.2 |
  | 34 | `config-validation` | already evaluated (20) inside `session-manager`'s subtree, before line 34 is reached; eliding it after 1.3 (`validateActiveProfile`, 690) changes nothing |
  | 41 | `lc-tare` | already evaluated (4) at `server.ts:29`; last user `calibration` (995) → 1.10 |
  | 42 | `../../shared/config-validation` | already evaluated (9); `sensor-config.ts:7` imports it; last user `buildSensorConfig` (279) → 1.2 |
  | 45 | `ball-valve-cal` | already evaluated (6) at `server.ts:30`; last user `calibration` → 1.10 |
  | 43 | `video/routes` | keeps its value use (`handleVideoRequest` stays in the router) |
  | 38, 40, 44, 10 | `elodin-query`, `shared-types`, `video/service`, `http` | type-only today, elided today; a bare import would **add** a module |
  | 6-9 | `fs`, `os`, `path`, `url` | Node builtins: no import-time effect, not in the order list (packages external); `path`/`fileURLToPath` keep a value use (line 14) until 1.13 |

  The resulting order: positions 1-30 unchanged, then the `api/*` modules (`api/http` first), then
  `api-server` and the rest of `server.ts`'s list.
- **S2b (runtime order — the check that counts).** Every commit diffs the esbuild bundle's module
  order against its **parent commit** (DESIGN-WP6 §6.3 item 4, with `src/api/` filtered out instead
  of `src/server/`). The only permitted difference is new `src/api/*` entries. No stored baseline
  (D49(4)); the queue item's merge check runs the same diff on the item's tip against its base.

  ```bash
  cd diablo_server/backend
  ESB=$PWD/node_modules/.bin/esbuild
  order() { "$ESB" src/server.ts --bundle --platform=node --format=esm --packages=external \
    --log-level=error | grep -E '^// (src|\.\./)' \
    | awk '{last[$2]=NR; o[NR]=$2} END{for(i=1;i<=NR;i++) if(last[o[i]]==i) print o[i]}'; }
  order > /tmp/order-after.txt
  # the same in a scratch checkout of the parent (ln -s "$PWD/node_modules" <scratch>/daq-server/diablo_server/backend/node_modules) → /tmp/order-before.txt
  diff <(grep -v '^src/api/' /tmp/order-before.txt) <(grep -v '^src/api/' /tmp/order-after.txt)   # prints nothing
  ```
- **S2c.** Never enable `verbatimModuleSyntax` (or `isolatedModules`-driven `import type`
  rewrites) to "pin" imports: it would add `elodin-query.ts` to today's evaluation set.
  `api/history.ts` imports `ElodinQueryClient` and `QueryOptions` with `import type`, so it stays
  elided there too.
- **S3 (`__dirname`).** The only `__dirname` user is `/api/cubic_calibration` (941-946). In
  `api/calibration.ts` define `const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');`
  and replace the two `path.join(__dirname, …)` candidates (942-943) with `path.join(SRC_DIR, …)`,
  same strings. Do **not** move them unchanged: one level deeper, candidate 1 points at
  `diablo_server/scripts/…` (absent) and candidate 2 happens to hit the same file — identical output
  today by accident, invisible to the golden (H6). The `__dirname` const at line 14 is then dead;
  commit 1.13 removes it.
- **S4 (options).** Each group destructures the `opts` members its bodies name, at its top, so
  bodies are unchanged.

| # | commit: create | cut from `api-server.ts` | notes |
|---|---|---|---|
| 1.1 | `api/http.ts` | 305-361 (types + `isConfigWriteAuthorized` + `readJsonBody`) | `api-server.ts` re-exports the three types; `operators` goes bare (S2a) |
| 1.2 | `sensor-config.ts` (append) | 47-303 | `api-server.ts`: `export { buildSensorConfig, type SensorConfigEntry } from './sensor-config.js';` — `t7.test.ts` unchanged. No import is added: `sensor-config.ts` already imports `readConfig` (`:6`) and `t7Channels` (`:7`), and `isCurrentLoopBoard` is defined there. The config characterization harness imports named functions from this file; adding exports does not change `config/golden/ts/` |
| 1.3 | `api/config.ts` | 394-507, 685-690 | `config-validation` loses its value use; no bare import (S2a table) |
| 1.4 | `api/states.ts` | 508-684 | `routes/script-check` goes bare |
| 1.5 | `api/profiles.ts` | 691-784 | `routes/config-profiles` goes bare |
| 1.6 | `api/history.ts` | 785-815, 849-877 | `import type` for `ElodinQueryClient`, `QueryOptions` (S2c) |
| 1.7 | `api/gui-config.ts` | 816-848 | imports `buildSensorConfig` from `../sensor-config.js` |
| 1.8 | `api/board-logs.ts` | 878-924 | the local `const history = getBoardLogHistory(…)` keeps its name (module-local; no clash); `board-logs` goes bare |
| 1.9 | `api/debug.ts` | 925-932, 1093-1096 | D64(3)'s value-level `/api/debug` and `transition_armed` `engine_state` lines exist first |
| 1.10 | `api/calibration.ts` | 933-998, 1056-1092 | S3; D64(5)'s operator `onCalibrationReload` vitest exists first |
| 1.11 | `api/feed-char.ts` | 999-1055 | `session-manager` goes bare |
| 1.12 | `api/ota.ts` | 1097-1256 | the `MAX_BODY` constant and SSE closure move inside the body unchanged; `ota-build`, `ota-service-cmd` go bare |
| 1.13 | cleanup: dead `__dirname` | delete 12-14 (the comment and `const __dirname = …`) and the four builtin imports 6-9 (`fs`, `os`, `path`, `url`), now without a value use | The only import deletion in WP7. Builtins have no import-time effect and no entry in the order list, so the S2b diff is trivially empty; `tsconfig` has no `noUnusedLocals`, so the proof is `grep -nE '\b(fs|os|path|fileURLToPath|__dirname)\b' src/api-server.ts` printing nothing plus `tsc` exit 0. Line 10 (`http` types) stays |

After 1.13 `api-server.ts` is the router (~90 lines): imports (seven of them bare), re-exports,
`createAPIHandler` with 363-393 verbatim (the `if (video && url.pathname.startsWith('/api/video/'))`
guard kept verbatim, first inside the try), ten `if (await handle…Request(req, res, url, opts))
return true;` lines, 1257-1267 verbatim.

**Checks for every commit** (no ports):

1. `npx tsc --noEmit` in `diablo_server/backend/` — exit 0 (required; merge-gate step).
2. Backend `npm test`, no failure outside `test/characterization/baseline_vitest_failures.txt`
   (`t7.test.ts`, `config-profile-create-calibration.test.ts` exercise the exports).
3. The module-order diff (S2b) and the cycle grep (§8).
4. Route-table check, dispatch check and move-only check, below.

Under the stack lock, at the end of the step (and at most at one midpoint, within AGENT-RULES rule
7's hold limit): `pipeline/run.sh pt nocal boards` and `lifecycle/run.sh` (its `ota` golden drives
`POST /api/ota-flash`). `test_integration.sh` runs in the merge queue's full gate. There is no
startup-log diff in WP7: nothing WP7 moves logs at import, and the order diff is the order check.

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
every line. **One substitution** is applied to the old text before comparing: in the
`/api/cubic_calibration` branch (937-959) the two `path.join(__dirname, …)` candidates (942-943)
become `path.join(SRC_DIR, …)` — the S3 rewrite, and the only non-verbatim edit of step 1. Every
branch's `[COND] + BODY` must then occur as one contiguous run of lines, after the same stripping,
in **exactly one** `api/*.ts` file (and nowhere twice). The only lines of an `api/*.ts` file
outside such runs may be imports, the handler's signature, its `opts` destructuring (S4), the added
`return true;` per branch, `return false;`, closing braces, and S3's `SRC_DIR` line. A ~40-line
Python script; WP7 commits it with the package's checks (outside `src/`).

**Review** with `git diff --color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change
backend-remastered -- diablo_server/backend/src`: in step 1 every non-dimmed line must be an import
(including an S2a bare import), an `export` keyword or re-export line, a handler signature, an
`opts` destructuring, a `return true;` / `return false;`, the `SRC_DIR` line and the two candidate
lines, or a dispatch line in `api-server.ts`. A line that only re-indents a moved body
(`} else if (COND) {` → `if (COND) {` one level shallower) is expected, not a stop (D43(6)).

### 6.2 Step 2 — cleanup toward the target

Each is its own commit, with the per-commit checks of §6.1; `pipeline/run.sh pt nocal boards` and
`lifecycle/run.sh` under the stack lock at the end. Numbering is kept from the reviewed note.

1. **`sendJson` and `denyUnlessOperator`** in `api/http.ts`.

   `sendJson(res, status, body)` is **not** a pure refactor in general. Today `res.writeHead(...)`
   runs **before** the body expression of `res.end(JSON.stringify(<expr>))` is evaluated; if `<expr>`
   calls something that throws, the router's catch then fails on `writeHead(500)` (headers already
   sent) and the request hangs. With `sendJson`, `<expr>` is evaluated first, so the same throw
   becomes a clean 500 — a silent defect fix. So `sendJson` may replace **only** a pair whose body
   argument is built from literals and already-evaluated locals (optional-chained reads such as
   `error?.message` and `??` defaults included), where nothing in the expression can throw. The
   91 `writeHead(<n>, { 'Content-Type': 'application/json' })` / `end(JSON.stringify(…))` pairs of
   the ladder, by today's line of the `res.end`:

   **Eligible** (50; each directly preceded by its `writeHead`): 410, 441, 467, 498, 559, 584,
   606, 634, 679, 707, 714, 723, 728, 753, 758, 768, 773, 783, 790, 810, 822, 848, 854, 874, 890,
   905, 919, 928, 932, 936, 968, 984, 1014, 1031, 1038, 1044, 1050, 1055, 1063, 1073, 1084, 1096,
   1100, 1105, 1181, 1188, 1197, 1221, 1249, 1259.

   **Not eligible, keep the raw pair** (41):
   - the body calls a function after `writeHead` (20): 398, 404, 426, 622 (the multi-line ternary
     calling `listStateScripts()` / `readStateScript()`), 690, 695, 720, 750, 765, 780, 860, 894,
     963, 977, 981, 1059, 1069, 1080, 1092, and the two multi-line OTA bodies 1208 and 1231
     (`Date.now() - t0`);
   - the body reads a property of a local without `?.` (it throws if the local is
     `null`/`undefined`, e.g. a thrown non-Error) (16): 445, 459, 505, 562, 577, 613, 627, 651, 658,
     666, 682, 814, 834, 922, 1254, 1264;
   - not an adjacent pair (4): 955, 958 (`writeHead` at 953 sits before an `if`/`try`), 995, 997
     (`writeHead` at 993 sits before the `try`);
   - outside the count: the CSV, text, SSE and `Content-Disposition` responses, the `OPTIONS`
     `end()`, and 957 (`res.end(body)`, a raw file body under a JSON header).

   The check script (the ~20-line grep check in the package's scripts, outside `src/`; no linter,
   STYLE-S40) identifies sites **by content, not by these line numbers**: for every `sendJson(`
   call in `api/*.ts` it takes the body argument (which may span lines), strips string literals
   **but keeps template-literal `${…}` interpolations** (426 hides `pwmIssues.join('; ')` inside
   one), and fails on a `(` (a call) or a `.` that is not part of `?.` (a property read). Run over
   the 91 bodies at `b2599617`, that rule passes exactly the 50 eligible sites and every
   function-call and property-read site fails it; of the four non-adjacent sites 995 fails it too
   (`currentTares()`) and 955, 958, 997 pass by content and are excluded only by the second
   condition, which is the reviewer's: each `sendJson` replaces exactly one adjacent pair — the
   diff shows a `writeHead` line deleted directly above it and nothing else. Expected saving
   ≈ 100 lines.

   `denyUnlessOperator(req, res)` replaces the 14 identical
   `if (!isConfigWriteAuthorized(req)) { 403 …; return true; }` blocks (their bodies are literals).
   The widened H8 package (§7) already exists — it gates step 1 — so every one of the 14 is
   frozen as a viewer 403 before this commit touches it.
2. **Slot rule.** `elodinSlotFromBoardId` (96-100, now in `sensor-config.ts`) → WP5's
   `boardSlot()`. DESIGN-WP5 fixes `boardSlot`'s body as literally
   `const m = boardId % 10; return m === 0 ? 10 : m;` — byte-identical to lines 98-99 — so the
   proof is a **diff, not a characterization** (D63(3)): the commit's review shows the deleted
   helper's body equal to `boardSlot`'s, `asBoardId` still guarantees a number, and no validation
   is added. H4 is worth writing but does not gate this commit.
3. **One identity rule — after both WP6 and WP7 have merged** (decision): `isConfigWriteAuthorized`
   (345-348) and the WS control path (`server.ts:978-979`) compute the same thing. Move it to
   `operators.ts` as `isOperatorRequest(headers)` used by both. The WS path still computes and keeps
   `authEmail`, which `CONTROL_STATUS` sends (`email: authEmail || null`). Same result for every
   header value. The WS half of the H8 package (the operator path, gating WP6 step 1) and the HTTP
   half together freeze both sides first.
4. **Label the bare imports.** One comment block above the seven S2a bare imports in
   `api-server.ts`, naming what each pins (STYLE-S37): `session-manager` is the effectful one (it
   constructs `sessionManager` at import and brings `config-validation` with it); the other six pin
   today's evaluation order only. No import is added, deleted, reordered or rewritten; the order
   diff is empty. Also `// Kept: C5-5 (D17)` at the cubic-store candidates in `api/calibration.ts`
   (STYLE-S12/S37): `GET /api/cubic_calibration` resolves its own four candidates and ignores
   `DAQ_CALIBRATIONS_DIR`, while `routes/calibration-profiles.livePath()` honours it — two owners
   of one path, a behaviour change to unify, Parked.

**Not in WP7** (D63; reasons in `debates/WP7/history.md`): pruning `api-server.ts`'s imports and
its 5 s startup-log diff (the bare imports stay, labelled — D63(2), as D49(8)); unifying body
reading; removing the never-wired `getQueryClient` / `getCalibrationStatus` options; renaming
`routes/`; the C5-5 fix.

### 6.3 Deliberately NOT changed (observable)

- Every path, method, status, body, header and text in §4.1 — including the 404-not-405 rule, the
  500 for malformed JSON on `readJsonBody` routes, the 409 for `feed-char` with no session on any
  method, `PUT /api/feed-char/results` → 405 during a session, the 503 stubs, the `/api/sensors/<x>`
  placeholder, `{"packets": []}`.
- `setImmediate` deferral of `onConfigUpdated` / `onStateCsvUpdated` and the synchronous
  `onCalibrationReload`; the response is written before the callback runs.
- `GET /api/config/profiles` calling `ensureSeeded()`; `GET /api/states` reading the **active
  profile** while `/api/pressure-limits` and `/api/gui-config` read the **deployed** config.
- `cubic_calibration` candidate order (S3) and its "partial/corrupt → `{"cubic_state":{}}`" fallback;
  that it ignores `DAQ_CALIBRATIONS_DIR` while `routes/calibration-profiles.livePath()` honours it
  (C5-5, two owners of one path — labelled in 2.4, Parked).
- SSE framing of `flash-all` (`event: …\ndata: …\n\n`), the sequential per-board flash, the OTA
  temp-dir lifecycle and 4 MB cap, the "port must be 3232" rule.
- **The security findings WP7 must not change** (route bodies move verbatim; LEDGER SEC-*):
  **SEC-2** the absent operator gate on `POST /api/ota-flash` (1169) and `…/flash-all` (1101);
  **SEC-3** `projectPath` (1194-1206) handed to `ota_service` as the caller sent it, where `pio
  run` executes it; **SEC-9** `POST /api/state-script/check` (669) ungated, with an unbounded body
  and a process per call. The H8 package freezes the two OTA routes as the viewer's 200 so SEC-2
  stays visible; a fix is the team's, after the remaster.

---

## 7. Guarding characterization

| part | guarded by | notes |
|---|---|---|
| every GET route, idle and during a session (status, CORS, content-type, body or schema) | `pipeline/golden/http.txt` (`http_before_session`, `http_during_session`) | P9 schema for `/api/debug`, `/stats`, board logs; D64(3) adds value-level `/api/debug` keys and `engine_state` during `transition_armed` |
| GET routes with every board type | `pipeline/golden/boards/http.txt` (`/api/sensor-config` for PT 21/22, TC, RTD, LC, T7; `ball_valve_cal`, `lc_tare`, `board-logs*`, `debug`, `config/validate`, `gui-config`, `pressure-limits`, `engine_state`) | |
| PT calibration file absent | `pipeline/golden/nocal/http.txt` | |
| error shapes: 404 ×2, OPTIONS, wrong method, 403 on 6 of the 14 gated routes, 400s, 409s, OTA 400s, video | `http.txt` `http_errors` | mutation `feed-char 409 → 410` went red |
| state CSV bodies | `pipeline/golden/csv.txt` | mutation (swap columns) went red |
| `cubic_calibration` resolves the fixture's store | `http.txt` (`GET /api/cubic_calibration` body) | a wrong root falls back to `{"cubic_state":{}}` → red |
| `POST /api/ota-flash` success and failure paths | `lifecycle/golden/ota.txt` ("backend POST /api/ota-flash: …", 6 cases, against a fake board on 3232) | |
| `buildSensorConfig` (T7 channels, RTD role) | `__tests__/t7.test.ts` | imports through `api-server.js` |
| `profiles/create` success with calibration | `__tests__/config-profile-create-calibration.test.ts` | drives `createAPIHandler` |
| route domain libraries | `config/golden/ts/*`, `calibration/golden/ts.txt` | untouched by WP7 |
| `board-log-mode` success | `test/ws_data_flow_test.ts` `testBoardLogMode` | gate |
| one raw body per HTTP route (key order) | D64(14), G9 widened | step 2.1 |

Backend vitests do not discharge these rows; substituting a vitest for a row is a decision the
orchestrator records per row, never a default.

### Gaps — a move could change these and no golden would notice

H1-H3, H5 and H8 belong in `test/characterization/pipeline/` (C0-owned, test-only, adding golden
lines only — D20); H4 is pure-function characterization (D20 allows white-box for pure functions
with a stable signature); H9 is a backend vitest.

| gap | priority (orchestrator) | must exist before |
|---|---|---|
| H8 (widened: all 14 HTTP gates + the two OTA routes; with the WS operator path for WP6) | MUST — C0 package | step 1 (and WP6 step 1) |
| H1, H2 | MUST | step 1 (H2's `flash-all` only against a config with no enabled boards; its viewer cases are H8's) |
| D64(3), D64(5) | MUST (C0) | 1.9, 1.10 |
| H9 | should | step 1 |
| H3 | should, only if `sendJson` survives review | step 2.1 |
| H4 | worth writing, **not gating** (D63(3): 2.2 is proven by a diff) | — |
| H5 | nice-to-have | — |
| H6, H7 | accepted as documented | — |

- **H8 Every operator gate, as the viewer** (`X-Auth-Email: viewer@example.com`, `session.ts:136`;
  the security ruling on the coverage hole: no backend test or golden pins any 403, so a refactor
  that dropped a gate would stay green). One package, C0, test-only: for each of the 14 gated
  routes of §1.1 a request as the viewer, frozen as 403 `{"error":"Not an approved operator"}` with
  no side effect (the file unchanged, no `config_updated` frame) — the six already frozen stay as
  they are, the eight new ones are `POST /api/state-script`, `profiles/create`, `…/rename`,
  `…/delete`, `POST /api/ball_valve_cal`, `POST /api/feed-char/results`,
  `calibration_profiles/load`, `…/new_blank`. The `feed-char` one must run **during a session**:
  without one the route answers 409 before it reaches the gate. Plus the two ungated OTA routes
  **as the viewer, frozen as today's 200** so that D-OTA/SEC-2 stays visible until the team fixes
  it: `POST /api/ota-flash/flash-all` against a config with no enabled boards → 200
  `{"success":false,"message":"No enabled boards in config"}` (never against the pipeline fixture:
  with boards it would flash them), and `POST /api/ota-flash` with `firmwareBase64` as a
  **viewer-header variant** of lifecycle's fake-board case (`lifecycle.py:1340` sends no
  `X-Auth-Email` today, so its existing 200 is the implicit operator's) → 200
  `{"success":true,…}`. Plus, for WP6, the WS control-unlock/operator path.
  Gates WP7 step 1 and WP6 step 1; mutation: drop one gate → its line goes red.
- **H1 Success paths of the writes and their callbacks.** Only error shapes are frozen for
  `POST /api/config`, `/api/config/import`, `/api/state-csv`, `/api/state-script`,
  `profiles/switch|rename|delete`, `calibration_profiles/save`; `profiles/create` has a vitest.
  Add, idle, as the operator: each write's status/body, the file it changed (normalised), and the WS
  frames that follow (`config_updated`, `board_status_update`), recording the frames that arrive
  **before** the response to see the `setImmediate` deferral (D64(15)). Include import with an
  invalid TOML (400 + rollback: the profile file is unchanged). Shared with WP6's G7 (widened by
  D64(10)).
- **H2 Routes no request ever reaches.** `POST /api/calibration_profiles/load`,
  `POST /api/calibration_profiles/new_blank` and `POST /api/ota-flash/flash-all` appear in no golden,
  so a misrouted or dropped branch would go unnoticed (the route-table check in §6.1 is static
  only). Their viewer cases are H8's; the operator `load` / `new_blank` case, which is the only way
  to see `onCalibrationReload` fire, is D64(5)'s vitest before 1.10.
- **H3 Malformed JSON bodies.** Not sent anywhere. Freeze one per style: a `readJsonBody` route that
  answers 500 (`ball_valve_cal`), one that answers 400 (`profiles/rename`), and one hand-parsed route
  (`board-log-mode`, 400 with V8's message — normalise to the error class, as the calibration harness
  does for `JSON.parse`).
- **H4 Slot 0 → 10 in `buildSensorConfig`.** No golden has a PT/TC/RTD/LC board with
  `board_id % 10 == 0` (the boards session's sensor list is PT1, PT2, TC1, RTD1, LC2, T71). Worth
  freezing `buildSensorConfig` for an injected config with board_ids 10, 20, 21, two RTD and two LC
  boards without roles (`generatedRole` multi-board names), a disabled board, a non-numeric
  `board_id` (`asBoardId` fallbacks 1/51/31/41), negative (`-21`) and non-integer (`21.5`)
  board_ids, and T7 channels. It does not gate 2.2 (D63(3)).
- **H5 `PUT /api/feed-char/results` during a session (405)**: the no-session 409 (`POST`, `PUT`),
  the in-session `GET` (200, `results: []`) and `POST` (500 `ENOENT`, mock mode) are frozen; the
  405 branch is not.
- **H6 `cubic_calibration` candidate order** cannot be observed (§6.1 S3); prescribed rather than
  tested.
- **H7 SSE headers and framing** of `flash-all` — covered by H8's no-boards case only for the JSON
  branch; the SSE branch stays unguarded (cannot be exercised safely on a shared machine without a
  fake `ota_service`; lifecycle's fake board could host it later).
- **H9 Every route is dispatched** (`research/node-realtime-backend.md` §5). A backend vitest
  that drives `createAPIHandler` with a temp-dir `CONFIG_PATH` (no enabled boards), a viewer
  `X-Auth-Email` and an empty or invalid body, for every `(method, path)` of a checked-in list
  generated from the route-table check, and asserts the answer is **not** the router's
  `404 {"error":"Not found"}` (and, for `/api/video/*`, that the video branch answered). Viewer
  identity makes every gated write a 403 with no side effect; the ungated OTA routes answer 400
  (missing ip) and, for `flash-all`, `200 {"success":false,"message":"No enabled boards in config"}`
  — the same safe cases as H8. It closes "a group is never dispatched" before the moves instead of
  by the static dispatch check alone, and it imports `api-server.ts` with no stack (no port). Its
  ESLint `no-restricted-syntax` guard for `sendJson` is not adopted (STYLE-S40: no linter; the
  content check of §6.2 item 1 instead).

---

## 8. Risks

- **Shared state.** None in the file (§1.2). The risk is the callbacks: a moved body must call
  `onConfigUpdated` / `onStateCsvUpdated` under the same condition and through the same
  `setImmediate`; H1 is what would notice.
- **A dropped gate.** Fourteen identical blocks move in nine commits and are rewritten in 2.1; no
  golden saw eight of them until H8. H8 is the gate on step 1 for this reason.
- **Unrestricted `sendJson`** would turn today's hang-after-headers into a clean 500 on 41 call
  sites — a defect fix no golden notices. §6.2 item 1 restricts it to the 50 listed sites and the
  check script enforces the rule by content.
- **A group never dispatched** passes the route-table diff; the dispatch check of §6.1 catches it,
  H9 before the moves.
- **Import cycles.** Types in `api/http.ts`; `api/*` never imports `api-server.ts` or `server/*`. A
  grep in the DoD: `grep -lE "from '\.\./(api-server\.js|server/)" src/api/*.ts` prints nothing.
- **Evaluation order.** `createAPIHandler` is called once, at `server.ts:784`, after `video.start()`;
  group modules have no import-time effects. What can move is *when* `session-manager`,
  `routes/config-profiles`, `routes/script-check`, `operators`, `ota-*` and `board-logs` evaluate
  (S2): the seven bare imports pin them and the order diff proves it per commit. A bare import on
  a type-only line would **add** a module (S2a's second table).
- **Unawaited group calls** turn a 500 into a hang (§4.2). Reviewed per line; `tsc` does not catch it.
- **`__dirname` depth** (S3, H6).
- **The `state-csv/` state-CSV loaders.** `api-server.ts` does not import them;
  `/api/state-csv` reads and writes through `routes/config-profiles.ts` — a separate CSV reader. What
  links the two is `onStateCsvUpdated`, which makes `server.ts` rebuild its `state-csv` map; WP7 keeps
  that callback's condition (`deployed`) and timing. The loaders' `__dirname`-relative paths are not
  touched (WP7 does not move them).
- **The duplicated slot helper.** `elodinSlotFromBoardId` (96-100) is one of six copies of
  `board_id % 10, 0 → 10` (BLOAT-MAP §3 lists five; `server.ts:344-345` is the sixth, DESIGN-WP6 §8
  R5). WP5 does not own this copy; WP7 moves it with `buildSensorConfig` in step 1 and replaces it
  in step 2.2 by a diff against `boardSlot`. The frontend copy
  (`frontend/lib/sensor-info-entities.ts:13`) stays (frontend out of scope).
- **`sensor-config.ts` grows to ~570 lines** (under the 700-line god-file line). It is also WP5's
  file; WP7 must start after WP5 has merged (the DAG already says so).
- **Harness imports by path.** `config/ts_dump.ts` and `calibration/ts_harness.mts` import
  `routes/*.ts`, `sensor-config.ts`, `config-validation.ts` by path; WP7 moves none of them (it only
  appends to `sensor-config.ts`).

---

## Defects found (report, not fix)

- **SEC-2 / D-OTA: `POST /api/ota-flash` (1169) and `POST /api/ota-flash/flash-all` (1101) have no
  operator gate.** Every other write checks `isConfigWriteAuthorized`; behind Caddy a signed-in
  non-operator can flash board firmware, and `flash-all` reflashes every enabled board. H8 freezes
  the viewer's 200.
- **SEC-3: `projectPath` → code execution.** `api-server.ts:1194-1206` passes a caller path to
  `ota_service`, which runs `pio run`; a `platformio.ini` `extra_scripts` runs arbitrary code as the
  service user. Moves verbatim into `api/ota.ts`.
- **SEC-9: `POST /api/state-script/check` (669)** is ungated, reads an unbounded body and spawns a
  process per call. Moves verbatim into `api/states.ts`.
- `getQueryClient` and `getCalibrationStatus` are never provided, so `/api/query` and `/api/sensors`
  always answer 503 and `/api/calibration_status` always answers the error object;
  `/api/sensors/<entity>` is a placeholder.
- Malformed JSON answers 500 on five `readJsonBody` routes (`ball_valve_cal`, `feed-char`,
  `calibration_profiles/save|load|new_blank`) and 400 everywhere else.
- A throw inside a `req.on('end')` callback outside its own try, or after `flash-all` has sent its
  headers, leaves the request without a response.
- `GET /api/config/profiles` can write (`ensureSeeded()`).
- C5-5: `GET /api/cubic_calibration` and `routes/calibration-profiles.livePath()` disagree on where
  the live cubic store is when `DAQ_CALIBRATIONS_DIR` is set.

---

## 9. Interface stubs and STYLE

The public surface of every §2 module is written as type-checked stubs in
`docs/remaster/design-stubs/ts/src/` (`api-server.ts`, `api/*.ts`, the `sensor-config.ts` delta;
one header comment per module, STYLE-S36, listing each group's routes with their gates, error paths
and callbacks), beside WP5's and WP6's. They are imported by nothing and excluded from the product's
`tsc`:

```bash
cd daq-server/docs/remaster/design-stubs/ts
npx --prefix ../../../../diablo_server/backend tsc --noEmit -p .    # exit 0
```

**The stubs are frozen as of D63 and are not maintained once step 1 starts.** Where a stub and this
note disagree, this note wins.

What writing them confirmed: the route-group signature stays documentation only (eleven modules
share it, but a declared `RouteHandler` type would be a callback type no code consumes generically,
STYLE-S34); `sendJson`'s body is fixed as `video/routes.ts:38`'s (`writeHead` before
`JSON.stringify`), so the restriction, not the helper, carries the safety; `api/history.ts` keeps
`ElodinQueryClient` type-only; `api/calibration.ts` owns `SRC_DIR` from `import.meta.url`
(STYLE-S30, D43(7)).

STYLE applied: S5 (`api/` = HTTP route handlers, `routes/` = domain libraries the harnesses import
by path, untouched); S6 (`handle<Group>Request`); S7 (every URL, header, text and filename kept);
S8/S10 (every frozen failure mode listed in the handlers' docs: the 500-vs-400 malformed-JSON split,
the hang paths, the ungated OTA routes, the 503 stubs); S12/S37 (`// Kept: C5-5 (D17)` in 2.4, the
bare-import labels in 2.4 — comments land in step 2, not in a move-only commit, S38); S28 (every
group call awaited inside the one try); S29 (`setImmediate` deferral vs synchronous
`onCalibrationReload`); S30, S31, S33, S34, S36; S40 (no linter; the `sendJson` check is a script in
the package, outside `src/`; 2 spaces, single quotes, semicolons in new files; moved code not
reformatted).
