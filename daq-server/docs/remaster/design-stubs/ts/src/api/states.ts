/**
 * api/states — the state machine as files: state list, state CSVs, dynamic-state scripts.
 * [WP7 1.4]
 *
 * Owns: no state. Reads and writes through `routes/config-profiles.ts` (a CSV reader separate
 * from `state-csv/*`, by design); scripts are checked by `routes/script-check.ts`. Must not know
 * about: `server/*` (the rebuilt actuator map is `server.ts`'s, via `opts.onStateCsvUpdated`).
 * Contract: `pipeline/golden/csv.txt`, `http.txt`; H1/H8 before the moves.
 * Import-time effects: none.
 */

import type { IncomingMessage, ServerResponse } from '../product-types.js';
import type { APIHandlerOptions } from './http.js';

/**
 * Answers, by exact `(pathname, method)` match (WP7-S1: bodies byte-identical, each branch ends
 * `return true;`, the group ends `return false;`):
 * - `GET /api/states` — the **active profile**'s `[[states]]` and `[flow]`.
 * - `GET /api/state-csv`, `POST /api/state-csv` — gate; deployed → `setImmediate(onStateCsvUpdated)`.
 * - `GET /api/state-script` (missing name → 200, empty body; C5-6, kept), `POST /api/state-script`
 *   (gate; `checkStateScript` before save), `POST /api/state-script/check` (no gate, no write).
 */
export function handleStatesRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  throw new Error('stub');
}
