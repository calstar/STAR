/**
 * server/ws-clients.ts — the browser-facing socket set.
 *
 * Owns `wss` (assigned once by attachWebSocketServer, in server.ts's synchronous startup body,
 * before any timer or listener can run) and `clientStreams`, the per-client sensor outboxes.
 * Exposes the two exits every other module sends through — broadcast() to every client, send()
 * to one — plus the outbox drain, its stats reset, the keepalive reaper and a client's link
 * status for CONNECTION_STATUS. ws-connection.ts registers and removes its socket in
 * `clientStreams` (the Map stays mutably exported for that, DESIGN-WP6 §6.4).
 *
 * Single-threaded: everything here runs on the event loop. `wss` is an `export let` — read it
 * through the live binding, never copy it into a local that outlives the call (§8 R1); a vitest
 * that reaches a sender mocks this module (TESTING-NOTES.md). No effect at import (M1): the
 * timers that drive flushClientOutboxes / resetOutboxStats / reapUnresponsiveClients are
 * registered by server.ts, in today's order. Never imports api-server.ts or api/*.
 *
 * Contract: the SENSOR_UPDATE frame shape and the 100 ms drain / 10 s reset / 30 s keepalive
 * periods are frozen in pipeline/golden/ws_streams.txt and ws_schema.txt; the `__daq*` socket
 * properties and the "Reaping unresponsive WS client" line are never renamed.
 */

import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { ClientOutbox, FlushPacer, linkStatus } from '../client-outbox.js';
import { MessageType } from '../../../shared/types.js';
import { isAllowedOrigin } from '../origin-policy.js';
import type { SensorUpdate } from '../../../shared/types.js';

// Per-connection control-auth state, stashed on the WebSocket.
export type WsWithControl = WebSocket & {
  __daqOperator?: boolean;
  __daqControlAuthorized?: boolean;
  /** Cleared each keepalive sweep, set again on pong. A socket that misses a
   *  sweep is gone in a way TCP never reported (Wi-Fi drop, closed lid). */
  __daqAlive?: boolean;
};

/**
 * Per-client sensor staging. Sensor samples go here rather than straight to
 * ws.send(), so a client that cannot keep up loses resolution instead of
 * falling further and further behind (see client-outbox.ts).
 *
 * Control and event messages deliberately do NOT pass through this — they keep
 * using send()/broadcast() directly. Sensor samples are idempotent and the next
 * supersedes the last, which is what makes them safe to compact; a state
 * transition or an abort notification is not.
 */
export interface ClientStream {
  outbox: ClientOutbox;
  pacer: FlushPacer;
  /** This link's observations, surfaced to the operator via CONNECTION_STATUS. Recomputed
   *  every tick from what has actually been delivered — NOT only on a successful flush,
   *  which is how a starved client used to report itself perfectly healthy. */
  throttled: boolean;
  lagMs: number;
  resolutionPct: number;
  /** Newest sample put on this socket, or null if nothing ever has been. */
  lastDeliveredTsMs: number | null;
}
export const clientStreams = new Map<WebSocket, ClientStream>();

// Drain each client's outbox as fast as its own socket allows. The interval
// between a client's flushes is set by how long its socket took to clear the
// last dump — that measurement is also what sizes the next one, so resolution
// (not currency) absorbs a slow link.
export function flushClientOutboxes(): void {
  const now = Date.now();
  for (const [ws, cs] of clientStreams) {
    if (ws.readyState !== WebSocket.OPEN) continue;

    // Status FIRST, before either `continue` below. A client that cannot flush is exactly
    // the one whose status matters, and it is the one that never reached the old
    // assignment at the end of this loop.
    {
      const st = linkStatus({
        lastDeliveredTsMs: cs.lastDeliveredTsMs,
        nowMs: now,
        resolutionRatio: cs.outbox.resolutionRatio(),
        squeezeDropped: cs.outbox.squeezeDroppedLast,
      });
      cs.throttled = st.throttled;
      cs.lagMs = st.lagMs;
      cs.resolutionPct = st.resolutionPct;
    }

    if (!cs.pacer.shouldFlush(ws.bufferedAmount, now)) continue;

    const newest = cs.outbox.newestTimestamp();
    cs.outbox.squeeze(cs.pacer.budgetBytes);
    const flushed = cs.outbox.drain();
    if (flushed.length === 0) continue;

    let bytes = 0;
    for (const series of flushed) {
      for (const p of series.points) {
        const update: SensorUpdate = {
          entity: series.entity, component: series.component, value: p.value, timestamp: p.tMs,
        };
        const data = JSON.stringify({ type: MessageType.SENSOR_UPDATE, timestamp: now, payload: update });
        bytes += data.length;
        try { ws.send(data); } catch { /* closing; the reaper will collect it */ }
      }
    }
    cs.pacer.noteFlush(bytes, now);
    if (newest !== null) cs.lastDeliveredTsMs = newest;
  }
}

// Reset the resolution window periodically so the reported percentage tracks
// the link's recent behavior rather than averaging over the whole session.
export function resetOutboxStats(): void {
  for (const cs of clientStreams.values()) cs.outbox.resetStats();
}

export let wss: WebSocketServer;

/** Attach the WebSocket server to the HTTP server; server.ts calls this at today's position. */
export function attachWebSocketServer(httpServer: http.Server): void {
  // SEC-6: a browser page that is not the GUI's own (origin-policy.ts) gets a 403 on the
  // upgrade, so a hostile page cannot open an operator socket from a bench laptop. No Origin
  // header (the harnesses, non-browser tools) is allowed.
  wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, cb) => {
      if (isAllowedOrigin(info.req.headers.origin)) cb(true);
      else cb(false, 403, 'Origin not allowed');
    },
  });
}

export function broadcast(message: object): void {
  if (wss.clients.size === 0) return;
  const data = JSON.stringify(message);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (_) { /* ignore disconnected */ }
    }
  });
}

export function send(ws: WebSocket, message: object): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(message)); } catch (_) { }
}

// ── Keepalive ────────────────────────────────────────────────────────────────
//
// TCP does not reliably report a peer that vanished without a FIN — a closed
// laptop lid or a walk out of Wi-Fi range leaves the socket readyState OPEN
// forever, and it keeps being fed. The outbox bounds what such a client costs,
// but nothing else ever removes it from wss.clients, so probe and reap.
export const KEEPALIVE_MS = 30_000;
export function reapUnresponsiveClients(): void {
  for (const ws of wss.clients) {
    const w = ws as WsWithControl;
    if (w.__daqAlive === false) {
      console.warn('[ThinServer] Reaping unresponsive WS client (missed keepalive)');
      clientStreams.delete(ws);
      ws.terminate();
      continue;
    }
    w.__daqAlive = false;
    try { ws.ping(); } catch { /* already closing */ }
  }
}

/** This client's own outbox observations, for connectionStatusPayload(). */
export function clientStreamStatus(ws: WebSocket): Record<string, unknown> {
  const cs = clientStreams.get(ws);
  if (!cs) return {};
  return { throttled: cs.throttled, resolutionPct: cs.resolutionPct, lagMs: cs.lagMs };
}
