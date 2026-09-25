/** Run from backend: ELODIN_DB=/path/to/elodin-db DAQ_BRIDGE=/path/to/daq_bridge npx tsx test/environmental.integration.ts */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbBinary = process.env.ELODIN_DB;
const bridgeBinary = process.env.DAQ_BRIDGE;
assert(dbBinary && bridgeBinary, 'Set ELODIN_DB and DAQ_BRIDGE to the built executables');
const work = mkdtempSync(join(tmpdir(), 'environmental-integration-'));
const backendFirst = process.env.BACKEND_FIRST === '1';
const children: ChildProcess[] = [];
const stopped = new Set<ChildProcess>();
const logs = new Map<ChildProcess, string>();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function start(command: string, args: string[], env = process.env): ChildProcess {
  const p = spawn(command, args, { cwd: backend, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  logs.set(p, '');
  for (const stream of [p.stdout, p.stderr]) {
    stream?.on('data', (data) => logs.set(p, (logs.get(p)! + data.toString()).slice(-2000000)));
  }
  p.on('error', (error) => logs.set(p, logs.get(p)! + error.message));
  return p;
}

async function until(check: () => boolean, label: string, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    for (const child of children) {
      if (stopped.has(child)) continue;
      assert(child.exitCode == null && child.signalCode == null,
        `Process ${child.pid} exited (${child.exitCode}/${child.signalCode}) while waiting for ${label}`);
    }
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await delay(50);
  }
}

function environmental(temperature = -12.5, pressure = 101325, humidity = 45.25) {
  const p = Buffer.alloc(18);
  p.writeUInt8(13, 0);
  p.writeUInt8(0, 1);
  p.writeUInt32LE(123456, 2);
  p.writeFloatLE(temperature, 6);
  p.writeUInt32LE(pressure, 10);
  p.writeFloatLE(humidity, 14);
  return p;
}

const udp = createSocket('udp4');
let ws: WebSocket | undefined;
let sender: ReturnType<typeof setInterval> | undefined;
try {
  const [dbPort, wsPort, udpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const config = join(work, 'config.toml');
  writeFileSync(config, `
[database]
host = "127.0.0.1"
port = ${dbPort}
[network]
bind_ip = "127.0.0.1"
sensor_port = ${udpPort}
[heartbeat_service]
enabled = true
[logs]
backend_udp_port = 0
[boards.environmental_board]
type = "ENVIRONMENTAL"
ip = "127.0.0.1"
board_id = 25
enabled = true
active_connectors = [1]
[boards.disabled_environmental]
type = "ENVIRONMENTAL"
ip = "127.0.0.2"
board_id = 35
enabled = false
active_connectors = [1]
`);
  for (const [name, text, message] of [
    ['range', readFileSync(config, 'utf8').replace('board_id = 25', 'board_id = 256'), 'integer from 1 to 255'],
    ['duplicate', readFileSync(config, 'utf8').replace('board_id = 35', 'board_id = 25')
      .replace('enabled = false', 'enabled = true'), 'claimed by both'],
  ]) {
    const invalidConfig = join(work, `invalid-${name}.toml`);
    writeFileSync(invalidConfig, text);
    const rejected = spawnSync(bridgeBinary!, [invalidConfig], { encoding: 'utf8', timeout: 3000 });
    assert.equal(rejected.status, 1, `Bridge must refuse ${name} config before connecting`);
    assert(rejected.stderr.includes(message), rejected.stderr);
  }
  const db = start(dbBinary!, ['run', `127.0.0.1:${dbPort}`, join(work, 'db')]);
  await delay(1000);
  assert.equal(db.exitCode, null, logs.get(db));
  const startBridge = async () => {
    const bridge = start(bridgeBinary!, [config]);
    await until(() => logs.get(bridge)!.includes('Listening for DiabloAvionics packets'), 'bridge readiness');
  };
  if (!backendFirst) await startBridge();
  const server = start(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    ...process.env, CONFIG_PATH: config, ELODIN_PORT: String(dbPort), WS_PORT: String(wsPort),
    ELODIN_HOST: '127.0.0.1', GUI_PORT: '0', SESSION_SERVICE_MODE: 'off', USE_SIM: '1',
  });
  await until(() => logs.get(server)!.includes('WebSocket server listening'), 'backend readiness');
  if (backendFirst) {
    await until(() => logs.get(server)!.includes('subscription refused for [0x25, 0x19]'),
      'environmental subscription rejected before its schema exists');
    await startBridge();
    console.log('Confirmed environmental subscription rejection before bridge startup.');
  }
  ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const updates: Array<{ entity: string; component: string; value: number; timestamp: number }> = [];
  let connectedBoard = false;
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'sensor_update') {
      const payload = Array.isArray(message.payload) ? message.payload : [message.payload];
      for (const p of payload) if (p.entity?.startsWith('ENV')) updates.push(p);
    }
    if (message.type === 'board_status_update') {
      connectedBoard = message.payload.boards.some((b: any) => b.id === 25 && b.type === 'ENVIRONMENTAL' && b.connected);
    }
  });
  await new Promise<void>((r, reject) => { ws!.once('open', r); ws!.once('error', reject); });
  const send = (p: Buffer) => udp.send(p, udpPort, '127.0.0.1');
  sender = setInterval(() => {
    send(environmental());
    // PacketHeader + firmware SHA-256 + board ID, engine state SAFE, board state ACTIVE.
    const heartbeat = Buffer.alloc(41);
    heartbeat[0] = 1;
    heartbeat[38] = 25;
    heartbeat[40] = 2;
    send(heartbeat);
  }, 200);
  await until(() => new Set(updates.map((p) => p.component)).size === 3 && connectedBoard, 'UDP → Elodin → backend → WebSocket');
  for (const [component, value] of Object.entries({ temperature_c: -12.5, pressure_pa: 101325, humidity_rh: 45.25 })) {
    const row = updates.find((p) => p.component === component)!;
    assert.equal(row.entity, 'ENV25');
    assert.equal(row.value, value);
    assert(Math.abs(row.timestamp - Date.now()) < 10000, 'Sensor timestamp must use epoch milliseconds');
  }
  assert(!updates.some((p) => p.entity === 'ENV35'), 'Disabled board must not emit data');
  if (backendFirst) {
    stopped.add(db);
    const exited = new Promise<void>((r) => db.once('exit', () => r()));
    db.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    assert(db.exitCode !== null || db.signalCode !== null, 'Database did not stop');
    await until(() => logs.get(server)!.includes('Elodin DB disconnected'), 'backend disconnect');
    // A fresh database requires the bridge to register schemas again, not just reconnect.
    start(dbBinary!, ['run', `127.0.0.1:${dbPort}`, join(work, 'restarted-db')]);
    updates.length = 0;
    await until(() => new Set(updates.map((p) => p.component)).size === 3,
      'environmental stream recovery after database restart', 30000);
  }
  clearInterval(sender);
  sender = undefined;
  await delay(300);
  const validUpdateCount = updates.length;
  const badVersion = environmental(777);
  badVersion[1] = 99;
  for (const p of [badVersion, environmental(777).subarray(0, 17),
    Buffer.concat([environmental(777), Buffer.from([0])]),
    environmental(777, 101325, 101), environmental(777, 0), environmental(NaN)]) {
    send(p);
    await delay(250);
  }
  await delay(500);
  assert.equal(updates.length, validUpdateCount, 'Invalid packets emitted new sensor updates');
  assert(updates.every((p) => Number.isFinite(p.value) && p.value !== 777), 'Invalid UDP packets reached the frontend stream');
  console.log(`PASS: real UDP → DAQ bridge → Elodin 0.16.1 → backend WebSocket; units, epoch time, heartbeat, malformed packets; backend-first/restart=${backendFirst}.`);
} catch (error) {
  for (const [p, log] of logs) {
    const path = join(work, `process-${p.pid}.log`);
    writeFileSync(path, log);
    console.error(`Process ${p.pid} (${p.exitCode}/${p.signalCode}): ${path}\n${log.slice(-1000)}`);
  }
  throw error;
} finally {
  if (sender) clearInterval(sender);
  ws?.terminate();
  udp.close();
  for (const p of children.reverse()) {
    if (p.exitCode != null || p.signalCode != null) continue;
    p.kill('SIGTERM');
    await Promise.race([new Promise<void>((r) => p.once('exit', () => r())), delay(2000)]);
    if (p.exitCode == null && p.signalCode == null) p.kill('SIGKILL');
  }
  console.log(`Test data: ${work}`);
}
