/**
 * api/config — the editor's config document: read, save, export, import, validate.  [WP7 1.3]
 *
 * Owns: no state; the active profile and `config.toml` belong to `routes/config-profiles.ts` /
 * `routes/config.ts`. Must not know about: `server/*` (reached only through
 * `opts.onConfigUpdated`), other groups. Callback timing (STYLE-S29): the response is written
 * first, `onConfigUpdated` runs on the next `setImmediate`, and only when no session is active.
 * Contract: `pipeline/golden/http.txt` (GETs, 403s); H1 freezes the write success paths and their
 * `config_updated` / `board_status_update` frames before step 1. Import-time effects: none.
 */

import type { IncomingMessage, ServerResponse } from '../product-types.js';
import type { APIHandlerOptions } from './http.js';

/**
 * Answers, by exact `(pathname, method)` match (WP7-S1: bodies byte-identical, each branch ends
 * `return true;`, the group ends `return false;`):
 * - `GET /api/config` — the active profile (the editor's draft) and its name.
 * - `GET /api/config/running` — the deployed config and its path.
 * - `POST /api/config` — gate; body in `req.on('end')` (own try → 400); PWM check → 400; save to the
 *   profile; idle → deploy + `setImmediate(onConfigUpdated)`; logs `📝 Config save → …`.
 * - `GET /api/config/export` — raw `config.toml`, `Content-Disposition: attachment`; 500 on read error.
 * - `POST /api/config/import` — gate; write, re-parse, PWM check, roll back on error (400); idle → deploy.
 * - `GET /api/config/validate` — `validateActiveProfile()`.
 */
export function handleConfigRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  throw new Error('stub');
}
