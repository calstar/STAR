/**
 * api/ota — firmware projects and over-the-air flashing.  [WP7 1.12]
 *
 * Owns: the OTA temp directories for the duration of one request; `MAX_BODY` and the SSE closure
 * move inside the body unchanged. Must not know about: `server/*`, sessions. Talks to
 * `ota_service` through `ota-service-cmd.ts`. Contract: `lifecycle/golden/ota.txt` (6 cases),
 * `http.txt` (400s); H2 freezes `flash-all` only against a config with no enabled boards.
 * Import-time effects: none.
 */

import type { IncomingMessage, ServerResponse } from '../product-types.js';
import type { APIHandlerOptions } from './http.js';

/**
 * Answers, by exact `(pathname, method)` match (WP7-S1: bodies byte-identical, each branch ends
 * `return true;`, the group ends `return false;`):
 * - `GET /api/ota-flash/projects`.
 * - `POST /api/ota-flash/flash-all` — **no operator gate (D-OTA, kept)**; no enabled boards → 200
 *   `{success:false,…}`; else Server-Sent Events, one sequential `otaBuildFlash` per enabled board.
 *   A throw after the SSE headers leaves the response open (D-API3, kept).
 * - `POST /api/ota-flash` — **no gate (D-OTA)**; 4 MB cap → 413; missing ip / port ≠ 3232 / no
 *   payload → 400; `projectPath` build+flash or a base64 file through a temp dir removed in
 *   `finally`; flash failure → 200 `{success:false, error}`.
 */
export function handleOtaRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  throw new Error('stub');
}
