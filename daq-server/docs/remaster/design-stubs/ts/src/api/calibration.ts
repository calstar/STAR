/**
 * api/calibration — calibration as files and live state: status, cubic store, ball-valve
 * endpoints, LC tares, calibration profiles.  [WP7 1.10]
 *
 * Owns: the module constant `SRC_DIR` (from `import.meta.url`, STYLE-S30; WP7-S3 — the two
 * `__dirname` candidates are re-rooted on it so the one-level-deeper file resolves the same
 * paths). Stores belong to `routes/calibration-profiles.ts`, `ball-valve-cal.ts`, `lc-tare.ts`,
 * and `calibration_service` (sole writer of the cubic store). Must not know about: `server/*`
 * (Elodin cmd 7 is reached through `opts.onCalibrationReload`). Contract: `http.txt` (cubic body,
 * 403 on save), H2 (load/new_blank as viewer), H3, H8. Import-time effects: none.
 */

import type { IncomingMessage, ServerResponse } from '../product-types.js';
import type { APIHandlerOptions } from './http.js';

/**
 * Answers, by exact `(pathname, method)` match (WP7-S1: bodies byte-identical, each branch ends
 * `return true;`, the group ends `return false;`):
 * - `GET /api/calibration_status` — the error object (no provider, D-API1, kept).
 * - `GET /api/cubic_calibration` — the live cubic store from four candidates, `SRC_DIR`-rooted;
 *   absent/corrupt → `{"cubic_state":{}}`. Ignores `DAQ_CALIBRATIONS_DIR` (C5-5) — **two owners of
 *   the store path** with `routes/calibration-profiles.livePath()`: kept, labelled
 *   `// Kept: C5-5 (D17)` in step 2 (WP7 [B2], STYLE-S12/S37), Parked.
 * - `GET /api/ball_valve_cal`, `POST /api/ball_valve_cal` (gate; 409 with no live position;
 *   bad JSON → 500 via the router), `GET /api/lc_tare`.
 * - `GET /api/calibration_profiles`; `POST …/save` (gate, `readJsonBody`, save, 200 list);
 *   `POST …/load`, `…/new_blank` (gate, swap the live store, then `opts.onCalibrationReload()`
 *   synchronously, then 200).
 */
export function handleCalibrationRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  throw new Error('stub');
}
