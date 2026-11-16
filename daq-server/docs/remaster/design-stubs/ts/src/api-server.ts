/**
 * api-server — the HTTP router for every `/api/*` path.  [WP7, after step 1: ~90 lines]
 *
 * Owns: the `/api/` prefix test (non-`/api/` → `false`, `server.ts` answers a bare 404), the
 * three CORS headers on every `/api/*` response, `OPTIONS` → 200 empty, the URL parse, the
 * dispatch order, the JSON 404 `{"error":"Not found"}` (a known path with the wrong method is
 * 404, never 405 — except feed-char's own 405), and **one** try/catch → 500 `{"error": message}`
 * logged `API error:`. Owns no state.
 *
 * Dispatch, inside the one try, in today's first-occurrence order (WP7-S1):
 * `if (video && url.pathname.startsWith('/api/video/')) { await handleVideoRequest(…); return true; }`
 * then `if (await handle<Group>Request(req, res, url, opts)) return true;` for config, states,
 * profiles, history, gui-config, board-logs, debug, calibration, feed-char, ota — always awaited
 * (STYLE-S28: an unawaited group turns a 500 into a hang); then the 404.
 *
 * Imports: all of today's imports in today's positions (WP7-S2), an import step 1 leaves without
 * a value use rewritten as a bare `import './x.js';` at its position when the module-order diff
 * shows it evaluating there (WP7 [B1]; never for the already-elided `./elodin-query.js`, `http`),
 * then the `./api/*.js` imports. Must not know about: `server/*` (STYLE-S31).
 * Path-coupled users: `server.ts:35`, `__tests__/config-profile-create-calibration.test.ts`
 * (`createAPIHandler`), `__tests__/t7.test.ts` (`buildSensorConfig`) — hence the re-exports.
 * Import-time effects: none of its own.
 */

import type { IncomingMessage, ServerResponse } from './product-types.js';
import type { APIHandlerOptions } from './api/http.js';

export { buildSensorConfig, type SensorConfigEntry } from './sensor-config.js';
export type { APIHandlerOptions, BoardScanRateHz, DebugInfo } from './api/http.js';

/** Build the handler `server.ts` awaits for every request that is not `/stats`. Resolves `true`
 *  if it answered (including every error it answered), `false` for a non-`/api/` path. */
export function createAPIHandler(
  opts?: APIHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  throw new Error('stub');
}
