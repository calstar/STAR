/**
 * Keeps the gateway in step with config/video.json for as long as the backend runs.
 *
 * Re-reads the config files when they change on disk (mtime), reconciles every
 * RECONCILE_INTERVAL_MS and immediately after a change, and remembers whether the last
 * pass reached the gateway so the pane can say so. Never logs a camera URL.
 */
import { statSync } from 'fs';
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { execFileSync } from 'child_process';
import {
  checkRtspUrl, loadVideoConfig, videoConfigPath, videoSecretsPath, VideoConfigError,
  type LoadedVideoConfig,
} from './config.js';
import { checkCamera, type CameraCheck } from './camera-check.js';
import {
  desiredPaths, gatewayEndpoint, gatewayPathFor, HttpGatewayApi, reconcile, withCredentials, PREVIEW_PREFIX,
  type GatewayApi, type GatewayEndpoint,
} from './gateway.js';

const RECONCILE_INTERVAL_MS = 5000;
/** An editor's preview lives this long unless it is closed sooner. */
export const PREVIEW_TTL_MS = 2 * 60_000;
export const PREVIEW_ID_RE = /^[0-9a-f]{12}$/;
/** A camera check is reused this long, so every screen's failing tile does not probe at once. */
const CHECK_TTL_MS = 5000;

export interface GatewayStatus {
  /** Where the backend is looking for it. */
  host: string;
  reachable: boolean;
  /** Why the last pass failed, if it did. */
  error?: string;
  /** Epoch ms of the last pass that reached the gateway. */
  lastSyncAt?: number;
}

/** What the video agent on the gateway machine says about the buffer (video/agent.mjs). */
export interface BufferStatus {
  /** The agent answered: Save and Record are possible. */
  available: boolean;
  error?: string;
  bufferSeconds?: number;
  /** Seconds currently buffered, per stream id. */
  buffered?: Record<string, number>;
  disk?: { freeBytes: number; totalBytes: number } | null;
  /** What the buffer is writing now, all streams together: for "hours left". */
  bytesPerSecond?: number;
  recording?: { active: boolean; stopping?: boolean; folder?: string; startedAt?: number; streams?: string[]; elapsedSeconds?: number };
  lastRecording?: (SaveResult & { startedAt: number; stoppedAt: number; reason: string }) | null;
  /** The disk guard in force (config/video.json recording). */
  refuseBelowBytes?: number;
  stopBelowBytes?: number;
}

export interface SaveResult {
  folder: string;
  seconds: number;
  streams: { stream: string; file?: string; bytes?: number; seconds?: number; gaps?: number; error?: string }[];
}

export class AgentError extends Error {}

const AGENT_STATUS_TIMEOUT_MS = 8000;
/** A Save concatenates up to 5 minutes per stream; ffmpeg does that in about a second each. */
const AGENT_SAVE_TIMEOUT_MS = 120_000;

let cachedLanName: string | undefined;

/**
 * This machine's name as other machines on the LAN can resolve it. On macOS that is the
 * Bonjour name (`scutil --get LocalHostName`, e.g. Theos-MacBook-Pro-774.local) -- *not*
 * the Unix hostname, which mDNS does not announce. On Linux avahi announces the hostname.
 */
export function lanName(platform: NodeJS.Platform = process.platform, run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' })): string {
  if (cachedLanName && platform === process.platform) return cachedLanName;
  let name = hostname();
  if (platform === 'darwin') {
    try { name = run('scutil', ['--get', 'LocalHostName']).trim() || name; } catch { /* keep hostname */ }
  }
  const out = name.includes('.') ? name : `${name}.local`;
  if (platform === process.platform) cachedLanName = out;
  return out;
}

function mtime(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return -1; }
}

export class VideoService {
  private loaded: LoadedVideoConfig;
  private stamp = '';
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private status: Omit<GatewayStatus, 'host'> = { reachable: false, error: 'not contacted yet' };
  private client: { key: string; api: GatewayApi } | undefined;
  private buffer: BufferStatus = { available: false, error: 'not contacted yet' };
  /** Live previews: id -> expiry (epoch ms). */
  private previews = new Map<string, number>();
  /** Recent camera checks: `${id}` or `${id}/low` -> result in flight or done, and when. */
  private checks = new Map<string, { at: number; result: Promise<CameraCheck> }>();

  /**
   * With no arguments the gateway is wherever this machine's setting says (the Video view's
   * Edit > Gateway, kept in the local file), re-read on every use. Tests pin both.
   */
  constructor(
    private readonly fixedEndpoint?: GatewayEndpoint,
    private readonly fixedApi?: GatewayApi,
  ) {
    this.loaded = this.reload(true);
  }

  get endpoint(): GatewayEndpoint {
    return this.fixedEndpoint ?? gatewayEndpoint(this.current().secrets.gateway);
  }

  private get api(): GatewayApi {
    if (this.fixedApi) return this.fixedApi;
    const ep = this.endpoint;
    const key = `${ep.apiUrl}|${ep.auth ?? ''}`;
    if (this.client?.key !== key) this.client = { key, api: new HttpGatewayApi(ep.apiUrl, ep.auth) };
    return this.client.api;
  }

  private reload(force = false): LoadedVideoConfig {
    const stamp = `${mtime(videoConfigPath())}:${mtime(videoSecretsPath())}`;
    if (!force && stamp === this.stamp) return this.loaded;
    this.stamp = stamp;
    this.loaded = loadVideoConfig();
    for (const e of this.loaded.errors) console.warn(`[video] ${e}`);
    return this.loaded;
  }

  current(): LoadedVideoConfig {
    return this.reload();
  }

  gatewayStatus(): GatewayStatus {
    return { host: this.endpoint.host, ...this.status };
  }

  /** One reconcile pass. Concurrent callers share the pass in flight. */
  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        await this.sweepPreviews();
        const r = await reconcile(this.api, desiredPaths(this.reload()));
        const changed = [...r.added, ...r.replaced, ...r.deleted];
        if (changed.length || !this.status.reachable) {
          console.log(`[video] gateway in sync (${this.endpoint.apiUrl}): +${r.added.length} ~${r.replaced.length} -${r.deleted.length}`);
        }
        this.status = { reachable: true, lastSyncAt: Date.now() };
        await this.refreshBuffer();
      } catch (e) {
        const error = (e as Error).message;
        if (this.status.error !== error) console.warn(`[video] ${error}`);
        this.status = { ...this.status, reachable: false, error };
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /**
   * Put an unsaved URL on the gateway so the editor can watch it before saving. With
   * `fromStreamId` and no password given, the saved credentials of that stream are used,
   * so editing a URL does not mean retyping a password the browser was never shown.
   */
  async createPreview(input: { url: unknown; username?: string; password?: string; fromStreamId?: string }): Promise<string> {
    const errors: string[] = [];
    const url = checkRtspUrl(input.url, 'url', errors);
    if (!url) throw new VideoConfigError(400, errors);
    const saved = input.fromStreamId ? this.current().secrets.streams[input.fromStreamId] : undefined;
    const secret = {
      username: input.username !== undefined ? input.username : saved?.username,
      password: input.password !== undefined ? input.password : saved?.password,
    };
    const id = randomBytes(6).toString('hex');
    await this.api.addPath(`${PREVIEW_PREFIX}${id}`, { source: withCredentials(url, secret), sourceOnDemand: true, record: false });
    this.previews.set(id, Date.now() + PREVIEW_TTL_MS);
    return id;
  }

  hasPreview(id: string): boolean {
    return (this.previews.get(id) ?? 0) > Date.now();
  }

  async deletePreview(id: string): Promise<void> {
    if (!this.previews.delete(id)) return;
    try { await this.api.deletePath(`${PREVIEW_PREFIX}${id}`); } catch { /* gateway gone: so is the path */ }
  }

  private async sweepPreviews(): Promise<void> {
    const now = Date.now();
    for (const [id, until] of this.previews) if (until <= now) await this.deletePreview(id);
  }

  /** A request to the video agent beside the gateway, with the gateway password. */
  private async agent<T>(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<T> {
    const ep = this.endpoint;
    if (!ep.agentUrl) throw new AgentError('no video agent configured');
    let res: Response;
    try {
      res = await fetch(`${ep.agentUrl}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(ep.auth ? { Authorization: ep.auth } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new AgentError(`video agent unreachable at ${ep.agentUrl} (${(e as Error).message})`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new AgentError('video agent refused the password');
    if (res.status === 409) throw new AgentError(data?.error ?? 'refused');
    if (!res.ok) throw new AgentError(data?.error ?? `video agent answered ${res.status}`);
    return data as T;
  }

  private async refreshBuffer(): Promise<void> {
    try {
      const s = await this.agent<Omit<BufferStatus, 'available'>>('GET', '/status', undefined, AGENT_STATUS_TIMEOUT_MS);
      const g = this.guardBytes();
      this.buffer = {
        available: true,
        bufferSeconds: s.bufferSeconds,
        buffered: s.buffered,
        disk: s.disk,
        bytesPerSecond: s.bytesPerSecond,
        recording: s.recording,
        lastRecording: s.lastRecording,
        ...g,
      };
    } catch (e) {
      this.buffer = { available: false, error: (e as Error).message };
    }
  }

  bufferStatus(): BufferStatus {
    return { ...this.buffer };
  }

  private guardBytes() {
    const r = this.current().config.recording;
    return { refuseBelowBytes: r.refuseBelowGB * 1e9, stopBelowBytes: r.stopBelowGB * 1e9 };
  }

  /** Record every stream marked "include in recording", from now until Stop. */
  async startRecording(): Promise<{ folder: string; startedAt: number; streams: string[] }> {
    const streams = this.current().config.streams.filter((s) => s.record).map((s) => s.id);
    if (!streams.length) throw new AgentError('no stream is marked "include in recording"');
    const started = await this.agent<{ folder: string; startedAt: number; streams: string[] }>(
      'POST', '/record/start', { streams, ...this.guardBytes() }, AGENT_STATUS_TIMEOUT_MS);
    await this.refreshBuffer();
    return started;
  }

  async stopRecording(): Promise<SaveResult & { reason: string }> {
    const done = await this.agent<SaveResult & { reason: string }>('POST', '/record/stop', {}, AGENT_SAVE_TIMEOUT_MS);
    await this.refreshBuffer();
    return done;
  }

  /** Keep the last buffer window of every stream marked "include in recording". */
  async save(): Promise<SaveResult> {
    const streams = this.current().config.streams.filter((s) => s.record).map((s) => s.id);
    if (!streams.length) throw new AgentError('no stream is marked "include in recording"');
    return this.agent<SaveResult>('POST', '/save', { streams, label: 'save' }, AGENT_SAVE_TIMEOUT_MS);
  }

  /** Why stream `id` (or its low-res URL) is not giving video. undefined: no such stream. */
  checkStream(id: string, low = false): Promise<CameraCheck> | undefined {
    const { config, secrets } = this.current();
    const s = config.streams.find((x) => x.id === id);
    if (s?.kind === 'udp') return low ? undefined : this.checkUdp(s.id, s.port);
    const url = s && (low ? s.lowResUrl : s.url);
    if (!s || !url) return undefined;
    const key = `${id}${low ? '/low' : ''}`;
    const hit = this.checks.get(key);
    if (hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.result;
    const result = checkCamera(url, secrets.streams[id]);
    this.checks.set(key, { at: Date.now(), result });
    return result;
  }

  /** A pushed stream has no camera to ask: ask the gateway whether TS is arriving. */
  private async checkUdp(id: string, port: number): Promise<CameraCheck> {
    const where = `${this.ingestHost()}:${port}`;
    try {
      if (await this.api.pathReady(gatewayPathFor(id))) return { ok: true, detail: `MPEG-TS arriving on UDP ${port}` };
      return { ok: false, problem: 'no-data', detail: `nothing arriving on UDP ${port} -- point HiDesViewer at ${where} (localhost:${port} on the gateway machine itself)` };
    } catch (e) {
      return { ok: false, problem: 'error', detail: (e as Error).message };
    }
  }

  /** The name a sender on the LAN should use for the gateway. */
  ingestHost(): string {
    const host = this.endpoint.host;
    if (host !== '127.0.0.1' && host !== 'localhost') return host;
    return lanName();
  }

  start(): void {
    if (this.timer) return;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
