/**
 * The scripted session the pipeline golden records. Drives a running stack (run.sh starts it) over
 * WebSocket and HTTP and writes everything it saw, raw, to a JSON capture; characterize.py turns
 * that into the goldens. Nothing here judges the backend — it only records.
 *
 *   tsx session.ts <ws_port> <capture.json> [pt|nocal|boards|stalesub|operator|holds|selftest|unrecognized|mismatch|statecsv]
 *
 * pt: the full scripted session against the one routed PT board. boards: every simulated board
 * type streaming at once, plus the startup board's SETUP -> SELF_TEST lifecycle (board 60, played
 * by sim/board_startup_sim.py: BOARD_STARTUP_SIM, PYTHON_BIN, CHAR_DAQ_UDP_PORT, CHAR_STARTUP_PORT).
 * stalesub: run.sh has arranged the D-SUB window (README "The stalesub session"); this only watches
 * what PT board 22 delivers, channel by channel, live and from history. operator: one client whose
 * upgrade carries an X-Auth-Email that is in operators.txt (README "The operator session").
 * what PT board 22 delivers, channel by channel, live and from history. holds: one accepted timed
 * hold, then the sequencer stalled (SIGSTOP) and gone (SIGTERM) under the backend's :9998 client;
 * run.sh hands over the sequencer's PID in <CHAR_FIXTURE>/ports.json (README "The holds session").
 * selftest, unrecognized, mismatch: the three WP6 gaps (DESIGN-WP6 §7 G2, G3, G1), each a session
 * cut to its one notification; statecsv: G8, an idle-mode state-CSV deploy and what the next client
 * is handed (README "The WP6 gap sessions").
 *
 * Run from diablo_server/backend (NODE_PATH there) so `ws` resolves.
 */
import WebSocket from 'ws';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
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
/** `notes`: lines the session itself derives from its own stamps (a bound met or not), printed
 *  under the step in ws_events.txt (characterize.py P13). Categorical only -- never a raw ms. */
/** A file of the fixture read at this point of the step (H1: what a write left on disk). */
interface FileRec { file: string; content: string | null }
interface Step { name: string; t0: number; t1: number; frames: Frame[]; sent: Sent[]; http: (HttpRec | FileRec)[]; notes: string[] }

const capture = { wsPort: PORT, steps: [] as Step[] };
let cur: Step | null = null;
const clients = new Map<string, WebSocket>();

function step(name: string): void {
  if (cur) cur.t1 = Date.now();
  cur = { name, t0: Date.now(), t1: 0, frames: [], sent: [], http: [], notes: [] };
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

/** Record a fixture file as it is right now, in order with the requests around it. */
function file(rel: string): void {
  const abs = `${process.env.CHAR_FIXTURE}/${rel}`;
  cur!.http.push({ file: rel, content: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null });
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
    '/api/debug', '/api/debug?values', '/api/engine_state', '/api/calibration_status', '/api/cubic_calibration',
    '/api/ball_valve_cal', '/api/lc_tare', '/api/feed-char/results', '/api/calibration_profiles',
    '/api/config_packets', '/api/ota-flash/projects',
    '/api/video/streams', '/api/video/config', '/api/video/recordings',
    '/api/video/streams/nope/check', '/api/video/streams/nope/whep', '/api/video/nope',
  ];
  for (const p of gets) await request('GET', p);
}

/** Wait until the pipeline delivers: a probe client sees a raw and a calibrated PT sample.
 *  `boards` / `selfTestBoard` (the WP6 gap sessions): the same probe also waits, bounded by
 *  `extraMs`, until the backend lists each of those boards connected (a `board_status_update`)
 *  and, for `selfTestBoard`, has its self-test (`SELF_TEST.BOARD_<id>.*`, replayed or live). The
 *  heartbeat and self-test tables are later subscription passes than the PT tables, and on a
 *  loaded Linux leg they went live ~3 s after the PT data: a client connecting on PT data alone
 *  saw a board list without 21 and no replay, and the one-shot self-test landed live in a later
 *  step. One probe for all of it, so client A's connId is c2 in every session. On timeout the
 *  session goes on and the golden shows what was missing. */
async function waitForData(
  timeoutMs: number, boards: number[] = [], selfTestBoard?: number, extraMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const seen = { raw: false, cal: false, st: selfTestBoard === undefined };
  const connected = new Set<number>();
  const probe = new WebSocket(`ws://127.0.0.1:${PORT}`);
  probe.on('message', (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.type === 'board_status_update') {
        for (const b of m.payload?.boards ?? []) if (b.connected === true) connected.add(b.id);
        return;
      }
      if (m.type !== 'sensor_update') return;
      const e = String(m.payload?.entity ?? '');
      if (/^PT\d+\.CH\d+$/.test(e)) seen.raw = true;
      if (/^PT\d+_Cal\.CH\d+$/.test(e)) seen.cal = true;
      if (selfTestBoard !== undefined && e === `SELF_TEST.BOARD_${selfTestBoard}`) seen.st = true;
    } catch { /* ignore */ }
  });
  while (Date.now() < deadline && !(seen.raw && seen.cal)) await sleep(200);
  const ready = () => seen.st && boards.every((b) => connected.has(b));
  const extraBy = Date.now() + extraMs;
  while (Date.now() < extraBy && !ready()) await sleep(200);
  probe.close();
  if (!(seen.raw && seen.cal)) throw new Error(`pipeline not delivering (raw=${seen.raw} cal=${seen.cal})`);
  if (!ready()) console.log(`[session] boards ${boards} / self-test ${selfTestBoard} not ready within ${extraMs} ms`);
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
  // G10 (DESIGN-WP6 §7): a well-formed message whose handler throws -- send_command with no payload
  // -- is caught at the WS boundary ("Bad message" log) and gets no reply either.
  send('A', { type: 'send_command' });
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
  // SEC-8 / SEC-5: the countdown target and a calibration write are control actions too; an
  // unarmed socket gets `Control locked` and nothing reaches the countdown or calibration_service.
  command('A', 'set_countdown_target', { targetTimeMs: 4102444000000 });
  send('A', { type: 'calibration_command', payload: { commandType: 'zero_all' } });
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
  // D64(3): the HTTP view of the state the WS path just reached (engineState 2, not the sweep's
  // 1), and /api/debug at value level (P13) with a client connected and ingest flowing.
  await request('GET', '/api/engine_state');
  await request('GET', '/api/debug?values');

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

  step('http_operator_writes');
  // H1 (DESIGN-WP7 §7, with WP6 G7): the success path of every write an operator makes while
  // idle. http_errors and http_viewer_gates reach these routes only as the viewer or with a body
  // that is refused; here each gets the operator and a body it accepts, so what is frozen is the
  // status and body, the files the write left in the fixture's config/ tree (FILE lines: the
  // deployed copy and the profile's), and the frames that follow — config_updated in
  // ws_events.txt, board_status_update in ws_streams.txt. Idle on purpose: only an idle write
  // deploys and fires its callback. Last on purpose: nothing after it reads what it changed.
  const active = JSON.parse((await request('GET', '/api/config')).body).config;
  await request('POST', '/api/config', { headers: OPERATOR, body: JSON.stringify({ config: { ...active, char: { h1_save: 1 } } }) });
  await settle(1500);
  file('config/config.toml');
  file('config/profiles/default/config.toml');
  const deployed = fs.readFileSync(`${process.env.CHAR_FIXTURE}/config/config.toml`, 'utf8');
  await request('POST', '/api/config/import', { headers: OPERATOR, body: `${deployed}\n[char_import]\nh1 = 1\n` });
  await settle(1500);
  file('config/config.toml');
  file('config/profiles/default/config.toml');
  // An upload that does not parse: 400, and the profile is rolled back to what it was.
  await request('POST', '/api/config/import', { headers: OPERATOR, body: 'x = [' });
  await settle(800);
  file('config/profiles/default/config.toml');
  const csv = fs.readFileSync(`${process.env.CHAR_FIXTURE}/config/profiles/default/state_machine_actuators.csv`, 'utf8');
  await request('POST', '/api/state-csv?name=actuators', { headers: OPERATOR, body: csv.split('\n').slice(0, 3).join('\n') + '\n' });
  await settle(1500);
  file('config/state_machine_actuators.csv');
  file('config/profiles/default/state_machine_actuators.csv');
  await request('GET', '/api/state-csv?name=actuators');
  await request('POST', '/api/state-script?name=h1.script&state=Idle', { headers: OPERATOR, body: 'delay(1)' });
  await settle(800);
  file('config/scripts/h1.script');
  file('config/profiles/default/scripts/h1.script');
  await request('GET', '/api/state-script?name=h1.script');
  await request('GET', '/api/state-script');
  await request('POST', '/api/config/profiles/create', { headers: OPERATOR, body: JSON.stringify({ name: 'h1' }) });
  await settle(800);
  file('config/profiles/h1/config.toml');
  await request('POST', '/api/config/profiles/rename', { headers: OPERATOR, body: JSON.stringify({ name: 'h1', newName: 'h1b' }) });
  await settle(800);
  file('config/profiles/h1/config.toml');
  file('config/profiles/h1b/config.toml');
  await request('POST', '/api/config/profiles/switch', { headers: OPERATOR, body: JSON.stringify({ name: 'h1b' }) });
  await settle(1500);
  file('config/.active_profile');
  file('config/config.toml');
  await request('POST', '/api/config/profiles/switch', { headers: OPERATOR, body: JSON.stringify({ name: 'default' }) });
  await settle(1500);
  file('config/.active_profile');
  await request('POST', '/api/config/profiles/delete', { headers: OPERATOR, body: JSON.stringify({ name: 'h1b' }) });
  await settle(800);
  file('config/profiles/h1b/config.toml');
  await request('GET', '/api/config/profiles');
  await request('POST', '/api/calibration_profiles/save', { headers: OPERATOR, body: JSON.stringify({ name: 'h1cal' }) });
  await settle(800);
  await request('GET', '/api/calibration_profiles');

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
  // The startup board's lifecycle is made deterministic by holding SENSOR_CONFIG back until it
  // has been reported stuck in SETUP (server.ts: >4 s in SETUP), and only then starting
  // config_broadcast_service. Left running from the start, whether "stuck in setup" fired at all
  // depended on where in its 1.5 s cycle the board appeared.
  const exited = new Promise<number>((resolve) => {
    const p = spawn(process.env.PYTHON_BIN || 'python3', [
      process.env.BOARD_STARTUP_SIM!, '--listen-port', process.env.CHAR_STARTUP_PORT!,
      '--daq-port', process.env.CHAR_DAQ_UDP_PORT!, '--board-ip', '127.0.0.60', '--board-id', '60',
      '--timeout-s', '30',
    ], { stdio: 'ignore' });
    p.on('exit', (c) => resolve(c ?? -1));
  });
  const stuckBy = Date.now() + 20000;
  const isStuck = (f: Frame) => {
    try {
      const m = JSON.parse(f.raw);
      return m.type === 'notification' && m.payload?.key === 'setup_stuck_60' && m.payload?.ongoing === true;
    } catch { return false; }
  };
  while (!cur!.frames.some(isStuck)) {
    if (Date.now() > stuckBy) throw new Error('board 60 never reported stuck in setup');
    await sleep(100);
  }
  const cb = spawn(process.env.CHAR_CONFIG_BROADCAST!, [
    '--config', process.env.CHAR_CONFIG!, '--interval-ms', '1500',
  ], { cwd: process.env.CHAR_FIXTURE!, stdio: 'ignore' });
  fs.writeFileSync(`${process.env.CHAR_FIXTURE}/config_broadcast.pid`, String(cb.pid));
  const code = await exited;
  if (code !== 0) throw new Error(`board_startup_sim exited ${code}`);
  // Long enough for the board's heartbeat to go stale (5 s) and the sweep to say so.
  await sleep(8000);
  cb.kill('SIGTERM');

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

/** The :9998 line client's three replies that no other session takes (DESIGN-WP5 §6 G4, LEDGER
 *  D70). Accepted hold: `state_transition {state: 21, holdMs: 800}` into the fixture's Flow Test
 *  (run.sh holds) is answered `OK:<ms>` -- no error frame, the state_update into 21 and, after the
 *  800 ms hold plus the gate's 0.4 s stagger, the auto-return to Press Standby. Stalled: with the
 *  sequencer SIGSTOPped a self-transition on the hub (Press Standby -> Press Standby; the diagonal
 *  is 1, so the line changes no state when it is finally read) gets the warning `State
 *  transition: no reply from the sequencer within 5 s -- state unknown, resyncing ...` and a
 *  state_update re-broadcast after the client's 5000 ms overall deadline -- bounded here at 5.8 s
 *  (D34's macOS timer overshoot fits; a 6000 ms deadline does not), as a per-step note; then
 *  SIGCONT. The resumed sequencer finds the line in its socket buffer with the sender already
 *  gone and does not run it (D-LATE, #234): the second note says whether any state_update
 *  arrived after the resume (a transition the operator was told about running late).
 *  Down: SIGTERM, wait until :9998 refuses, then the same transition -> `connect ECONNREFUSED`,
 *  and a `debug_mode` whose failure has no reply at all. Nothing else, so a change elsewhere in
 *  the WS/HTTP surface cannot fail this golden. */
async function holds(): Promise<void> {
  const ports = JSON.parse(fs.readFileSync(`${process.env.CHAR_FIXTURE}/ports.json`, 'utf8'));
  const seqPid: number = ports.sequencer_pid;
  const seqPort: number = ports.sequencer;
  if (!Number.isInteger(seqPid) || !Number.isInteger(seqPort)) throw new Error('ports.json lacks sequencer_pid / sequencer');
  const TIMEOUT_BOUND_MS = 5800;

  step('readiness');
  await waitForData(60000);
  await sleep(3000);

  step('connect');
  await openClient('A', OPERATOR);
  await settle(2500);

  step('unlock');
  send('A', { type: 'control_unlock', payload: {} });
  await settle(600);

  step('park_on_hub');
  // Idle -> Armed -> Press Standby: the transitions CSV's only route to the hub Flow Test hangs off.
  command('A', 'state_transition', { state: 2 });
  await settle(2500);
  command('A', 'state_transition', { state: 20 });
  await settle(2500);

  step('hold_accepted');
  command('A', 'state_transition', { state: 21, holdMs: 800 });
  await settle(2500);

  step('sequencer_stalled');
  process.kill(seqPid, 'SIGSTOP');
  command('A', 'state_transition', { state: 20 });
  const sentAt = cur!.sent[cur!.sent.length - 1].t;
  const isTimeoutError = (f: Frame) => {
    try {
      const m = JSON.parse(f.raw);
      return m.type === 'notification' && String(m.payload?.message ?? '').includes('state unknown, resyncing');
    } catch { return false; }
  };
  // Wait for the reply itself (bounded well past the bound) rather than for quiet, so the note
  // judges the reply's arrival and not the end of the step.
  const replyBy = Date.now() + 10000;
  while (!cur!.frames.some(isTimeoutError) && Date.now() < replyBy) await sleep(50);
  const reply = cur!.frames.find(isTimeoutError);
  cur!.notes.push(`timeout_reply_within_${TIMEOUT_BOUND_MS}ms: ${reply && reply.t - sentAt <= TIMEOUT_BOUND_MS ? 'yes' : 'no'}`);
  process.kill(seqPid, 'SIGCONT');
  const resumedAt = Date.now();
  await settle(2500);
  const isStateUpdate = (f: Frame) => {
    try { return JSON.parse(f.raw).type === 'state_update'; } catch { return false; }
  };
  const late = cur!.frames.some((f) => isStateUpdate(f) && f.t >= resumedAt);
  cur!.notes.push(`late_transition_after_resume: ${late ? 'yes' : 'no'}`);

  step('sequencer_down');
  process.kill(seqPid, 'SIGTERM');
  // The sequencer is run.sh's child, so after it exits it is a zombie until run.sh reaps it and
  // a signal-0 probe would keep succeeding: wait for its port to refuse instead, which is the
  // precondition this half records.
  const refusedBy = Date.now() + 15000;
  for (;;) {
    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: seqPort });
      s.once('connect', () => { s.destroy(); resolve(false); });
      s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED'));
    });
    if (refused) break;
    if (Date.now() > refusedBy) throw new Error('sequencer still listening 15 s after SIGTERM');
    await sleep(100);
  }
  command('A', 'state_transition', { state: 20 });
  await settle(1000);
  command('A', 'debug_mode', { debugMode: true });
  await settle(1000);

  step('disconnect');
  await closeClient('A');
  await settle(500);
  cur!.t1 = Date.now();
  fs.writeFileSync(OUT, JSON.stringify(capture));
  console.log(`[session] wrote ${OUT}`);
}


/** Wait (bounded) for a frame of client `name` that `pred` accepts; the frame, or undefined. */
async function waitForFrame(name: string, pred: (m: any) => boolean, boundMs: number): Promise<Frame | undefined> {
  const by = Date.now() + boundMs;
  const match = (f: Frame) => {
    if (f.client !== name) return false;
    try { return pred(JSON.parse(f.raw)); } catch { return false; }
  };
  while (Date.now() < by) {
    const f = capture.steps.flatMap((s) => s.frames).find(match);
    if (f) return f;
    await sleep(100);
  }
  return undefined;
}
const notificationWith = (key: string, ongoing: boolean) => (m: any) =>
  m.type === 'notification' && m.payload?.key === key && m.payload?.ongoing === ongoing;

/** G2 (DESIGN-WP6 §7): run.sh started the simulator with --fail-connector 21:3, so pt_board's
 *  one-shot SELF_TEST carries sensor_3 = 0. The backend raises `self_test_fail_21` once (the
 *  `break` after the first failing row) during readiness; client A's connect burst freezes the
 *  self-test replay with the 0 (ws_streams.txt P12, expected from selftest_expected.py --fail) and
 *  the notification replay; the unnarrowed history query freezes the series. Nothing else. */
async function selftest(): Promise<void> {
  step('readiness');
  await waitForData(60000, [21], 21);
  await sleep(3000);

  step('connect');
  await openClient('A');
  await settle(2500);

  step('history');
  send('A', { type: 'query_historical', payload: {} });
  await settle(1500);

  step('disconnect');
  await closeClient('A');
  await settle(500);
  cur!.t1 = Date.now();
  fs.writeFileSync(OUT, JSON.stringify(capture));
  console.log(`[session] wrote ${OUT}`);
}

/** G3 (DESIGN-WP6 §7): the backend read a config in which pt_board's id is spelled `id = 21`
 *  (make_fixture.py config_backend/): the registry subscribes to board 21's tables (its data
 *  flows -- readiness needs it) but loadBoardsFromConfig never listed it, so its first heartbeat
 *  creates it `expected: false` at the backend's invented `192.168.2.21`, and the next 1 Hz sweep
 *  raises `unrecognized_21`. All during readiness: client A's burst freezes the board list and the
 *  notification replay. WS only -- the HTTP routes read board_id too, and their shapes for a board
 *  without one are not what this session is for. */
async function unrecognized(): Promise<void> {
  step('readiness');
  await waitForData(60000, [21]);
  await sleep(3000);

  step('connect');
  await openClient('A');
  await settle(2500);

  step('disconnect');
  await closeClient('A');
  await settle(500);
  cur!.t1 = Date.now();
  fs.writeFileSync(OUT, JSON.stringify(capture));
  console.log(`[session] wrote ${OUT}`);
}

/** G1 (DESIGN-WP6 §7, LEDGER D48): the actuator-mismatch check, which no other golden ever
 *  fires. The fixture names the ball valve ("Main Ball Valve" = ["NC", 1, 71], CLOSE in every
 *  state; make_fixture.py mismatch), and a ball valve is the one actuator the simulated stack
 *  reports a sensed position for (BV1_Cal.CH1.position_pct -> sensed BV1.CH1, ball-valve.ts).
 *  Unlock -> debug on -> open the valve -> wait out its 3 s travel (board_simulator.py
 *  BALL_VALVE_TRAVEL_S) -> debug on AGAIN: doSetDebugMode(true) publishes state without clearing
 *  overrides (SequencerService.cpp), which is what schedules the backend's 5 s check ->
 *  `actuator_mismatch` ongoing:true "… BV1.CH1 (expected CLOSED, sensed OPEN)" -> close the valve:
 *  each sensed change with the key active reschedules the check -> "Actuator positions match
 *  expected" ongoing:false -> debug off. The two notifications are waited for by predicate with a
 *  bound (the 5 s timer can straddle a step boundary under load), never by quiet; a late or
 *  missing one is a frame in the wrong step, which the golden shows. */
async function mismatch(): Promise<void> {
  step('readiness');
  await waitForData(60000, [21, 71]);
  await sleep(3000);

  step('connect');
  await openClient('A', OPERATOR);
  await settle(2500);

  step('unlock');
  send('A', { type: 'control_unlock', payload: {} });
  await settle(600);

  step('debug_on');
  command('A', 'debug_mode', { debugMode: true });
  // This publish schedules a check too (server.ts ACTUATOR_MISMATCH_DELAY_MS, 5 s). Let it fire
  // while the valve is still closed -- a match, nothing raised -- before the valve is told to
  // open; opened right away, whether the valve was past 95 % by the time it fired was a 0.4 s
  // race, and the mismatch landed in one step or the next.
  await settle(6500);

  step('valve_open');
  command('A', 'actuator', { actuatorName: 'Main Ball Valve', actuatorState: 1 });
  await settle(4500);  // 3 s of travel, then the sensed OPEN is on record; no publish, no check

  step('mismatch_raised');
  command('A', 'debug_mode', { debugMode: true });
  // Waited for by predicate, not by quiet: the frame lands in this step or the golden differs.
  await waitForFrame('A', notificationWith('actuator_mismatch', true), 12000);
  await settle(600);

  step('valve_close');
  command('A', 'actuator', { actuatorName: 'Main Ball Valve', actuatorState: 0 });
  await waitForFrame('A', notificationWith('actuator_mismatch', false), 15000);
  await settle(600);

  step('debug_off');
  command('A', 'debug_mode', { debugMode: false });
  await settle(1200);

  step('disconnect');
  await closeClient('A');
  await settle(500);
  cur!.t1 = Date.now();
  fs.writeFileSync(OUT, JSON.stringify(capture));
  console.log(`[session] wrote ${OUT}`);
}

/** G8 (DESIGN-WP6 §7, LEDGER D105): an idle-mode POST /api/state-csv, as the operator, with the
 *  actuators CSV changed in one cell -- Fuel Vent's Idle column, CLOSE -> OPEN -- and what the
 *  always-on backend does with it: writeStateCsv deploys it (no session), setImmediate fires
 *  onStateCsvUpdated (server.ts), which rebuilds STATE_ACTUATOR_MAP and broadcasts one
 *  `config_updated` to client A -- and nothing else to A: its commanded snapshot was sent at
 *  connect and is not re-sent. The rebuild is observable only through the next client: B's connect
 *  burst (ws_handshake.txt) carries ACT_CMD.B2.CH2 (Fuel Vent, board 12 channel 2) = 1 where A's
 *  carried 0. The GETs before and after are the witnesses in http.txt / csv.txt. The body is built
 *  from the GET so the fixture's CSV, not a copy of it, is what is deployed. */
async function statecsv(): Promise<void> {
  step('readiness');
  await waitForData(60000, [21]);
  await sleep(3000);

  step('connect');
  await openClient('A');
  await settle(2500);

  step('state_csv_deploy');
  const before = await request('GET', '/api/state-csv?name=actuators');
  const rows = before.body.split('\n');
  const i = rows.findIndex((r) => r.startsWith('Fuel Vent,'));
  if (i < 0) throw new Error('actuators CSV has no Fuel Vent row');
  const cells = rows[i].split(',');
  if (cells[1] !== 'CLOSE') throw new Error(`Fuel Vent Idle is ${cells[1]}, expected CLOSE`);
  cells[1] = 'OPEN';
  rows[i] = cells.join(',');
  await request('POST', '/api/state-csv?name=actuators', { headers: OPERATOR, body: rows.join('\n') });
  await settle(1500);
  await request('GET', '/api/state-csv?name=actuators');

  step('late_client');
  await openClient('B');
  await settle(1500);
  await closeClient('B');
  await settle(300);

  step('disconnect');
  await closeClient('A');
  await settle(500);
  cur!.t1 = Date.now();
  fs.writeFileSync(OUT, JSON.stringify(capture));
  console.log(`[session] wrote ${OUT}`);
}

(MODE === 'boards' ? boards() : MODE === 'nocal' ? nocal() : MODE === 'stalesub' ? stalesub()
  : MODE === 'operator' ? operator() : MODE === 'holds' ? holds()
  : MODE === 'selftest' ? selftest() : MODE === 'unrecognized' ? unrecognized() : MODE === 'mismatch' ? mismatch()
  : MODE === 'statecsv' ? statecsv() : main()).then(() => process.exit(0)).catch((err) => {
  console.error('[session] FAILED:', err);
  try { fs.writeFileSync(OUT, JSON.stringify(capture)); } catch { /* best effort */ }
  process.exit(1);
});
