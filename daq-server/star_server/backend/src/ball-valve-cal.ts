/**
 * Ball valve two-point calibration: the raw reading at fully closed and at fully open, and a
 * straight line between them.
 *
 * calibration_service converts a valve's position loop to % open assuming an ideal 4-20 mA across
 * an exact 100 ohm into an ideal ADC. The ESP32's ADC1 is not ideal: on 2026-11-05 the Ox Vent
 * valve, physically closed, read ~355 counts where 4 mA "should" be 496, about 1 mA low. Rather
 * than model the ADC, the operator shows us the two ends: on the Calibration page, with the valve
 * fully closed, "Set fully closed"; with it fully open, "Set fully open". Each stores the mean of
 * the last second of raw counts on that channel.
 *
 * Applied here, on the way to the browser and to the actuator-mismatch check (server.ts), by
 * replacing position_pct. Elodin keeps calibration_service's ideal-loop figure and the raw counts
 * beside it, so an archive can always be re-derived. A dead loop (cal_status NO SIGNAL) is left
 * alone: no endpoint makes 0 mA mean "closed".
 *
 * Keyed by the calibrated entity (BV<n>_Cal.CH<m>): the physical channel the valve is wired to,
 * so renaming its role does not lose its calibration.
 */
import fs from 'fs';
import type { ParsedSensorData } from './elodin-protocol.js';
import { BALL_VALVE_STATUS_NO_SIGNAL } from './ball-valve.js';
import { ballValveCalPath } from './routes/calibration-profiles.js';

/** Ideal-loop counts: 4 mA and 20 mA across 100 ohm, 12-bit at 3.3 V (ValvePosition.hpp). */
export const IDEAL_CLOSED_COUNTS = 496;
export const IDEAL_OPEN_COUNTS = 2482;
/** Endpoints closer than this (~0.8 mA) cannot be a valve's travel: refuse rather than divide. */
export const MIN_SPAN_COUNTS = 100;
/** How much recent signal a capture averages, and the least it will accept. */
export const CAPTURE_WINDOW_MS = 1000;
export const MIN_CAPTURE_SAMPLES = 3;

export interface ValveEndpoints {
  closedCounts?: number;
  openCounts?: number;
  closedAtMs?: number;
  openAtMs?: number;
}

/** % open from raw counts. A missing endpoint falls back to its ideal-loop value. Clamped 0-100. */
export function percentOpen(counts: number, ep: ValveEndpoints): number {
  const closed = ep.closedCounts ?? IDEAL_CLOSED_COUNTS;
  const open = ep.openCounts ?? IDEAL_OPEN_COUNTS;
  if (!Number.isFinite(counts) || Math.abs(open - closed) < MIN_SPAN_COUNTS) return NaN;
  const pct = ((counts - closed) / (open - closed)) * 100;
  return Math.min(100, Math.max(0, pct));
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────
interface FileShape {
  valves: Record<string, { closed_counts?: number; open_counts?: number; closed_at_ms?: number; open_at_ms?: number }>;
}

let cache: { mtimeMs: number; map: Map<string, ValveEndpoints> } | null = null;

export function parseEndpointsFile(text: string): Map<string, ValveEndpoints> {
  const root = JSON.parse(text) as Partial<FileShape>;
  const out = new Map<string, ValveEndpoints>();
  for (const [entity, v] of Object.entries(root?.valves ?? {})) {
    if (!/^BV\d+_Cal\.CH\d+$/.test(entity) || !v || typeof v !== 'object') continue;
    const ep: ValveEndpoints = {};
    if (Number.isFinite(v.closed_counts)) { ep.closedCounts = v.closed_counts; ep.closedAtMs = v.closed_at_ms; }
    if (Number.isFinite(v.open_counts)) { ep.openCounts = v.open_counts; ep.openAtMs = v.open_at_ms; }
    if (ep.closedCounts !== undefined || ep.openCounts !== undefined) out.set(entity, ep);
  }
  return out;
}

/** The stored endpoints. A missing or unreadable file is "none": every valve on the ideal loop. */
export function loadEndpoints(): Map<string, ValveEndpoints> {
  let st: fs.Stats;
  try {
    st = fs.statSync(ballValveCalPath());
  } catch {
    cache = null;
    return new Map();
  }
  if (cache && cache.mtimeMs === st.mtimeMs) return cache.map;
  try {
    const map = parseEndpointsFile(fs.readFileSync(ballValveCalPath(), 'utf8'));
    cache = { mtimeMs: st.mtimeMs, map };
    return map;
  } catch {
    return cache?.map ?? new Map();  // torn read: keep the last good map
  }
}

function saveEndpoints(map: Map<string, ValveEndpoints>): void {
  const file: FileShape = { valves: {} };
  for (const [entity, ep] of map) {
    file.valves[entity] = {
      ...(ep.closedCounts !== undefined ? { closed_counts: ep.closedCounts, closed_at_ms: ep.closedAtMs } : {}),
      ...(ep.openCounts !== undefined ? { open_counts: ep.openCounts, open_at_ms: ep.openAtMs } : {}),
    };
  }
  const p = ballValveCalPath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
  fs.renameSync(tmp, p);
  cache = null;
}

// ── Live stream ──────────────────────────────────────────────────────────────────────────────
interface Sample { t: number; counts: number; noSignal: boolean }
const recent = new Map<string, Sample[]>();

/**
 * Record each ball valve's raw counts for capture, and replace position_pct with the calibrated
 * line for every valve that has endpoints. Everything else passes through untouched.
 */
export function applyValveCalibration(parsed: ParsedSensorData[], nowMs = Date.now()): ParsedSensorData[] {
  let out: ParsedSensorData[] | null = null;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.component !== 'position_pct' || !/^BV\d+_Cal\.CH\d+$/.test(p.entity)) continue;
    const raw = parsed.find((q) => q.entity === p.entity && q.component === 'raw_adc')?.value;
    const status = parsed.find((q) => q.entity === p.entity && q.component === 'cal_status')?.value;
    if (raw === undefined || !Number.isFinite(raw)) continue;
    const noSignal = status === BALL_VALVE_STATUS_NO_SIGNAL;

    const buf = recent.get(p.entity) ?? [];
    buf.push({ t: nowMs, counts: raw, noSignal });
    while (buf.length && nowMs - buf[0].t > 2 * CAPTURE_WINDOW_MS) buf.shift();
    recent.set(p.entity, buf);

    const ep = loadEndpoints().get(p.entity);
    if (!ep || noSignal) continue;
    const value = percentOpen(raw, ep);
    if (!Number.isFinite(value)) continue;
    if (!out) out = [...parsed];
    out[i] = { ...p, value };
  }
  return out ?? parsed;
}

export type CaptureResult = { ok: true; endpoints: ValveEndpoints } | { ok: false; error: string };

/** Store the last second's mean raw counts as this valve's fully closed or fully open reading. */
export function captureEndpoint(entity: string, point: 'closed' | 'open', nowMs = Date.now()): CaptureResult {
  if (!/^BV\d+_Cal\.CH\d+$/.test(entity)) return { ok: false, error: `${entity} is not a ball valve channel` };
  const window = (recent.get(entity) ?? []).filter((s) => nowMs - s.t <= CAPTURE_WINDOW_MS);
  if (window.length < MIN_CAPTURE_SAMPLES)
    return { ok: false, error: 'No live position from this valve in the last second. Is a session running?' };
  if (window.some((s) => s.noSignal))
    return { ok: false, error: 'The position loop reads below 2 mA (no signal). Check the valve power and feedback wiring.' };
  const counts = Math.round(window.reduce((a, s) => a + s.counts, 0) / window.length);

  const map = new Map(loadEndpoints());
  const ep: ValveEndpoints = { ...(map.get(entity) ?? {}) };
  const other = point === 'closed' ? ep.openCounts : ep.closedCounts;
  if (other !== undefined && Math.abs(counts - other) < MIN_SPAN_COUNTS)
    return { ok: false, error: `This reads ${counts} counts, within ${MIN_SPAN_COUNTS} of the stored fully ${point === 'closed' ? 'open' : 'closed'} reading (${other}). Is the valve actually ${point}?` };
  if (point === 'closed') { ep.closedCounts = counts; ep.closedAtMs = nowMs; }
  else { ep.openCounts = counts; ep.openAtMs = nowMs; }
  map.set(entity, ep);
  saveEndpoints(map);
  return { ok: true, endpoints: ep };
}

/** Forget a valve's endpoints: back to the ideal 4-20 mA line. */
export function clearEndpoints(entity: string): void {
  const map = new Map(loadEndpoints());
  if (map.delete(entity)) saveEndpoints(map);
}

/** For the Calibration page: stored endpoints and the live mean reading per valve channel. */
export function valveCalibrationSnapshot(nowMs = Date.now()): Array<{
  entity: string; endpoints: ValveEndpoints | null; liveCounts: number | null; noSignal: boolean;
}> {
  const map = loadEndpoints();
  const entities = new Set<string>([...map.keys(), ...recent.keys()]);
  return [...entities].sort().map((entity) => {
    const w = (recent.get(entity) ?? []).filter((s) => nowMs - s.t <= CAPTURE_WINDOW_MS);
    return {
      entity,
      endpoints: map.get(entity) ?? null,
      liveCounts: w.length ? Math.round(w.reduce((a, s) => a + s.counts, 0) / w.length) : null,
      noSignal: w.some((s) => s.noSignal),
    };
  });
}

/** Test hook. */
export function _resetValveCalForTest(): void {
  recent.clear();
  cache = null;
}
