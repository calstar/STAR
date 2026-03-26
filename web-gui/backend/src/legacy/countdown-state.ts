import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getConfigPath } from '../routes/config.js';

type CountdownStateFile = {
  /** Unix timestamp in milliseconds; null clears/pauses the countdown. */
  targetTimeMs: number | null;
};

function isValidTargetTimeMs(value: unknown): value is number | null {
  if (value === null) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  // Reject obviously-bad values (seconds vs ms, etc.) but keep bounds generous.
  // 2000-01-01 .. 2100-01-01
  return value >= 946684800000 && value <= 4102444800000;
}

export function getCountdownStatePath(): string {
  if (process.env.COUNTDOWN_STATE_PATH && process.env.COUNTDOWN_STATE_PATH.length > 0) {
    return process.env.COUNTDOWN_STATE_PATH;
  }
  // Default: persist alongside config.toml so deployments carry it naturally.
  const cfgPath = getConfigPath();
  return join(dirname(cfgPath), 'countdown_state.json');
}

export function loadCountdownTargetTimeMs(): number | null {
  const statePath = getCountdownStatePath();
  try {
    const raw = readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CountdownStateFile>;
    if (isValidTargetTimeMs(parsed.targetTimeMs)) return parsed.targetTimeMs;
  } catch {
    // ignore (missing file, parse errors, etc.)
  }
  return null;
}

export function saveCountdownTargetTimeMs(targetTimeMs: number | null): void {
  const statePath = getCountdownStatePath();
  const payload: CountdownStateFile = { targetTimeMs };
  try {
    writeFileSync(statePath, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8', flag: 'w' });
  } catch (err) {
    // Non-fatal: countdown still works for this process lifetime.
    console.warn(`⚠️ Failed to persist countdown state to ${statePath}:`, err);
  }
}
