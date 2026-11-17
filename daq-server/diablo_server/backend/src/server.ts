/**
 * server.ts — Minimal Node.js WebSocket bridge for browser clients.
 * (Formerly server-thin.ts — now the default backend server.)
 *
 * Responsibilities:
 *   - Connect directly to Elodin DB (TCP :2240), register VTables, subscribe
 *   - Relay Elodin sensor/actuator/state packets → SENSOR_UPDATE / ACTUATOR_UPDATE / STATE_UPDATE
 *   - Board status via Elodin heartbeat packets [0x10, board_id] → BOARD_STATUS_UPDATE (1 Hz)
 *   - Forward commands to C++ actuator_service (TCP) → TRANSITION / ACTUATOR / DEBUG_MODE / EXTEND_FIRE
 *   - Rolling in-memory history → HISTORICAL_DATA on connect + QUERY_HISTORICAL
 *   - MISSION_START_TIME, CONNECTION_STATUS, COUNTDOWN_TARGET_UPDATE
 *
 * NOT handled (owned by C++ services):
 *   - State machine validation — sequencer_service / actuator_service
 *   - Actuator UDP — sequencer / actuator_service
 *   - SERVER_HEARTBEAT — heartbeat_service
 *   - Config packets — config_broadcast_service
 *   - Calibration — calibration_service (stub reply)
 *
 * Frontend / dev:
 *   NEXT_PUBLIC_WS_URL=ws://localhost:<WS_PORT>
 */

import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import './elodin-client.js';
import { parseElodinPacket } from './elodin-protocol.js';
import { expandWithTare, resetTareState, setRunDir } from './lc-tare.js';
import { applyValveCalibration } from './ball-valve-cal.js';
import './sensor-config.js';
import { registerVTables, clearSubscriptionState, noteSubscriptionRejected, notePairDelivered } from './elodin-vtable-registry.js';
import { refusalText } from './refusal-text.js';
import './script-status.js';
import { createAPIHandler } from './api-server.js';
import { VideoService } from './video/service.js';
import { startBoardLogReceiver } from './board-logs.js';
import { readConfig, readDeployedConfig } from './routes/config.js';
import { getStateActuatorMap, CSV_ACTUATOR_TO_ENTITY, resolveActuatorCmdEntity, resolveActuatorTelemetryEntity } from './state-csv/state-actuators.js';
import type { StateActuatorMap } from './state-csv/state-actuators.js';
import { getStateTransitions } from './state-csv/state-transitions.js';
import { recordBoardScanIngest, getBoardScanRateHz, isPrimaryPhysicalStream, mapEntityToGroup } from './board-scan-rate.js';
import {
  EnvelopeAccumulator, parseGuiStreamConfig, envelopeWindowMs, encoderWindowMs,
  type GuiStreamConfig, type EnvelopePoint,
} from './gui-stream.js';
import { ClientOutbox, FlushPacer, SOCKET_IDLE_BYTES, linkStatus } from './client-outbox.js';
import './history-backfill.js';
import './history-cache.js';
import { startGuiStaticServer } from './static-gui.js';
import { startDhcpStatusPoller, getBoardDhcpStatus } from './dhcp-status.js';
import { publishClearAllTares, handleCalibrationCommand, publishCalibrationReload, type CalibrationHost } from './calibration-handler.js';
import './calibration.js';
import { MessageType, SystemState } from '../../shared/types.js';
import { isOperator } from './operators.js';
import type { NotificationPayload } from '../../shared/types.js';
import type { SensorUpdate, StateUpdate, CommandPayload, BoardStatus, ActuatorUpdate, QueryHistoricalRequest } from '../../shared/types.js';

// ── Config ───────────────────────────────────────────────────────────────────

// Command types that actuate/transition the engine — gated by the operator
// unlock. Read-only queries and countdown display are not.
const CONTROL_COMMAND_TYPES = new Set(['state_transition', 'actuator', 'extend_fire', 'debug_mode', 'session_start', 'session_stop', 'session_extend']);

setInterval(pruneHistory, 60_000);

// ── GUI stream downsampling (config.toml [gui]; see gui-stream.ts) ───────────

initGuiStream();

setInterval(flushClientOutboxes, 100);

setInterval(resetOutboxStats, 10_000);

setInterval(flushEnvelopes, 50);

// ── Mission time ─────────────────────────────────────────────────────────────

import { loadCountdownTargetTimeMs, saveCountdownTargetTimeMs } from './countdown-state.js';
initMissionTime();
import { sessionManager } from './session-manager.js';
import { ConfigIssuesError } from './config-validation.js';
import { ballValveSensedEntity, sensedStateFromPosition } from './ball-valve.js';
import { countByLevel, t7Channels } from '../../shared/config-validation.js';
import { sendToSequencer, SEQUENCER_PORT } from './sequencer-client.js';
import { WS_PORT, GUI_PORT, ELODIN_HOST, ELODIN_PORT, THIN_VERBOSE_CONNECTION_LOG, THIN_HEARTBEAT_DIAG_LOG, THIN_STATS_LOG } from './server/env.js';
import { stats, initStats } from './server/stats.js';
import { type WsWithControl, wss, attachWebSocketServer, broadcast, send, clientStreams, clientStreamStatus, flushClientOutboxes, resetOutboxStats, reapUnresponsiveClients, KEEPALIVE_MS } from './server/ws-clients.js';
import { activeNotificationKeys, notificationBuffer, pruneNotificationBuffer, broadcastNotification } from './server/notifications.js';
import { history, pruneHistory, sendHistoricalData } from './server/history.js';
import { firstPacketTimeMs, countdownTargetMs, initMissionTime, setFirstPacketTimeMs, setCountdownTargetMs } from './server/mission-time.js';
import { guiStreamConfig, envelope, encoderEnvelope, broadcastLastTime, BROADCAST_MIN_MS, streamBudgetFor, saneSampleTimeMs, initGuiStream, reloadGuiStreamConfig, emitSensorPoint, emitSensorWindow, flushEnvelopes } from './server/sensor-stream.js';
import { _hpBoardNumbers, _t7CalFields, _t7SlotToBoardId, initConfigCaches, resetConfigCaches, uniqueIdFromPtEntity } from './server/config-caches.js';
import { calibrationHost, lastRawAdc, initCalibrationState, reloadCalibrationEntityMap } from './server/calibration-state.js';
import { BOARD_STATUS_HZ, boardsStatus, loadBoardsFromConfig, updateBoard, countHeartbeat, noteT7Alive, markStaleBoards, broadcastBoardStatus, boardLabel, logDiagnostics, selfTestLatest, selfTestNotifiedBoards } from './server/board-status.js';
import { currentState, debugMode, STATE_ACTUATOR_MAP, initEngineState, reloadStateActuatorMap, configStateName, getExpectedPositions, broadcastCommandedActuatorsForState, broadcastStateUpdate, refreshScriptStatus, setDebugMode, applySequencerState } from './server/engine-state.js';
import { actuatorSensedState, scheduleActuatorMismatchCheck } from './server/actuator-mismatch.js';
import { elodin, noteIngest, connectionStatusPayload, broadcastConnectionStatus, syncElodinToSession, onElodinConnected, onElodinDbError, onElodinDisconnected, onElodinError } from './server/elodin-link.js';

// ── Calibration state ────────────────────────────────────────────────────────

initCalibrationState();

initConfigCaches();

// ── Board status ─────────────────────────────────────────────────────────────

loadBoardsFromConfig();

// ── State actuator map (expected positions per state from CSV) ────────────────

reloadStateActuatorMap();

setInterval(logDiagnostics, 5000);

setInterval(markStaleBoards, 1000);

initStats();

// ── Local state (sequencer / actuator_service authoritative) ────────────────

initEngineState();

// ── HTTP + WebSocket server ──────────────────────────────────────────────────

// The video pane: keeps the gateway (MediaMTX, sensor-video) in step with config/video.json.
// Independent of the run pipeline: a missing gateway only greys the video view.
const video = new VideoService();
video.start();

const apiHandler = createAPIHandler({
  video,
  getEngineState: () => currentState,
  getDebugInfo: () => {
    // Turns "the dashboards are stuck, restart the backend" into a diagnosis:
    // a large wsBufferedBytes against a small wsClients is this exact bug.
    let buffered = 0;
    for (const ws of wss.clients) buffered += ws.bufferedAmount;
    let windows = 0;
    for (const cs of clientStreams.values()) windows += cs.outbox.windowsHeld;
    return {
      ingestConnected: elodin.isConnected(),
      ingestPacketsReceived: stats.ingestEntityUpdatesReceived,
      wsClients: wss.clients.size,
      sensorCacheSize: history.size,
      useRelay: false,
      boardScanRateHz: getBoardScanRateHz(),
      wsBufferedBytes: buffered,
      outboxWindowsHeld: windows,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    };
  },
  onStateCsvUpdated: () => {
    // The CSV on disk changed and was deployed. Rebuild what the always-on backend derives from
    // it, and tell browsers to refetch.
    //
    // Nothing is pushed to the run pipeline. Config reaches it at exactly one point --
    // deployActiveProfile() at session start -- and the services read it once at boot. This used
    // to send RELOAD_CONFIG to hot-reload the actuator and transition tables into a running
    // sequencer, which was dead weight in the safety-critical path: this callback only fires when
    // the CSV was actually *deployed*, and a deploy only happens when no session is active, so
    // there was never a running sequencer for it to reach.
    try {
      reloadStateActuatorMap();
    } catch (e) {
      console.warn('\u26a0\ufe0f Failed to rebuild STATE_ACTUATOR_MAP:', e);
    }
    broadcast({ type: MessageType.CONFIG_UPDATED, timestamp: Date.now(), payload: {} });
  },
  onCalibrationReload: () => {
    // A calibration profile was loaded / a blank created on disk (api-server swapped the live
    // store file). Ask the calibration service to re-read it so the whole rig's cal switches live.
    publishCalibrationReload(calibrationHost);
  },
  onConfigUpdated: () => applyDeployedConfigChange(),
});

/**
 * Everything the always-on backend must redo when new config reaches disk, plus the nudge
 * that makes open browsers pick it up.
 *
 * Named and exported to the session path because SessionManager.start() deploys too. The
 * api-server edit routes call deployActiveProfile() and then onConfigUpdated(); the session
 * path called deployActiveProfile() with nothing after it, so a profile edited during a run
 * landed in config.toml at the next session start and no client was ever told. /api/states
 * served the new state immediately while every open tab kept the list it had cached at page
 * load, and the state diagram silently disagreed with the rig until someone hit reload.
 * Observed on the stand 2026-09-12: "LOX Press" saved 20:06, deployed 20:08, invisible in
 * the GUI on both sides of it.
 *
 * Deliberately NOT fired on a plain save. With a session active a save is a draft — nothing
 * is deployed and the rig keeps running what it booted with, so the GUI should keep showing
 * that, not the draft.
 */
export function applyDeployedConfigChange(): void {
  reloadGuiStreamConfig();
  reloadCalibrationEntityMap();
  resetConfigCaches();
  // The state CSVs are deployed in the same step, so rebuild what is derived from them too
  // rather than relying on onStateCsvUpdated, which the session path never fires.
  try {
    reloadStateActuatorMap();
  } catch (e) {
    console.warn('Failed to rebuild STATE_ACTUATOR_MAP:', e);
  }
  // The board list too. loadBoardsFromConfig() ran at startup and on session STOP and
  // nowhere else, so enabling a board in the config editor reached the Boards panel at
  // neither the edit nor the deploy — an enabled LC board was simply absent until the
  // backend restarted or a run ended, which reads exactly like the panel hardcoding a list.
  loadBoardsFromConfig();
  broadcastBoardStatus();
  // Tell every open client the config changed so they refetch /api/* live
  // (states, sensor-config, pressure-limits, pressure-bars) — no reload/restart.
  broadcast({ type: MessageType.CONFIG_UPDATED, timestamp: Date.now(), payload: {} });
}

const httpServer = http.createServer(async (req, res) => {
  const urlPath = (req.url ?? '').split('?')[0] ?? '';

  // Internal stats endpoint (not part of public API)
  if (req.method === 'GET' && urlPath === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...stats, uptimeMs: Date.now() - stats.startTimeMs }));
    return;
  }

  // Delegate all /api/* routes to the API handler
  try {
    if (await apiHandler(req, res)) return;
  } catch (err) {
    console.error('[ThinServer] API handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});
attachWebSocketServer(httpServer);
let wsConnCounter = 0;

startDhcpStatusPoller();
setInterval(broadcastBoardStatus, 1000 / BOARD_STATUS_HZ);

setInterval(reapUnresponsiveClients, KEEPALIVE_MS);

// ── Client connection ─────────────────────────────────────────────────────────

wss.on('connection', (ws: WebSocket, req) => {
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
});

// ── Message handling ─────────────────────────────────────────────────────────

function handleMessage(ws: WebSocket, message: any): void {
  switch (message.type) {
    case MessageType.SEND_COMMAND:
      handleCommand(ws, message.payload as CommandPayload);
      break;
    case MessageType.CONTROL_UNLOCK: {
      // Arming is identity-only: approved operators may toggle control on. Checked
      // server-side; the reply drives the UI's armed state, so it can never
      // disagree with what the backend will actually accept.
      const op = (ws as WsWithControl).__daqOperator === true;
      (ws as WsWithControl).__daqControlAuthorized = op;
      const reason = op ? 'ok' : 'not_operator';
      send(ws, { type: MessageType.CONTROL_UNLOCK_RESULT, timestamp: Date.now(), payload: { ok: op, reason } });
      break;
    }
    case MessageType.QUERY_HISTORICAL:
      void sendHistoricalData(ws, message.payload as QueryHistoricalRequest | undefined);
      break;
    case MessageType.CALIBRATION_COMMAND:
      handleCalibrationCommand(calibrationHost, ws, message.payload);
      break;
    case 'get_state_transitions':
      send(ws, { type: 'state_transitions', timestamp: Date.now(), payload: { transitions: getStateTransitions() } });
      break;
    default:
      console.warn('[ThinServer] Unknown message type:', message.type);
  }
}

function handleCommand(ws: WebSocket, command: CommandPayload): void {
  // The real, unbypassable gate: engine-control commands require an armed
  // (approved-operator) connection, regardless of what the UI shows.
  if (CONTROL_COMMAND_TYPES.has(command.commandType) && !(ws as WsWithControl).__daqControlAuthorized) {
    send(ws, {
      type: MessageType.ERROR, timestamp: Date.now(),
      payload: { message: 'Control locked: unlock as an approved operator first.' },
    });
    return;
  }
  switch (command.commandType) {
    case 'state_transition': {
      const targetState = command.data.state!;
      const declaredName = configStateName(targetState);
      // Resolve the id through the config the sequencer itself loaded, not the compiled enum.
      // The GUI sends a [[states]] id; SystemState is a fixed table that only agrees with it on a
      // rig that never renumbered. On one that did, every id from the first divergence up named a
      // different state: id 7 is Vent in config and FUEL_PRESS in the enum, so pressing Vent sent
      // TRANSITION:Fuel Press — and because Fuel Press is a real state here, fromName() resolved
      // it and the sequencer would have run it. A vent request executing a press is not a failure
      // mode worth keeping for the sake of a fallback.
      //
      // So once the config declares a [[states]] list it is the sole authority: an id it does not
      // declare is rejected, not rewritten through the enum. The enum fallback below stands only
      // when the config declares no states at all (legacy / unconfigured rig).
      const cfgStates = (() => {
        try {
          const r = (readConfig() as any)?.states;
          return Array.isArray(r) ? r : null;
        } catch {
          return null;
        }
      })();
      if (cfgStates && cfgStates.length > 0 && declaredName === null) {
        console.warn(`[ThinServer] state_transition rejected: id ${targetState} not in active config [[states]]`);
        send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `State transition rejected: id ${targetState} is not a state in the active config` } });
        break;
      }
      const stateName = declaredName ?? SystemState[targetState] ?? String(targetState);
      const csvName = declaredName ?? STATE_TO_CSV_NAME[stateName] ?? stateName;
      // Optional timed hold. Only appended when it is a sane integer, so a malformed value never
      // reaches the wire and every existing client stays byte-for-byte identical. This check is
      // convenience, not safety: the sequencer validates independently and is the authority on
      // which states may carry a duration at all (never the burn state).
      const holdMs = command.data.holdMs;
      let holdSuffix = '';
      if (holdMs !== undefined) {
        if (!Number.isInteger(holdMs) || holdMs <= 0 || holdMs > 3600000) {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Invalid hold duration: ${holdMs}` } });
          break;
        }
        holdSuffix = `:${holdMs}`;
      }
      // No optimistic update — real state/actuator positions arrive via _SEQUENCER_STATE [0x50]
      // and [0x32] packets from Elodin. FIRE_START/FIRE_STOP are sent from the subscriber path.
      sendToSequencer(`TRANSITION:${csvName}${holdSuffix}\n`).then(({ ok, reply }) => {
        console.log(`[ThinServer] State transition ${stateName} → ${csvName}${holdSuffix}: ${ok ? 'OK' : 'FAIL'} (${reply})`);
        if (!ok) {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `State transition failed: ${refusalText(reply)}` } });
        }
      });
      break;
    }
    case 'actuator': {
      const open = command.data.actuatorState === 1 || command.data.actuatorState as unknown as string === 'open';
      const actuatorName = command.data.actuatorName!;
      // No optimistic update — real commanded state arrives via [0x32] packets from Elodin.
      sendToSequencer(`ACTUATOR:${actuatorName}:${open ? 1 : 0}\n`).then(({ ok, reply }) => {
        if (!ok) {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Actuator command failed: ${refusalText(reply)}` } });
        }
      });
      break;
    }
    case 'debug_mode': {
      const newDebug = !!command.data.debugMode;
      sendToSequencer(`DEBUG_MODE:${newDebug ? 1 : 0}\n`).then(({ ok, reply }) => {
        console.log(`[ThinServer] Debug mode ${newDebug ? 'ON' : 'OFF'}: ${ok ? 'OK' : 'FAIL'} (${reply})`);
        if (ok) {
          setDebugMode(newDebug);
          broadcastStateUpdate();
        }
      }).catch(() => { });
      break;
    }
    case 'extend_fire':
      sendToSequencer('EXTEND_FIRE\n').then(({ ok, reply }) => {
        console.log(`[ThinServer] Extend fire: ${ok ? 'OK' : 'FAIL'} (${reply})`);
        if (!ok) {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Extend fire failed: ${refusalText(reply)}` } });
        }
      });
      break;
    case 'set_countdown_target':
      setCountdownTargetMs(command.data.targetTimeMs ?? null);
      saveCountdownTargetTimeMs(countdownTargetMs);
      broadcast({ type: MessageType.COUNTDOWN_TARGET_UPDATE, timestamp: Date.now(), payload: { targetTimeMs: countdownTargetMs } });
      break;
    case 'session_start':
      sessionManager
        .start(
          !!command.data.keepData,
          command.data.durationMs ?? 0,
          !!command.data.simulated,
          !!command.data.force,
        )
        .then(() => broadcastConnectionStatus())
        .catch((err) => {
          // A config-gated refusal is not a failure to report as a one-line string: the operator
          // needs the list, grouped by the page that fixes each item, and the choice to run anyway.
          // Sent only to the client that asked — another browser did not press this button.
          if (err instanceof ConfigIssuesError) {
            const { errors, warnings } = countByLevel(err.issues);
            send(ws, {
              type: MessageType.SESSION_START_BLOCKED,
              timestamp: Date.now(),
              payload: { issues: err.issues, errors, warnings, profile: err.profile },
            });
            return;
          }
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Session start failed: ${err.message}` } });
        });
      break;
    case 'session_stop':
      sessionManager
        .stop(false)
        .then(() => broadcastConnectionStatus())
        .catch((err) => send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Session stop failed: ${err.message}` } }));
      break;
    case 'session_extend':
      try {
        sessionManager.extend(command.data.addMs ?? 0);
      } catch (err) {
        send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Session extend failed: ${(err as Error).message}` } });
      }
      break;
    default:
      // stub for unhandled commands (calibration, controller_frequency, etc.)
      send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Command not supported in thin backend: ${command.commandType}` } });
  }
}

// ── Elodin DB connection ─────────────────────────────────────────────────────

const STATE_TO_CSV_NAME: Record<string, string> = {
  IDLE: 'Idle', ARMED: 'Armed', FUEL_FILL: 'Fuel Fill', OX_FILL: 'Ox Fill',
  PRESS_STANDBY: 'Press Standby',
  GN2_LOW_PRESS: 'GN2 Low Press', GN2_VENT: 'GN2 Low Vent',
  FUEL_PRESS: 'Fuel Press', FUEL_VENT: 'Fuel Vent',
  OX_PRESS: 'Ox Press', OX_VENT: 'Ox Vent',
  GN2_HIGH_PRESS: 'GN2 High Press', GN2_HIGH_VENT: 'GN2 High Vent',
  CALIBRATE: 'Calibrate', READY: 'Ready', FIRE: 'Fire', VENT: 'Vent',
  ENGINE_ABORT: 'Engine Abort', GSE_ABORT: 'GSE Abort',
  EMERGENCY_ABORT: 'Emergency Abort', ABORT: 'Emergency Abort',
  DEBUG: 'Idle',
};

// Push the authoritative status ~1 Hz so dataFresh (and thus the badge) never goes
// stale — otherwise it would only refresh on connect/elodin-flip and could show
// "Simulated Data" long after the pipeline stopped delivering.
setInterval(broadcastConnectionStatus, 1000);

elodin.on('connected', onElodinConnected);

// Slow on purpose. The sensor gate can block and unblock while the rig runs, so the reasons
// cannot be read once — but they only annotate a button the bitmask has already greyed, so
// there is nothing to gain from reading them often and a poll that notified would flood the
// notification panel.
setInterval(refreshScriptStatus, 15000);

elodin.on('dbError', onElodinDbError);

elodin.on('disconnected', onElodinDisconnected);

elodin.on('error', onElodinError);

elodin.on('packet', (header: any, payload: Buffer) => {
  try {
    const [high, low] = header.packetId as [number, number];
    // Proof this table is live. A rejection naming a delivering pair is a misattribution,
    // and acting on it would re-subscribe a live table and double its rate.
    notePairDelivered(high, low);

    // ── Board heartbeat [0x10, board_id] ────────────────────────────────────
    if (high === 0x10) {
      countHeartbeat(low);
      updateBoard(low, payload);
      return;
    }

    // ── Parse sensor/actuator/state packets ──────────────────────────────────
    // expandWithTare appends a derived `force_kg_tared` for each calibrated load-cell point and
    // leaves `force_kg` alone. It belongs HERE rather than inside parseElodinPacket (a pure,
    // stateless decoder that elodin-query.ts also uses to replay the archive — taring there
    // would apply today's offset to yesterday's samples) and rather than in the outbox drain
    // (which would leave the live stream tared and the reconnect backfill gross, because
    // emitSensorWindow records to history before it stages to any client).
    // applyValveCalibration replaces a ball valve's position_pct with its two-point calibrated
    // figure (ball-valve-cal.ts) before the mismatch check below and the browser see it.
    const parsedList = applyValveCalibration(
      expandWithTare(parseElodinPacket(header.packetId, payload, _hpBoardNumbers, _t7CalFields)));

    if (parsedList.length === 0) {
      if (high >= 0x40) {
        console.log(`[ThinServer] Unmapped packet from Elodin: [0x${high.toString(16)}, 0x${low.toString(16)}] len=${payload.length}`);
      }
      return;
    }

    const epochNow = Date.now();

    // ── Self-test results → snapshot + NOTIFICATION ────────────────────
    if (high >= 0x60 && high <= 0x6F && parsedList.length > 0) {
      const boardId = low;
      for (const parsed of parsedList) {
        const stKey = `${parsed.entity}.${parsed.component}`;
        selfTestLatest.set(stKey, { entity: parsed.entity, component: parsed.component, value: parsed.value, timestamp: epochNow });

        if (parsed.value === 0 && !selfTestNotifiedBoards.has(boardId)) {
          selfTestNotifiedBoards.add(boardId);
          const status = boardsStatus.get(boardId);
          const label = status ? boardLabel(status) : `Board ${boardId}`;
          broadcastNotification({
            key: `self_test_fail_${boardId}`,
            category: 'error',
            message: `${label} failed self-test`,
            timestampMs: epochNow,
            ongoing: true,
          });
          activeNotificationKeys.add(`self_test_fail_${boardId}`);
          break;
        }
      }
    }

    // ── SequencerState packet → STATE_UPDATE broadcast ───────────────────
    if (parsedList[0]?.entity === '_SEQUENCER_STATE') {
      applySequencerState(parsedList);
      scheduleActuatorMismatchCheck(currentState);
      // FIRE_START / FIRE_STOP are NOT sent from here. The sequencer owns the burn gate and
      // notifies controller_service itself (SequencerService::notifyControllerFire). This branch
      // used to send them too, so a safety-critical gate had two writers in two processes racing
      // on the same TCP endpoint — and this one keyed off SystemState.FIRE, a hardcoded enum,
      // rather than the configured fire state.
      return;
    }

    for (const parsed of parsedList) {
      if (!Number.isFinite(parsed.value)) continue;

      // A ball valve's sensed state comes from its position [0x34]: open/closed near the ends of
      // travel, nothing while it travels or its loop is dead (ball-valve.ts).
      if (parsed.component === 'position_pct') {
        const sensedEntity = ballValveSensedEntity(parsed.entity);
        if (sensedEntity) {
          const status = parsedList.find((p) => p.entity === parsed.entity && p.component === 'cal_status')?.value;
          const sensed = sensedStateFromPosition(parsed.value, status);
          const prev = actuatorSensedState.get(sensedEntity);
          if (sensed === undefined) actuatorSensedState.delete(sensedEntity);
          else actuatorSensedState.set(sensedEntity, sensed);
          if (prev !== sensed && activeNotificationKeys.has('actuator_mismatch')) {
            scheduleActuatorMismatchCheck(currentState);
          }
        }
      }

      // Track actuator sensed state [0x31] for mismatch detection
      if (parsed.component === 'actuator_state') {
        const prev = actuatorSensedState.get(parsed.entity);
        actuatorSensedState.set(parsed.entity, parsed.value);
        // Re-check mismatch when sensed state changes (clears "current" flag when resolved)
        if (prev !== parsed.value && activeNotificationKeys.has('actuator_mismatch')) {
          scheduleActuatorMismatchCheck(currentState);
        }
      }

      // A T7's raw data is its heartbeat (noteT7Alive).
      if (parsed.component === 'volts' || parsed.component === 'temperature_c') {
        const t7 = /^T7(\d+)\.(?:AIN\d+|CJC)$/.exec(parsed.entity);
        if (t7) noteT7Alive(parseInt(t7[1], 10));
      }

      // Track raw ADC for calibration (uniqueId = board_id*100+channel, same as calibration_service)
      if (parsed.component === 'raw_adc_counts') {
        const uid = uniqueIdFromPtEntity(parsed.entity);
        if (uid != null) lastRawAdc.set(uid, parsed.value);
      }

      // Set mission T+0 on first meaningful data packet.
      if (firstPacketTimeMs === null) {
        setFirstPacketTimeMs(epochNow);
        if (THIN_VERBOSE_CONNECTION_LOG) {
          console.log(`[ThinServer] Mission T+0: ${new Date(epochNow).toISOString()}`);
        }
        broadcast({ type: MessageType.MISSION_START_TIME, timestamp: Date.now(), payload: { missionStartTime: firstPacketTimeMs } });
      }

      const key = `${parsed.entity}.${parsed.component}`;
      stats.ingestEntityUpdatesReceived++;
      noteIngest();

      // Pre-downsample ingest rate (what boards/Elodin actually deliver) — not WS broadcast rate.
      recordBoardScanIngest(parsed.entity, parsed.component);
      // _Cal excluded: calibration_service republications would double-count PT samples.
      if (!parsed.entity.includes('_Cal') && isPrimaryPhysicalStream(parsed.entity, parsed.component)) {
        stats.rawPrimarySamplesIngested++;
        const group = mapEntityToGroup(parsed.entity) ?? 'other';
        stats.rawPrimarySamplesByGroup[group] = (stats.rawPrimarySamplesByGroup[group] || 0) + 1;
      }

      // Sample time = Elodin field-0 timestamp (bridge receipt, epoch ms),
      // guarded against off-clock publishers.
      const tsMs = saneSampleTimeMs(parsed.timestamp, epochNow);

      const budget = streamBudgetFor(high, low);
      if (budget === null) {
        // Event-like streams (state, self-test, controller, sequencer): every
        // update goes out immediately, no downsampling and no staging.
        emitSensorPoint(key, parsed.entity, parsed.component, parsed.value, tsMs);
        continue;
      }

      if (budget === 'gui' && guiStreamConfig.mode === 'throttle') {
        // Legacy drop-throttle (config.toml [gui] downsample_mode = "throttle").
        const lastBcast = broadcastLastTime.get(key) ?? 0;
        if (epochNow - lastBcast < BROADCAST_MIN_MS) continue;
        broadcastLastTime.set(key, epochNow);
        emitSensorWindow(key, parsed.entity, parsed.component, [{ tMs: tsMs, value: parsed.value }]);
      } else {
        // Min/max envelope: extremes of each window survive with their real
        // timestamps, so transients can't hide between broadcast slots.
        // Encoders run on their own, much shorter window (see streamBudgetFor).
        const acc = budget === 'encoder' ? encoderEnvelope : envelope;
        const closed = acc.add(key, parsed.entity, parsed.component, tsMs, parsed.value);
        if (closed.length > 0) emitSensorWindow(key, parsed.entity, parsed.component, closed);
      }
    }
  } catch (err) {
    console.error('[ThinServer] Packet error:', err);
  }
});

// ── Crash guards — keep the process alive on unhandled rejections ────────────
// tsx watch would restart on source-file changes and compete for port 8081,
// causing EADDRINUSE to bring down both instances. We use plain `tsx` (no watch)
// in the startup script, but keep these guards as belt-and-suspenders.

process.on('uncaughtException', (err) => {
  console.error('[ThinServer] UNCAUGHT EXCEPTION — keeping server alive:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ThinServer] UNHANDLED REJECTION — keeping server alive:', reason);
});

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ThinServer] Port ${WS_PORT} already in use — another instance may be running. Retrying in 3s...`);
    setTimeout(() => httpServer.listen(WS_PORT), 3000);
  } else {
    console.error('[ThinServer] HTTP server error:', err);
  }
});

startGuiStaticServer(GUI_PORT);

httpServer.listen(WS_PORT, () => {
  console.log(`[ThinServer] WebSocket server listening on port ${WS_PORT}`);
  console.log(`[ThinServer] Elodin DB: ${ELODIN_HOST}:${ELODIN_PORT}`);
  console.log(`[ThinServer] Actuator service: localhost:${SEQUENCER_PORT}`);
  // Init the run-session manager last, once broadcast/notify + wss are live.
  // No-op (enabled=false) unless SESSION_SERVICE_MODE is mock/systemd.
  // On run stop, re-baseline board status from config (clears stale heartbeat
  // timestamps) so boards read "disconnected", matching fresh startup, instead of "---".
  sessionManager.init(broadcast, broadcastNotification, () => {
    loadBoardsFromConfig();
    broadcastBoardStatus();
    // The pipeline is down again (systemd mode); stop dialling it until the next run.
    if (!sessionManager.pipelineExpected()) elodin.disconnect();
  }, applyDeployedConfigChange, () => {
  // The run pipeline is up. Every session starts with every load cell reading absolute: the
  // controller already removed lc_tare.json, and this drops the copy a still-running service
  // holds in memory (mock mode, where nothing went down to reload it).
  publishClearAllTares(calibrationHost);
  // sensor-elodin is confirmed active by now (ServiceController.start waits for it).
  void elodin.connect();
});
  syncElodinToSession();
  // Board diagnostic logs (type-15 LOGS forwarded by daq_bridge over loopback UDP).
  startBoardLogReceiver(broadcast);
});
