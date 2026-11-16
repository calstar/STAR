/**
 * api/debug — diagnostics and the legacy stub.  [WP7 1.9]
 *
 * Owns: nothing; reads WS-side values only through the two options. Contract: `http.txt` (P9).
 * Import-time effects: none.
 */

import type { IncomingMessage, ServerResponse } from '../product-types.js';
import type { APIHandlerOptions } from './http.js';

/**
 * Answers, by exact `(pathname, method)` match (WP7-S1: bodies byte-identical, each branch ends
 * `return true;`, the group ends `return false;`):
 * - `GET /api/debug` — `opts.getDebugInfo()` (`useRelay: false` included).
 * - `GET /api/engine_state` — `opts.getEngineState()`.
 * - `GET /api/config_packets` — `{"packets": []}` (legacy stub, kept).
 */
export function handleDebugRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  throw new Error('stub');
}
