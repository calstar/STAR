/**
 * server/board-status.ts — what the backend knows about each board.
 *
 * Owns `boardsStatus` (the config baseline from loadBoardsFromConfig(), then heartbeats via
 * updateBoard(), a T7's data-as-heartbeat via noteT7Alive()), the stale sweep and the board-
 * health notifications it raises (markStaleBoards()), the 1 Hz BOARD_STATUS_UPDATE
 * (broadcastBoardStatus()), the self-test snapshot replayed on connect (`selfTestLatest`, filled
 * by noteSelfTestResults() from ingest) and the 5 s diagnostics log. ws-connection reads `boardsStatus` and
 * `selfTestLatest` for the connect burst; ingest reads `boardsStatus` for the self-test label.
 *
 * Event-loop only. No effect at import (M1): server.ts calls loadBoardsFromConfig() at today's
 * position (§1.2 row 10) and registers the three timers (logDiagnostics 5 s, markStaleBoards 1 s,
 * broadcastBoardStatus 1 s) in today's order — the stale sweep's 1 s timer is registered before
 * the board-status one and the connection-status one, which is the on-wire order within a second
 * (G11, D42(b)). Never imports api-server.ts or api/*.
 *
 * Contract: `board_lost_<id>` / `setup_stuck_<id>` / `unrecognized_<id>` keys and texts, the
 * 5 s stale threshold and 4 s setup-stuck bound, and the board_status_update shape are frozen in
 * pipeline/golden/boards/ws_events.txt, ws_streams.txt and lifecycle/golden/{reconnect,hbloss}.txt;
 * `Loaded N boards from config.toml` is startup-log order (G12).
 */

import { readConfig } from '../routes/config.js';
import { getBoardDhcpStatus } from '../dhcp-status.js';
import { t7Channels } from '../../../shared/config-validation.js';
import { MessageType } from '../../../shared/types.js';
import type { SensorUpdate, BoardStatus } from '../../../shared/types.js';
import type { ParsedSensorData } from '../elodin-protocol.js';
import { THIN_VERBOSE_CONNECTION_LOG, THIN_HEARTBEAT_DIAG_LOG, THIN_STATS_LOG } from './env.js';
import { stats } from './stats.js';
import { wss, broadcast } from './ws-clients.js';
import { activeNotificationKeys, broadcastNotification } from './notifications.js';
import { _t7SlotToBoardId } from './config-caches.js';

export const BOARD_STATUS_HZ = 1;     // broadcast rate for board status
/** Board marked disconnected if no Elodin [0x10] heartbeat for this long. Too low causes UI flap when DB or TCP jitters; heartbeats are usually multi-Hz but not hard-real-time. */
export const BOARD_HEARTBEAT_STALE_MS = 5000;

// ── Board status ─────────────────────────────────────────────────────────────

export const boardsStatus = new Map<number, BoardStatus>();

// Pre-populate expected boards from config.toml so the frontend knows about them
// before any heartbeats arrive.
export function loadBoardsFromConfig(): void {
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

export function updateBoard(low: number, payload: Buffer): void {
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
  else if (boardType === 7) typeStr = 'ENVIRONMENTAL';
  else if (boardType === 8) typeStr = 'BALL_VALVE';

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

/**
 * A LabJack T7 sends no BOARD_HEARTBEAT — it is not an ESP32 board — so its liveness on the Boards
 * pane is its data: each raw sample t7_bridge publishes stands in for a heartbeat, at most every
 * T7_ALIVE_MARK_MS so the pane's heartbeat-rate reads as a steady ~2 Hz rather than the scan rate.
 * The same BOARD_HEARTBEAT_STALE_MS sweep then marks it disconnected when its data stops.
 */
const T7_ALIVE_MARK_MS = 500;
const t7LastMark = new Map<number, number>();
export function noteT7Alive(slot: number): void {
  if (_t7SlotToBoardId.size === 0) {
    try {
      for (const ch of t7Channels(readConfig().boards)) _t7SlotToBoardId.set(ch.slot, ch.boardId);
    } catch { return; }
  }
  const boardId = _t7SlotToBoardId.get(slot);
  if (boardId === undefined) return;
  const now = Date.now();
  if (now - (t7LastMark.get(boardId) ?? 0) < T7_ALIVE_MARK_MS) return;
  t7LastMark.set(boardId, now);
  const status = boardsStatus.get(boardId);
  if (!status) return;  // only boards config declares (loadBoardsFromConfig)
  const wasDisconnected = status.lastHeartbeatMs == null || now - status.lastHeartbeatMs > BOARD_HEARTBEAT_STALE_MS;
  status.connected = true;
  status.lastHeartbeatMs = now;
  status.heartbeatTimes = status.heartbeatTimes ?? [];
  status.heartbeatTimes.push(now);
  if (status.heartbeatTimes.length > 20) status.heartbeatTimes.shift();
  if (wasDisconnected) broadcastBoardStatus();
}

// Periodic heartbeat rate diagnostic — log actual arrival rates so we can
// see if Elodin is delivering duplicates vs boards sending too fast.
let hbDiagCount = new Map<number, number>();
export function logDiagnostics(): void {
  if (THIN_HEARTBEAT_DIAG_LOG && hbDiagCount.size > 0) {
    const entries = Array.from(hbDiagCount.entries())
      .map(([id, count]) => `board ${id}=${count}/s`)
      .join(', ');
    console.log(`[ThinServer] Heartbeat arrival rate: ${entries}`);
  }
  hbDiagCount.clear();
  // Logged unconditionally when enabled — entityUpdates=0 is the single most
  // useful reading there is (Elodin delivered nothing vs. downsampler dropped
  // everything), so it must not be suppressed by a `> 0` guard.
  if (THIN_STATS_LOG) {
    console.log(`[ThinServer] Stats: entityUpdates=${stats.ingestEntityUpdatesReceived} broadcasts=${stats.sensorUpdatesBroadcast} wsClients=${wss.clients.size}`);
  }
}

// Count heartbeat arrivals (called from packet handler before updateBoard)
export function countHeartbeat(boardId: number): void {
  hbDiagCount.set(boardId, (hbDiagCount.get(boardId) ?? 0) + 1);
}

// ── Board notifications ──────────────────────────────────────────────────────

const BOARD_STATE_SETUP = 1;
const SETUP_STUCK_THRESHOLD_MS = 4000;

const prevConnectedState = new Map<number, boolean>();
const boardFirstSeenSetupMs = new Map<number, number>();
const selfTestNotifiedBoards = new Set<number>();
/** Latest self-test results — key = "SELF_TEST.BOARD_{id}.sensor_{n}", value = 0|1.
 *  Replayed as SENSOR_UPDATE on WS connect so late-connecting browsers see results. */
export const selfTestLatest = new Map<string, SensorUpdate>();

/** Self-test rows [0x60..0x6F, id] (ingest, step 2.1): snapshot each; on the first failing value for
 *  a board not yet notified, raise `self_test_fail_<id>` and stop (the `break` stays). */
export function noteSelfTestResults(boardId: number, rows: ParsedSensorData[], epochNow: number): void {
  for (const parsed of rows) {
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

export function boardLabel(status: BoardStatus): string {
  const num = status.boardNumber ?? status.id;
  return `Board ${num} (${status.type})`;
}

// Mark boards with no recent heartbeat as disconnected each tick,
// and generate notifications for board health changes.
export function markStaleBoards(): void {
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

export function broadcastBoardStatus(): void {
  const boards = Array.from(boardsStatus.values());
  if (boards.length === 0) return;

  // Compute frequencyHz from heartbeatTimes for each board
  for (const b of boards) {
    b.dhcp = getBoardDhcpStatus(b.ip);
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
