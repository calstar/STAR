/**
 * SEC-3: `POST /api/ota-flash` builds only a project named in `GET /api/ota-flash/projects`,
 * resolved on the server. A client path, relative or absolute, never reaches ota_service.
 *
 * ota-service-cmd is mocked, so what is asserted is the directory the backend would hand to
 * `OTA_BUILD_FLASH`. The firmware tree is a temp directory named by OTA_WORKSPACE_ROOT.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../ota-service-cmd.js', () => ({
  otaBuildFlash: vi.fn(async () => ({ ok: true, reply: 'OK' })),
  otaFlashFirmwareFile: vi.fn(async () => ({ ok: true, reply: 'OK' })),
}));

const root = mkdtempSync(join(tmpdir(), 'daq-ota-name-'));
const ws = join(root, 'ws');
const proj = join(ws, 'firmware', 'Hotfire_Code', 'PT_Hotfire');
const outside = join(root, 'evil');
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, 'platformio.ini'), '[env:x]\n');
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'platformio.ini'), '[env:x]\nextra_scripts = pre:pwn.py\n');
process.env.OTA_WORKSPACE_ROOT = ws;
const configDir = join(root, 'config');
process.env.CONFIG_PATH = join(configDir, 'config.toml');
process.env.DAQ_CALIBRATIONS_DIR = join(root, 'calibrations');
process.env.SESSION_STATE_PATH = join(root, 'session.json');
process.env.DAQ_OPERATORS_FILE = join(root, 'operators.txt');
mkdirSync(join(configDir, 'profiles', 'default'), { recursive: true });
writeFileSync(join(configDir, 'config.toml'), '[network]\nactuator_cmd_port = 5005\n');
writeFileSync(join(configDir, 'profiles', 'default', 'config.toml'), '[network]\nactuator_cmd_port = 5005\n');
writeFileSync(join(configDir, '.active_profile'), 'default');
writeFileSync(join(root, 'operators.txt'), 'operator@example.com\n');

const { createAPIHandler } = await import('../api-server.js');
const { otaBuildFlash } = await import('../ota-service-cmd.js');

let server: Server;
let base = '';
beforeAll(async () => {
  const handler = createAPIHandler({});
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
beforeEach(() => vi.clearAllMocks());

const flash = (body: unknown) =>
  fetch(`${base}/api/ota-flash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/ota-flash project resolution', () => {
  it('lists the project by name', async () => {
    const res = await fetch(`${base}/api/ota-flash/projects`);
    expect(await res.json()).toEqual({ projects: [{ name: 'PT_Hotfire', path: 'firmware/Hotfire_Code/PT_Hotfire' }] });
  });

  it('builds a listed name in the server-resolved directory', async () => {
    const res = await flash({ ip: '127.0.0.1', project: 'PT_Hotfire', boardId: 21 });
    expect(res.status).toBe(200);
    expect(otaBuildFlash).toHaveBeenCalledWith('127.0.0.1', proj, 21);
  });

  it.each([
    ['absolute', outside],
    ['relative ..', '../evil'],
    ['a listed project\'s own path', 'firmware/Hotfire_Code/PT_Hotfire'],
  ])('refuses projectPath (%s) with 400 and builds nothing', async (_t, p) => {
    const res = await flash({ ip: '127.0.0.1', projectPath: p });
    expect(res.status).toBe(400);
    expect(otaBuildFlash).not.toHaveBeenCalled();
  });

  it.each([['no_such_project'], [outside], ['../evil'], ['PT_Hotfire/../../../evil'], [42]])(
    'refuses project %s as unknown with 400 and builds nothing',
    async (p) => {
      const res = await flash({ ip: '127.0.0.1', project: p });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/^Unknown firmware project/);
      expect(otaBuildFlash).not.toHaveBeenCalled();
    },
  );
});
