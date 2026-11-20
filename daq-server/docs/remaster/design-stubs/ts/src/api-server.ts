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
 * Imports: all of today's imports in today's positions (WP7-S2), then the `./api/*.js` imports.
 * Exactly seven go bare (`import './x.js';` at the same line, WP7-S2a, each in the commit that
 * moves its last value user out): `operators` (1.1), `routes/script-check` (1.4),
 * `routes/config-profiles` (1.5), `board-logs` (1.8), `session-manager` (1.11), `ota-build` and
 * `ota-service-cmd` (1.12). None for `config-validation` (already evaluated inside
 * `session-manager`'s subtree), for anything `server.ts:29-31` evaluated first, or for the
 * type-only `./elodin-query.js`, `./shared-types.js`, `./video/service.js`, `http` (a bare import
 * there would add a module). Commit 1.13 (D72) deletes the dead `__dirname` const, the four
 * builtin imports (`fs`, `os`, `path`, `url`) and the ten named-import declarations left without a
 * value use — `routes/config`, `routes/calibration-profiles`, `sensor-config`, `config-validation`,
 * `elodin-query`, `shared-types`, `lc-tare`, `../../shared/config-validation`, `video/service`,
 * `ball-valve-cal` (17 lines, every one already elided at runtime; proof: tsc exit 0, the order
 * diff empty, `grep -w` per name printing nothing). What remains below is the whole import block:
 * `http` (the signature's types), the seven bare imports, `video/routes`, the ten `./api/*.js`
 * imports, the two re-export lines. Step 2.4 labels the seven. The esbuild module-order diff
 * against the parent commit (filtered on `src/api/`) is the check. Must not know about:
 * `server/*` (STYLE-S31).
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
