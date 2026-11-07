import { describe, expect, it } from 'vitest';
import { MONO_ADVANCE, TANK_READOUT_W, fitMono, fmtParam, fmtValue } from './fmt';

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

describe('a readout that has to fit inside a symbol', () => {
  // TankNode's barrel is 48 px between its walls (x 6..54). LE4 (3)'s COPV
  // printed '3764.7 psia' at 7.5 px monospace, 49.7 px wide, through both
  // walls, and its export read the leading 3 as an 8. Any tank pressure of
  // 1000 psia or more is eleven characters.
  const wide = (text: string, size: number) => text.length * MONO_ADVANCE * size;

  it('shrinks one too wide for the room, until it fits', () => {
    const size = fitMono('3764.7 psia', TANK_READOUT_W, 7.5);
    expect(size).toBeLessThan(7.5);
    expect(wide('3764.7 psia', size)).toBeLessThanOrEqual(TANK_READOUT_W);
    expect(TANK_READOUT_W).toBeLessThan(48);
  });

  it('leaves one that already fits at its size', () => {
    expect(fitMono('599.7 psia', TANK_READOUT_W, 7.5)).toBe(7.5);
    expect(fitMono('90.2 K', TANK_READOUT_W, 7.5)).toBe(7.5);
  });
});
