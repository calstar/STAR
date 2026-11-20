/**
 * The calibration page draws a load cell's linear fit beside its cubic one, from the two fits the
 * service writes (`fits`), so an operator can see before switching where the cubic bends away
 * from the line. The browser never fits: it only picks the curves out of the record.
 */
import { describe, it, expect } from 'vitest';
import { fitCurvesForTests } from '../components/calibration/CalibrationChart';
import type { CubicCalibrationChannel } from '@/lib/types';

const base = {
  boardId: 42, connector: 1, logicalCh: 11, kind: 'LC', role: 'LOX Scale', numPoints: 5,
  status: 'OK', last_error: '', rmse: 0, degree: 1, updatedAt: 0,
  coeffs: { A: 0, B: 0, C: 0.001, D: -400 }, points: [],
} as const;

describe('fitCurvesForTests', () => {
  it('draws both fits from a record that carries them', () => {
    const rec = {
      ...base, active_model: 'linear', polyCoeffs: [50, 100], adcNormMin: 450e3, adcNormScale: 100e3,
      fits: {
        linear: { valid: true, degree: 1, rmse: 0.2, polyCoeffs: [50, 100], adcNormMin: 450e3, adcNormScale: 100e3 },
        cubic: { valid: true, degree: 3, rmse: 0.1, polyCoeffs: [50, 99, 1, 2], adcNormMin: 450e3, adcNormScale: 100e3 },
      },
    } as unknown as CubicCalibrationChannel;
    const f = fitCurvesForTests(rec);
    expect(f.linear?.poly).toEqual([50, 100]);
    expect(f.cubic?.poly).toEqual([50, 99, 1, 2]);
  });

  it('draws no line for a fit the service marked invalid (one point is not a line)', () => {
    const rec = {
      ...base, active_model: 'linear', numPoints: 1, polyCoeffs: [], adcNormMin: 0, adcNormScale: 1,
      fits: {
        linear: { valid: false, degree: 0, rmse: 0, polyCoeffs: [], adcNormMin: 0, adcNormScale: 1 },
        cubic: { valid: true, degree: 0, rmse: 0, polyCoeffs: [5], adcNormMin: 0, adcNormScale: 1 },
      },
    } as unknown as CubicCalibrationChannel;
    const f = fitCurvesForTests(rec);
    expect(f.linear).toBeUndefined();
    expect(f.cubic).toBeUndefined(); // a constant (one coefficient) is not drawn either
  });

  it('reads a file written before linear existed as its cubic', () => {
    const rec = {
      ...base, active_model: 'cubic', degree: 3, polyCoeffs: [1, 2, 3, 4], adcNormMin: 10, adcNormScale: 2,
    } as unknown as CubicCalibrationChannel;
    const f = fitCurvesForTests(rec);
    expect(f.cubic).toEqual({ poly: [1, 2, 3, 4], min: 10, scale: 2 });
    expect(f.linear).toBeUndefined();
  });
});
