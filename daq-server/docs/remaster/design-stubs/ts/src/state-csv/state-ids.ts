/**
 * state-csv/state-ids — CSV state names → state ids.  [WP5: renamed from `legacy/`; unchanged]
 *
 * `LEGACY_CSV_STATE_MAP` keeps its name: it maps the legacy CSV spellings, which is accurate, and
 * nothing outside the directory reads it. Must not know about: WebSocket, the sequencer.
 */

import type { SystemState } from '../product-types.js';

/** The fixed legacy CSV spellings. */
export declare const LEGACY_CSV_STATE_MAP: Record<string, SystemState>;

/** The config's `[[states]]` name → id map when it declares at least one state; otherwise (or
 *  on any config error, caught — a decision, STYLE-S9) the legacy map whole. Read per call, never
 *  cached (a profile can be redeployed under the always-on backend). Does not merge the two. */
export function csvStateMap(): Record<string, SystemState> {
  throw new Error('stub');
}
