/**
 * The DAQ backend's side of the video gateway (MediaMTX).
 *
 * The backend owns the stream list; the gateway holds it in memory only. Every few seconds
 * (and at once after a config change) `reconcile` reads the gateway's path list and makes
 * its `raw/*` paths exactly the configured streams: add what is missing, replace what
 * differs, delete what is no longer configured. Paths outside `raw/` (the static ones in
 * daq-server/video/mediamtx.yml) are never touched. A gateway that restarts comes back
 * empty and is refilled on the next pass, with no operator action.
 *
 * Audio: the live view strips camera audio by negotiation, not by a relay. The browser
 * offers a single video transceiver (frontend lib/video/whep.ts), so the gateway has no
 * audio m-line to send on; nothing sits in the video path to add latency. Proven against
 * the real gateway by test/video-gateway.integration.test.ts.
 */
import type { LoadedVideoConfig, VideoStream, VideoSecrets } from './config.js';

export const MANAGED_PREFIX = 'raw/';

export function gatewayPathFor(streamId: string): string {
  return `${MANAGED_PREFIX}${streamId}`;
}

/** Path settings the backend sets. Everything else is the gateway's pathDefaults. */
export interface ManagedPathConf {
  source: string;
}

/** The camera URL the gateway pulls: the configured URL with this machine's credentials. */
export function cameraSource(stream: VideoStream, secrets: VideoSecrets): string {
  const secret = secrets.streams[stream.id];
  if (!secret?.username && !secret?.password) return stream.url;
  const u = new URL(stream.url);
  u.username = encodeURIComponent(secret.username ?? '');
  u.password = encodeURIComponent(secret.password ?? '');
  return u.toString();
}

export function desiredPaths(loaded: Pick<LoadedVideoConfig, 'config' | 'secrets'>): Map<string, ManagedPathConf> {
  const out = new Map<string, ManagedPathConf>();
  for (const s of loaded.config.streams) out.set(gatewayPathFor(s.id), { source: cameraSource(s, loaded.secrets) });
  return out;
}

export interface GatewayEndpoint {
  /** Control API, e.g. http://127.0.0.1:9997 */
  apiUrl: string;
  /** WebRTC/WHEP HTTP listener, e.g. http://127.0.0.1:8889 */
  webrtcUrl: string;
}

export function gatewayEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayEndpoint {
  const host = env.VIDEO_GATEWAY_HOST || '127.0.0.1';
  const apiPort = env.VIDEO_GATEWAY_API_PORT || '9997';
  const webrtcPort = env.VIDEO_GATEWAY_WEBRTC_PORT || '8889';
  return { apiUrl: `http://${host}:${apiPort}`, webrtcUrl: `http://${host}:${webrtcPort}` };
}

const API_TIMEOUT_MS = 3000;

/** The four control-API calls reconcile needs. An interface so tests can count calls. */
export interface GatewayApi {
  listPaths(): Promise<Map<string, Record<string, unknown>>>;
  addPath(name: string, conf: ManagedPathConf): Promise<void>;
  replacePath(name: string, conf: ManagedPathConf): Promise<void>;
  deletePath(name: string): Promise<void>;
}

export class GatewayError extends Error {}

export class HttpGatewayApi implements GatewayApi {
  constructor(private readonly apiUrl: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (e) {
      throw new GatewayError(`gateway unreachable at ${this.apiUrl} (${(e as Error).message})`);
    }
    const text = await res.text();
    if (!res.ok) {
      // MediaMTX answers {"status":"error","error":"..."}; never include the request body,
      // which carries camera credentials.
      let msg = text;
      try { msg = JSON.parse(text).error ?? text; } catch { /* plain text */ }
      throw new GatewayError(`gateway ${method} ${path.split('?')[0]} failed: ${res.status} ${msg}`);
    }
    return text ? JSON.parse(text) : undefined;
  }

  async listPaths(): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    for (let page = 0; ; page++) {
      const data = await this.call('GET', `/v3/config/paths/list?itemsPerPage=500&page=${page}`);
      for (const item of data?.items ?? []) out.set(item.name, item);
      if (page + 1 >= (data?.pageCount ?? 1)) return out;
    }
  }

  async addPath(name: string, conf: ManagedPathConf): Promise<void> {
    await this.call('POST', `/v3/config/paths/add/${name}`, conf);
  }

  async replacePath(name: string, conf: ManagedPathConf): Promise<void> {
    await this.call('POST', `/v3/config/paths/replace/${name}`, conf);
  }

  async deletePath(name: string): Promise<void> {
    await this.call('DELETE', `/v3/config/paths/delete/${name}`);
  }
}

export interface ReconcileResult {
  added: string[];
  replaced: string[];
  deleted: string[];
}

function differs(have: Record<string, unknown>, want: ManagedPathConf): boolean {
  return (Object.keys(want) as (keyof ManagedPathConf)[]).some((k) => have[k] !== want[k]);
}

/** Make the gateway's managed paths exactly `desired`. Idempotent: a second pass is a no-op. */
export async function reconcile(api: GatewayApi, desired: Map<string, ManagedPathConf>): Promise<ReconcileResult> {
  const have = await api.listPaths();
  const result: ReconcileResult = { added: [], replaced: [], deleted: [] };
  for (const [name, want] of desired) {
    const cur = have.get(name);
    if (!cur) {
      await api.addPath(name, want);
      result.added.push(name);
    } else if (differs(cur, want)) {
      await api.replacePath(name, want);
      result.replaced.push(name);
    }
  }
  for (const name of have.keys()) {
    if (name.startsWith(MANAGED_PREFIX) && !desired.has(name)) {
      await api.deletePath(name);
      result.deleted.push(name);
    }
  }
  return result;
}
