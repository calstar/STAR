/**
 * The response goes out before the callback (DESIGN-WP7 §7 H1, the ordering half; D72).
 *
 * Four writes defer their callback with `setImmediate` so the HTTP response is written first and
 * the WS `config_updated` that `server.ts` sends from the callback comes after: `POST /api/config`
 * and `POST /api/config/import` (idle → deploy → `onConfigUpdated`), `POST /api/state-csv`
 * (deployed → `onStateCsvUpdated`) and `POST /api/config/profiles/switch` (`onConfigUpdated`). On
 * loopback the response and the frame are microseconds apart, so a golden cannot show the
 * deferral; this test records `res.writableEnded` at the moment each mocked callback runs, on the
 * real ServerResponse, and asserts it is already `true`. A callback called directly instead of
 * through `setImmediate` runs before `res.writeHead` and reads `false`. During a session the
 * save and the CSV write stay drafts and fire neither callback; the switch is refused (409).
 *
 * Hermetic: CONFIG_PATH, DAQ_CALIBRATIONS_DIR, SESSION_STATE_PATH and DAQ_OPERATORS_FILE point at
 * a temp directory; `session-manager` is mocked so a session can be "active" without starting
 * one (its real init would resume a pipeline); the handler is served on an ephemeral loopback
 * port, as config-profile-create-calibration.test.ts does.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { createServer, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'daq-cb-order-'));
const configDir = join(root, 'config');
process.env.CONFIG_PATH = join(configDir, 'config.toml');
process.env.DAQ_CALIBRATIONS_DIR = join(root, 'calibrations');
process.env.SESSION_STATE_PATH = join(root, 'session.json');
process.env.DAQ_OPERATORS_FILE = join(root, 'operators.txt');
writeFileSync(join(root, 'operators.txt'), 'operator@example.com\n');

const session = vi.hoisted(() => ({ active: false }));
vi.mock('../session-manager.js', () => ({
  sessionManager: { getStatus: () => ({ active: session.active, dbDir: null }) },
}));

const { createAPIHandler } = await import('../api-server.js');

const OPERATOR = { 'X-Auth-Email': 'operator@example.com' };
const DEFAULT_TOML = '[network]\nactuator_cmd_port = 5005\n';
const OTHER_TOML = '[network]\nactuator_cmd_port = 5007\n\n[marker]\nprofile = "other"\n';

let server: Server;
let base = '';
/** The response of the request in flight, so a mocked callback can read its `writableEnded`. */
let current: ServerResponse | null = null;
/** `writableEnded` as each callback saw it, in call order. */
let endedAtCall: boolean[] = [];
let fired: (() => void) | null = null;
const record = () => { endedAtCall.push(current!.writableEnded); fired?.(); };
const onConfigUpdated = vi.fn(record);
const onStateCsvUpdated = vi.fn(record);

beforeAll(async () => {
  const handler = createAPIHandler({ onConfigUpdated, onStateCsvUpdated });
  server = createServer(async (req, res) => {
    current = res;
    if (!(await handler(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  session.active = false;
  endedAtCall = [];
  fired = null;
  onConfigUpdated.mockClear();
  onStateCsvUpdated.mockClear();
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(join(configDir, 'profiles', 'default'), { recursive: true });
  mkdirSync(join(configDir, 'profiles', 'other'), { recursive: true });
  writeFileSync(join(configDir, 'config.toml'), DEFAULT_TOML);
  writeFileSync(join(configDir, 'profiles', 'default', 'config.toml'), DEFAULT_TOML);
  writeFileSync(join(configDir, 'profiles', 'other', 'config.toml'), OTHER_TOML);
  writeFileSync(join(configDir, '.active_profile'), 'default');
});

const post = (path: string, body: string, contentType = 'application/json') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { ...OPERATOR, 'Content-Type': contentType }, body });

/** Resolves when a callback runs (armed before the request, since the callback may run before
 *  the client sees the response), or after 2 s. */
const callbackRan = () => new Promise<void>((r) => {
  fired = r;
  setTimeout(r, 2000);
});

/** Two macrotask turns: anything deferred with `setImmediate` by the handler has run by now. */
const drainImmediates = () => new Promise<void>((r) => setImmediate(() => setImmediate(() => r())));

const deployed = () => readFileSync(join(configDir, 'config.toml'), 'utf-8');

describe('idle, as the operator: the response is ended before the callback runs', () => {
  it('POST /api/config → onConfigUpdated after the 200', async () => {
    const ran = callbackRan();
    const res = await post('/api/config', JSON.stringify({
      config: { network: { actuator_cmd_port: 5005 }, marker: { saved: 1 } },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deployed: true, message: 'Config saved and deployed' });
    await ran;
    expect(onConfigUpdated).toHaveBeenCalledTimes(1);
    expect(onStateCsvUpdated).not.toHaveBeenCalled();
    expect(endedAtCall).toEqual([true]);
    expect(deployed()).toContain('saved = 1');
  });

  it('POST /api/config/import → onConfigUpdated after the 200', async () => {
    const ran = callbackRan();
    const toml = '[network]\nactuator_cmd_port = 5006\n\n[marker]\nimported = 1\n';
    const res = await post('/api/config/import', toml, 'text/plain');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deployed: true, message: 'Config imported and deployed' });
    await ran;
    expect(onConfigUpdated).toHaveBeenCalledTimes(1);
    expect(endedAtCall).toEqual([true]);
    expect(deployed()).toBe(toml);
  });

  it('POST /api/state-csv (deployed) → onStateCsvUpdated after the 200', async () => {
    const ran = callbackRan();
    const csv = 'a,b\n1,2\n';
    const res = await post('/api/state-csv?name=actuators', csv, 'text/csv');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deployed: true, message: 'Saved and applied' });
    await ran;
    expect(onStateCsvUpdated).toHaveBeenCalledTimes(1);
    expect(onConfigUpdated).not.toHaveBeenCalled();
    expect(endedAtCall).toEqual([true]);
    expect(readFileSync(join(configDir, 'state_machine_actuators.csv'), 'utf-8')).toBe(csv);
  });

  it('POST /api/config/profiles/switch → onConfigUpdated after the 200', async () => {
    const ran = callbackRan();
    const res = await post('/api/config/profiles/switch', JSON.stringify({ name: 'other' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, active: 'other' });
    await ran;
    expect(onConfigUpdated).toHaveBeenCalledTimes(1);
    expect(endedAtCall).toEqual([true]);
    expect(deployed()).toBe(OTHER_TOML);
  });
});

describe('during a session: drafts, and neither callback fires', () => {
  beforeEach(() => { session.active = true; });

  it('POST /api/config saves a draft; config.toml and the callback are untouched', async () => {
    const res = await post('/api/config', JSON.stringify({
      config: { network: { actuator_cmd_port: 5005 }, marker: { saved: 1 } },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, deployed: false, message: 'Saved as draft (applies at next session start)',
    });
    await drainImmediates();
    expect(onConfigUpdated).not.toHaveBeenCalled();
    expect(deployed()).toBe(DEFAULT_TOML);
    expect(readFileSync(join(configDir, 'profiles', 'default', 'config.toml'), 'utf-8')).toContain('saved = 1');
  });

  it('POST /api/state-csv saves a draft; config/ and the callback are untouched', async () => {
    const res = await post('/api/state-csv?name=actuators', 'a,b\n1,2\n', 'text/csv');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, deployed: false, message: 'Saved as draft (applies at next session start)',
    });
    await drainImmediates();
    expect(onStateCsvUpdated).not.toHaveBeenCalled();
    expect(onConfigUpdated).not.toHaveBeenCalled();
  });

  it('POST /api/config/profiles/switch is refused with 409 and fires nothing', async () => {
    const res = await post('/api/config/profiles/switch', JSON.stringify({ name: 'other' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Cannot switch config while a session is running' });
    await drainImmediates();
    expect(onConfigUpdated).not.toHaveBeenCalled();
    expect(deployed()).toBe(DEFAULT_TOML);
  });
});
