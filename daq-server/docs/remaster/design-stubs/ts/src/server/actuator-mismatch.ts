/**
 * server/actuator-mismatch — the commanded-vs-sensed check, 5 s after each state publish.
 * [WP6 1.12, layer 4]
 *
 * Owns: `actuatorSensedState` (entity → last sensed 0/1; absent = unknown, never alerts) and the
 * single pending check timer (a new schedule replaces it).
 * Must not know about: where states come from (`engine-state`), how notifications are stored
 * (`notifications`), Elodin. Imports `engine-state`, `notifications`, `ball-valve`.
 * Contract: `actuator_mismatch` notification text `Actuator mismatch in <state>: <name> (expected
 * X, sensed Y)` / `Actuator positions match expected`, the 5 s delay, the warn line. **No golden
 * fires it yet (gap G1, MUST before 2.1 moves the two sensed-row blocks; without it they stay in
 * `ingest`, D51).**
 * Import-time effects: none.
 */

import type { ParsedSensorData, SystemState } from '../product-types.js';

/** [step 1] Written by `ingest`'s per-row blocks until 2.1. */
export declare const actuatorSensedState: Map<string, number>;

/** Replace any pending check with one that runs `ACTUATOR_MISMATCH_DELAY_MS` (5000) later for
 *  `state` (captured now, not read later). */
export function scheduleActuatorMismatchCheck(state: SystemState): void {
  throw new Error('stub');
}

/**
 * [step 2.1] One finite row: a ball valve's `position_pct` → its sensed state (delete when
 * travelling / no signal, reading `cal_status` from the same packet's `rows`); an
 * `actuator_state` row → set. Either way, if it changed while `actuator_mismatch` is raised,
 * re-schedule for `engine-state.currentState`. Both blocks, in today's order. Exists only once G1
 * has landed (D51).
 */
export function noteSensedRow(row: ParsedSensorData, rows: ReadonlyArray<ParsedSensorData>): void {
  throw new Error('stub');
}
