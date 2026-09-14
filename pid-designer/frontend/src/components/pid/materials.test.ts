import { describe, expect, it } from 'vitest';
import {
  TANK_MATERIALS, INSULATIONS, TEMPERATURES, DEFAULT_MATERIAL,
  cvFromCd, paramFromPreset, saturationK,
} from './materials';

describe('what a material writes for you', () => {
  it('names its source, and says when it is unverified', () => {
    for (const m of TANK_MATERIALS) {
      const p = paramFromPreset(m);
      expect(p.source).toBe('default');
      expect(p.reference).toContain(m.verified ? m.reference : 'UNVERIFIED');
    }
  });

  it('defaults to aluminium', () => {
    expect(TANK_MATERIALS.find(m => m.id === DEFAULT_MATERIAL)?.label).toMatch(/6061/);
  });

  it('carries the fiberglass figure as arithmetic on the bag', () => {
    const f = INSULATIONS[0];
    // k = t / R: 0.0889 m / (13 × 0.1761 m²K/W)
    expect(f.value).toBeCloseTo(0.0889 / (13 * 0.1761), 2);
    expect(f.reference).toMatch(/R-13/);
  });

  it('has the cryogens at their NIST boiling points', () => {
    expect(TEMPERATURES.find(t => t.id === 'lox')?.value).toBeCloseTo(90.19, 2);
    expect(TEMPERATURES.find(t => t.id === 'ln2')?.value).toBeCloseTo(77.36, 2);
  });
});

describe('what a dewar sits at', () => {
  const psi = (p: number) => p * 6894.757293168361;

  it('gives the normal boiling point at one atmosphere', () => {
    expect(saturationK('nitrogen', 101325)).toBeCloseTo(77.4, 0);
    expect(saturationK('oxygen', 101325)).toBeCloseTo(90.2, 0);
  });

  it('follows the curve up with delivery pressure', () => {
    // 35 psia LN2 sits around 85.5 K; 22 psia LOX around 94 K.
    expect(saturationK('nitrogen', psi(35))).toBeCloseTo(85.5, 0);
    expect(saturationK('oxygen', psi(22))).toBeCloseTo(94.3, 0);
    expect(saturationK('nitrogen', psi(100))).toBeGreaterThan(saturationK('nitrogen', psi(35))!);
  });

  it('lands on the table exactly at a tabulated point', () => {
    expect(saturationK('nitrogen', psi(112.88))).toBeCloseTo(100, 1);
  });

  it('refuses off the table, and for a fluid it has no curve for', () => {
    expect(saturationK('nitrogen', psi(1000))).toBeUndefined();
    expect(saturationK('ethanol', 101325)).toBeUndefined();
    expect(saturationK('oxygen', 0)).toBeUndefined();
  });
});

describe('Cd to Cv', () => {
  it('is 38 gpm per square inch per unit Cd', () => {
    // One square inch is a bore of 1.1284 in = 28.66 mm.
    expect(cvFromCd(1, 28.66)).toBeCloseTo(38.0, 1);
    expect(cvFromCd(0.6, 28.66)).toBeCloseTo(22.8, 1);
  });

  it('scales with the area, not the diameter', () => {
    expect(cvFromCd(0.6, 12.7) / cvFromCd(0.6, 6.35)).toBeCloseTo(4, 2);
  });
});
