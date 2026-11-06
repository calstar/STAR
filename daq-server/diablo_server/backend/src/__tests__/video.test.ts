/**
 * VIDCOMM video backend: config validation, credential handling, gateway reconcile and the
 * WHEP proxy. Hermetic -- the gateway is a fake (an in-memory GatewayApi, and a local HTTP
 * server standing in for MediaMTX's WHEP listener). The real gateway is exercised by
 * test/video-gateway.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as http from 'http';
import { readFileSync, utimesSync } from 'fs';
import { fileURLToPath } from 'url';
import type { AddressInfo } from 'net';

const dir = mkdtempSync(join(tmpdir(), 'daq-video-'));
const CONFIG = join(dir, 'video.json');
const SECRETS = join(dir, 'video.secrets.json');
process.env.VIDEO_CONFIG_PATH = CONFIG;
process.env.VIDEO_SECRETS_PATH = SECRETS;

const { validateVideoConfig, validateLayout, loadVideoConfig, publicStream, LAYOUT_PRESETS } = await import('../video/config.js');
const gatewayMod = await import('../video/gateway.js');
const { cameraSource, desiredPaths, reconcile, gatewayEndpointFromEnv } = gatewayMod;
const { VideoService } = await import('../video/service.js');
const { handleVideoRequest } = await import('../video/routes.js');
type GatewayApi = import('../video/gateway.js').GatewayApi;
type ManagedPathConf = import('../video/gateway.js').ManagedPathConf;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PASSWORD = 'hunter2-not-in-any-response';

function writeConfig(streams: unknown[]): void {
  writeFileSync(CONFIG, JSON.stringify({ version: 1, streams }));
}
function writeSecrets(streams: Record<string, unknown>): void {
  writeFileSync(SECRETS, JSON.stringify({ streams }));
}

const pad = { id: 'pad', label: 'Pad overview', kind: 'rtsp', url: 'rtsp://192.0.2.10:554/stream1', record: true };

describe('video config validation', () => {
  it('accepts a well-formed stream and defaults record to true', () => {
    const { config, errors } = validateVideoConfig({ version: 1, streams: [{ ...pad, record: undefined }] });
    expect(errors).toEqual([]);
    expect(config.streams).toEqual([{ id: 'pad', label: 'Pad overview', kind: 'rtsp', url: pad.url, record: true }]);
  });

  it('rejects a URL with credentials in it, so a password cannot be committed', () => {
    const { config, errors } = validateVideoConfig({ version: 1, streams: [{ ...pad, url: 'rtsp://admin:pw@192.0.2.10/s' }] });
    expect(config.streams).toEqual([]);
    expect(errors.join()).toMatch(/credentials/);
    expect(errors.join()).not.toContain('pw@');
  });

  it('drops a bad stream and keeps the good ones', () => {
    const { config, errors } = validateVideoConfig({
      version: 1,
      streams: [pad, { ...pad }, { ...pad, id: 'Bad Id' }, { ...pad, id: 'http', url: 'http://x/' }, { ...pad, id: 'eng', label: 'Engine' }],
    });
    expect(config.streams.map((s) => s.id)).toEqual(['pad', 'eng']);
    expect(errors).toHaveLength(3);
  });

  it('a missing file is an empty config, not an error', () => {
    rmSync(CONFIG, { force: true });
    rmSync(SECRETS, { force: true });
    expect(loadVideoConfig()).toEqual({ config: { version: 1, streams: [], layout: { preset: 'auto', slots: [] } }, secrets: { streams: {} }, errors: [] });
  });

  it('a corrupt secrets file is reported without echoing its contents', () => {
    writeConfig([pad]);
    writeFileSync(SECRETS, `{"streams": {"pad": {"password": "${PASSWORD}"`);
    const { errors } = loadVideoConfig();
    expect(errors).toEqual(['video secrets file is not valid JSON']);
  });
});

describe('credentials', () => {
  it('reach the gateway source URL, percent-encoded', () => {
    const src = cameraSource(pad as any, { streams: { pad: { username: 'admin', password: 'p@ss:/w' } } });
    expect(src).toBe('rtsp://admin:p%40ss%3A%2Fw@192.0.2.10:554/stream1');
    expect(new URL(src).hostname).toBe('192.0.2.10');
  });

  it('are absent from what a browser is given', () => {
    const pub = publicStream({ ...pad, lowResUrl: 'rtsp://192.0.2.10/sub' } as any);
    expect(pub).toEqual({ id: 'pad', label: 'Pad overview', kind: 'rtsp', hasLowRes: true, record: true });
  });
});

/** In-memory MediaMTX config API. */
class FakeGateway implements GatewayApi {
  paths = new Map<string, Record<string, unknown>>();
  calls: string[] = [];
  down = false;
  async listPaths() {
    if (this.down) throw new Error('gateway unreachable');
    this.calls.push('list');
    return new Map([...this.paths].map(([k, v]) => [k, { name: k, ...v }]));
  }
  async addPath(name: string, conf: ManagedPathConf) { this.calls.push(`add ${name}`); this.paths.set(name, { ...conf }); }
  async replacePath(name: string, conf: ManagedPathConf) { this.calls.push(`replace ${name}`); this.paths.set(name, { ...conf }); }
  async deletePath(name: string) { this.calls.push(`delete ${name}`); this.paths.delete(name); }
  ready = new Set<string>();
  async pathReady(name: string) { return this.ready.has(name); }
}

describe('reconcile', () => {
  let gw: FakeGateway;
  beforeEach(() => {
    gw = new FakeGateway();
    gw.paths.set('~^fake/[a-z0-9-]+$', { source: 'publisher' });
  });

  const desired = (streams: any[], secrets = {}) =>
    desiredPaths({ config: { version: 1, streams, layout: { preset: 'auto', slots: [] } }, secrets: { streams: secrets } });

  it('adds, then is a no-op on the second pass', async () => {
    const want = desired([pad]);
    expect(await reconcile(gw, want)).toEqual({ added: ['raw/pad'], replaced: [], deleted: [] });
    expect(await reconcile(gw, want)).toEqual({ added: [], replaced: [], deleted: [] });
    expect(gw.calls).toEqual(['list', 'add raw/pad', 'list']);
  });

  it('replaces a changed source and deletes an unconfigured raw/ path, leaving static paths alone', async () => {
    await reconcile(gw, desired([pad, { ...pad, id: 'eng' }]));
    const r = await reconcile(gw, desired([{ ...pad, url: 'rtsp://192.0.2.11/s' }]));
    expect(r).toEqual({ added: [], replaced: ['raw/pad'], deleted: ['raw/eng'] });
    expect([...gw.paths.keys()].sort()).toEqual(['raw/pad', '~^fake/[a-z0-9-]+$']);
  });

  it('a credential change alone is pushed', async () => {
    await reconcile(gw, desired([pad]));
    const r = await reconcile(gw, desired([pad], { pad: { username: 'u', password: 'p' } }));
    expect(r.replaced).toEqual(['raw/pad']);
    expect(gw.paths.get('raw/pad')?.source).toBe('rtsp://u:p@192.0.2.10:554/stream1');
  });

  it('refills a gateway that restarted empty', async () => {
    const svc = new VideoService({ apiUrl: 'x', webrtcUrl: 'x', host: 'x' }, gw);
    writeConfig([pad]);
    rmSync(SECRETS, { force: true });
    await svc.sync();
    gw.paths.clear();
    gw.down = true;
    await svc.sync();
    expect(svc.gatewayStatus().reachable).toBe(false);
    gw.down = false;
    await svc.sync();
    expect(svc.gatewayStatus().reachable).toBe(true);
    expect(gw.paths.has('raw/pad')).toBe(true);
  });
});

describe('routes', () => {
  // A stand-in for the gateway's WHEP listener: records what it was sent.
  let whep: http.Server;
  let whepUrl = '';
  const seen: { method: string; url: string; body: string; headers: http.IncomingHttpHeaders }[] = [];
  // And the backend in front of it.
  let api: http.Server;
  let apiUrl = '';

  beforeAll(async () => {
    whep = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, body, headers: req.headers });
        if (req.method === 'POST' && req.url === '/raw/pad/whep') {
          res.writeHead(201, { 'Content-Type': 'application/sdp', Location: '/raw/pad/whep/0b6f3c2e-1111-4a4a-9c9c-123456789abc' });
          res.end('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 109\r\n');
        } else if (req.method === 'POST') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'no stream is available on path' }));
        } else {
          res.writeHead(200);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => whep.listen(0, '127.0.0.1', r));
    whepUrl = `http://127.0.0.1:${(whep.address() as AddressInfo).port}`;

    writeConfig([{ ...pad, lowResUrl: 'rtsp://192.0.2.10/sub' }]);
    writeSecrets({ pad: { username: 'admin', password: PASSWORD } });
    const svc = new VideoService({ apiUrl: 'http://127.0.0.1:1', webrtcUrl: whepUrl, host: '127.0.0.1' }, new FakeGateway());
    api = http.createServer(async (req, res) => {
      const handled = await handleVideoRequest(req, res, new URL(req.url!, 'http://x').pathname, svc);
      if (!handled) { res.writeHead(418); res.end(); }
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    whep.close();
    api.close();
  });

  it('GET /api/video/streams lists streams with no URL or credential anywhere in the body', async () => {
    const res = await fetch(`${apiUrl}/api/video/streams`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).streams).toEqual([{ id: 'pad', label: 'Pad overview', kind: 'rtsp', hasLowRes: true, record: true }]);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('admin');
    expect(text).not.toContain('rtsp://');
  });

  it('proxies a WHEP offer to raw/<id> and rewrites Location to the backend', async () => {
    const res = await fetch(`${apiUrl}/api/video/streams/pad/whep`, {
      method: 'POST', headers: { 'Content-Type': 'application/sdp', Cookie: 'session=secret' }, body: 'v=0 offer',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toBe('/api/video/streams/pad/whep/0b6f3c2e-1111-4a4a-9c9c-123456789abc');
    expect(await res.text()).toContain('m=video');
    const sent = seen.at(-1)!;
    expect(sent).toMatchObject({ method: 'POST', url: '/raw/pad/whep', body: 'v=0 offer' });
    expect(sent.headers.cookie).toBeUndefined();
  });

  it('DELETE ends the session on the gateway', async () => {
    const res = await fetch(`${apiUrl}/api/video/streams/pad/whep/0b6f3c2e-1111-4a4a-9c9c-123456789abc`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', url: '/raw/pad/whep/0b6f3c2e-1111-4a4a-9c9c-123456789abc' });
  });

  it('will not proxy to a gateway path that is not a configured stream', async () => {
    const before = seen.length;
    for (const id of ['nope', '..', 'fake%2Fcam1']) {
      const res = await fetch(`${apiUrl}/api/video/streams/${id}/whep`, { method: 'POST', body: 'v=0' });
      expect(res.status).toBe(404);
    }
    expect(seen.length).toBe(before);
  });

  it('leaves non-video paths to the caller', async () => {
    expect((await fetch(`${apiUrl}/api/config`)).status).toBe(418);
  });
});

describe('gateway defaults', () => {
  // The backend's default endpoint and daq-server/video/mediamtx.yml must name the same ports,
  // and neither may take a port the DAQ already uses (9997 OTA, 9998 actuator, 9999 fire).
  const yml = readFileSync(fileURLToPath(new URL('../../../../video/mediamtx.yml', import.meta.url)), 'utf8');
  const setting = (key: string) => yml.match(new RegExp(`^${key}:\\s*(\\S+)`, 'm'))?.[1] ?? '';
  const port = (addr: string) => addr.split(':').pop();

  it('match the gateway config', () => {
    const ep = gatewayEndpointFromEnv({});
    expect(port(setting('apiAddress'))).toBe(new URL(ep.apiUrl).port);
    expect(port(setting('webrtcAddress'))).toBe(new URL(ep.webrtcUrl).port);
  });

  it('stay off the DAQ service ports', () => {
    const taken = new Set(['9997', '9998', '9999', '8081', '3000', '2240']);
    for (const key of ['apiAddress', 'webrtcAddress', 'webrtcLocalUDPAddress', 'rtspAddress']) {
      expect(taken.has(port(setting(key))!), `${key} = ${setting(key)}`).toBe(false);
    }
    for (const off of ['metrics', 'pprof', 'playback', 'rtmp', 'hls', 'srt', 'moq']) {
      expect(setting(off), off).toBe('false');
    }
  });
});

describe('editing from the pane', () => {
  let whep: http.Server;
  let api: http.Server;
  let apiUrl = '';
  let gw: FakeGateway;
  let svc: InstanceType<typeof VideoService>;
  const whepSeen: string[] = [];

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  };
  const config = () => call('GET', '/api/video/config');
  const save = (revision: string, streams: unknown[], credentials?: unknown) =>
    call('PUT', '/api/video/config', { revision, streams, credentials });

  beforeAll(async () => {
    whep = http.createServer((req, res) => {
      whepSeen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/sdp', Location: `${req.url}/1234abcd-0000-4000-8000-000000000000` });
        res.end('v=0\r\n');
      });
    });
    await new Promise<void>((r) => whep.listen(0, '127.0.0.1', r));
    gw = new FakeGateway();
    svc = new VideoService({ apiUrl: 'x', webrtcUrl: `http://127.0.0.1:${(whep.address() as AddressInfo).port}`, host: '127.0.0.1' }, gw);
    api = http.createServer(async (req, res) => {
      await handleVideoRequest(req, res, new URL(req.url!, 'http://x').pathname, svc);
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(() => { whep.close(); api.close(); });

  beforeEach(() => {
    writeFileSync(CONFIG, JSON.stringify({ version: 1, streams: [pad], layout: { preset: '2x2', slots: ['pad', null, null, null] }, notes: 'kept' }));
    writeSecrets({ pad: { username: 'admin', password: PASSWORD } });
  });

  it('shows usernames and whether a password is set, never the password', async () => {
    const r = await config();
    expect(r.json.streams[0]).toMatchObject({ id: 'pad', url: pad.url, username: 'admin', passwordSet: true });
    expect(r.text).not.toContain(PASSWORD);
  });

  it('saves streams, keeps an untouched password, and pushes to the gateway at once', async () => {
    const { json: before } = await config();
    const r = await save(before.revision, [{ ...pad, label: 'Pad wide' }, { ...pad, id: 'eng', label: 'Engine' }], {
      eng: { username: 'op', password: 'eng-pass' },
    });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(PASSWORD);
    const file = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(file.streams.map((s: any) => s.label)).toEqual(['Pad wide', 'Engine']);
    expect(file.notes).toBe('kept'); // other keys survive
    expect(file.layout).toEqual({ preset: '2x2', slots: ['pad', null, null, null] }); // no layout sent: kept
    expect(JSON.stringify(file)).not.toMatch(/pass/);
    const secrets = JSON.parse(readFileSync(SECRETS, 'utf8'));
    expect(secrets.streams).toEqual({ pad: { username: 'admin', password: PASSWORD }, eng: { username: 'op', password: 'eng-pass' } });
    expect(gw.paths.get('raw/eng')?.source).toBe('rtsp://op:eng-pass@192.0.2.10:554/stream1');
  });

  it('keeps the secrets file private to its owner', async () => {
    const { json } = await config();
    await save(json.revision, [pad], { pad: { password: 'new' } });
    const { statSync } = await import('fs');
    expect(statSync(SECRETS).mode & 0o077).toBe(0);
  });

  it('clears a password with null and drops a removed stream\'s secret', async () => {
    let { json } = await config();
    await save(json.revision, [pad, { ...pad, id: 'eng', label: 'Engine' }], { eng: { password: 'x' } });
    ({ json } = await config());
    await save(json.revision, [pad], { pad: { password: null } });
    expect(JSON.parse(readFileSync(SECRETS, 'utf8')).streams).toEqual({ pad: { username: 'admin' } });
  });

  it('rejects a save made against an older revision', async () => {
    const { json } = await config();
    await save(json.revision, [{ ...pad, label: 'First editor' }]);
    const r = await save(json.revision, [{ ...pad, label: 'Second editor' }]);
    expect(r.status).toBe(409);
    expect(JSON.parse(readFileSync(CONFIG, 'utf8')).streams[0].label).toBe('First editor');
  });

  it('rejects the whole save if any stream is invalid, and writes nothing', async () => {
    const { json } = await config();
    const before = readFileSync(CONFIG, 'utf8');
    for (const bad of [{ ...pad, id: 'eng', url: 'rtsp://u:p@cam/x' }, { ...pad }, { ...pad, id: 'eng', label: '' }]) {
      const r = await save(json.revision, [pad, bad]);
      expect(r.status).toBe(400);
      expect(r.json.errors.length).toBeGreaterThan(0);
    }
    expect(readFileSync(CONFIG, 'utf8')).toBe(before);
  });

  it('previews an unsaved URL, reusing the saved password of the stream being edited', async () => {
    const r = await call('POST', '/api/video/previews', { url: 'rtsp://192.0.2.20/new', fromStreamId: 'pad' });
    expect(r.status).toBe(201);
    const id = r.json.id;
    expect(gw.paths.get(`preview/${id}`)?.source).toBe(`rtsp://admin:${PASSWORD}@192.0.2.20/new`);
    expect(r.text).not.toContain(PASSWORD);

    const offer = await fetch(`${apiUrl}/api/video/previews/${id}/whep`, { method: 'POST', body: 'v=0' });
    expect(offer.status).toBe(201);
    expect(offer.headers.get('location')).toBe(`/api/video/previews/${id}/whep/1234abcd-0000-4000-8000-000000000000`);
    expect(whepSeen.at(-1)).toBe(`POST /preview/${id}/whep`);

    expect((await call('DELETE', `/api/video/previews/${id}`)).status).toBe(200);
    expect(gw.paths.has(`preview/${id}`)).toBe(false);
    expect((await fetch(`${apiUrl}/api/video/previews/${id}/whep`, { method: 'POST', body: 'v=0' })).status).toBe(404);
  });

  it('a preview is never reconciled away, and expires on its own', async () => {
    const { json } = await call('POST', '/api/video/previews', { url: 'rtsp://192.0.2.20/new' });
    await svc.sync();
    expect(gw.paths.has(`preview/${json.id}`)).toBe(true);
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 3 * 60_000);
    try {
      await svc.sync();
      expect(gw.paths.has(`preview/${json.id}`)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a preview of a URL with credentials in it', async () => {
    const r = await call('POST', '/api/video/previews', { url: 'rtsp://u:p@192.0.2.20/new' });
    expect(r.status).toBe(400);
  });
});

describe('layout', () => {
  const ids = new Set(['pad', 'eng']);

  it('defaults to auto, and normalises slots to the preset', () => {
    expect(validateLayout(undefined, ids)).toEqual({ layout: { preset: 'auto', slots: [] }, errors: [] });
    expect(validateLayout({ preset: '2x2', slots: ['pad'] }, ids).layout).toEqual({ preset: '2x2', slots: ['pad', null, null, null] });
    expect(validateLayout({ preset: '1x1', slots: ['eng', 'pad'] }, ids).layout).toEqual({ preset: '1x1', slots: ['eng'] });
  });

  it('empties a slot whose stream is gone, rather than failing', () => {
    expect(validateLayout({ preset: '2x2', slots: ['gone', 'pad', 7, null] }, ids)).toEqual({
      layout: { preset: '2x2', slots: [null, 'pad', null, null] }, errors: [],
    });
  });

  it('reports an unknown preset and falls back to auto', () => {
    const r = validateLayout({ preset: '5x5', slots: [] }, ids);
    expect(r.layout.preset).toBe('auto');
    expect(r.errors[0]).toMatch(/5x5/);
  });

  it('slot counts match the frontend presets', async () => {
    const { PRESET_SLOT_COUNTS } = await import('../../../frontend/lib/video/layout.js');
    expect(PRESET_SLOT_COUNTS).toEqual(LAYOUT_PRESETS);
  });

  it('a low-res URL becomes its own gateway path with the same credentials', () => {
    const paths = desiredPaths({
      config: { version: 1, streams: [{ ...pad, lowResUrl: 'rtsp://192.0.2.10/sub' } as any], layout: { preset: 'auto', slots: [] } },
      secrets: { streams: { pad: { username: 'u', password: 'p' } } },
    });
    expect([...paths]).toEqual([
      // In the buffer (record: true): pulled all the time.
      ['raw/pad', { source: 'rtsp://u:p@192.0.2.10:554/stream1', sourceOnDemand: false, record: true }],
      // Low-res: never recorded, pulled only while shown.
      ['raw/pad/low', { source: 'rtsp://u:p@192.0.2.10/sub', sourceOnDemand: true, record: false }],
    ]);
  });
});

describe('layout over HTTP', () => {
  let whep: http.Server;
  let api: http.Server;
  let apiUrl = '';
  const seen: string[] = [];

  beforeAll(async () => {
    whep = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => { res.writeHead(201, { 'Content-Type': 'application/sdp', Location: `${req.url}/1234abcd-0000-4000-8000-000000000000` }); res.end('v=0'); });
    });
    await new Promise<void>((r) => whep.listen(0, '127.0.0.1', r));
    const svc = new VideoService({ apiUrl: 'x', webrtcUrl: `http://127.0.0.1:${(whep.address() as AddressInfo).port}`, host: '127.0.0.1' }, new FakeGateway());
    api = http.createServer(async (req, res) => { await handleVideoRequest(req, res, new URL(req.url!, 'http://x').pathname, svc); });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(() => { whep.close(); api.close(); });

  beforeEach(() => {
    writeConfig([{ ...pad, lowResUrl: 'rtsp://192.0.2.10/sub' }, { ...pad, id: 'eng', label: 'Engine' }]);
    rmSync(SECRETS, { force: true });
  });

  it('the low-res route proxies to raw/<id>/low, and only for streams that have one', async () => {
    const ok = await fetch(`${apiUrl}/api/video/streams/pad/low/whep`, { method: 'POST', body: 'v=0' });
    expect(ok.status).toBe(201);
    expect(ok.headers.get('location')).toBe('/api/video/streams/pad/low/whep/1234abcd-0000-4000-8000-000000000000');
    expect(seen.at(-1)).toBe('POST /raw/pad/low/whep');
    expect((await fetch(`${apiUrl}/api/video/streams/eng/low/whep`, { method: 'POST', body: 'v=0' })).status).toBe(404);
  });

  it('saves a layout, rejects an unknown preset, and lists the layout to viewers', async () => {
    const cfg = await (await fetch(`${apiUrl}/api/video/config`)).json();
    const put = (layout: unknown, revision = cfg.revision) => fetch(`${apiUrl}/api/video/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, streams: cfg.streams.map(({ username, passwordSet, ...st }: any) => st), layout }),
    });
    expect((await put({ preset: 'huge', slots: [] })).status).toBe(400);
    const saved = await (await put({ preset: '1+5', slots: ['eng', 'pad'] })).json();
    expect(saved.layout).toEqual({ preset: '1+5', slots: ['eng', 'pad', null, null, null, null] });
    const view = await (await fetch(`${apiUrl}/api/video/streams`)).json();
    expect(view.layout).toEqual(saved.layout);

    // Removing a stream empties its slot.
    const put2 = await fetch(`${apiUrl}/api/video/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: saved.revision, streams: [pad] }),
    });
    expect((await put2.json()).layout).toEqual({ preset: '1+5', slots: [null, 'pad', null, null, null, null] });
  });
});

describe('gateway on another machine', () => {
  const { gatewayEndpoint, HttpGatewayApi } = gatewayMod;

  it('defaults to this machine, follows the setting, and lets VIDEO_GATEWAY_HOST win', () => {
    expect(gatewayEndpoint(undefined, {})).toEqual({ apiUrl: 'http://127.0.0.1:8887', webrtcUrl: 'http://127.0.0.1:8889', agentUrl: 'http://127.0.0.1:8886', host: '127.0.0.1' });
    const ep = gatewayEndpoint({ host: 'theombp.local', password: 'gw-pass' }, {});
    expect(ep).toMatchObject({ apiUrl: 'http://theombp.local:8887', webrtcUrl: 'http://theombp.local:8889', host: 'theombp.local' });
    expect(ep.auth).toBe(`Basic ${Buffer.from('daq:gw-pass').toString('base64')}`);
    expect(gatewayEndpoint({ host: 'theombp.local' }, { VIDEO_GATEWAY_HOST: '10.0.0.5' }).host).toBe('10.0.0.5');
  });

  it('the service follows the local file, live', () => {
    const before = process.env.VIDEO_GATEWAY_HOST;
    delete process.env.VIDEO_GATEWAY_HOST;
    try {
      writeConfig([pad]);
      writeFileSync(SECRETS, JSON.stringify({ streams: {}, gateway: { host: 'media-mac.local', password: 'p' } }));
      const svc = new VideoService();
      expect(svc.endpoint.host).toBe('media-mac.local');
      expect(svc.gatewayStatus().host).toBe('media-mac.local');
      writeFileSync(SECRETS, JSON.stringify({ streams: {} }));
      // mtime resolution: make sure the change is seen
      utimesSync(SECRETS, new Date(), new Date(Date.now() + 5000));
      expect(svc.endpoint.host).toBe('127.0.0.1');
      expect(svc.endpoint.auth).toBeUndefined();
    } finally {
      if (before !== undefined) process.env.VIDEO_GATEWAY_HOST = before;
    }
  });

  it('sends the password to the control API, and says so when it is refused', async () => {
    const got: (string | undefined)[] = [];
    const srv = http.createServer((req, res) => {
      got.push(req.headers.authorization);
      const ok = req.headers.authorization === `Basic ${Buffer.from('daq:right').toString('base64')}`;
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(ok ? JSON.stringify({ items: [], pageCount: 1 }) : '');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      await new HttpGatewayApi(url, gatewayEndpoint({ password: 'right' }, {}).auth).listPaths();
      await expect(new HttpGatewayApi(url, gatewayEndpoint({ password: 'wrong' }, {}).auth).listPaths()).rejects.toThrow(/refused the password/);
      expect(got[0]).toBe(`Basic ${Buffer.from('daq:right').toString('base64')}`);
    } finally {
      srv.close();
    }
  });

  it('is set from the editor: host checked, password write-only and kept when omitted', async () => {
    writeConfig([pad]);
    writeFileSync(SECRETS, JSON.stringify({ streams: { pad: { username: 'admin', password: PASSWORD } } }));
    const { editableConfig, saveVideoConfig } = await import('../video/config.js');
    let cfg = editableConfig();
    expect(cfg.gateway).toEqual({ host: '', passwordSet: false });
    expect(() => saveVideoConfig({ streams: [pad], gateway: { host: 'not a host!' } }, cfg.revision)).toThrow(/not a hostname/);
    cfg = saveVideoConfig({ streams: [pad], gateway: { host: 'theombp.local', password: 'gw-pass' } }, cfg.revision);
    expect(cfg.gateway).toEqual({ host: 'theombp.local', passwordSet: true });
    expect(JSON.stringify(cfg)).not.toContain('gw-pass');
    cfg = saveVideoConfig({ streams: [pad], gateway: { host: 'theombp.local' } }, cfg.revision);
    const file = JSON.parse(readFileSync(SECRETS, 'utf8'));
    expect(file.gateway).toEqual({ host: 'theombp.local', password: 'gw-pass' });
    expect(file.streams.pad.password).toBe(PASSWORD); // cameras untouched
    cfg = saveVideoConfig({ streams: [pad], gateway: { host: '', password: null } }, cfg.revision);
    expect(JSON.parse(readFileSync(SECRETS, 'utf8')).gateway).toBeUndefined();
    expect(JSON.stringify(readFileSync(CONFIG, 'utf8'))).not.toContain('theombp'); // never in the committed file
  });
});

describe('HiDes: MPEG-TS pushed over UDP', () => {
  const hides = { id: 'hides', label: 'HiDes link', kind: 'udp', port: 5600, record: true };

  it('validates the port: in 5600-5609, one stream per port, never a DAQ port', () => {
    expect(validateVideoConfig({ version: 1, streams: [hides] }).config.streams).toEqual([hides]);
    for (const port of [5006, 5000, 5599, 5610, 5600.5, '5600']) {
      const r = validateVideoConfig({ version: 1, streams: [{ ...hides, port }] });
      expect(r.config.streams, String(port)).toEqual([]);
      expect(r.errors[0]).toMatch(/5600-5609/);
    }
    const dup = validateVideoConfig({ version: 1, streams: [hides, { ...hides, id: 'hides2' }] });
    expect(dup.errors[0]).toMatch(/already used/);
  });

  it('becomes a gateway path that listens all the time, with no URL or credentials', () => {
    const paths = desiredPaths({ config: { version: 1, streams: [hides as any], layout: { preset: 'auto', slots: [] } }, secrets: { streams: { hides: { password: 'x' } } } });
    expect([...paths]).toEqual([['raw/hides', { source: 'udp+mpegts://0.0.0.0:5600', sourceOnDemand: false, record: true }]]);
    expect(publicStream(hides as any)).toEqual({ id: 'hides', label: 'HiDes link', kind: 'udp', hasLowRes: false, record: true });
  });

  it('its check says whether TS is arriving, and where to send it', async () => {
    writeFileSync(CONFIG, JSON.stringify({ version: 1, streams: [hides] }));
    writeFileSync(SECRETS, JSON.stringify({ streams: {}, gateway: { host: 'theombp.local' } }));
    const gw = new FakeGateway();
    const svc = new VideoService(undefined, gw);
    const idle = await svc.checkStream('hides')!;
    expect(idle).toMatchObject({ ok: false });
    expect((idle as any).detail).toBe('nothing arriving on UDP 5600 -- point HiDesViewer at theombp.local:5600 (localhost:5600 on the gateway machine itself)');
    gw.ready.add('raw/hides');
    await new Promise((r) => setTimeout(r, 5100)); // past the check cache
    expect(await svc.checkStream('hides')!).toMatchObject({ ok: true });
    expect(svc.checkStream('hides', true)).toBeUndefined(); // no low-res for a pushed stream
  }, 10_000);
});

describe('the rolling buffer on the gateway', () => {
  it('records only streams marked "include in recording", and pulls those all the time', () => {
    const paths = desiredPaths({
      config: { version: 1, layout: { preset: 'auto', slots: [] }, streams: [
        { ...pad, record: true } as any,
        { ...pad, id: 'overview', record: false } as any,
        { id: 'hides', label: 'HiDes', kind: 'udp', port: 5600, record: false } as any,
      ] },
      secrets: { streams: {} },
    });
    expect(paths.get('raw/pad')).toMatchObject({ record: true, sourceOnDemand: false });
    expect(paths.get('raw/overview')).toMatchObject({ record: false, sourceOnDemand: true });
    expect(paths.get('raw/hides')).toMatchObject({ record: false, sourceOnDemand: false });
  });

  it('switching a stream out of the recording is pushed to the gateway', async () => {
    const gw = new FakeGateway();
    const mk = (record: boolean) => desiredPaths({ config: { version: 1, layout: { preset: 'auto', slots: [] }, streams: [{ ...pad, record } as any] }, secrets: { streams: {} } });
    await reconcile(gw, mk(true));
    expect((await reconcile(gw, mk(false))).replaced).toEqual(['raw/pad']);
    expect(gw.paths.get('raw/pad')).toMatchObject({ record: false, sourceOnDemand: true });
  });
});

describe('Save, through the video agent', () => {
  let agentSrv: http.Server;
  let agentUrl = '';
  const got: { url: string; auth?: string; body: any }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    agentSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push({ url: req.url!, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
        const r = req.url === '/status' ? { status: 200, body: { bufferSeconds: 300, buffered: { pad: 120 }, disk: { freeBytes: 5e10, totalBytes: 1e12 } } } : reply;
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((r) => agentSrv.listen(0, '127.0.0.1', r));
    agentUrl = `http://127.0.0.1:${(agentSrv.address() as AddressInfo).port}`;
  });
  afterAll(() => agentSrv.close());

  const svcWith = (auth?: string) => new VideoService({ apiUrl: 'x', webrtcUrl: 'x', agentUrl, host: '127.0.0.1', ...(auth ? { auth } : {}) }, new FakeGateway());

  it('asks for exactly the streams marked "include in recording", with the gateway password', async () => {
    writeConfig([pad, { ...pad, id: 'overview', label: 'Overview', record: false }, { id: 'hides', label: 'HiDes', kind: 'udp', port: 5600, record: true }]);
    reply = { status: 200, body: { folder: '/rec/2026-11-06_120000_save', seconds: 300, streams: [] } };
    const r = await svcWith('Basic abc').save();
    expect(r.folder).toBe('/rec/2026-11-06_120000_save');
    expect(got.at(-1)).toEqual({ url: '/save', auth: 'Basic abc', body: { streams: ['pad', 'hides'], label: 'save' } });
  });

  it('reports the buffer from the agent on every sync', async () => {
    writeConfig([pad]);
    const svc = svcWith();
    expect(svc.bufferStatus().available).toBe(false);
    await svc.sync();
    expect(svc.bufferStatus()).toEqual({ available: true, bufferSeconds: 300, buffered: { pad: 120 }, disk: { freeBytes: 5e10, totalBytes: 1e12 } });
  });

  it('says why a Save failed: agent error, wrong password, nothing to save, agent gone', async () => {
    writeConfig([pad]);
    reply = { status: 500, body: { error: 'ffmpeg: No such file' } };
    await expect(svcWith().save()).rejects.toThrow('ffmpeg: No such file');
    reply = { status: 401, body: {} };
    await expect(svcWith().save()).rejects.toThrow('refused the password');
    writeConfig([{ ...pad, record: false }]);
    await expect(svcWith().save()).rejects.toThrow(/include in recording/);
    writeConfig([pad]);
    const gone = new VideoService({ apiUrl: 'x', webrtcUrl: 'x', agentUrl: 'http://127.0.0.1:1', host: '127.0.0.1' }, new FakeGateway());
    await expect(gone.save()).rejects.toThrow(/unreachable/);
  });
});
