/**
 * Ball valve command current: the loop current each valve is driven at to be fully closed
 * (commanded 0) and fully open (commanded 1). Ideal 4 / 20 mA; an actuator's positioner may need
 * a little more or less to reach the end of its travel.
 *
 * Not the position calibration (ball-valve-cal.ts): that one says what the valve's *readback*
 * means; this says what the board *sends*. The operator trims each end on the Calibration page
 * while watching % open. This module only stores it: config_broadcast reads the same file every
 * cycle and sends each ball valve board VALVE_CURRENT_CONFIG (lib ValveCommandCurrent.hpp), and the
 * board applies it at once -- including to a valve sitting in that state -- and keeps it in NVS.
 *
 * Calibrating is a trial: the operator drives a valve at any current ("Drive"), watches its
 * position, and saves that current as the valve's open or closed ("Save as open / closed"). The
 * running trial lives in ball_valve_trials.json with an expiry; config_broadcast repeats it to
 * the board as VALVE_TEST_CURRENT every cycle until it is saved, ended or expires, and the board
 * drops it 3 s after the repeats stop. A command that changes the valve's state also ends it.
 *
 * Keyed like the position calibration by the calibrated entity (BV<n>_Cal.CH<m>), the physical
 * channel, so renaming a role keeps its currents. The limits match the C++ and the firmware.
 */
import fs from 'fs';
import path from 'path';
import { ballValveCurrentPath, ballValveTrialsPath } from './routes/calibration-profiles.js';

export const DEFAULT_CLOSED_MA = 4.0;
export const DEFAULT_OPEN_MA = 20.0;
/** NAMUR NE43's low saturation; clear of the board's 3.6 mA "command loop open" fault. */
export const MIN_MA = 3.8;
/** The board's DAC full scale: 4095 codes at 200 codes per mA. */
export const MAX_MA = 20.475;
/** Ends closer than this cannot be a valve's travel; most likely a typo. */
export const MIN_SPAN_MA = 1.0;
/** A trial left running ends itself after this long; each Drive starts it again. */
export const TRIAL_MS = 120_000;

const ENTITY = /^BV\d+_Cal\.CH\d+$/;

export interface ValveCurrents {
  closedMa: number;
  openMa: number;
  updatedAtMs?: number;
}

/** null when valid, else why not. Mirrors fsw::calibration::valve_current::validate. */
export function validateCurrents(closedMa: number, openMa: number): string | null {
  for (const [name, v] of [['Closed', closedMa], ['Open', openMa]] as const) {
    if (!Number.isFinite(v) || v < MIN_MA || v > MAX_MA)
      return `${name} current must be ${MIN_MA}-${MAX_MA} mA (got ${Number.isFinite(v) ? v : 'not a number'})`;
  }
  if (Math.abs(openMa - closedMa) < MIN_SPAN_MA)
    return `Closed and open must be at least ${MIN_SPAN_MA} mA apart`;
  return null;
}

interface FileShape {
  valves: Record<string, { closed_ma: number; open_ma: number; updated_at_ms?: number }>;
}

/** The stored currents. Missing or unreadable file: none (every valve at 4 / 20). */
export function loadCurrents(): Map<string, ValveCurrents> {
  const out = new Map<string, ValveCurrents>();
  let root: Partial<FileShape>;
  try {
    root = JSON.parse(fs.readFileSync(ballValveCurrentPath(), 'utf8'));
  } catch {
    return out;
  }
  for (const [entity, v] of Object.entries(root?.valves ?? {})) {
    if (!ENTITY.test(entity) || !v || typeof v !== 'object') continue;
    if (validateCurrents(v.closed_ma, v.open_ma) !== null) continue;
    out.set(entity, { closedMa: v.closed_ma, openMa: v.open_ma, updatedAtMs: v.updated_at_ms });
  }
  return out;
}

/** Atomic write: config_broadcast never reads half a file. */
function writeJson(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function saveCurrents(map: Map<string, ValveCurrents>): void {
  const file: FileShape = { valves: {} };
  for (const [entity, c] of [...map].sort(([a], [b]) => a.localeCompare(b)))
    file.valves[entity] = { closed_ma: c.closedMa, open_ma: c.openMa, updated_at_ms: c.updatedAtMs };
  writeJson(ballValveCurrentPath(), file);
}

export type SetResult = { ok: true } | { ok: false; error: string };

/** Store a valve's closed/open currents, rounded to 0.01 mA (the board's DAC step is 0.005). */
export function setCurrents(entity: string, closedMa: number, openMa: number, nowMs = Date.now()): SetResult {
  if (!ENTITY.test(entity)) return { ok: false, error: `${entity} is not a ball valve channel` };
  const closed = Math.round(closedMa * 100) / 100;
  const open = Math.round(openMa * 100) / 100;
  const why = validateCurrents(closed, open);
  if (why) return { ok: false, error: why };
  const map = loadCurrents();
  map.set(entity, { closedMa: closed, openMa: open, updatedAtMs: nowMs });
  saveCurrents(map);
  return { ok: true };
}

/** Forget a valve's currents: config_broadcast sends it 4 / 20 again. Ends its trial too. */
export function clearCurrents(entity: string): void {
  const map = loadCurrents();
  if (map.delete(entity)) saveCurrents(map);
  endTrial(entity);
}

// ── Trials ───────────────────────────────────────────────────────────────────────────────────
export interface Trial { ma: number; expiresAtMs: number }

/** Running trials (expired ones dropped). Missing or unreadable file: none. */
export function loadTrials(nowMs = Date.now()): Map<string, Trial> {
  const out = new Map<string, Trial>();
  let root: { valves?: Record<string, { ma: number; expires_at_ms: number }> };
  try {
    root = JSON.parse(fs.readFileSync(ballValveTrialsPath(), 'utf8'));
  } catch {
    return out;
  }
  for (const [entity, t] of Object.entries(root?.valves ?? {})) {
    if (!ENTITY.test(entity) || !t || !Number.isFinite(t.ma) || !Number.isFinite(t.expires_at_ms)) continue;
    if (t.expires_at_ms <= nowMs) continue;
    out.set(entity, { ma: t.ma, expiresAtMs: t.expires_at_ms });
  }
  return out;
}

function saveTrials(map: Map<string, Trial>): void {
  const valves: Record<string, { ma: number; expires_at_ms: number }> = {};
  for (const [entity, t] of map) valves[entity] = { ma: t.ma, expires_at_ms: t.expiresAtMs };
  writeJson(ballValveTrialsPath(), { valves });
}

/** Drive a valve at `ma` now, whatever it is commanded, for TRIAL_MS. */
export function startTrial(entity: string, ma: number, nowMs = Date.now()): SetResult {
  if (!ENTITY.test(entity)) return { ok: false, error: `${entity} is not a ball valve channel` };
  const v = Math.round(ma * 100) / 100;
  if (!Number.isFinite(v) || v < MIN_MA || v > MAX_MA)
    return { ok: false, error: `Trial current must be ${MIN_MA}-${MAX_MA} mA` };
  const map = loadTrials(nowMs);
  map.set(entity, { ma: v, expiresAtMs: nowMs + TRIAL_MS });
  saveTrials(map);
  return { ok: true };
}

/** Stop driving the trial: the valve goes back to its commanded state's current. */
export function endTrial(entity: string, nowMs = Date.now()): void {
  const map = loadTrials(nowMs);
  if (map.delete(entity)) saveTrials(map);
}

/**
 * The running trial's current becomes this valve's open (or closed) current, and the trial ends:
 * the valve is then driven at its commanded state's current, which for that state is the one
 * just saved. The other end keeps what it had (4 / 20 if never set).
 */
export function saveTrialAs(entity: string, as: 'open' | 'closed', nowMs = Date.now()): SetResult {
  const trial = loadTrials(nowMs).get(entity);
  if (!trial) return { ok: false, error: 'No trial current is running on this valve: Drive one first.' };
  const stored = loadCurrents().get(entity);
  const closed = as === 'closed' ? trial.ma : stored?.closedMa ?? DEFAULT_CLOSED_MA;
  const open = as === 'open' ? trial.ma : stored?.openMa ?? DEFAULT_OPEN_MA;
  const r = setCurrents(entity, closed, open, nowMs);
  if (r.ok) endTrial(entity, nowMs);
  return r;
}

/** For the Calibration page: every stored valve, and the limits the inputs enforce. */
export function currentsSnapshot(nowMs = Date.now()) {
  return {
    valves: [...loadCurrents()].map(([entity, c]) => ({ entity, ...c })),
    trials: [...loadTrials(nowMs)].map(([entity, t]) => ({ entity, ...t })),
    trialMs: TRIAL_MS,
    defaults: { closedMa: DEFAULT_CLOSED_MA, openMa: DEFAULT_OPEN_MA },
    limits: { minMa: MIN_MA, maxMa: MAX_MA, minSpanMa: MIN_SPAN_MA },
  };
}
