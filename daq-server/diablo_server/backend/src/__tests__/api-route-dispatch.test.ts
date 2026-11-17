/**
 * Every route of api-server.ts is dispatched (DESIGN-WP7 §7 H9), and the one safe way to reach
 * `POST /api/ota-flash/flash-all`: a config with no enabled boards (D72 — the recorded substitute
 * for a golden line, because no harness owns such a config and lifecycle's live ota_service
 * would flash the four boards its fixture declares).
 *
 * The route table below is what the §6.1 route-table grep prints for api-server.ts (and, after
 * the split, api/*.ts); a test here regenerates it from the sources so the sweep cannot silently
 * fall behind the file. Each row of CASES sends one request as the viewer (a signed-in email that
 * is not in the operator roster), with `{}` where the route reads a body, and asserts the status
 * the route gives today — never the router's `404 {"error":"Not found"}`, which is what a branch
 * that is no longer reached would answer. Viewer identity makes every gated write a 403 with no
 * side effect; the two ungated OTA routes answer as themselves (SEC-2 stays visible: flash-all
 * is 200, not 403).
 *
 * Hermetic: CONFIG_PATH, DAQ_CALIBRATIONS_DIR, SESSION_STATE_PATH and DAQ_OPERATORS_FILE point at
 * a temp directory; the handler is served on an ephemeral loopback port, as
 * config-profile-create-calibration.test.ts does. No stack, no fixed port.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = mkdtempSync(join(tmpdir(), 'daq-dispatch-'));
const configDir = join(root, 'config');
process.env.CONFIG_PATH = join(configDir, 'config.toml');
process.env.DAQ_CALIBRATIONS_DIR = join(root, 'calibrations');
process.env.SESSION_STATE_PATH = join(root, 'session.json');
process.env.DAQ_OPERATORS_FILE = join(root, 'operators.txt');

// One board, disabled: getEnabledBoardsForFlash() must filter it out, not merely see no boards.
const NO_ENABLED_BOARDS = [
  '[network]',
  'actuator_cmd_port = 5005',
  '',
  '[boards.pt_board]',
  'type = "PT"',
  'ip = "127.0.0.21"',
  'board_id = 21',
  'enabled = false',
  '',
].join('\n');

mkdirSync(join(configDir, 'profiles', 'default'), { recursive: true });
writeFileSync(join(configDir, 'config.toml'), NO_ENABLED_BOARDS);
writeFileSync(join(configDir, 'profiles', 'default', 'config.toml'), NO_ENABLED_BOARDS);
writeFileSync(join(configDir, '.active_profile'), 'default');
mkdirSync(join(root, 'calibrations'), { recursive: true });
writeFileSync(join(root, 'operators.txt'), 'operator@example.com\n');

const { createAPIHandler } = await import('../api-server.js');

const VIEWER = { 'X-Auth-Email': 'viewer@example.com' };
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The route table, as `routes()` in DESIGN-WP7 §6.1 prints it, one `METHOD path` per line:
 * `ANY` is a condition with no method, a trailing `*` is a `startsWith` condition.
 */
const ROUTE_TABLE = `
GET /api/ball_valve_cal
POST /api/ball_valve_cal
POST /api/board-log-mode
GET /api/board-logs
GET /api/board-logs/stats
GET /api/calibration_profiles
POST /api/calibration_profiles/load
POST /api/calibration_profiles/new_blank
POST /api/calibration_profiles/save
GET /api/calibration_status
GET /api/config
POST /api/config
GET /api/config_packets
GET /api/config/export
POST /api/config/import
GET /api/config/profiles
POST /api/config/profiles/create
POST /api/config/profiles/delete
POST /api/config/profiles/rename
POST /api/config/profiles/switch
GET /api/config/running
GET /api/config/validate
GET /api/cubic_calibration
GET /api/debug
GET /api/engine_state
ANY /api/feed-char/results
GET /api/gui-config
GET /api/lc_tare
POST /api/ota-flash
POST /api/ota-flash/flash-all
GET /api/ota-flash/projects
GET /api/pressure-limits
GET /api/query
GET /api/sensor-config
GET /api/sensors
GET /api/sensors/*
GET /api/state-csv
POST /api/state-csv
GET /api/state-script
POST /api/state-script
POST /api/state-script/check
GET /api/states
ANY /api/video/*
`.trim().split('\n');

/** The §6.1 grep, in TS: every `url.pathname …` condition of the router and its route groups. */
function routeTableFromSources(): string[] {
  const files = [join(SRC_DIR, 'api-server.ts')];
  const apiDir = join(SRC_DIR, 'api');
  if (existsSync(apiDir)) {
    for (const f of readdirSync(apiDir).filter((n) => n.endsWith('.ts')).sort()) files.push(join(apiDir, f));
  }
  const re = /url\.pathname( === '[^']+'|\.startsWith\('[^']+'\))( && req\.method === '[A-Z]+')?/g;
  const out = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf-8').matchAll(re)) {
      const path = /'([^']+)'/.exec(m[1])![1] + (m[1].startsWith('.startsWith') ? '*' : '');
      const method = m[2] ? /'([A-Z]+)'/.exec(m[2])![1] : 'ANY';
      out.add(`${method} ${path}`);
    }
  }
  return [...out].sort();
}

/** [method, path, body or null, status the route gives today]. */
type Case = [string, string, string | null, number];
const CASES: Case[] = [
  ['GET', '/api/ball_valve_cal', null, 200],
  ['POST', '/api/ball_valve_cal', '{}', 403],
  ['POST', '/api/board-log-mode', '{}', 403],
  ['GET', '/api/board-logs', null, 200],
  ['GET', '/api/board-logs/stats', null, 200],
  ['GET', '/api/calibration_profiles', null, 200],
  ['POST', '/api/calibration_profiles/load', '{}', 403],
  ['POST', '/api/calibration_profiles/new_blank', '{}', 403],
  ['POST', '/api/calibration_profiles/save', '{}', 403],
  ['GET', '/api/calibration_status', null, 200],
  ['GET', '/api/config', null, 200],
  ['POST', '/api/config', '{}', 403],
  ['GET', '/api/config_packets', null, 200],
  ['GET', '/api/config/export', null, 200],
  ['POST', '/api/config/import', '{}', 403],
  ['GET', '/api/config/profiles', null, 200],
  ['POST', '/api/config/profiles/create', '{}', 403],
  ['POST', '/api/config/profiles/delete', '{}', 403],
  ['POST', '/api/config/profiles/rename', '{}', 403],
  ['POST', '/api/config/profiles/switch', '{}', 403],
  ['GET', '/api/config/running', null, 200],
  ['GET', '/api/config/validate', null, 200],
  ['GET', '/api/cubic_calibration', null, 200],
  ['GET', '/api/debug', null, 200],
  ['GET', '/api/engine_state', null, 200],
  // No session → 409 before the method is looked at (the 405 branch stays unguarded, H5).
  ['GET', '/api/feed-char/results', null, 409],
  ['POST', '/api/feed-char/results', '{}', 409],
  ['PUT', '/api/feed-char/results', '{}', 409],
  ['GET', '/api/gui-config', null, 200],
  ['GET', '/api/lc_tare', null, 200],
  // Ungated (SEC-2): `{}` is "Missing or invalid ip"; an empty body would be a 500 from
  // JSON.parse('') — also not 404, but the asserted answer must be the one the route gives.
  ['POST', '/api/ota-flash', '{}', 400],
  ['POST', '/api/ota-flash/flash-all', '{}', 200],
  ['GET', '/api/ota-flash/projects', null, 200],
  ['GET', '/api/pressure-limits', null, 200],
  ['GET', '/api/query', null, 503],         // no query client is ever passed (D-API1)
  ['GET', '/api/sensor-config', null, 200],
  ['GET', '/api/sensors', null, 503],       // D-API1
  ['GET', '/api/sensors/PT1_Cal.CH1', null, 200],
  ['GET', '/api/state-csv', null, 400],     // no ?name → Unknown CSV ""
  ['POST', '/api/state-csv', '{}', 403],
  ['GET', '/api/state-script', null, 200],
  ['POST', '/api/state-script', '{}', 403],
  ['POST', '/api/state-script/check', '{}', 400],  // no ?state → "state is required", before execFile
  ['GET', '/api/states', null, 200],
  ['GET', '/api/video/streams', null, 200],
];

/** The smallest VideoService `GET /api/video/streams` reads (video/routes.ts). */
const videoStub = {
  current: () => ({ config: { streams: [], layout: null }, errors: [] }),
  gatewayStatus: () => ({}),
  bufferStatus: () => ({}),
} as any;

let server: Server;
let base = '';

beforeAll(async () => {
  const handler = createAPIHandler({ video: videoStub });
  server = createServer(async (req, res) => {
    if (!(await handler(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

const send = (method: string, path: string, body: string | null, headers: Record<string, string> = VIEWER) =>
  fetch(`${base}${path}`, {
    method,
    headers: body === null ? headers : { ...headers, 'Content-Type': 'application/json' },
    body,
  });

describe('the route table', () => {
  it('is the one the sources declare (regenerate ROUTE_TABLE when this fails)', () => {
    expect(routeTableFromSources()).toEqual([...ROUTE_TABLE].sort());
  });

  it('is covered by CASES, every line at least once', () => {
    const covers = (line: string, [method, path]: Case) => {
      const [m, p] = line.split(' ');
      const pathMatch = p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p;
      return pathMatch && (m === 'ANY' || m === method);
    };
    const uncovered = ROUTE_TABLE.filter((line) => !CASES.some((c) => covers(line, c)));
    expect(uncovered).toEqual([]);
  });
});

describe('every route is dispatched (as the viewer)', () => {
  it.each(CASES)('%s %s (body %s) answers %i, not the router\'s 404', async (method, path, body, status) => {
    const res = await send(method, path, body);
    const text = await res.text();
    const routerNotFound = res.status === 404 && text === JSON.stringify({ error: 'Not found' })
      && res.headers.get('access-control-expose-headers') === null;
    expect(routerNotFound, `${method} ${path} fell through to the router's 404`).toBe(false);
    expect(res.status, `${method} ${path} → ${text}`).toBe(status);
  });

  it('/api/video/* is answered by the video branch (it sets Access-Control-Expose-Headers)', async () => {
    const res = await send('GET', '/api/video/streams', null);
    expect(res.headers.get('access-control-expose-headers')).toBe('Location');
    expect(await res.json()).toMatchObject({ streams: [], errors: [] });
  });

  it('POST /api/ota-flash with {} is the route\'s own 400', async () => {
    const res = await send('POST', '/api/ota-flash', '{}');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing or invalid ip' });
  });
});

describe('POST /api/ota-flash/flash-all with no enabled boards (H8\'s viewer case, D72)', () => {
  it('answers the viewer 200 {"success":false,"message":"No enabled boards in config"} — no gate (SEC-2, kept)', async () => {
    const res = await send('POST', '/api/ota-flash/flash-all', '{}');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(JSON.stringify({ success: false, message: 'No enabled boards in config' }));
  });

  it('answers the same with no X-Auth-Email at all (the implicit operator)', async () => {
    const res = await send('POST', '/api/ota-flash/flash-all', '{}', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: false, message: 'No enabled boards in config' });
  });
});
