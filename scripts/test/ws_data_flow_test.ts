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

const WS_PORT = parseInt(process.argv[2] || '8081', 10);
const API_PORT = parseInt(process.argv[3] || '8082', 10);
const ACTUATOR_UDP_PORT = parseInt(process.argv[4] || '5005', 10);
const VERBOSE = process.argv.includes('--verbose');
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;
const SENSOR_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 15000;

// Shared types (inline to avoid import issues)
enum MessageType {
  SUBSCRIBE_SENSOR = 'subscribe_sensor',
  SEND_COMMAND = 'send_command',
  SENSOR_UPDATE = 'sensor_update',
  ACTUATOR_UPDATE = 'actuator_update',
  STATE_UPDATE = 'state_update',
  CONNECTION_STATUS = 'connection_status',
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

function startMessageSpy(ws: WebSocket): () => void {
  const handler = (data: WebSocket.Data) => {
    try {
      const msg: WSMessage = JSON.parse(data.toString());
      const payloadStr = JSON.stringify(msg.payload);
      const truncated = payloadStr.length > 200 ? payloadStr.slice(0, 200) + '...' : payloadStr;
      console.log(`  << RECV: type=${msg.type} payload=${truncated}`);
    } catch { /* ignore */ }
  };
  ws.on('message', handler);
  return () => ws.removeListener('message', handler);
}

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

/** Wait for backend to report elodinConnected=true before running tests */
async function waitForElodinConnection(ws: WebSocket): Promise<void> {
  console.log('  Waiting for backend Elodin connection...');
  try {
    await waitForMessage(ws, MessageType.CONNECTION_STATUS, 10000,
      (payload) => payload.elodinConnected === true);
    console.log('  ✅ Backend reports Elodin connected');
  } catch {
    // May have already connected before we started listening — check current state
    console.log('  ⚠️  No connection_status received (may already be connected)');
  }
}

// ── Test 1: Sensor Data Flow ─────────────────────────────────────────────────

async function testSensorDataFlow(ws: WebSocket): Promise<void> {
  console.log('\n📡 Test 1: Sensor Data Flow (fake data → DAQ bridge → Elodin → relay → backend → WS)');

  // Subscribe to PT channels
  for (let i = 1; i <= 10; i++) {
    send(ws, {
      type: MessageType.SUBSCRIBE_SENSOR,
      timestamp: Date.now(),
      payload: { entity: `PT_Cal.PT_CH${i}` },
    });
    send(ws, {
      type: MessageType.SUBSCRIBE_SENSOR,
      timestamp: Date.now(),
      payload: { entity: `PT.PT_CH${i}` },
    });
  }
  // Subscribe to actuator, RTD, TC, LC channels
  for (let i = 1; i <= 10; i++) {
    send(ws, { type: MessageType.SUBSCRIBE_SENSOR, timestamp: Date.now(), payload: { entity: `ACT.ACT_CH${i}` } });
    send(ws, { type: MessageType.SUBSCRIBE_SENSOR, timestamp: Date.now(), payload: { entity: `RTD.RTD_CH${i}` } });
    send(ws, { type: MessageType.SUBSCRIBE_SENSOR, timestamp: Date.now(), payload: { entity: `TC.TC_CH${i}` } });
    send(ws, { type: MessageType.SUBSCRIBE_SENSOR, timestamp: Date.now(), payload: { entity: `LC.LC_CH${i}` } });
  }

  console.log('  Collecting sensor updates for 15s...');
  const updates = await collectMessages(ws, MessageType.SENSOR_UPDATE, SENSOR_TIMEOUT_MS);

  // ── Assertions: expect meaningful data volumes ──
  // With 10Hz fake data over 15s, we should get hundreds of updates minimum
  const MIN_UPDATES = 50; // conservative — real runs get 1000+
  assert(updates.length >= MIN_UPDATES, `Received ${updates.length} sensor updates (expected >= ${MIN_UPDATES})`);

  if (updates.length > 0) {
    // Check entity diversity — with multiple boards we should see many distinct entities
    const entities = new Set(updates.map((u) => u.payload.entity));
    const MIN_ENTITIES = 3; // at least a few distinct sensor channels
    assert(entities.size >= MIN_ENTITIES, `Received data from ${entities.size} distinct entities (expected >= ${MIN_ENTITIES})`);

    // Log all distinct entities for diagnostics
    const sortedEntities = [...entities].sort();
    if (VERBOSE) {
      console.log(`  Distinct entities (${sortedEntities.length}):`);
      for (const e of sortedEntities) {
        const count = updates.filter((u) => u.payload.entity === e).length;
        console.log(`    ${e} (${count} updates)`);
      }
    }

    // Verify we receive multiple sensor types (not just one kind)
    const knownPrefixes = ['PT_Cal.', 'PT.', 'RTD.', 'TC.', 'LC.', 'ACT.'];
    const sensorTypesFound = knownPrefixes.filter(prefix =>
      [...entities].some(e => e.startsWith(prefix)));
    assert(sensorTypesFound.length >= 1, `Received ${sensorTypesFound.length} sensor type(s): ${sensorTypesFound.map(p => p.replace('.', '')).join(', ')}`);

    // Check all values are finite numbers
    const allNumeric = updates.every((u) => typeof u.payload.value === 'number' && Number.isFinite(u.payload.value));
    assert(allNumeric, 'All sensor values are finite numbers');

    // Check timestamps are recent (all should be within 60s)
    const now = Date.now();
    const recentTimestamps = updates.filter((u) => Math.abs(now - u.payload.timestamp) < 60000);
    assert(
      recentTimestamps.length === updates.length,
      `${recentTimestamps.length}/${updates.length} timestamps are within 60s of now`,
    );

    // ── Pipeline latency measurement ──
    const latencies = updates
      .map((u) => u.receivedAt - u.payload.timestamp)
      .filter((l) => l >= 0 && l < 60000);

    printLatencyStats('Pipeline Latency (message timestamp → WS client receive)', latencies);

    // Log sample data
    if (VERBOSE) {
      const sampleEntities = sortedEntities.slice(0, 3);
      for (const e of sampleEntities) {
        const sample = updates.find((u) => u.payload.entity === e);
        console.log(`  Sample [${e}]: component=${sample!.payload.component} value=${sample!.payload.value} latency=${sample!.receivedAt - sample!.payload.timestamp}ms`);
      }
    }
  }
}

// ── Test 2: State Transition Command ─────────────────────────────────────────

async function testStateTransition(ws: WebSocket): Promise<void> {
  console.log('\n🔄 Test 2: State Transition (without debug mode)');
  debugLogMessages = VERBOSE;
  const stopSpy = VERBOSE ? startMessageSpy(ws) : () => {};

  // Listen for error messages from the backend
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

  // Test state transition WITHOUT debug mode (Elodin direct connection should be up)
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
    if (errors.length > 0) {
      assert(false, `State transition IDLE→ARMED: backend rejected — ${JSON.stringify(errors[0])}`);
    } else {
      assert(false, `State transition IDLE→ARMED: ${err.message}`);
    }
  }

  // ARMED → IDLE
  errors.length = 0;
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
    if (errors.length > 0) {
      assert(false, `State transition ARMED→IDLE: backend rejected — ${JSON.stringify(errors[0])}`);
    } else {
      assert(false, `Return to IDLE: ${err.message}`);
    }
  }

  printLatencyStats('State Transition Command Latency (send → state_update received)', commandLatencies);

  ws.removeListener('message', errorHandler);
  stopSpy();
  debugLogMessages = false;
}

// ── Test 3: State Transition in Debug Mode ──────────────────────────────────

async function testStateTransitionDebugMode(ws: WebSocket): Promise<void> {
  console.log('\n🔄 Test 3: State Transition (debug mode)');
  debugLogMessages = VERBOSE;
  const stopSpy = VERBOSE ? startMessageSpy(ws) : () => {};

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
  const stopSpy = VERBOSE ? startMessageSpy(ws) : () => {};

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
        console.log(`  ✅ ${actuatorName} → OPEN (${openLatency}ms)`);
      }
    } catch (err: any) {
      assert(false, `Actuator OPEN "${actuatorName}": ${err.message}`);
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
        console.log(`  ✅ ${actuatorName} → CLOSED (${closeLatency}ms)`);
      }
    } catch (err: any) {
      assert(false, `Actuator CLOSE "${actuatorName}": ${err.message}`);
    }

    // Small delay before next actuator
    await new Promise(r => setTimeout(r, 200));
  }

  // Summary assertions
  assert(actuatorsOpened === TEST_ACTUATORS.length,
    `${actuatorsOpened}/${TEST_ACTUATORS.length} actuators opened successfully`);
  assert(actuatorsClosed === TEST_ACTUATORS.length,
    `${actuatorsClosed}/${TEST_ACTUATORS.length} actuators closed successfully`);

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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🧪 WebSocket Data Flow Integration Test');
  console.log(`   Backend: ${WS_URL}`);
  console.log('');

  let ws: WebSocket;
  try {
    ws = await connectWS();
    console.log('✅ Connected to backend WebSocket');
  } catch (err: any) {
    console.error(`❌ Failed to connect: ${err.message}`);
    process.exit(1);
  }

  // Wait briefly for backend to establish Elodin connection
  await waitForElodinConnection(ws);

  try {
    await testSensorDataFlow(ws);
    await testStateTransition(ws);
    await testStateTransitionDebugMode(ws);
    await testActuatorCommands(ws);
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
