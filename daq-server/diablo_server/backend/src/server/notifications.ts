/**
 * server/notifications.ts — operator notifications and their 5-minute replay buffer.
 *
 * Owns `activeNotificationKeys` (which keyed notifications are currently raised) and
 * `notificationBuffer` (what a late-connecting browser is replayed). In step 1 both are
 * exported as the mutable containers they were, because the raise/clear pairs still sit in
 * board-status, actuator-mismatch and ingest (DESIGN-WP6 R3); step 2.2 makes this module the
 * only writer. ws-connection.ts reads the buffer for the connect burst and prunes it first.
 *
 * Event-loop only. No effect at import (M1). Never imports api-server.ts or api/*.
 *
 * Contract: notification keys (`board_lost_<id>`, `setup_stuck_<id>`, `unrecognized_<id>`,
 * `self_test_fail_<id>`, `actuator_mismatch`), texts and the 5 min / 500 buffer bound are
 * frozen in pipeline/golden/boards/ws_events.txt and ws_streams.txt (P1, P1b, P12).
 */

import { broadcast } from './ws-clients.js';
import { MessageType } from '../../../shared/types.js';
import type { NotificationPayload } from '../../../shared/types.js';

export const activeNotificationKeys = new Set<string>();

// Rolling notification history so a reloaded/late-connecting browser recovers the
// last few minutes of warnings/info instead of starting blank. Replayed on connect.
const NOTIFICATION_BUFFER_MS = 5 * 60 * 1000;
const NOTIFICATION_BUFFER_MAX = 500; // hard cap so a flapping alert can't grow it unbounded
export const notificationBuffer: { at: number; payload: NotificationPayload }[] = [];

export function pruneNotificationBuffer(now: number): void {
  const cutoff = now - NOTIFICATION_BUFFER_MS;
  while (notificationBuffer.length > 0 && notificationBuffer[0].at < cutoff) notificationBuffer.shift();
  if (notificationBuffer.length > NOTIFICATION_BUFFER_MAX) {
    notificationBuffer.splice(0, notificationBuffer.length - NOTIFICATION_BUFFER_MAX);
  }
}

export function broadcastNotification(payload: NotificationPayload): void {
  const at = Date.now();
  notificationBuffer.push({ at, payload });
  pruneNotificationBuffer(at);
  broadcast({ type: MessageType.NOTIFICATION, timestamp: at, payload });
}
