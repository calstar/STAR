/**
 * server/notifications — operator notifications and their 5-minute replay buffer.
 * [WP6 1.4, layer 2]
 *
 * Owns: `activeNotificationKeys` (which ongoing notifications are raised) and
 * `notificationBuffer` (last 5 min, at most 500, replayed on connect). After step 2.2 it is the
 * only writer of both (STYLE-S32): the type of `activeNotificationKeys` narrows to
 * `ReadonlySet`, so `tsc --noEmit` rejects an `add`/`delete` anywhere else.
 *
 * Must not know about: why a notification is raised (boards, mismatch, self-test decide that),
 * Elodin, HTTP. Imports `ws-clients`, `shared/types`.
 * Contract: notification keys (`board_lost_<id>`, `setup_stuck_<id>`, `unrecognized_<id>`,
 * `self_test_fail_<id>`, `actuator_mismatch`), texts, the broadcast-then-record order, the
 * replay order (chronological, pruned first) — `pipeline/golden/boards/ws_events.txt`,
 * `lifecycle/golden/{reconnect,hbloss}.txt`. `sessionManager.init` receives
 * `broadcastNotification` from `server.ts` (injection that breaks a real cycle, STYLE-S31).
 * Import-time effects: none.
 */

import type { NotificationPayload, NotificationPayloadOngoing, WebSocket } from '../product-types.js';

/** Raised ongoing notification keys. Step 1: exported mutable (`Set<string>`), mutated in place
 *  by the moved bodies (WP6-R3); step 2.2: `ReadonlySet` to everyone but this module. */
export declare const activeNotificationKeys: ReadonlySet<string>;

/** Step 1 only (read by `ws-connection`'s replay); private after step 2.8. */
export declare const notificationBuffer: ReadonlyArray<{ at: number; payload: NotificationPayload }>;

/** Drop entries older than 5 min, then cap at 500. */
export function pruneNotificationBuffer(now: number): void {
  throw new Error('stub');
}

/** Record in the buffer (pruned), then broadcast one NOTIFICATION frame stamped with the same
 *  `at`. Used directly for one-shot notifications (`"… connected"`). */
export function broadcastNotification(payload: NotificationPayload): void {
  throw new Error('stub');
}

/**
 * [step 2.2] Broadcast an ongoing notification, then mark its key raised — today's
 * broadcast-then-`add` pairs (5 sites). The key is `payload.key` (one argument, so the two can
 * never disagree; the reviewed note wrote `(key, payload)` with equal values at every site).
 */
export function raiseNotification(payload: NotificationPayloadOngoing): void {
  throw new Error('stub');
}

/** [step 2.2] Broadcast the `ongoing:false` notification, then clear its key — today's
 *  broadcast-then-`delete` pairs (4 sites). */
export function clearNotification(payload: NotificationPayloadOngoing): void {
  throw new Error('stub');
}

/** [step 2.8, A4] The connect-burst replay: prune, send each buffered NOTIFICATION with its own
 *  `at` as the frame timestamp, return how many frames were sent. */
export function sendNotificationReplay(ws: WebSocket): number {
  throw new Error('stub');
}
