/**
 * server/ws-connection — one browser connection: identity, the connect burst, wiring of its
 * handlers.  [WP6 1.16, layer 6; an input boundary, STYLE-S9]
 *
 * Owns: the connection counter (`connId` = `c<N>`), the socket's identity (`__daqOperator` from
 * `X-Auth-Email`: empty header → operator; else the allowlist — the same rule as
 * `api/http.isConfigWriteAuthorized`, unified into `operators.isOperatorRequest` after WP6 and
 * WP7 merge, WP7 step 2.3), the **order** of the connect burst, the per-connection counters in
 * the `[WS_BACKEND] conn_open/conn_close` lines, and the one try/catch around parse + dispatch.
 * After step 2.8 [A4] it builds only `connection_status` (payload from `elodin-link`),
 * `control_status` and `session_update`; every other frame comes from its owner's `send…(ws)`.
 * Must not know about: what any frame means beyond its place in the order. Imports every layer
 * below it; nothing imports it except `server.ts`.
 *
 * The burst, in frozen order (WP6 §3.5; `pipeline/golden/ws_handshake.txt`,
 * `lifecycle/golden/startup.txt`): register the client's outbox first; `connection_status`
 * (with `connId`) → `control_status` → `mission_start_time` (if set) →
 * `countdown_target_update` → `session_update` → `state_update` (connect shape) →
 * `board_status_update` (if any) → commanded snapshot → self-test replay → notification replay
 * → `historical_data` (fire-and-forget, STYLE-S29). Counters skip `mission_start_time` and
 * `session_update` (D-WS quirk, kept).
 * Error paths: a non-JSON message or a throwing handler → `[ThinServer] Bad message:`, no reply
 * (today, kept, STYLE-S10; G10). `close` → delete the client's outbox, log `conn_close`.
 * Import-time effects: none; `server.ts` registers `wss.on('connection', handleConnection)`.
 */

import type { IncomingMessage, WebSocket } from '../product-types.js';

/** The `connection` listener. */
export function handleConnection(ws: WebSocket, req: IncomingMessage): void {
  throw new Error('stub');
}
