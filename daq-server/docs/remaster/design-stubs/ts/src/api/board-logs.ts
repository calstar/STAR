/**
 * api/board-logs — board diagnostic logs and their verbosity.  [WP7 1.8]
 *
 * Owns: nothing (`board-logs.ts` owns the ring). Must not know about: `server/*`.
 * Contract: `http.txt` (P9 schema, 403), `ws_data_flow_test` `testBoardLogMode`.
 * Import-time effects: none.
 */

import type { IncomingMessage, ServerResponse } from '../product-types.js';
import type { APIHandlerOptions } from './http.js';

/**
 * Answers, by exact `(pathname, method)` match (WP7-S1: bodies byte-identical, each branch ends
 * `return true;`, the group ends `return false;`):
 * - `GET /api/board-logs`, `GET /api/board-logs/stats` — the ring `board-logs.ts` fills.
 * - `POST /api/board-log-mode` — gate; body in `req.on('end')` (own try → 400);
 *   `patchBoardField(id, 'enable_serial_printing', 0..3)` writes `config.toml` and the profile, even
 *   during a session; fires **no** callback (`config_broadcast_service` re-reads the file).
 */
export function handleBoardLogsRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  throw new Error('stub');
}
