/**
 * api/feed-char — feed-characterization results stored with the run.  [WP7 1.11]
 *
 * Owns: nothing; the file lives in the session's `dbDir`. The one method-agnostic path (it is
 * still an exact pathname, so WP7-S1's disjointness holds). Contract: `http.txt` (409, GET, POST
 * 500), H5 (405), H8 (403 during a session). Import-time effects: none.
 */

import type { IncomingMessage, ServerResponse } from '../product-types.js';
import type { APIHandlerOptions } from './http.js';

/**
 * Answers, by exact `(pathname, method)` match (WP7-S1: bodies byte-identical, each branch ends
 * `return true;`, the group ends `return false;`):
 * - `/api/feed-char/results`, **any method**: no session → 409; `GET` → the run's JSONL as
 *   `results`; `POST` → gate, append one line (mock mode: 500 ENOENT, C5-2, kept); else 405.
 */
export function handleFeedCharRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  throw new Error('stub');
}
