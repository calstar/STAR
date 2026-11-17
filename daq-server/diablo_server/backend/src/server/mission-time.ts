/**
 * server/mission-time.ts — mission T+0 and the countdown target.
 *
 * Owns `firstPacketTimeMs` (set once, by ingest, on the first finite Elodin row) and
 * `countdownTargetMs` (read from countdown-state at startup, set by the operator's
 * set_countdown_target command). Both are `export let` live bindings; only the two setters here
 * assign them (STYLE-S32, DESIGN-WP6 §6.2) — ingest and commands call the setters and keep
 * their own broadcasts and the countdown-state save where they are today.
 *
 * initMissionTime() is the startup read (DESIGN-WP6 §1.2 row 6); nothing is read at import (M1).
 * Never imports api-server.ts or api/*.
 *
 * Contract: MISSION_START_TIME and COUNTDOWN_TARGET_UPDATE frames and their place in the
 * connect burst are frozen in pipeline/golden/ws_handshake.txt and ws_events.txt (countdown).
 */

import { loadCountdownTargetTimeMs } from '../countdown-state.js';

export let firstPacketTimeMs: number | null = null;
export let countdownTargetMs: number | null = null;

export function initMissionTime(): void {
  countdownTargetMs = loadCountdownTargetTimeMs();
}

export function setFirstPacketTimeMs(ms: number): void {
  firstPacketTimeMs = ms;
}

export function setCountdownTargetMs(ms: number | null): void {
  countdownTargetMs = ms;
}
