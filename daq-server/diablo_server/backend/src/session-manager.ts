/**
 * Authoritative DAQ run-session engine: owns the auto-stop deadline (so a run
 * stops even if every browser is closed), fires a high-priority warning
 * `SESSION_WARN_LEAD_MS` before expiry, and starts each run into a fresh
 * timestamped Elodin DB (so no run ever clobbers another).
 *
 * Disabled entirely when SESSION_SERVICE_MODE=off (the launch-site laptop): no
 * timers, no auto-stop, `enabled=false` so the UI hides the button.
 */
import { statfsSync, rmSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SessionStatus, NotificationPayload } from '../../shared/types.js';
import { MessageType } from '../../shared/types.js';
import { ServiceController, getSessionServiceMode } from './service-controller.js';
import { loadSession, saveSession } from './session-state.js';

// Warn the operator at each of these leads before auto-stop. Default: 5 min and
// 1 min. Override with SESSION_WARN_LEADS_MS (comma-separated ms) to exercise the
// warnings quickly in tests, e.g. "20000,10000". The legacy single-value
// SESSION_WARN_LEAD_MS is still honored if SESSION_WARN_LEADS_MS is unset.
function parseWarnLeads(): number[] {
  const raw = process.env.SESSION_WARN_LEADS_MS || process.env.SESSION_WARN_LEAD_MS || '300000,60000';
  const leads = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  // De-dupe and sort descending so the earliest (largest-lead) warning fires first.
  return Array.from(new Set(leads)).sort((a, b) => b - a);
}
const WARN_LEADS_MS = parseWarnLeads();
const ELODIN_ROOT = join(homedir(), '.local', 'share', 'elodin');

type Broadcast = (message: object) => void;
type Notify = (payload: NotificationPayload) => void;

function timestampName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `daq_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// True on WSL, where the Linux home lives on a thin-provisioned ext4 vhdx.
const IS_WSL = (() => {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
})();

function statfsFree(path: string): number | null {
  try {
    const s = statfsSync(path);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function freeDiskBytes(): number | null {
  // On WSL, statfs(ELODIN_ROOT) reports the vhdx's ~1 TB virtual size, not the
  // real free space — the actual limit is the Windows drive backing it (/mnt/c).
  // Report that instead so the number is truthful. On real Linux (server + CI)
  // this branch never runs and statfs(ELODIN_ROOT) is already correct.
  if (IS_WSL && existsSync('/mnt/c')) {
    const win = statfsFree('/mnt/c');
    if (win != null) return win;
  }
  return statfsFree(ELODIN_ROOT);
}

class SessionManager {
  private readonly mode = getSessionServiceMode();
  private readonly enabled = this.mode !== 'off';
  private readonly controller = new ServiceController(this.mode);
  private broadcast: Broadcast = () => {};
  private notify: Notify = () => {};
  /** Fired after a run stops, so the server can revert board status to the
   *  pristine config baseline (else boards keep a stale heartbeat timestamp and
   *  read "---" instead of the disconnected baseline shown on fresh startup). */
  private onStopped: () => void = () => {};

  private active = false;
  private dbDir: string | null = null;
  private keepData = false;
  private simulated = false;
  private deadlineMs: number | null = null;
  private durationMs: number | null = null;
  private warnTimers: NodeJS.Timeout[] = [];
  private stopTimer: NodeJS.Timeout | null = null;

  init(broadcast: Broadcast, notify: Notify, onStopped: () => void = () => {}): void {
    this.broadcast = broadcast;
    this.notify = notify;
    this.onStopped = onStopped;
    if (!this.enabled) return;
    // Recover a session that outlived a backend restart.
    const persisted = loadSession();
    if (persisted?.active) {
      this.active = true;
      this.dbDir = persisted.dbDir;
      this.keepData = persisted.keepData;
      this.simulated = persisted.simulated;
      this.deadlineMs = persisted.deadlineMs;
      this.durationMs = persisted.durationMs;
      if (this.deadlineMs != null && this.deadlineMs <= Date.now()) {
        void this.stop(true); // expired while we were down
      } else {
        this.scheduleTimers();
        // The spawned simulator (mock mode) dies with the backend — re-launch it
        // for a recovered simulated run. (systemd units survive; resume is a no-op.)
        void this.controller.resume(this.simulated);
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** True when an active run is fed by the board simulator (drives the "Simulated Data" badge). */
  isSimulated(): boolean {
    return this.active && this.simulated;
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
      simulated: this.active && this.simulated,
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
    for (const t of this.warnTimers) clearTimeout(t);
    this.warnTimers = [];
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  /** Dismiss any live warning banners (e.g. after Add time moves the deadline out). */
  private clearWarnings(): void {
    for (const lead of WARN_LEADS_MS) {
      this.notify({
        key: `session-timeout-${lead}`,
        category: 'error',
        message: '',
        timestampMs: Date.now(),
        ongoing: false,
      });
    }
  }

  private scheduleTimers(): void {
    this.clearTimers();
    this.clearWarnings(); // re-arming (start/extend) supersedes stale banners
    if (this.deadlineMs == null) return;
    const now = Date.now();
    for (const lead of WARN_LEADS_MS) {
      const warnAt = this.deadlineMs - lead;
      if (warnAt > now) {
        this.warnTimers.push(setTimeout(() => this.fireWarning(lead), warnAt - now));
      }
    }
    this.stopTimer = setTimeout(() => void this.stop(true), Math.max(0, this.deadlineMs - now));
  }

  private fireWarning(leadMs: number): void {
    const mins = Math.max(1, Math.round(leadMs / 60000));
    this.notify({
      key: `session-timeout-${leadMs}`,
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
      simulated: this.simulated,
    });
  }

  async start(keepData: boolean, durationMs: number, simulated = false): Promise<void> {
    if (!this.enabled) throw new Error('Session control is disabled in this mode.');
    if (this.active) throw new Error('A run is already active.');
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error('durationMs must be a positive number.');
    }
    this.dbDir = join(ELODIN_ROOT, timestampName());
    this.keepData = keepData;
    this.simulated = simulated;
    this.durationMs = durationMs;
    this.deadlineMs = Date.now() + durationMs;
    await this.controller.start(this.dbDir, this.simulated);
    this.active = true;
    this.scheduleTimers();
    this.persist();
    this.emit();
  }

  async stop(auto = false): Promise<void> {
    if (!this.enabled) throw new Error('Session control is disabled in this mode.');
    if (!this.active) return;
    this.clearTimers();
    this.clearWarnings();
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
    this.simulated = false;
    this.persist();
    this.emit();
    this.onStopped(); // revert board status to the disconnected baseline
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
