#!/usr/bin/env tsx
/**
 * WebSocket Data Flow Integration Test
 *
 * Connects to the backend WebSocket, subscribes to sensors, and verifies:
 * 1. SENSOR_UPDATE messages arrive with valid entity names and numeric values
 * 2. STATE_UPDATE messages work both with and without debug mode
 * 3. ACTUATOR_UPDATE messages arrive after sending actuator commands (multiple actuators)
 *    with round-trip command latency measurement
 *
 * Usage: tsx ws_data_flow_test.ts [ws_port] [api_port] [actuator_udp_port] [--verbose] [--only=<ids>]
 * --verbose: Test 1 prints breakdowns, per-board counts, latency stats, Sensor Info contract
 *   tables, and backend throughput; default is quiet (✅ lines + errors only).
 * Or from repo root (starts services + passes --only through):
 *   bash test/test_integration.sh --only=sensor_data
 *
 * --only runs a subset of tests (comma-separated). IDs: sensor_config, sensor_data,
 * cal_stability, raw_cal_presence, heartbeat, board_status (Boards pane: all enabled boards connected),
 * selftest, state_transition,
 * state_debug, actuator_ws, actuator_udp, elodin_sync, controller, timestamps,
 * conservation — or numbers 1–6, 10–12, 14–15
 * (same as printed test labels). Env INTEGRATION_ONLY is equivalent to --only.
 * Most IDs still need the full integration stack (Elodin, DAQ, calibration, backend);
 * state/actuator/elodin_sync need sequencer; controller needs controller_service; selftest
 * needs BOARD_STARTUP_SIM and ports.
 *
 * Exit code: 0 = pass, 1 = fail
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as http from 'http';
import { spawnSync } from 'child_process';

const WS_PORT = parseInt(process.argv[2] || '8081', 10);
const API_PORT = parseInt(process.argv[3] || '8082', 10);
const ACTUATOR_UDP_PORT = parseInt(process.argv[4] || '5005', 10);
const VERBOSE = process.argv.includes('--verbose');
const BACKEND = process.argv.find(a => a.startsWith('--backend='))?.split('=')[1] ?? 'legacy';
const HAS_SEQUENCER = process.argv.includes('--has-sequencer');
const HAS_CONTROLLER = process.argv.includes('--has-controller');
const IS_THIN = BACKEND === 'thin';

// --received-stats <path>: write received update counts per entity to this file
const receivedStatsIdx = process.argv.indexOf('--received-stats');
const RECEIVED_STATS_FILE = receivedStatsIdx >= 0 ? process.argv[receivedStatsIdx + 1] : '';

const udpCommandsIdx = process.argv.indexOf('--udp-commands');
const UDP_COMMANDS_FILE = udpCommandsIdx >= 0 ? process.argv[udpCommandsIdx + 1] : '';

const seqLogIdx = process.argv.indexOf('--seq-log');
const SEQ_LOG_FILE = seqLogIdx >= 0 ? process.argv[seqLogIdx + 1] : '';

const backendLogIdx = process.argv.indexOf('--backend-log');
const BACKEND_LOG_FILE = backendLogIdx >= 0 ? process.argv[backendLogIdx + 1] : '';

const controllerLogIdx = process.argv.indexOf('--controller-log');
const CONTROLLER_LOG_FILE = controllerLogIdx >= 0 ? process.argv[controllerLogIdx + 1] : '';

/** Subset of tests; null = run full suite */
function parseOnlyTests(): Set<string> | null {
  const fromEnv = process.env.INTEGRATION_ONLY?.trim();
  const eq = process.argv.find(a => a.startsWith('--only='));
  const fromEq = eq ? eq.slice('--only='.length).trim() : '';
  const idx = process.argv.indexOf('--only');
  const fromPos = idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('-')
    ? process.argv[idx + 1].trim()
    : '';
  const raw = fromEq || fromPos || fromEnv || '';
  if (!raw) return null;
  const parts = raw.split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  const numToId: Record<string, string> = {
    '1': 'sensor_data',
    '2': 'state_transition',
    '3': 'state_debug',
    '4': 'actuator_ws',
    '5': 'actuator_udp',
    '6': 'elodin_sync',
    '10': 'cal_stability',
    '11': 'sensor_config',
    '12': 'raw_cal_presence',
    '14': 'timestamps',
    '15': 'conservation',
  };
  const out = new Set<string>();
  for (const p of parts) {
    let id = numToId[p] ?? p.replace(/-/g, '_');
    if (id === 'raw_cal') id = 'raw_cal_presence';
    out.add(id);
  }
  const allowed = new Set([
    'sensor_config', 'sensor_data', 'cal_stability', 'raw_cal_presence',
    'cal_values', 'cal_model_select', 'cal_robust_learn', 'cal_shared_points', 'cal_clear',
    'heartbeat', 'board_status', 'selftest', 'backend_debug_api',
    'state_transition', 'state_debug', 'actuator_ws', 'actuator_udp', 'elodin_sync',
    'controller', 'timestamps', 'conservation', 'board_logs', 'board_log_mode',
  ]);
  for (const id of out) {
    if (!allowed.has(id)) {
      console.error(`❌ Unknown --only test id: "${id}". Allowed: ${[...allowed].sort().join(', ')}`);
      process.exit(1);
    }
  }
  return out;
}

const ONLY_TESTS = parseOnlyTests();

function runTest(id: string): boolean {
  return ONLY_TESTS === null || ONLY_TESTS.has(id);
}

const WS_URL = `ws://127.0.0.1:${WS_PORT}`;
const SENSOR_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 5000;

/**
 * Each Sensor Info pane stream (entity.component with a finite value) must appear at least
 * this many times in the Test 1 window. A channel with **no** finite updates fails the manifest
 * as "missing" outright; this minimum also blocks a **single** stray SENSOR_UPDATE from counting
 * as "present" when the stream is otherwise dead.
 */
const MIN_FINITE_SAMPLES_PER_SENSOR_STREAM = Math.max(
  1,
  parseInt(process.env.INTEGRATION_MIN_SENSOR_SAMPLES || '4', 10) || 4,
);

const TEST_DAQ_UDP_PORT = parseInt(process.env.TEST_DAQ_UDP_PORT || '5016', 10);
const TEST_STARTUP_LISTEN_PORT = parseInt(process.env.TEST_STARTUP_LISTEN_PORT || '0', 10);
const BOARD_STARTUP_SIM = process.env.BOARD_STARTUP_SIM || '';
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const SKIP_STARTUP_E2E = process.env.INTEGRATION_SKIP_STARTUP_E2E === '1';
/** Set INTEGRATION_SELFTEST_DEBUG=1 or pass --verbose to log every SELF_TEST.* SENSOR_UPDATE during Test 9. */
const INTEGRATION_SELFTEST_DEBUG = process.env.INTEGRATION_SELFTEST_DEBUG === '1';
/**
 * Max time to wait for SELF_TEST on WS after board_startup_sim exits 0 (timer starts only after spawn).
 * Override with INTEGRATION_SELFTEST_WS_MS on very slow hosts.
 */
const SELF_TEST_WS_MS = parseInt(process.env.INTEGRATION_SELFTEST_WS_MS || '8000', 10);

/** Window to collect BOARD_STATUS_UPDATE and see every enabled board as connected (matches Boards / Heartbeats UI). */
const BOARD_STATUS_COLLECT_MS = parseInt(process.env.INTEGRATION_BOARD_STATUS_MS || '8000', 10);

/** Board IDs skipped for Test 8 (e.g. integration_startup @ 60 — no heartbeat until Test 9 sim). Comma-separated env INTEGRATION_BOARD_STATUS_SKIP_IDS. */
function boardStatusSkipIds(): Set<number> {
  const raw = process.env.INTEGRATION_BOARD_STATUS_SKIP_IDS ?? '60';
  const ids = raw
    .split(/[,\s]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  return new Set(ids.length ? ids : [60]);
}

// Shared types (inline to avoid import issues)
enum MessageType {
  SUBSCRIBE_SENSOR = 'subscribe_sensor',
  SEND_COMMAND = 'send_command',
  SENSOR_UPDATE = 'sensor_update',
  ACTUATOR_UPDATE = 'actuator_update',
  STATE_UPDATE = 'state_update',
  BOARD_STATUS_UPDATE = 'board_status_update',
  CONTROL_UNLOCK = 'control_unlock',
  CONTROL_UNLOCK_RESULT = 'control_unlock_result',
  BOARD_LOG = 'board_log',
}

// A local copy of the state ids, kept in step with diablo_server/shared/types.ts. It used to hold
// only the handful this file referenced by name, which silently broke the [fire] lookup below:
// resolving "Fire" produced undefined and the whole fire phase skipped itself. Complete now.
// (This is one of several duplicates of the state list across the tree — the config-owned state
// list is what should eventually replace them all.)
enum SystemState {
  DEBUG = 0, IDLE = 1, ARMED = 2, FUEL_FILL = 3, OX_FILL = 4,
  GN2_LOW_PRESS = 5, GN2_VENT = 6, FUEL_PRESS = 7, FUEL_VENT = 8,
  OX_PRESS = 9, OX_VENT = 10, GN2_HIGH_PRESS = 11, GN2_HIGH_VENT = 12,
  VENT = 13, CALIBRATE = 14, READY = 15, FIRE = 16,
  ENGINE_ABORT = 17, GSE_ABORT = 18, EMERGENCY_ABORT = 19, PRESS_STANDBY = 20,
}

enum ActuatorState {
  CLOSED = 0, OPEN = 1,
}

interface WSMessage {
  type: string;
  timestamp: number;
  payload: any;
}

// All actuator names from config.toml [actuator_roles]
const ALL_ACTUATORS = [
  'LOX Main', 'Fuel Vent', 'Fuel Press', 'Fuel Main',
  'LOX Vent', 'LOX Press', 'GSE Low Press Vent', 'Fuel Fill Press',
  'Fuel Fill Vent', 'GSE LOX Fill Vent', 'GSE High Press Control',
  'GSE Med Press Control', 'GSE High Press Vent', 'GN2 Vent',
  'LOX Fill', 'LOX Dump',
];

// Test a subset of actuators for comprehensive coverage (both boards)
const TEST_ACTUATORS = [
  'LOX Main',             // board 12, NC
  'Fuel Main',            // board 12, NO
  'LOX Vent',             // board 12, NO
  'GSE Low Press Vent',   // board 12, NC
  'Fuel Fill Vent',       // board 14, NC
  'LOX Fill',             // board 14, NC
];

// ── Helpers ──────────────────────────────────────────────────────────────────

let debugLogMessages = false;

function send(ws: WebSocket, msg: WSMessage): void {
  if (debugLogMessages) {
    console.log(`  >> SEND: type=${msg.type} payload=${JSON.stringify(msg.payload)}`);
  }
  ws.send(JSON.stringify(msg));
}

function startMessageSpy(ws: WebSocket, filter?: Set<string>): () => void {
  const handler = (data: WebSocket.Data) => {
    try {
      const msg: WSMessage = JSON.parse(data.toString());
      if (filter && !filter.has(msg.type)) return;
      const payloadStr = JSON.stringify(msg.payload);
      const truncated = payloadStr.length > 200 ? payloadStr.slice(0, 200) + '...' : payloadStr;
      if (debugLogMessages) {
        console.log(`  << RECV: type=${msg.type} payload=${truncated}`);
      }
    } catch { /* ignore */ }
  };
  ws.on('message', handler);
  return () => ws.removeListener('message', handler);
}

// Message types we care about during command tests (includes sensor for [0x32] actuator commanded)
const CMD_SPY_FILTER = new Set([
  MessageType.STATE_UPDATE, MessageType.ACTUATOR_UPDATE, MessageType.SENSOR_UPDATE,
  MessageType.ERROR, MessageType.CONNECTION_STATUS,
]);

function waitForMessage(
  ws: WebSocket,
  type: string,
  timeoutMs: number,
  predicate?: (payload: any) => boolean,
): Promise<{ payload: any; receivedAt: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Timeout waiting for ${type} (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      const receivedAt = Date.now();
      try {
        const msg: WSMessage = JSON.parse(data.toString());
        if (msg.type === type && (!predicate || predicate(msg.payload))) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve({ payload: msg.payload, receivedAt });
        }
      } catch { /* ignore malformed */ }
    }

    ws.on('message', handler);
  });
}

/**
 * Like waitForMessage, but the timeout starts only when armTimeout() is called.
 * Use when spawnSync runs between attaching the handler and starting the deadline (Test 9).
 */
function waitForMessageArmed(
  ws: WebSocket,
  type: string,
  timeoutMs: number,
  predicate?: (payload: any) => boolean,
): {
  promise: Promise<{ payload: any; receivedAt: number }>;
  armTimeout: () => void;
  cancel: () => void;
} {
  const ctl: { armTimeout?: () => void; cancel?: () => void } = {};

  const promise = new Promise<{ payload: any; receivedAt: number }>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    function handler(data: WebSocket.Data) {
      const receivedAt = Date.now();
      try {
        const msg: WSMessage = JSON.parse(data.toString());
        if (msg.type === type && (!predicate || predicate(msg.payload))) {
          if (settled) return;
          settled = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          ws.removeListener('message', handler);
          resolve({ payload: msg.payload, receivedAt });
        }
      } catch {
        /* ignore malformed */
      }
    }

    ws.on('message', handler);

    ctl.armTimeout = () => {
      if (settled) return;
      if (timer !== null) return;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        ws.removeListener('message', handler);
        reject(new Error(`Timeout waiting for ${type} (${timeoutMs}ms)`));
      }, timeoutMs);
    };

    ctl.cancel = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      ws.removeListener('message', handler);
      reject(new Error(`Cancelled waiting for ${type}`));
    };
  });

  return {
    promise,
    armTimeout: () => ctl.armTimeout!(),
    cancel: () => ctl.cancel!(),
  };
}

/**
 * Parallel listener for Test 9: counts SELF_TEST.* sensor_update frames (DAQ → Elodin → relay → thin).
 * Use snapshot() on failure to see whether the WS client ever saw any self-test traffic.
 */
function attachSelfTestNineSniffer(ws: WebSocket): {
  stop: () => void;
  snapshot: () => { count: number; samples: string[] };
} {
  let count = 0;
  const samples: string[] = [];
  const maxSamples = 16;
  const logEach = INTEGRATION_SELFTEST_DEBUG || VERBOSE;

  const handler = (data: WebSocket.Data) => {
    try {
      const msg: WSMessage = JSON.parse(data.toString());
      if (msg.type !== MessageType.SENSOR_UPDATE || !msg.payload) return;
      const p = msg.payload;
      const ent = typeof p.entity === 'string' ? p.entity : '';
      if (!ent.startsWith('SELF_TEST.')) return;
      count++;
      const line = `${ent} ${p.component}=${JSON.stringify(p.value)}`;
      if (samples.length < maxSamples) samples.push(line);
      if (logEach) {
        console.log(`  SELF_TEST on WS: ${line}`);
      }
    } catch {
      /* ignore */
    }
  };

  ws.on('message', handler);
  return {
    stop: () => ws.removeListener('message', handler),
    snapshot: () => ({ count, samples: [...samples] }),
  };
}

interface CollectedMessage {
  payload: any;
  receivedAt: number;
}

function collectMessages(
  ws: WebSocket,
  type: string,
  durationMs: number,
): Promise<CollectedMessage[]> {
  return new Promise((resolve) => {
    const collected: CollectedMessage[] = [];

    function handler(data: WebSocket.Data) {
      const receivedAt = Date.now();
      try {
        const msg: WSMessage = JSON.parse(data.toString());
        if (msg.type === type) {
          collected.push({ payload: msg.payload, receivedAt });
        }
      } catch { /* ignore */ }
    }

    ws.on('message', handler);

    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(collected);
    }, durationMs);
  });
}

function formatLatency(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`;
}

/**
 * Read [fire] from the config the stack under test is actually running, so the assertions compare
 * against configuration rather than a number baked into this file.
 */
function readFireConfig(): { durationMs: number; expiryState: number; fireState: number } | null {
  const candidates = [
    process.env.INTEGRATION_CONFIG,
    process.env.DAQ_CONFIG,
    'config/config.toml',
    '../config/config.toml',
    '../../config/config.toml',
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    let raw = '';
    try { raw = fs.readFileSync(path, 'utf-8'); } catch { continue; }
    const section = raw.split(/^\[fire\]$/m)[1];
    if (!section) continue;
    const body = section.split(/^\[/m)[0];
    const pick = (k: string) => {
      const m = body.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, 'm'));
      return m ? m[1].trim().replace(/^["']|["'].*$/g, '') : '';
    };
    const durationMs = parseInt(pick('duration_ms'), 10);
    const stateName = pick('state');
    const expiryName = pick('expiry_target');
    const toId = (n: string): number => {
      const key = n.toUpperCase().replace(/\s+/g, '_');
      const v = (SystemState as any)[key];
      return typeof v === 'number' ? v : NaN;
    };
    const fireState = toId(stateName);
    const expiryState = toId(expiryName);
    if (!Number.isFinite(durationMs) || !Number.isFinite(fireState) || !Number.isFinite(expiryState))
      continue;
    return { durationMs, expiryState, fireState };
  }
  return null;
}

/** The UDP actuator packets captured so far by udp_listener.ts (it rewrites the file per packet). */
function readUdpCommands(): any[] {
  if (!UDP_COMMANDS_FILE) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(UDP_COMMANDS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Passive latest-state tracker. There is no get_state command, so mid-burn sampling watches the
 * STATE_UPDATE broadcasts rather than asking — which is also closer to what the GUI does.
 */
function trackState(ws: WebSocket, seed: number): { get: () => number; stop: () => void } {
  let latest = seed;
  const onMsg = (data: WebSocket.RawData) => {
    try {
      const m = JSON.parse(data.toString());
      if (m?.type === MessageType.STATE_UPDATE && typeof m.payload?.currentState === 'number') {
        latest = m.payload.currentState;
      }
    } catch { /* not JSON — ignore */ }
  };
  ws.on('message', onMsg);
  return { get: () => latest, stop: () => ws.removeListener('message', onMsg) };
}

function printLatencyStats(label: string, latencies: number[]): void {
  if (latencies.length === 0) {
    console.log(`  📊 ${label}: no samples`);
    return;
  }
  latencies.sort((a, b) => a - b);
  const min = latencies[0];
  const max = latencies[latencies.length - 1];
  const avg = latencies.reduce((s, l) => s + l, 0) / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  console.log('');
  console.log(`  📊 ${label}:`);
  console.log(`     Samples: ${latencies.length}`);
  console.log(`     Min:     ${formatLatency(min)}`);
  console.log(`     Avg:     ${formatLatency(avg)}`);
  console.log(`     P50:     ${formatLatency(p50)}`);
  console.log(`     P95:     ${formatLatency(p95)}`);
  console.log(`     P99:     ${formatLatency(p99)}`);
  console.log(`     Max:     ${formatLatency(max)}`);
}

// ── Test Runner ──────────────────────────────────────────────────────────────

const passedList: string[] = [];
const failedList: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passedList.push(message);
  } else {
    console.error(`  ❌ ${message}`);
    failedList.push(message);
  }
}

async function connectWS(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout connecting to ${WS_URL}`));
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Engine-control commands (state_transition, debug_mode, actuator, extend_fire)
// are gated behind a per-connection unlock in server.ts (added with the operator
// allowlist). With no X-Auth-Email header the test connection is treated as an
// operator, but it must still send CONTROL_UNLOCK with the fat-finger password
// before the backend accepts control commands. Only the thin backend enforces
// this; legacy has no such gate (and never replies CONTROL_UNLOCK_RESULT).
const CONTROL_PASSWORD = process.env.CONTROL_PASSWORD || 'diablo';

async function unlockControl(ws: WebSocket): Promise<void> {
  const resultPromise = waitForMessage(ws, MessageType.CONTROL_UNLOCK_RESULT, COMMAND_TIMEOUT_MS,
    (payload) => payload.ok === true);
  send(ws, {
    type: MessageType.CONTROL_UNLOCK,
    timestamp: Date.now(),
    payload: { password: CONTROL_PASSWORD },
  });
  await resultPromise;
}

// ── Expected entities from config.toml enabled boards ────────────────────────
// Entity names use sensor_roles from config (spaces → underscores). Boards
// without role mappings use generic CHx names. Elodin uses local CH1–CH10 per board slot.
//
// pt_board    (id 21): [sensor_roles_pt_board] maps connectors 1-10 to named PTs
// pt_board_2  (id 22): [sensor_roles_pt2] maps connectors 1,3,4 to named HP PTs
// rtd_board   (id 31): active [1,2,3,4] → RTD.CH1-CH4
// lc_board_2  (id 42): active [1,2,6]   → LC.CH1, LC.CH2, LC.CH6
// tc_board    (id 51): active [2,3,4,5] → TC.CH2-CH5
//
// NOTE: Actuator boards (12,14) also produce data but entity names vary.
//       PT_Cal entities appear when calibration is active.
//       Both are checked as "extra" but not required.

const EXPECTED_ENTITIES: string[] = [
  // Board-namespaced: TYPE<board_number>.CH<local_channel>

  // pt_board (id 21, board_number 1) — 10 channels
  'PT1.CH1', 'PT1.CH2', 'PT1.CH3', 'PT1.CH4', 'PT1.CH5',
  'PT1.CH6', 'PT1.CH7', 'PT1.CH8', 'PT1.CH9', 'PT1.CH10',

  // pt_board_2 (id 22, board_number 2) — active [1,2,3,4]
  'PT2.CH1', 'PT2.CH2', 'PT2.CH3', 'PT2.CH4',

  // rtd_board (id 31, board_number 1) — active [1,2,3,4]
  'RTD1.CH1', 'RTD1.CH2', 'RTD1.CH3', 'RTD1.CH4',

  // lc_board_2 (id 42, board_number 2) — active [1,2,6]
  'LC2.CH1', 'LC2.CH2', 'LC2.CH6',

  // tc_board (id 51, board_number 1) — active [2,3,4,5]
  'TC1.CH2', 'TC1.CH3', 'TC1.CH4', 'TC1.CH5',

  // encoder_board (id 61, board_number 1) — 2 channels
  'ENC1.CH1', 'ENC1.CH2',

  // actuator_board_2 (id 12, board_number 2) — 10 channels
  'ACT2.CH1', 'ACT2.CH2', 'ACT2.CH3', 'ACT2.CH4', 'ACT2.CH5',
  'ACT2.CH6', 'ACT2.CH7', 'ACT2.CH8', 'ACT2.CH9', 'ACT2.CH10',

  // actuator_board_4 (id 14, board_number 4) — 10 channels
  'ACT4.CH1', 'ACT4.CH2', 'ACT4.CH3', 'ACT4.CH4', 'ACT4.CH5',
  'ACT4.CH6', 'ACT4.CH7', 'ACT4.CH8', 'ACT4.CH9', 'ACT4.CH10',
];

// ── GET /api/debug · backend rate-card contract ────────────────────────────
// Asserts the Sensor Info page header cards will show non-zero values.
// sensor-info/page.tsx polls GET /api/debug every 1s for ingestPacketsReceived
// and boardScanRateHz.{pt1,pt2,tc,rtd,lc,act,enc}. If this check fails the
// "Backend Ingest" and "Board ingest scan rate" cards will show "---".

async function testBackendDebugApi(): Promise<void> {
  console.log('\n📊 Test: Backend /api/debug (Sensor Info header cards)');

  interface DebugApiResponse {
    ingestPacketsReceived?: number;
    boardScanRateHz?: Record<string, number>;
    ingestConnected?: boolean;
  }

  const result = await new Promise<DebugApiResponse | null>((resolve) => {
    const req = http.get(`http://127.0.0.1:${WS_PORT}/api/debug`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });

  assert(result !== null, '/api/debug endpoint responds with JSON');
  if (!result) return;

  assert(
    typeof result.ingestPacketsReceived === 'number' && result.ingestPacketsReceived > 0,
    `ingestPacketsReceived > 0 (got ${result.ingestPacketsReceived ?? 'missing'}) — "Ingest Rate" card would show "---"`,
  );

  const bsr = result.boardScanRateHz;
  assert(bsr !== null && typeof bsr === 'object', '/api/debug includes boardScanRateHz object');
  if (!bsr) return;

  // Every board group that has active boards in the config must report > 0 Hz.
  // If 0, the "Board ingest scan rate" card shows "---" for that row.
  const boardGroups: Array<[string, string]> = [
    ['pt1', 'PT B21 scan rate'],
    ['tc',  'TC B51 scan rate'],
    ['rtd', 'RTD B31 scan rate'],
    ['lc',  'LC B41 scan rate'],
    ['enc', 'ENC B61 scan rate'],
    ['act', 'ACT B12/14 scan rate'],
  ];
  for (const [key, label] of boardGroups) {
    const hz = typeof bsr[key] === 'number' ? bsr[key] : -1;
    assert(
      hz > 0,
      `${label}: boardScanRateHz.${key} > 0 Hz (got ${hz.toFixed !== undefined ? hz.toFixed(1) : hz}) — card shows "---"`,
    );
  }
}

// ── Sensor Info pane · WebSocket contract (integration) ────────────────────
// Asserts every useSensorValue(entity, component) on sensor-info/page.tsx has
// received ≥1 SENSOR_UPDATE with a finite value in the collection window (cells
// would not stay "---"). Covers both raw and calibrated columns per row.
// Not asserted: Frontend Rate (client-side Hz).

function rawEntityToCalEntity(rawEntity: string): string {
  const dot = rawEntity.indexOf('.');
  if (dot < 0) return rawEntity;
  const prefix = rawEntity.slice(0, dot);
  const ch = rawEntity.slice(dot + 1);
  return `${prefix}_Cal.${ch}`;
}

function rawComponentForSensorEntity(entity: string): string {
  if (entity.startsWith('RTD')) return 'raw_resistance_counts';
  return 'raw_adc_counts';
}

function calComponentForSensorEntity(entity: string): string | null {
  if (entity.startsWith('PT')) return 'pressure_psi';
  if (entity.startsWith('TC')) return 'temperature_c';
  if (entity.startsWith('RTD')) return 'temperature_c';
  if (entity.startsWith('LC')) return 'force_kg';
  return null;
}

/** One row cell on the Sensor Info page (same as useSensorValue in page.tsx). */
interface SensorInfoFieldCheck {
  table: string;
  column: string;
  entity: string;
  component: string;
}

interface SensorConfigApiRow {
  entity: string;
  calEntity: string;
  isHpPt?: boolean;
}

function boardPaneShowsConnected(b: { connected?: boolean; operational?: boolean }): boolean {
  return (b.operational ?? b.connected) === true;
}

/** GET /api/sensor-config — same PT/HPT entity names as the browser (when backend is up). */
function fetchSensorConfigForSensorInfo(): Promise<{ sensors: SensorConfigApiRow[] } | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${API_PORT}/api/sensor-config`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data) as { sensors?: SensorConfigApiRow[] };
          if (Array.isArray(j?.sensors) && j.sensors.length > 0) resolve({ sensors: j.sensors });
          else resolve(null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Every raw + calibrated WebSocket field the Sensor Info tables render (not: Hz column, not header cards).
 */
function buildSensorInfoPaneFieldChecks(sensorApi: { sensors: SensorConfigApiRow[] } | null): SensorInfoFieldCheck[] {
  const out: SensorInfoFieldCheck[] = [];

  const ptFiltered = sensorApi?.sensors?.filter((s) => {
    const cal = String(s.calEntity || '');
    return cal.startsWith('PT_Cal.') || /^PT\d+_Cal\.CH\d+$/.test(cal);
  });

  if (ptFiltered && ptFiltered.length > 0) {
    for (const s of ptFiltered) {
      const table = s.isHpPt ? 'HPT' : 'PT';
      out.push({ table, column: 'ADC code', entity: s.entity, component: 'raw_adc_counts' });
      out.push({ table, column: 'Pressure (PSI)', entity: s.calEntity, component: 'pressure_psi' });
    }
  } else {
    for (const ent of EXPECTED_ENTITIES) {
      if (ent.startsWith('PT1.')) {
        out.push({ table: 'PT', column: 'ADC code', entity: ent, component: 'raw_adc_counts' });
        out.push({ table: 'PT', column: 'Pressure (PSI)', entity: rawEntityToCalEntity(ent), component: 'pressure_psi' });
      } else if (ent.startsWith('PT2.')) {
        out.push({ table: 'HPT', column: 'ADC code', entity: ent, component: 'raw_adc_counts' });
        out.push({ table: 'HPT', column: 'Pressure (PSI)', entity: rawEntityToCalEntity(ent), component: 'pressure_psi' });
      }
    }
  }

  for (const ent of EXPECTED_ENTITIES) {
    if (ent.startsWith('PT')) continue;
    if (ent.startsWith('ENC')) {
      out.push({
        table: 'ENC',
        column: 'Raw counts (° column is derived in browser)',
        entity: ent,
        component: 'raw_angle',
      });
      continue;
    }
    if (ent.startsWith('ACT')) {
      out.push({ table: 'ACT', column: 'ADC code', entity: ent, component: 'raw_adc_counts' });
      out.push({ table: 'ACT', column: 'Current (A)', entity: rawEntityToCalEntity(ent), component: 'current_a' });
      continue;
    }
    const rawComp = rawComponentForSensorEntity(ent);
    const calComp = calComponentForSensorEntity(ent);
    if (!calComp) continue;
    const calEnt = rawEntityToCalEntity(ent);
    if (ent.startsWith('TC')) {
      out.push({ table: 'TC', column: 'ADC code', entity: ent, component: rawComp });
      out.push({ table: 'TC', column: 'Temp (°C)', entity: calEnt, component: calComp });
    } else if (ent.startsWith('RTD')) {
      out.push({ table: 'RTD', column: 'Raw resistance counts', entity: ent, component: rawComp });
      out.push({ table: 'RTD', column: 'Temp (°C)', entity: calEnt, component: calComp });
    } else if (ent.startsWith('LC')) {
      out.push({ table: 'LC', column: 'ADC code', entity: ent, component: rawComp });
      out.push({ table: 'LC', column: 'Force (kg)', entity: calEnt, component: calComp });
    }
  }

  return out;
}

function bucketSensorInfoField(f: SensorInfoFieldCheck): string {
  return `${f.table} · ${f.column}`;
}

function logSensorInfoPaneContractOverview(fields: SensorInfoFieldCheck[]): void {
  const byBucket = new Map<string, number>();
  for (const f of fields) {
    const b = bucketSensorInfoField(f);
    byBucket.set(b, (byBucket.get(b) ?? 0) + 1);
  }
  const lines: string[] = [
    '',
    '──────────────────────────────────────────────────────────────────',
    'Sensor Info pane — fields checked (raw + calibrated per row)',
    '──────────────────────────────────────────────────────────────────',
    'Each line is one WebSocket stream (entity/component) that must appear once',
    'in the window with a finite value. Same columns as /sensor-info tables.',
    '',
  ];
  const keys = [...byBucket.keys()].sort((a, b) => a.localeCompare(b));
  for (const k of keys) {
    lines.push(`  ${k.padEnd(52)} ${String(byBucket.get(k) ?? 0).padStart(3)}`);
  }
  lines.push(`  ${'— TOTAL —'.padEnd(52)} ${String(fields.length).padStart(3)}`);
  lines.push('──────────────────────────────────────────────────────────────────');
  console.log(lines.join('\n'));
}

function formatMissingSensorInfoFields(
  missingKeys: string[],
  fields: SensorInfoFieldCheck[],
): string {
  const keyToField = new Map<string, SensorInfoFieldCheck>();
  for (const f of fields) {
    keyToField.set(`${f.entity}.${f.component}`, f);
  }
  const lines: string[] = ['  Missing (table · column · stream):'];
  for (const mk of missingKeys) {
    const f = keyToField.get(mk);
    if (f) {
      lines.push(`    · [${f.table}] ${f.column} → ${mk}`);
    } else {
      lines.push(`    · ${mk}`);
    }
  }
  return lines.join('\n');
}

function countFiniteSensorUpdates(
  updates: CollectedMessage[],
  entity: string,
  component: string,
): number {
  let n = 0;
  for (const u of updates) {
    const p = u.payload as { entity?: string; component?: string; value?: number };
    if (p.entity === entity && p.component === component && Number.isFinite(p.value)) n++;
  }
  return n;
}

function assertSensorInfoParity(updates: CollectedMessage[], sensorApi: { sensors: SensorConfigApiRow[] } | null): void {
  if (!sensorApi && VERBOSE) {
    console.log('  Sensor Info: GET /api/sensor-config unavailable — PT/HPT expectations from EXPECTED_ENTITIES');
  }

  const streamFiniteCounts = new Map<string, number>();
  for (const u of updates) {
    const { entity, component, value } = u.payload as {
      entity?: string;
      component?: string;
      value?: number;
    };
    if (!entity || !component || !Number.isFinite(value)) continue;
    const k = `${entity}.${component}`;
    streamFiniteCounts.set(k, (streamFiniteCounts.get(k) ?? 0) + 1);
  }

  const fields = buildSensorInfoPaneFieldChecks(sensorApi);

  const missingKeys: string[] = [];
  const shortStreams: { key: string; got: number; need: number }[] = [];
  for (const f of fields) {
    const k = `${f.entity}.${f.component}`;
    const n = streamFiniteCounts.get(k) ?? 0;
    if (n === 0) missingKeys.push(k);
    else if (n < MIN_FINITE_SAMPLES_PER_SENSOR_STREAM) {
      shortStreams.push({ key: k, got: n, need: MIN_FINITE_SAMPLES_PER_SENSOR_STREAM });
    }
  }

  if (missingKeys.length > 0 || shortStreams.length > 0) {
    logSensorInfoPaneContractOverview(fields);
    if (missingKeys.length > 0) {
      console.error('\n' + formatMissingSensorInfoFields(missingKeys, fields) + '\n');
    }
    if (shortStreams.length > 0) {
      const keyToField = new Map<string, SensorInfoFieldCheck>();
      for (const f of fields) keyToField.set(`${f.entity}.${f.component}`, f);
      const lines = ['  Under-sampled streams (need ≥' + MIN_FINITE_SAMPLES_PER_SENSOR_STREAM + ' finite updates each):'];
      for (const s of shortStreams) {
        const f = keyToField.get(s.key);
        const where = f ? `[${f.table}] ${f.column}` : s.key;
        lines.push(`    · ${where} → ${s.key} (got ${s.got}, need ${s.need})`);
      }
      console.error('\n' + lines.join('\n') + '\n');
    }
  } else if (VERBOSE) {
    logSensorInfoPaneContractOverview(fields);
  }

  assert(
    missingKeys.length === 0 && shortStreams.length === 0,
    missingKeys.length === 0 && shortStreams.length === 0
      ? `Sensor Info: all ${fields.length} streams (raw + cal) each had ≥${MIN_FINITE_SAMPLES_PER_SENSOR_STREAM} finite updates`
      : `Sensor Info: ${missingKeys.length} missing and ${shortStreams.length} under-sampled stream(s) — see above`,
  );
}

// ── Test 1: Sensor Data Flow ─────────────────────────────────────────────────

// ── Backend stats (thin backend only) ────────────────────────────────────────

interface BackendStats {
  ingestEntityUpdatesReceived: number;
  sensorUpdatesBroadcast: number;
  uptimeMs: number;
}

function fetchBackendStats(): Promise<BackendStats | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${WS_PORT}/stats`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', (err) => { if (VERBOSE) console.log(`    [stats] fetch error: ${err.message}`); resolve(null); });
    req.setTimeout(2000, () => { if (VERBOSE) console.log('    [stats] fetch timeout'); req.destroy(); resolve(null); });
  });
}

/** GET a JSON body from the backend REST API (served on WS_PORT for the thin backend). */
function httpGetJson(path: string): Promise<any | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${WS_PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

/** POST a JSON body to the backend REST API; resolves { status, json }. */
function httpPostJson(path: string, body: unknown): Promise<{ status: number; json: any | null }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    const req = http.request(
      `http://127.0.0.1:${WS_PORT}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json: any = null;
          try { json = JSON.parse(data); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', () => resolve({ status: 0, json: null }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.write(payload);
    req.end();
  });
}

async function testSensorDataFlow(ws: WebSocket): Promise<void> {
  console.log('\n📡 Test 1: Sensor Data Flow');

  // Subscribe to CH1–CH20 per prefix so we don’t miss updates (wide net; Elodin entities are still CH1–CH10 per slot).
  // Board-namespaced prefixes: subscribe to all possible board numbers
  const sensorPrefixes = [
    'PT1.CH', 'PT2.CH', 'PT1_Cal.CH', 'PT2_Cal.CH',
    'RTD1.CH', 'RTD1_Cal.CH',
    'TC1.CH', 'TC1_Cal.CH',
    'LC2.CH', 'LC2_Cal.CH',
    'ENC1.CH', 'ENC1_Cal.CH',
    'ACT2.CH', 'ACT4.CH', 'ACT2_Cal.CH', 'ACT4_Cal.CH',
  ];
  for (const prefix of sensorPrefixes) {
    for (let i = 1; i <= 20; i++) {
      send(ws, {
        type: MessageType.SUBSCRIBE_SENSOR,
        timestamp: Date.now(),
        payload: { entity: `${prefix}${i}` },
      });
    }
  }

  // Snapshot backend stats before the window so we can compute a delta.
  const statsAtWindowStart = IS_THIN ? await fetchBackendStats() : null;

  if (VERBOSE) console.log('  Collecting sensor updates (5s window)…');
  const updates = await collectMessages(ws, MessageType.SENSOR_UPDATE, SENSOR_TIMEOUT_MS);

  const statsAtWindowEnd = IS_THIN ? await fetchBackendStats() : null;

  // ── Group by sensor type ──
  const entities = new Set(updates.map((u) => u.payload.entity));
  const sortedEntities = [...entities].sort();

  // Build per-type breakdown
  const typeBreakdown: Record<string, { entities: Set<string>; count: number }> = {};
  for (const u of updates) {
    const entity: string = u.payload.entity;
    // Extract type prefix (everything before the dot, e.g. "PT" from "PT.CH1")
    const dotIdx = entity.indexOf('.');
    const typePrefix = dotIdx >= 0 ? entity.slice(0, dotIdx + 1) : entity;
    if (!typeBreakdown[typePrefix]) {
      typeBreakdown[typePrefix] = { entities: new Set(), count: 0 };
    }
    typeBreakdown[typePrefix].entities.add(entity);
    typeBreakdown[typePrefix].count++;
  }

  if (VERBOSE) {
    console.log(`\n  Sensor data breakdown (${updates.length} updates, ${entities.size} entities):`);
    for (const [prefix, info] of Object.entries(typeBreakdown).sort()) {
      console.log(`    ${prefix.replace('.', '').padEnd(8)} ${info.count.toString().padStart(5)} updates / ${info.entities.size} ch: ${[...info.entities].sort().join(', ')}`);
    }
  }

  // ── Assertions: verify EVERY expected entity was received ──
  const missing: string[] = [];
  const received: string[] = [];
  for (const expected of EXPECTED_ENTITIES) {
    if (entities.has(expected)) {
      received.push(expected);
    } else {
      missing.push(expected);
    }
  }

  assert(missing.length === 0,
    missing.length === 0
      ? `All ${EXPECTED_ENTITIES.length}/${EXPECTED_ENTITIES.length} expected entities received`
      : `${received.length}/${EXPECTED_ENTITIES.length} expected entities received — MISSING: ${missing.join(', ')}`);

  const sensorApi = await fetchSensorConfigForSensorInfo();
  assertSensorInfoParity(updates, sensorApi);

  // B61 encoder: Sensor Info "Encoder 1" / "Encoder 2" rows use ENC1.CH1 / ENC1.CH2 + raw_angle.
  // If CH2 is literally empty in the UI, the stream below has zero finite samples — parity also fails,
  // but this assertion names the board/row explicitly in the log.
  for (const ch of [1, 2] as const) {
    const ent = `ENC1.CH${ch}`;
    const n = countFiniteSensorUpdates(updates, ent, 'raw_angle');
    assert(
      n >= MIN_FINITE_SAMPLES_PER_SENSOR_STREAM,
      n >= MIN_FINITE_SAMPLES_PER_SENSOR_STREAM
        ? `B61 Encoder ${ch} (${ent}.raw_angle): ≥${MIN_FINITE_SAMPLES_PER_SENSOR_STREAM} finite updates`
        : `B61 Encoder ${ch} (Sensor Info row): ${ent}.raw_angle — ${n} finite WS updates (need ≥${MIN_FINITE_SAMPLES_PER_SENSOR_STREAM}; 0 means no CH${ch} data reached the client)`,
    );
  }

  const extraEntities = sortedEntities.filter(e => !EXPECTED_ENTITIES.includes(e));
  if (extraEntities.length > 0 && VERBOSE) {
    console.log(`  Extra entities (${extraEntities.length}): ${extraEntities.join(', ')}`);
  }

  // ── Per-board channel starvation check ──
  // Each board sends ALL its active channels in one UDP packet, so every channel
  // of a board sees the same chunk timestamps and hence the same envelope windows.
  // The envelope decimator emits 1 point per window for a flat channel and 2
  // (min+max) for a varying one, so sibling channel counts legitimately differ by
  // up to ~2x — equal counts is NOT an invariant here. What IS invariant: every
  // channel must emit at least once per window, so each channel's count must be
  // ≥ ~half the board's max. A channel far below that (or at zero) means genuine
  // starvation/packet loss in the pipeline, which is what this check catches.
  const BOARD_GROUPS: Record<string, string[]> = {
    'pt_board (B1)': [
      'PT1.CH1', 'PT1.CH2', 'PT1.CH3', 'PT1.CH4', 'PT1.CH5',
      'PT1.CH6', 'PT1.CH7', 'PT1.CH8', 'PT1.CH9', 'PT1.CH10',
    ],
    'pt_board_2 (B2)': ['PT2.CH1', 'PT2.CH2', 'PT2.CH3', 'PT2.CH4'],
    'rtd_board (B1)': ['RTD1.CH1', 'RTD1.CH2', 'RTD1.CH3', 'RTD1.CH4'],
    'lc_board_2 (B2)': ['LC2.CH1', 'LC2.CH2', 'LC2.CH6'],
    'tc_board (B1)': ['TC1.CH2', 'TC1.CH3', 'TC1.CH4', 'TC1.CH5'],
    'encoder_board (B1)': ['ENC1.CH1', 'ENC1.CH2'],
    'actuator_board_2 (B2)': [
      'ACT2.CH1', 'ACT2.CH2', 'ACT2.CH3', 'ACT2.CH4', 'ACT2.CH5',
      'ACT2.CH6', 'ACT2.CH7', 'ACT2.CH8', 'ACT2.CH9', 'ACT2.CH10',
    ],
    'actuator_board_4 (B4)': [
      'ACT4.CH1', 'ACT4.CH2', 'ACT4.CH3', 'ACT4.CH4', 'ACT4.CH5',
      'ACT4.CH6', 'ACT4.CH7', 'ACT4.CH8', 'ACT4.CH9', 'ACT4.CH10',
    ],
  };

  // Count updates per entity
  const entityCounts: Record<string, number> = {};
  for (const u of updates) {
    const e = u.payload.entity as string;
    entityCounts[e] = (entityCounts[e] || 0) + 1;
  }

  // A channel emits 1-2 points per envelope window (see comment above); 0.45
  // instead of 0.5 leaves slack for window-boundary edge effects at the start
  // and end of the collection interval.
  const MIN_SIBLING_RATIO = 0.45;
  for (const [boardName, boardEntities] of Object.entries(BOARD_GROUPS)) {
    const counts = boardEntities.map(e => entityCounts[e] || 0);
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);

    const floor = Math.max(
      Math.floor(maxCount * MIN_SIBLING_RATIO),
      MIN_FINITE_SAMPLES_PER_SENSOR_STREAM,
    );
    const starved = boardEntities.filter(e => (entityCounts[e] || 0) < floor);
    const passed = maxCount > 0 && starved.length === 0;
    if (!passed || VERBOSE) {
      console.log(`\n  ${boardName} (max ${maxCount} updates per ch, floor ${floor}):`);
      for (const e of boardEntities) {
        const count = entityCounts[e] || 0;
        const status = count >= floor ? '✅' : '❌';
        console.log(`    ${status} ${e}: ${count}/${maxCount}`);
      }
    }
    assert(passed,
      maxCount === 0
        ? `${boardName}: 0 updates received — board sent no data`
        : passed
          ? `${boardName}: all ${boardEntities.length} channels healthy (${minCount}-${maxCount} updates, floor ${floor})`
          : `${boardName}: ${starved.length} starved channel(s) below floor ${floor} (max sibling ${maxCount}): ${starved.map(e => `${e}=${entityCounts[e] || 0}`).join(', ')}`);
  }

  // ── Envelope downsampling verification ──
  // Active only when the harness pins [gui] points_per_second (test_integration.sh
  // sets INTEGRATION_GUI_PPS=4 in the generated config). The sim feeds PT/TC/RTD/LC
  // at 10 Hz, so a working envelope must compress each stream to ≤ pps points/sec —
  // the cap catches pass-through and duplicate-emission bugs — while still emitting
  // min/max for every window — the floor catches a stalled/blackholing decimator.
  // ACT entities are excluded (a second component, actuator_state, can share the
  // entity and inflate its count); ENC is event-like passthrough by design.
  const GUI_PPS = Number(process.env.INTEGRATION_GUI_PPS || 0);
  if (GUI_PPS > 0) {
    const windowSec = SENSOR_TIMEOUT_MS / 1000;
    const cap = Math.ceil(GUI_PPS * windowSec * 1.25) + 2;  // +2: partial windows at collection edges
    const floorPts = Math.floor((GUI_PPS / 2) * windowSec * 0.5);  // ≥ half the envelope windows
    const eligible = Object.entries(BOARD_GROUPS)
      .filter(([name]) => /^(pt|tc|rtd|lc)_/.test(name))
      .flatMap(([, ents]) => ents);
    const over = eligible.filter(e => (entityCounts[e] || 0) > cap);
    const under = eligible.filter(e => (entityCounts[e] || 0) < floorPts);
    assert(over.length === 0,
      over.length === 0
        ? `Envelope cap: all ${eligible.length} eligible channels ≤ ${cap} updates (${GUI_PPS} pts/s × ${windowSec}s)`
        : `Envelope NOT downsampling — over cap ${cap} (${GUI_PPS} pts/s × ${windowSec}s): ${over.map(e => `${e}=${entityCounts[e]}`).join(', ')}`);
    assert(under.length === 0,
      under.length === 0
        ? `Envelope liveness: all eligible channels ≥ ${floorPts} updates`
        : `Envelope starving streams (below ${floorPts}): ${under.map(e => `${e}=${entityCounts[e] || 0}`).join(', ')}`);
  }

  if (VERBOSE) console.log(`  WS client: ${updates.length} SENSOR_UPDATE messages in window`);

  // Write per-entity received counts to file for comparison with simulator stats
  if (RECEIVED_STATS_FILE) {
    const perEntity: Record<string, number> = {};
    for (const u of updates) {
      const e = u.payload.entity as string;
      perEntity[e] = (perEntity[e] || 0) + 1;
    }
    fs.writeFileSync(RECEIVED_STATS_FILE, JSON.stringify({
      total_updates: updates.length,
      entities: perEntity,
    }, null, 2));
  }

  if (updates.length > 0) {
    // Check all values are finite numbers
    const badValues = updates.filter((u) => typeof u.payload.value !== 'number' || !Number.isFinite(u.payload.value));
    assert(badValues.length === 0, `All ${updates.length} sensor values are finite numbers${badValues.length > 0 ? ` (${badValues.length} bad)` : ''}`);


    // ── Pipeline latency measurement ──
    const latencies = updates
      .map((u) => u.receivedAt - u.payload.timestamp)
      .filter((l) => l >= 0 && l < 60000);

    if (VERBOSE) {
      printLatencyStats('Pipeline Latency (message timestamp → WS client receive)', latencies);
      for (const [prefix] of Object.entries(typeBreakdown).sort()) {
        const typeUpdates = updates.filter((u) => u.payload.entity.startsWith(prefix));
        const typeLatencies = typeUpdates
          .map((u) => u.receivedAt - u.payload.timestamp)
          .filter((l) => l >= 0 && l < 60000);
        if (typeLatencies.length > 0) {
          printLatencyStats(`${prefix.replace('.', '')} Latency`, typeLatencies);
        }
      }
    }
  }

  // ── Backend throughput stats (thin backend only) ──────────────────────────
  if (IS_THIN && statsAtWindowStart && statsAtWindowEnd) {
    // Use window delta so we measure only what happened during the sensor collection window.
    const received = statsAtWindowEnd.ingestEntityUpdatesReceived - statsAtWindowStart.ingestEntityUpdatesReceived;
    const broadcast = statsAtWindowEnd.sensorUpdatesBroadcast - statsAtWindowStart.sensorUpdatesBroadcast;
    const wsDelivery = broadcast > 0 ? (updates.length / broadcast * 100).toFixed(1) : '0.0';

    if (VERBOSE) {
      console.log(`\n  Backend throughput (${SENSOR_TIMEOUT_MS / 1000}s window):`);
      console.log(`    ${received.toLocaleString()} ingested from Elodin · ${broadcast.toLocaleString()} WS broadcasts · ${updates.length.toLocaleString()} received by test`);
    }

    assert(received > 0, `Elodin → backend: data flowing (${received.toLocaleString()} updates)`);
    assert(received >= broadcast, `No phantom broadcasts (${broadcast.toLocaleString()} sent ≤ ${received.toLocaleString()} ingested)`);

    // broadcast() is an unconditional ws.send() to every open client over loopback
    // TCP — there is no drop path, so delivery should be ~100%. The only expected
    // shortfall is edge skew: the /stats delta brackets the collection window, so
    // messages in flight at either edge count as broadcast but not received. That
    // is tens of ms of traffic per edge of a 5 s window — 3% slack covers it.
    const wsDeliveryNum = broadcast > 0 ? updates.length / broadcast : 0;
    assert(wsDeliveryNum >= 0.97,
      `Frontend received ${updates.length.toLocaleString()}/${broadcast.toLocaleString()} broadcasts (${(wsDeliveryNum * 100).toFixed(1)}% — need ≥97%)`);
  } else if (IS_THIN) {
    console.log('  ℹ️  Backend stats unavailable — skipping relay→backend loss check');
  }
}

// ── Test 2: State Transition Command ─────────────────────────────────────────

async function testStateTransition(ws: WebSocket): Promise<void> {
  console.log('\n🔄 Test 2: State Transition (without debug mode)');
  debugLogMessages = VERBOSE;
  const stopSpy = startMessageSpy(ws, CMD_SPY_FILTER);

  const commandLatencies: number[] = [];

  // IDLE → ARMED
  const sentAt1 = Date.now();
  const statePromise = waitForMessage(ws, MessageType.STATE_UPDATE, COMMAND_TIMEOUT_MS,
    (payload) => payload.currentState === SystemState.ARMED);

  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: { commandType: 'state_transition', data: { state: SystemState.ARMED } },
  });

  try {
    const { payload: stateUpdate, receivedAt } = await statePromise;
    commandLatencies.push(receivedAt - sentAt1);
    assert(stateUpdate.currentState === SystemState.ARMED, `State changed to ARMED (got ${stateUpdate.currentState})`);
    assert(typeof stateUpdate.stateName === 'string', `State name is string: "${stateUpdate.stateName}"`);
    assert(typeof stateUpdate.timestamp === 'number', 'State update has timestamp');
  } catch (err: any) {
    assert(false, `State transition IDLE→ARMED: ${err.message}`);
  }

  // ARMED → IDLE
  const sentAt2 = Date.now();
  const idlePromise = waitForMessage(ws, MessageType.STATE_UPDATE, COMMAND_TIMEOUT_MS,
    (payload) => payload.currentState === SystemState.IDLE);
  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: { commandType: 'state_transition', data: { state: SystemState.IDLE } },
  });
  try {
    const { payload: idleUpdate, receivedAt } = await idlePromise;
    commandLatencies.push(receivedAt - sentAt2);
    assert(idleUpdate.currentState === SystemState.IDLE, `State returned to IDLE (got ${idleUpdate.currentState})`);
  } catch (err: any) {
    assert(false, `Return to IDLE: ${err.message}`);
  }

  printLatencyStats('State Transition Command Latency (send → state_update received)', commandLatencies);

  stopSpy();
  debugLogMessages = false;
}

// ── Test 3: State Transition in Debug Mode ──────────────────────────────────

async function testStateTransitionDebugMode(ws: WebSocket): Promise<void> {
  console.log('\n🔄 Test 3: State Transition (debug mode)');
  debugLogMessages = VERBOSE;
  const stopSpy = startMessageSpy(ws, CMD_SPY_FILTER);

  const errors: any[] = [];
  const errorHandler = (data: WebSocket.Data) => {
    try {
      const msg: WSMessage = JSON.parse(data.toString());
      if (msg.type === 'error') {
        errors.push(msg.payload);
        console.log(`  ⚠️  Backend error: ${JSON.stringify(msg.payload)}`);
      }
    } catch { /* ignore */ }
  };
  ws.on('message', errorHandler);

  // Enable debug mode
  const debugOnPromise = waitForMessage(ws, MessageType.STATE_UPDATE, COMMAND_TIMEOUT_MS,
    (payload) => payload.debugMode === true);
  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: { commandType: 'debug_mode', data: { debugMode: true } },
  });
  try {
    await debugOnPromise;
    assert(true, 'Debug mode enabled');
  } catch (err: any) {
    assert(false, `Could not enable debug mode: ${err.message}`);
    ws.removeListener('message', errorHandler);
    stopSpy();
    debugLogMessages = false;
    return;
  }

  const commandLatencies: number[] = [];

  // IDLE → ARMED in debug mode
  const sentAt1 = Date.now();
  const armedPromise = waitForMessage(ws, MessageType.STATE_UPDATE, COMMAND_TIMEOUT_MS,
    (payload) => payload.currentState === SystemState.ARMED);
  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: { commandType: 'state_transition', data: { state: SystemState.ARMED } },
  });
  try {
    const { payload, receivedAt } = await armedPromise;
    commandLatencies.push(receivedAt - sentAt1);
    assert(payload.currentState === SystemState.ARMED, `[Debug] State changed to ARMED (got ${payload.currentState})`);
  } catch (err: any) {
    assert(false, `[Debug] State transition IDLE→ARMED: ${err.message}`);
  }

  // ARMED → IDLE in debug mode
  const sentAt2 = Date.now();
  const idlePromise = waitForMessage(ws, MessageType.STATE_UPDATE, COMMAND_TIMEOUT_MS,
    (payload) => payload.currentState === SystemState.IDLE);
  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: { commandType: 'state_transition', data: { state: SystemState.IDLE } },
  });
  try {
    const { payload, receivedAt } = await idlePromise;
    commandLatencies.push(receivedAt - sentAt2);
    assert(payload.currentState === SystemState.IDLE, `[Debug] State returned to IDLE (got ${payload.currentState})`);
  } catch (err: any) {
    assert(false, `[Debug] Return to IDLE: ${err.message}`);
  }

  printLatencyStats('[Debug] State Transition Command Latency', commandLatencies);

  // ── FIRE lifecycle, against the running stack ───────────────────────────────────────────────
  // Nothing here used to touch fire, which is how fire_duration_ms went unread for so long: the
  // keys live in [controller_service] but the sequencer read [state_machine], so every burn ran
  // FireManager's 6000 ms default and no test ever compared a burn against its configured length.
  // This drives the real sequencer_service over the real WS/TCP path and checks the whole cycle:
  // enter fire, STAY in fire for the configured window, then auto-transition to [fire]
  // expiry_target without anyone asking.
  {
    const fireCfg = readFireConfig();
    if (!fireCfg) {
      console.log('  ⚠️  [fire] section not found in the test config — skipping fire lifecycle');
    } else {
      const { durationMs, expiryState, fireState } = fireCfg;
      console.log(`  [Fire] configured: ${durationMs} ms → ${SystemState[expiryState] ?? expiryState}`);

      const enteredFire = waitForMessage(ws, MessageType.STATE_UPDATE, COMMAND_TIMEOUT_MS,
        (payload) => payload.currentState === fireState);
      const firedAt = Date.now();
      send(ws, {
        type: MessageType.SEND_COMMAND,
        timestamp: Date.now(),
        payload: { commandType: 'state_transition', data: { state: fireState } },
      });

      let inFire = false;
      let enteredAt = firedAt;
      let leftFireAt = Number.MAX_SAFE_INTEGER;
      const tracker = trackState(ws, fireState);
      try {
        const { receivedAt } = await enteredFire;
        // Measure the burn from when fire was ENTERED, not from when the command was sent —
        // otherwise the command's round trip is charged to the burn length and the assertion has
        // to be loose enough to be nearly meaningless.
        enteredAt = receivedAt;
        inFire = true;
        assert(true, `[Fire] entered the fire state (+${receivedAt - firedAt} ms after the command)`);
      } catch (err: any) {
        assert(false, `[Fire] could not enter the fire state: ${err.message}`);
      }

      if (inFire) {
        // It must NOT leave early. Sample well inside the window; the auto-transition landing
        // here would mean the timer is running short (or running at all when it should not).
        const midMs = Math.max(200, Math.floor(durationMs * 0.4));
        await new Promise((r) => setTimeout(r, midMs));
        const midState = tracker.get();
        assert(midState === fireState, `[Fire] still in fire ${midMs} ms in (got ${midState})`);

        // Then it must leave on its own, at roughly the configured duration.
        try {
          const { receivedAt } = await waitForMessage(ws, MessageType.STATE_UPDATE,
            durationMs + 4000, (payload) => payload.currentState === expiryState);
          const elapsed = receivedAt - enteredAt;
          leftFireAt = receivedAt;
          assert(true, `[Fire] auto-transitioned to ${SystemState[expiryState] ?? expiryState} after ${elapsed} ms`);
          // Generous window: this crosses two processes, a TCP hop and the WS broadcast. The point
          // is that it tracks the CONFIGURED duration rather than the 6000 ms default.
          // The trailing edge carries the sequencer -> Elodin -> backend -> WS hop, measured at
          // roughly a second on this box (the entry edge above reports the same order). So the
          // window is deliberately generous on the upper side; what it has to exclude is
          // FireManager's 6000 ms default masquerading as a configured burn, which would land
          // around 7 s and is nowhere near this range.
          const upper = durationMs + 2500;
          assert(elapsed >= durationMs - 400 && elapsed <= upper,
            `[Fire] burn length tracked the configured ${durationMs} ms (measured ${elapsed} ms, window ${durationMs - 400}-${upper})`);
        } catch (err: any) {
          assert(false, `[Fire] no auto-transition out of fire: ${err.message}`);
        }

        // The PWM handoff (sequencer stops commanding PWM roles during a burn so
        // controller_service is the only writer) is NOT assertable here. Actuator commands go to
        // each board's own address, which in this harness is the simulator — so a 0.0.0.0 UDP
        // listener never sees them, and remapping the boards onto a shared address to make it
        // visible breaks daq_bridge's routing by source address. That behaviour is covered instead
        // by test_fire_lifecycle (ctest), which drives ActuatorCommander directly and asserts the
        // PWM channel is withheld in fire and commanded outside it.
      }
      tracker.stop();
    }
  }


  // Disable debug mode
  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: { commandType: 'debug_mode', data: { debugMode: false } },
  });
  await new Promise(r => setTimeout(r, 500));

  ws.removeListener('message', errorHandler);
  stopSpy();
  debugLogMessages = false;
}

// ── Test 4: Comprehensive Actuator Commands ──────────────────────────────────

async function testActuatorCommands(ws: WebSocket): Promise<void> {
  console.log(`\n🔧 Test 4: Actuator Commands (${TEST_ACTUATORS.length} actuators, round-trip latency)`);
  debugLogMessages = VERBOSE;
  const stopSpy = startMessageSpy(ws, CMD_SPY_FILTER);

  // Enable debug mode to allow manual actuator commands
  const debugPromise = waitForMessage(ws, MessageType.STATE_UPDATE, COMMAND_TIMEOUT_MS,
    (payload) => payload.debugMode === true);
  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: { commandType: 'debug_mode', data: { debugMode: true } },
  });
  try {
    await debugPromise;
    console.log('  Debug mode enabled for actuator testing');
  } catch {
    assert(false, 'Could not enter debug mode for actuator testing');
    stopSpy();
    debugLogMessages = false;
    return;
  }

  const commandLatencies: number[] = [];
  let actuatorsOpened = 0;
  let actuatorsClosed = 0;

  // Actuator commanded state: ACT_CMD.B<board_number>.CH<local_channel>
  // Board 12 = board_number 2, Board 14 = board_number 4.
  const ACTUATOR_ENTITY: Record<string, string> = {
    'LOX Main': 'ACT_CMD.B2.CH1', 'Fuel Vent': 'ACT_CMD.B2.CH2',
    'Fuel Press': 'ACT_CMD.B2.CH3', 'GSE Low Press Vent': 'ACT_CMD.B2.CH5',
    'LOX Vent': 'ACT_CMD.B2.CH6', 'Fuel Main': 'ACT_CMD.B2.CH7',
    'LOX Press': 'ACT_CMD.B2.CH8', 'Fuel Fill Press': 'ACT_CMD.B4.CH2',
    'Fuel Fill Vent': 'ACT_CMD.B4.CH1', 'GSE LOX Fill Vent': 'ACT_CMD.B4.CH10',
    'GSE High Press Control': 'ACT_CMD.B4.CH3', 'GSE Med Press Control': 'ACT_CMD.B4.CH4',
    'GSE High Press Vent': 'ACT_CMD.B4.CH5', 'GN2 Vent': 'ACT_CMD.B4.CH6',
    'LOX Fill': 'ACT_CMD.B4.CH7', 'LOX Dump': 'ACT_CMD.B4.CH8',
  };
  const nameToEntity = (name: string) => ACTUATOR_ENTITY[name] ?? 'ACT_CMD.B2.CH1';

  for (const actuatorName of TEST_ACTUATORS) {
    const entity = nameToEntity(actuatorName);

    // Wait for continuous loop to settle (it re-sends state every ~1s via Elodin [0x32])
    await new Promise(r => setTimeout(r, 1200));

    // ── OPEN the actuator ──
    // Arm listener BEFORE sending command to avoid race with fast Elodin round-trip
    const openPromise = waitForMessage(ws, MessageType.SENSOR_UPDATE, COMMAND_TIMEOUT_MS,
      (payload) => payload.entity === entity && payload.component === 'actuator_state_commanded' && payload.value === 1);
    const sentAtOpen = Date.now();

    send(ws, {
      type: MessageType.SEND_COMMAND,
      timestamp: Date.now(),
      payload: {
        commandType: 'actuator',
        data: { actuatorName, actuatorState: ActuatorState.OPEN },
      },
    });

    try {
      const { payload: openUpdate, receivedAt: openReceivedAt } = await openPromise;
      const openLatency = openReceivedAt - sentAtOpen;
      commandLatencies.push(openLatency);
      actuatorsOpened++;
      if (VERBOSE) {
        console.log(`  ✅ WS updated: ${actuatorName} → OPEN (${openLatency}ms)`);
      }
    } catch (err: any) {
      assert(false, `WS OPEN update for "${actuatorName}": ${err.message}`);
      continue; // skip close test for this actuator
    }

    // Small delay between commands
    await new Promise(r => setTimeout(r, 200));

    // ── CLOSE the actuator ──
    // Arm listener BEFORE sending command
    const closePromise = waitForMessage(ws, MessageType.SENSOR_UPDATE, COMMAND_TIMEOUT_MS,
      (payload) => payload.entity === entity && payload.component === 'actuator_state_commanded' && payload.value === 0);
    const sentAtClose = Date.now();

    send(ws, {
      type: MessageType.SEND_COMMAND,
      timestamp: Date.now(),
      payload: {
        commandType: 'actuator',
        data: { actuatorName, actuatorState: ActuatorState.CLOSED },
      },
    });

    try {
      const { payload: closeUpdate, receivedAt: closeReceivedAt } = await closePromise;
      const closeLatency = closeReceivedAt - sentAtClose;
      commandLatencies.push(closeLatency);
      actuatorsClosed++;
      if (VERBOSE) {
        console.log(`  ✅ WS updated: ${actuatorName} → CLOSED (${closeLatency}ms)`);
      }
    } catch (err: any) {
      assert(false, `WS CLOSE update for "${actuatorName}": ${err.message}`);
    }

    // Small delay before next actuator
    await new Promise(r => setTimeout(r, 200));
  }

  // Summary assertions
  assert(actuatorsOpened === TEST_ACTUATORS.length,
    `${actuatorsOpened}/${TEST_ACTUATORS.length} frontend WS updates received for OPEN commands`);
  assert(actuatorsClosed === TEST_ACTUATORS.length,
    `${actuatorsClosed}/${TEST_ACTUATORS.length} frontend WS updates received for CLOSE commands`);

  printLatencyStats('Actuator Command Round-Trip Latency (send → Elodin DB → sensor_update received)', commandLatencies);

  // Disable debug mode
  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: { commandType: 'debug_mode', data: { debugMode: false } },
  });
  await new Promise(r => setTimeout(r, 500));

  stopSpy();
  debugLogMessages = false;
}

// ── Test 5: UDP Actuator Commands ────────────────────────────────────────────

async function testUdpActuatorCommands(): Promise<void> {
  if (!HAS_SEQUENCER || !UDP_COMMANDS_FILE || !SEQ_LOG_FILE) return;
  console.log(`\n📬 Test 5: UDP Actuator Commands`);

  // Give the UDP listener a moment to flush if it hasn't already
  await new Promise(r => setTimeout(r, 500));

  let expectedPackets = 0;
  if (fs.existsSync(SEQ_LOG_FILE)) {
    try {
      const seqLog = fs.readFileSync(SEQ_LOG_FILE, 'utf-8');
      // Match logs for Sent N commands to... or Manual: ... or Actuator ... -> OPEN/CLOSED
      const regex = /\[Actuator(?:Commander|Service)\].*(?:Sent [0-9]+ commands to|Manual: |Actuator [a-zA-Z0-9_ ]+ -> (?:OPEN|CLOSED))/g;
      const matches = seqLog.match(regex);
      expectedPackets = matches ? matches.length : 0;
    } catch (err) {
      console.log(`  ⚠️  Could not read sequencer log to determine expected packets.`);
    }
  }

  let actualPackets = 0;
  if (fs.existsSync(UDP_COMMANDS_FILE)) {
    try {
      const data = fs.readFileSync(UDP_COMMANDS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      actualPackets = Array.isArray(parsed) ? parsed.length : 0;
    } catch (err) {
      assert(false, `UDP actuator commands: no packets received (listener file missing or invalid)`);
      return;
    }
  } else {
    assert(false, `UDP actuator commands: no packets received (listener file missing)`);
    return;
  }

  if (expectedPackets > 0 && expectedPackets <= actualPackets) {
    assert(true, `UDP actuator commands: All ${expectedPackets} expected packet(s) received by local listener`);
  } else if (expectedPackets > actualPackets) {
    assert(false, `UDP actuator commands: Only ${actualPackets}/${expectedPackets} packets received (DROPPED PACKETS)`);
  } else if (expectedPackets === 0 && actualPackets > 0) {
    assert(true, `UDP actuator commands: ${actualPackets} packets received (couldn't parse expected count from log)`);
  } else {
    assert(false, `UDP actuator commands: 0 packets expected/sent, zero received. Sequencer did not run commands.`);
  }
}

// ── Test 10: Calibrated Data Stability ────────────────────────────────────────

async function testCalibratedDataStability(ws: WebSocket): Promise<void> {
  console.log('\n📊 Test 10: Calibrated Data Stability (spike detection)');

  // Calibrated entities we expect (from calibration_service defaults).
  // Omit ACT*_Cal.current_a: sim currents vary in normal operation (Test 1 checks presence/parity).
  const CALIBRATED_COMPONENTS: Record<string, string> = {
    'PT1_Cal': 'pressure_psi',
    'PT2_Cal': 'pressure_psi',
    'TC1_Cal': 'temperature_c',
    'RTD1_Cal': 'temperature_c',
    'LC2_Cal': 'force_kg',
  };

  // Collect calibrated SENSOR_UPDATE values for 8 seconds
  const COLLECT_MS = 8000;
  const values = new Map<string, number[]>();  // "entity.component" -> values

  const collectPromise = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve();
    }, COLLECT_MS);

    function handler(data: WebSocket.Data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== MessageType.SENSOR_UPDATE) return;
        const { entity, component, value } = msg.payload;
        if (!entity || !component || !Number.isFinite(value)) return;

        // Only track calibrated entities
        const prefix = entity.split('.')[0];
        const expectedComp = CALIBRATED_COMPONENTS[prefix];
        if (!expectedComp || component !== expectedComp) return;

        const key = `${entity}.${component}`;
        if (!values.has(key)) values.set(key, []);
        values.get(key)!.push(value);
      } catch { /* ignore */ }
    }

    ws.on('message', handler);
  });

  await collectPromise;

  // Analyze stability
  console.log(`  Collected calibrated data for ${COLLECT_MS / 1000}s: ${values.size} entities`);

  if (values.size === 0) {
    assert(false, 'No calibrated data received (calibration_service may not be running)');
    return;
  }

  let totalSpikes = 0;
  let entitiesWithSpikes = 0;
  const spikeDetails: string[] = [];

  for (const [key, vals] of values) {
    if (vals.length < 3) continue;

    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const stddev = Math.sqrt(variance);

    // Spike = value deviating more than 20% from median (or > 5 stddev if stddev is very small)
    const absThreshold = Math.abs(median) * 0.2 || 10;  // 20% or at least 10 units
    const spikes = vals.filter(v => Math.abs(v - median) > absThreshold);

    if (VERBOSE || spikes.length > 0) {
      const status = spikes.length > 0 ? '❌' : '✅';
      console.log(`  ${status} ${key}: n=${vals.length} mean=${mean.toFixed(2)} stddev=${stddev.toFixed(4)} min=${min.toFixed(2)} max=${max.toFixed(2)} spikes=${spikes.length}`);
      if (spikes.length > 0 && spikes.length <= 5) {
        console.log(`     Spike values: [${spikes.map(v => v.toFixed(2)).join(', ')}]`);
      }
    }

    if (spikes.length > 0) {
      totalSpikes += spikes.length;
      entitiesWithSpikes++;
      spikeDetails.push(`${key} (${spikes.length} spikes, median=${median.toFixed(2)})`);
    }
  }

  console.log(`  Summary: ${values.size} entities, ${totalSpikes} total spikes across ${entitiesWithSpikes} entities`);

  if (entitiesWithSpikes > 0) {
    assert(false, `Calibrated data spikes in ${entitiesWithSpikes} entities: ${spikeDetails.join('; ')}`);
  } else {
    assert(true, `All ${values.size} calibrated entities stable (0 spikes in ${COLLECT_MS / 1000}s)`);
  }
}

// ── Calibration correctness: value, model selection, robust learning ─────────
// These verify what the presence/stability checks above cannot: that PT_Cal carries the RIGHT
// number, that the per-sensor cubic/robust choice in config is honored, and that the robust stack
// actually learns. (The "PT_Cal not uniformly 0" guard would have caught fa0e27f9, where a broken
// JSON loader made every PT read 0 PSI yet presence+stability still passed.)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Collect PT1_Cal.CH<n> pressure_psi and raw_adc_counts (same message → time-aligned) for `ms`.
 *  Subscriptions from Test 1 are already active. */
function collectPtCal(
  ws: WebSocket, ms: number,
): Promise<{ cal: Map<number, number[]>; adc: Map<number, number[]> }> {
  const cal = new Map<number, number[]>();
  const adc = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, ch: number, v: number) => {
    const a = m.get(ch); if (a) a.push(v); else m.set(ch, [v]);
  };
  return new Promise((resolve) => {
    function handler(data: WebSocket.Data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== MessageType.SENSOR_UPDATE) return;
        const { entity, component, value } = msg.payload;
        if (!entity || !Number.isFinite(value)) return;
        const m = /^PT1_Cal\.CH(\d+)$/.exec(entity);
        if (!m) return;
        const ch = Number(m[1]);
        if (component === 'pressure_psi') push(cal, ch, value);
        else if (component === 'raw_adc_counts') push(adc, ch, value);
      } catch { /* ignore */ }
    }
    ws.on('message', handler);
    setTimeout(() => { ws.removeListener('message', handler); resolve({ cal, adc }); }, ms);
  });
}

/** Newest non-excluded factory-cubic JSON in the cal dir → logical-ch → [A,B,C,D], matching the
 *  service's find_latest_json_file (which skips adjustments / cubic_calibration / *learned_prior*). */
// The test runs from diablo_server/backend, so resolve the service's cal dir via the env the harness
// exports (INTEGRATION_CAL_DIR) or known-relative fallbacks.
function findCalDir(): string | null {
  const candidates = [
    process.env.INTEGRATION_CAL_DIR,
    'scripts/calibration/calibrations',
    '../../scripts/calibration/calibrations',
  ].filter((d): d is string => !!d);
  return candidates.find((d) => { try { return fs.existsSync(d); } catch { return false; } }) ?? null;
}

function loadFactoryPtCoeffs(): Map<number, [number, number, number, number]> | null {
  const dir = findCalDir();
  if (!dir) return null;
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  const excluded = (f: string) => /adjustments|cubic_calibration|learned_prior/.test(f);
  const cand = files.filter((f) => !excluded(f))
    .map((f) => ({ f, m: fs.statSync(`${dir}/${f}`).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (cand.length === 0) return null;
  try {
    const j = JSON.parse(fs.readFileSync(`${dir}/${cand[0].f}`, 'utf-8'));
    const polys = j.calibration_polynomials;
    if (!polys || typeof polys !== 'object') return null;
    const out = new Map<number, [number, number, number, number]>();
    for (const [k, v] of Object.entries(polys)) {
      const arr = v as number[];
      if (Array.isArray(arr) && arr.length >= 4) out.set(Number(k), [arr[0], arr[1], arr[2], arr[3]]);
    }
    return out.size ? out : null;
  } catch { return null; }
}

function evalCubic(adc: number, c: [number, number, number, number]): number {
  const v = c[0] * adc * adc * adc + c[1] * adc * adc + c[2] * adc + c[3];
  return Math.max(-3000, Math.min(20000, v));  // matches PTCalibration.cpp clamp
}

// ── Test: physics conversion is correct, and an uncalibrated cubic reads nothing (0) ─
// Under the physics-or-nothing baseline there is no factory cubic: a sensor set to `physics` streams
// the datasheet closed form, and a `cubic`/`robust` sensor with no captured points streams 0. This
// replaces the old "matches factory cubic" check (that baseline no longer exists).
async function testCalibratedValueCorrectness(ws: WebSocket): Promise<void> {
  console.log('\n🎯 Test 16: physics conversion correct + uncalibrated cubic reads 0');
  const { cal, adc } = await collectPtCal(ws, 5000);
  const ADC_MAX = 2147483648; // 2^31

  // test_integration.sh sets "GSE Low" (pt_board conn 2 → CH2) to physics; pt_board is 0-5V
  // ratiometric with the default 1000 PSI full scale, so PT_Cal = (adc/2^31)*1000.
  const phCal = cal.get(2), phAdc = adc.get(2);
  if (!phCal || phCal.length < 3 || !phAdc || phAdc.length < 3) {
    assert(false, 'cal_values: no PT1_Cal.CH2 (physics sensor) samples'); return;
  }
  const a2 = median(phAdc), psi2 = median(phCal), expected2 = (a2 / ADC_MAX) * 1000;
  const tol2 = Math.max(Math.abs(expected2) * 0.03, 5);
  assert(Math.abs(psi2) > 1, 'cal_values: physics CH2 is not 0 (datasheet conversion active)');
  assert(Math.abs(psi2 - expected2) <= tol2,
    `cal_values: physics CH2 = ${psi2.toFixed(1)} ≈ (adc/2^31)*1000 = ${expected2.toFixed(1)} (adc ${a2.toFixed(0)}, tol ${tol2.toFixed(1)})`);

  // A cubic sensor with no captured points reads nothing. CH1 (Fuel Upstream) is cubic + uncalibrated.
  const c1 = cal.get(1);
  if (c1 && c1.length >= 3) {
    const psi1 = median(c1);
    assert(Math.abs(psi1) < 1,
      `cal_values: uncalibrated cubic CH1 reads ~0 (physics-or-nothing baseline) — got ${psi1.toFixed(2)}`);
  }
}

// ── Test: the per-sensor cubic/robust config choice is respected ─────────────
async function testCalibrationModelSelection(): Promise<void> {
  console.log('\n🔀 Test 17: cubic/robust config selection respected (service cubic_calibration.json)');
  // Read the service's own authoritative record — it tags each uid with the model it resolved from
  // config, so this proves config -> service selection end to end (the /api view is a passthrough of
  // this same file).
  const dir = findCalDir();
  if (!dir) { assert(false, 'cal_model_select: could not locate the calibration dir'); return; }
  let state: Record<string, any> | null = null;
  for (let i = 0; i < 6; i++) {  // the service rewrites the file at startup; retry for readiness
    try {
      const j = JSON.parse(fs.readFileSync(`${dir}/cubic_calibration.json`, 'utf-8'));
      if (j?.cubic_state && Object.keys(j.cubic_state).length > 0) { state = j.cubic_state; break; }
    } catch { /* not written yet */ }
    await sleep(500);
  }
  if (!state) {
    assert(false, 'cal_model_select: cubic_calibration.json had no populated cubic_state after retries');
    return;
  }
  // test_integration.sh sets "Ox Upstream" (pt_board conn 5 → uid 2105) to robust; the rest stay
  // cubic. "Fuel Upstream" is conn 1 → uid 2101.
  const robust = state['2105']?.active_model;
  const cubic = state['2101']?.active_model;
  const physics = state['2102']?.active_model;  // GSE Low, conn 2, set to physics
  assert(robust === 'robust', `cal_model_select: uid 2105 (Ox Upstream) active_model=robust — config respected (got ${robust})`);
  assert(cubic === 'cubic', `cal_model_select: uid 2101 (Fuel Upstream) active_model=cubic (got ${cubic})`);
  assert(physics === 'physics', `cal_model_select: uid 2102 (GSE Low) active_model=physics (got ${physics})`);
}

// Read the service's cubic_calibration.json record for a uid (fresh each capture/clear).
function readCalRecord(uid: number): Record<string, unknown> | null {
  const dir = findCalDir();
  if (!dir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(`${dir}/cubic_calibration.json`, 'utf-8'));
    return (j?.cubic_state?.[String(uid)] as Record<string, unknown>) ?? null;
  } catch { return null; }
}

// ── Test: one capture feeds BOTH the cubic fit and the robust learner (shared points) ─
// The headline guarantee of the merge. Captures on a CUBIC sensor must land in the cubic store's
// points AND be fed to the robust learner — the service samples robust into `fitCurve` for any
// sensor with points, so a populated fitCurve reflecting the taught PSI proves robust got them too.
// (In sim the ADC is constant per channel, so a real cubic FIT can't form — this checks the routing,
// not the fit quality.)
async function testSharedPoints(ws: WebSocket): Promise<void> {
  console.log('\n🔗 Test 19: one capture feeds both cubic + robust (shared points)');
  const CH = 3, BOARD = 21, UID = BOARD * 100 + CH, REF = 100;  // Fuel Downstream — cubic by config
  for (let i = 0; i < 10; i++) {
    send(ws, { type: 'calibration_command', timestamp: Date.now(),
      payload: { commandType: 'capture_point', sensorId: CH, boardId: BOARD, referencePressure: REF } });
    await sleep(120);
  }
  await sleep(1500);
  let rec: Record<string, unknown> | null = null;
  for (let i = 0; i < 8; i++) { rec = readCalRecord(UID); if (rec && (rec.numPoints as number ?? 0) > 0) break; await sleep(400); }
  if (!rec) { assert(false, `cal_shared_points: no record for uid ${UID}`); return; }
  const numPoints = rec.numPoints as number ?? 0;
  const fc = (Array.isArray(rec.fitCurve) ? rec.fitCurve : []) as { adc: number; psi: number }[];
  const medRob = fc.length ? median(fc.map((p) => p.psi)) : NaN;
  console.log(`  uid ${UID}: numPoints=${numPoints} fitCurve=${fc.length} robustMedian=${Number.isFinite(medRob) ? medRob.toFixed(1) : 'n/a'}`);
  assert(numPoints >= 1, `cal_shared_points: cubic store recorded ${numPoints} point(s)`);
  assert(fc.length > 0, `cal_shared_points: robust fitCurve populated on a cubic sensor (${fc.length}) — the capture fed robust too`);
  assert(Number.isFinite(medRob) && Math.abs(medRob - REF) < 40,
    `cal_shared_points: robust learned ~${REF} from the cubic-mode capture (fitCurve median ${Number.isFinite(medRob) ? medRob.toFixed(1) : 'n/a'})`);
}

// ── Test: clear returns a sensor to nothing (points + robust wiped) ─ (runs after cal_shared_points)
async function testClearToNothing(ws: WebSocket): Promise<void> {
  console.log('\n🧹 Test 20: clear wipes points + robust → nothing');
  const CH = 3, BOARD = 21, UID = BOARD * 100 + CH;
  send(ws, { type: 'calibration_command', timestamp: Date.now(),
    payload: { commandType: 'new_calibration', sensorId: CH, boardId: BOARD } });
  await sleep(1500);
  let rec: Record<string, unknown> | null = null;
  for (let i = 0; i < 8; i++) { rec = readCalRecord(UID); if (rec && (rec.numPoints as number ?? 0) === 0) break; await sleep(400); }
  if (!rec) { assert(false, `cal_clear: no record for uid ${UID}`); return; }
  const numPoints = rec.numPoints as number ?? -1;
  const fc = (Array.isArray(rec.fitCurve) ? rec.fitCurve : []) as unknown[];
  assert(numPoints === 0, `cal_clear: captured points wiped (numPoints ${numPoints})`);
  assert(fc.length === 0, `cal_clear: robust preview curve cleared (${fc.length} samples)`);
}

// ── Test: the robust stack actually learns (and the cubic channel is unaffected) ─
async function testRobustLearns(ws: WebSocket): Promise<void> {
  console.log('\n🧠 Test 18: robust stack learns an operator offset (cubic channel unchanged)');
  const ROBUST_CH = 5, CUBIC_CH = 1, BOARD = 21;
  const base = await collectPtCal(ws, 3000);
  const f5 = base.cal.get(ROBUST_CH), c1 = base.cal.get(CUBIC_CH);
  if (!f5 || f5.length < 3 || !c1 || c1.length < 3) {
    assert(false, 'cal_robust_learn: missing baseline PT_Cal for ch5/ch1');
    return;
  }
  const factory5 = median(f5), before1 = median(c1);
  const operatorPsi = factory5 + 50;  // within robust reconcile tolerance (<125 PSI)

  for (let i = 0; i < 15; i++) {  // teach robust the offset at the (constant) ADC
    send(ws, {
      type: 'calibration_command', timestamp: Date.now(),
      payload: { commandType: 'capture_point', sensorId: ROBUST_CH, boardId: BOARD, referencePressure: operatorPsi },
    });
    await sleep(120);
  }
  await sleep(3000);  // let RLS converge + stream + EMA catch up

  const after = await collectPtCal(ws, 3000);
  const a5 = after.cal.get(ROBUST_CH), a1 = after.cal.get(CUBIC_CH);
  if (!a5 || a5.length < 3 || !a1 || a1.length < 3) {
    assert(false, 'cal_robust_learn: missing post-capture PT_Cal for ch5/ch1');
    return;
  }
  const after5 = median(a5), after1 = median(a1);
  const moved5 = after5 - factory5, moved1 = Math.abs(after1 - before1);
  console.log(`  ch5(robust): factory=${factory5.toFixed(1)} operator=${operatorPsi.toFixed(1)} after=${after5.toFixed(1)} (moved ${moved5.toFixed(1)}) ; ch1(cubic): ${before1.toFixed(1)}→${after1.toFixed(1)}`);
  assert(moved5 > 15, `cal_robust_learn: robust ch5 moved ${moved5.toFixed(1)} PSI toward the operator value (+50) — robust stack learns`);
  assert(moved1 < 10, `cal_robust_learn: cubic ch1 unaffected by robust captures (moved ${moved1.toFixed(1)} PSI)`);
}

// ── Test 6: Elodin State Sync ────────────────────────────────────────────────

async function testElodinStateSync(): Promise<void> {
  if (!IS_THIN || !HAS_SEQUENCER) return;
  console.log(`\n📬 Test 6: Elodin State Sync`);

  // Give DB and relay a moment to flush packets
  await new Promise(r => setTimeout(r, 500));

  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${WS_PORT}/stats`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const stats = JSON.parse(data);
          const count = stats.sequencerStatesReceived ?? 0;
          if (count > 0) {
            assert(true, `Elodin State Sync: ${count} state update(s) verified in Elodin DB stream`);
          } else {
            assert(false, `Elodin State Sync: 0 state updates in stream! State transitions NOT saving to DB.`);
          }
        } catch (e) {
          assert(false, `Elodin State Sync: Failed to parse /stats JSON`);
        }
        resolve();
      });
    });

    req.on('error', (err) => {
      assert(false, `Elodin State Sync: Failed to fetch /stats API (${err.message})`);
      resolve();
    });

    req.setTimeout(2000, () => {
      assert(false, `Elodin State Sync: Timed out fetching /stats API`);
      req.destroy();
      resolve();
    });
  });
}

// ── Test 7: SERVER_HEARTBEAT on control UDP (thin + listener file) ─────────

async function testServerHeartbeatUdp(): Promise<void> {
  if (!IS_THIN || !UDP_COMMANDS_FILE) return;
  console.log('\n📬 Test 7: SERVER_HEARTBEAT UDP (heartbeat_service or daq_bridge → listener)');
  // Wait for listener to bind and create the JSON file (integration starts it just before this test).
  let waited = 0;
  while (!fs.existsSync(UDP_COMMANDS_FILE) && waited < 8000) {
    await new Promise((r) => setTimeout(r, 200));
    waited += 200;
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (!fs.existsSync(UDP_COMMANDS_FILE)) {
    assert(false, 'SERVER_HEARTBEAT: UDP listener file missing (listener failed to bind or start?)');
    return;
  }
  let packets: { packetType?: number }[] = [];
  try {
    const raw = fs.readFileSync(UDP_COMMANDS_FILE, 'utf-8');
    packets = JSON.parse(raw);
    if (!Array.isArray(packets)) packets = [];
  } catch {
    assert(false, 'SERVER_HEARTBEAT: invalid UDP listener JSON');
    return;
  }
  const hb = packets.filter((p) => p.packetType === 2);
  assert(hb.length >= 1, `SERVER_HEARTBEAT: expected ≥1 type-2 packet, got ${hb.length}`);
}

// ── Test 8: Board status from relay → thin → WS ───────────────────────────

async function testBoardStatusToFrontend(ws: WebSocket): Promise<void> {
  if (!IS_THIN) return;
  console.log('\n📬 Test 8: BOARD_STATUS_UPDATE — Boards pane (all expected boards connected)');
  const skipIds = boardStatusSkipIds();
  const msgs = await collectMessages(ws, MessageType.BOARD_STATUS_UPDATE, BOARD_STATUS_COLLECT_MS);

  type BoardRow = {
    id?: number;
    expected?: boolean;
    type?: string;
    connected?: boolean;
    operational?: boolean;
  };
  let lastBoards: BoardRow[] | null = null;
  for (const m of msgs) {
    const list = m.payload?.boards as BoardRow[] | undefined;
    if (Array.isArray(list) && list.length > 0) lastBoards = list;
  }

  if (!lastBoards || lastBoards.length === 0) {
    assert(false, 'BOARD_STATUS: no BOARD_STATUS_UPDATE with non-empty boards[]');
    return;
  }

  const expectedBoards = lastBoards.filter(
    (b) =>
      b.expected === true &&
      typeof b.id === 'number' &&
      !skipIds.has(b.id),
  );

  if (expectedBoards.length === 0) {
    assert(false, 'BOARD_STATUS: no boards with expected=true (thin server should preload config boards)');
    return;
  }

  const notConnected: number[] = [];
  for (const b of expectedBoards) {
    if (!boardPaneShowsConnected(b)) notConnected.push(b.id!);
  }

  if (VERBOSE || notConnected.length > 0) {
    const lines = expectedBoards.map((b) => {
      const ok = boardPaneShowsConnected(b);
      return `    board_id ${b.id} (${b.type ?? '?'}): ${ok ? 'connected' : 'disconnected'}`;
    });
    console.log(
      `  Last snapshot (${msgs.length} msgs / ${BOARD_STATUS_COLLECT_MS}ms, ${expectedBoards.length} expected boards${skipIds.size ? `; skip ids ${[...skipIds].join(',')}` : ''}):\n${lines.join('\n')}`,
    );
  }

  assert(
    notConnected.length === 0,
    notConnected.length === 0
      ? `Boards pane: all ${expectedBoards.length} config board(s) show connected (operational ?? connected)`
      : `Boards pane: not connected — board_id(s): ${notConnected.join(', ')}`,
  );
}

// ── Test 9: Board startup → SELF_TEST → SENSOR_UPDATE ─────────────────────────
//
// board_startup_sim.py emulates one board (integration board 60 @ 127.0.0.60):
//   1) Binds UDP on the board listen port (SENSOR_CONFIG is sent *to* this address:port).
//   2) Sends BOARD_HEARTBEAT every 1s with board_state = SETUP (real boards do this while waiting for config).
//   3) Blocks until it receives a datagram whose first byte is SENSOR_CONFIG (type 5) from
//      config_broadcast_service (same as production startup).
//   4) Sends a SELF_TEST packet to the DAQ bridge UDP port; DAQ publishes to Elodin → relay → thin → WS.
//
// We pause briefly before starting the sim so config_broadcast has usually fired at least once or twice
// (interval ~1.5s); otherwise the sim can bind after a broadcast and wait until the next cycle.
// We listen on the WebSocket *before* running the sim so we do not miss the SELF_TEST SENSOR_UPDATE.
// The timer for “still waiting on WebSocket” starts only *after* the Python process exits 0 (SELF_TEST UDP
// already sent); that window is INTEGRATION_SELFTEST_WS_MS (spawnSync blocks Node’s event loop).

async function testBoardStartupSelfTestToFrontend(ws: WebSocket): Promise<void> {
  if (!IS_THIN || SKIP_STARTUP_E2E) return;
  if (!BOARD_STARTUP_SIM || !fs.existsSync(BOARD_STARTUP_SIM) || TEST_STARTUP_LISTEN_PORT <= 0) {
    console.log('\n📬 Test 9: Board startup SELF_TEST E2E — SKIPPED (BOARD_STARTUP_SIM / port)');
    return;
  }
  const preSpawnMs = parseInt(process.env.INTEGRATION_SELFTEST_PRESPAWN_MS || '3500', 10);

  console.log('\n📬 Test 9: Board startup → SELF_TEST → WebSocket (board 60)');
  console.log('  What the sim does: SETUP heartbeats (1 Hz) → wait for SENSOR_CONFIG on board UDP → send SELF_TEST to DAQ.');
  console.log(
    `  Addresses: board listens on 127.0.0.60:${TEST_STARTUP_LISTEN_PORT}; SELF_TEST UDP → DAQ :${TEST_DAQ_UDP_PORT}; expect WS entity SELF_TEST.BOARD_60 sensor_2 = pass (1).`,
  );
  if (INTEGRATION_SELFTEST_DEBUG || VERBOSE) {
    console.log('  Debug: set INTEGRATION_SELFTEST_DEBUG=1 or --verbose to log each SELF_TEST.* SENSOR_UPDATE on the socket.');
  }
  console.log(
    `  Pause ${preSpawnMs / 1000}s before starting the sim so config_broadcast has likely sent SENSOR_CONFIG (env INTEGRATION_SELFTEST_PRESPAWN_MS=${preSpawnMs}).`,
  );
  await new Promise((r) => setTimeout(r, preSpawnMs));

  const sniff = attachSelfTestNineSniffer(ws);
  try {
    const pred = (payload: any) =>
      payload.entity === 'SELF_TEST.BOARD_60' &&
      payload.component === 'sensor_2' &&
      Number(payload.value) === 1;

    const { promise: selfTestPromise, armTimeout, cancel } = waitForMessageArmed(
      ws,
      MessageType.SENSOR_UPDATE,
      SELF_TEST_WS_MS,
      pred,
    );

    const tSpawn0 = Date.now();
    const r = spawnSync(
      PYTHON_BIN,
      [
        BOARD_STARTUP_SIM,
        '--listen-port',
        String(TEST_STARTUP_LISTEN_PORT),
        '--daq-port',
        String(TEST_DAQ_UDP_PORT),
        '--board-ip',
        '127.0.0.60',
        '--board-id',
        '60',
      ],
      { stdio: 'pipe', encoding: 'utf-8', timeout: 95000 },
    );
    const spawnMs = Date.now() - tSpawn0;
    console.log(
      `  board_startup_sim finished in ${spawnMs}ms (exit ${r.status ?? 'null'}${r.signal ? ` signal=${r.signal}` : ''}).`,
    );

    if (r.status !== 0) {
      cancel();
      void selfTestPromise.catch(() => {});
      const errOut = `${r.stderr || ''}${r.stdout || ''}`.slice(0, 1200);
      console.error(`  Sim log (trimmed):\n${errOut}`);
      const { count, samples } = sniff.snapshot();
      console.error(`  SELF_TEST-related SENSOR_UPDATE count on socket during run: ${count}`);
      if (samples.length) console.error(`  Samples: ${samples.join(' | ')}`);
      assert(false, `board_startup_sim exit ${r.status}: ${errOut.slice(0, 400)}`);
      return;
    }

    if (INTEGRATION_SELFTEST_DEBUG || VERBOSE) {
      const out = (r.stdout || '').trim();
      const err = (r.stderr || '').trim();
      if (out) console.log(`  Sim stdout: ${out.slice(0, 600)}`);
      if (err) console.log(`  Sim stderr: ${err.slice(0, 600)}`);
    }

    console.log(
      `  Waiting up to ${SELF_TEST_WS_MS}ms for that SELF_TEST to appear on this WebSocket (DAQ → Elodin → relay → thin). Env: INTEGRATION_SELFTEST_WS_MS.`,
    );
    const tArm = Date.now();
    armTimeout();
    try {
      const { receivedAt } = await selfTestPromise;
      const wsLagMs = receivedAt - tArm;
      if (INTEGRATION_SELFTEST_DEBUG || VERBOSE) {
        console.log(`  Matched on WebSocket after ${wsLagMs}ms (timer started when sim had already sent SELF_TEST).`);
      }
      assert(true, 'SELF_TEST.BOARD_60.sensor_2 pass (value=1) received on WebSocket');
    } catch (e: any) {
      const { count, samples } = sniff.snapshot();
      console.error(`  FAIL: ${e.message}`);
      console.error(`  SELF_TEST SENSOR_UPDATE count on this socket: ${count}`);
      if (samples.length) {
        console.error(`  Saw these SELF_TEST lines: ${samples.join(' | ')}`);
      } else {
        console.error(
          '  No SELF_TEST traffic on WebSocket — trace DAQ (UDP from 127.0.0.60), board_id 60 in test config, Elodin publish, relay subscription 0x60, thin parser.',
        );
      }
      console.error('  Re-run with INTEGRATION_SELFTEST_DEBUG=1 or test_integration.sh -v for per-packet logs.');
      assert(false, `SELF_TEST E2E: ${e.message}`);
    }
  } finally {
    sniff.stop();
  }
}

// ── Test 13: Self-test replay on late connect ─────────────────────────────────
// A browser that connects AFTER boards have already sent self-test packets must
// still see the results (they're one-shot events during SETUP). The backend
// replays them as SENSOR_UPDATE on connect. This test opens a *fresh* WS client
// after Test 9 has already run and verifies it receives SELF_TEST.BOARD_60.

async function testSelfTestReplayOnLateConnect(): Promise<void> {
  if (!IS_THIN || SKIP_STARTUP_E2E) return;
  if (!BOARD_STARTUP_SIM || TEST_STARTUP_LISTEN_PORT <= 0) {
    console.log('\n📬 Test 13: Self-test replay on late connect — SKIPPED (no startup sim)');
    return;
  }

  console.log('\n📬 Test 13: Self-test replay on late connect (fresh WS after SELF_TEST)');

  let ws2: WebSocket | null = null;
  try {
    ws2 = await connectWS();
    const selfTestKeys = new Map<string, number>();
    const collectMs = 3000;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, collectMs);
      ws2!.on('message', (data: WebSocket.Data) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());
          if (msg.type !== MessageType.SENSOR_UPDATE) return;
          const p = msg.payload as any;
          if (typeof p.entity === 'string' && p.entity.startsWith('SELF_TEST.')) {
            selfTestKeys.set(`${p.entity}.${p.component}`, p.value);
          }
        } catch { /* ignore */ }
      });
    });

    if (selfTestKeys.size === 0) {
      assert(false, 'Late-connect WS received 0 self-test SENSOR_UPDATE replays (backend must send selfTestLatest on connect)');
      return;
    }

    const board60Keys = [...selfTestKeys.entries()].filter(([k]) => k.startsWith('SELF_TEST.BOARD_60.'));
    assert(board60Keys.length > 0, `Late-connect received ${selfTestKeys.size} self-test keys (${board60Keys.length} for board 60)`);

    const sensor2 = selfTestKeys.get('SELF_TEST.BOARD_60.sensor_2');
    assert(sensor2 === 1, `Late-connect SELF_TEST.BOARD_60.sensor_2 = ${sensor2} (expected 1 = pass)`);
  } finally {
    if (ws2 && ws2.readyState <= WebSocket.OPEN) ws2.close();
  }
}

// ── Test 11: Sensor Config Entity Format ──────────────────────────────────────
// Verify that /api/sensor-config returns generic channel-based entity names
// (PT.CH1, TC_Cal.CH2) and NOT role-based names (PT.Fuel_Upstream).

async function testSensorConfigEntityFormat(): Promise<void> {
  console.log('\n📋 Test 11: Sensor Config Entity Format (generic CH<n> names)');

  let sensors: any[] = [];
  try {
    const res = await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${WS_PORT}/api/sensor-config`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
    const parsed = JSON.parse(res);
    sensors = parsed.sensors || [];
  } catch (e: any) {
    assert(false, `Failed to fetch /api/sensor-config: ${e.message}`);
    return;
  }

  assert(sensors.length > 0, `sensor-config returned ${sensors.length} sensors`);

  // Every entity must match TYPE<N>.CH<N> (e.g. PT1.CH1, TC1.CH3, RTD1.CH2, LC2.CH5)
  const entityPattern = /^(PT|TC|RTD|LC|ENC|ACT)\d+\.CH\d+$/;
  const calEntityPattern = /^(PT|TC|RTD|LC|ENC|ACT)\d+_Cal\.CH\d+$/;

  const badEntities: string[] = [];
  const badCalEntities: string[] = [];
  const typesSeen = new Set<string>();

  for (const s of sensors) {
    const entity = s.entity as string;
    const calEntity = s.calEntity as string;

    // Extract sensor type (strip board number: "PT1" → "PT")
    const dotIdx = entity.indexOf('.');
    if (dotIdx > 0) typesSeen.add(entity.slice(0, dotIdx).replace(/\d+$/, ''));

    if (!entityPattern.test(entity)) {
      badEntities.push(entity);
    }
    if (!calEntityPattern.test(calEntity)) {
      badCalEntities.push(calEntity);
    }
  }

  assert(badEntities.length === 0,
    badEntities.length === 0
      ? `All ${sensors.length} entity names use generic CH<n> format`
      : `${badEntities.length} entities use non-generic names: ${badEntities.slice(0, 5).join(', ')}${badEntities.length > 5 ? '...' : ''}`);

  assert(badCalEntities.length === 0,
    badCalEntities.length === 0
      ? `All ${sensors.length} calEntity names use generic CH<n> format`
      : `${badCalEntities.length} calEntities use non-generic names: ${badCalEntities.slice(0, 5).join(', ')}${badCalEntities.length > 5 ? '...' : ''}`);

  // Verify at least PT, TC, RTD, LC are present
  const requiredTypes = ['PT', 'TC', 'RTD', 'LC'];
  const missingTypes = requiredTypes.filter(t => !typesSeen.has(t));
  assert(missingTypes.length === 0,
    missingTypes.length === 0
      ? `All required sensor types present: ${requiredTypes.join(', ')}`
      : `Missing sensor types in config: ${missingTypes.join(', ')}`);
}

// ── Test 12: Raw AND Calibrated Data Presence ─────────────────────────────────
// For each sensor type (PT, TC, RTD, LC), verify that BOTH raw codes AND
// calibrated values appear in the SENSOR_UPDATE stream.

async function testRawAndCalibratedPresence(ws: WebSocket): Promise<void> {
  console.log('\n📊 Test 12: Raw AND Calibrated Data Presence (all sensor types)');
  // Wait for backend resubscribe cycle to pick up calibrated vtables registered by calibration_service
  await new Promise(r => setTimeout(r, 6000));

  // Subscribe broadly to raw and calibrated for all types
  const prefixes = [
    'PT1.CH', 'PT2.CH', 'PT1_Cal.CH', 'PT2_Cal.CH',
    'TC1.CH', 'TC1_Cal.CH', 'RTD1.CH', 'RTD1_Cal.CH',
    'LC2.CH', 'LC2_Cal.CH',
  ];
  for (const prefix of prefixes) {
    for (let i = 1; i <= 20; i++) {
      send(ws, {
        type: MessageType.SUBSCRIBE_SENSOR,
        timestamp: Date.now(),
        payload: { entity: `${prefix}${i}` },
      });
    }
  }

  const COLLECT_MS = 8000;
  console.log(`  Collecting sensor updates for ${COLLECT_MS / 1000}s...`);
  const updates = await collectMessages(ws, MessageType.SENSOR_UPDATE, COLLECT_MS);

  // Group received entities by sensor type and raw/calibrated
  const rawByType: Record<string, Set<string>> = {};
  const calByType: Record<string, Set<string>> = {};

  // Also track which calibrated components we see per type
  const calComponents: Record<string, string> = {
    'PT': 'pressure_psi',
    'TC': 'temperature_c',
    'RTD': 'temperature_c',
    'LC': 'force_kg',
  };

  for (const u of updates) {
    const entity: string = u.payload.entity;
    const component: string = u.payload.component;
    const dotIdx = entity.indexOf('.');
    if (dotIdx < 0) continue;
    const prefix = entity.slice(0, dotIdx);

    // Strip board number: "PT1_Cal" → "PT", "PT1" → "PT"
    if (prefix.endsWith('_Cal')) {
      const baseType = prefix.replace(/_Cal$/, '').replace(/\d+$/, '');
      if (!calByType[baseType]) calByType[baseType] = new Set();
      calByType[baseType].add(entity);
    } else {
      const baseType = prefix.replace(/\d+$/, '');
      if (!rawByType[baseType]) rawByType[baseType] = new Set();
      rawByType[baseType].add(entity);
    }
  }

  // Assert both raw and calibrated present for each sensor type
  const SENSOR_TYPES = ['PT', 'TC', 'RTD', 'LC'];
  for (const sensorType of SENSOR_TYPES) {
    const rawCount = rawByType[sensorType]?.size ?? 0;
    const calCount = calByType[sensorType]?.size ?? 0;

    assert(rawCount > 0,
      rawCount > 0
        ? `${sensorType}: raw data present (${rawCount} channels: ${[...(rawByType[sensorType] || [])].sort().join(', ')})`
        : `${sensorType}: NO raw data received`);

    assert(calCount > 0,
      calCount > 0
        ? `${sensorType}: calibrated data present (${calCount} channels: ${[...(calByType[sensorType] || [])].sort().join(', ')})`
        : `${sensorType}: NO calibrated data received (calibration_service may not be running)`);
  }
}

// ── Test: Controller Data Flow ────────────────────────────────────────────────

async function testControllerDataFlow(): Promise<void> {
  console.log('\n📡 Test: Controller Data Flow (controller_service log verification)');

  // Verify the controller service is running, connected to Elodin, and producing output
  // by checking its log file for key markers.
  if (!CONTROLLER_LOG_FILE) {
    assert(false, 'Controller log file not specified (--controller-log)');
    return;
  }

  let logContent = '';
  try {
    logContent = fs.readFileSync(CONTROLLER_LOG_FILE, 'utf-8');
  } catch {
    assert(false, `Could not read controller log: ${CONTROLLER_LOG_FILE}`);
    return;
  }

  // 1. Elodin publisher connected
  const elodinConnected = logContent.includes('Connected to Elodin database');
  assert(elodinConnected, 'Controller connected to Elodin DB (publisher)');

  // 2. Elodin subscriber connected and subscribed to calibrated PT
  const subscriberConnected = logContent.includes('Elodin subscriber connected');
  assert(subscriberConnected, 'Controller Elodin subscriber connected (calibrated PT)');

  // 3. Controller loop is running (check for tick output)
  const tickMatch = logContent.match(/tick=(\d+)/g);
  const lastTick = tickMatch ? parseInt(tickMatch[tickMatch.length - 1].split('=')[1]) : 0;
  assert(lastTick > 10, `Controller loop running (last tick=${lastTick})`);

  // 4. Controller tables registered with Elodin
  const tablesRegistered = logContent.includes('Registered controller tables');
  assert(tablesRegistered, 'Controller VTables registered with Elodin DB');

  if (VERBOSE) {
    const hasPT = logContent.includes('PT ch1') || logContent.includes('PT ch5');
    const hasTestDuty = logContent.includes('Test duty override');
    console.log(`    PT data received: ${hasPT ? 'yes' : 'no'}`);
    console.log(`    Test duty active: ${hasTestDuty ? 'yes' : 'no'}`);
    console.log(`    Last tick: ${lastTick}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Test 14: Timestamp quality (clock-sync verification).
 *
 * The integration stack runs the board simulator with deliberate timing
 * pathologies (network jitter, clock drift/offset, a mid-run reboot, a uint32
 * millis wrap — see INTEGRATION_TIME_FLAGS in test_integration.sh). The DAQ
 * bridge's per-board clock sync must still produce a clean timeline. Per
 * high-rate stream this asserts:
 *   - payload timestamps are monotonic non-decreasing,
 *   - no timestamp is in the future (beyond small tolerance),
 *   - pipeline latency (receivedAt − timestamp) is bounded,
 *   - inter-sample spacing is sane (no flattening onto one instant, no stalls):
 *     median spacing within [5 ms, 1000 ms] and samples spanning ≥50% of the
 *     collection window.
 */
async function testTimestampQuality(ws: WebSocket): Promise<void> {
  console.log('\n⏱️  Test 14: Timestamp Quality (clock sync under timing pathologies)');

  const WINDOW_MS = 8000;
  const FUTURE_TOLERANCE_MS = 250;
  const MAX_LATENCY_MS = 10000;
  const MIN_SAMPLES = 10;

  if (VERBOSE) console.log(`  Collecting sensor updates (${WINDOW_MS / 1000}s window)…`);
  const updates = await collectMessages(ws, MessageType.SENSOR_UPDATE, WINDOW_MS);

  // Group per stream (entity.component), keep arrival order.
  const streams = new Map<string, { ts: number[]; recv: number[] }>();
  for (const u of updates) {
    const p = u.payload as { entity?: string; component?: string; timestamp?: number; value?: number };
    if (!p.entity || !p.component || typeof p.timestamp !== 'number' || !Number.isFinite(p.value)) continue;
    const key = `${p.entity}.${p.component}`;
    let s = streams.get(key);
    if (!s) { s = { ts: [], recv: [] }; streams.set(key, s); }
    s.ts.push(p.timestamp);
    s.recv.push(u.receivedAt);
  }

  let outOfOrder = 0;
  let future = 0;
  const latencies: number[] = [];
  const spacingViolations: string[] = [];
  let highRateStreams = 0;

  for (const [key, s] of streams) {
    for (let i = 0; i < s.ts.length; i++) {
      if (i > 0 && s.ts[i] < s.ts[i - 1]) outOfOrder++;
      if (s.ts[i] > s.recv[i] + FUTURE_TOLERANCE_MS) future++;
      const lat = s.recv[i] - s.ts[i];
      if (lat >= 0 && lat < 120000) latencies.push(lat);
    }

    if (s.ts.length < MIN_SAMPLES) continue;  // event/low-rate streams: monotonic+future only
    highRateStreams++;

    const deltas: number[] = [];
    for (let i = 1; i < s.ts.length; i++) deltas.push(s.ts[i] - s.ts[i - 1]);
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    const span = s.ts[s.ts.length - 1] - s.ts[0];
    if (median < 5 || median > 1000) {
      spacingViolations.push(`${key}: median spacing ${median}ms (want 5–1000ms)`);
    } else if (span < WINDOW_MS * 0.5) {
      spacingViolations.push(`${key}: samples span only ${span}ms of the ${WINDOW_MS}ms window`);
    }
  }

  latencies.sort((a, b) => a - b);
  const p99 = latencies.length ? latencies[Math.floor(latencies.length * 0.99)] : 0;
  const maxLat = latencies.length ? latencies[latencies.length - 1] : 0;

  if (VERBOSE) {
    console.log(`  Streams: ${streams.size} total, ${highRateStreams} high-rate (≥${MIN_SAMPLES} samples)`);
    printLatencyStats('Pipeline latency (receivedAt − payload.timestamp)', latencies);
  }

  assert(streams.size > 0, `Timestamp quality: received data on ${streams.size} streams`);
  assert(outOfOrder === 0,
    outOfOrder === 0
      ? 'All per-stream timestamps monotonic non-decreasing'
      : `Timestamps went backwards ${outOfOrder} time(s) across streams`);
  assert(future === 0,
    future === 0
      ? `No future timestamps (tolerance ${FUTURE_TOLERANCE_MS}ms)`
      : `${future} timestamp(s) ahead of arrival by >${FUTURE_TOLERANCE_MS}ms`);
  assert(maxLat < MAX_LATENCY_MS,
    maxLat < MAX_LATENCY_MS
      ? `Pipeline latency bounded (max ${maxLat}ms, p99 ${p99}ms < ${MAX_LATENCY_MS}ms)`
      : `Pipeline latency too high: max ${maxLat}ms (limit ${MAX_LATENCY_MS}ms) — clock sync mis-anchored?`);
  assert(spacingViolations.length === 0,
    spacingViolations.length === 0
      ? `Inter-sample spacing sane on all ${highRateStreams} high-rate streams (no flattening, no stalls)`
      : `Spacing violations on ${spacingViolations.length} stream(s): ${spacingViolations.slice(0, 5).join('; ')}${spacingViolations.length > 5 ? ' …' : ''}`);
}

// ── Test 15: Sample Conservation (sim → bridge → Elodin DB → backend) ────────
// The simulator rewrites its ground-truth stats file (samples sent per channel)
// every second. The backend's rawPrimarySamplesIngested counts the same samples
// as ingested from the Elodin DB stream BEFORE the GUI downsampler (one per raw
// physical sample, canonical component only, _Cal republications excluded).
// Comparing the two detects absolute packet loss anywhere in
// UDP → bridge → Elodin DB → backend, independent of envelope emission.
async function testSampleConservation(): Promise<void> {
  console.log('\n🔎 Test 15: Sample Conservation (sim sent vs backend ingested, pre-downsample)');
  const statsFile = process.env.INTEGRATION_SIM_STATS || '';
  if (!statsFile) {
    console.log('  ℹ️  INTEGRATION_SIM_STATS not set — skipping (run via test_integration.sh)');
    return;
  }

  // Read the sim snapshot FIRST, then fetch the backend counter: the snapshot
  // lags actual sent by ≤1s, so the backend has ingested at least as much as
  // the snapshot claims was sent — the skew only adds slack, never false fails.
  let sim: any;
  try {
    sim = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  } catch (e: any) {
    assert(false, `Could not read sim stats file ${statsFile}: ${e.message}`);
    return;
  }
  const sent = Number(sim?.total_sensor_updates) || 0;
  assert(sent > 0, sent > 0
    ? `Sim ground truth: ${sent.toLocaleString()} samples sent`
    : 'Sim stats file reports 0 samples sent — simulator produced no data');
  if (sent <= 0) return;

  const backendStats = await fetchBackendStats();
  const ingested = Number((backendStats as any)?.rawPrimarySamplesIngested);
  if (!Number.isFinite(ingested)) {
    assert(false, 'Backend /stats has no rawPrimarySamplesIngested — stale backend build?');
    return;
  }

  // Per-group breakdown (always printed): pinpoints WHICH stream loses samples.
  // Sim board names → backend board-scan groups.
  const groupOfBoard = (name: string): string => {
    if (/^pt_board_2/.test(name)) return 'pt2';
    if (/^pt_board/.test(name)) return 'pt1';
    if (/^rtd/.test(name)) return 'rtd';
    if (/^lc/.test(name)) return 'lc';
    if (/^tc/.test(name)) return 'tc';
    if (/^encoder/.test(name)) return 'enc';
    if (/^actuator/.test(name)) return 'act';
    return 'other';
  };
  const sentByGroup: Record<string, number> = {};
  for (const [name, b] of Object.entries(sim.boards ?? {}) as [string, any][]) {
    const g = groupOfBoard(name);
    sentByGroup[g] = (sentByGroup[g] || 0) + (Number(b.total_sensor_updates) || 0);
  }
  const ingestedByGroup: Record<string, number> = (backendStats as any)?.rawPrimarySamplesByGroup ?? {};
  for (const g of Object.keys(sentByGroup).sort()) {
    const s = sentByGroup[g];
    const i = ingestedByGroup[g] || 0;
    const gp = s > 0 ? ((i / s) * 100).toFixed(1) : '?';
    console.log(`  ${g.padEnd(5)} sent ${String(s).padStart(6)}  ingested ${String(i).padStart(6)}  (${gp}%)`);
  }

  // Loss model (verified against bridge logs): the bridge receives and publishes
  // every sample (its [Stats] line counts drops), but Elodin DB's live stream to
  // subscribers coalesces same-channel rows written in one burst — with N chunks
  // per packet, each channel gets N rows in one TCP batch and the DB may forward
  // fewer (storage keeps all rows; only the push stream thins). Genuine pipeline
  // loss (UDP drop, flush failure, disconnect) loses WHOLE packets, so the hard
  // invariant is one surviving row per channel per packet: packets × channels.
  // In clean 1-chunk mode that floor equals full sample count — strict lossless.
  const uniqueScans = Object.values(sim.boards ?? {}).reduce(
    (sum: number, b: any) => sum + (Number(b.packets_sent) || 0) * (Number(b.channels_per_packet) || 0), 0);
  const MIN_PCT = 95;
  const floorScans = Math.floor(uniqueScans * (MIN_PCT / 100));
  const pctOfSent = (ingested / sent) * 100;
  const pctOfScans = uniqueScans > 0 ? (ingested / uniqueScans) * 100 : 0;
  console.log(`  Ingested ${ingested.toLocaleString()}/${sent.toLocaleString()} samples (${pctOfSent.toFixed(1)}% of sent, ${pctOfScans.toFixed(1)}% of per-packet channel scans)`);
  assert(ingested >= floorScans,
    ingested >= floorScans
      ? `Sample conservation: ingested ≥ ${MIN_PCT}% of ${uniqueScans.toLocaleString()} channel scans (whole-packet loss check)`
      : `Sample conservation FAILED: ingested ${ingested.toLocaleString()} < ${floorScans.toLocaleString()} (${MIN_PCT}% of ${uniqueScans.toLocaleString()} channel scans) — whole packets lost in UDP → bridge → Elodin → backend`);
  // Upper sanity bound: ingesting far more than sent means double counting
  // (e.g. _Cal republications leaking into the counter). 5% covers the ≤1s
  // stats-file snapshot lag.
  assert(ingested <= sent * 1.05,
    ingested <= sent * 1.05
      ? `No double counting (ingested ≤ sent + snapshot lag)`
      : `Ingested ${ingested.toLocaleString()} exceeds sent ${sent.toLocaleString()} by >5% — counter double-counting a stream?`);
}

// ── Test: Board logs reach the frontend (board_simulator → daq_bridge → backend → WS/REST) ──
// The sim streams simple type-15 LOGS unconditionally (it does NOT honor the mode byte).
async function testBoardLogs(ws: WebSocket): Promise<void> {
  console.log('\n🪵 Test: Board diagnostic logs → WebSocket + REST cache');
  console.log('  The board_simulator streams type-15 LOGS (1 Hz/board); daq_bridge forwards them to the backend cache.');
  try {
    const { payload } = await waitForMessage(
      ws,
      MessageType.BOARD_LOG,
      12000,
      (p) => p && p.boardId > 0 && Array.isArray(p.lines) && p.lines.length > 0,
    );
    assert(payload.boardId > 0 && payload.lines.length > 0,
      `BOARD_LOG frame received over WS (board ${payload.boardId}, ${payload.lines.length} line(s): "${String(payload.lines[0]).slice(0, 60)}")`);
  } catch (e: any) {
    assert(false, `BOARD_LOG frame over WS: ${e.message}`);
  }

  // REST cache: /api/board-logs/stats should show a board with received > 0.
  const stats = await httpGetJson('/api/board-logs/stats');
  const entries: [string, any][] = stats && stats.stats ? Object.entries(stats.stats) : [];
  const streaming = entries.find(([, v]) => v && v.received > 0);
  assert(!!streaming, streaming
    ? `/api/board-logs/stats shows board ${streaming[0]} received=${streaming[1].received}`
    : `/api/board-logs/stats has a board with received>0 (got ${JSON.stringify(stats?.stats ?? {})})`);

  if (streaming) {
    const hist = await httpGetJson(`/api/board-logs?board=${streaming[0]}&limit=20`);
    const lines = hist && Array.isArray(hist.lines) ? hist.lines : [];
    assert(lines.length > 0,
      lines.length > 0
        ? `/api/board-logs?board=${streaming[0]} returned ${lines.length} cached line(s)`
        : `/api/board-logs?board=${streaming[0]} returned cached lines`);
  }
}

// ── Test: a GUI logging-mode change reaches the board (frontend → config → config_broadcast → board 60) ──
// board_startup_sim (127.0.0.60) receives SENSOR_CONFIG and reports the enable_serial_printing byte;
// the board does NOT have to act on it — we only prove the changed byte arrives.
async function testBoardLogMode(_ws: WebSocket): Promise<void> {
  console.log('\n🎚️  Test: GUI log-mode change reaches board 60 (POST → config.toml → config_broadcast → SENSOR_CONFIG)');
  if (!BOARD_STARTUP_SIM || !fs.existsSync(BOARD_STARTUP_SIM) || TEST_STARTUP_LISTEN_PORT <= 0) {
    console.log('  SKIPPED (BOARD_STARTUP_SIM / port not available)');
    return;
  }
  const TARGET_MODE = 3;
  const post = await httpPostJson('/api/board-log-mode', { boardId: 60, mode: TARGET_MODE });
  assert(post.status === 200 && post.json?.success === true,
    post.status === 200 ? `POST /api/board-log-mode {60,${TARGET_MODE}} accepted` : `POST /api/board-log-mode failed (status ${post.status})`);
  if (post.status !== 200) return;

  // Let config_broadcast (≥1.5s cycle) re-read the patched config and start sending the new byte.
  const waitMs = parseInt(process.env.INTEGRATION_LOGMODE_WAIT_MS || '4000', 10);
  console.log(`  Waiting ${waitMs / 1000}s for config_broadcast to pick up the change before starting the board sim…`);
  await new Promise((r) => setTimeout(r, waitMs));

  const r = spawnSync(
    PYTHON_BIN,
    [
      BOARD_STARTUP_SIM,
      '--listen-port', String(TEST_STARTUP_LISTEN_PORT),
      '--daq-port', String(TEST_DAQ_UDP_PORT),
      '--board-ip', '127.0.0.60',
      '--board-id', '60',
    ],
    { stdio: 'pipe', encoding: 'utf-8', timeout: 30000 },
  );
  const out = `${r.stdout || ''}`;
  const m = out.match(/enable_serial_printing=(\d+)/);
  const seen = m ? parseInt(m[1], 10) : -1;
  assert(seen === TARGET_MODE,
    seen === TARGET_MODE
      ? `Board 60 received the GUI-set log mode over the wire (enable_serial_printing=${seen})`
      : `Board 60 should receive enable_serial_printing=${TARGET_MODE} (saw ${seen === -1 ? 'no config' : seen}). Sim out: ${out.slice(0, 300)}`);
}

async function main(): Promise<void> {
  console.log('🧪 WebSocket Data Flow Integration Test');
  console.log(`   Backend: ${WS_URL} (${IS_THIN ? 'server.ts' : 'server-legacy.ts'})`);
  if (ONLY_TESTS) {
    console.log(`   --only: ${[...ONLY_TESTS].sort().join(', ')}`);
  }
  if (IS_THIN) {
    console.log(`   sequencer_service: ${HAS_SEQUENCER ? 'available' : 'not found — command tests will be skipped'}`);
    console.log(`   controller_service: ${HAS_CONTROLLER ? 'available' : 'not found — controller tests will be skipped'}`);
  }
  console.log('');

  let ws: WebSocket;
  try {
    ws = await connectWS();
    console.log('✅ Connected to backend WebSocket');
  } catch (err: any) {
    console.error(`❌ Failed to connect: ${err.message}`);
    process.exit(1);
  }

  const canRunCommandTests = !IS_THIN || HAS_SEQUENCER;

  // Thin backend gates control commands behind an operator unlock — do it once
  // up front so the state/actuator/debug tests below are authorized.
  if (IS_THIN && canRunCommandTests) {
    try {
      await unlockControl(ws);
      console.log('🔓 Control unlocked (approved operator + password)');
    } catch (err: any) {
      console.error(`❌ Control unlock failed: ${err.message}`);
      process.exit(1);
    }
  }

  if (ONLY_TESTS) {
    const needsSeq = ['state_transition', 'state_debug', 'actuator_ws', 'actuator_udp', 'elodin_sync']
      .some(id => ONLY_TESTS!.has(id));
    if (needsSeq && !canRunCommandTests) {
      console.error('❌ Selected tests require sequencer_service (integration must start sequencer or pass --has-sequencer)');
      process.exit(1);
    }
    if (ONLY_TESTS.has('controller') && !HAS_CONTROLLER) {
      console.error('❌ Selected tests include controller but controller_service was not started');
      process.exit(1);
    }
    if (ONLY_TESTS.has('selftest') && !IS_THIN) {
      console.error('❌ selftest is only defined for thin backend');
      process.exit(1);
    }
  }

  try {
    if (runTest('sensor_config')) await testSensorConfigEntityFormat();
    if (runTest('sensor_data')) await testSensorDataFlow(ws);
    if (IS_THIN && runTest('backend_debug_api')) await testBackendDebugApi();
    if (runTest('raw_cal_presence')) await testRawAndCalibratedPresence(ws);
    if (runTest('timestamps')) await testTimestampQuality(ws);
    if (runTest('cal_stability')) await testCalibratedDataStability(ws);
    if (runTest('cal_values')) await testCalibratedValueCorrectness(ws);
    if (IS_THIN && runTest('cal_model_select')) await testCalibrationModelSelection();
    if (IS_THIN) {
      if (runTest('heartbeat')) await testServerHeartbeatUdp();
      if (runTest('board_status')) await testBoardStatusToFrontend(ws);
      if (runTest('selftest')) await testBoardStartupSelfTestToFrontend(ws);
      if (runTest('selftest_replay')) await testSelfTestReplayOnLateConnect();
      if (runTest('board_logs')) await testBoardLogs(ws);
      // After selftest so board_startup_sim's port (5014) is free to reuse.
      if (runTest('board_log_mode')) await testBoardLogMode(ws);
    }
    if (canRunCommandTests) {
      if (runTest('state_transition')) await testStateTransition(ws);
      if (runTest('state_debug')) await testStateTransitionDebugMode(ws);
      if (runTest('actuator_ws')) await testActuatorCommands(ws);
      if (runTest('actuator_udp')) await testUdpActuatorCommands();
      if (runTest('elodin_sync')) await testElodinStateSync();
    } else if (!ONLY_TESTS) {
      console.log('\n🔄 Test 2: State Transition — SKIPPED (thin backend requires sequencer_service)');
      console.log('🔄 Test 3: State Transition Debug Mode — SKIPPED');
      console.log('🔄 Test 4: Actuator Commands — SKIPPED');
      console.log('📬 Test 5: UDP Actuator Commands — SKIPPED');
      console.log('📬 Test 6: Elodin State Sync — SKIPPED');
    }
    if (HAS_CONTROLLER && runTest('controller')) {
      await testControllerDataFlow();
    } else if (!ONLY_TESTS && !HAS_CONTROLLER) {
      console.log('\n📡 Test: Controller Data Flow — SKIPPED (controller_service not found)');
    }
    // Last on purpose: maximizes the sample count both sides of the comparison.
    if (IS_THIN && runTest('conservation')) await testSampleConservation();
    // Truly last: this drives capture commands that mutate the robust channel's learned state, so it
    // must run after every read-only value/stability/conservation check.
    if (IS_THIN && canRunCommandTests && runTest('cal_robust_learn')) await testRobustLearns(ws);
    // Shared-points then clear run last (they mutate CH3's cubic store + robust state).
    if (IS_THIN && canRunCommandTests && runTest('cal_shared_points')) await testSharedPoints(ws);
    if (IS_THIN && canRunCommandTests && runTest('cal_clear')) await testClearToNothing(ws);
  } finally {
    ws.close();
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Results: ${passedList.length} passed, ${failedList.length} failed`);
  console.log(`${'═'.repeat(60)}`);

  if (failedList.length > 0) {
    console.log('\n  Failed:');
    for (const msg of failedList) {
      console.log(`    ❌ ${msg}`);
    }
  }
  if (passedList.length > 0) {
    console.log('\n  Passed:');
    for (const msg of passedList) {
      console.log(`    ✅ ${msg}`);
    }
  }

  process.exit(failedList.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ Unhandled error:', err);
  process.exit(1);
});
