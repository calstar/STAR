/**
 * Authoritative DAQ run-session engine: owns the auto-stop deadline (so a run
 * stops even if every browser is closed), fires a high-priority warning
 * `SESSION_WARN_LEAD_MS` before expiry, and starts each run into a fresh
 * timestamped Elodin DB (so no run ever clobbers another).
 *
 * Disabled entirely when SESSION_SERVICE_MODE=off (the launch-site laptop): no
 * timers, no auto-stop, `enabled=false` so the UI hides the button.
 */
import { statfsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SessionStatus, NotificationPayload } from '../../shared/types.js';
import { MessageType } from '../../shared/types.js';
import { ServiceController, getSessionServiceMode } from './service-controller.js';
import { loadSession, saveSession } from './session-state.js';

// Default 5 min; override low (e.g. 60000) to exercise the warning quickly in tests.
const WARN_LEAD_MS = parseInt(process.env.SESSION_WARN_LEAD_MS || '300000', 10);
const ELODIN_ROOT = join(homedir(), '.local', 'share', 'elodin');

type Broadcast = (message: object) => void;
type Notify = (payload: NotificationPayload) => void;

function timestampName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `daq_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function freeDiskBytes(): number | null {
  try {
    const s = statfsSync(ELODIN_ROOT);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

class SessionManager {
  private readonly mode = getSessionServiceMode();
  private readonly enabled = this.mode !== 'off';
  private readonly controller = new ServiceController(this.mode);
  private broadcast: Broadcast = () => {};
  private notify: Notify = () => {};

  private active = false;
  private dbDir: string | null = null;
  private keepData = false;
  private deadlineMs: number | null = null;
  private durationMs: number | null = null;
  private warnTimer: NodeJS.Timeout | null = null;
  private stopTimer: NodeJS.Timeout | null = null;

  init(broadcast: Broadcast, notify: Notify): void {
    this.broadcast = broadcast;
    this.notify = notify;
    if (!this.enabled) return;
    // Recover a session that outlived a backend restart.
    const persisted = loadSession();
    if (persisted?.active) {
      this.active = true;
      this.dbDir = persisted.dbDir;
      this.keepData = persisted.keepData;
      this.deadlineMs = persisted.deadlineMs;
      this.durationMs = persisted.durationMs;
      if (this.deadlineMs != null && this.deadlineMs <= Date.now()) {
        void this.stop(true); // expired while we were down
      } else {
        this.scheduleTimers();
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getStatus(): SessionStatus {
    return {
      enabled: this.enabled,
      active: this.active,
      dbDir: this.dbDir,
      keepData: this.keepData,
      deadlineMs: this.deadlineMs,
      remainingMs: this.deadlineMs != null ? this.deadlineMs - Date.now() : null,
      freeDiskBytes: this.enabled ? freeDiskBytes() : null,
    };
  }

  private emit(): void {
    this.broadcast({
      type: MessageType.SESSION_UPDATE,
      timestamp: Date.now(),
      payload: this.getStatus(),
    });
  }

  private clearTimers(): void {
    if (this.warnTimer) {
      clearTimeout(this.warnTimer);
      this.warnTimer = null;
    }
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private scheduleTimers(): void {
    this.clearTimers();
    if (this.deadlineMs == null) return;
    const now = Date.now();
    const warnAt = this.deadlineMs - WARN_LEAD_MS;
    if (warnAt > now) {
      this.warnTimer = setTimeout(() => this.fireWarning(), warnAt - now);
    }
    this.stopTimer = setTimeout(() => void this.stop(true), Math.max(0, this.deadlineMs - now));
  }

  private fireWarning(): void {
    const mins = Math.max(1, Math.round(WARN_LEAD_MS / 60000));
    this.notify({
      key: 'session-timeout',
      category: 'error',
      message: `Run auto-stops in ${mins} min — add time in Session`,
      timestampMs: Date.now(),
      ongoing: true,
    });
  }

  private persist(): void {
    saveSession({
      active: this.active,
      dbDir: this.dbDir,
      keepData: this.keepData,
      deadlineMs: this.deadlineMs,
      durationMs: this.durationMs,
    });
  }

  async start(keepData: boolean, durationMs: number): Promise<void> {
    if (!this.enabled) throw new Error('Session control is disabled in this mode.');
    if (this.active) throw new Error('A run is already active.');
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error('durationMs must be a positive number.');
    }
    this.dbDir = join(ELODIN_ROOT, timestampName());
    this.keepData = keepData;
    this.durationMs = durationMs;
    this.deadlineMs = Date.now() + durationMs;
    await this.controller.start(this.dbDir);
    this.active = true;
    this.scheduleTimers();
    this.persist();
    this.emit();
  }

  async stop(auto = false): Promise<void> {
    if (!this.enabled) throw new Error('Session control is disabled in this mode.');
    if (!this.active) return;
    this.clearTimers();
    await this.controller.stop();
    const stoppedDir = this.dbDir;
    if (!this.keepData && stoppedDir) {
      try {
        rmSync(stoppedDir, { recursive: true, force: true });
        rmSync(`${stoppedDir}_metadata`, { recursive: true, force: true });
      } catch (err) {
        console.warn('⚠️ Failed to remove discarded DB dir:', err);
      }
    }
    console.log(
      `[Session] ${auto ? 'auto-' : ''}stopped run (${this.keepData ? 'saved' : 'discarded'}) ${stoppedDir}`,
    );
    this.active = false;
    this.dbDir = null;
    this.deadlineMs = null;
    this.durationMs = null;
    this.keepData = false;
    this.persist();
    this.emit();
  }

  extend(addMs: number): void {
    if (!this.enabled) throw new Error('Session control is disabled in this mode.');
    if (!this.active || this.deadlineMs == null) throw new Error('No active run to extend.');
    if (!Number.isFinite(addMs) || addMs <= 0) throw new Error('addMs must be a positive number.');
    this.deadlineMs += addMs;
    this.scheduleTimers();
    this.persist();
    this.emit();
  }
}

export const sessionManager = new SessionManager();
