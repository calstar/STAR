/**
 * server/actuator-mismatch.ts — the 5 s commanded-vs-sensed check.
 *
 * Owns `actuatorSensedState` (last-known sensed position per entity; filled by ingest's two
 * sensed-row blocks in step 1 — they stay in ingest until G1 lands, DESIGN-WP6 2.1 / D51) and
 * the one-shot timer that compares it with engine-state's expected positions 5 s after a state
 * publish, raising or clearing the `actuator_mismatch` notification.
 *
 * Event-loop only. No effect at import (M1). Never imports api-server.ts or api/*.
 *
 * Contract: the `actuator_mismatch` key and both texts (never fired in any golden today — G1 is
 * the ball-valve case that will freeze it); the 5 s delay is a §6.5 period.
 */

import { SystemState } from '../../../shared/types.js';
import { getExpectedPositions, configStateName } from './engine-state.js';
import { activeNotificationKeys, broadcastNotification } from './notifications.js';

// ── Actuator state mismatch detection ────────────────────────────────────────

/** Last-known actuator_state per entity: [0x31] current-sense (ACT*), or a ball valve's position
 *  (BV*, see ball-valve.ts). Absent = not known, which never raises a mismatch. */
export const actuatorSensedState = new Map<string, number>();
const ACTUATOR_MISMATCH_DELAY_MS = 5000;
let actuatorMismatchTimer: NodeJS.Timeout | null = null;

export function scheduleActuatorMismatchCheck(state: SystemState): void {
  if (actuatorMismatchTimer) clearTimeout(actuatorMismatchTimer);
  actuatorMismatchTimer = setTimeout(() => {
    actuatorMismatchTimer = null;
    checkActuatorMismatch(state);
  }, ACTUATOR_MISMATCH_DELAY_MS);
}

function checkActuatorMismatch(state: SystemState): void {
  const expected = getExpectedPositions(state);
  if (Object.keys(expected).length === 0) return;

  const now = Date.now();
  const mismatched: string[] = [];

  for (const [entity, expectedPos] of Object.entries(expected)) {
    const sensed = actuatorSensedState.get(entity);
    if (sensed === undefined) continue; // no data yet — don't alert
    if (sensed !== expectedPos) {
      const expLabel = expectedPos === 1 ? 'OPEN' : 'CLOSED';
      const actLabel = sensed === 1 ? 'OPEN' : 'CLOSED';
      const name = entity.replace('ACT.', '').replace(/_/g, ' ');
      mismatched.push(`${name} (expected ${expLabel}, sensed ${actLabel})`);
    }
  }

  const key = 'actuator_mismatch';
  if (mismatched.length > 0) {
    const stateName = configStateName(state) ?? SystemState[state] ?? 'UNKNOWN';
    const msg = `Actuator mismatch in ${stateName}: ${mismatched.join(', ')}`;
    console.warn(`[ThinServer] ⚠️ ${msg}`);
    broadcastNotification({ key, category: 'warning', message: msg, timestampMs: now, ongoing: true });
    activeNotificationKeys.add(key);
  } else if (activeNotificationKeys.has(key)) {
    broadcastNotification({ key, category: 'warning', message: 'Actuator positions match expected', timestampMs: now, ongoing: false });
    activeNotificationKeys.delete(key);
  }
}
