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

import * as net from 'net';
import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { ElodinClient } from './elodin-client.js';
import { parseElodinPacket } from './elodin-protocol.js';
import { loadSensorRoleMap } from './sensor-config.js';
import { registerVTables, clearSubscriptionState } from './elodin-vtable-registry.js';
import { registerControllerVTables } from './legacy/elodin-vtable-controller.js';
import { createAPIHandler } from './api-server.js';
import { readConfig } from './routes/config.js';
import { getStateActuatorMap, CSV_ACTUATOR_TO_ENTITY, resolveActuatorCmdEntity, resolveActuatorTelemetryEntity } from './legacy/state-actuators.js';
import type { StateActuatorMap } from './legacy/state-actuators.js';
import { getStateTransitions } from './legacy/state-transitions.js';
import { recordBoardScanIngest, getBoardScanRateHz } from './board-scan-rate.js';
import { handleCalibrationCommand, type CalibrationHost } from './calibration-handler.js';
import { loadPTCalibration, type CalibrationCoefficients } from './calibration.js';
import { MessageType, SystemState } from '../../shared/types.js';
import type { NotificationPayload } from '../../shared/types.js';
import type { SensorUpdate, StateUpdate, CommandPayload, BoardStatus, ActuatorUpdate } from '../../shared/types.js';

// ── Config ───────────────────────────────────────────────────────────────────

const WS_PORT = parseInt(process.env.WS_PORT ?? '8081', 10);
const ELODIN_HOST = process.env.ELODIN_HOST ?? '127.0.0.1';
const ELODIN_PORT = parseInt(process.env.ELODIN_PORT ?? '2240', 10);
const ACT_SVC_PORT = parseInt(process.env.ACTUATOR_SERVICE_PORT ?? '9998', 10);
const CTRL_SVC_PORT = parseInt(process.env.CONTROLLER_SERVICE_PORT ?? '9999', 10);
const THIN_VERBOSE_CONNECTION_LOG = process.env.THIN_VERBOSE_CONNECTION_LOG === '1';
const THIN_HEARTBEAT_DIAG_LOG = process.env.THIN_HEARTBEAT_DIAG_LOG === '1';
const THIN_STATS_LOG = process.env.THIN_STATS_LOG === '1';

// ~20 Hz × 300 s (5 min window) ≈ 6000; keep extra for HISTORICAL_DATA on reconnect.
const HISTORY_MAX_POINTS = 16000;  // per series
const HISTORY_MAX_KEYS = 200;
const HISTORY_STALE_MS = 5 * 60 * 1000;
const BOARD_STATUS_HZ = 1;     // broadcast rate for board status
/** Board marked disconnected if no Elodin [0x10] heartbeat for this long. Too low causes UI flap when DB or TCP jitters; heartbeats are usually multi-Hz but not hard-real-time. */
const BOARD_HEARTBEAT_STALE_MS = 5000;
/** Min interval between WS SENSOR_UPDATE broadcasts for high-rate DAQ streams only.
 *  50 ms caps at ~20 Hz per key — comfortably passes 10 Hz sources even with
 *  network jitter and Date.now() quantization. */
const BROADCAST_MIN_MS = 50;

/**
 * True for PT/TC/RTD/LC raw+cal and actuator raw+state ([0x20]–[0x23], [0x30]–[0x31]).
 * Encoder ([0x24]), heartbeats ([0x10]), self-test ([0x60]), controller ([0x40]–[0x44]),
 * sequencer/PSM ([0x50]), etc. are not throttled.
 */
function shouldThrottleSensorStreamPacket(high: number, _low: number): boolean {
  if (high === 0x20 || high === 0x21 || high === 0x22 || high === 0x23) return true;
  if (high === 0x30 || high === 0x31) return true;
  return false;
}

// ── History cache (ring buffer) ───────────────────────────────────────────────
// Uses Float64Array ring buffers to avoid O(n) splice shifts on every write.

interface HistorySeries {
  tBuf: Float64Array;
  vBuf: Float64Array;
  head: number;   // next write index
  len:  number;   // fill count 0..HISTORY_MAX_POINTS
  lastMs: number;
}

const historyCache = new Map<string, HistorySeries>();
const historyCacheTime = new Map<string, number>(); // wall-clock last update
const broadcastLastTime = new Map<string, number>();  // per-key throttle gate

function recordHistory(key: string, timeSec: number, value: number): void {
  let s = historyCache.get(key);
  if (!s) {
    s = { tBuf: new Float64Array(HISTORY_MAX_POINTS), vBuf: new Float64Array(HISTORY_MAX_POINTS), head: 0, len: 0, lastMs: 0 };
    historyCache.set(key, s);
  }
  // Overwrite last entry if same timestamp; otherwise advance ring.
  const lastIdx = (s.head - 1 + HISTORY_MAX_POINTS) % HISTORY_MAX_POINTS;
  if (s.len > 0 && s.tBuf[lastIdx] === timeSec) {
    s.vBuf[lastIdx] = value;
  } else {
    s.tBuf[s.head] = timeSec;
    s.vBuf[s.head] = value;
    s.head = (s.head + 1) % HISTORY_MAX_POINTS;
    if (s.len < HISTORY_MAX_POINTS) s.len++;
  }
  const now = Date.now();
  s.lastMs = now;
  historyCacheTime.set(key, now);
}

/** Read ring buffer as plain arrays for sendHistoricalData (allocates once per call, OK since it's only on connect). */
function readHistorySeries(s: HistorySeries): { time: number[]; values: number[] } {
  const len = s.len;
  const tail = len < HISTORY_MAX_POINTS ? 0 : s.head;
  const time: number[] = new Array(len);
  const values: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const idx = (tail + i) % HISTORY_MAX_POINTS;
    time[i]   = s.tBuf[idx];
    values[i] = s.vBuf[idx];
  }
  return { time, values };
}

function pruneHistory(): void {
  const now = Date.now();
  if (historyCache.size <= HISTORY_MAX_KEYS) {
    for (const [key, s] of historyCache) {
      if (now - s.lastMs > HISTORY_STALE_MS) {
        historyCache.delete(key);
        historyCacheTime.delete(key);
      }
    }
  } else {
    const byAge = Array.from(historyCacheTime.entries()).sort((a, b) => a[1] - b[1]);
    const toRemove = historyCache.size - HISTORY_MAX_KEYS;
    for (let i = 0; i < toRemove && i < byAge.length; i++) {
      historyCache.delete(byAge[i][0]);
      historyCacheTime.delete(byAge[i][0]);
    }
  }
}

setInterval(pruneHistory, 60_000);

// ── Mission time ─────────────────────────────────────────────────────────────

let firstPacketTimeMs: number | null = null;
import { loadCountdownTargetTimeMs, saveCountdownTargetTimeMs } from './countdown-state.js';
let countdownTargetMs: number | null = loadCountdownTargetTimeMs();

// ── Calibration state ────────────────────────────────────────────────────────

const ptCalibration = new Map<number, CalibrationCoefficients>();
const calibrationPoints = new Map<number, { adc: number; pressure: number }[]>();
const lastRawAdc = new Map<number, number>();
let ptCalibrationFilePath: string | null = null;

// Load existing calibration file if available
try {
  const loaded = loadPTCalibration();
  if (loaded.map.size > 0) {
    for (const [k, v] of loaded.map) ptCalibration.set(k, v);
    ptCalibrationFilePath = loaded.filePath;
    console.log(`[ThinServer] Loaded ${ptCalibration.size} PT calibrations from ${loaded.filePath}`);
  }
} catch { /* no calibration file — fine */ }

const calChannelToEntityMap = loadSensorRoleMap().channelToEntityMap;

/** Cached slot→board_id map for uniqueIdFromPtEntity — built once, avoids config re-reads on hot path. */
const _ptSlotToBoardId = new Map<number, number>();
function _ensurePtSlotCache(): void {
  if (_ptSlotToBoardId.size > 0) return;
  try {
    const config = readConfig();
    const boards = (config.boards || {}) as Record<string, Record<string, unknown>>;
    for (const [, raw] of Object.entries(boards)) {
      const bid = raw.board_id;
      const typ = raw.type;
      if (typeof bid !== 'number' || typ !== 'PT') continue;
      const mod = bid % 10;
      _ptSlotToBoardId.set(mod === 0 ? 10 : mod, bid);
    }
  } catch { /* fine — fallback below */ }
}

/** Map PT{n}.CH{m} entity to uniqueId = board_id*100+local_ch (matches calibration_service). */
function uniqueIdFromPtEntity(entity: string): number | null {
  const m = entity.match(/^PT(\d+)(?:_Cal)?\.CH(\d+)$/);
  if (!m) return null;
  const slot = parseInt(m[1], 10);
  const ch = parseInt(m[2], 10);
  _ensurePtSlotCache();
  const bid = _ptSlotToBoardId.get(slot);
  return bid !== undefined ? bid * 100 + ch : slot * 100 + ch;
}

const calibrationHost: CalibrationHost = {
  ptCalibration,
  ptCalibrationFilePath,
  calibrationPoints,
  channelToEntityMap: calChannelToEntityMap,
  lastRawAdc,
  send,
  broadcast,
  elodin: null as any, // Will be set after elodin connection
};

// ── Board status ─────────────────────────────────────────────────────────────

const boardsStatus = new Map<number, BoardStatus>();

// Pre-populate expected boards from config.toml so the frontend knows about them
// before any heartbeats arrive.
function loadBoardsFromConfig(): void {
  try {
    const config = readConfig();
    const boards = (config.boards || {}) as Record<string, any>;
    for (const [, raw] of Object.entries(boards)) {
      const board = raw as any;
      if (board.enabled === false) continue;
      const id: number | undefined = typeof board.board_id === 'number' ? board.board_id : undefined;
      if (id === undefined) continue;
      const type: string = board.type || 'UNKNOWN';
      const boardNumber: number | null = typeof board.board_number === 'number'
        ? board.board_number
        : (typeof board.board_id === 'number' ? board.board_id : null);
      const ip = typeof board.ip === 'string' ? board.ip : `192.168.2.${id}`;
      boardsStatus.set(id, {
        type, boardNumber, id, ip,
        expected: true,
        connected: false,
        lastHeartbeatMs: null,
        heartbeatTimes: [],
        boardState: null,
        engineState: null,
      });
    }
    console.log(`[ThinServer] Loaded ${boardsStatus.size} boards from config.toml`);
  } catch (err) {
    console.warn('[ThinServer] Could not load boards from config.toml:', err);
  }
}

loadBoardsFromConfig();

// ── State actuator map (expected positions per state from CSV) ────────────────

const STATE_ACTUATOR_MAP: StateActuatorMap = getStateActuatorMap();

/**
 * Build entity→expected map for a given state.
 * Keys must match Elodin [0x31] actuator_state entities (ACT{n}.CH{m}), not ACT.Role_Name,
 * or mismatch detection never lines up with sensed state.
 */
function getExpectedPositions(state: SystemState): Record<string, number> {
  const expected = STATE_ACTUATOR_MAP[state];
  if (!expected) return {};
  const result: Record<string, number> = {};
  for (const [name, value] of Object.entries(expected)) {
    const tel = resolveActuatorTelemetryEntity(name);
    if (tel) {
      result[tel] = value;
      continue;
    }
    const entity = CSV_ACTUATOR_TO_ENTITY[name] || `ACT.${name.replace(/\s+/g, '_')}`;
    result[entity] = value;
  }
  return result;
}

/** Push CSV-derived commanded actuator states using ACT_CMD.B*.CH* keys (matches Elodin [0x32] + GUI). */
function broadcastCommandedActuatorsForState(state: SystemState): void {
  const raw = STATE_ACTUATOR_MAP[state];
  if (!raw) return;
  const epochNow = Date.now();
  for (const [actuatorName, value] of Object.entries(raw)) {
    const cmdEntity = resolveActuatorCmdEntity(actuatorName);
    if (!cmdEntity) continue;
    const key = `${cmdEntity}.actuator_state_commanded`;
    if (firstPacketTimeMs !== null) {
      const timeSec = (epochNow - firstPacketTimeMs) / 1000;
      if (timeSec >= 0 && timeSec < 86400) recordHistory(key, timeSec, value);
    }
    stats.sensorUpdatesBroadcast++;
    broadcast({
      type: MessageType.SENSOR_UPDATE,
      timestamp: epochNow,
      payload: { entity: cmdEntity, component: 'actuator_state_commanded', value, timestamp: epochNow },
    });
  }
}

// ── Actuator state mismatch detection ────────────────────────────────────────

/** Last-known actuator_state (sensed from [0x31] current-sense) per entity */
const actuatorSensedState = new Map<string, number>();
const ACTUATOR_MISMATCH_DELAY_MS = 5000;
let actuatorMismatchTimer: NodeJS.Timeout | null = null;

function scheduleActuatorMismatchCheck(state: SystemState): void {
  if (actuatorMismatchTimer) clearTimeout(actuatorMismatchTimer);
  actuatorMismatchTimer = setTimeout(() => {
    actuatorMismatchTimer = null;
    checkActuatorMismatch(state);
  }, ACTUATOR_MISMATCH_DELAY_MS);
}

function checkActuatorMismatch(state: SystemState): void {
  const expected = getExpectedPositions(state);
  if (Object.keys(expected).length === 0) return;

  const now = Date.now();
  const mismatched: string[] = [];

  for (const [entity, expectedPos] of Object.entries(expected)) {
    const sensed = actuatorSensedState.get(entity);
    if (sensed === undefined) continue; // no data yet — don't alert
    if (sensed !== expectedPos) {
      const expLabel = expectedPos === 1 ? 'OPEN' : 'CLOSED';
      const actLabel = sensed === 1 ? 'OPEN' : 'CLOSED';
      const name = entity.replace('ACT.', '').replace(/_/g, ' ');
      mismatched.push(`${name} (expected ${expLabel}, sensed ${actLabel})`);
    }
  }

  const key = 'actuator_mismatch';
  if (mismatched.length > 0) {
    const stateName = SystemState[state] ?? 'UNKNOWN';
    const msg = `Actuator mismatch in ${stateName}: ${mismatched.join(', ')}`;
    console.warn(`[ThinServer] ⚠️ ${msg}`);
    broadcastNotification({ key, category: 'warning', message: msg, timestampMs: now, ongoing: true });
    activeNotificationKeys.add(key);
  } else if (activeNotificationKeys.has(key)) {
    broadcastNotification({ key, category: 'warning', message: 'Actuator positions match expected', timestampMs: now, ongoing: false });
    activeNotificationKeys.delete(key);
  }
}

function updateBoard(low: number, payload: Buffer): void {
  if (payload.length < 16) return;
  const boardId = low;
  const boardType = payload.readUInt8(9);
  const engineState = payload.readUInt8(10);
  const boardState = payload.readUInt8(11);
  const now = Date.now();

  let typeStr = 'UNKNOWN';
  if (boardType === 1) typeStr = 'PT';
  else if (boardType === 2) typeStr = 'TC';
  else if (boardType === 3) typeStr = 'RTD';
  else if (boardType === 4) typeStr = 'LC';
  else if (boardType === 5) typeStr = 'ACTUATOR';
  else if (boardType === 6 || boardId === 61) typeStr = 'ENCODER';

  let status = boardsStatus.get(boardId);
  const wasDisconnected = !status || status.lastHeartbeatMs == null || now - (status.lastHeartbeatMs ?? 0) > BOARD_HEARTBEAT_STALE_MS;

  if (!status) {
    status = {
      type: typeStr, boardNumber: null, id: boardId,
      ip: `192.168.2.${boardId}`, expected: false,
      connected: true, lastHeartbeatMs: now,
      heartbeatTimes: [now], boardState, engineState,
    };
    boardsStatus.set(boardId, status);
  } else {
    status.connected = true;
    status.lastHeartbeatMs = now;
    status.boardState = boardState;
    status.engineState = engineState;
    status.heartbeatTimes = status.heartbeatTimes ?? [];
    status.heartbeatTimes.push(now);
    if (status.heartbeatTimes.length > 20) status.heartbeatTimes.shift();
  }

  if (wasDisconnected) {
    broadcastBoardStatus();
    if (THIN_VERBOSE_CONNECTION_LOG) {
      console.log(`[ThinServer] Board ${boardId} (${typeStr}) connected`);
    }
  }
}

// Periodic heartbeat rate diagnostic — log actual arrival rates so we can
// see if Elodin is delivering duplicates vs boards sending too fast.
let hbDiagCount = new Map<number, number>();
setInterval(() => {
  if (THIN_HEARTBEAT_DIAG_LOG && hbDiagCount.size > 0) {
    const entries = Array.from(hbDiagCount.entries())
      .map(([id, count]) => `board ${id}=${count}/s`)
      .join(', ');
    console.log(`[ThinServer] Heartbeat arrival rate: ${entries}`);
  }
  hbDiagCount.clear();
  if (THIN_STATS_LOG && stats.relayEntityUpdatesReceived > 0) {
    console.log(`[ThinServer] Stats: entityUpdates=${stats.relayEntityUpdatesReceived} broadcasts=${stats.sensorUpdatesBroadcast} wsClients=${wss.clients.size}`);
  }
}, 5000);

// Count heartbeat arrivals (called from packet handler before updateBoard)
function countHeartbeat(boardId: number): void {
  hbDiagCount.set(boardId, (hbDiagCount.get(boardId) ?? 0) + 1);
}

// ── Board notifications ──────────────────────────────────────────────────────

const BOARD_STATE_SETUP = 1;
const SETUP_STUCK_THRESHOLD_MS = 4000;

const prevConnectedState = new Map<number, boolean>();
const boardFirstSeenSetupMs = new Map<number, number>();
const activeNotificationKeys = new Set<string>();
const selfTestNotifiedBoards = new Set<number>();
/** Latest self-test results — key = "SELF_TEST.BOARD_{id}.sensor_{n}", value = 0|1.
 *  Replayed as SENSOR_UPDATE on WS connect so late-connecting browsers see results. */
const selfTestLatest = new Map<string, SensorUpdate>();

function broadcastNotification(payload: NotificationPayload): void {
  broadcast({ type: MessageType.NOTIFICATION, timestamp: Date.now(), payload });
}

function boardLabel(status: BoardStatus): string {
  const num = status.boardNumber ?? status.id;
  return `Board ${num} (${status.type})`;
}

// Mark boards with no recent heartbeat as disconnected each tick,
// and generate notifications for board health changes.
function markStaleBoards(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, status] of boardsStatus) {
    const stale = status.lastHeartbeatMs == null || now - status.lastHeartbeatMs > BOARD_HEARTBEAT_STALE_MS;
    if (stale && status.connected) {
      status.connected = false;
      changed = true;
    }

    const prev = prevConnectedState.get(id);
    const label = boardLabel(status);

    // Board connection lost
    const lostKey = `board_lost_${id}`;
    if (prev === true && !status.connected) {
      broadcastNotification({ key: lostKey, category: 'error', message: `${label} connection lost`, timestampMs: now, ongoing: true });
      activeNotificationKeys.add(lostKey);
    } else if (status.connected && activeNotificationKeys.has(lostKey)) {
      broadcastNotification({ key: lostKey, category: 'error', message: `${label} connection lost`, timestampMs: now, ongoing: false });
      activeNotificationKeys.delete(lostKey);
    }

    // Board connected (one-shot)
    if ((prev === false || prev === undefined) && status.connected) {
      broadcastNotification({ category: 'info', message: `${label} connected`, timestampMs: now });
    }

    // Board stuck in setup
    const stuckKey = `setup_stuck_${id}`;
    const inSetup = status.connected && status.boardState === BOARD_STATE_SETUP;
    if (inSetup) {
      if (!boardFirstSeenSetupMs.has(id)) boardFirstSeenSetupMs.set(id, now);
      const first = boardFirstSeenSetupMs.get(id)!;
      if (now - first > SETUP_STUCK_THRESHOLD_MS && !activeNotificationKeys.has(stuckKey)) {
        broadcastNotification({ key: stuckKey, category: 'error', message: `${label} stuck in setup`, timestampMs: first, ongoing: true });
        activeNotificationKeys.add(stuckKey);
      }
    } else {
      boardFirstSeenSetupMs.delete(id);
      if (activeNotificationKeys.has(stuckKey)) {
        broadcastNotification({ key: stuckKey, category: 'error', message: `${label} stuck in setup`, timestampMs: now, ongoing: false });
        activeNotificationKeys.delete(stuckKey);
      }
    }

    // Unrecognized board
    const unrecKey = `unrecognized_${id}`;
    if (status.connected && !status.expected) {
      if (!activeNotificationKeys.has(unrecKey)) {
        broadcastNotification({ key: unrecKey, category: 'warning', message: `Unrecognized board at ${status.ip}`, timestampMs: now, ongoing: true });
        activeNotificationKeys.add(unrecKey);
      }
    } else if (!status.connected && activeNotificationKeys.has(unrecKey)) {
      broadcastNotification({ key: unrecKey, category: 'warning', message: `Unrecognized board at ${status.ip}`, timestampMs: now, ongoing: false });
      activeNotificationKeys.delete(unrecKey);
    }

    prevConnectedState.set(id, status.connected);
  }
  if (changed) broadcastBoardStatus();
}

setInterval(markStaleBoards, 1000);

// ── Packet stats ─────────────────────────────────────────────────────────────
// Counts raw entity updates received from Elodin DB vs broadcasts sent to WS clients.
// GET /stats returns these so the integration test can verify no drops occur before
// the throttle (Elodin→backend must be lossless; backend→WS is intentionally throttled).

const stats = {
  relayEntityUpdatesReceived: 0,  // every finite-value entity parsed from Elodin DB
  sensorUpdatesBroadcast: 0,  // SENSOR_UPDATE messages actually sent (post-throttle)
  sequencerStatesReceived: 0,  // packets successfully streamed through Elodin DB verifying storage
  startTimeMs: Date.now(),
};

// ── Local state (sequencer / actuator_service authoritative) ────────────────
let currentState: SystemState = SystemState.IDLE;
let debugMode = false;

// ── HTTP + WebSocket server ──────────────────────────────────────────────────

const apiHandler = createAPIHandler({
  getEngineState: () => currentState,
  getDebugInfo: () => ({
    relayConnected: elodin.isConnected(),
    relayPacketsReceived: stats.relayEntityUpdatesReceived,
    wsClients: wss.clients.size,
    sensorCacheSize: historyCache.size,
    useRelay: false,
    boardScanRateHz: getBoardScanRateHz(),
  }),
});

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
const wss = new WebSocketServer({ server: httpServer });
let wsConnCounter = 0;

function broadcast(message: object): void {
  if (wss.clients.size === 0) return;
  const data = JSON.stringify(message);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (_) { /* ignore disconnected */ }
    }
  });
}

function send(ws: WebSocket, message: object): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(message)); } catch (_) { }
}

function broadcastBoardStatus(): void {
  const boards = Array.from(boardsStatus.values());
  if (boards.length === 0) return;

  // Compute frequencyHz from heartbeatTimes for each board
  for (const b of boards) {
    const times = b.heartbeatTimes;
    if (times && times.length >= 2) {
      const span = times[times.length - 1] - times[0];
      if (span > 0) {
        (b as any).frequencyHz = (times.length - 1) / (span / 1000);
      }
    }
  }

  broadcast({ type: MessageType.BOARD_STATUS_UPDATE, timestamp: Date.now(), payload: { boards } });
}

setInterval(broadcastBoardStatus, 1000 / BOARD_STATUS_HZ);

// ── Client connection ─────────────────────────────────────────────────────────

wss.on('connection', (ws: WebSocket, req) => {
  const connId = `c${++wsConnCounter}`;
  const openedAt = Date.now();
  const remoteAddr =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const userAgent = req.headers['user-agent'] ?? 'unknown';
  let inboundMessages = 0;
  let outboundMessages = 0;
  let lastInboundAt = 0;
  let lastOutboundAt = 0;
  console.log(`[WS_BACKEND] ${JSON.stringify({ event: 'conn_open', ts: openedAt, connId, remoteAddr, userAgent, wsClients: wss.clients.size })}`);

  // Connection status
  send(ws, {
    type: MessageType.CONNECTION_STATUS, timestamp: Date.now(),
    payload: { connected: true, elodinConnected: elodin.isConnected(), connId },
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

  // Current state
  send(ws, {
    type: MessageType.STATE_UPDATE, timestamp: Date.now(),
    payload: { currentState, stateName: SystemState[currentState] ?? 'UNKNOWN', timestamp: Date.now(), debugMode },
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

  // Historical data
  sendHistoricalData(ws);
  outboundMessages++;
  lastOutboundAt = Date.now();

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

function sendHistoricalData(ws: WebSocket): void {
  const MAX_SEND_POINTS = 3000;
  const payload: Record<string, { time: number[]; values: number[] }> = {};
  for (const [key, series] of historyCache) {
    if (series.len === 0) continue;
    const { time, values } = readHistorySeries(series);
    const start = time.length > MAX_SEND_POINTS ? time.length - MAX_SEND_POINTS : 0;
    payload[key] = start > 0
      ? { time: time.slice(start), values: values.slice(start) }
      : { time, values };
  }
  send(ws, { type: MessageType.HISTORICAL_DATA, timestamp: Date.now(), payload });
}

// ── Message handling ─────────────────────────────────────────────────────────

function handleMessage(ws: WebSocket, message: any): void {
  switch (message.type) {
    case MessageType.SEND_COMMAND:
      handleCommand(ws, message.payload as CommandPayload);
      break;
    case MessageType.QUERY_HISTORICAL:
      sendHistoricalData(ws);
      break;
    case MessageType.CALIBRATION_COMMAND:
      handleCalibrationCommand(calibrationHost, ws, message.payload);
      break;
    case MessageType.SUBSCRIBE_SENSOR:
    case MessageType.UNSUBSCRIBE_SENSOR:
      // Thin backend broadcasts all updates to all clients, ignore filter requests safely.
      break;
    case 'get_state_transitions':
      send(ws, { type: 'state_transitions', timestamp: Date.now(), payload: { transitions: getStateTransitions() } });
      break;
    default:
      console.warn('[ThinServer] Unknown message type:', message.type);
  }
}

function broadcastStateUpdate(): void {
  broadcast({
    type: MessageType.STATE_UPDATE, timestamp: Date.now(),
    payload: { currentState, stateName: SystemState[currentState] ?? 'UNKNOWN', timestamp: Date.now(), debugMode },
  });
}

function handleCommand(ws: WebSocket, command: CommandPayload): void {
  switch (command.commandType) {
    case 'state_transition': {
      const targetState = command.data.state!;
      const stateName = SystemState[targetState] ?? String(targetState);
      const csvName = STATE_TO_CSV_NAME[stateName] ?? stateName;
      // No optimistic update — real state/actuator positions arrive via _SEQUENCER_STATE [0x50]
      // and [0x32] packets from Elodin. FIRE_START/FIRE_STOP are sent from the subscriber path.
      sendToActuatorService(`TRANSITION:${csvName}\n`).then(({ ok, reply }) => {
        console.log(`[ThinServer] State transition ${stateName} → ${csvName}: ${ok ? 'OK' : 'FAIL'} (${reply})`);
        if (!ok) {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `State transition failed: ${reply}` } });
        }
      });
      break;
    }
    case 'actuator': {
      const open = command.data.actuatorState === 1 || command.data.actuatorState as unknown as string === 'open';
      const actuatorName = command.data.actuatorName!;
      // No optimistic update — real commanded state arrives via [0x32] packets from Elodin.
      sendToActuatorService(`ACTUATOR:${actuatorName}:${open ? 1 : 0}\n`).then(({ ok, reply }) => {
        if (!ok) {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Actuator command failed: ${reply}` } });
        }
      });
      break;
    }
    case 'debug_mode': {
      const newDebug = !!command.data.debugMode;
      sendToActuatorService(`DEBUG_MODE:${newDebug ? 1 : 0}\n`).then(({ ok, reply }) => {
        console.log(`[ThinServer] Debug mode ${newDebug ? 'ON' : 'OFF'}: ${ok ? 'OK' : 'FAIL'} (${reply})`);
        if (ok) {
          debugMode = newDebug;
          broadcastStateUpdate();
        }
      }).catch(() => { });
      break;
    }
    case 'extend_fire':
      sendToActuatorService('EXTEND_FIRE\n').catch(() => { });
      break;
    case 'set_countdown_target':
      countdownTargetMs = command.data.targetTimeMs ?? null;
      saveCountdownTargetTimeMs(countdownTargetMs);
      broadcast({ type: MessageType.COUNTDOWN_TARGET_UPDATE, timestamp: Date.now(), payload: { targetTimeMs: countdownTargetMs } });
      break;
    default:
      // stub for unhandled commands (calibration, controller_frequency, etc.)
      send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Command not supported in thin backend: ${command.commandType}` } });
  }
}

// ── Actuator service TCP forwarding ─────────────────────────────────────────

function sendToActuatorService(line: string): Promise<{ ok: boolean; reply: string }> {
  return new Promise((resolve) => {
    let replyData = '';
    let resolved = false;
    const done = (ok: boolean, reply: string) => {
      if (resolved) return;
      resolved = true;
      resolve({ ok, reply });
    };
    const socket = net.connect({ host: '127.0.0.1', port: ACT_SVC_PORT }, () => {
      console.log(`[ThinServer] → actuator_service: ${line.trim()}`);
      socket.write(line);
    });
    socket.on('data', (data) => {
      replyData += data.toString();
      if (replyData.includes('\n')) {
        socket.destroy();
        const reply = replyData.trim();
        done(reply === 'OK', reply);
      }
    });
    socket.on('close', () => done(false, replyData.trim() || 'connection closed'));
    socket.on('error', (err) => {
      console.warn(`[ThinServer] actuator_service connect error: ${err.message}`);
      done(false, err.message);
    });
    socket.setTimeout(2000, () => { socket.destroy(); done(false, 'timeout'); });
  });
}

function sendToControllerService(line: string): Promise<{ ok: boolean; reply: string }> {
  return new Promise((resolve) => {
    let replyData = '';
    let resolved = false;
    const done = (ok: boolean, reply: string) => {
      if (resolved) return;
      resolved = true;
      resolve({ ok, reply });
    };
    const socket = net.connect({ host: '127.0.0.1', port: CTRL_SVC_PORT }, () => {
      socket.write(line);
    });
    socket.on('data', (data) => {
      replyData += data.toString();
      if (replyData.includes('\n')) {
        socket.destroy();
        const reply = replyData.trim();
        done(reply === 'OK', reply);
      }
    });
    socket.on('close', () => done(false, replyData.trim() || 'connection closed'));
    socket.on('error', (err) => done(false, err.message));
    socket.setTimeout(2000, () => { socket.destroy(); done(false, 'timeout'); });
  });
}

// ── Elodin DB connection ─────────────────────────────────────────────────────

const elodin = new ElodinClient(ELODIN_HOST, ELODIN_PORT);

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

// VTable resubscription — Elodin DB rejects subscriptions for VTables not yet
// registered by other services (e.g., daq_bridge). Retry every 5s until all
// expected packet groups flow.
let resubscribeTimer: NodeJS.Timeout | null = null;
const MAX_RESUBSCRIBE_ATTEMPTS = 24;
let shouldResubscribe = true;

function scheduleResubscribe(attempt: number): void {
  if (!shouldResubscribe) return;
  if (attempt > MAX_RESUBSCRIBE_ATTEMPTS) return;
  if (resubscribeTimer) return;
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null;
    if (!elodin.isConnected()) return;
    if (!shouldResubscribe) return;
    registerVTables(elodin).then(() => {
      scheduleResubscribe(attempt + 1);
    }).catch(() => {
      scheduleResubscribe(attempt + 1);
    });
  }, 5000);
}

elodin.on('connected', () => {
  console.log('[ThinServer] Elodin Connected');
  broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: true } });

  if (resubscribeTimer) { clearTimeout(resubscribeTimer); resubscribeTimer = null; }
  shouldResubscribe = true;

  calibrationHost.elodin = elodin;
  registerVTables(elodin).then(() => {
    scheduleResubscribe(1);
  });
  registerControllerVTables(elodin);
  console.log('[ThinServer] Connected to Elodin, registered VTables.');
});

elodin.on('disconnected', () => {
  console.log('[ThinServer] Elodin DB disconnected');
  broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: false } });
  if (resubscribeTimer) { clearTimeout(resubscribeTimer); resubscribeTimer = null; }
  clearSubscriptionState();
});

elodin.on('error', (err: Error) => {
  console.error('[ThinServer] Elodin error:', err.message);
});

elodin.on('packet', (header: any, payload: Buffer) => {
  try {
    const [high, low] = header.packetId as [number, number];

    // ── Board heartbeat [0x10, board_id] ────────────────────────────────────
    if (high === 0x10) {
      countHeartbeat(low);
      updateBoard(low, payload);
      return;
    }

    // ── Parse sensor/actuator/state packets ──────────────────────────────────
    const parsedList = parseElodinPacket(header.packetId, payload);

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
      const prevState = currentState;
      const stateVal = parsedList.find(p => p.component === 'state')?.value ?? 0;
      const bitmask = parsedList.find(p => p.component === 'allowedBitmask')?.value ?? 0;
      const debugModeVal = parsedList.find(p => p.component === 'debugMode')?.value ?? 0;
      if (THIN_VERBOSE_CONNECTION_LOG) {
        console.log(`[ThinServer] SequencerState from Elodin: state=${stateVal} bitmask=0x${bitmask.toString(16)} debug=${debugModeVal}`);
      }
      stats.sequencerStatesReceived++;
      // Sync local state from Elodin (backup path — primary is TCP reply)
      currentState = stateVal as SystemState;
      debugMode = debugModeVal === 1;
      broadcastStateUpdate();
      broadcastCommandedActuatorsForState(currentState);
      scheduleActuatorMismatchCheck(currentState);
      if (currentState === SystemState.FIRE && prevState !== SystemState.FIRE) {
        sendToControllerService('FIRE_START\n').catch(() => { /* non-fatal */ });
      } else if (prevState === SystemState.FIRE && currentState !== SystemState.FIRE) {
        sendToControllerService('FIRE_STOP\n').catch(() => { /* non-fatal */ });
      }
      return;
    }

    for (const parsed of parsedList) {
      if (!Number.isFinite(parsed.value)) continue;

      // Track actuator sensed state [0x31] for mismatch detection
      if (parsed.component === 'actuator_state') {
        const prev = actuatorSensedState.get(parsed.entity);
        actuatorSensedState.set(parsed.entity, parsed.value);
        // Re-check mismatch when sensed state changes (clears "current" flag when resolved)
        if (prev !== parsed.value && activeNotificationKeys.has('actuator_mismatch')) {
          scheduleActuatorMismatchCheck(currentState);
        }
      }

      // Track raw ADC for calibration (uniqueId = board_id*100+channel, same as calibration_service)
      if (parsed.component === 'raw_adc_counts') {
        const uid = uniqueIdFromPtEntity(parsed.entity);
        if (uid != null) lastRawAdc.set(uid, parsed.value);
      }

      // Set mission T+0 on first meaningful data packet.
      if (firstPacketTimeMs === null) {
        firstPacketTimeMs = epochNow;
        if (THIN_VERBOSE_CONNECTION_LOG) {
          console.log(`[ThinServer] Mission T+0: ${new Date(firstPacketTimeMs).toISOString()}`);
        }
        broadcast({ type: MessageType.MISSION_START_TIME, timestamp: Date.now(), payload: { missionStartTime: firstPacketTimeMs } });
        shouldResubscribe = false;
        if (resubscribeTimer) { clearTimeout(resubscribeTimer); resubscribeTimer = null; }
      }

      const key = `${parsed.entity}.${parsed.component}`;
      stats.relayEntityUpdatesReceived++;

      // Pre-throttle ingest rate (what boards/Elodin actually deliver) — not WS broadcast rate.
      recordBoardScanIngest(parsed.entity, parsed.component);

      const throttle = shouldThrottleSensorStreamPacket(high, low);
      const lastBcast = broadcastLastTime.get(key) ?? 0;
      if (throttle && epochNow - lastBcast < BROADCAST_MIN_MS) continue;
      broadcastLastTime.set(key, epochNow);

      const update: SensorUpdate = { entity: parsed.entity, component: parsed.component, value: parsed.value, timestamp: epochNow };
      const timeSec = (epochNow - firstPacketTimeMs) / 1000;

      if (timeSec >= 0 && timeSec < 86400) {
        recordHistory(key, timeSec, parsed.value);
      }

      stats.sensorUpdatesBroadcast++;
      broadcast({ type: MessageType.SENSOR_UPDATE, timestamp: epochNow, payload: update });
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

elodin.connect().then((ok) => {
  if (!ok) {
    console.warn('[ThinServer] Initial Elodin DB connect failed — will retry automatically');
  }
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ThinServer] Port ${WS_PORT} already in use — another instance may be running. Retrying in 3s...`);
    setTimeout(() => httpServer.listen(WS_PORT), 3000);
  } else {
    console.error('[ThinServer] HTTP server error:', err);
  }
});

httpServer.listen(WS_PORT, () => {
  console.log(`[ThinServer] WebSocket server listening on port ${WS_PORT}`);
  console.log(`[ThinServer] Elodin DB: ${ELODIN_HOST}:${ELODIN_PORT}`);
  console.log(`[ThinServer] Actuator service: localhost:${ACT_SVC_PORT}`);
});
