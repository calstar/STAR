/**
 * state-csv/state-transitions — the allowed-transition list from the state-transitions CSV.
 * [WP5: renamed from `legacy/`; surviving surface]
 *
 * Read on every `get_state_transitions` WS request (`server/commands`), never cached. Must not
 * know about: WebSocket, the sequencer (which enforces transitions itself — this list only feeds
 * the GUI's diagram).
 *
 * Deleted by WP5 5.4 (no caller): `buildTransitionMap`, `isTransitionAllowed`, `_transitionMap`.
 * With them goes the module's only *value* use of `SystemState` (`SystemState[id]`), so 5.4 makes
 * the product's `import { SystemState } from '../shared-types.js'` an explicit `import type`;
 * `shared-types.ts` then leaves the esbuild module order and is dead code (DESIGN-WP5 §1.1, D60).
 * Short rows read left-aligned (C2-8, known NEEDS-REPAIR): kept.
 */

import type { SystemState } from '../product-types.js';

/** One allowed transition. (Module-private type today; exported here only to name the return.) */
export interface Transition {
  from: SystemState;
  to: SystemState;
}

/** Parse one CSV file; `[]` with an error log on failure. */
export function parseStateTransitionsCSV(csvPath: string): Transition[] {
  throw new Error('stub');
}

/** Find and parse the transitions CSV (config path, then fallbacks); `[]` when none is found. */
export function getStateTransitions(): Transition[] {
  throw new Error('stub');
}
