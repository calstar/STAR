/**
 * server/engine-state — the sequencer's state as the backend reports it: current state, debug
 * mode, allowed set, refusal reasons, the CSV-derived commanded positions, and (after step 2.9)
 * what a GUI state id means.  [WP6 1.11, layer 3]
 *
 * Owns: `currentState`, `debugMode`, `allowedBitmask`, `stateRefusalReasons`,
 * `stateActuatorMap`; both `state_update` shapes (broadcast and, after 2.8, connect); state-id
 * resolution (after 2.9). The sequencer is the authority: nothing here is optimistic — state
 * changes only from `_SEQUENCER_STATE` or an `ok` `DEBUG_MODE` reply.
 * Must not know about: sockets' identity or arming (`ws-connection`, `commands`), Elodin
 * connection state, HTTP (`api/debug` reads `currentState` through the `getEngineState` option).
 * Imports `ws-clients`, `history`, `stats`, `sequencer-client` (SCRIPTS poll), `state-csv/*`,
 * `script-status`, `routes/config`.
 * Contract: `state_update` (two shapes — connect has no `allowedBitmask`/`stateRefusalReasons`),
 * the double `state_update` on `debug_mode` (C5-3, kept), commanded `sensor_update`s
 * (`actuator_state_commanded`), the 15 s SCRIPTS poll skipped between runs —
 * `pipeline/golden/ws_events.txt`, `ws_handshake.txt`.
 * Import-time effects: none; `server.ts` calls `reloadStateActuatorMap()` at row 11 (uncaught: a
 * throw there kills the process before the crash guards, as today), `initEngineState()` at row
 * 15, and registers `setInterval(refreshScriptStatus, 15000)` at row 26.
 */

import type { SystemState, WebSocket } from '../product-types.js';
import type { StateActuatorMap } from '../state-csv/state-actuators.js';

export declare let currentState: SystemState;
export declare let debugMode: boolean;
/** Step 1 name `STATE_ACTUATOR_MAP` (renamed in 2.5, STYLE-S6). */
export declare let stateActuatorMap: StateActuatorMap;

/** Row 15: `currentState = configBootStateId()` (the config's `is_boot` state, else IDLE). */
export function initEngineState(): void {
  throw new Error('stub');
}

/** `stateActuatorMap = getStateActuatorMap()`. Throws through: row 11 leaves it uncaught; the
 *  two reload callers keep their own try/catch and warning texts. */
export function reloadStateActuatorMap(): void {
  throw new Error('stub');
}

/** The deployed config's name for a state id, or null (no `[[states]]`, unknown id, config error). */
export function configStateName(id: number): string | null {
  throw new Error('stub');
}

/** Telemetry entity (`ACT<n>.CH<m>` / `BV…`, else `CSV_ACTUATOR_TO_ENTITY`, else `ACT.<Name>`)
 *  → expected 0/1 for `state`. */
export function getExpectedPositions(state: SystemState): Record<string, number> {
  throw new Error('stub');
}

/** For each CSV actuator of `state` that resolves: record to history, count, broadcast a
 *  `actuator_state_commanded` SENSOR_UPDATE (frame and payload stamped with one `epochNow`). */
export function broadcastCommandedActuatorsForState(state: SystemState): void {
  throw new Error('stub');
}

/** The broadcast `state_update` (with `allowedBitmask`, `stateRefusalReasons`). */
export function broadcastStateUpdate(): void {
  throw new Error('stub');
}

/** The SCRIPTS poll: skipped when no pipeline is expected; else `sendToSequencer('SCRIPTS\n')`
 *  and store the parsed reasons; a failed reply leaves the old reasons; never notifies. */
export function refreshScriptStatus(): void {
  throw new Error('stub');
}

/** [step 1] Setter for `commands`' `debug_mode` reply (WP6 §6.2). */
export function setDebugMode(value: boolean): void {
  throw new Error('stub');
}

/** `_SEQUENCER_STATE` rows: set allowed set, state, debug (counting the packet, verbose log), then
 *  `broadcastStateUpdate()` and `broadcastCommandedActuatorsForState(currentState)`. The caller
 *  (`ingest`) then schedules the mismatch check — order frozen (WP6 row 1.11). */
export function applySequencerState(rows: ReadonlyArray<{ entity: string; component: string; value: number }>): void {
  throw new Error('stub');
}

/** [step 2.8, A4] Connect burst: the connect-shape `state_update`; returns 1. */
export function sendConnectStateUpdate(ws: WebSocket): number {
  throw new Error('stub');
}

/** [step 2.8, A4] Connect burst: one `actuator_state_commanded` SENSOR_UPDATE per resolvable CSV
 *  actuator of `currentState` (no history, no stats — as today); returns how many. */
export function sendCommandedSnapshot(ws: WebSocket): number {
  throw new Error('stub');
}

/** [step 2.9, A3] What a GUI state id means to the sequencer. */
export type TransitionTarget =
  | { ok: true; stateName: string; csvName: string }
  /** The active config declares `[[states]]` and not this id: refuse, never fall back to the enum. */
  | { ok: false };

/**
 * [step 2.9, A3] Resolve a `state_transition` id. Reads in today's order: `configStateName(id)`
 * (deployed-config cache), then `readConfig().states` (a read error → treated as "declares none").
 * Declared → its name for both; undeclared with no `[[states]]` → `SystemState[id]` or the id,
 * mapped through `STATE_TO_CSV_NAME`. `commands` keeps the warning, the `ERROR` text, the
 * `holdMs` check (after this) and the line format.
 */
export function resolveTransitionTarget(id: number): TransitionTarget {
  throw new Error('stub');
}
