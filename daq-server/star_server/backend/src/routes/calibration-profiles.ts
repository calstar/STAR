/**
 * Named calibration profiles — a profile is a whole-rig snapshot of the calibration store.
 *
 *   scripts/calibration/calibrations/cubic_calibration.json          <- live store (gitignored,
 *                                                                       rewritten by the service)
 *   scripts/calibration/calibrations/cubic_calibration.default.json  <- committed seed (first run)
 *   scripts/calibration/calibrations/profiles/<name>.json            <- committed named snapshots
 *   scripts/calibration/calibrations/profiles/.active                <- last-loaded profile name
 *
 * The calibration service is the only process that writes the live store during a session; these
 * routes only touch it between captures (on an explicit Load / New-blank), then ask the service to
 * re-read it (cmd 7) so the swap takes effect live. All ops are plain Node file copies — no wire
 * format change — because a "calibration file" is one JSON with every sensor keyed by uid.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM has no __dirname — derive it. (Under `node dist/…` there is no tsx shim, so this is required.)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertValidProfileName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid profile name "${name}" (use letters, digits, _ or -, max 64 chars)`);
  }
}

/** Locate scripts/calibration/calibrations, covering dev (tsx) and dist layouts + cwd variants. */
function getCalibrationsDir(): string {
  // An explicit directory wins — the hermetic tests point this at a temp dir so they can never
  // touch the real live store (which the integration harness has already lost once).
  if (process.env.DAQ_CALIBRATIONS_DIR) return process.env.DAQ_CALIBRATIONS_DIR;
  const rel = 'scripts/calibration/calibrations';
  const candidates = [
    path.join(__dirname, '../../../..', rel),
    path.join(__dirname, '../../../../..', rel),
    path.join(process.cwd(), rel),
    path.join(process.cwd(), '../..', rel),
  ];
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* try next */ }
  }
  // Fall back to the first candidate; callers that need to write will mkdir it.
  return candidates[0];
}

/** Ball valve closed/open endpoints (ball-valve-cal.ts). Not session-scoped: they describe the
 *  valve, so unlike the load-cell tare this file is never cleared at session start. */
export function ballValveCalPath(): string {
  return path.join(getCalibrationsDir(), 'ball_valve_endpoints.json');
}

export function livePath(): string {
  return path.join(getCalibrationsDir(), 'cubic_calibration.json');
}
/**
 * The live load-cell tare state, written by the calibration service and read here to apply the
 * display subtraction. Lives beside the cubic store on purpose — same directory, same atomic
 * write discipline, same "read the file to learn the answer" contract, because [0x46,0x00] is
 * one-way and the service never sends a reply.
 *
 * NOT the per-run record: that is <dbDir>/lc_tare.jsonl, appended by lc-tare.ts. This file is
 * overwritten on every change and removed at session start, so it cannot serve as a record.
 */
export function tarePath(): string {
  return path.join(getCalibrationsDir(), 'lc_tare.json');
}
function defaultPath(): string {
  return path.join(getCalibrationsDir(), 'cubic_calibration.default.json');
}
export function profilesDir(): string {
  return path.join(getCalibrationsDir(), 'profiles');
}
function profilePath(name: string): string {
  assertValidProfileName(name);
  return path.join(profilesDir(), `${name}.json`);
}
function activePointerPath(): string {
  return path.join(profilesDir(), '.active');
}

function getActiveProfileName(): string {
  try {
    const raw = readFileSync(activePointerPath(), 'utf-8').trim();
    if (raw && NAME_RE.test(raw)) return raw;
  } catch { /* no pointer yet */ }
  return '';
}
function setActiveProfileName(name: string): void {
  mkdirSync(profilesDir(), { recursive: true });
  writeFileSync(activePointerPath(), name, 'utf-8');
}

export interface CalibrationProfileInfo { name: string; active: boolean; }

/** List committed calibration profiles + which one is currently loaded. */
export function listCalibrationProfiles(): { profiles: CalibrationProfileInfo[]; active: string } {
  const active = getActiveProfileName();
  let names: string[] = [];
  try {
    names = readdirSync(profilesDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((n) => NAME_RE.test(n))
      .sort();
  } catch { /* dir may not exist yet */ }
  return { profiles: names.map((name) => ({ name, active: name === active })), active };
}

/** Save the current live store as a named profile. */
export function saveCalibrationProfile(name: string): void {
  assertValidProfileName(name);
  const src = livePath();
  if (!existsSync(src)) throw new Error('No live calibration to save (capture some points first)');
  mkdirSync(profilesDir(), { recursive: true });
  copyFileSync(src, profilePath(name));
  setActiveProfileName(name);
}

/** Load a named profile into the live store (caller then triggers the service to re-read it). */
export function loadCalibrationProfile(name: string): void {
  const src = profilePath(name);
  if (!existsSync(src)) throw new Error(`Calibration profile "${name}" not found`);
  copyFileSync(src, livePath());
  setActiveProfileName(name);
}

/** Strip a calibration store to a blank scaffold: keep every channel's identity/role/model, drop
 *  all captured points and fits so the whole rig reads 0 until re-calibrated. */
function stripToBlank(json: any): any {
  const out = json && typeof json === 'object' ? json : {};
  const cs = out.cubic_state;
  if (cs && typeof cs === 'object') {
    for (const ch of Object.values<any>(cs)) {
      if (!ch || typeof ch !== 'object') continue;
      ch.points = [];
      ch.numPoints = 0;
      ch.fitCurve = [];
      ch.polyCoeffs = [];
      if (ch.coeffs && typeof ch.coeffs === 'object') {
        for (const k of Object.keys(ch.coeffs)) ch.coeffs[k] = 0.0;
      }
      ch.rmse = 0.0;
      ch.last_error = 0.0;
      ch.status = 'uncalibrated';
    }
  }
  // Both namespaces. The lc_* maps exist because PT and LC share a logical-channel space
  // (see SensorKind in CubicCalibrationStore.hpp); leaving them out would give a "blank"
  // profile that still carried every load cell's curve.
  for (const k of ['calibration_adc_norm_min', 'calibration_adc_norm_scale',
                   'calibration_poly_coeffs', 'calibration_polynomials',
                   'lc_calibration_adc_norm_min', 'lc_calibration_adc_norm_scale',
                   'lc_calibration_poly_coeffs', 'lc_calibration_polynomials']) {
    if (k in out) out[k] = {};
  }
  return out;
}

/** A blank calibration store as text: the live store (or the committed default) stripped of every
 *  point and fit, so each channel's identity/role/model survives and every sensor reads 0. */
function blankCalibrationText(): string {
  let base: any = { cubic_state: {} };
  const seed = existsSync(livePath()) ? livePath() : (existsSync(defaultPath()) ? defaultPath() : '');
  if (seed) {
    try { base = JSON.parse(readFileSync(seed, 'utf-8')); } catch { /* start from empty scaffold */ }
  }
  return JSON.stringify(stripToBlank(base), null, 2);
}

/** Create a fresh blank calibration (all sensors read 0). Optionally also save it as a profile. */
export function newBlankCalibration(name?: string): void {
  const text = blankCalibrationText();
  mkdirSync(path.dirname(livePath()), { recursive: true });
  writeFileSync(livePath(), text, 'utf-8');
  if (name) {
    assertValidProfileName(name);
    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(profilePath(name), text, 'utf-8');
    setActiveProfileName(name);
  } else {
    setActiveProfileName('');
  }
}

/**
 * Write a new named calibration profile — a copy of profile `from`, or a blank one when `from` is
 * absent — WITHOUT touching the live store or which profile is loaded. This is what a new config
 * profile gets beside it: making a config must not change what the running stream is calibrated
 * with. Refuses a name already taken, so an existing calibration is never overwritten.
 */
export function createCalibrationProfile(name: string, from?: string): void {
  assertValidProfileName(name);
  const dest = profilePath(name);
  if (existsSync(dest)) throw new Error(`Calibration profile "${name}" already exists`);
  let text: string;
  if (from) {
    const src = profilePath(from);
    if (!existsSync(src)) throw new Error(`Calibration profile "${from}" not found`);
    text = readFileSync(src, 'utf-8');
  } else {
    text = blankCalibrationText();
  }
  mkdirSync(profilesDir(), { recursive: true });
  writeFileSync(dest, text, 'utf-8');
}

/** Remove a calibration profile created a moment ago (rollback when the config beside it failed). */
export function removeCalibrationProfile(name: string): void {
  rmSync(profilePath(name), { force: true });
}
