/**
 * api/gui-config — the deployed config as the GUI lays it out.  [WP7 1.7]
 *
 * Owns: nothing. Must not know about: `server/*`, the editor's draft (it reads the deployed
 * config, unlike `api/states`; frozen). Contract: `pipeline/golden/http.txt`,
 * `boards/http.txt` (every board type), `__tests__/t7.test.ts` (via the re-export). H4 (slot
 * 0 → 10) is worth writing but does not gate 2.2, which is proven by a diff (D63).
 * Import-time effects: none.
 */

import type { IncomingMessage, ServerResponse } from '../product-types.js';
import type { APIHandlerOptions } from './http.js';

/**
 * Answers, by exact `(pathname, method)` match (WP7-S1: bodies byte-identical, each branch ends
 * `return true;`, the group ends `return false;`):
 * - `GET /api/pressure-limits`, `GET /api/gui-config` — the **deployed** config (cache).
 * - `GET /api/sensor-config` — `buildSensorConfig()` from `../sensor-config.js`.
 */
export function handleGuiConfigRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  throw new Error('stub');
}
