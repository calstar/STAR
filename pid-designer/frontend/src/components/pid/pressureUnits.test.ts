// A drawing's pressures: bare is gauge, "a" is absolute, and a difference never
// carries a reference -- the rule feed-twin reads by (feedtwin.model.pressure).
import { describe, expect, it } from 'vitest';
import { explicitUnit, pressureNote, toAbsolutePa, toGaugePa, toPsia, unitsFor } from './params';
import { fmtPressure } from './fmt';

const PSI = 6894.757293168361;

describe('pressure references', () => {
  it('reads a bare psi as gauge and psia as absolute', () => {
    expect(toGaugePa({ value: 500, unit: 'psi' } as never)).toBeCloseTo(500 * PSI);
    expect(toGaugePa({ value: 514.696, unit: 'psia' } as never)).toBeCloseTo(500 * PSI, 0);
    expect(toAbsolutePa({ value: 500, unit: 'psig' } as never)).toBeCloseTo(500 * PSI + 101325);
  });

  it('offers a difference no gauge or absolute spelling', () => {
    expect(unitsFor({ key: 'dome_bias', dimension: 'pressure' })).not.toContain('psig');
    expect(unitsFor({ key: 'set_pressure', dimension: 'pressure' })).not.toContain('psia');
    expect(unitsFor({ key: 'setpoint', dimension: 'pressure' })).toEqual(
      expect.arrayContaining(['psig', 'psia']),
    );
    expect(pressureNote('dome_bias')).toMatch(/difference/);
    expect(pressureNote('pressure')).toMatch(/psia is absolute; psig is gauge/);
  });

  it('offers a pressure at a place only with its reference, psia first', () => {
    // A bare psi meant gauge on a tank and absolute on the engine; the
    // drawing printed both as "psi". It is read still, but not offered.
    const units = unitsFor({ key: 'pressure', dimension: 'pressure' });
    expect(units[0]).toBe('psia');
    expect(units).not.toContain('psi');
    expect(units).not.toContain('bar');
    expect(unitsFor({ key: 'set_pressure', dimension: 'pressure' })).toContain('psi');
  });

  it('reopens a bare unit saying the reference it was read with', () => {
    expect(explicitUnit('pressure', 'psi', 'TANK')).toBe('psig');
    expect(explicitUnit('chamber_pressure', 'psi', 'ENGINE')).toBe('psia');
    expect(explicitUnit('pressure', 'bar', 'SUPPLY')).toBe('barg');
    expect(explicitUnit('set_pressure', 'psi', 'RV')).toBe('psi');
    expect(explicitUnit('pressure', 'psia', 'TANK')).toBe('psia');
  });
});

describe('a pressure as the drawing prints it', () => {
  const p = (value: number, unit: string) => ({ value, unit, source: 'measured' }) as never;

  it('prints a pressure at a place in psia, whatever it was written in', () => {
    // The dry run's readouts: COPV "4000 psi", tank "585 psi", engine "385 psi".
    expect(fmtPressure('pressure', p(4000, 'psi'))).toBe('4014.7 psia');
    expect(fmtPressure('pressure', p(585, 'psi'), 'TANK')).toBe('599.7 psia');
    expect(fmtPressure('chamber_pressure', p(385, 'psi'), 'ENGINE')).toBe('385 psia');
    expect(fmtPressure('pressure', p(600, 'psia'))).toBe('600 psia');
    expect(fmtPressure('pressure', p(585, 'psig'))).toBe('599.7 psia');
    expect(toPsia(p(40, 'bar'))).toBeCloseTo((40e5 + 101325) / PSI, 6);
  });

  it('prints a difference in plain psi', () => {
    expect(fmtPressure('set_pressure', p(600, 'psi'))).toBe('600 psi');
    expect(fmtPressure('dome_bias', p(50, 'psi'))).toBe('50 psi');
  });

  it('falls back to the number as written for a unit it does not know', () => {
    expect(fmtPressure('pressure', p(3, 'furlongs'))).toBe('3 furlongs');
    expect(fmtPressure('pressure', undefined)).toBe('');
  });
});
