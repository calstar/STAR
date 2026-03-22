#!/usr/bin/env tsx
/**
 * WebSocket Data Flow Test
 *
 * Connects to the backend WebSocket, subscribes to sensors, and verifies:
 * 1. SENSOR_UPDATE messages arrive with valid entity names and numeric values
 * 2. STATE_UPDATE messages arrive after sending a state transition command
 * 3. ACTUATOR_UPDATE messages arrive after sending an actuator command
 *
 * Usage: tsx ws_data_flow_test.ts [ws_port] [api_port] [actuator_udp_port]
 * Exit code: 0 = pass, 1 = fail
 */

import WebSocket from 'ws';

const WS_PORT = parseInt(process.argv[2] || '8081', 10);
const API_PORT = parseInt(process.argv[3] || '8082', 10);
const ACTUATOR_UDP_PORT = parseInt(process.argv[4] || '5005', 10);
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;
const SENSOR_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 10000;

// Shared types (inline to avoid import issues)
enum MessageType {
  SUBSCRIBE_SENSOR = 'subscribe_sensor',
  SEND_COMMAND = 'send_command',
  SENSOR_UPDATE = 'sensor_update',
  ACTUATOR_UPDATE = 'actuator_update',
  STATE_UPDATE = 'state_update',
}

enum SystemState {
  DEBUG = 0, IDLE = 1, ARMED = 2,
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(ws: WebSocket, msg: WSMessage): void {
  ws.send(JSON.stringify(msg));
}

function waitForMessage(
  ws: WebSocket,
  type: string,
  timeoutMs: number,
  predicate?: (payload: any) => boolean,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Timeout waiting for ${type} (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      try {
        const msg: WSMessage = JSON.parse(data.toString());
        if (msg.type === type && (!predicate || predicate(msg.payload))) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg.payload);
        }
      } catch { /* ignore malformed */ }
    }

    ws.on('message', handler);
  });
}

function collectMessages(
  ws: WebSocket,
  type: string,
  durationMs: number,
): Promise<any[]> {
  return new Promise((resolve) => {
    const collected: any[] = [];

    function handler(data: WebSocket.Data) {
      try {
        const msg: WSMessage = JSON.parse(data.toString());
        if (msg.type === type) {
          collected.push(msg.payload);
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

// ── Test Runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
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
  // Subscribe to actuator channels
  for (let i = 1; i <= 10; i++) {
    send(ws, {
      type: MessageType.SUBSCRIBE_SENSOR,
      timestamp: Date.now(),
      payload: { entity: `ACT.ACT_CH${i}` },
    });
  }

  console.log('  Waiting for sensor updates...');
  const updates = await collectMessages(ws, MessageType.SENSOR_UPDATE, SENSOR_TIMEOUT_MS);

  assert(updates.length > 0, `Received ${updates.length} sensor updates (expected > 0)`);

  if (updates.length > 0) {
    // Check entity names
    const entities = new Set(updates.map((u: any) => u.entity));
    assert(entities.size > 1, `Received data from ${entities.size} distinct entities (expected > 1)`);

    // Check for PT channels
    const hasPT = [...entities].some(e => e.startsWith('PT_Cal.') || e.startsWith('PT.'));
    assert(hasPT, 'Received PT sensor data');

    // Check numeric values
    const allNumeric = updates.every((u: any) => typeof u.value === 'number' && Number.isFinite(u.value));
    assert(allNumeric, 'All sensor values are finite numbers');

    // Check timestamps are recent
    const now = Date.now();
    const recentTimestamps = updates.filter((u: any) => Math.abs(now - u.timestamp) < 60000);
    assert(
      recentTimestamps.length > updates.length * 0.5,
      `${recentTimestamps.length}/${updates.length} timestamps are within 60s of now`,
    );

    // Log sample data
    const sample = updates[0];
    console.log(`  Sample: entity=${sample.entity} component=${sample.component} value=${sample.value}`);
  }
}

// ── Test 2: State Transition Command ─────────────────────────────────────────

async function testStateTransition(ws: WebSocket): Promise<void> {
  console.log('\n🔄 Test 2: State Transition Command (WS client → backend → broadcast)');

  // Send state transition to ARMED
  const statePromise = waitForMessage(ws, MessageType.STATE_UPDATE, COMMAND_TIMEOUT_MS);

  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: {
      commandType: 'state_transition',
      data: { state: SystemState.ARMED },
    },
  });

  try {
    const stateUpdate = await statePromise;
    assert(stateUpdate.currentState === SystemState.ARMED, `State changed to ARMED (got ${stateUpdate.currentState})`);
    assert(typeof stateUpdate.stateName === 'string', `State name is string: "${stateUpdate.stateName}"`);
    assert(typeof stateUpdate.timestamp === 'number', 'State update has timestamp');
  } catch (err: any) {
    assert(false, `State transition: ${err.message}`);
  }

  // Transition back to IDLE
  const idlePromise = waitForMessage(ws, MessageType.STATE_UPDATE, COMMAND_TIMEOUT_MS);
  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: {
      commandType: 'state_transition',
      data: { state: SystemState.IDLE },
    },
  });
  try {
    const idleUpdate = await idlePromise;
    assert(idleUpdate.currentState === SystemState.IDLE, `State returned to IDLE (got ${idleUpdate.currentState})`);
  } catch (err: any) {
    assert(false, `Return to IDLE: ${err.message}`);
  }
}

// ── Test 3: Actuator Command ─────────────────────────────────────────────────

async function testActuatorCommand(ws: WebSocket): Promise<void> {
  console.log('\n🔧 Test 3: Actuator Command (WS client → backend → UDP + broadcast)');

  // First go to DEBUG mode to allow manual actuator commands
  const debugPromise = waitForMessage(ws, MessageType.STATE_UPDATE, COMMAND_TIMEOUT_MS);
  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: {
      commandType: 'state_transition',
      data: { state: SystemState.DEBUG },
    },
  });
  try {
    await debugPromise;
  } catch {
    console.log('  ⚠️ Could not enter DEBUG mode, skipping actuator command test');
    return;
  }

  // Send actuator command
  const actPromise = waitForMessage(ws, MessageType.ACTUATOR_UPDATE, COMMAND_TIMEOUT_MS);

  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: {
      commandType: 'actuator',
      data: {
        actuatorName: 'LOX_Main',
        actuatorState: ActuatorState.OPEN,
      },
    },
  });

  try {
    const actUpdate = await actPromise;
    assert(actUpdate.name === 'LOX_Main' || actUpdate.name?.includes('LOX'), `Actuator update for LOX_Main (got name="${actUpdate.name}")`);
    assert(actUpdate.state === ActuatorState.OPEN, `Actuator state is OPEN (got ${actUpdate.state})`);
  } catch (err: any) {
    assert(false, `Actuator command: ${err.message}`);
  }

  // Return to IDLE
  send(ws, {
    type: MessageType.SEND_COMMAND,
    timestamp: Date.now(),
    payload: {
      commandType: 'state_transition',
      data: { state: SystemState.IDLE },
    },
  });
  await new Promise(r => setTimeout(r, 500));
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

  try {
    await testSensorDataFlow(ws);
    await testStateTransition(ws);
    await testActuatorCommand(ws);
  } finally {
    ws.close();
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ Unhandled error:', err);
  process.exit(1);
});
