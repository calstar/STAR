/**
 * Persists the active DAQ session across backend restarts, mirroring
 * countdown-state.ts. Stored next to config.toml so deployments carry it
 * naturally. Only used when SESSION_SERVICE_MODE != off.
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getConfigPath } from './routes/config.js';

export interface PersistedSession {
  active: boolean;
  dbDir: string | null;
  keepData: boolean;
  deadlineMs: number | null;
  durationMs: number | null;
  simulated: boolean;
}

export function getSessionStatePath(): string {
  if (process.env.SESSION_STATE_PATH && process.env.SESSION_STATE_PATH.length > 0) {
    return process.env.SESSION_STATE_PATH;
  }
  return join(dirname(getConfigPath()), 'session_state.json');
}

export function loadSession(): PersistedSession | null {
  try {
    const raw = readFileSync(getSessionStatePath(), 'utf-8');
    const p = JSON.parse(raw) as Partial<PersistedSession>;
    if (typeof p.active !== 'boolean') return null;
    return {
      active: p.active,
      dbDir: typeof p.dbDir === 'string' ? p.dbDir : null,
      keepData: !!p.keepData,
      deadlineMs: typeof p.deadlineMs === 'number' ? p.deadlineMs : null,
      durationMs: typeof p.durationMs === 'number' ? p.durationMs : null,
      simulated: !!p.simulated,
    };
  } catch {
    return null;
  }
}

export function saveSession(s: PersistedSession): void {
  try {
    writeFileSync(getSessionStatePath(), JSON.stringify(s, null, 2) + '\n', {
      encoding: 'utf-8',
      flag: 'w',
    });
  } catch (err) {
    // Non-fatal: session still works for this process lifetime.
    console.warn('⚠️ Failed to persist session state:', err);
  }
}
