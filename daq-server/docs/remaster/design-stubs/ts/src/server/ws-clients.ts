/**
 * server/ws-clients — the browser-facing socket set: send, broadcast, per-client sensor outboxes,
 * link status, keepalive reaping.  [WP6 1.3, layer 1]
 *
 * Owns: `wss` (assigned once by `attachWebSocketServer`), `clientStreams` (a `Map`, iterated in
 * insertion = connect order by the drain loop and by `emitSensorWindow` — keep it a `Map`,
 * research `node-realtime-backend.md` §3), the outbox drain and the reaper.
 * Three delivery policies live here and in `history`, moved verbatim (research §3): sensor windows
 * are coalesced per client (resolution, not time, absorbs a slow link); control/event frames go
 * straight to `ws.send` with no cap (bounded only by the reaper); backfill pauses per socket
 * (`history`). A control-path cap is a PROPOSAL, not WP6.
 *
 * Must not know about: message meanings, Elodin, sessions, HTTP routes; never imports `api/*`
 * or `api-server.ts` (STYLE-S31). Imports `client-outbox`, `shared/types`.
 * Import-time effects: none (WP6-M1); `server.ts` registers the timers:
 * `setInterval(flushClientOutboxes, 100)`, `setInterval(resetOutboxStats, 10_000)`,
 * `attachWebSocketServer(httpServer)`, `setInterval(reapUnresponsiveClients, KEEPALIVE_MS)`.
 * Contract: frame bytes as `JSON.stringify(message)` (key order is the literal's, G9);
 * `__daq*` socket properties (STYLE-S7); the drain's tare-free slice that `lc-tare.test.ts`
 * reads by path after its re-point (WP6 §6.1 row 1.3).
 */

import type { ClientOutbox, FlushPacer, HttpServer, WebSocket, WebSocketServer } from '../product-types.js';

/** Per-connection flags stashed on the socket (names are external, STYLE-S7). */
export type WsWithControl = WebSocket & {
  /** Set at connect from `X-Auth-Email` (`ws-connection`). */
  __daqOperator?: boolean;
  /** Set by `CONTROL_UNLOCK` (`commands`); required by every control command. */
  __daqControlAuthorized?: boolean;
  /** Cleared each keepalive sweep, set on pong. */
  __daqAlive?: boolean;
};

/** One client's sensor staging and its link observations (CONNECTION_STATUS fields). */
export interface ClientStream {
  outbox: ClientOutbox;
  pacer: FlushPacer;
  throttled: boolean;
  lagMs: number;
  resolutionPct: number;
  /** Newest sample put on this socket, or null if nothing ever has been. */
  lastDeliveredTsMs: number | null;
}

/** Live binding, assigned by `attachWebSocketServer`. Never destructure into a local (WP6 R6). */
export declare let wss: WebSocketServer;
/** Registered by `ws-connection` at connect, deleted on close and by the reaper. */
export declare const clientStreams: Map<WebSocket, ClientStream>;
/** 30 000 ms between keepalive sweeps. */
export declare const KEEPALIVE_MS: number;

/** `new WebSocketServer({ server })`, assigned to `wss`. Called once, at WP6 §1.3 row 18. */
export function attachWebSocketServer(server: HttpServer): void {
  throw new Error('stub');
}

/** Serialise once, send to every OPEN client; no-op when none; per-socket send errors ignored. */
export function broadcast(message: object): void {
  throw new Error('stub');
}

/** Send to one socket if OPEN; errors ignored. */
export function send(ws: WebSocket, message: object): void {
  throw new Error('stub');
}

/** This client's `{ throttled, resolutionPct, lagMs }` for CONNECTION_STATUS, or `{}` if unknown. */
export function clientStreamStatus(ws: WebSocket): Record<string, unknown> {
  throw new Error('stub');
}

/** The 100 ms drain: status first (even for a client that cannot flush), then pace, squeeze,
 *  drain, one SENSOR_UPDATE frame per point. Body verbatim from `server.ts:233-276`. */
export function flushClientOutboxes(): void {
  throw new Error('stub');
}

/** The 10 s reset of each outbox's resolution window. */
export function resetOutboxStats(): void {
  throw new Error('stub');
}

/** The 30 s sweep: terminate a socket that missed the previous ping, then ping the rest. */
export function reapUnresponsiveClients(): void {
  throw new Error('stub');
}
