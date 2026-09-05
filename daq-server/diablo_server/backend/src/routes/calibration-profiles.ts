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
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertValidProfileName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid profile name "${name}" (use letters, digits, _ or -, max 64 chars)`);
  }
}

/** Locate scripts/calibration/calibrations, covering dev (tsx) and dist layouts + cwd variants. */
function getCalibrationsDir(): string {
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

export function livePath(): string {
  return path.join(getCalibrationsDir(), 'cubic_calibration.json');
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
  for (const k of ['calibration_adc_norm_min', 'calibration_adc_norm_scale',
                   'calibration_poly_coeffs', 'calibration_polynomials']) {
    if (k in out) out[k] = {};
  }
  return out;
}

/** Create a fresh blank calibration (all sensors read 0). Optionally also save it as a profile. */
export function newBlankCalibration(name?: string): void {
  // Base the scaffold on the current live store (or the committed default) so roles/models survive.
  let base: any = { cubic_state: {} };
  const seed = existsSync(livePath()) ? livePath() : (existsSync(defaultPath()) ? defaultPath() : '');
  if (seed) {
    try { base = JSON.parse(readFileSync(seed, 'utf-8')); } catch { /* start from empty scaffold */ }
  }
  const blank = stripToBlank(base);
  const text = JSON.stringify(blank, null, 2);
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
