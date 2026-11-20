/**
 * api/history — Elodin historical queries; all three depend on `opts.getQueryClient`, which
 * `server.ts` never passes (D-API1, kept; removing the option is Parked).  [WP7 1.6]
 *
 * `ElodinQueryClient` is a type-only import here as in `api-server.ts` today: it is elided at
 * runtime, and must **not** become a bare import (that would add `elodin-query.ts` to the
 * evaluation set — WP7 [B1]). Import-time effects: none.
 */

import type { IncomingMessage, ServerResponse } from '../product-types.js';
import type { APIHandlerOptions } from './http.js';

/**
 * Answers, by exact `(pathname, method)` match (WP7-S1: bodies byte-identical, each branch ends
 * `return true;`, the group ends `return false;`):
 * - `GET /api/query` — 503 `Query client not available` without `getQueryClient` (always, D-API1).
 * - `GET /api/sensors` — same 503.
 * - `GET /api/sensors/<entity>` (prefix) — placeholder body (kept).
 */
export function handleHistoryRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  throw new Error('stub');
}
