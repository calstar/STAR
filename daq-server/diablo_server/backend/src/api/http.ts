/**
 * api/http — what every route group shares about HTTP: the option types, the operator gate and
 * the JSON body reader.  [WP7 1.1]
 *
 * Owns: `APIHandlerOptions` (built once by `server.ts` — the one seam from the HTTP side to the
 * WS side, STYLE-S31), `DebugInfo`, `BoardScanRateHz`; the gate rule (empty `X-Auth-Email` → no
 * proxy in front → operator; else the allowlist); the JSON body reader. The types live here, not
 * in `api-server.ts`, so no `api/*` file imports the router, not even for a type.
 * Must not know about: any route, `server/*` (never imported, STYLE-S31), sessions.
 * Contract: the 403 body `{"error":"Not an approved operator"}` before any body is read (every
 * gated route is frozen as the viewer by H8, `pipeline/golden/http.txt` `http_viewer_gates`);
 * the `Invalid JSON body` rejection (→ 500 on the `readJsonBody` routes that do not catch, a kept
 * inconsistency, D-API2). Import-time effects: none.
 *
 * Route-group signature, as documentation only (nothing new is declared, WP7 §2, STYLE-S34):
 * `(req, res, url, opts: APIHandlerOptions) => Promise<boolean>` — `true` iff it answered. Each
 * group destructures only the option members its bodies name (WP7-S4).
 */

import { IncomingMessage } from 'http';
import { isOperator } from '../operators.js';
import type { VideoService } from '../video/service.js';

/**
 * Average Hz of primary raw streams per board group from relay ingest (pre-WS-throttle).
 * Dynamic keys: `pt<n>` per PT board (n = board_id % 10) plus aggregated `tc`/`rtd`/`lc`/`act`/`enc`.
 * A group only appears once it has seen data — read a missing group as 0.
 */
export type BoardScanRateHz = Record<string, number>;

export interface DebugInfo {
  ingestConnected: boolean;
  ingestPacketsReceived: number;
  heartbeatPacketsReceived?: number;
  wsClients: number;
  sensorCacheSize: number;
  useRelay: boolean;
  boardScanRateHz?: BoardScanRateHz;
}

export interface APIHandlerOptions {
  getDebugInfo?: () => DebugInfo | null;
  onConfigUpdated?: () => void;
  /** A state-machine CSV was saved and deployed: rebuild the maps the always-on backend derives
   *  from it and tell browsers to refetch. Nothing is pushed to the run pipeline — it picks the
   *  CSVs up at the next session start, which is the only point config is applied. */
  onStateCsvUpdated?: () => void;
  getEngineState?: () => number;
  getCalibrationStatus?: () => Promise<any>;
  /** A calibration profile was loaded / a blank was created on disk: tell the calibration service
   *  to re-read the live store (cmd 7) so the swap takes effect without a session restart. */
  onCalibrationReload?: () => void;
  /** The VIDCOMM video pane's backend; /api/video/* answers 404 without it. */
  video?: VideoService;
}

/**
 * Config edits require an approved operator. Identity is the `X-Auth-Email`
 * header Caddy injects on every proxied request; an empty header means no proxy
 * in front (local/dev/test stand) and is treated as operator — same rule the WS
 * control path uses in server.ts. Present-but-not-allowlisted → denied.
 */
export function isConfigWriteAuthorized(req: IncomingMessage): boolean {
  const authEmail = ((req.headers['x-auth-email'] as string | undefined) || '').trim();
  return authEmail === '' ? true : isOperator(authEmail);
}

/** Collect and JSON-parse a request body. Rejects on invalid JSON. */
export function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(body.trim() ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
