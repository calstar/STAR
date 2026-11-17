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
import './elodin-protocol.js';
import './lc-tare.js';
import './ball-valve-cal.js';
import './sensor-config.js';
import './elodin-vtable-registry.js';
import './refusal-text.js';
import './script-status.js';
import { createAPIHandler } from './api-server.js';
import { VideoService } from './video/service.js';
import { startBoardLogReceiver } from './board-logs.js';
import { readConfig, readDeployedConfig } from './routes/config.js';
import './state-csv/state-actuators.js';
import type { StateActuatorMap } from './state-csv/state-actuators.js';
import './state-csv/state-transitions.js';
import { recordBoardScanIngest, getBoardScanRateHz, isPrimaryPhysicalStream, mapEntityToGroup } from './board-scan-rate.js';
import {
  EnvelopeAccumulator, parseGuiStreamConfig, envelopeWindowMs, encoderWindowMs,
  type GuiStreamConfig, type EnvelopePoint,
} from './gui-stream.js';
import './client-outbox.js';
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

setInterval(pruneHistory, 60_000);

// ── GUI stream downsampling (config.toml [gui]; see gui-stream.ts) ───────────

initGuiStream();

setInterval(flushClientOutboxes, 100);

setInterval(resetOutboxStats, 10_000);

setInterval(flushEnvelopes, 50);

// ── Mission time ─────────────────────────────────────────────────────────────

import './countdown-state.js';
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
import { handleElodinPacket } from './server/ingest.js';
import { handleMessage } from './server/commands.js';
import { handleConnection } from './server/ws-connection.js';

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

startDhcpStatusPoller();
setInterval(broadcastBoardStatus, 1000 / BOARD_STATUS_HZ);

setInterval(reapUnresponsiveClients, KEEPALIVE_MS);

// ── Client connection ─────────────────────────────────────────────────────────

wss.on('connection', handleConnection);

// ── Elodin DB connection ─────────────────────────────────────────────────────

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

elodin.on('packet', handleElodinPacket);

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
