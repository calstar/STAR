/**
 * server/mission-time.ts — mission T+0 and the countdown target.
 *
 * Owns `firstPacketTimeMs` (set once, by noteFirstSample() on the first finite Elodin row) and
 * `countdownTargetMs` (read from countdown-state at startup, set by setCountdownTarget() for the
 * operator's set_countdown_target command, which also saves it and broadcasts the update). Both
 * are `export let` live bindings assigned only in this module (STYLE-S32).
 *
 * initMissionTime() is the startup read (DESIGN-WP6 §1.2 row 6); nothing is read at import (M1).
 * Never imports api-server.ts or api/*.
 *
 * Contract: MISSION_START_TIME and COUNTDOWN_TARGET_UPDATE frames and their place in the
 * connect burst are frozen in pipeline/golden/ws_handshake.txt and ws_events.txt (countdown).
 */

import { loadCountdownTargetTimeMs, saveCountdownTargetTimeMs } from '../countdown-state.js';
import { MessageType } from '../../../shared/types.js';
import { THIN_VERBOSE_CONNECTION_LOG } from './env.js';
import { broadcast } from './ws-clients.js';

export let firstPacketTimeMs: number | null = null;
export let countdownTargetMs: number | null = null;

export function initMissionTime(): void {
  countdownTargetMs = loadCountdownTargetTimeMs();
}

/** The set_countdown_target command's three statements, in order (commands.ts, step 2.2):
 *  assign, save, broadcast countdown_target_update. */
export function setCountdownTarget(ms: number | null): void {
  countdownTargetMs = ms;
  saveCountdownTargetTimeMs(countdownTargetMs);
  broadcast({ type: MessageType.COUNTDOWN_TARGET_UPDATE, timestamp: Date.now(), payload: { targetTimeMs: countdownTargetMs } });
}

/** Every finite row (ingest, step 2.1): if T+0 is unset, set it, log when verbose, broadcast mission_start_time. */
export function noteFirstSample(epochNow: number): void {
  if (firstPacketTimeMs === null) {
    firstPacketTimeMs = epochNow;
    if (THIN_VERBOSE_CONNECTION_LOG) {
      console.log(`[ThinServer] Mission T+0: ${new Date(firstPacketTimeMs).toISOString()}`);
    }
    broadcast({ type: MessageType.MISSION_START_TIME, timestamp: Date.now(), payload: { missionStartTime: firstPacketTimeMs } });
  }
}
