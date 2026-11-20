/**
 * The physics overlay must not depend on capture history.
 *
 * Reported on the stand 2026-09-13: two LC boards, both on physics, both falling back to
 * the same [calibration.lc] globals — and their physics curves in the cal tab looked
 * "totally different". Clearing the calibration made them match again, which is the tell:
 * the CONVERSION reads no captured points (force = adc / (sens/1000 * pga * 2^31) *
 * full_scale, config only), but the chart swept the curve across an ADC window derived
 * from the channel's own captured points. Different capture history, different x axis,
 * same line — unrecognisably so, because a capture window is a fraction of a percent of
 * the sensor's range.
 *
 * A cubic genuinely belongs on a capture window; it is nonsense away from its fit. A
 * physics curve belongs on the sensor's own full-scale range, which is the same number
 * for every channel configured the same way.
 */
import { describe, it, expect } from 'vitest';
import { physicsSweepRangeForTests, type LcPhysicsParams, type PhysicsParams } from '../components/calibration/CalibrationChart';

const LC: LcPhysicsParams = { fullScale: 300, sensitivityMvPerV: 2, pgaGain: 32 };
const ADC_MAX = 2147483648;
/** (2 / 1000) * 32 * 2^31 — the code a 300 kg load produces. */
const LC_FULL_SCALE_ADC = 0.002 * 32 * ADC_MAX;

const FEW_POINTS = [{ adc: 5_000_000, psi: 10 }, { adc: 5_400_000, psi: 20 }];

describe('physics sweep range', () => {
  it('is the same for two channels with the same params but different captures', () => {
    const a = physicsSweepRangeForTests('physics', [], undefined, LC);
    const b = physicsSweepRangeForTests('physics', FEW_POINTS, undefined, LC);
    expect(a).toEqual(b);
  });

  it('ends at the sensor full scale, not at the full ADC code', () => {
    const [lo, hi] = physicsSweepRangeForTests('physics', FEW_POINTS, undefined, LC);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(LC_FULL_SCALE_ADC, 0);
    // The old behaviour with no captures swept to 2^31 — 15x past anything this load
    // cell can output, so the y axis ran to ~4700 kg on a 300 kg cell.
    expect(hi).toBeLessThan(ADC_MAX / 10);
  });

  it('still zooms a cubic sensor to its captured points', () => {
    const [lo, hi] = physicsSweepRangeForTests('cubic', FEW_POINTS, undefined, LC);
    expect(lo).toBeLessThan(5_000_000);
    expect(hi).toBeGreaterThan(5_400_000);
    // Nowhere near the sensor's full range — that is the point of the cubic window.
    expect(hi).toBeLessThan(LC_FULL_SCALE_ADC / 10);
  });

  it('falls back to the sensor range when a cubic sensor has no captures yet', () => {
    expect(physicsSweepRangeForTests('cubic', [], undefined, LC)).toEqual([0, LC_FULL_SCALE_ADC]);
  });

  it('a 4-20 mA PT ends at 20 mA through its sense resistor', () => {
    const pt: PhysicsParams = { fullScale: 5000, isLoop: true, senseResistor: 120, adcRefVoltage: 2.5 };
    const [, hi] = physicsSweepRangeForTests('physics', [], pt);
    // 20 mA * 120 Ω = 2.4 V of a 2.5 V reference.
    expect(hi).toBeCloseTo((2.4 / 2.5) * ADC_MAX, 0);
  });

  it('a 0-5 V ratiometric PT reaches full scale at full code', () => {
    const pt: PhysicsParams = { fullScale: 1000, isLoop: false };
    expect(physicsSweepRangeForTests('physics', [], pt)).toEqual([0, ADC_MAX]);
  });
});
