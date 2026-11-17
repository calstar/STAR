/**
 * The scripted session the pipeline golden records. Drives a running stack (run.sh starts it) over
 * WebSocket and HTTP and writes everything it saw, raw, to a JSON capture; characterize.py turns
 * that into the goldens. Nothing here judges the backend — it only records.
 *
 *   tsx session.ts <ws_port> <capture.json> [pt|nocal|boards|stalesub|operator]
 *
 * pt: the full scripted session against the one routed PT board. boards: every simulated board
 * type streaming at once, plus the startup board's SETUP -> SELF_TEST lifecycle (board 60, played
 * by sim/board_startup_sim.py: BOARD_STARTUP_SIM, PYTHON_BIN, CHAR_DAQ_UDP_PORT, CHAR_STARTUP_PORT).
 * stalesub: run.sh has arranged the D-SUB window (README "The stalesub session"); this only watches
 * what PT board 22 delivers, channel by channel, live and from history. operator: one client whose
 * upgrade carries an X-Auth-Email that is in operators.txt (README "The operator session").
 *
 * Run from diablo_server/backend (NODE_PATH there) so `ws` resolves.
 */
import WebSocket from 'ws';
import * as fs from 'fs';
import * as http from 'http';
import { spawn } from 'child_process';

const PORT = parseInt(process.argv[2] ?? '', 10);
const OUT = process.argv[3];
const MODE = process.argv[4] ?? 'pt';
if (!PORT || !OUT) {
  console.error('usage: session.ts <ws_port> <capture.json>');
  process.exit(2);
}

interface Frame { client: string; t: number; raw: string }
interface Sent { client: string; t: number; raw: string }
interface HttpRec {
  method: string; path: string; reqHeaders: Record<string, string>; reqBody: string | null;
  status: number; headers: Record<string, string | string[] | undefined>; body: string;
}
interface Step { name: string; t0: number; t1: number; frames: Frame[]; sent: Sent[]; http: HttpRec[] }

const capture = { wsPort: PORT, steps: [] as Step[] };
let cur: Step | null = null;
const clients = new Map<string, WebSocket>();

function step(name: string): void {
  if (cur) cur.t1 = Date.now();
  cur = { name, t0: Date.now(), t1: 0, frames: [], sent: [], http: [] };
  capture.steps.push(cur);
  console.log(`[session] ${name}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STREAM_TYPES = new Set([
  'sensor_update', 'historical_data', 'connection_status', 'board_status_update', 'board_log',
]);
/** Event-like frames are what a step's golden records in order; streams are summarised. */
function isEvent(raw: string): boolean {
  try {
    const m = JSON.parse(raw);
    if (STREAM_TYPES.has(m.type)) return false;
    // Board-health notifications come from a 1 Hz sweep, not from the step (README P1).
    const key = String(m.payload?.key ?? '');
    if (m.type === 'notification' && (key.startsWith('board_lost_') || key.startsWith('setup_stuck_')
      || (!m.payload?.key && String(m.payload?.message ?? '').endsWith(' connected')))) return false;
    return true;
  } catch { return true; }
}
/** QUIET_MS: how long the event stream must be silent before a step may end. The slowest reply a
 *  step waits for is the sequencer's (TCP reply and its Elodin publish); 1.5 s is several times
 *  what it takes on an idle machine, so a loaded one still finishes the step inside the step. */
const QUIET_MS = 1500;
const SETTLE_CAP_MS = 20000;
async function settle(minMs: number): Promise<void> {
  const t0 = Date.now();
  await sleep(minMs);
  for (;;) {
    const evs = cur!.frames.filter((f) => isEvent(f.raw));
    const last = Math.max(t0, ...evs.map((f) => f.t), ...cur!.sent.map((x) => x.t));
    if (Date.now() - last >= QUIET_MS) return;
    if (Date.now() - t0 > SETTLE_CAP_MS) throw new Error(`step ${cur!.name} never went quiet`);
    await sleep(100);
  }
}

function openClient(name: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers });
    ws.on('message', (data) => {
      cur!.frames.push({ client: name, t: Date.now(), raw: data.toString() });
    });
    ws.once('open', () => { clients.set(name, ws); resolve(ws); });
    ws.once('error', reject);
  });
}

function send(name: string, obj: unknown): void {
  const raw = typeof obj === 'string' ? obj : JSON.stringify(obj);
  cur!.sent.push({ client: name, t: Date.now(), raw });
  clients.get(name)!.send(raw);
}

function command(name: string, commandType: string, data: Record<string, unknown> = {}): void {
  send(name, { type: 'send_command', payload: { commandType, data } });
}

function closeClient(name: string): Promise<void> {
  const ws = clients.get(name)!;
  return new Promise((resolve) => {
    ws.once('close', () => resolve());
    ws.close(1000, 'char done');
    clients.delete(name);
  });
}

function request(
  method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<HttpRec> {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) reqHeaders['Content-Type'] ??= 'application/json';
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: reqHeaders }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const rec: HttpRec = {
          method, path, reqHeaders: opts.headers ?? {}, reqBody: opts.body ?? null,
          status: res.statusCode ?? 0, headers: res.headers, body,
        };
        cur!.http.push(rec);
        resolve(rec);
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error(`timeout ${method} ${path}`)));
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const VIEWER = { 'X-Auth-Email': 'viewer@example.com' };
const OPERATOR = { 'X-Auth-Email': 'operator@example.com' };

/** Every GET the backend registers (server.ts, api-server.ts, video/routes.ts), plus the error
 *  shapes reachable without changing anything. Run before and during a session. */
async function getSweep(): Promise<void> {
  const gets = [
    '/stats',
    '/api/config', '/api/config/running', '/api/config/export', '/api/config/validate',
    '/api/config/profiles',
    '/api/states',
    '/api/state-csv?name=actuators', '/api/state-csv?name=delays', '/api/state-csv?name=transitions',
    '/api/state-csv?name=bogus', '/api/state-csv',
    '/api/state-script', '/api/state-script?name=missing.script',
    '/api/query', '/api/pressure-limits', '/api/gui-config', '/api/sensor-config',
    '/api/sensors', '/api/sensors/PT1.CH1',
    '/api/board-logs', '/api/board-logs?board=21&limit=5', '/api/board-logs/stats',
    '/api/debug', '/api/engine_state', '/api/calibration_status', '/api/cubic_calibration',
    '/api/ball_valve_cal', '/api/lc_tare', '/api/feed-char/results', '/api/calibration_profiles',
    '/api/config_packets', '/api/ota-flash/projects',
    '/api/video/streams', '/api/video/config', '/api/video/recordings',
    '/api/video/streams/nope/check', '/api/video/streams/nope/whep', '/api/video/nope',
  ];
  for (const p of gets) await request('GET', p);
}

/** Wait until the pipeline delivers: a probe client sees a raw and a calibrated PT sample. */
async function waitForData(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const seen = { raw: false, cal: false };
  const probe = new WebSocket(`ws://127.0.0.1:${PORT}`);
  probe.on('message', (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.type !== 'sensor_update') return;
      const e = String(m.payload?.entity ?? '');
      if (/^PT\d+\.CH\d+$/.test(e)) seen.raw = true;
      if (/^PT\d+_Cal\.CH\d+$/.test(e)) seen.cal = true;
    } catch { /* ignore */ }
  });
  while (Date.now() < deadline && !(seen.raw && seen.cal)) await sleep(200);
  probe.close();
  if (!(seen.raw && seen.cal)) throw new Error(`pipeline not delivering (raw=${seen.raw} cal=${seen.cal})`);
}

async function main(): Promise<void> {
  step('readiness');
  await waitForData(60000);
  // Let calibration_service's seeding, the envelope windows and the sequencer's first publish settle.
  await sleep(3000);

  step('http_before_session');
  await getSweep();

  step('connect');
  await openClient('A');
  await settle(2500);

  step('live');
  await sleep(3000);

  step('viewer_client');
  await openClient('B', VIEWER);
  await settle(1500);
  send('B', { type: 'control_unlock', payload: {} });
  await settle(400);
  command('B', 'state_transition', { state: 2 });
  await settle(600);
  await closeClient('B');
  await settle(300);

  step('subscribe');
  // The thin backend has no subscription protocol: every client gets everything. An unknown
  // message type is logged and dropped, with no reply.
  send('A', { type: 'subscribe', payload: { keys: ['PT1.CH1.raw_adc_counts'] } });
  send('A', 'not json');
  send('A', { type: 'get_state_transitions' });
  await settle(1000);

  step('history');
  send('A', { type: 'query_historical', payload: { keys: ['PT1.CH1.raw_adc_counts'], sinceMs: Date.now() - 10000 } });
  await settle(700);
  send('A', { type: 'query_historical', payload: { keys: ['NO_SUCH.KEY.value'] } });
  await settle(700);
  send('A', { type: 'query_historical', payload: { sinceMs: Date.now() + 3_600_000 } });
  await settle(700);
  send('A', { type: 'query_historical', payload: {} });
  await settle(1500);

  step('control_locked');
  command('A', 'state_transition', { state: 2 });
  command('A', 'actuator', { actuatorName: 'Fuel Vent', actuatorState: 1 });
  await settle(600);

  step('unlock');
  send('A', { type: 'control_unlock', payload: {} });
  await settle(600);

  step('transition_rejected_locally');
  command('A', 'state_transition', { state: 99 });
  command('A', 'state_transition', { state: 2, holdMs: -5 });
  await settle(800);

  step('transition_refused_by_sequencer');
  command('A', 'state_transition', { state: 16 });
  await settle(1500);

  step('transition_armed');
  command('A', 'state_transition', { state: 2 });
  await settle(2500);

  step('debug_on');
  command('A', 'debug_mode', { debugMode: true });
  await settle(1200);

  step('actuator_open_close');
  command('A', 'actuator', { actuatorName: 'Fuel Vent', actuatorState: 1 });
  await settle(1200);
  command('A', 'actuator', { actuatorName: 'Fuel Vent', actuatorState: 0 });
  await settle(1200);
  command('A', 'actuator', { actuatorName: 'No Such Valve', actuatorState: 1 });
  await settle(1000);

  step('debug_off');
  command('A', 'debug_mode', { debugMode: false });
  await settle(1200);

  step('extend_fire_not_firing');
  command('A', 'extend_fire');
  await settle(1000);

  step('transition_idle');
  command('A', 'state_transition', { state: 1 });
  await settle(2500);

  step('countdown');
  command('A', 'set_countdown_target', { targetTimeMs: 4102444000000 });
  await settle(500);
  command('A', 'set_countdown_target', { targetTimeMs: null });
  await settle(500);

  step('calibration_command');
  send('A', { type: 'calibration_command', payload: { commandType: 'char_probe' } });
  await settle(600);

  step('unsupported_command');
  command('A', 'controller_frequency', { frequency: 10 });
  await settle(600);

  step('session_start_blocked');
  command('A', 'session_start', { keepData: true, durationMs: 600000 });
  await settle(2000);

  step('session_start_forced');
  command('A', 'session_start', { keepData: true, durationMs: 600000, force: true });
  await settle(3000);

  step('session_start_again');
  command('A', 'session_start', { keepData: true, durationMs: 600000, force: true });
  await settle(800);

  step('http_during_session');
  await getSweep();
  await request('POST', '/api/feed-char/results', { body: JSON.stringify({ cda: 1.5 }) });
  await request('POST', '/api/config/profiles/switch', { body: JSON.stringify({ name: 'default' }) });

  step('http_viewer_gates');
  // H8 (DESIGN-WP7 §7): every operator gate api-server.ts has, as the viewer (a signed-in email
  // that is not in operators.txt). The six gates http_errors freezes stay there; these are the
  // other eight, in the file's order. Each body would be accepted from an operator, so a dropped
  // gate shows as a 200 and a changed file, not as a 400. During the session on purpose:
  // /api/feed-char/results answers 409 without one before it reaches its gate, and a session is
  // when a stray write would matter most. The GETs after are the witnesses that nothing changed.
  await request('POST', '/api/state-script?name=viewer.script&state=Idle', { headers: VIEWER, body: 'delay(1)' });
  await request('POST', '/api/config/profiles/create', { headers: VIEWER, body: JSON.stringify({ name: 'viewer-made' }) });
  await request('POST', '/api/config/profiles/rename', { headers: VIEWER, body: JSON.stringify({ name: 'default', newName: 'viewer-renamed' }) });
  await request('POST', '/api/config/profiles/delete', { headers: VIEWER, body: JSON.stringify({ name: 'default' }) });
  await request('POST', '/api/ball_valve_cal', { headers: VIEWER, body: JSON.stringify({ entity: 'BV1_Cal.CH1', action: 'clear' }) });
  await request('POST', '/api/feed-char/results', { headers: VIEWER, body: JSON.stringify({ cda: 1.5 }) });
  await request('POST', '/api/calibration_profiles/load', { headers: VIEWER, body: JSON.stringify({ name: 'default' }) });
  await request('POST', '/api/calibration_profiles/new_blank', { headers: VIEWER, body: JSON.stringify({ name: 'viewer-blank' }) });
  await request('GET', '/api/config/profiles');
  await request('GET', '/api/state-script?name=viewer.script');
  await request('GET', '/api/ball_valve_cal');
  await request('GET', '/api/feed-char/results');
  await request('GET', '/api/calibration_profiles');

  step('session_extend');
  command('A', 'session_extend', { addMs: 60000 });
  await settle(600);
  command('A', 'session_extend', { addMs: -1 });
  await settle(600);

  step('session_stop');
  command('A', 'session_stop');
  await settle(2500);

  step('session_stop_idle');
  command('A', 'session_stop');
  command('A', 'session_extend', { addMs: 1000 });
  await settle(800);

  step('late_client');
  // A client that connects after the session: what the backend replays to it -- the notification
  // buffer (session warnings cleared at start/extend/stop) and the self-test results.
  await openClient('C');
  await settle(1500);
  await closeClient('C');
  await settle(300);

  step('http_errors');
  await request('GET', '/nope');
  await request('GET', '/');
  await request('OPTIONS', '/api/config');
  await request('PUT', '/api/config', { body: '{}' });
  await request('DELETE', '/api/states');
  await request('POST', '/api/config', { headers: VIEWER, body: JSON.stringify({ config: {} }) });
  await request('POST', '/api/config/import', { headers: VIEWER, body: 'x = 1' });
  await request('POST', '/api/state-csv?name=actuators', { headers: VIEWER, body: 'a,b' });
  await request('POST', '/api/state-csv?name=actuators', { headers: OPERATOR, body: '' });
  await request('POST', '/api/state-csv?name=bogus', { body: 'a,b\n1,2' });
  await request('POST', '/api/state-script', { body: 'delay(1)' });
  await request('POST', '/api/state-script/check', { body: 'delay(1)' });
  await request('POST', '/api/config/profiles/switch', { headers: VIEWER, body: '{}' });
  await request('POST', '/api/config/profiles/switch', { body: JSON.stringify({ name: 'no-such-profile' }) });
  await request('POST', '/api/config/profiles/create', { body: JSON.stringify({ name: 'bad name!' }) });
  await request('POST', '/api/config/profiles/rename', { body: JSON.stringify({ name: 'missing', newName: 'x' }) });
  await request('POST', '/api/config/profiles/delete', { body: JSON.stringify({ name: 'missing' }) });
  await request('POST', '/api/board-log-mode', { body: JSON.stringify({ boardId: 0, mode: 9 }) });
  await request('POST', '/api/board-log-mode', { headers: VIEWER, body: '{}' });
  await request('POST', '/api/ball_valve_cal', { body: JSON.stringify({ entity: 'BV1_Cal.CH1', action: 'sideways' }) });
  await request('POST', '/api/ball_valve_cal', { body: JSON.stringify({ entity: 'BV1_Cal.CH1', action: 'open' }) });
  await request('POST', '/api/feed-char/results', { body: JSON.stringify({ cda: 1.5 }) });
  await request('PUT', '/api/feed-char/results', { body: '{}' });
  await request('POST', '/api/calibration_profiles/save', { headers: VIEWER, body: '{}' });
  await request('POST', '/api/ota-flash', { body: JSON.stringify({}) });
  await request('POST', '/api/ota-flash', { body: JSON.stringify({ ip: '127.0.0.1', port: 1 , projectPath: 'x' }) });
  await request('PUT', '/api/video/config', { body: JSON.stringify({ streams: 'nope' }) });
  await request('POST', '/api/video/previews', { body: JSON.stringify({ url: 'not-a-url' }) });
  await request('DELETE', '/api/video/previews/nope');

  step('disconnect');
  await closeClient('A');
  await settle(500);
  cur!.t1 = Date.now();

  fs.writeFileSync(OUT, JSON.stringify(capture));
  console.log(`[session] wrote ${OUT}`);
}

/** Every board type at once: the per-type frame shapes and channel sets, the board/sensor HTTP
 *  endpoints, and one board's whole status lifecycle (SETUP, SELF_TEST, ACTIVE, lost). */
async function boards(): Promise<void> {
  step('readiness');
  await waitForData(60000);
  await sleep(5000);

  const sweep = async () => {
    for (const p of [
      '/stats', '/api/debug', '/api/sensor-config', '/api/config/validate', '/api/gui-config',
      '/api/pressure-limits', '/api/ball_valve_cal', '/api/lc_tare', '/api/board-logs',
      '/api/board-logs/stats', '/api/engine_state',
    ]) await request('GET', p);
  };
  step('http_boards');
  await sweep();

  step('connect');
  await openClient('A');
  await sleep(2500);

  step('live');
  await sleep(5000);

  step('startup_board');
  const code = await new Promise<number>((resolve) => {
    const p = spawn(process.env.PYTHON_BIN || 'python3', [
      process.env.BOARD_STARTUP_SIM!, '--listen-port', process.env.CHAR_STARTUP_PORT!,
      '--daq-port', process.env.CHAR_DAQ_UDP_PORT!, '--board-ip', '127.0.0.60', '--board-id', '60',
      '--timeout-s', '30',
    ], { stdio: 'ignore' });
    p.on('exit', (c) => resolve(c ?? -1));
  });
  if (code !== 0) throw new Error(`board_startup_sim exited ${code}`);
  // Long enough for the board's heartbeat to go stale (5 s) and the sweep to say so.
  await sleep(8000);

  step('http_after_startup');
  await sweep();

  step('disconnect');
  await closeClient('A');
  await sleep(500);
  cur!.t1 = Date.now();
  fs.writeFileSync(OUT, JSON.stringify(capture));
  console.log(`[session] wrote ${OUT}`);
}

/** The backend with no PT calibration file of its own: what calibration_status, the calibration
 *  command reply and the cubic store look like then. The pt session is the file-present case. */
async function nocal(): Promise<void> {
  step('readiness');
  await waitForData(60000);
  await sleep(3000);

  step('http_calibration');
  for (const p of ['/api/calibration_status', '/api/cubic_calibration', '/api/calibration_profiles', '/api/lc_tare'])
    await request('GET', p);

  step('connect');
  await openClient('A');
  await settle(2500);

  step('calibration_command');
  send('A', { type: 'calibration_command', payload: { commandType: 'char_probe' } });
  await settle(600);

  step('disconnect');
  await closeClient('A');
  await settle(500);
  cur!.t1 = Date.now();
  fs.writeFileSync(OUT, JSON.stringify(capture));
  console.log(`[session] wrote ${OUT}`);
}

/** The D-SUB window, arranged by run.sh: the backend's VTableStream for [0x20,0x31] was accepted
 *  while that table was PT10_Cal.CH1 and the table has since been re-registered as PT2_Cal.CH1.
 *  Watch PT board 22 for 2 x RESUBSCRIBE_MIN_MS (server.ts, 5000) + 2 s from the moment its
 *  untouched channel 2 first arrives calibrated: two resubscribe passes have run by then, so a
 *  backend that re-sent a silent pair would have had its chance. Then history, both ways. */
async function stalesub(): Promise<void> {
  step('readiness');
  const deadline = Date.now() + 60000;
  let seen = false;
  const probe = new WebSocket(`ws://127.0.0.1:${PORT}`);
  probe.on('message', (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.type === 'sensor_update' && m.payload?.entity === 'PT2_Cal.CH2') seen = true;
    } catch { /* ignore */ }
  });
  while (Date.now() < deadline && !seen) await sleep(100);
  probe.close();
  if (!seen) throw new Error('pipeline not delivering PT2_Cal.CH2 (the control channel)');

  step('connect');
  await openClient('A');
  await sleep(2 * 5000 + 2000);

  step('history');
  send('A', { type: 'query_historical', payload: {
    keys: ['PT2.CH1.raw_adc_counts', 'PT2_Cal.CH1.pressure_psi', 'PT2_Cal.CH2.pressure_psi'],
    sinceMs: Date.now() - 12000,
  } });
  await settle(1500);

  step('disconnect');
  await closeClient('A');
  await settle(500);
  cur!.t1 = Date.now();
  fs.writeFileSync(OUT, JSON.stringify(capture));
  console.log(`[session] wrote ${OUT}`);
}

/** The WS operator allowlist's positive half (H8b, LEDGER D84): a client whose upgrade request
 *  carries an X-Auth-Email that IS in operators.txt. server.ts reads the header at the upgrade and
 *  answers control_status with operator:true and the email; its control_unlock is then ok. The pt
 *  session freezes the other two cases (no header: operator:true, email null; a viewer: operator:
 *  false, not_operator) but never this one, so a backend that made every non-empty header a
 *  viewer stayed green. Its own session, so the pt goldens (ws_streams.txt's P12 "paths checked"
 *  line counts every client's handshake) keep every line. Nothing is commanded: the unlock's
 *  reply is the observable, and a transition would move the sequencer. */
async function operator(): Promise<void> {
  step('readiness');
  await waitForData(60000);
  await sleep(3000);

  step('connect');
  await openClient('A', OPERATOR);
  await settle(2500);

  step('unlock');
  send('A', { type: 'control_unlock', payload: {} });
  await settle(600);

  step('disconnect');
  await closeClient('A');
  await settle(500);
  cur!.t1 = Date.now();
  fs.writeFileSync(OUT, JSON.stringify(capture));
  console.log(`[session] wrote ${OUT}`);
}

(MODE === 'boards' ? boards() : MODE === 'nocal' ? nocal() : MODE === 'stalesub' ? stalesub() : MODE === 'operator' ? operator() : main()).then(() => process.exit(0)).catch((err) => {
  console.error('[session] FAILED:', err);
  try { fs.writeFileSync(OUT, JSON.stringify(capture)); } catch { /* best effort */ }
  process.exit(1);
});
