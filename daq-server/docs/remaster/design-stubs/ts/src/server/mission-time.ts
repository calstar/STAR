/**
 * server/mission-time — mission T+0 (first data row) and the countdown target.
 * [WP6 1.6, layer 2]
 *
 * Owns: `firstPacketTimeMs` (null until the first finite row after process start) and
 * `countdownTargetMs` (persisted through `countdown-state.ts`).
 * Must not know about: Elodin, commands' validation, HTTP. Imports `ws-clients`,
 * `countdown-state`, `env`. `server.ts` keeps its own `countdown-state.js` import at its
 * position (WP6 row 1.6; with WP6-R1a it may need to be a bare import — the module-order diff
 * decides).
 * Contract: `mission_start_time` and `countdown_target_update` frames
 * (`pipeline/golden/ws_events.txt`, `ws_handshake.txt`).
 * Import-time effects: none; `initMissionTime()` reads the saved target at WP6 §1.3 row 6.
 */

import type { WebSocket } from '../product-types.js';

export declare let firstPacketTimeMs: number | null;
export declare let countdownTargetMs: number | null;

/** Row 6: `countdownTargetMs = loadCountdownTargetTimeMs()` (disk read, no log). */
export function initMissionTime(): void {
  throw new Error('stub');
}

/** [step 1] Setter for `ingest`'s former assignment (WP6 §6.2). */
export function setFirstPacketTimeMs(ms: number): void {
  throw new Error('stub');
}

/** [step 1] Setter for `commands`' former assignment (WP6 §6.2). */
export function setCountdownTargetMs(ms: number | null): void {
  throw new Error('stub');
}

/** [step 2.1] If T+0 is unset: set it to `epochNow`, log when verbose, broadcast
 *  `mission_start_time`. Called for every finite row, in the row order of WP6 §3.3 step 6. */
export function noteFirstSample(epochNow: number): void {
  throw new Error('stub');
}

/** [step 2] Assign, save, broadcast `countdown_target_update` — the `set_countdown_target`
 *  command's three statements, in order. */
export function setCountdownTarget(ms: number | null): void {
  throw new Error('stub');
}

/** [step 2.8, A4] Connect burst: `mission_start_time` if T+0 is set; returns 0 or 1. The
 *  connection's counter ignores it, as today (D-WS quirk, kept). */
export function sendMissionStartTime(ws: WebSocket): number {
  throw new Error('stub');
}

/** [step 2.8, A4] Connect burst: `countdown_target_update` (always); returns 1. */
export function sendCountdownTarget(ws: WebSocket): number {
  throw new Error('stub');
}
