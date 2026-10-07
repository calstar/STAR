// A drawing's pressures: bare is gauge, "a" is absolute, and a difference never
// carries a reference -- the rule feed-twin reads by (feedtwin.model.pressure).
import { describe, expect, it } from 'vitest';
import { pressureNote, toAbsolutePa, toGaugePa, unitsFor } from './params';

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
      expect.arrayContaining(['psi', 'psig', 'psia']),
    );
    expect(pressureNote('dome_bias')).toMatch(/difference/);
    expect(pressureNote('pressure')).toMatch(/gauge unless psia/);
  });
});
