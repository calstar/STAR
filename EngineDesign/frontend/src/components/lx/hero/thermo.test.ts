import { describe, expect, it } from 'vitest';
import { areaRatio, machAt, stateAlong } from './thermo';

describe('the gas along the engine', () => {
  it('is sonic at the throat, where T*/Tc = 2/(γ+1)', () => {
    const s = stateAlong([2, 1.5, 1, 1.4, 2], 2, 3000, 400, 1.2, 1.2);
    expect(s.M[2]).toBe(1);
    expect(s.T[2]).toBeCloseTo((3000 * 2) / 2.2, 6);
    // p*/pc = (2/(γ+1))^(γ/(γ-1)): 0.5645 at γ = 1.2.
    expect(s.p[2] / 400).toBeCloseTo(Math.pow(2 / 2.2, 1.2 / 0.2), 6);
  });

  it('is subsonic upstream and supersonic downstream of the throat at the same area', () => {
    const s = stateAlong([2, 1, 2], 1, 3000, 400, 1.2, 1.2);
    expect(s.M[0]).toBeLessThan(1);
    expect(s.M[2]).toBeGreaterThan(1);
    expect(s.T[2]).toBeLessThan(s.T[0]);
  });

  it('inverts the area–Mach relation on both branches (γ = 1.4: M 2 at A/A* 1.6875)', () => {
    expect(areaRatio(2, 1.4)).toBeCloseTo(1.6875, 4);
    expect(machAt(1.6875, 1.4, true)).toBeCloseTo(2, 4);
    expect(machAt(areaRatio(0.3, 1.4), 1.4, false)).toBeCloseTo(0.3, 5);
  });
});
