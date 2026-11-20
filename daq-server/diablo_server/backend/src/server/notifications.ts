/**
 * server/notifications.ts — operator notifications and their 5-minute replay buffer.
 *
 * Owns `activeNotificationKeys` (which keyed notifications are currently raised; exported as a
 * ReadonlySet — raiseNotification / clearNotification are its only writers, step 2.2) and
 * `notificationBuffer` (what a late-connecting browser is replayed; ws-connection.ts reads it
 * for the connect burst and prunes it first).
 *
 * Event-loop only. No effect at import (M1). Never imports api-server.ts or api/*.
 *
 * Contract: notification keys (`board_lost_<id>`, `setup_stuck_<id>`, `unrecognized_<id>`,
 * `self_test_fail_<id>`, `actuator_mismatch`), texts and the 5 min / 500 buffer bound are
 * frozen in pipeline/golden/boards/ws_events.txt and ws_streams.txt (P1, P1b, P12).
 */

import { broadcast } from './ws-clients.js';
import { MessageType } from '../../../shared/types.js';
import type { NotificationPayload, NotificationPayloadOngoing } from '../../../shared/types.js';

// The keys currently raised. Only raiseNotification / clearNotification below change it; importers
// get the read-only view, so a stray add/delete elsewhere is a build error (STYLE-S32, step 2.2).
const activeKeys = new Set<string>();
export const activeNotificationKeys: ReadonlySet<string> = activeKeys;

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

/** Broadcast an ongoing notification, then mark its key raised — today's broadcast-then-add
 *  pairs, broadcast first as before. The key is `payload.key`, so the two can never disagree. */
export function raiseNotification(payload: NotificationPayloadOngoing): void {
  broadcastNotification(payload);
  activeKeys.add(payload.key);
}

/** Broadcast the `ongoing: false` notification, then clear its key — today's broadcast-then-delete pairs. */
export function clearNotification(payload: NotificationPayloadOngoing): void {
  broadcastNotification(payload);
  activeKeys.delete(payload.key);
}
