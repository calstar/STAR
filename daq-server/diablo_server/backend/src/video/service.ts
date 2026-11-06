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
    await this.api.addPath(`${PREVIEW_PREFIX}${id}`, { source: withCredentials(url, secret) });
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
      return { ok: false, problem: 'unreachable', detail: `nothing arriving on UDP ${port} -- point HiDesViewer at ${where} (localhost:${port} on the gateway machine itself)` };
    } catch (e) {
      return { ok: false, problem: 'error', detail: (e as Error).message };
    }
  }

  /** The name a sender on the LAN should use for the gateway. */
  ingestHost(): string {
    const host = this.endpoint.host;
    if (host !== '127.0.0.1' && host !== 'localhost') return host;
    const name = hostname();
    return name.includes('.') ? name : `${name}.local`;
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
