/**
 * server/elodin-link — the Elodin DB connection as the backend uses it: connect/disconnect with
 * the session, subscription passes and the resubscribe loop, link health on the status badge.
 * [WP6 1.13, layer 4]
 *
 * Owns: `elodin` (one `ElodinClient`, constructed at import — pure, WP6 §1.3 row 23), the
 * resubscribe timer, `lastIngestMs` (data freshness). It is the **one home** of the resubscribe
 * loop and of the Elodin event handlers, so a later subscription-echo check (D-ECHO) or
 * per-pair liveness watchdog (D-SUB) attaches here — PROPOSALS only (LEDGER D42,
 * `research/subscription-robustness.md` Ideas 2-4). Such a watchdog would read board liveness
 * from `board-status` (layer 3, a downward edge; not added now, WP6 [A6]). The registry's
 * generation guard and `clearSubscriptionState()` on disconnect stay exactly as they are (what a
 * make-before-break reconnect would rely on).
 * Must not know about: what packets mean (`ingest`), commands, HTTP. Imports `env`,
 * `ws-clients`, `calibration-state`, `engine-state`, `elodin-client`, `elodin-vtable-registry`,
 * `session-manager`.
 * Contract: the log lines `[ThinServer] Elodin Connected`, `Connected to Elodin, subscriptions
 * sent.` (counted by `lifecycle.py:1083`, STYLE-S15), `Elodin DB disconnected`; the badge's
 * `connection_status` fields; the 5 s resubscribe minimum; `registerVTables(...).then(...)` with
 * **no** `.catch` (STYLE-S28, kept) — `lifecycle/golden/{reconnect,shutdown}.txt`.
 * Seams (debate verdict, 2026-11-16): **no factory and no deps object in WP6** — no
 * `createElodinLink`, no `now` dep, no `setClockForTests` here. `scheduleResubscribe` and the four
 * listeners stay verbatim (LEDGER D49: no pure delay function either). A later
 * D-SUB/D-ECHO package passes `client` as a **parameter at the decision**
 * (`registerVTables(client)`; the registry's due-pair loop stays inline until such a package
 * extracts it — WP5's `duePairs` was dropped, D60), not a factory.
 * Import-time effects: none beyond the pure constructor; `server.ts` registers
 * `setInterval(broadcastConnectionStatus, 1000)` (row 24, the third 1 s timer) and
 * `elodin.on('connected' | 'dbError' | 'disconnected' | 'error', …)` in today's order.
 */

import type { ElodinClient } from '../product-types.js';

export declare const elodin: ElodinClient;

/** `lastIngestMs = Date.now()` — called per finite row (keeps `Date.now()`, not `epochNow`). */
export function noteIngest(): void {
  throw new Error('stub');
}

/** Session-enabled: the active run is simulated; otherwise `process.env.USE_SIM === '1'`, read
 *  per call (moved verbatim; STYLE-S20 question recorded in DESIGN-WP6 "Interfaces"). */
export function isSimulated(): boolean {
  throw new Error('stub');
}

/** The badge: `{ connected: true, elodinConnected, simulated, dataFresh (ingest < 3 s ago),
 *  throttled:false, resolutionPct:100, lagMs:0, ...extra }` — key order frozen (G9). */
export function connectionStatusPayload(extra?: Record<string, unknown>): Record<string, unknown> {
  throw new Error('stub');
}

/** One `connection_status` per OPEN client, each with its own link fields. */
export function broadcastConnectionStatus(): void {
  throw new Error('stub');
}

/** Connect when a pipeline is expected (warn on failure; the client retries), else disconnect
 *  and log that it is waiting for a session. Called from `server.ts`'s `listen` callback. */
export function syncElodinToSession(): void {
  throw new Error('stub');
}

/** `connected`: log, badge, cancel a pending resubscribe, `setCalibrationElodin(elodin)` (2.2),
 *  first subscription pass then the resubscribe loop, the harness-read log line, SCRIPTS poll. */
export function onElodinConnected(): void {
  throw new Error('stub');
}

/** `dbError`: record the refusal in the registry only (no immediate retry). */
export function onElodinDbError(requestId: number, description: string): void {
  throw new Error('stub');
}

/** `disconnected`: log, `lastIngestMs = 0`, badge, cancel resubscribe, `clearSubscriptionState()`. */
export function onElodinDisconnected(): void {
  throw new Error('stub');
}

/** `error`: log `Elodin error: <message>` only. */
export function onElodinError(err: Error): void {
  throw new Error('stub');
}
