/**
 * api/http — what every route group shares about HTTP: the option types, the operator gate, body
 * reading, and (step 2) the two response helpers.  [WP7 1.1]
 *
 * Owns: `APIHandlerOptions` (built once by `server.ts` — the one seam from the HTTP side to the
 * WS side, STYLE-S31), `DebugInfo`, `BoardScanRateHz`; the gate rule (empty `X-Auth-Email` → no
 * proxy in front → operator; else the allowlist); the JSON body reader. The types live here, not
 * in `api-server.ts`, so no `api/*` file imports the router, not even for a type.
 * Must not know about: any route, `server/*` (never imported, STYLE-S31), sessions.
 * Contract: the 403 body `{"error":"Not an approved operator"}` before any body is read; the
 * `Invalid JSON body` rejection (→ 500 on the five `readJsonBody` routes that do not catch, a
 * frozen inconsistency, H3).
 * Import-time effects: none.
 *
 * Route-group signature, as documentation only (nothing new is declared, WP7 §2, STYLE-S34):
 * `(req, res, url, opts: APIHandlerOptions) => Promise<boolean>` — `true` iff it answered. Each
 * group destructures only the option members its bodies name (WP7-S4).
 */

import type { ElodinQueryClient, IncomingMessage, ServerResponse, VideoService } from '../product-types.js';

/** Average Hz of primary raw streams per board group, pre-throttle; a missing group reads as 0. */
export type BoardScanRateHz = Record<string, number>;

/** `/api/debug` body (verbatim; `server.ts`'s `getDebugInfo` adds buffer/heap fields). */
export interface DebugInfo {
  ingestConnected: boolean;
  ingestPacketsReceived: number;
  heartbeatPacketsReceived?: number;
  wsClients: number;
  sensorCacheSize: number;
  useRelay: boolean;
  boardScanRateHz?: BoardScanRateHz;
}

/** The callbacks and providers `server.ts` passes to `createAPIHandler`. Verbatim. */
export interface APIHandlerOptions {
  /** Never passed (D-API1): `/api/query`, `/api/sensors` always 503. Kept. */
  getQueryClient?: () => ElodinQueryClient | null;
  getDebugInfo?: () => DebugInfo | null;
  /** Deferred with `setImmediate` after the response by config save/import (idle) and profile
   *  switch → `server.ts` `applyDeployedConfigChange`. H1's ordering vitest (D72) asserts
   *  `res.writableEnded === true` inside a mock of it at each of the three sites. */
  onConfigUpdated?: () => void;
  /** Deferred after a deployed state-CSV save → rebuild the state-actuator map, `config_updated`.
   *  Same vitest, fourth site. */
  onStateCsvUpdated?: () => void;
  /** Reads `engine-state.currentState`. */
  getEngineState?: () => number;
  /** Never passed (D-API1): `/api/calibration_status` always the error object. Kept. */
  getCalibrationStatus?: () => Promise<any>;
  /** Called synchronously, before the response, by calibration profile load / new_blank →
   *  `publishCalibrationReload` (Elodin cmd 7). */
  onCalibrationReload?: () => void;
  /** The video pane's backend; `/api/video/*` answers 404 (JSON) without it. */
  video?: VideoService;
}

/** The operator gate for every gated write (14 routes; the two OTA routes have none — D-OTA /
 *  SEC-2, kept). All 14 and `POST /api/ota-flash` are frozen as the viewer by the H8 package (C0,
 *  gates step 1; security ruling) before any of them moves; `flash-all`'s viewer 200 is H9's
 *  vitest (D72: no harness has a config with no enabled boards). */
export function isConfigWriteAuthorized(req: IncomingMessage): boolean {
  throw new Error('stub');
}

/** Collect the body; empty → `{}`; rejects `Error('Invalid JSON body')` on bad JSON, or the
 *  request's own error. */
export function readJsonBody(req: IncomingMessage): Promise<any> {
  throw new Error('stub');
}

/**
 * [step 2.1] `writeHead(status, {'Content-Type':'application/json'})` then
 * `end(JSON.stringify(body))` — same body as `video/routes.ts:38` (WP7 §5), so `writeHead` still
 * runs before `stringify`. **Restricted** (WP7 §6.2, D39, STYLE-S10) to the 50 sites whose
 * `body` is built from literals and already-evaluated locals (41 pairs keep the raw form):
 * anywhere else it would evaluate a throwing expression before `writeHead` and silently turn
 * today's hang (D-API3) into a 500. A check script in the package (no linter, STYLE-S40)
 * identifies sites **by content**, not line number: the body argument, string literals stripped
 * (template-literal `${…}` interpolations kept), may contain no `(` and no `.` outside `?.`; the
 * reviewer confirms each call replaces exactly one adjacent `writeHead`/`end` pair.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  throw new Error('stub');
}

/** [step 2.1] If `!isConfigWriteAuthorized(req)`: write the literal 403 and return `true`
 *  (the caller then `return true`s); else `false`. Replaces 14 identical blocks, every one frozen
 *  as a viewer 403 by the H8 package since before step 1. */
export function denyUnlessOperator(req: IncomingMessage, res: ServerResponse): boolean {
  throw new Error('stub');
}
