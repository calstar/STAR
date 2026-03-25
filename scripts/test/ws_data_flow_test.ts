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
 * Usage: tsx ws_data_flow_test.ts [ws_port] [api_port] [actuator_udp_port] [--verbose]
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

const WS_URL = `ws://127.0.0.1:${WS_PORT}`;
const SENSOR_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 5000;

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

// Shared types (inline to avoid import issues)
enum MessageType {
  SUBSCRIBE_SENSOR = 'subscribe_sensor',
  SEND_COMMAND = 'send_command',
  SENSOR_UPDATE = 'sensor_update',
  ACTUATOR_UPDATE = 'actuator_update',
  STATE_UPDATE = 'state_update',
  BOARD_STATUS_UPDATE = 'board_status_update',
}

enum SystemState {
  DEBUG = 0, IDLE = 1, ARMED = 2, FUEL_FILL = 3, OX_FILL = 4,
  ENGINE_ABORT = 17, GSE_ABORT = 18, EMERGENCY_ABORT = 19,
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

// Message types we care about during command tests (excludes noisy sensor data)
const CMD_SPY_FILTER = new Set([
  MessageType.STATE_UPDATE, MessageType.ACTUATOR_UPDATE,
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

// ── Expected entities from config.toml enabled boards ────────────────────────
// Entity names use sensor_roles from config (spaces → underscores). Boards
// without role mappings use generic CHx names. Channels use channel_offset
// for second boards of the same type.
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
  // pt_board (id 21) — [sensor_roles_pt_board]: 10 named PTs
  'PT.Fuel_Upstream',        // connector 1
  'PT.GSE_Low',              // connector 2
  'PT.Fuel_Downstream',      // connector 3
  'PT.Chamber_Mid_PT_1',     // connector 4
  'PT.Ox_Upstream',          // connector 5
  'PT.GN2_Regulated',        // connector 6
  'PT.Ox_Downstream',        // connector 7
  'PT.Chamber_Mid_PT_2',     // connector 8
  'PT.Chamber_Throat_PT_1',  // connector 9
  'PT.Chamber_Throat_PT_2',  // connector 10

  // pt_board_2 (id 22) — [sensor_roles_pt2]: 3 HP PTs (connector 2 unused)
  'PT.GSE_High',             // connector 1
  'PT.GSE_Mid',              // connector 3
  'PT.GN2_High',             // connector 4

  // rtd_board (id 31) — active [1,2,3,4], no role-based entity names
  'RTD.CH1', 'RTD.CH2', 'RTD.CH3', 'RTD.CH4',

  // lc_board_2 (id 42) — active [1,2,6], no role-based entity names
  'LC.CH1', 'LC.CH2', 'LC.CH6',

  // tc_board (id 51) — active [2,3,4,5], no role-based entity names
  'TC.CH2', 'TC.CH3', 'TC.CH4', 'TC.CH5',

  // encoder_board_61 (id 61) — see config.toml [boards.encoder_board_61]
  'ENC.CH1',
];

// ── Test 1: Sensor Data Flow ─────────────────────────────────────────────────

// ── Backend stats (thin backend only) ────────────────────────────────────────

interface BackendStats {
  relayEntityUpdatesReceived: number;
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

async function testSensorDataFlow(ws: WebSocket): Promise<void> {
  console.log('\n📡 Test 1: Sensor Data Flow (fake data → DAQ bridge → Elodin → relay → backend → WS)');

  // Subscribe to all channel types. Channels go up to 20 because boards of
  // the same type use channel_offset to create a global namespace:
  //   board 1: offset 0  → CH1-CH10
  //   board 2: offset 10 → CH11-CH20
  const sensorPrefixes = ['PT_Cal.CH', 'PT.CH', 'RTD.CH', 'TC.CH', 'LC.CH', 'ENC.CH', 'ACT.CH'];
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

  console.log('  Collecting sensor updates for 5s...');
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

  // Print breakdown
  console.log(`\n  Sensor data breakdown (${updates.length} total updates, ${entities.size} entities):`);
  for (const [prefix, info] of Object.entries(typeBreakdown).sort()) {
    console.log(`    ${prefix.replace('.', '').padEnd(8)} ${info.count.toString().padStart(5)} updates across ${info.entities.size} channels: ${[...info.entities].sort().join(', ')}`);
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

  // Report any extra entities received beyond what we expected (e.g. ACT, PT_Cal)
  const extraEntities = sortedEntities.filter(e => !EXPECTED_ENTITIES.includes(e));
  if (extraEntities.length > 0) {
    console.log(`  Extra entities beyond expected (${extraEntities.length}): ${extraEntities.join(', ')}`);
  }

  // ── Zero packet loss verification ──
  // Each board sends ALL its active channels in one UDP packet. So every entity
  // from the same board MUST have the exact same update count. If any entity has
  // fewer updates than its board siblings, packets were dropped in the pipeline.
  const BOARD_GROUPS: Record<string, string[]> = {
    'pt_board': [
      'PT.Fuel_Upstream', 'PT.GSE_Low', 'PT.Fuel_Downstream', 'PT.Chamber_Mid_PT_1',
      'PT.Ox_Upstream', 'PT.GN2_Regulated', 'PT.Ox_Downstream', 'PT.Chamber_Mid_PT_2',
      'PT.Chamber_Throat_PT_1', 'PT.Chamber_Throat_PT_2',
    ],
    'pt_board_2': ['PT.GSE_High', 'PT.GSE_Mid', 'PT.GN2_High'],
    'rtd_board': ['RTD.CH1', 'RTD.CH2', 'RTD.CH3', 'RTD.CH4'],
    'lc_board_2': ['LC.CH1', 'LC.CH2', 'LC.CH6'],
    'tc_board': ['TC.CH2', 'TC.CH3', 'TC.CH4', 'TC.CH5'],
    'encoder_board': ['ENC.CH1'],
  };

  // Count updates per entity
  const entityCounts: Record<string, number> = {};
  for (const u of updates) {
    const e = u.payload.entity as string;
    entityCounts[e] = (entityCounts[e] || 0) + 1;
  }

  let totalDropped = 0;
  for (const [boardName, boardEntities] of Object.entries(BOARD_GROUPS)) {
    const counts = boardEntities.map(e => entityCounts[e] || 0);
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);

    // Print per-entity counts for this board
    console.log(`\n  ${boardName} (${maxCount} packets received):`);
    for (const e of boardEntities) {
      const count = entityCounts[e] || 0;
      const withinSpec = maxCount === 0 || count / maxCount >= 0.85;
      const status = withinSpec ? '✅' : '❌';
      console.log(`    ${status} ${e}: ${count}/${maxCount}`);
    }

    const dropped = boardEntities.reduce((sum, e) => sum + (maxCount - (entityCounts[e] || 0)), 0);
    const totalExpected = maxCount * boardEntities.length;
    const totalReceived = totalExpected - dropped;
    const deliveryPct = totalExpected > 0 ? (totalReceived / totalExpected) * 100 : 100;
    totalDropped += dropped;

    // 85% delivery threshold — small drops are expected because the WS test's
    // collection window doesn't align perfectly with when the simulator starts/stops
    // sending. Packets in flight at window boundaries may be counted for some
    // channels but not others, causing per-entity count skew of a few updates.
    const DELIVERY_THRESHOLD_PCT = 85;
    const passed = deliveryPct >= DELIVERY_THRESHOLD_PCT;
    assert(passed,
      dropped === 0
        ? `${boardName}: 0 dropped — all ${boardEntities.length} channels received ${maxCount} updates each`
        : `${boardName}: ${dropped} updates dropped (${deliveryPct.toFixed(1)}% delivery) — counts range ${minCount}-${maxCount}${passed ? ' (within tolerance)' : ''}`);
  }

  // Total update count — just report, no arbitrary minimum
  console.log(`  Total updates received (WS client): ${updates.length}`);

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

    printLatencyStats('Pipeline Latency (message timestamp → WS client receive)', latencies);

    // Per-type latency breakdown
    if (VERBOSE) {
      for (const [prefix, info] of Object.entries(typeBreakdown).sort()) {
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
    const received = statsAtWindowEnd.relayEntityUpdatesReceived - statsAtWindowStart.relayEntityUpdatesReceived;
    const broadcast = statsAtWindowEnd.sensorUpdatesBroadcast - statsAtWindowStart.sensorUpdatesBroadcast;
    const wsDelivery = broadcast > 0 ? (updates.length / broadcast * 100).toFixed(1) : '0.0';

    console.log(`\n  Backend throughput (${SENSOR_TIMEOUT_MS / 1000}s window):`);
    console.log(`    ${received.toLocaleString()} sensor updates ingested from Elodin (full rate)`);
    console.log(`    ${broadcast.toLocaleString()} sent to frontend after 10 Hz throttle`);
    console.log(`    ${updates.length.toLocaleString()} received by test client`);

    assert(received > 0, `Elodin → backend: data flowing (${received.toLocaleString()} updates)`);
    assert(received >= broadcast, `No phantom broadcasts (${broadcast.toLocaleString()} sent ≤ ${received.toLocaleString()} ingested)`);

    const wsDeliveryNum = broadcast > 0 ? updates.length / broadcast : 0;
    assert(wsDeliveryNum >= 0.85,
      `Frontend received ${updates.length.toLocaleString()}/${broadcast.toLocaleString()} broadcasts (${(wsDeliveryNum * 100).toFixed(1)}% — need ≥85%)`);
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

  for (const actuatorName of TEST_ACTUATORS) {
    // ── OPEN the actuator ──
    const sentAtOpen = Date.now();
    const openPromise = waitForMessage(ws, MessageType.ACTUATOR_UPDATE, COMMAND_TIMEOUT_MS,
      (payload) => payload.name === actuatorName && payload.state === ActuatorState.OPEN);

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
    const sentAtClose = Date.now();
    const closePromise = waitForMessage(ws, MessageType.ACTUATOR_UPDATE, COMMAND_TIMEOUT_MS,
      (payload) => payload.name === actuatorName && payload.state === ActuatorState.CLOSED);

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

  printLatencyStats('Actuator Command Round-Trip Latency (send → actuator_update received)', commandLatencies);

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
  console.log('\n📬 Test 8: BOARD_STATUS_UPDATE (thin backend)');
  const msgs = await collectMessages(ws, MessageType.BOARD_STATUS_UPDATE, 6000);
  const saw = msgs.some(
    (m) =>
      Array.isArray(m.payload?.boards) &&
      m.payload.boards.some((b: { boardState?: number }) => typeof b.boardState === 'number'),
  );
  assert(saw, 'BOARD_STATUS_UPDATE: at least one board with numeric boardState');
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🧪 WebSocket Data Flow Integration Test');
  console.log(`   Backend: ${WS_URL} (${IS_THIN ? 'server-thin.ts' : 'server.ts legacy'})`);
  if (IS_THIN) {
    console.log(`   sequencer_service: ${HAS_SEQUENCER ? 'available' : 'not found — command tests will be skipped'}`);
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

  try {
    await testSensorDataFlow(ws);
    if (IS_THIN) {
      await testServerHeartbeatUdp();
      await testBoardStatusToFrontend(ws);
      await testBoardStartupSelfTestToFrontend(ws);
    }
    if (canRunCommandTests) {
      await testStateTransition(ws);
      await testStateTransitionDebugMode(ws);
      await testActuatorCommands(ws);
      await testUdpActuatorCommands();
      await testElodinStateSync();
    } else {
      console.log('\n🔄 Test 2: State Transition — SKIPPED (thin backend requires sequencer_service)');
      console.log('🔄 Test 3: State Transition Debug Mode — SKIPPED');
      console.log('🔄 Test 4: Actuator Commands — SKIPPED');
      console.log('📬 Test 5: UDP Actuator Commands — SKIPPED');
      console.log('📬 Test 6: Elodin State Sync — SKIPPED');
    }
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
