/**
 * Load-cell tare: the display-only subtraction, and the per-run record of it.
 *
 * WHY THE SUBTRACTION LIVES HERE AND NOT IN C++
 * ---------------------------------------------
 * The calibration service pushes raw ADC into its CaptureWindow *before* it computes any
 * kilograms, which is what makes a calibration capture structurally immune to a standing tare —
 * an operator can tare a loaded tank and still calibrate in absolute weight afterwards. Moving
 * the subtraction into C++ would put a tared number in front of that boundary and destroy the
 * property. So Elodin keeps carrying gross `force_kg` forever, every archive stays comparable,
 * and the tare is applied on the way to the browser and nowhere else.
 *
 * WHY A PARALLEL COMPONENT AND NOT AN IN-PLACE EDIT
 * -------------------------------------------------
 * The calibration page must be able to read absolute kilograms — the operator types the true
 * weight of a known mass, and a tared readout beside that input is how a false point gets into
 * the fit. Mutating `force_kg` would leave that page no way to get gross. So this emits
 * `force_kg_tared` alongside the untouched original and the frontend picks which to render.
 *
 * This is the backend's first derived stream component; everything else it publishes is verbatim
 * from the packet. That is a deliberate exception, for the reason above.
 */

import fs from 'fs';
import path from 'path';
import type { ParsedSensorData } from './elodin-protocol.js';
import { tarePath } from './routes/calibration-profiles.js';

/** One channel's tare as the calibration service wrote it. */
interface TareRecord {
  uid: number;
  entity: string;
  adc_at_tare: number;
  offset_kg: number;
  set_at_ms: number;
  curve_fp: number;
}

export interface TareEntry {
  uid: number;
  offsetKg: number;
  adcAtTare: number;
  setAtMs: number;
}

/** entity (e.g. "LC2_Cal.CH1") -> tare. Keyed on the string C++ writes; never re-derived here. */
type TareMap = Map<string, TareEntry>;

const COMPONENT_GROSS = 'force_kg';
export const COMPONENT_TARED = 'force_kg_tared';

let _cache: { mtimeMs: number; map: TareMap } | null = null;
/** The map currently applied to the stream. Survives a torn read; see loadTareMap(). */
let _held: TareMap = new Map();
let _dbDir: string | null = null;

/** Where the per-run record goes. Null between sessions — see appendRunRecord(). */
export function setRunDir(dbDir: string | null): void {
  _dbDir = dbDir;
}

/**
 * Forget everything. Called at session stop and on an Elodin reconnect: without it a stale
 * offset from the previous run is applied to the next run's first poll interval, which is
 * exactly the window in which nobody is looking closely yet.
 */
export function resetTareState(): void {
  _cache = null;
  _held = new Map();
}

function parseTareFile(text: string): TareMap {
  const map: TareMap = new Map();
  const root = JSON.parse(text) as { tares?: TareRecord[] };
  if (!root || !Array.isArray(root.tares)) throw new Error('no tares array');
  for (const t of root.tares) {
    if (!t || typeof t.entity !== 'string' || !t.entity) continue;
    // A non-finite offset is refused rather than clamped to 0: it means the service wrote
    // something it should not have, and silently treating it as "no tare" would hide that.
    if (!Number.isFinite(t.offset_kg)) continue;
    map.set(t.entity, {
      uid: Number(t.uid) || 0,
      offsetKg: t.offset_kg,
      adcAtTare: Number.isFinite(t.adc_at_tare) ? t.adc_at_tare : 0,
      setAtMs: Number.isFinite(t.set_at_ms) ? t.set_at_ms : 0,
    });
  }
  return map;
}

/**
 * The live tare map, reloaded when the file's mtime moves.
 *
 * Three outcomes, deliberately distinguished by error code rather than a bare catch:
 *   - file absent (ENOENT)  -> empty map. This is the normal state after a session-start clear.
 *   - file unreadable/torn  -> KEEP the previous map. The service writes tmp+rename, but a
 *                              reader can still lose a race; clearing on a transient parse
 *                              failure would make every LC plot jump by the tare amount for one
 *                              poll interval and then jump back.
 *   - file parsed           -> adopt it, and append any change to the run record.
 */
export function loadTareMap(): TareMap {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(tarePath());
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

  let next: TareMap;
  try {
    next = parseTareFile(fs.readFileSync(tarePath(), 'utf8'));
  } catch {
    return _held; // torn or malformed — keep the last good map, do NOT clear
  }

  recordChanges(_held, next);
  _held = next;
  _cache = { mtimeMs: stat.mtimeMs, map: next };
  return next;
}

/** The offset to subtract for a cal entity. 0 when untared, absent, or non-finite. */
export function tareOffsetKg(entity: string): number {
  const t = loadTareMap().get(entity);
  if (!t) return 0;
  return Number.isFinite(t.offsetKg) ? t.offsetKg : 0;
}

/**
 * Add `force_kg_tared` for every calibrated load-cell point in `parsed`.
 *
 * Emits unconditionally, with a 0 offset when untared: a component that appears only while a
 * tare is set renders identically to a dead stream, and "is that channel untared or is the board
 * gone?" is not a question to ask an operator mid-procedure.
 *
 * Never touches `force_kg`, and never touches the `raw_adc`/`raw_adc_counts` echoes that ride in
 * the same array — those are the raw truth and feed calibration capture.
 */
export function expandWithTare(parsed: ParsedSensorData[]): ParsedSensorData[] {
  let out: ParsedSensorData[] | null = null;
  for (const p of parsed) {
    if (p.component !== COMPONENT_GROSS) continue;
    const offset = tareOffsetKg(p.entity);
    const value = p.value - (Number.isFinite(offset) ? offset : 0);
    // Guard again after the arithmetic: this value is produced downstream of the protocol
    // layer's finite check, so a NaN here would be dropped by the caller's own guard and the
    // entire tared series would vanish from the plot with nothing logged anywhere.
    if (!Number.isFinite(value)) continue;
    if (!out) out = [...parsed];
    out.push({ entity: p.entity, component: COMPONENT_TARED, value, timestamp: p.timestamp });
  }
  return out ?? parsed;
}

/**
 * Append what changed to <dbDir>/lc_tare.jsonl.
 *
 * The record is written by whoever applies the subtraction, at the instant the applied value
 * changes — not when the operator clicks, and not when C++ captures. Two reasons. The browser
 * can close between the command and the response while the tare still applies, which would
 * leave a run whose archive cannot be reconstructed for a tare that demonstrably happened. And
 * a re-cal rewrites offset_kg with no operator action at all, so there is no click to hang a
 * write off; this path covers it for free.
 */
function recordChanges(prev: TareMap, next: TareMap): void {
  if (!_dbDir) return; // a tare with no active session still applies; it just is not recorded
  const lines: string[] = [];
  const at = Date.now();

  for (const [entity, t] of next) {
    const before = prev.get(entity);
    if (before && before.offsetKg === t.offsetKg && before.adcAtTare === t.adcAtTare) continue;
    // Same code, different offset means the curve moved under a standing tare, not a new tare.
    const event = !before ? 'set' : before.adcAtTare === t.adcAtTare ? 'recal' : 'set';
    lines.push(
      JSON.stringify({
        entity, uid: t.uid, event, offsetKg: t.offsetKg,
        adcAtTare: t.adcAtTare, setAtMs: t.setAtMs, appliedAtMs: at,
      }),
    );
  }
  for (const [entity, t] of prev) {
    if (next.has(entity)) continue;
    lines.push(
      JSON.stringify({
        entity, uid: t.uid, event: 'clear', offsetKg: 0,
        adcAtTare: t.adcAtTare, setAtMs: t.setAtMs, appliedAtMs: at,
      }),
    );
  }
  if (lines.length === 0) return;

  try {
    fs.mkdirSync(_dbDir, { recursive: true });
    // Append, never rewrite: each line is a thing that happened. There is no terminal line at
    // session stop, so a missing trailing 'clear' unambiguously means "in effect to end of run".
    fs.appendFileSync(path.join(_dbDir, 'lc_tare.jsonl'), lines.join('\n') + '\n');
  } catch (e) {
    console.warn('[LcTare] could not append the run record:', e);
  }
}

/** The live tares, for the status endpoint the calibration UI polls. */
export function currentTares(): Array<TareEntry & { entity: string }> {
  return [...loadTareMap()].map(([entity, t]) => ({ entity, ...t }));
}
