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
import type { LoadedVideoConfig, RtspStream, VideoSecrets } from './config.js';

export const MANAGED_PREFIX = 'raw/';

/** `raw/<id>` pulls a stream's main URL; `raw/<id>/low` its low-res URL, when it has one. */
export function gatewayPathFor(streamId: string, low = false): string {
  return `${MANAGED_PREFIX}${streamId}${low ? '/low' : ''}`;
}

/** Path settings the backend sets. Everything else is the gateway's pathDefaults. */
export interface ManagedPathConf {
  source: string;
  /** Pull only while watched. Off for anything recording (the buffer never stops) and for
   *  pushed (UDP) sources, which are listeners. */
  sourceOnDemand: boolean;
  /** Write the rolling buffer (video/mediamtx.yml recordPath) -- "include in recording". */
  record: boolean;
}

/** What MediaMTX listens on for a pushed MPEG-TS stream (every interface). */
export function udpSource(port: number): string {
  return `udp+mpegts://0.0.0.0:${port}`;
}

/** The camera URL the gateway pulls: the configured URL with this machine's credentials. */
export function cameraSource(stream: RtspStream, secrets: VideoSecrets, low = false): string {
  return withCredentials(low && stream.lowResUrl ? stream.lowResUrl : stream.url, secrets.streams[stream.id]);
}

export function withCredentials(url: string, secret: { username?: string; password?: string } | undefined): string {
  if (!secret?.username && !secret?.password) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(secret.username ?? '');
  u.password = encodeURIComponent(secret.password ?? '');
  return u.toString();
}

/** Temporary paths for the editor's live preview of an unsaved URL. Never reconciled. */
export const PREVIEW_PREFIX = 'preview/';

export function desiredPaths(loaded: Pick<LoadedVideoConfig, 'config' | 'secrets'>): Map<string, ManagedPathConf> {
  const out = new Map<string, ManagedPathConf>();
  for (const s of loaded.config.streams) {
    if (s.kind === 'udp') {
      // A listener, not a pull: it must be up before HiDesViewer sends, whoever is watching.
      out.set(gatewayPathFor(s.id), { source: udpSource(s.port), sourceOnDemand: false, record: s.record });
      continue;
    }
    // A stream in the buffer is pulled all the time; one that is not, only while watched.
    out.set(gatewayPathFor(s.id), { source: cameraSource(s, loaded.secrets), sourceOnDemand: !s.record, record: s.record });
    // Same camera, same credentials, its sub stream: never recorded (recordings are main),
    // pulled only while a small tile shows it.
    if (s.lowResUrl) out.set(gatewayPathFor(s.id, true), { source: cameraSource(s, loaded.secrets, true), sourceOnDemand: true, record: false });
  }
  return out;
}

export interface GatewayEndpoint {
  /** Control API, e.g. http://127.0.0.1:8887 (video/mediamtx.yml apiAddress) */
  apiUrl: string;
  /** WebRTC/WHEP HTTP listener, e.g. http://127.0.0.1:8889 */
  webrtcUrl: string;
  /** The video agent beside it (video/agent.mjs), e.g. http://127.0.0.1:8886 */
  agentUrl?: string;
  /** Authorization header for a remote gateway (user "daq", see scripts/video-gateway.sh). */
  auth?: string;
  /** The host as an operator would name it. */
  host: string;
}

/** The user scripts/video-gateway.sh admits with the gateway password. */
export const GATEWAY_USER = 'daq';

/**
 * Where the gateway is. VIDEO_GATEWAY_HOST (tests, unusual setups) wins; then this machine's
 * setting from the Video view (the local file); then this machine.
 */
export function gatewayEndpoint(
  setting: { host?: string; password?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): GatewayEndpoint {
  const host = env.VIDEO_GATEWAY_HOST || setting?.host || '127.0.0.1';
  const apiPort = env.VIDEO_GATEWAY_API_PORT || '8887';
  const webrtcPort = env.VIDEO_GATEWAY_WEBRTC_PORT || '8889';
  const agentPort = env.VIDEO_AGENT_PORT || '8886';
  const auth = setting?.password ? `Basic ${Buffer.from(`${GATEWAY_USER}:${setting.password}`).toString('base64')}` : undefined;
  return {
    apiUrl: `http://${host}:${apiPort}`,
    webrtcUrl: `http://${host}:${webrtcPort}`,
    agentUrl: `http://${host}:${agentPort}`,
    host,
    ...(auth ? { auth } : {}),
  };
}

export function gatewayEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayEndpoint {
  return gatewayEndpoint(undefined, env);
}

/** Generous on purpose: MediaMTX answers a wrong password only after a deliberate ~2 s pause
 *  (brute-force protection), and a timeout must not turn "wrong password" into "unreachable". */
const API_TIMEOUT_MS = 8000;

/** The four control-API calls reconcile needs. An interface so tests can count calls. */
export interface GatewayApi {
  listPaths(): Promise<Map<string, Record<string, unknown>>>;
  addPath(name: string, conf: ManagedPathConf): Promise<void>;
  replacePath(name: string, conf: ManagedPathConf): Promise<void>;
  deletePath(name: string): Promise<void>;
  /** Is media arriving on this path right now? */
  pathReady(name: string): Promise<boolean>;
}

export class GatewayError extends Error {}

export class HttpGatewayApi implements GatewayApi {
  constructor(private readonly apiUrl: string, private readonly auth?: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.auth ? { Authorization: this.auth } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (e) {
      throw new GatewayError(`gateway unreachable at ${this.apiUrl} (${(e as Error).message})`);
    }
    const text = await res.text();
    if (res.status === 401) {
      throw new GatewayError(`gateway at ${this.apiUrl} refused the password (set the same one with scripts/video-gateway.sh --set-password there)`);
    }
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

  async pathReady(name: string): Promise<boolean> {
    try {
      return !!(await this.call('GET', `/v3/paths/get/${name}`))?.ready;
    } catch (e) {
      if (/: 404 /.test((e as Error).message)) return false; // no source yet: not ready
      throw e;
    }
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
