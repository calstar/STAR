#!/usr/bin/env tsx
/**
 * Session-control end-to-end test (systemd/sim or systemd/hardware backend).
 *
 * Drives the run-session feature over the backend WebSocket exactly as the GUI
 * does, and asserts the whole lifecycle works against a REAL systemctl-managed
 * pipeline (not the `mock` no-op mode):
 *
 *   1. session_start (Discard) → SESSION_UPDATE active, a fresh timestamped DB
 *      dir is created on disk.
 *   2. The pipeline the button started actually comes up: Elodin connects and
 *      SENSOR_UPDATE data flows.
 *   3. Both auto-stop warnings fire (one per configured SESSION_WARN_LEADS_MS
 *      lead) as high-priority notifications.
 *   4. Auto-stop fires at the deadline → SESSION_UPDATE active:false, and the
 *      Discard dir is removed.
 *   5. A second run with Save + session_extend pushes the deadline out and, on
 *      stop, keeps its DB dir.
 *   6. The LabJack T7 in config_base.toml streams through the session: sensor-t7 runs
 *      t7_bridge --fake on a simulated run, calibration_service calibrates it, and its
 *      calibrated values reach the GUI in BOTH runs (run 2 restarts Elodin under the
 *      same backend, which is where a T7 subscription that is not renewed goes quiet).
 *      The saved run's sidecar config carries the T7 so the run can be decoded later.
 *
 * Requires the backend running in SESSION_SERVICE_MODE=systemd (or dev sim) with
 * SESSION_WARN_LEADS_MS set short (e.g. "20000,10000"). Started for CI/local by
 * test/test_session.sh. Exit 0 = pass, 1 = fail.
 */
import WebSocket from 'ws';
import { existsSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const WS_PORT = parseInt(process.env.SESSION_TEST_WS_PORT || '8081', 10);
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;
const PASSWORD = process.env.CONTROL_PASSWORD || 'diablo';
const DURATION_MS = parseInt(process.env.SESSION_TEST_DURATION_MS || '30000', 10);
const ELODIN_ROOT = process.env.ELODIN_ROOT || join(homedir(), '.local', 'share', 'elodin');
const EXPECTED_WARN_KEYS = (process.env.SESSION_WARN_LEADS_MS || '20000,10000')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0)
  .map((lead) => `session-timeout-${lead}`);

const passed: string[] = [];
const failed: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✅ ${msg}`); passed.push(msg); }
  else { console.error(`  ❌ ${msg}`); failed.push(msg); }
}

interface WSMessage { type: string; timestamp: number; payload: any }

// Shared observed state, populated by a single persistent listener.
const state = {
  sensorUpdates: 0,
  elodinConnected: false,
  warnKeys: new Set<string>(),
  lastSession: null as any,
  // Boards that produced a SELF_TEST.* SENSOR_UPDATE — proves the config→self-test
  // lifecycle ran (i.e. config_broadcast reached the sim boards). A wrong-config
  // service unit leaves this empty even though plain sensor data still flows.
  selfTestBoards: new Set<string>(),
  // Calibrated T7 values (T7<slot>_Cal.AIN<n>, psi / °C / kg), counted and kept by key.
  t7Updates: 0,
  t7Last: new Map<string, number>(),
};

/** The T7 config_base.toml declares, with the range its --fake signal should calibrate into. */
const T7_EXPECT = [
  { key: 'T71_Cal.AIN1.pressure_psi', min: 250, max: 350 },  // PT 30 % of 1000 psi
  { key: 'T71_Cal.AIN2.temperature_c', min: 45, max: 75 },   // TC ~60 °C
  { key: 'T71_Cal.AIN4.force_kg', min: 85, max: 115 },       // LC 20 % of 500 kg
];

function checkT7(run: string): void {
  for (const { key, min, max } of T7_EXPECT) {
    const v = state.t7Last.get(key);
    assert(v !== undefined && v >= min && v <= max, `${run}: T7 ${key} streams calibrated, in [${min}, ${max}] (${v?.toFixed?.(1) ?? 'none'})`);
  }
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const t = setTimeout(() => { ws.close(); reject(new Error(`connect timeout ${WS_URL}`)); }, 8000);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function send(ws: WebSocket, type: string, payload: any): void {
  ws.send(JSON.stringify({ type, timestamp: Date.now(), payload }));
}

/** Resolve when a message of `type` satisfying `pred` arrives, else reject on timeout. */
function waitFor(ws: WebSocket, type: string, timeoutMs: number, pred?: (p: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeListener('message', h); reject(new Error(`timeout waiting ${type} (${timeoutMs}ms)`)); }, timeoutMs);
    function h(d: WebSocket.Data) {
      let m: WSMessage; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === type && (!pred || pred(m.payload))) { clearTimeout(timer); ws.removeListener('message', h); resolve(m.payload); }
    }
    ws.on('message', h);
  });
}

function attachObserver(ws: WebSocket): void {
  ws.on('message', (d) => {
    let m: WSMessage; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.type === 'sensor_update') {
      state.sensorUpdates++;
      const ent = m.payload?.entity;
      if (typeof ent === 'string' && ent.startsWith('SELF_TEST.')) state.selfTestBoards.add(ent.split('.')[1] ?? ent);
      for (const row of Array.isArray(m.payload) ? m.payload : [m.payload]) {
        if (typeof row?.entity === 'string' && /^T7\d+_Cal\./.test(row.entity) && Number.isFinite(row.value)
            && ['pressure_psi', 'temperature_c', 'force_kg'].includes(row.component)) {
          state.t7Updates++;
          state.t7Last.set(`${row.entity}.${row.component}`, row.value);
        }
      }
    }
    else if (m.type === 'connection_status' && m.payload?.elodinConnected) state.elodinConnected = true;
    else if (m.type === 'session_update') state.lastSession = m.payload;
    else if (m.type === 'notification' && typeof m.payload?.key === 'string'
             && m.payload.key.startsWith('session-timeout-') && m.payload.ongoing) {
      state.warnKeys.add(m.payload.key);
    }
  });
}

async function unlock(ws: WebSocket): Promise<void> {
  const p = waitFor(ws, 'control_unlock_result', 5000, (x) => x.ok === true);
  send(ws, 'control_unlock', { password: PASSWORD });
  await p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `pred()` holds, resolving the instant it does; return whether it held
 * within `timeoutMs`. Replaces the old fixed `sleep(6000)`-then-count, which raced a
 * cold systemd pipeline: `elodinConnected` only means the backend's socket to the
 * freshly-restarted elodin is open — NOT that the sim / daq_bridge that same session
 * unit started are producing yet. On a slow CI runner first data landed just after the
 * 6s window, so the count read 0. Polling passes fast on the happy path and tolerates a
 * slow startup, while still failing (after the longer window) if data genuinely never flows.
 */
async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(200);
  }
  return pred();
}

// Max time to wait for the session's pipeline to start delivering data after
// elodinConnected. Kept below Run 1's DURATION_MS (30s) so the auto-stop / warning
// timeline is unaffected; the poll resolves in ~1–10s on a healthy stack.
const PIPELINE_DATA_TIMEOUT_MS = parseInt(process.env.SESSION_TEST_DATA_TIMEOUT_MS || '15000', 10);

async function main(): Promise<void> {
  console.log(`▶ session_flow_test → ${WS_URL} (duration ${DURATION_MS}ms, warn keys ${EXPECTED_WARN_KEYS.join(', ')})`);
  const ws = await connect();
  attachObserver(ws);
  await unlock(ws);
  console.log('  control unlocked');

  // ── Run 1: Discard, short duration → warnings + auto-stop + dir removed ─────
  console.log('\n▶ Run 1 — Discard, auto-stop');
  const startedAt = Date.now();
  const activePromise = waitFor(ws, 'session_update', 10000, (p) => p.active === true);
  send(ws, 'send_command', { commandType: 'session_start', data: { keepData: false, durationMs: DURATION_MS, simulated: true } });
  const active = await activePromise;
  const dbDir1: string = active.dbDir;
  assert(active.active === true, 'session_start → active');
  assert(active.simulated === true, 'session_start (simulated) → SESSION_UPDATE.simulated true');
  assert(typeof dbDir1 === 'string' && dbDir1.startsWith(join(ELODIN_ROOT, 'daq_')), `fresh timestamped dbDir (${dbDir1})`);
  await sleep(300);
  assert(existsSync(dbDir1), 'run DB dir created on disk');

  // Pipeline the button started must actually produce data.
  await waitFor(ws, 'connection_status', 30000, (p) => p.elodinConnected === true).catch(() => {});
  assert(state.elodinConnected, 'Elodin connected (pipeline came up via systemctl)');
  const before = state.sensorUpdates;
  // Wait until the pipeline is actually delivering (sensor data + the one-shot
  // self-test lifecycle), rather than blindly sleeping past a slow cold start.
  await waitUntil(() => state.sensorUpdates - before > 50 && state.selfTestBoards.size > 0, PIPELINE_DATA_TIMEOUT_MS);
  const flowed = state.sensorUpdates - before;
  assert(flowed > 50, `sensor data flowing (${flowed} SENSOR_UPDATE within ${PIPELINE_DATA_TIMEOUT_MS / 1000}s)`);
  // Config→self-test lifecycle ran: sim boards received SENSOR_CONFIG and emitted
  // SELF_TEST. Empty here means config_broadcast never reached the boards (e.g. a
  // service unit wired to the hardware config instead of the sim overlay).
  assert(state.selfTestBoards.size > 0,
    `boards ran self-test (${state.selfTestBoards.size} boards: ${[...state.selfTestBoards].join(',') || 'none'})`);
  // The T7 came up with the session (sensor-t7 → t7_bridge --fake) and is calibrated.
  const t7Before = state.t7Updates;
  state.t7Last.clear();
  await waitUntil(() => state.t7Updates - t7Before > 10 && T7_EXPECT.every((e) => state.t7Last.has(e.key)), PIPELINE_DATA_TIMEOUT_MS);
  checkT7('run 1');

  // Auto-stop at the deadline; warnings should have fired before it.
  const remaining = Math.max(0, DURATION_MS - (Date.now() - startedAt));
  await waitFor(ws, 'session_update', remaining + 20000, (p) => p.active === false);
  assert(true, 'auto-stop fired (session inactive)');
  for (const key of EXPECTED_WARN_KEYS) {
    assert(state.warnKeys.has(key), `warning fired: ${key}`);
  }
  await sleep(500);
  assert(!existsSync(dbDir1), 'Discard removed the run DB dir');

  // ── Run 2: Save + extend → deadline moves out, dir persists on stop ────────
  console.log('\n▶ Run 2 — Save, extend, manual stop');
  const active2Promise = waitFor(ws, 'session_update', 10000, (p) => p.active === true);
  send(ws, 'send_command', { commandType: 'session_start', data: { keepData: true, durationMs: 600000, simulated: true } });
  const active2 = await active2Promise;
  const dbDir2: string = active2.dbDir;
  const deadline1: number = active2.deadlineMs;
  assert(active2.active === true && active2.keepData === true, 'session_start (Save) → active, keepData');

  // Data must flow AGAIN on the second run over the SAME long-lived WS connection.
  // Start/Stop run bounces elodin to a fresh DB without restarting the backend, so
  // a client that never reconnects must still receive the new run's data. (Regression
  // guard for the "no data after stop→start until manual reload" class of bug.)
  await waitFor(ws, 'connection_status', 30000, (p) => p.elodinConnected === true).catch(() => {});
  const before2 = state.sensorUpdates;
  await waitUntil(() => state.sensorUpdates - before2 > 50, PIPELINE_DATA_TIMEOUT_MS);
  const flowed2 = state.sensorUpdates - before2;
  assert(flowed2 > 50, `sensor data flowing after session restart (${flowed2} SENSOR_UPDATE within ${PIPELINE_DATA_TIMEOUT_MS / 1000}s, same WS connection)`);
  // The T7 again, on the restarted Elodin: its tables are created after the backend's and
  // calibration_service's subscriptions, so this fails if either stops renewing them.
  const t7Before2 = state.t7Updates;
  state.t7Last.clear();
  await waitUntil(() => state.t7Updates - t7Before2 > 10 && T7_EXPECT.every((e) => state.t7Last.has(e.key)), PIPELINE_DATA_TIMEOUT_MS);
  checkT7('run 2');
  // The run's sidecar config names the T7 and its channels, so the saved run decodes later.
  const sidecar = existsSync(`${dbDir2}.toml`) ? readFileSync(`${dbDir2}.toml`, 'utf-8') : '';
  assert(/\[boards\.labjack_1\][^[]*type\s*=\s*"T7"/.test(sidecar) && sidecar.includes('T7 Thrust LC'),
    `run sidecar ${dbDir2}.toml carries the T7 board and its channels`);

  const extendedPromise = waitFor(ws, 'session_update', 8000, (p) => p.active && p.deadlineMs > deadline1);
  send(ws, 'send_command', { commandType: 'session_extend', data: { addMs: 120000 } });
  const extended = await extendedPromise;
  assert(extended.deadlineMs >= deadline1 + 120000 - 50, `extend pushed deadline out (+${Math.round((extended.deadlineMs - deadline1) / 1000)}s)`);

  const stoppedPromise = waitFor(ws, 'session_update', 20000, (p) => p.active === false);
  send(ws, 'send_command', { commandType: 'session_stop', data: {} });
  await stoppedPromise;
  await sleep(500);
  assert(existsSync(dbDir2), 'Save kept the run DB dir after stop');
  // Test hygiene: remove the saved dir we created.
  try { rmSync(dbDir2, { recursive: true, force: true }); rmSync(`${dbDir2}_metadata`, { recursive: true, force: true }); rmSync(`${dbDir2}.toml`, { force: true }); } catch { /* ignore */ }

  ws.close();
  console.log(`\n${failed.length === 0 ? '✅ PASS' : '❌ FAIL'} — ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) { failed.forEach((f) => console.error(`   ✗ ${f}`)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('❌ session_flow_test error:', e?.message || e); process.exit(1); });
