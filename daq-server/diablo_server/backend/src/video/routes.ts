/**
 * /api/video/* -- the video pane's HTTP surface.
 *
 *   GET    /api/video/streams                         streams (no URLs) + gateway status
 *   GET    /api/video/config                          the editor's view (URLs, usernames, passwordSet)
 *   PUT    /api/video/config                          save the editor's streams (all-or-nothing)
 *   POST   /api/video/previews                        put an unsaved URL on the gateway -> { id }
 *   DELETE /api/video/previews/:id                    drop that preview
 *   POST   /api/video/{streams|previews}/:id/whep     WHEP offer -> gateway, answer back (201)
 *   DELETE /api/video/{streams|previews}/:id/whep/:s  end that WebRTC session
 *   ...    /api/video/streams/:id/low/whep[/:s]       the same, for a stream's low-res URL
 *   GET    /api/video/streams/:id[/low]/check         why that camera is not giving video
 *
 * The WHEP routes are a proxy, so a browser's handshake travels the same origin and the same
 * sign-in as the rest of the GUI, and the gateway's HTTP side never faces the LAN. Only the
 * media flows browser <-> gateway directly. Only a configured stream or a live preview can be
 * proxied: the browser cannot name an arbitrary gateway path.
 *
 * Editing is open to anyone signed in (VIDCOMM decision); passwords are write-only.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  editableConfig, publicStream, saveVideoConfig, STREAM_ID_RE, VideoConfigError,
  type CredentialChange,
} from './config.js';
import { gatewayPathFor, PREVIEW_PREFIX } from './gateway.js';
import { PREVIEW_ID_RE, type VideoService } from './service.js';

const MAX_BODY_BYTES = 256 * 1024;
const WHEP_TIMEOUT_MS = 10_000;
const SESSION_RE = /^[0-9a-f-]{8,64}$/i;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

class BodyTooLarge extends Error {}

function readText(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new BodyTooLarge('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<any> {
  const text = await readText(req);
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new VideoConfigError(400, ['body is not valid JSON']);
  }
}

/** Forward a WHEP offer or teardown to the gateway path `gatewayPath`. */
async function proxyWhep(
  req: IncomingMessage, res: ServerResponse, video: VideoService,
  gatewayPath: string, routeBase: string, session: string | undefined,
): Promise<void> {
  const target = `${video.endpoint.webrtcUrl}/${gatewayPath}/whep`;

  if (!session && req.method === 'POST') {
    const offer = await readText(req);
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', ...(video.endpoint.auth ? { Authorization: video.endpoint.auth } : {}) },
        body: offer,
        signal: AbortSignal.timeout(WHEP_TIMEOUT_MS),
      });
    } catch (e) {
      sendJson(res, 502, { error: `video gateway unreachable (${(e as Error).message})` });
      return;
    }
    const body = await upstream.text();
    if (upstream.status !== 201) {
      // MediaMTX's own words ("no stream is available on path ...") are the useful part.
      let error = body;
      try { error = JSON.parse(body).error ?? body; } catch { /* plain text */ }
      sendJson(res, upstream.status === 404 ? 404 : 502, { error: `gateway: ${error}` });
      return;
    }
    const sid = (upstream.headers.get('location') ?? '').split('/').pop() ?? '';
    const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
    if (SESSION_RE.test(sid)) headers.Location = `${routeBase}/whep/${sid}`;
    res.writeHead(201, headers);
    res.end(body);
    return;
  }

  if (session && req.method === 'DELETE') {
    if (!SESSION_RE.test(session)) {
      sendJson(res, 400, { error: 'bad session id' });
      return;
    }
    try {
      const upstream = await fetch(`${target}/${session}`, {
        method: 'DELETE',
        headers: video.endpoint.auth ? { Authorization: video.endpoint.auth } : undefined,
        signal: AbortSignal.timeout(WHEP_TIMEOUT_MS),
      });
      res.writeHead(upstream.ok ? 200 : upstream.status === 404 ? 404 : 502);
    } catch {
      res.writeHead(200); // the gateway is gone, and the session with it
    }
    res.end();
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

function credentialsFrom(raw: unknown): Record<string, CredentialChange> {
  const out: Record<string, CredentialChange> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, any>)) {
    if (!v || typeof v !== 'object') continue;
    const c: CredentialChange = {};
    if (typeof v.username === 'string') c.username = v.username;
    if (v.password === null || typeof v.password === 'string') c.password = v.password;
    out[id] = c;
  }
  return out;
}

/** Returns true when the request was a video route (handled, successfully or not). */
export async function handleVideoRequest(
  req: IncomingMessage, res: ServerResponse, pathname: string, video: VideoService,
): Promise<boolean> {
  if (!pathname.startsWith('/api/video/')) return false;
  // The WHEP client reads Location to address its session later.
  res.setHeader('Access-Control-Expose-Headers', 'Location');

  try {
    if (pathname === '/api/video/streams' && req.method === 'GET') {
      const { config, errors } = video.current();
      sendJson(res, 200, { streams: config.streams.map(publicStream), layout: config.layout, errors, gateway: video.gatewayStatus() });
      return true;
    }

    if (pathname === '/api/video/config' && req.method === 'GET') {
      sendJson(res, 200, editableConfig());
      return true;
    }

    if (pathname === '/api/video/config' && req.method === 'PUT') {
      const body = await readJson(req);
      const saved = saveVideoConfig(
        {
          streams: body.streams,
          layout: body.layout,
          credentials: credentialsFrom(body.credentials),
          gateway: body.gateway && typeof body.gateway === 'object' ? {
            ...(typeof body.gateway.host === 'string' ? { host: body.gateway.host } : {}),
            ...(body.gateway.password === null || typeof body.gateway.password === 'string' ? { password: body.gateway.password } : {}),
          } : undefined,
        },
        typeof body.revision === 'string' ? body.revision : '',
      );
      await video.sync(); // live for everyone now, not at the next tick
      sendJson(res, 200, saved);
      return true;
    }

    if (pathname === '/api/video/previews' && req.method === 'POST') {
      const body = await readJson(req);
      const id = await video.createPreview({
        url: body.url,
        username: typeof body.username === 'string' ? body.username : undefined,
        password: typeof body.password === 'string' ? body.password : undefined,
        fromStreamId: typeof body.fromStreamId === 'string' ? body.fromStreamId : undefined,
      });
      sendJson(res, 201, { id });
      return true;
    }

    const check = pathname.match(/^\/api\/video\/streams\/([^/]+)(\/low)?\/check$/);
    if (check && req.method === 'GET') {
      const result = STREAM_ID_RE.test(check[1]) ? video.checkStream(check[1], !!check[2]) : undefined;
      if (!result) sendJson(res, 404, { error: `no stream "${check[1]}"` });
      else sendJson(res, 200, await result);
      return true;
    }

    const preview = pathname.match(/^\/api\/video\/previews\/([^/]+)$/);
    if (preview && req.method === 'DELETE') {
      if (PREVIEW_ID_RE.test(preview[1])) await video.deletePreview(preview[1]);
      res.writeHead(200);
      res.end();
      return true;
    }

    const whep = pathname.match(/^\/api\/video\/(streams|previews)\/([^/]+)(\/low)?\/whep(?:\/([^/]+))?$/);
    if (whep) {
      const [, kind, id, lowPart, session] = whep;
      const low = !!lowPart;
      const routeBase = `/api/video/${kind}/${id}${low ? '/low' : ''}`;
      if (kind === 'streams') {
        const stream = STREAM_ID_RE.test(id) ? video.current().config.streams.find((s) => s.id === id) : undefined;
        if (!stream || (low && !stream.lowResUrl)) {
          sendJson(res, 404, { error: low ? `no low-res stream "${id}"` : `no stream "${id}"` });
          return true;
        }
        await proxyWhep(req, res, video, gatewayPathFor(id, low), routeBase, session);
      } else {
        if (low || !PREVIEW_ID_RE.test(id) || !video.hasPreview(id)) {
          sendJson(res, 404, { error: 'preview expired' });
          return true;
        }
        await proxyWhep(req, res, video, `${PREVIEW_PREFIX}${id}`, routeBase, session);
      }
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof VideoConfigError) sendJson(res, e.status, { error: e.errors.join('; '), errors: e.errors });
    else if (e instanceof BodyTooLarge) sendJson(res, 413, { error: 'body too large' });
    else sendJson(res, 502, { error: (e as Error).message });
  }
  return true;
}
