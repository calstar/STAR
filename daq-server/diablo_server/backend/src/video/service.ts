/**
 * Keeps the gateway in step with config/video.json for as long as the backend runs.
 *
 * Re-reads the config files when they change on disk (mtime), reconciles every
 * RECONCILE_INTERVAL_MS and immediately after a change, and remembers whether the last
 * pass reached the gateway so the pane can say so. Never logs a camera URL.
 */
import { statSync } from 'fs';
import { randomBytes } from 'crypto';
import {
  checkRtspUrl, loadVideoConfig, videoConfigPath, videoSecretsPath, VideoConfigError,
  type LoadedVideoConfig,
} from './config.js';
import {
  desiredPaths, gatewayEndpointFromEnv, HttpGatewayApi, reconcile, withCredentials, PREVIEW_PREFIX,
  type GatewayApi, type GatewayEndpoint,
} from './gateway.js';

const RECONCILE_INTERVAL_MS = 5000;
/** An editor's preview lives this long unless it is closed sooner. */
export const PREVIEW_TTL_MS = 2 * 60_000;
export const PREVIEW_ID_RE = /^[0-9a-f]{12}$/;

export interface GatewayStatus {
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
  private status: GatewayStatus = { reachable: false, error: 'not contacted yet' };
  /** Live previews: id -> expiry (epoch ms). */
  private previews = new Map<string, number>();

  constructor(
    readonly endpoint: GatewayEndpoint = gatewayEndpointFromEnv(),
    private readonly api: GatewayApi = new HttpGatewayApi(endpoint.apiUrl),
  ) {
    this.loaded = this.reload(true);
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
    return { ...this.status };
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
