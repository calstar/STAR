/**
 * The camera check (video/camera-check.ts) against a scripted RTSP camera: each answer it
 * can give, and the Digest/Basic exchange -- verified on the camera's side with an
 * independent hash, so a wrong digest cannot pass by agreeing with itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import { createHash } from 'crypto';
import type { AddressInfo } from 'net';
import { checkCamera } from '../video/camera-check.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const USER = 'admin';
const PASS = 'c@m:pass';
const REALM = 'IP Camera';
const NONCE = 'abc123';

type Mode = 'open' | 'digest' | 'digest-qop' | 'basic' | 'missing' | 'garbage' | 'silent';

/** Is `auth` a correct answer to our challenge for DESCRIBE `uri`? */
function authOk(mode: Mode, auth: string | undefined, uri: string): boolean {
  if (!auth) return false;
  if (mode === 'basic') return auth === `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
  const p: Record<string, string> = {};
  for (const m of auth.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1]] = m[2] ?? m[3];
  const ha1 = md5(`${USER}:${REALM}:${PASS}`);
  const ha2 = md5(`DESCRIBE:${uri}`);
  const want = mode === 'digest-qop'
    ? md5(`${ha1}:${NONCE}:${p.nc}:${p.cnonce}:auth:${ha2}`)
    : md5(`${ha1}:${NONCE}:${ha2}`);
  return p.username === USER && p.uri === uri && p.response === want;
}

let server: net.Server;
let port = 0;
const seen: string[] = [];

beforeAll(async () => {
  server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let end: number;
      while ((end = buf.indexOf('\r\n\r\n')) >= 0) {
        const req = buf.slice(0, end);
        buf = buf.slice(end + 4);
        seen.push(req);
        const [line, ...hdrs] = req.split('\r\n');
        const [, uri] = line.split(' ');
        const mode = new URL(uri).pathname.slice(1) as Mode;
        const cseq = hdrs.find((h) => h.startsWith('CSeq'))?.split(':')[1].trim();
        const auth = hdrs.find((h) => h.startsWith('Authorization'))?.slice('Authorization:'.length).trim();
        const send = (status: string, extra = '', body = '') =>
          sock.write(`RTSP/1.0 ${status}\r\nCSeq: ${cseq}\r\n${extra}${body ? `Content-Length: ${body.length}\r\n` : ''}\r\n${body}`);
        if (mode === 'silent') return;
        if (mode === 'garbage') { sock.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
        if (mode === 'missing') { send('404 Not Found'); return; }
        if (mode === 'open') { send('200 OK', 'Content-Type: application/sdp\r\n', 'v=0\r\n'); return; }
        if (authOk(mode, auth, uri)) { send('200 OK', 'Content-Type: application/sdp\r\n', 'v=0\r\n'); return; }
        const challenge = mode === 'basic' ? `Basic realm="${REALM}"`
          : `Digest realm="${REALM}", nonce="${NONCE}"${mode === 'digest-qop' ? ', qop="auth"' : ''}`;
        // A body on the 401 too: the checker must skip it, not read it as the next answer.
        send('401 Unauthorized', `WWW-Authenticate: ${challenge}\r\n`, 'denied');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

const url = (mode: Mode) => `rtsp://127.0.0.1:${port}/${mode}`;
const creds = { username: USER, password: PASS };

describe('camera check', () => {
  it('a camera that answers is ok', async () => {
    expect(await checkCamera(url('open'), undefined)).toMatchObject({ ok: true });
  });

  for (const mode of ['digest', 'digest-qop', 'basic'] as const) {
    it(`logs in with ${mode}`, async () => {
      expect(await checkCamera(url(mode), creds)).toMatchObject({ ok: true });
    });
  }

  it('a wrong password is "auth", and says so without the password', async () => {
    const r = await checkCamera(url('digest'), { username: USER, password: 'wrong' });
    expect(r).toMatchObject({ ok: false, problem: 'auth', detail: 'camera rejected the username or password' });
    expect(JSON.stringify(r)).not.toContain('wrong');
  });

  it('no credentials for a camera that wants them says so', async () => {
    expect(await checkCamera(url('digest'), undefined)).toMatchObject({ ok: false, problem: 'auth', detail: 'camera needs a username and password' });
  });

  it('a wrong path is "not-found"', async () => {
    expect(await checkCamera(url('missing'), undefined)).toMatchObject({ ok: false, problem: 'not-found' });
  });

  it('a closed port is "refused"', async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const p = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await checkCamera(`rtsp://127.0.0.1:${p}/x`, undefined)).toMatchObject({ ok: false, problem: 'refused' });
  });

  it('a host that never answers is "unreachable"', async () => {
    // 192.0.2.0/24 is TEST-NET-1: never routed, so the connect hangs until the timeout.
    expect(await checkCamera('rtsp://192.0.2.1:554/x', undefined, 300)).toMatchObject({ ok: false, problem: 'unreachable' });
  });

  it('something that is not RTSP, or says nothing, is an error, not "ok"', async () => {
    expect(await checkCamera(url('garbage'), undefined)).toMatchObject({ ok: false, problem: 'error' });
    expect(await checkCamera(url('silent'), undefined, 300)).toMatchObject({ ok: false, problem: 'error' });
  });

  it('never puts credentials on the wire in the URL', async () => {
    seen.length = 0;
    await checkCamera(url('digest'), creds);
    expect(seen.join('\n')).not.toContain(PASS);
    expect(seen[0]).toMatch(new RegExp(`^DESCRIBE rtsp://127\\.0\\.0\\.1:${port}/digest RTSP/1\\.0`));
  });
});
