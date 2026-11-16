/**
 * api/profiles — named config profiles.  [WP7 1.5]
 *
 * Owns: no state (`routes/config-profiles.ts`, `routes/calibration-profiles.ts` do). Must not
 * know about: `server/*`. Contract: `http.txt` (switch 403/409),
 * `__tests__/config-profile-create-calibration.test.ts` (drives `createAPIHandler`); H1/H8.
 * Import-time effects: none.
 */

import type { IncomingMessage, ServerResponse } from '../product-types.js';
import type { APIHandlerOptions } from './http.js';

/**
 * Answers, by exact `(pathname, method)` match (WP7-S1: bodies byte-identical, each branch ends
 * `return true;`, the group ends `return false;`):
 * - `GET /api/config/profiles` — list; calls `ensureSeeded()` (a GET that may write, D-API2, kept).
 * - `POST /api/config/profiles/switch` — gate; `readJsonBody` in its own try (bad JSON → 400); 409
 *   during a session; switch; `setImmediate(onConfigUpdated)`.
 * - `POST …/create` (optional calibration profile, rolled back if the config create fails),
 *   `…/rename`, `…/delete` — gate; local try → 400.
 */
export function handleProfilesRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  throw new Error('stub');
}
