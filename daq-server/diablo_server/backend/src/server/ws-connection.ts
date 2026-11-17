/**
 * server/ws-connection.ts — one browser connection: identity, the connect burst, its handlers.
 *
 * Owns `wsConnCounter` (the `c<N>` connId). handleConnection is the input boundary for a
 * socket: it decides the operator identity from X-Auth-Email (no header ⇒ trusted local ⇒
 * operator; SEC-1, kept), registers the socket's outbox in ws-clients.clientStreams (and removes
 * it on close), sends the connect burst in the frozen order (DESIGN-WP6 §3.3 — every frame built
 * here from the other modules' live bindings; it assigns none of them), and wires the message
 * listener, whose try/catch covers parse and dispatch (`Bad message`, no reply — today, kept,
 * D43(5)). The history backfill is fire-and-forget by design (STYLE-S29).
 *
 * Event-loop only, registered by server.ts as `wss.on('connection', handleConnection)` (§1.2
 * row 22). No effect at import (M1). The one importer of commands.ts; nothing imports this
 * module but server.ts; never imports ingest, api-server.ts or api/*.
 *
 * Contract: the burst order and contents (connection_status with connId → control_status →
 * mission_start_time? → countdown_target_update → session_update → state_update [connect shape]
 * → board_status_update? → commanded sensor_updates → self-test replay → notification replay →
 * historical_data chunks) are frozen in pipeline/golden/ws_handshake.txt (A, B, C), the boards/
 * and nocal/ copies and lifecycle/golden/startup.txt; the `[WS_BACKEND]` conn_open / conn_close
 * JSON (incl. lastOutboundAt and the counters that skip mission_start_time and session_update)
 * is log only (G13) and never changes.
 */

import * as http from 'http';
import WebSocket from 'ws';
import { isOperator } from '../operators.js';
import { ClientOutbox, FlushPacer } from '../client-outbox.js';
import { resolveActuatorCmdEntity } from '../state-csv/state-actuators.js';
import { sessionManager } from '../session-manager.js';
import { MessageType, SystemState } from '../../../shared/types.js';
import { type WsWithControl, wss, send, clientStreams, clientStreamStatus } from './ws-clients.js';
import { notificationBuffer, pruneNotificationBuffer } from './notifications.js';
import { sendHistoricalData } from './history.js';
import { firstPacketTimeMs, countdownTargetMs } from './mission-time.js';
import { boardsStatus, selfTestLatest } from './board-status.js';
import { currentState, debugMode, STATE_ACTUATOR_MAP, configStateName } from './engine-state.js';
import { connectionStatusPayload } from './elodin-link.js';
import { handleMessage } from './commands.js';

let wsConnCounter = 0;

// ── Client connection ─────────────────────────────────────────────────────────

export function handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
  const connId = `c${++wsConnCounter}`;
  const openedAt = Date.now();
  const remoteAddr =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const userAgent = req.headers['user-agent'] ?? 'unknown';

  // Engine-control authorization. Caddy injects X-Auth-Email on the upgrade
  // (from the session cookie). No header ⇒ no Caddy in front (dev/test-stand) ⇒
  // trusted local ⇒ treat as operator. Approved operators still explicitly arm
  // control via the toggle below (__daqControlAuthorized) — a fat-finger guard
  // in every env.
  const authEmail = ((req.headers['x-auth-email'] as string | undefined) || '').trim();
  const isOp = authEmail === '' ? true : isOperator(authEmail);
  (ws as WsWithControl).__daqOperator = isOp;

  // Sensor staging for this client (see client-outbox.ts). Registered before
  // any send so the first window produced after connect is already captured.
  clientStreams.set(ws, {
    outbox: new ClientOutbox(),
    pacer: new FlushPacer(),
    throttled: false,
    lagMs: 0,
    resolutionPct: 100,
    // null, not Date.now(): nothing has been delivered yet, and the flush loop treats
    // null as the connect race rather than as a stale link.
    lastDeliveredTsMs: null,
  });
  (ws as WsWithControl).__daqAlive = true;
  ws.on('pong', () => { (ws as WsWithControl).__daqAlive = true; });
  (ws as WsWithControl).__daqControlAuthorized = false;

  let inboundMessages = 0;
  let outboundMessages = 0;
  let lastInboundAt = 0;
  let lastOutboundAt = 0;
  console.log(`[WS_BACKEND] ${JSON.stringify({ event: 'conn_open', ts: openedAt, connId, remoteAddr, userAgent, wsClients: wss.clients.size })}`);

  // Connection status
  send(ws, {
    type: MessageType.CONNECTION_STATUS, timestamp: Date.now(),
    payload: connectionStatusPayload({ connId, ...clientStreamStatus(ws) }),
  });
  outboundMessages++;
  lastOutboundAt = Date.now();

  // Control authorization status — lets the UI enable/disable the arm step
  // before arming (non-operators see it disabled, never a false-armed state).
  send(ws, {
    type: MessageType.CONTROL_STATUS, timestamp: Date.now(),
    payload: { operator: isOp, email: authEmail || null },
  });
  outboundMessages++;
  lastOutboundAt = Date.now();

  // Mission start time
  if (firstPacketTimeMs !== null) {
    send(ws, {
      type: MessageType.MISSION_START_TIME, timestamp: Date.now(),
      payload: { missionStartTime: firstPacketTimeMs },
    });
  }

  // Countdown target
  send(ws, {
    type: MessageType.COUNTDOWN_TARGET_UPDATE, timestamp: Date.now(),
    payload: { targetTimeMs: countdownTargetMs },
  });
  outboundMessages++;
  lastOutboundAt = Date.now();

  // Session status (enabled=false in off mode → clients hide the button).
  send(ws, {
    type: MessageType.SESSION_UPDATE, timestamp: Date.now(),
    payload: sessionManager.getStatus(),
  });

  // Current state
  send(ws, {
    type: MessageType.STATE_UPDATE, timestamp: Date.now(),
    payload: { currentState, stateName: configStateName(currentState) ?? SystemState[currentState] ?? 'UNKNOWN', timestamp: Date.now(), debugMode },
  });
  outboundMessages++;
  lastOutboundAt = Date.now();

  // Board status
  const boards = Array.from(boardsStatus.values());
  if (boards.length > 0) {
    send(ws, { type: MessageType.BOARD_STATUS_UPDATE, timestamp: Date.now(), payload: { boards } });
    outboundMessages++;
    lastOutboundAt = Date.now();
  }

  // Commanded actuator snapshot for current state (ACT_CMD.B*.CH* keys — same as [0x32] parser + GUI).
  const snap = STATE_ACTUATOR_MAP[currentState];
  if (snap) {
    const t = Date.now();
    for (const [actuatorName, value] of Object.entries(snap)) {
      const cmdEntity = resolveActuatorCmdEntity(actuatorName);
      if (!cmdEntity) continue;
      send(ws, {
        type: MessageType.SENSOR_UPDATE, timestamp: t,
        payload: { entity: cmdEntity, component: 'actuator_state_commanded', value, timestamp: t },
      });
      outboundMessages++;
      lastOutboundAt = Date.now();
    }
  }

  // Self-test snapshot: replay latest results so late-connecting browsers see them.
  // Self-test is a one-shot event during board SETUP — without this, browsers that
  // connect after SETUP would never receive the results.
  if (selfTestLatest.size > 0) {
    const t = Date.now();
    for (const update of selfTestLatest.values()) {
      send(ws, { type: MessageType.SENSOR_UPDATE, timestamp: t, payload: update });
    }
    outboundMessages += selfTestLatest.size;
    lastOutboundAt = Date.now();
  }

  // Notification history: replay the last few minutes (chronological, so the
  // client's keyed dedup reconstructs current vs cleared state) so a reloaded
  // browser recovers recent warnings/info instead of starting blank.
  {
    const now = Date.now();
    pruneNotificationBuffer(now);
    for (const n of notificationBuffer) {
      send(ws, { type: MessageType.NOTIFICATION, timestamp: n.at, payload: n.payload });
    }
    if (notificationBuffer.length > 0) {
      outboundMessages += notificationBuffer.length;
      lastOutboundAt = now;
    }
  }

  // Historical data. Fire-and-forget: it now drains in chunks, so awaiting it here
  // would hold up the rest of the connection setup behind a slow client.
  void sendHistoricalData(ws, undefined, () => {
    outboundMessages++;
    lastOutboundAt = Date.now();
  });

  ws.on('message', (data: Buffer) => {
    inboundMessages++;
    lastInboundAt = Date.now();
    try {
      const message = JSON.parse(data.toString());
      handleMessage(ws, message);
    } catch (err) {
      console.error('[ThinServer] Bad message:', err);
    }
  });

  ws.on('close', (code, reasonBuffer) => {
    clientStreams.delete(ws);
    const reason = reasonBuffer?.toString() ?? '';
    console.log(`[WS_BACKEND] ${JSON.stringify({
      event: 'conn_close',
      ts: Date.now(),
      connId,
      code,
      reason,
      lifetimeMs: Date.now() - openedAt,
      inboundMessages,
      outboundMessages,
      lastInboundAt: lastInboundAt || null,
      lastOutboundAt: lastOutboundAt || null,
      wsClients: wss.clients.size,
    })}`);
  });
  ws.on('error', (err) => {
    console.error(`[WS_BACKEND] ${JSON.stringify({
      event: 'conn_error',
      ts: Date.now(),
      connId,
      readyState: ws.readyState,
      message: err.message,
    })}`);
  });
}
