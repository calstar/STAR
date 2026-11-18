/**
 * server/history.ts — the rolling in-memory history cache and the backfill sent from it.
 *
 * Owns `history` (sensor-stream and engine-state record into it; ws-connection and commands
 * read it through sendHistoricalData) and the prune the 60 s timer in server.ts drives. The
 * connect-time backfill is fire-and-forget by design (DESIGN-WP6 §6.5, STYLE-S29): it drains
 * in chunks behind the socket, so nothing waits on it and its order is not observable.
 *
 * Event-loop only. No effect at import (M1): `new HistoryCache(...)` is a pure constructor.
 * Never imports api-server.ts or api/*.
 *
 * Contract: HISTORICAL_DATA chunking, the 3000 points per backfill series and the capped
 * connect backfill are frozen in pipeline/golden/ws_streams.txt (P7, P8, T1).
 */

import WebSocket from 'ws';
import { SOCKET_IDLE_BYTES } from '../client-outbox.js';
import { sendBackfill, type HistoryPayload } from '../history-backfill.js';
import { HistoryCache } from '../history-cache.js';
import { MessageType } from '../../../shared/types.js';
import type { QueryHistoricalRequest } from '../../../shared/types.js';
import { send } from './ws-clients.js';

// ~20 Hz × 800 s ≈ 13 min per full series; rings grow lazily so sparse/event
// streams stay small. Key cap must exceed the live stream count (>200) or
// active series get silently evicted and reconnect backfills lose data.
const HISTORY_MAX_POINTS = 16000;  // per series (ceiling)
const HISTORY_MAX_KEYS = 1000;
const HISTORY_STALE_MS = 30 * 60 * 1000;

// ── History cache (epoch-ms timestamps; see history-cache.ts) ────────────────

export const history = new HistoryCache({
  maxPoints: HISTORY_MAX_POINTS,
  maxKeys: HISTORY_MAX_KEYS,
  staleMs: HISTORY_STALE_MS,
});

export function pruneHistory(): void {
  history.prune();
}

/** Historical backfill. Times are epoch ms (same clock as SENSOR_UPDATE
 *  payload timestamps — clients merge by timestamp, no rebasing). Optional
 *  query narrows to specific keys and/or points newer than sinceMs; no query
 *  = full dump (legacy behavior, still used on connect).
 *
 *  Sent in chunks, each waiting for the socket to drain first, because a full dump
 *  is MAX_SEND_POINTS *per series*: at 177 live sensors that is ~530k points, ~15 MB,
 *  and it used to go out as a single ws.send() straight into the socket, outside the
 *  outbox. On a slow link (an iPad on site Wi-Fi) that wedged the client PERMANENTLY,
 *  which is worse than merely being slow: ClientOutbox.shouldFlush() only flushes when
 *  bufferedAmount is below SOCKET_IDLE_BYTES, and a socket holding megabytes never gets
 *  there again — so the client received its handshake messages and then not one live
 *  sample, indefinitely. The keepalive ping queued behind the same bytes, so the reaper
 *  eventually terminated it and the reconnect replayed the whole thing. Measured on the
 *  stand: every such connection showed exactly 15 outbound messages, even one that
 *  stayed open 179 s.
 *
 *  Chunking lets the socket return to idle between sends, which is what lets live data
 *  and the ping through. Clients merge HISTORICAL_DATA by timestamp and never wipe
 *  (frontend/lib/data-cache.ts, pinned by plot-time-cache.test.ts), so N small messages
 *  are equivalent to one big one. Abandoning the tail on timeout is deliberate: partial
 *  history plus live data beats complete history and a dead feed. */
export async function sendHistoricalData(
  ws: WebSocket,
  query?: QueryHistoricalRequest,
  onSent?: () => void,
): Promise<void> {
  const MAX_SEND_POINTS = 3000;
  const payload = history.buildPayload(query, MAX_SEND_POINTS) as HistoryPayload;
  if (Object.keys(payload).length === 0) return;

  // Cap unless the query actually NARROWS the range. `!query` is not enough: a client
  // that holds no data yet sends `{}` (see data-cache.ts — newestServerTsMs() is null on a
  // fresh or starved client), and `{}` is truthy, so the horizon was switched off for
  // precisely the client least able to take a full dump. On the stand that was the whole
  // death spiral: starved -> reaped -> reconnects with {} -> uncapped 19-slice ~10 MB
  // backfill -> starved harder. An empty query is a connect backfill and is capped.
  const narrowed = !!(query && (query.sinceMs != null || (query.keys?.length ?? 0) > 0));
  await sendBackfill(payload, /*capped=*/ !narrowed, {
    socket: {
      get bufferedAmount() { return ws.bufferedAmount; },
      get isOpen() { return ws.readyState === WebSocket.OPEN; },
    },
    idleBytes: SOCKET_IDLE_BYTES,
    sendSlice: (chunk) => {
      send(ws, { type: MessageType.HISTORICAL_DATA, timestamp: Date.now(), payload: chunk });
      onSent?.();
    },
    onStopped: (sentSlices, totalSlices) => {
      console.warn(
        `[ThinServer] Historical backfill stopped after ${sentSlices}/${totalSlices} slices — ` +
        'socket did not drain. Client keeps live data and the history it received.',
      );
    },
  });
}
