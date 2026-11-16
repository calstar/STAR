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
 * fires it yet (gap G1, MUST before commits 1.11/1.12).**
 * Import-time effects: none.
 */

import type { NotificationPayload, ParsedSensorData, SystemState } from '../product-types.js';

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
 * re-schedule for `engine-state.currentState`. Both blocks, in today's order.
 */
export function noteSensedRow(row: ParsedSensorData, rows: ReadonlyArray<ParsedSensorData>): void {
  throw new Error('stub');
}

/**
 * [step 2.10, debate verdict] The pure decision of `checkActuatorMismatch` (server.ts:489-516 minus
 * the sends): `null` when `expected` is empty (:490); else the `actuator_mismatch` raise payload
 * (`ongoing:true`, `Actuator mismatch in <stateName>: …`) when any entity with a sensed value
 * differs, the clear payload (`ongoing:false`, `Actuator positions match expected`) when nothing
 * differs and `mismatchActive`, otherwise `null`. Today's literals and key order (G9). No read of
 * module state, no clock, no log, no send: the timer callback fetches `getExpectedPositions`,
 * `configStateName(state) ?? SystemState[state] ?? 'UNKNOWN'` (hoisted: a listed non-verbatim
 * edit) and `activeNotificationKeys.has('actuator_mismatch')`, keeps `const now = Date.now()`
 * (:492), then warns, sends and records what this returns. Owners send; decisions return.
 */
export function mismatchVerdict(
  expected: Readonly<Record<string, number>>,
  sensed: ReadonlyMap<string, number>,
  stateName: string,
  mismatchActive: boolean,
  now: number,
): NotificationPayload | null {
  throw new Error('stub');
}
