/**
 * Ball valve two-point calibration: the operator's closed/open readings replace the ideal
 * 4-20 mA line. The stand's Ox Vent read ~355 counts fully closed (2026-11-05), where the ideal
 * line puts 4 mA at 496 -- so closed showed as NO SIGNAL / a negative position.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bvcal-'));
const file = path.join(dir, 'ball_valve_endpoints.json');
vi.mock('../routes/calibration-profiles.js', () => ({ ballValveCalPath: () => file }));

const cal = await import('../ball-valve-cal.js');
const E = 'BV1_Cal.CH1';

/** One [0x34] packet as parseElodinPacket returns it. */
const packet = (counts: number, status = 1, pct = 0) => [
  { entity: E, component: 'position_pct', value: pct, timestamp: 0 },
  { entity: E, component: 'raw_adc', value: counts, timestamp: 0 },
  { entity: E, component: 'cal_status', value: status, timestamp: 0 },
];
const pctOf = (list: { component: string; value: number }[]) =>
  list.find((p) => p.component === 'position_pct')!.value;

/** Feed `n` samples of `counts` over the last second ending at `t`. */
function feed(counts: number, t: number, n = 10, status = 1) {
  for (let i = n - 1; i >= 0; i--) cal.applyValveCalibration(packet(counts, status), t - i * 100);
}

beforeEach(() => { cal._resetValveCalForTest(); try { fs.unlinkSync(file); } catch { /* none */ } });
afterEach(() => vi.useRealTimers());

describe('percentOpen', () => {
  it('interpolates between the two readings and clamps outside them', () => {
    const ep = { closedCounts: 355, openCounts: 2355 };
    expect(cal.percentOpen(355, ep)).toBe(0);
    expect(cal.percentOpen(1355, ep)).toBe(50);
    expect(cal.percentOpen(2355, ep)).toBe(100);
    expect(cal.percentOpen(300, ep)).toBe(0);
    expect(cal.percentOpen(2500, ep)).toBe(100);
  });
  it('a missing endpoint is the ideal loop', () => {
    expect(cal.percentOpen(cal.IDEAL_OPEN_COUNTS, { closedCounts: 355 })).toBe(100);
    expect(cal.percentOpen(355, { openCounts: 2482 })).toBe(0);
  });
});

describe('capture and apply', () => {
  it('without endpoints the stream is untouched', () => {
    const list = packet(355, 1, 0);
    expect(cal.applyValveCalibration(list, 1000)).toBe(list);
  });

  it('closed then open: the stream reads along the operator\'s line', () => {
    feed(355, 10_000);
    expect(cal.captureEndpoint(E, 'closed', 10_000).ok).toBe(true);
    feed(2355, 20_000);
    expect(cal.captureEndpoint(E, 'open', 20_000).ok).toBe(true);
    expect(pctOf(cal.applyValveCalibration(packet(1355), 21_000))).toBe(50);
    expect(pctOf(cal.applyValveCalibration(packet(355), 21_100))).toBe(0);
    // Survives a restart: it is the file, not memory.
    cal._resetValveCalForTest();
    expect(pctOf(cal.applyValveCalibration(packet(2355), 30_000))).toBe(100);
  });

  it('captures the mean of the last second, not one sample', () => {
    for (const [i, c] of [350, 360, 355, 345, 365].entries()) cal.applyValveCalibration(packet(c), 9_000 + i * 200);
    const r = cal.captureEndpoint(E, 'closed', 9_900);
    expect(r.ok && r.endpoints.closedCounts).toBe(355);
  });

  it('a dead loop is left alone and cannot be captured as closed', () => {
    feed(355, 10_000);
    cal.captureEndpoint(E, 'closed', 10_000);
    const dead = packet(0, 2, 0);
    expect(cal.applyValveCalibration(dead, 11_000)).toBe(dead);
    feed(0, 20_000, 10, 2);
    const r = cal.captureEndpoint(E, 'closed', 20_000);
    expect(r.ok).toBe(false);
  });

  it('refuses with no recent data, and refuses endpoints too close to divide by', () => {
    expect(cal.captureEndpoint(E, 'closed', 50_000).ok).toBe(false);
    feed(355, 60_000);
    cal.captureEndpoint(E, 'closed', 60_000);
    feed(400, 70_000);
    const r = cal.captureEndpoint(E, 'open', 70_000);
    expect(r.ok).toBe(false);
  });

  it('clear goes back to the ideal loop', () => {
    feed(355, 10_000);
    cal.captureEndpoint(E, 'closed', 10_000);
    cal.clearEndpoints(E);
    const list = packet(355, 1, 0);
    expect(cal.applyValveCalibration(list, 11_000)).toBe(list);
  });
});
