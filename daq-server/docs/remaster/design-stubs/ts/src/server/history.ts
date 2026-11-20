/**
 * server/history — the rolling history cache and the backfill sent from it.  [WP6 1.5, layer 2]
 *
 * Owns: `history` (`HistoryCache`: 16 000 points per series, 1000 keys, 30 min stale) and the
 * chunked backfill (pauses per socket until it drains; abandons the tail after 30 s —
 * `history-backfill.ts`, research `node-realtime-backend.md` §3).
 *
 * Must not know about: where samples come from (`sensor-stream` and `engine-state` record),
 * Elodin, HTTP. Imports `ws-clients`, `history-cache`, `history-backfill`, `client-outbox`.
 * Contract: `historical_data` chunks and the 3000-points-per-series cap on an un-narrowed query
 * (`pipeline/golden/ws_streams.txt`); the `Historical backfill stopped after …` warning text.
 * Import-time effects: none (the cache is a pure constructor); `server.ts` registers
 * `setInterval(pruneHistory, 60_000)`.
 */

import type { HistoryCache, QueryHistoricalRequest, WebSocket } from '../product-types.js';

export declare const history: HistoryCache;

/** The 60 s prune. */
export function pruneHistory(): void {
  throw new Error('stub');
}

/**
 * Send history to one socket in drain-paced chunks. No query (connect) or a non-narrowing one →
 * capped at 3000 points per series. Resolves when done or abandoned; never rejects in practice
 * (send errors are swallowed by `send`). Fire-and-forget on connect (STYLE-S29), awaited by no one.
 * @param onSent called once per chunk sent (the connection's outbound counter).
 */
export function sendHistoricalData(ws: WebSocket, query?: QueryHistoricalRequest, onSent?: () => void): Promise<void> {
  throw new Error('stub');
}
