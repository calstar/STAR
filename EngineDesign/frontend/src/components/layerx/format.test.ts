import { describe, expect, it } from 'vitest';
import { niceTicks, stepDigits } from './format';

describe('niceTicks', () => {
  it('lands on round values inside the range', () => {
    expect(niceTicks(368, 592, 4)).toEqual([400, 450, 500, 550]);
    expect(niceTicks(-0.5, 3.6, 5)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(6506, 7278, 4)).toEqual([6600, 6800, 7000, 7200]);
  });
  it('uses 2.5 steps when they fit best', () => {
    expect(niceTicks(0, 10, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
  });
  it('gives nothing for an empty or bad range', () => {
    expect(niceTicks(5, 5)).toEqual([]);
    expect(niceTicks(NaN, 1)).toEqual([]);
  });
});

describe('stepDigits', () => {
  it('prints a step exactly', () => {
    expect(stepDigits(50)).toBe(0);
    expect(stepDigits(2.5)).toBe(1);
    expect(stepDigits(0.25)).toBe(2);
    expect(stepDigits(0.1)).toBe(1);
  });
});
