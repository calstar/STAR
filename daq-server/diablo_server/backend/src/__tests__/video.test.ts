/**
 * VIDCOMM video backend: config validation, credential handling, gateway reconcile and the
 * WHEP proxy. Hermetic -- the gateway is a fake (an in-memory GatewayApi, and a local HTTP
 * server standing in for MediaMTX's WHEP listener). The real gateway is exercised by
 * test/video-gateway.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';

const dir = mkdtempSync(join(tmpdir(), 'daq-video-'));
const CONFIG = join(dir, 'video.json');
const SECRETS = join(dir, 'video.secrets.json');
process.env.VIDEO_CONFIG_PATH = CONFIG;
process.env.VIDEO_SECRETS_PATH = SECRETS;

const { validateVideoConfig, loadVideoConfig, publicStream } = await import('../video/config.js');
const { cameraSource, desiredPaths, reconcile } = await import('../video/gateway.js');
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
    expect(loadVideoConfig()).toEqual({ config: { version: 1, streams: [] }, secrets: { streams: {} }, errors: [] });
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
}

describe('reconcile', () => {
  let gw: FakeGateway;
  beforeEach(() => {
    gw = new FakeGateway();
    gw.paths.set('~^fake/[a-z0-9-]+$', { source: 'publisher' });
  });

  const desired = (streams: any[], secrets = {}) =>
    desiredPaths({ config: { version: 1, streams }, secrets: { streams: secrets } });

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
    const svc = new VideoService({ apiUrl: 'x', webrtcUrl: 'x' }, gw);
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
    const svc = new VideoService({ apiUrl: 'http://127.0.0.1:1', webrtcUrl: whepUrl }, new FakeGateway());
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
