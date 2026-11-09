/**
 * A new config profile gets a calibration profile of the same name: a copy of an existing one, or
 * a fresh blank. Making it must not change what the running stream is calibrated with — neither
 * the live store nor which profile is loaded — and must never overwrite a calibration.
 *
 * Hermetic: DAQ_CALIBRATIONS_DIR points every calibration path at a temp directory.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'daq-calprof-'));
process.env.DAQ_CALIBRATIONS_DIR = dir;
const cal = await import('../routes/calibration-profiles.js');

const profiles = join(dir, 'profiles');
const live = join(dir, 'cubic_calibration.json');
const STORE = JSON.stringify({
  cubic_state: { '0x2011': { role: 'LOX Tank', points: [[1, 2]], numPoints: 1, status: 'calibrated', rmse: 0.4 } },
  calibration_poly_coeffs: { '0x2011': [1, 2, 3] },
});
const LIVE = JSON.stringify({ cubic_state: { '0x2011': { role: 'LOX Tank', points: [[9, 9]], numPoints: 1 } } });

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(profiles, { recursive: true });
  writeFileSync(join(profiles, 'hotfire.json'), STORE);
  writeFileSync(join(profiles, '.active'), 'hotfire');
  writeFileSync(live, LIVE);
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.DAQ_CALIBRATIONS_DIR; });

describe('createCalibrationProfile', () => {
  it('copies an existing profile byte for byte', () => {
    cal.createCalibrationProfile('cold_flow', 'hotfire');
    expect(readFileSync(join(profiles, 'cold_flow.json'), 'utf-8')).toBe(STORE);
  });

  it('makes a fresh one with every point and fit dropped but the channels kept', () => {
    cal.createCalibrationProfile('cold_flow');
    const blank = JSON.parse(readFileSync(join(profiles, 'cold_flow.json'), 'utf-8'));
    const ch = blank.cubic_state['0x2011'];
    expect(ch.role).toBe('LOX Tank');
    expect(ch.points).toEqual([]);
    expect(ch.status).toBe('uncalibrated');
  });

  it('leaves the live store and the loaded profile alone', () => {
    cal.createCalibrationProfile('a', 'hotfire');
    cal.createCalibrationProfile('b');
    expect(readFileSync(live, 'utf-8')).toBe(LIVE);
    expect(cal.listCalibrationProfiles().active).toBe('hotfire');
  });

  it('refuses a name already taken, and a source that does not exist', () => {
    expect(() => cal.createCalibrationProfile('hotfire')).toThrow(/already exists/);
    expect(readFileSync(join(profiles, 'hotfire.json'), 'utf-8')).toBe(STORE);
    expect(() => cal.createCalibrationProfile('x', 'nope')).toThrow(/not found/);
    expect(existsSync(join(profiles, 'x.json'))).toBe(false);
  });

  it('removeCalibrationProfile undoes a create', () => {
    cal.createCalibrationProfile('tmp');
    cal.removeCalibrationProfile('tmp');
    expect(existsSync(join(profiles, 'tmp.json'))).toBe(false);
  });
});
