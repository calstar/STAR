/**
 * Keeps the gateway in step with config/video.json for as long as the backend runs.
 *
 * Re-reads the config files when they change on disk (mtime), reconciles every
 * RECONCILE_INTERVAL_MS and immediately after a change, and remembers whether the last
 * pass reached the gateway so the pane can say so. Never logs a camera URL.
 */
import { statSync } from 'fs';
import { loadVideoConfig, videoConfigPath, videoSecretsPath, type LoadedVideoConfig } from './config.js';
import {
  desiredPaths, gatewayEndpointFromEnv, HttpGatewayApi, reconcile,
  type GatewayApi, type GatewayEndpoint,
} from './gateway.js';

const RECONCILE_INTERVAL_MS = 5000;

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
