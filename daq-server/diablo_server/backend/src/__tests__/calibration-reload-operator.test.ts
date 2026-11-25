/**
 * `onCalibrationReload` as the operator (LEDGER D64(5), gating DESIGN-WP7 1.10).
 *
 * `POST /api/calibration_profiles/load` and `…/new_blank` are the only routes that fire
 * `onCalibrationReload` (→ `server.ts` tells the calibration service to re-read the live store,
 * Elodin cmd 7). Every golden reaches them only as the viewer (H8's 403s), so nothing froze the
 * operator path: that the callback fires exactly once per successful write, **synchronously,
 * before the response** (unlike the deferred `onConfigUpdated`, STYLE-S29 / WP7 §3.3), with the
 * live store already swapped; and that a refused load (500, the router's catch — the route has no
 * try of its own) fires nothing.
 *
 * Hermetic: CONFIG_PATH, DAQ_CALIBRATIONS_DIR, SESSION_STATE_PATH and DAQ_OPERATORS_FILE point at
 * a temp directory; the handler is served on an ephemeral loopback port, as
 * config-profile-create-calibration.test.ts does.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { createServer, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'daq-calreload-'));
const configDir = join(root, 'config');
const calDir = join(root, 'calibrations');
const calProfiles = join(calDir, 'profiles');
const livePath = join(calDir, 'cubic_calibration.json');
process.env.CONFIG_PATH = join(configDir, 'config.toml');
process.env.DAQ_CALIBRATIONS_DIR = calDir;
process.env.SESSION_STATE_PATH = join(root, 'session.json');
process.env.DAQ_OPERATORS_FILE = join(root, 'operators.txt');
mkdirSync(join(configDir, 'profiles', 'default'), { recursive: true });
writeFileSync(join(configDir, 'config.toml'), '[network]\nactuator_cmd_port = 5005\n');
writeFileSync(join(configDir, 'profiles', 'default', 'config.toml'), '[network]\nactuator_cmd_port = 5005\n');
writeFileSync(join(configDir, '.active_profile'), 'default');
writeFileSync(join(root, 'operators.txt'), 'operator@example.com\n');

const { createAPIHandler } = await import('../api-server.js');

const OPERATOR = { 'X-Auth-Email': 'operator@example.com' };
const VIEWER = { 'X-Auth-Email': 'viewer@example.com' };
const HOTFIRE_CAL = JSON.stringify({
  cubic_state: { '0x2011': { role: 'LOX Tank', points: [[1, 2]], numPoints: 1, status: 'calibrated' } },
});

let server: Server;
let base = '';
let current: ServerResponse | null = null;
/** What each `onCalibrationReload` call saw: had the response started, and was the live store
 *  already the one being loaded. */
let atCall: { headersSent: boolean; writableEnded: boolean; live: string | null }[] = [];
const onCalibrationReload = vi.fn(() => {
  atCall.push({
    headersSent: current!.headersSent,
    writableEnded: current!.writableEnded,
    live: existsSync(livePath) ? readFileSync(livePath, 'utf-8') : null,
  });
});

beforeAll(async () => {
  const handler = createAPIHandler({ onCalibrationReload });
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
  atCall = [];
  onCalibrationReload.mockClear();
  rmSync(calDir, { recursive: true, force: true });
  mkdirSync(calProfiles, { recursive: true });
  writeFileSync(join(calProfiles, 'hotfire.json'), HOTFIRE_CAL);
});

const post = (path: string, body: unknown, headers: Record<string, string> = OPERATOR) =>
  fetch(`${base}${path}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

describe('POST /api/calibration_profiles/load as the operator', () => {
  it('swaps the live store, then fires onCalibrationReload once before the 200', async () => {
    const res = await post('/api/calibration_profiles/load', { name: 'hotfire' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profiles: [{ name: 'hotfire', active: true }], active: 'hotfire' });
    expect(readFileSync(livePath, 'utf-8')).toBe(HOTFIRE_CAL);
    expect(onCalibrationReload).toHaveBeenCalledTimes(1);
    expect(atCall).toEqual([{ headersSent: false, writableEnded: false, live: HOTFIRE_CAL }]);
  });

  it('a missing profile is the router\'s 500 and fires nothing', async () => {
    const res = await post('/api/calibration_profiles/load', { name: 'missing' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Calibration profile "missing" not found' });
    expect(onCalibrationReload).not.toHaveBeenCalled();
    expect(existsSync(livePath)).toBe(false);
  });

  it('the viewer is refused before anything happens', async () => {
    const res = await post('/api/calibration_profiles/load', { name: 'hotfire' }, VIEWER);
    expect(res.status).toBe(403);
    expect(onCalibrationReload).not.toHaveBeenCalled();
    expect(existsSync(livePath)).toBe(false);
  });
});

describe('POST /api/calibration_profiles/new_blank as the operator', () => {
  it('with a name: writes the blank live store and the profile, then fires once before the 200', async () => {
    writeFileSync(livePath, HOTFIRE_CAL); // the seed the blank is stripped from
    const res = await post('/api/calibration_profiles/new_blank', { name: 'blank1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      profiles: [{ name: 'blank1', active: true }, { name: 'hotfire', active: false }], active: 'blank1',
    });
    const live = readFileSync(livePath, 'utf-8');
    expect(JSON.parse(live).cubic_state['0x2011']).toMatchObject({
      role: 'LOX Tank', points: [], numPoints: 0, status: 'uncalibrated',
    });
    expect(readFileSync(join(calProfiles, 'blank1.json'), 'utf-8')).toBe(live);
    expect(onCalibrationReload).toHaveBeenCalledTimes(1);
    expect(atCall).toEqual([{ headersSent: false, writableEnded: false, live }]);
  });

  it('without a name: blank live store, no profile loaded, fires once', async () => {
    const res = await post('/api/calibration_profiles/new_blank', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profiles: [{ name: 'hotfire', active: false }], active: '' });
    expect(JSON.parse(readFileSync(livePath, 'utf-8'))).toEqual({ cubic_state: {} });
    expect(onCalibrationReload).toHaveBeenCalledTimes(1);
    expect(atCall[0]).toMatchObject({ headersSent: false, writableEnded: false });
  });
});

// C5-5: GET /api/cubic_calibration used to search fixed repo paths and never DAQ_CALIBRATIONS_DIR,
// so it could show a different store from the one load / new_blank had just written.
describe('GET /api/cubic_calibration reads the same live store the profile routes write', () => {
  it('serves the store a load has just swapped in', async () => {
    expect((await post('/api/calibration_profiles/load', { name: 'hotfire' })).status).toBe(200);
    const res = await fetch(`${base}/api/cubic_calibration`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HOTFIRE_CAL);
  });

  it('answers an empty store when DAQ_CALIBRATIONS_DIR holds none, whatever the checkout has', async () => {
    const res = await fetch(`${base}/api/cubic_calibration`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cubic_state: {} });
  });
});
