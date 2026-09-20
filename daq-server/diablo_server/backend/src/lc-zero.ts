/**
 * Load-cell zeros, as the calibration service records them.
 *
 * A ZERO is not a tare, and this module is not a copy of lc-tare.ts with the nouns changed. The
 * difference that matters here is WHERE the correction is applied:
 *
 *   - A tare is subtracted AFTER the curve, in kilograms. Node can and does apply it, because
 *     that is arithmetic on a published number.
 *   - A zero shifts the curve's INPUT, in ADC codes. `model(adc - shift)` is not
 *     `model(adc) - k`, so it cannot be applied downstream of the conversion. C++ applies it
 *     inside the conversion itself and publishes the corrected kilograms.
 *
 * So this module performs NO arithmetic on samples. It reads state, serves it to the UI, and
 * records changes for the archive. If you find yourself adding a subtraction here, the thing you
 * actually want is already done in calibration_main.cpp's lc_kg().
 *
 * What the archive needs, and why the snapshot exists: because the shift is applied before
 * publication, `force_kg` means different weights for the same ADC code in runs with different
 * zeros. That is intended. It is only legible after the fact because service-controller.ts
 * snapshots the calibration and this file beside every run, so the viewer can recompute from the
 * raw codes it already stores.
 */

import fs from 'fs';
import path from 'path';
import { zeroPath } from './routes/calibration-profiles.js';

/** One channel's zero as the calibration service wrote it. */
interface ZeroRecord {
  uid: number;
  entity: string;
  adc_at_zero: number;
  cal_zero_adc: number;
  shift_codes: number;
  domain_min: number;
  domain_max: number;
  set_at_ms: number;
  basis_fp: number;
}

export interface ZeroEntry {
  uid: number;
  /** The truth: the raw code read with the cell unloaded. */
  adcAtZero: number;
  /** The code the static calibration maps to 0 kg. */
  calZeroAdc: number;
  /** adcAtZero - calZeroAdc, subtracted from a live code before the curve is evaluated. */
  shiftCodes: number;
  /** The captured points' own span — a shifted code outside it means the cubic is extrapolating. */
  domainMin: number;
  domainMax: number;
  setAtMs: number;
}

/** entity (e.g. "LC2_Cal.CH1") -> zero. Keyed on the string C++ writes; never re-derived here. */
type ZeroMap = Map<string, ZeroEntry>;

let _cache: { mtimeMs: number; map: ZeroMap } | null = null;
/** The map currently in effect. Survives a torn read; see loadZeroMap(). */
let _held: ZeroMap = new Map();
let _dbDir: string | null = null;

/** Where the per-run record goes. Null between sessions — see recordChanges(). */
export function setRunDir(dbDir: string | null): void {
  _dbDir = dbDir;
}

/** Drop the cached map so the next read re-reads the file. */
export function resetZeroState(): void {
  _cache = null;
  _held = new Map();
}

function parseZeroFile(text: string): ZeroMap {
  const map: ZeroMap = new Map();
  const data = JSON.parse(text) as { zeros?: ZeroRecord[] };
  if (!Array.isArray(data?.zeros)) return map;
  for (const z of data.zeros) {
    if (typeof z?.entity !== 'string' || z.entity.length === 0) continue;
    // A non-finite shift would be subtracted from every code on the channel. C++ refuses to
    // record one; this is the second line of defence, because the cost of being wrong is a whole
    // series of NaN with nothing to explain it.
    if (!Number.isFinite(z.shift_codes)) continue;
    map.set(z.entity, {
      uid: Number(z.uid) || 0,
      adcAtZero: Number(z.adc_at_zero),
      calZeroAdc: Number(z.cal_zero_adc),
      shiftCodes: Number(z.shift_codes),
      domainMin: Number(z.domain_min),
      domainMax: Number(z.domain_max),
      setAtMs: Number(z.set_at_ms),
    });
  }
  return map;
}

/**
 * The live zero map, reloaded when the file's mtime moves.
 *
 * Same three outcomes as the tare map, distinguished by error code rather than a bare catch:
 *   - file absent (ENOENT)  -> empty map. Normal on a stand that has never been zeroed. Note
 *                              this is NOT a session-start state any more: nothing removes
 *                              either file at session start.
 *   - file unreadable/torn  -> KEEP the previous map. tmp+rename still loses races.
 *   - file parsed           -> adopt it, and append any change to the run record.
 */
export function loadZeroMap(): ZeroMap {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(zeroPath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (_held.size > 0) {
        recordChanges(_held, new Map());
        _held = new Map();
      }
      _cache = null;
      return _held;
    }
    return _held; // permissions, I/O — hold what we have
  }

  if (_cache && _cache.mtimeMs === stat.mtimeMs) return _cache.map;

  let next: ZeroMap;
  try {
    next = parseZeroFile(fs.readFileSync(zeroPath(), 'utf8'));
  } catch {
    return _held; // torn or malformed — keep the last good map, do NOT clear
  }

  recordChanges(_held, next);
  _held = next;
  _cache = { mtimeMs: stat.mtimeMs, map: next };
  return next;
}

/**
 * Append what changed to <dbDir>/lc_zero.jsonl.
 *
 * The per-run snapshot taken at session start says what the zero was when the run BEGAN. This
 * says what happened to it during the run. Both are needed: an operator who re-zeroes mid-run
 * makes the same ADC code mean two different weights within one archive, and only the timestamped
 * line here says where the boundary was.
 *
 * A 'recal' line carries its weight the same way the tare's does: a re-fit moves cal_zero_adc
 * with no operator action, so the shift changes with no click to hang a write off.
 */
function recordChanges(prev: ZeroMap, next: ZeroMap): void {
  if (!_dbDir) return; // a zero with no active session still applies; it just is not recorded
  const lines: string[] = [];
  const at = Date.now();

  for (const [entity, z] of next) {
    const before = prev.get(entity);
    if (before && before.shiftCodes === z.shiftCodes && before.adcAtZero === z.adcAtZero) continue;
    // Same captured code, different shift means the calibration moved under a standing zero.
    const event = !before ? 'set' : before.adcAtZero === z.adcAtZero ? 'recal' : 'set';
    lines.push(
      JSON.stringify({
        entity, uid: z.uid, event, shiftCodes: z.shiftCodes, adcAtZero: z.adcAtZero,
        calZeroAdc: z.calZeroAdc, domainMin: z.domainMin, domainMax: z.domainMax,
        setAtMs: z.setAtMs, appliedAtMs: at,
      }),
    );
  }
  for (const [entity, z] of prev) {
    if (next.has(entity)) continue;
    lines.push(
      JSON.stringify({
        entity, uid: z.uid, event: 'clear', shiftCodes: 0, adcAtZero: z.adcAtZero,
        calZeroAdc: z.calZeroAdc, domainMin: z.domainMin, domainMax: z.domainMax,
        setAtMs: z.setAtMs, appliedAtMs: at,
      }),
    );
  }
  if (lines.length === 0) return;

  try {
    fs.mkdirSync(_dbDir, { recursive: true });
    // Append, never rewrite: each line is a thing that happened. There is no terminal line at
    // session stop, so a missing trailing 'clear' unambiguously means "in effect to end of run".
    fs.appendFileSync(path.join(_dbDir, 'lc_zero.jsonl'), lines.join('\n') + '\n');
  } catch (e) {
    console.warn('[LcZero] could not append the run record:', e);
  }
}

/**
 * Drive the run record from the packet path without paying a statSync per packet.
 *
 * The tare map is re-read on every packet because the subtraction needs it; the zero is already
 * applied in C++, so the only reason to read the file live is to timestamp a mid-run change into
 * lc_zero.jsonl. A quarter-second gate bounds that timestamp's error to 250 ms, which is far
 * inside the resolution anyone reconstructing a step function needs — a re-zero is an operator
 * action on an unloaded cell, not a millisecond event.
 */
const POLL_INTERVAL_MS = 250;
let _lastPollMs = 0;
export function pollZeroChanges(): void {
  const now = Date.now();
  if (now - _lastPollMs < POLL_INTERVAL_MS) return;
  _lastPollMs = now;
  loadZeroMap();
}

/** The live zeros, for the status endpoint the calibration UI polls. */
export function currentZeros(): Array<ZeroEntry & { entity: string }> {
  return [...loadZeroMap()].map(([entity, z]) => ({ entity, ...z }));
}
