# DESIGN-WP7 — split `diablo_server/backend/src/api-server.ts`

Target-design note required by LEDGER D17(a) before the WP7 split. Design only: nothing here has
been executed. Paths are relative to `daq-server/diablo_server/backend/src/` unless stated.

**Baseline.** Line numbers are `api-server.ts` on `backend-remastered` @ `b2599617` (1269 lines).
WP7 runs after WP5 (which adds `boardSlot()` to `sensor-config.ts`) and may run in parallel with WP6;
WP5 does not edit this file, so these line numbers stay valid. Read with `DESIGN-WP6.md` §3.4: the
seam between the two is `createAPIHandler(opts)`.

**Prerequisites.** C1 merged on `backend-remastered`, and `npx tsc --noEmit` in
`diablo_server/backend/` added to `gate.sh` as a merge-gate step (orchestrator). WP5 merged (WP7
appends to WP5's `sensor-config.ts`).

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
| 508-684 | states | `GET /api/states` (+ `[flow]`), `GET`/`POST /api/state-csv` (deploy when idle → `setImmediate(onStateCsvUpdated)`), `GET`/`POST /api/state-script` (checked by `checkStateScript` before save), `POST /api/state-script/check` |
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
| 1097-1256 | OTA | `GET /api/ota-flash/projects`, `POST /api/ota-flash/flash-all` (Server-Sent Events, sequential `otaBuildFlash` per enabled board), `POST /api/ota-flash` (4 MB cap, `projectPath` build+flash or base64 file flash through a temp dir) |
| 1257-1260 | fallthrough | 404 `{"error":"Not found"}` |
| 1261-1265 | catch-all | 500 `{"error": <message>}`, logged `API error:` |
| 1267 | | `return true` |

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

(That type is documentation; nothing new needs to be declared beyond `APIHandlerOptions`.)

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
the overlap BLOAT-MAP §3 points at ("both read config, both build sensor/board maps"). See Q1.

Import edges: `api-server.ts` → `api/*`, `video/routes.ts`, `sensor-config.ts` (re-export).
`api/*` → `api/http.ts` and existing domain modules. **`api/*` never imports `api-server.ts`**
(types live in `api/http.ts`, so not even a type-only cycle), and never imports `server/*` (WP6);
the WS side is reached only through `opts`. `api/*` modules have no import-time effects (DESIGN-WP6
rule M1).

**Why `api/` and not `routes/`** (the WP table's directory): `routes/config.ts`,
`routes/config-profiles.ts`, `routes/calibration-profiles.ts`, `routes/script-check.ts` are domain
libraries, imported by the config and calibration characterization harnesses by path
(`config/ts_dump.ts:53-69`, `calibration/ts_harness.mts:95`). Handlers named `routes/states.ts`
beside library `routes/config.ts` would make the directory mean two things; renaming the libraries
would edit two harnesses (D18/D20). `api/` matches `api-server.ts` and the `/api/*` paths.

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

| HTTP write | callback | effect on the WS / Elodin side (`DESIGN-WP6.md` §3.4) |
|---|---|---|
| `POST /api/config`, `POST /api/config/import` (idle), `POST /api/config/profiles/switch` | `setImmediate(onConfigUpdated)` | `applyDeployedConfigChange()`: GUI stream, calibration entity map, hot-path caches, state-actuator map, board list reloaded; `board_status_update`; `config_updated` broadcast |
| `POST /api/state-csv` (deployed) | `setImmediate(onStateCsvUpdated)` | state-actuator map rebuilt; `config_updated` broadcast |
| `POST /api/calibration_profiles/load`, `…/new_blank` | `onCalibrationReload()` (synchronous) | `publishCalibrationReload(calibrationHost)` → Elodin `[0x46,0x00]` cmd 7 (no-op if Elodin is not connected) |
| `GET /api/debug`, `/api/engine_state` | `getDebugInfo()`, `getEngineState()` | read-only |

WP7 must not change when these fire (deferred vs synchronous) or under which condition
(`deployed` for state-csv, `!sessionActive` for config).

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
  `calibration`, `ota`), not for the URL prefix. `api/http.ts` for the shared request helpers.
- **Functions:** one exported `handle<Group>Request(req, res, url, opts)` per module, as
  `handleVideoRequest`; private helpers camelCase verbs (`readJsonBody`, `isConfigWriteAuthorized`).
  Step 2: `sendJson(res, status, body)` (same name and body as `video/routes.ts:38`),
  `denyUnlessOperator(req, res): boolean` (writes the 403 and returns `true` when it denied).
- **Types:** existing names kept (`APIHandlerOptions`, `DebugInfo`, `SensorConfigEntry`,
  `BoardScanRateHz`).
- **Not renamed:** every URL (including the mixed `snake_case` / `kebab-case` ones such as
  `/api/ball_valve_cal` vs `/api/feed-char/results`), error texts, `Content-Disposition` filenames,
  log texts (`📝 Config save → …`, `❌ OTA flash error:`, `API error:`).

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
   evaluates it at the same point. The check: diff the first 60 lines of `backend.log` (a 5 s
   backend-only start under the stack lock, as DESIGN-WP6 §6.3 item 5) before and after; any
   difference beyond timestamps and PIDs fails the commit.
Step 2 is its own queue item, gated in full like step 1.

5. Not in WP7 (Parked): unifying body reading, removing the never-wired `getQueryClient` /
   `getCalibrationStatus` options, renaming `routes/`.

### 6.3 Deliberately NOT changed (observable)

- Every path, method, status, body, header and text in §4.1 — including the 404-not-405 rule, the
  500 for malformed JSON on `readJsonBody` routes, the 409 for `feed-char` with no session on any
  method, `PUT /api/feed-char/results` → 405 during a session, the 503 stubs, the `/api/sensors/<x>`
  placeholder, `{"packets": []}`.
- `setImmediate` deferral of `onConfigUpdated` / `onStateCsvUpdated` and the synchronous
  `onCalibrationReload`; the response is written before the callback runs.
- `GET /api/config/profiles` calling `ensureSeeded()`; `GET /api/states` reading the **active
  profile** while `/api/pressure-limits` and `/api/gui-config` read the **deployed** config.
- `cubic_calibration` candidate order (S3) and its "partial/corrupt → `{"cubic_state":{}}`" fallback.
- SSE framing of `flash-all` (`event: …\ndata: …\n\n`), the sequential per-board flash, the OTA
  temp-dir lifecycle and 4 MB cap, the "port must be 3232" rule.
- The absent operator gate on `/api/ota-flash*` (a defect, reported below, not fixed).

---

## 7. Guarding characterization

| part | guarded by | notes |
|---|---|---|
| every GET route, idle and during a session (status, CORS, content-type, body or schema) | `pipeline/golden/http.txt` (`http_before_session`, `http_during_session`) | P9 schema for `/api/debug`, `/stats`, board logs |
| GET routes with every board type | `pipeline/golden/boards/http.txt` (`/api/sensor-config` for PT 21/22, TC, RTD, LC, T7; `ball_valve_cal`, `lc_tare`, `board-logs*`, `debug`, `config/validate`, `gui-config`, `pressure-limits`, `engine_state`) | |
| PT calibration file absent | `pipeline/golden/nocal/http.txt` | |
| error shapes: 404 ×2, OPTIONS, wrong method, 403 on 6 of the 14 gated routes, 400s, 409s, OTA 400s, video | `http.txt` `http_errors` | mutation `feed-char 409 → 410` went red |
| state CSV bodies | `pipeline/golden/csv.txt` | mutation (swap columns) went red |
| `cubic_calibration` resolves the fixture's store | `http.txt` (`GET /api/cubic_calibration` body) | a wrong root falls back to `{"cubic_state":{}}` → red |
| `POST /api/ota-flash` success and failure paths | `lifecycle/golden/ota.txt` ("backend POST /api/ota-flash: …", 6 cases) | |
| `buildSensorConfig` (T7 channels, RTD role) | `__tests__/t7.test.ts` | imports through `api-server.js` |
| `profiles/create` success with calibration | `__tests__/config-profile-create-calibration.test.ts` | drives `createAPIHandler` |
| route domain libraries | `config/golden/ts/*`, `calibration/golden/ts.txt` | untouched by WP7 |
| `board-log-mode` success | `test/ws_data_flow_test.ts` `testBoardLogMode` | gate |

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
- **H7 SSE headers and framing** of `flash-all` — covered by H2's no-boards case only for the JSON
  branch; the SSE branch stays unguarded (cannot be exercised safely on a shared machine without a
  fake `ota_service`; lifecycle's fake board could host it later).

---

## 8. Risks

- **Shared state.** None in the file (§1.2). The risk is the callbacks: a moved body must call
  `onConfigUpdated` / `onStateCsvUpdated` under the same condition and through the same
  `setImmediate`; H1 is what would notice.
- **Unrestricted `sendJson`** would turn today's hang-after-headers into a clean 500 on ~35 call
  sites — a defect fix no golden notices. §6.2 item 1 restricts it to the listed sites.
- **A group never dispatched** passes the route-table diff; the dispatch check of §6.1 catches it.
- **Import cycles.** Types in `api/http.ts`; `api/*` never imports `api-server.ts` or `server/*`. A
  grep in the DoD: `grep -l "api-server\|\.\./server/" src/api/*.ts` prints nothing.
- **Startup order.** `createAPIHandler` is called once, at `server.ts:784`, after `video.start()`;
  group modules have no import-time effects, and S2 keeps `api-server.ts`'s import list (and so the
  evaluation order of `session-manager`, `routes/*`, `ota-*`) unchanged in step 1.
- **Unawaited group calls** turn a 500 into a hang (§4.2). Reviewed per line; `tsc` does not catch it.
- **`__dirname` depth** (S3, H6).
- **The `legacy/` (`state-csv/` after WP5) state-CSV loaders.** `api-server.ts` does not import them;
  `/api/state-csv` reads and writes through `routes/config-profiles.ts` — a separate CSV reader. What
  links the two is `onStateCsvUpdated`, which makes `server.ts` rebuild its `state-csv` map; WP7 keeps
  that callback's condition (`deployed`) and timing. The loaders' `__dirname`-relative paths are not
  touched (WP7 does not move them).
- **The duplicated slot helper.** `elodinSlotFromBoardId` (96-100) is one of six copies of
  `board_id % 10, 0 → 10` (BLOAT-MAP §3 lists five; `server.ts:344-345` is the sixth, DESIGN-WP6 R5).
  WP5 does not own this copy; WP7 moves it with `buildSensorConfig` in step 1 and replaces it in step
  2.2, after H4. The frontend copy (`frontend/lib/sensor-info-entities.ts:13`) stays (frontend out of
  scope).
- **`sensor-config.ts` grows to ~570 lines** (under the 700-line god-file line). It is also WP5's
  file; WP7 must start after WP5 has merged (the DAG already says so).
- **Harness imports by path.** `config/ts_dump.ts` and `calibration/ts_harness.mts` import
  `routes/*.ts`, `sensor-config.ts`, `config-validation.ts` by path; WP7 moves none of them (it only
  appends to `sensor-config.ts`).

---

## Defects found (report, not fix)

- **`POST /api/ota-flash` and `POST /api/ota-flash/flash-all` have no operator gate.** Every other
  write checks `isConfigWriteAuthorized`; behind Caddy a signed-in non-operator can flash board
  firmware, and `flash-all` reflashes every enabled board.
- `getQueryClient` and `getCalibrationStatus` are never provided, so `/api/query` and `/api/sensors`
  always answer 503 and `/api/calibration_status` always answers the error object;
  `/api/sensors/<entity>` is a placeholder.
- Malformed JSON answers 500 on five `readJsonBody` routes (`ball_valve_cal`, `feed-char`,
  `calibration_profiles/save|load|new_blank`) and 400 everywhere else.
- A throw inside a `req.on('end')` callback outside its own try, or after `flash-all` has sent its
  headers, leaves the request without a response.
- `GET /api/config/profiles` can write (`ensureSeeded()`).

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
