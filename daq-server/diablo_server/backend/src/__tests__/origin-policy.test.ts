/**
 * SEC-6: the backend serves only the GUI's own origins, on the HTTP API and the WebSocket.
 *
 * A foreign Origin is refused with a 403 (API) or a refused upgrade (WS); the GUI's origins get
 * their origin echoed (never `*`); no Origin at all, which is every non-browser client and the
 * harnesses, is allowed and gets no Allow-Origin. Hermetic: the API handler and the real
 * WebSocketServer from ws-clients.ts on ephemeral loopback ports, config in a temp directory.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { createServer, request as httpRequest, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';

const root = mkdtempSync(join(tmpdir(), 'daq-origin-'));
const configDir = join(root, 'config');
process.env.CONFIG_PATH = join(configDir, 'config.toml');
process.env.DAQ_CALIBRATIONS_DIR = join(root, 'calibrations');
process.env.SESSION_STATE_PATH = join(root, 'session.json');
process.env.DAQ_OPERATORS_FILE = join(root, 'operators.txt');
process.env.GUI_PORT = '3000';
delete process.env.DAQ_ALLOWED_ORIGINS;
mkdirSync(join(configDir, 'profiles', 'default'), { recursive: true });
writeFileSync(join(configDir, 'config.toml'), '[network]\nactuator_cmd_port = 5005\n');
writeFileSync(join(configDir, 'profiles', 'default', 'config.toml'), '[network]\nactuator_cmd_port = 5005\n');
writeFileSync(join(configDir, '.active_profile'), 'default');
writeFileSync(join(root, 'operators.txt'), 'operator@example.com\n');

const { isAllowedOrigin } = await import('../origin-policy.js');
const { createAPIHandler } = await import('../api-server.js');
const wsClients = await import('../server/ws-clients.js');

const FOREIGN = ['https://evil.example', 'http://evil.example:3000', 'null', 'http://localhost:8081', 'file://'];
const OWN = ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://daq-server.starberkeley.org'];

describe('isAllowedOrigin', () => {
  it('allows a request with no Origin (non-browser clients, the harnesses)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });
  it.each(OWN)('allows the GUI origin %s', (o) => expect(isAllowedOrigin(o)).toBe(true));
  it.each(FOREIGN)('refuses %s', (o) => expect(isAllowedOrigin(o)).toBe(false));
  it('honours DAQ_ALLOWED_ORIGINS and then no longer allows the default Caddy site', () => {
    process.env.DAQ_ALLOWED_ORIGINS = 'http://daq.test:8443';
    try {
      expect(isAllowedOrigin('http://daq.test:8443')).toBe(true);
      expect(isAllowedOrigin('https://daq-server.starberkeley.org')).toBe(false);
    } finally {
      delete process.env.DAQ_ALLOWED_ORIGINS;
    }
  });
});

let api: Server;
let apiBase = '';
let wsServer: Server;
let wsPort = 0;

beforeAll(async () => {
  const handler = createAPIHandler({});
  api = createServer(async (req, res) => {
    if (!(await handler(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  wsServer = createServer();
  wsClients.attachWebSocketServer(wsServer);
  await new Promise<void>((r) => wsServer.listen(0, '127.0.0.1', () => r()));
  wsPort = (wsServer.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => api.close(() => r()));
  wsClients.wss?.close();
  await new Promise<void>((r) => wsServer.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

/** A raw http request, so the test sets Origin itself (fetch would refuse to). */
function get(path: string, method: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(apiBase + path);
    const req = httpRequest(
      { host: u.hostname, port: u.port, path: u.pathname, method, headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP API CORS', () => {
  it.each(FOREIGN)('refuses Origin %s with 403 and no Allow-Origin', async (o) => {
    const r = await get('/api/gui-config', 'GET', { Origin: o });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: 'Origin not allowed' });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
  it.each([
    ['POST', '/api/ball_valve_current'],
    ['POST', '/api/ota-flash'],
    ['POST', '/api/config'],
  ])('refuses a foreign %s %s before the route (and its operator gate) runs', async (m, p) => {
    const r = await get(p, m, { Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: 'Origin not allowed' });
  });
  it('refuses a foreign preflight too', async () => {
    const r = await get('/api/config', 'OPTIONS', { Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });
  it.each(OWN)('echoes the GUI origin %s, never *', async (o) => {
    const r = await get('/api/gui-config', 'GET', { Origin: o });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(o);
  });
  it('answers a request with no Origin and sends no Allow-Origin', async () => {
    const r = await get('/api/gui-config', 'GET', {});
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

function upgrade(origin?: string): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`, origin ? { origin } : {});
    ws.once('open', () => { ws.close(); resolve('open'); });
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.once('error', () => { /* reported via unexpected-response */ });
  });
}

describe('WebSocket upgrade', () => {
  it.each(FOREIGN)('refuses Origin %s with 403', async (o) => {
    expect(await upgrade(o)).toBe(403);
  });
  it.each(OWN)('accepts the GUI origin %s', async (o) => {
    expect(await upgrade(o)).toBe('open');
  });
  it('accepts a client that sends no Origin', async () => {
    expect(await upgrade()).toBe('open');
  });
});
