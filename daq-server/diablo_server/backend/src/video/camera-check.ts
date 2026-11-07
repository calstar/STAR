/**
 * Why a camera is not giving video, in words an operator can act on.
 *
 * The gateway knows why it cannot pull a source, but says so only in its log -- its API has
 * just `ready: false`. So when a tile fails, the backend asks the camera itself, from the same
 * LAN: a TCP connect (unreachable? refused?), then an RTSP DESCRIBE with the stream's
 * credentials, answering Basic or Digest (wrong password? wrong path?). A camera that answers
 * 200 is fine, and the fault is between it and the gateway.
 *
 * RTSPS gets the TCP check only. Never returns or logs a credential.
 */
import * as net from 'net';
import { createHash, randomBytes } from 'crypto';

/** Shown to operators only as a short code (frontend lib/video/tile-state codeForProblem). */
export type CameraProblem = 'unreachable' | 'refused' | 'auth' | 'not-found' | 'no-data' | 'error';

export type CameraCheck =
  | { ok: true; detail: string }
  | { ok: false; problem: CameraProblem; detail: string };

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

interface RtspResponse {
  status: number;
  headers: Record<string, string>;
  /** Bytes of `text` this response used, body included. */
  length: number;
}

function parseResponse(text: string): RtspResponse | null {
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const [statusLine, ...lines] = text.slice(0, end).split('\r\n');
  const m = statusLine.match(/^RTSP\/1\.\d (\d{3})/);
  if (!m) return { status: 0, headers: {}, length: text.length };
  const headers: Record<string, string> = {};
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  const length = end + 4 + (Number(headers['content-length']) || 0);
  if (text.length < length) return null; // body still arriving
  return { status: Number(m[1]), headers, length };
}

function authParams(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

/** The Authorization header answering `challenge` (a WWW-Authenticate value). */
export function authorization(challenge: string, method: string, uri: string, user: string, pass: string): string | null {
  if (/^Basic/i.test(challenge)) return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  if (!/^Digest/i.test(challenge)) return null;
  const p = authParams(challenge);
  if (!p.realm || !p.nonce) return null;
  const ha1 = md5(`${user}:${p.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = p.qop?.split(',').map((q) => q.trim()).includes('auth') ? 'auth' : undefined;
  const parts = [`username="${user}"`, `realm="${p.realm}"`, `nonce="${p.nonce}"`, `uri="${uri}"`];
  if (qop) {
    const nc = '00000001';
    const cnonce = randomBytes(8).toString('hex');
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`, `response="${md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)}"`);
  } else {
    parts.push(`response="${md5(`${ha1}:${p.nonce}:${ha2}`)}"`);
  }
  if (p.opaque) parts.push(`opaque="${p.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

/** One connection, up to two DESCRIBEs (the second answering an auth challenge). */
export function checkCamera(
  url: string,
  secret: { username?: string; password?: string } | undefined,
  timeoutMs = 2500,
): Promise<CameraCheck> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, problem: 'error', detail: 'the URL is not valid' });
  }
  const tls = u.protocol === 'rtsps:';
  const port = Number(u.port || (tls ? 322 : 554));
  const host = u.hostname;
  u.username = '';
  u.password = '';
  const uri = u.toString();
  const where = `${host}:${port}`;

  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    let buf = '';
    let cseq = 0;
    let triedAuth = false;
    const finish = (r: CameraCheck) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish(cseq === 0
        ? { ok: false, problem: 'unreachable', detail: `camera unreachable (no answer from ${where})` }
        : { ok: false, problem: 'error', detail: `camera at ${where} accepted the connection but did not answer RTSP` }),
      timeoutMs,
    );
    const describe = (auth?: string) => {
      cseq++;
      sock.write(`DESCRIBE ${uri} RTSP/1.0\r\nCSeq: ${cseq}\r\nAccept: application/sdp\r\nUser-Agent: star-daq-video-check\r\n${auth ? `Authorization: ${auth}\r\n` : ''}\r\n`);
    };

    sock.on('connect', () => {
      if (tls) {
        finish({ ok: true, detail: `camera at ${where} accepts connections (RTSPS: not inspected further)` });
        return;
      }
      describe();
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNREFUSED') finish({ ok: false, problem: 'refused', detail: `camera refused the connection on port ${port} (wrong port, or RTSP is off)` });
      else if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' || e.code === 'ETIMEDOUT') finish({ ok: false, problem: 'unreachable', detail: `camera unreachable (${where})` });
      else if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') finish({ ok: false, problem: 'unreachable', detail: `no such host "${host}"` });
      else finish({ ok: false, problem: 'error', detail: `connecting to ${where}: ${e.code ?? e.message}` });
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const res = parseResponse(buf);
      if (!res) return;
      buf = buf.slice(res.length); // the body (an SDP on 200) is not needed, only skipped
      if (res.status === 200) {
        finish({ ok: true, detail: `camera at ${where} answers with a stream` });
      } else if (res.status === 401) {
        const challenge = res.headers['www-authenticate'] ?? '';
        if (!secret?.username && !secret?.password) {
          finish({ ok: false, problem: 'auth', detail: 'camera needs a username and password' });
        } else if (triedAuth) {
          finish({ ok: false, problem: 'auth', detail: 'camera rejected the username or password' });
        } else {
          const auth = authorization(challenge, 'DESCRIBE', uri, secret.username ?? '', secret.password ?? '');
          if (!auth) finish({ ok: false, problem: 'auth', detail: 'camera asks for an authentication scheme this check does not speak' });
          else { triedAuth = true; describe(auth); }
        }
      } else if (res.status === 404) {
        finish({ ok: false, problem: 'not-found', detail: 'camera has no stream at that path (check the URL after the port)' });
      } else if (res.status === 0) {
        finish({ ok: false, problem: 'error', detail: `${where} is not speaking RTSP` });
      } else {
        finish({ ok: false, problem: 'error', detail: `camera answered RTSP ${res.status}` });
      }
    });
  });
}
