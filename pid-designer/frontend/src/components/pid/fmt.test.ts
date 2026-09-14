import { describe, expect, it } from 'vitest';
import { fmtParam, fmtValue } from './fmt';

describe('numbers drawn on symbols', () => {
  it('puts a space before the unit', () => {
    // The engine printed 300psi and the relief 650 psi on the same sheet.
    expect(fmtParam({ value: 300, unit: 'psi', source: 'estimated' })).toBe('300 psi');
  });

  it('draws a dimensionless value bare', () => {
    expect(fmtParam({ value: 1.7, unit: '-', source: 'estimated' })).toBe('1.7');
  });

  it('cuts a long decimal to what fits', () => {
    expect(fmtValue(10.213456)).toBe('10.2');
    expect(fmtValue(0.61234)).toBe('0.612');
    expect(fmtValue(2000)).toBe('2000');
    expect(fmtValue(1234.56)).toBe('1235');
  });

  it('draws nothing for nothing', () => {
    expect(fmtParam(undefined)).toBe('');
  });
});
