/**
 * /api/video/* -- the video pane's HTTP surface.
 *
 *   GET    /api/video/streams                      streams (no URLs) + gateway status
 *   POST   /api/video/streams/:id/whep             WHEP offer -> gateway, answer back (201)
 *   DELETE /api/video/streams/:id/whep/:session    end that WebRTC session
 *
 * The WHEP routes are a proxy, so a browser's handshake travels the same origin and the same
 * sign-in as the rest of the GUI, and the gateway's HTTP side never faces the LAN. Only the
 * media flows browser <-> gateway directly. A stream id must be configured to be proxied:
 * the browser cannot name an arbitrary gateway path.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { publicStream, STREAM_ID_RE } from './config.js';
import { gatewayPathFor } from './gateway.js';
import type { VideoService } from './service.js';

const MAX_SDP_BYTES = 256 * 1024;
const WHEP_TIMEOUT_MS = 10_000;
const SESSION_RE = /^[0-9a-f-]{8,64}$/i;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readText(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Returns true when the request was a video route (handled, successfully or not). */
export async function handleVideoRequest(
  req: IncomingMessage, res: ServerResponse, pathname: string, video: VideoService,
): Promise<boolean> {
  if (!pathname.startsWith('/api/video/')) return false;
  // The WHEP client reads Location to address its session later.
  res.setHeader('Access-Control-Expose-Headers', 'Location');

  if (pathname === '/api/video/streams' && req.method === 'GET') {
    const { config, errors } = video.current();
    sendJson(res, 200, {
      streams: config.streams.map(publicStream),
      errors,
      gateway: video.gatewayStatus(),
    });
    return true;
  }

  const m = pathname.match(/^\/api\/video\/streams\/([^/]+)\/whep(?:\/([^/]+))?$/);
  if (!m) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }
  const [, id, session] = m;
  if (!STREAM_ID_RE.test(id) || !video.current().config.streams.some((s) => s.id === id)) {
    sendJson(res, 404, { error: `no stream "${id}"` });
    return true;
  }
  const target = `${video.endpoint.webrtcUrl}/${gatewayPathFor(id)}/whep`;

  if (!session && req.method === 'POST') {
    let offer: string;
    try {
      offer = await readText(req, MAX_SDP_BYTES);
    } catch (e) {
      sendJson(res, 413, { error: (e as Error).message });
      return true;
    }
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer,
        signal: AbortSignal.timeout(WHEP_TIMEOUT_MS),
      });
    } catch (e) {
      sendJson(res, 502, { error: `video gateway unreachable (${(e as Error).message})` });
      return true;
    }
    const body = await upstream.text();
    if (upstream.status !== 201) {
      // MediaMTX's own words ("no stream is available on path ...") are the useful part.
      let error = body;
      try { error = JSON.parse(body).error ?? body; } catch { /* plain text */ }
      sendJson(res, upstream.status === 404 ? 404 : 502, { error: `gateway: ${error}` });
      return true;
    }
    const loc = upstream.headers.get('location') ?? '';
    const sid = loc.split('/').pop() ?? '';
    const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
    if (SESSION_RE.test(sid)) headers.Location = `/api/video/streams/${id}/whep/${sid}`;
    res.writeHead(201, headers);
    res.end(body);
    return true;
  }

  if (session && req.method === 'DELETE') {
    if (!SESSION_RE.test(session)) {
      sendJson(res, 400, { error: 'bad session id' });
      return true;
    }
    try {
      const upstream = await fetch(`${target}/${session}`, { method: 'DELETE', signal: AbortSignal.timeout(WHEP_TIMEOUT_MS) });
      res.writeHead(upstream.ok ? 200 : upstream.status === 404 ? 404 : 502);
      res.end();
    } catch {
      // The gateway is gone, and the session with it.
      res.writeHead(200);
      res.end();
    }
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
