/**
 * server.ts — Minimal Node.js WebSocket bridge for browser clients.
 * (Formerly server-thin.ts — now the default backend server.)
 *
 * Responsibilities:
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
import { ElodinRelayClient } from './elodin-relay-client.js';
import { parseElodinPacket } from './elodin-protocol.js';
import { loadSensorRoleMap, loadActuatorChannelToEntityMap } from './sensor-config.js';
import { createAPIHandler } from './api-server.js';
import { readConfig } from './routes/config.js';
import { MessageType, SystemState } from '../../shared/types.js';
import type { SensorUpdate, StateUpdate, CommandPayload, BoardStatus, ActuatorUpdate } from '../../shared/types.js';

// ── Config ───────────────────────────────────────────────────────────────────

const WS_PORT       = parseInt(process.env.WS_PORT     ?? '8082', 10);
const RELAY_URL     = process.env.ELODIN_RELAY_URL      ?? 'ws://localhost:9090';
const ACT_SVC_PORT  = parseInt(process.env.ACTUATOR_SERVICE_PORT ?? '9998', 10);

const HISTORY_MAX_POINTS = 1000;  // per series
const HISTORY_MAX_KEYS   = 80;
const HISTORY_STALE_MS   = 5 * 60 * 1000;
const BOARD_STATUS_HZ    = 1;     // broadcast rate for board status
/** Min interval between WS SENSOR_UPDATE broadcasts for high-rate DAQ streams only (~10 Hz per key).
 *  Set to 90 ms (not 100) so that 10 Hz sources aren't randomly dropped by Date.now() jitter. */
const BROADCAST_MIN_MS   = 90;

/**
 * True for PT/TC/RTD/LC/ENC raw+cal and actuator raw+state ([0x20]–[0x24], [0x30]–[0x31]).
 * Heartbeats ([0x10]), self-test ([0x60]), controller ([0x40]–[0x44]), sequencer/PSM ([0x50]), etc. are not throttled.
 */
function shouldThrottleSensorStreamPacket(high: number, _low: number): boolean {
  if (high === 0x20 || high === 0x21 || high === 0x22 || high === 0x23 || high === 0x24) return true;
  if (high === 0x30 || high === 0x31) return true;
  return false;
}

// ── History cache ────────────────────────────────────────────────────────────

interface HistorySeries {
  time: number[];
  values: number[];
  lastMs: number;
}

const historyCache     = new Map<string, HistorySeries>();
const historyCacheTime = new Map<string, number>(); // wall-clock last update
const broadcastLastTime = new Map<string, number>();  // per-key 10 Hz gate

function recordHistory(key: string, timeSec: number, value: number): void {
  let s = historyCache.get(key);
  if (!s) {
    s = { time: [], values: [], lastMs: Date.now() };
    historyCache.set(key, s);
  }
  const lastT = s.time.length > 0 ? s.time[s.time.length - 1] : -Infinity;
  if (timeSec > lastT) {
    s.time.push(timeSec);
    s.values.push(value);
  } else if (timeSec === lastT) {
    s.values[s.values.length - 1] = value;
  }
  if (s.time.length > HISTORY_MAX_POINTS) {
    const excess = s.time.length - HISTORY_MAX_POINTS;
    s.time.splice(0, excess);
    s.values.splice(0, excess);
  }
  s.lastMs = Date.now();
  historyCacheTime.set(key, Date.now());
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

function updateBoard(low: number, payload: Buffer): void {
  if (payload.length < 16) return;
  const boardId    = low;
  const boardType  = payload.readUInt8(9);
  const engineState = payload.readUInt8(10);
  const boardState = payload.readUInt8(11);
  const now        = Date.now();

  let typeStr = 'UNKNOWN';
  if (boardType === 1)      typeStr = 'PT';
  else if (boardType === 2) typeStr = 'TC';
  else if (boardType === 3) typeStr = 'RTD';
  else if (boardType === 4) typeStr = 'LC';
  else if (boardType === 5) typeStr = 'ACTUATOR';
  else if (boardType === 6 || boardId === 61) typeStr = 'ENCODER';

  let status = boardsStatus.get(boardId);
  const wasDisconnected = !status || status.lastHeartbeatMs == null || now - (status.lastHeartbeatMs ?? 0) > 2500;

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
    console.log(`[ThinServer] Board ${boardId} (${typeStr}) connected`);
  }
}

// Mark boards with no recent heartbeat as disconnected each tick.
function markStaleBoards(): void {
  const now = Date.now();
  let changed = false;
  for (const [, status] of boardsStatus) {
    const stale = status.lastHeartbeatMs == null || now - status.lastHeartbeatMs > 2500;
    if (stale && status.connected) {
      status.connected = false;
      changed = true;
    }
  }
  if (changed) broadcastBoardStatus();
}

setInterval(markStaleBoards, 1000);

// ── Packet stats ─────────────────────────────────────────────────────────────
// Counts raw entity updates received from relay vs broadcasts sent to WS clients.
// GET /stats returns these so the integration test can verify no drops occur before
// the 10 Hz throttle (relay→backend must be lossless; backend→WS is intentionally
// throttled).

const stats = {
  relayEntityUpdatesReceived: 0,  // every finite-value entity parsed from relay
  sensorUpdatesBroadcast:     0,  // SENSOR_UPDATE messages actually sent (post-throttle)
  sequencerStatesReceived:   0,  // packets successfully streamed through Elodin DB verifying storage
  startTimeMs:                Date.now(),
};

// ── Local state (sequencer / actuator_service authoritative) ────────────────
let currentState: SystemState = SystemState.IDLE;
let debugMode = false;

// ── HTTP + WebSocket server ──────────────────────────────────────────────────

const apiHandler = createAPIHandler({
  getEngineState: () => currentState,
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
  if (await apiHandler(req, res)) return;

  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server: httpServer });

function broadcast(message: object): void {
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
  broadcast({ type: MessageType.BOARD_STATUS_UPDATE, timestamp: Date.now(), payload: { boards } });
}

setInterval(broadcastBoardStatus, 1000 / BOARD_STATUS_HZ);

// ── Client connection ─────────────────────────────────────────────────────────

wss.on('connection', (ws: WebSocket) => {
  console.log('[ThinServer] Client connected');

  // Connection status
  send(ws, {
    type: MessageType.CONNECTION_STATUS, timestamp: Date.now(),
    payload: { connected: true, elodinConnected: relay.connected },
  });

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

  // Current state
  send(ws, {
    type: MessageType.STATE_UPDATE, timestamp: Date.now(),
    payload: { currentState, stateName: SystemState[currentState] ?? 'UNKNOWN', timestamp: Date.now(), debugMode },
  });

  // Board status
  const boards = Array.from(boardsStatus.values());
  if (boards.length > 0) {
    send(ws, { type: MessageType.BOARD_STATUS_UPDATE, timestamp: Date.now(), payload: { boards } });
  }

  // Historical data
  sendHistoricalData(ws);

  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(ws, message);
    } catch (err) {
      console.error('[ThinServer] Bad message:', err);
    }
  });

  ws.on('close', () => console.log('[ThinServer] Client disconnected'));
  ws.on('error', (err) => console.error('[ThinServer] WS error:', err.message));
});

function sendHistoricalData(ws: WebSocket): void {
  const MAX_SEND_POINTS = 3000;
  const payload: Record<string, { time: number[]; values: number[] }> = {};
  for (const [key, series] of historyCache) {
    const len = series.time.length;
    if (len === 0) continue;
    const start = len > MAX_SEND_POINTS ? len - MAX_SEND_POINTS : 0;
    payload[key] = { time: series.time.slice(start), values: series.values.slice(start) };
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
    case MessageType.SUBSCRIBE_SENSOR:
    case MessageType.UNSUBSCRIBE_SENSOR:
      // Thin backend broadcasts all updates to all clients, ignore filter requests safely.
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
      sendToActuatorService(`TRANSITION:${csvName}\n`).then(({ ok, reply }) => {
        console.log(`[ThinServer] State transition ${stateName} → ${csvName}: ${ok ? 'OK' : 'FAIL'} (${reply})`);
        if (ok) {
          currentState = targetState;
          broadcastStateUpdate();
        } else {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `State transition failed: ${reply}` } });
        }
      });
      break;
    }
    case 'actuator': {
      const open = command.data.actuatorState === 1 || command.data.actuatorState as unknown as string === 'open';
      const actuatorName = command.data.actuatorName!;
      sendToActuatorService(`ACTUATOR:${actuatorName}:${open ? 1 : 0}\n`).then(({ ok, reply }) => {
        if (ok) {
          broadcast({ type: MessageType.ACTUATOR_UPDATE, timestamp: Date.now(),
            payload: { name: actuatorName, state: open ? 1 : 0, rawAdcCounts: 0, timestamp: Date.now() } });
        } else {
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

// ── State name map (mirrors actuator-control.ts) ─────────────────────────────

const STATE_TO_CSV_NAME: Record<string, string> = {
  IDLE: 'Idle', ARMED: 'Armed', FUEL_FILL: 'Fuel Fill', OX_FILL: 'Ox Fill',
  PRESS_STANDBY: 'Press Standby', GN2_LOW_PRESS: 'GN2 Low Press', GN2_VENT: 'GN2 Low Vent',
  FUEL_PRESS: 'Fuel Press', FUEL_VENT: 'Fuel Vent', OX_PRESS: 'Ox Press', OX_VENT: 'Ox Vent',
  GN2_HIGH_PRESS: 'GN2 High Press', GN2_HIGH_VENT: 'GN2 High Vent', CALIBRATE: 'Calibrate',
  READY: 'Ready', FIRE: 'Fire', VENT: 'Vent',
  ENGINE_ABORT: 'Engine Abort', GSE_ABORT: 'GSE Abort', EMERGENCY_ABORT: 'Emergency Abort',
  ABORT: 'Emergency Abort', DEBUG: 'Idle',
};

// ── Elodin relay ─────────────────────────────────────────────────────────────

const { channelToEntityMap }         = loadSensorRoleMap();
const actuatorChannelToEntityMap     = loadActuatorChannelToEntityMap();

const relay = new ElodinRelayClient(RELAY_URL);

relay.on('connected', () => {
  console.log('[ThinServer] Elodin relay connected');
  broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: true } });
});

relay.on('disconnected', () => {
  console.log('[ThinServer] Elodin relay disconnected');
  broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: false } });
  setTimeout(() => relay.connect(), 2000);
});

relay.on('error', (err: Error) => {
  console.error('[ThinServer] Relay error:', err.message);
});

relay.on('packet', (header: any, payload: Buffer) => {
  try {
    const [high, low] = header.packetId as [number, number];

    // ── Board heartbeat [0x10, board_id] ────────────────────────────────────
    if (high === 0x10) {
      updateBoard(low, payload);
      return;
    }

    // ── Parse sensor/actuator/state packets ──────────────────────────────────
    const parsedList = parseElodinPacket(header.packetId, payload, {
      channelToEntityMap,
      actuatorChannelToEntityMap,
    });

    if (parsedList.length === 0) {
      if (high >= 0x40) {
        console.log(`[ThinServer] Unmapped packet from relay: [0x${high.toString(16)}, 0x${low.toString(16)}] len=${payload.length}`);
      }
      return;
    }

    const epochNow = Date.now();

    // ── SequencerState packet → STATE_UPDATE broadcast ───────────────────
    if (parsedList[0]?.entity === '_SEQUENCER_STATE') {
      const stateVal      = parsedList.find(p => p.component === 'state')?.value ?? 0;
      const bitmask       = parsedList.find(p => p.component === 'allowedBitmask')?.value ?? 0;
      const debugModeVal  = parsedList.find(p => p.component === 'debugMode')?.value ?? 0;
      console.log(`[ThinServer] SequencerState from relay: state=${stateVal} bitmask=0x${bitmask.toString(16)} debug=${debugModeVal}`);
      stats.sequencerStatesReceived++;
      // Sync local state from Elodin (backup path — primary is TCP reply)
      currentState = stateVal as SystemState;
      debugMode = debugModeVal === 1;
      broadcastStateUpdate();
      return;
    }

    for (const parsed of parsedList) {
      if (!Number.isFinite(parsed.value)) continue;

      // Set mission T+0 on first meaningful data packet.
      if (firstPacketTimeMs === null) {
        firstPacketTimeMs = epochNow;
        console.log(`[ThinServer] Mission T+0: ${new Date(firstPacketTimeMs).toISOString()}`);
        broadcast({ type: MessageType.MISSION_START_TIME, timestamp: Date.now(), payload: { missionStartTime: firstPacketTimeMs } });
      }

      const key = `${parsed.entity}.${parsed.component}`;
      stats.relayEntityUpdatesReceived++;

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

// ── Start ─────────────────────────────────────────────────────────────────────

relay.connect().then((ok) => {
  if (!ok) {
    console.warn('[ThinServer] Initial relay connect failed — will retry automatically');
  }
});

httpServer.listen(WS_PORT, () => {
  console.log(`[ThinServer] WebSocket server listening on port ${WS_PORT}`);
  console.log(`[ThinServer] Relay: ${RELAY_URL}`);
  console.log(`[ThinServer] Actuator service: localhost:${ACT_SVC_PORT}`);
});
