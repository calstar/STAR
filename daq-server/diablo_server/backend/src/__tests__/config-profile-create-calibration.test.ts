/**
 * POST /api/config/profiles/create with `calibration` makes a calibration profile of the config's
 * name beside it — copied or fresh — and makes neither when either one is refused.
 *
 * Hermetic: CONFIG_PATH and DAQ_CALIBRATIONS_DIR point at a temp directory; the handler is served
 * on an ephemeral localhost port.
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'daq-cfgcal-'));
const configDir = join(root, 'config');
const calDir = join(root, 'calibrations');
const calProfiles = join(calDir, 'profiles');
process.env.CONFIG_PATH = join(configDir, 'config.toml');
process.env.DAQ_CALIBRATIONS_DIR = calDir;
process.env.SESSION_STATE_PATH = join(root, 'session.json');

const { createAPIHandler } = await import('../api-server.js');

const HOTFIRE_CAL = JSON.stringify({ cubic_state: { '0x2011': { role: 'LOX Tank', points: [[1, 2]], numPoints: 1 } } });
let server: Server;
let base = '';

beforeAll(async () => {
  const handler = createAPIHandler();
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

beforeEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(calDir, { recursive: true, force: true });
  mkdirSync(join(configDir, 'profiles', 'default'), { recursive: true });
  writeFileSync(join(configDir, 'profiles', 'default', 'config.toml'), '[network]\nactuator_cmd_port = 5005\n');
  writeFileSync(join(configDir, 'profiles', '.active'), 'default');
  mkdirSync(calProfiles, { recursive: true });
  writeFileSync(join(calProfiles, 'hotfire.json'), HOTFIRE_CAL);
});

const create = (body: unknown) => fetch(`${base}/api/config/profiles/create`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('create config profile with a calibration profile', () => {
  it('copies the chosen calibration profile under the new config\'s name', async () => {
    const res = await create({ name: 'cold_flow', calibration: { from: 'hotfire' } });
    expect(res.status).toBe(200);
    expect(existsSync(join(configDir, 'profiles', 'cold_flow', 'config.toml'))).toBe(true);
    expect(readFileSync(join(calProfiles, 'cold_flow.json'), 'utf-8')).toBe(HOTFIRE_CAL);
    const data = await res.json();
    expect(data.calibration_profiles.profiles.map((p: any) => p.name)).toContain('cold_flow');
  });

  it('makes a fresh one with {}', async () => {
    expect((await create({ name: 'cold_flow', calibration: {} })).status).toBe(200);
    expect(existsSync(join(calProfiles, 'cold_flow.json'))).toBe(true);
  });

  it('without `calibration` makes only the config, as before', async () => {
    expect((await create({ name: 'cold_flow' })).status).toBe(200);
    expect(existsSync(join(calProfiles, 'cold_flow.json'))).toBe(false);
  });

  it('a taken calibration name refuses the whole create', async () => {
    const res = await create({ name: 'hotfire', calibration: {} });
    expect(res.status).toBe(400);
    expect(existsSync(join(configDir, 'profiles', 'hotfire'))).toBe(false);
    expect(readFileSync(join(calProfiles, 'hotfire.json'), 'utf-8')).toBe(HOTFIRE_CAL);
  });

  it('a refused config leaves no calibration profile behind', async () => {
    mkdirSync(join(configDir, 'profiles', 'taken'));
    const res = await create({ name: 'taken', calibration: { from: 'hotfire' } });
    expect(res.status).toBe(400);
    expect(existsSync(join(calProfiles, 'taken.json'))).toBe(false);
  });
});
