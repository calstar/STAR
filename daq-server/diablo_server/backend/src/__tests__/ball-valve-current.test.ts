/**
 * Ball valve command current store: what config_broadcast reads to send each board
 * VALVE_CURRENT_CONFIG. The file shape is a contract with lib ValveCommandCurrent.hpp
 * (closed_ma / open_ma under valves.<BV entity>), so it is asserted on disk, not only through
 * loadCurrents.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bvcur-'));
const file = path.join(dir, 'ball_valve_currents.json');
const trials = path.join(dir, 'ball_valve_trials.json');
vi.mock('../routes/calibration-profiles.js', () => ({ ballValveCurrentPath: () => file, ballValveTrialsPath: () => trials }));

const cur = await import('../ball-valve-current.js');
const E = 'BV1_Cal.CH1';

beforeEach(() => { for (const f of [file, trials]) { try { fs.unlinkSync(f); } catch { /* none */ } } });

describe('validateCurrents', () => {
  it('takes 4 / 20 and the limits themselves', () => {
    expect(cur.validateCurrents(4, 20)).toBeNull();
    expect(cur.validateCurrents(3.8, 20.475)).toBeNull();
  });
  it('refuses below 3.8 (the board faults at 3.6), above DAC full scale, NaN, and a tiny span', () => {
    expect(cur.validateCurrents(3.7, 20)).toMatch(/Closed/);
    expect(cur.validateCurrents(4, 20.5)).toMatch(/Open/);
    expect(cur.validateCurrents(NaN, 20)).toMatch(/not a number/);
    expect(cur.validateCurrents(12, 12.5)).toMatch(/apart/);
  });
  it('allows a reverse-acting valve, open below closed', () => {
    expect(cur.validateCurrents(20, 4)).toBeNull();
  });
});

describe('store', () => {
  it('with no file every valve is on the defaults', () => {
    expect(cur.loadCurrents().size).toBe(0);
    expect(cur.currentsSnapshot().defaults).toEqual({ closedMa: 4, openMa: 20 });
  });

  it('writes the shape config_broadcast parses, rounded to 0.01 mA', () => {
    expect(cur.setCurrents(E, 4.1234, 19.555, 1000)).toEqual({ ok: true });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk).toEqual({ valves: { [E]: { closed_ma: 4.12, open_ma: 19.56, updated_at_ms: 1000 } } });
    expect(cur.loadCurrents().get(E)).toEqual({ closedMa: 4.12, openMa: 19.56, updatedAtMs: 1000 });
  });

  it('refuses a bad entity or bad currents and leaves the file alone', () => {
    cur.setCurrents(E, 4, 19.5);
    const before = fs.readFileSync(file, 'utf8');
    expect(cur.setCurrents('PT1_Cal.CH1', 4, 20)).toMatchObject({ ok: false });
    expect(cur.setCurrents(E, 2, 20)).toMatchObject({ ok: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('clear drops one valve and keeps the others', () => {
    cur.setCurrents(E, 4.2, 19.5);
    cur.setCurrents('BV1_Cal.CH2', 4.0, 20.3);
    cur.clearCurrents(E);
    expect([...cur.loadCurrents().keys()]).toEqual(['BV1_Cal.CH2']);
  });

  it('ignores a hand-edited entry out of range rather than serving it', () => {
    fs.writeFileSync(file, JSON.stringify({ valves: { [E]: { closed_ma: 1, open_ma: 20 } } }));
    expect(cur.loadCurrents().size).toBe(0);
  });
});

describe('trial, then save as open / closed', () => {
  it('a trial is written with an expiry, in the shape config_broadcast parses', () => {
    expect(cur.startTrial(E, 19.6, 1000)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(trials, 'utf8'))).toEqual({ valves: { [E]: { ma: 19.6, expires_at_ms: 1000 + cur.TRIAL_MS } } });
    expect(cur.loadTrials(1001).get(E)?.ma).toBe(19.6);
    expect(cur.loadTrials(1000 + cur.TRIAL_MS).size).toBe(0);  // expired
  });

  it('refuses a trial out of range', () => {
    expect(cur.startTrial(E, 3, 0)).toMatchObject({ ok: false });
    expect(cur.startTrial(E, 21, 0)).toMatchObject({ ok: false });
    expect(fs.existsSync(trials)).toBe(false);
  });

  it('save as open stores the trial as open, keeps closed, and ends the trial', () => {
    cur.setCurrents(E, 4.2, 20, 0);
    cur.startTrial(E, 19.55, 1000);
    expect(cur.saveTrialAs(E, 'open', 2000)).toEqual({ ok: true });
    expect(cur.loadCurrents().get(E)).toMatchObject({ closedMa: 4.2, openMa: 19.55 });
    expect(cur.loadTrials(2000).has(E)).toBe(false);
  });

  it('save as closed on a never-calibrated valve keeps open at 20', () => {
    cur.startTrial(E, 4.35, 1000);
    expect(cur.saveTrialAs(E, 'closed', 1500)).toEqual({ ok: true });
    expect(cur.loadCurrents().get(E)).toMatchObject({ closedMa: 4.35, openMa: 20 });
  });

  it('save with no trial running is refused', () => {
    expect(cur.saveTrialAs(E, 'open', 0)).toMatchObject({ ok: false, error: expect.stringMatching(/Drive/) });
  });

  it('save that would put the two ends under 1 mA apart is refused and the trial keeps running', () => {
    cur.startTrial(E, 19.5, 1000);  // closed is 4; fine as open, not as closed vs open 20
    expect(cur.saveTrialAs(E, 'closed', 1500)).toMatchObject({ ok: false });
    expect(cur.loadTrials(1500).has(E)).toBe(true);
  });

  it('reset ends a running trial too', () => {
    cur.setCurrents(E, 4.2, 19.5, 0);
    cur.startTrial(E, 12, Date.now());
    cur.clearCurrents(E);
    expect(cur.loadCurrents().size).toBe(0);
    expect(cur.loadTrials().size).toBe(0);
  });
});
