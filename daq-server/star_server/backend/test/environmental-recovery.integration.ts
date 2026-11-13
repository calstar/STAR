/** Isolated startup/restart regression. Core packet assertions live in test/ws_data_flow_test.ts. */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbBinary = process.env.ELODIN_DB;
const bridgeBinary = process.env.DAQ_BRIDGE;
assert(dbBinary && bridgeBinary, 'Set ELODIN_DB and DAQ_BRIDGE to the built executables');
const work = mkdtempSync(join(tmpdir(), 'environmental-integration-'));
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
  const server = start(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    ...process.env, CONFIG_PATH: config, ELODIN_PORT: String(dbPort), WS_PORT: String(wsPort),
    ELODIN_HOST: '127.0.0.1', GUI_PORT: '0', SESSION_SERVICE_MODE: 'off', USE_SIM: '1',
  });
  await until(() => logs.get(server)!.includes('WebSocket server listening'), 'backend readiness');
  await until(() => logs.get(server)!.split('\n').some((line) =>
    line.includes('subscription refusal(s)') && line.includes('[0x25, 0x19]')),
    'environmental subscription rejected before its schema exists');
  await startBridge();
  console.log('Confirmed environmental subscription rejection before bridge startup.');
  const checkDataFlow = async () => {
    const check = start(process.execPath, ['--import', 'tsx', '../../test/ws_data_flow_test.ts',
      String(wsPort), '0', '0', '--backend=thin', '--only=environmental'], {
      ...process.env, TEST_DAQ_UDP_PORT: String(udpPort),
      NODE_PATH: join(backend, 'node_modules'),
      TEST_ENVIRONMENTAL_SOURCE_IP: '127.0.0.1', TEST_ENVIRONMENTAL_EXCLUSIVE: '1',
    });
    // This process is expected to exit; keep checking the services while it runs.
    stopped.add(check);
    await until(() => check.exitCode !== null || check.signalCode !== null, 'standard environmental checks', 60000);
    console.log(logs.get(check));
    assert.equal(check.exitCode, 0, 'Standard environmental data-flow checks failed');
  };
  await checkDataFlow();
  stopped.add(db);
  const exited = new Promise<void>((r) => db.once('exit', () => r()));
  db.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  assert(db.exitCode !== null || db.signalCode !== null, 'Database did not stop');
  await until(() => logs.get(server)!.includes('Elodin DB disconnected'), 'backend disconnect');
  // A fresh database requires schema registration as well as subscription recovery.
  start(dbBinary!, ['run', `127.0.0.1:${dbPort}`, join(work, 'restarted-db')]);
  await checkDataFlow();
  console.log('PASS: backend-first subscription retry and fresh-database restart recovery.');
} catch (error) {
  for (const [p, log] of logs) {
    const path = join(work, `process-${p.pid}.log`);
    writeFileSync(path, log);
    console.error(`Process ${p.pid} (${p.exitCode}/${p.signalCode}): ${path}\n${log.slice(-1000)}`);
  }
  throw error;
} finally {
  for (const p of children.reverse()) {
    if (p.exitCode != null || p.signalCode != null) continue;
    p.kill('SIGTERM');
    await Promise.race([new Promise<void>((r) => p.once('exit', () => r())), delay(2000)]);
    if (p.exitCode == null && p.signalCode == null) p.kill('SIGKILL');
  }
  console.log(`Test data: ${work}`);
}
