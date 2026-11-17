/**
 * server/elodin-link.ts — the Elodin DB connection.
 *
 * Owns `elodin` (the one ElodinClient; a pure constructor, so it lives at the top level —
 * DESIGN-WP6 §1.2 row 23, the only row that leaves server.ts's startup sequence), the
 * resubscribe pass and its timer, the ingest-freshness clock behind the status badge
 * (`lastIngestMs`, advanced by ingest through noteIngest(), zeroed on disconnect), and the four
 * client listeners server.ts registers in today's order. syncElodinToSession() is what the
 * listen callback calls after sessionManager.init. scheduleResubscribe and the listeners are
 * kept verbatim as the one home a future D-SUB liveness watchdog would have; WP6 adds no seam
 * here (no factory, no deps object, no clock seam — D48).
 *
 * Event-loop only. No effect at import (M1); USE_SIM is read per call in isSimulated(), verbatim
 * (D44(1)). onElodinConnected hands the client to calibration-state.setCalibrationElodin().
 * Never imports api-server.ts or api/*.
 *
 * Contract: `Connected to Elodin, subscriptions sent.` is counted by lifecycle.py:1083 and frozen
 * in lifecycle/golden/reconnect.txt (STYLE-S15); `VTableStream: sent` / `queued for the next
 * pass` are the registry's; CONNECTION_STATUS's fields and its 1 s period are frozen in
 * pipeline/golden/ws_handshake.txt and ws_schema.txt; the 5 s resubscribe minimum and 3 s
 * data-fresh window are §6.5 periods.
 */

import WebSocket from 'ws';
import { ElodinClient } from '../elodin-client.js';
import { registerVTables, clearSubscriptionState, noteSubscriptionRejected } from '../elodin-vtable-registry.js';
import { sessionManager } from '../session-manager.js';
import { MessageType } from '../../../shared/types.js';
import { ELODIN_HOST, ELODIN_PORT } from './env.js';
import { wss, send, clientStreamStatus } from './ws-clients.js';
import { setCalibrationElodin } from './calibration-state.js';
import { refreshScriptStatus } from './engine-state.js';

// Authoritative "data is actually flowing" signal: epoch-ms of the last entity we
// ingested from Elodin. The status badge derives dataFresh from this, so it reflects
// real end-to-end delivery — not just "a run is marked active" or the WS being open.
let lastIngestMs = 0;
const DATA_FRESH_MS = 3000; // no ingest for this long ⇒ pipeline is not delivering

/** ingest's note that a finite row arrived (keeps Date.now(), not the row's epochNow). */
export function noteIngest(): void {
  lastIngestMs = Date.now();
}

// ── Elodin DB connection ─────────────────────────────────────────────────────

export const elodin = new ElodinClient(ELODIN_HOST, ELODIN_PORT);

// VTable resubscription — Elodin DB rejects subscriptions for VTables not yet
// registered by other services (e.g., daq_bridge). A pass runs every 5s for the life of
// the connection; once everything is subscribed it sends nothing.
let resubscribeTimer: NodeJS.Timeout | null = null;
const RESUBSCRIBE_MIN_MS = 5000;

// No attempt ceiling any more. The old one (24 passes, ~2 min) was dead code anyway: the
// dbError handler called scheduleResubscribe(1) on every refusal, resetting the ladder
// forever. Worse, a real ceiling is wrong here — a service started more than two minutes
// after the backend connects would never be picked up. Termination is now per PAIR
// (MAX_PAIR_ATTEMPTS in elodin-vtable-registry), which is where it belongs: one table that
// nobody publishes gets parked, without stopping retries for every other table.
//
// Nor does the first data packet stop it. It used to: harmless when one pass sent
// everything, fatal once a pass was capped at the request-id space — the first pass got
// sensor data flowing, the remainder (board heartbeat/self-test tables) was never sent, and a
// board's self-test never reached the GUI. A pass with nothing due sends nothing.
function scheduleResubscribe(delayMs: number = RESUBSCRIBE_MIN_MS): void {
  if (resubscribeTimer) return;
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null;
    if (!elodin.isConnected()) return;
    registerVTables(elodin).then((res) => {
      // Sleep until the earliest pair is actually due, instead of spinning every 5 s.
      // A remainder means the pass hit the request-id cap, not that anything is wrong —
      // come straight back for it rather than idling 5 s per 255 tables on first connect.
      const wait = res.remaining > 0
        ? 0
        : res.nextAttemptMs === null
          ? RESUBSCRIBE_MIN_MS
          : Math.max(RESUBSCRIBE_MIN_MS, res.nextAttemptMs - Date.now());
      scheduleResubscribe(wait);
    }).catch(() => {
      scheduleResubscribe(RESUBSCRIBE_MIN_MS);
    });
  }, Math.max(0, delayMs));
}

// True when incoming data is synthetic. In a session-enabled deployment this is
// exactly "an active simulated run" — the backend's own USE_SIM env is ignored
// there because the systemd sim harness sets USE_SIM=1 on the backend process
// permanently (so it would wrongly read simulated even when the run is stopped or
// live). Only the field-laptop path (session control off, no run concept) falls
// back to USE_SIM=1 (the terminal `dev.sh --sim` stack). Drives the purple badge.
export function isSimulated(): boolean {
  if (sessionManager.isEnabled()) return sessionManager.isSimulated();
  return process.env.USE_SIM === '1';
}

// Single source of truth for the status badge. Every field is backend-observed —
// no frontend guessing: connected (this socket), elodinConnected (backend↔Elodin
// link), simulated (active simulated run), and dataFresh (we actually ingested a
// row from Elodin within DATA_FRESH_MS — i.e. the pipeline is really delivering).
//
// throttled/resolutionPct/lagMs describe ONE client's link and so must be passed
// per socket. They cannot be derived in the browser: resolutionPct needs the
// produced-point count the client never receives, and lagMs needs the server
// clock. An operator must never be looking at decimated data without being told.
export function connectionStatusPayload(extra: Record<string, unknown> = {}) {
  return {
    connected: true,
    elodinConnected: elodin.isConnected(),
    simulated: isSimulated(),
    dataFresh: Date.now() - lastIngestMs < DATA_FRESH_MS,
    throttled: false,
    resolutionPct: 100,
    lagMs: 0,
    ...extra,
  };
}

// Re-send connection status. Per-client rather than a single broadcast: each
// dashboard must report the state of ITS link, not whichever one is worst.
export function broadcastConnectionStatus(): void {
  const ts = Date.now();
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    send(ws, {
      type: MessageType.CONNECTION_STATUS,
      timestamp: ts,
      payload: connectionStatusPayload(clientStreamStatus(ws)),
    });
  }
}

export function onElodinConnected(): void {
  console.log('[ThinServer] Elodin Connected');
  broadcastConnectionStatus();

  if (resubscribeTimer) { clearTimeout(resubscribeTimer); resubscribeTimer = null; }

  setCalibrationElodin(elodin);
  registerVTables(elodin).then(() => {
    scheduleResubscribe();
  });
  // No VTable REGISTRATION from here. The C++ services own it (sequencer:
  // "Registered Sequencer/Controller VTables"), and every message this backend sent was
  // rejected by the DB anyway — measured against elodin-db: 5x "postcard Serde
  // Deserialization Error" for the controller tables and 20x "Hit the end of buffer" for
  // the actuator ones. That encoder emitted a VTableMsg this DB version cannot parse, and
  // the "✅ Registered" it logged only ever meant socket.write() returned true. It has
  // been deleted (see elodin-vtable-registry.ts); this backend only subscribes.
  console.log('[ThinServer] Connected to Elodin, subscriptions sent.');
  refreshScriptStatus();
}

// The DB refuses a subscription for a VTable that does not exist YET — the publisher
// registers it when that service starts, which on a session start is a few seconds after
// this backend reconnects. Un-mark the pair and make sure a retry is queued; without this
// the refusal was silent and permanent, and the GUI sat on a stale state all session.
export function onElodinDbError(requestId: number, description: string): void {
  // Record only. This used to also call scheduleResubscribe(1), which reset the retry
  // ladder on every single refusal — with thousands of refusals per pass that made the
  // loop permanent and the attempt ceiling meaningless. The pass scheduled above already
  // comes back around, now timed off the pairs' own backoff.
  noteSubscriptionRejected(requestId, description);
}

export function onElodinDisconnected(): void {
  console.log('[ThinServer] Elodin DB disconnected');
  // The data source is gone (run stopped / DB swap). Clear the freshness clock so a
  // new run starts as "not delivering" (dataFresh=false) instead of briefly showing
  // the stale previous run's fresh state — fixes the "Simulated Data" flash on start.
  lastIngestMs = 0;
  broadcastConnectionStatus();
  if (resubscribeTimer) { clearTimeout(resubscribeTimer); resubscribeTimer = null; }
  clearSubscriptionState();
}

export function onElodinError(err: Error): void {
  console.error('[ThinServer] Elodin error:', err.message);
}

// Connect to the DB only while it is meant to exist. In systemd mode sensor-elodin runs per
// session, so between runs this used to retry a refused port every 5 s, forever. The session
// manager decides after it has recovered any run that outlived a backend restart (see the
// listen callback below), and session start/stop connect and disconnect from then on.
export function syncElodinToSession(): void {
  if (sessionManager.pipelineExpected()) {
    elodin.connect().then((ok) => {
      if (!ok) console.warn('[ThinServer] Elodin DB connect failed — will retry automatically');
    });
  } else {
    elodin.disconnect();
    console.log('[ThinServer] No active session: not connecting to Elodin DB until one starts');
  }
}
