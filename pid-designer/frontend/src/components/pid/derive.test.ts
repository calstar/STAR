import { describe, expect, it } from 'vitest';
import { deriveLineParams, deriveParams, supplyCoefficient } from './derive';


describe('what the tank dialog writes from its dropdowns', () => {
  it('writes the wall specific heat from the material, as a default with a reference', () => {
    const out = deriveParams('TANK', { material: 'al6061', insulation: 'none' }, {});
    expect(out.wall_capacity).toMatchObject({ value: 897, unit: 'J/(kg.K)', source: 'default' });
    expect(out.wall_capacity.reference).toMatch(/NIST/);
  });

  it('marks an unverified material as such', () => {
    const out = deriveParams('TANK', { material: 'copv', insulation: 'none' }, {});
    expect(out.wall_capacity.reference).toMatch(/UNVERIFIED/);
  });

  it('writes the fiberglass conductivity and keeps the thickness that was typed', () => {
    const out = deriveParams('TANK', { material: 'al6061', insulation: 'fiberglass_r13' },
      { insulation_thickness: { value: 25, unit: 'mm', source: 'measured' } });
    expect(out.insulation_conductivity).toMatchObject({ value: 0.039, source: 'default' });
    expect(out.insulation_thickness.value).toBe(25);
  });

  it('leaves a custom conductivity alone, and strips both when bare', () => {
    const typed = { insulation_conductivity: { value: 0.05, unit: 'W/(m.K)', source: 'measured' as const },
      insulation_thickness: { value: 10, unit: 'mm', source: 'measured' as const } };
    expect(deriveParams('TANK', { material: 'al6061', insulation: 'custom' }, typed).insulation_conductivity.value).toBe(0.05);
    const bare = deriveParams('TANK', { material: 'al6061', insulation: 'none' }, typed);
    expect(bare.insulation_conductivity).toBeUndefined();
    expect(bare.insulation_thickness).toBeUndefined();
  });
});

describe('Cd and Cv', () => {
  it('writes the Cv a Cd and a bore amount to', () => {
    const out = deriveParams('MAN', { flowCoefficient: 'Cd' },
      { Cd: { value: 0.6, unit: '-', source: 'manufacturer' }, bore: { value: 28.66, unit: 'mm', source: 'measured' } });
    expect(out.Cv).toMatchObject({ unit: 'Cv', source: 'default' });
    expect(out.Cv.value).toBeCloseTo(22.8, 1);
    expect(out.Cd.value).toBe(0.6);
  });

  it('takes a bore in inches too', () => {
    const out = deriveParams('MAN', { flowCoefficient: 'Cd' },
      { Cd: { value: 0.6, unit: '-', source: 'manufacturer' }, bore: { value: 1.1284, unit: 'in', source: 'measured' } });
    expect(out.Cv.value).toBeCloseTo(22.8, 1);
  });

  it('writes no Cv without a bore, and no stale Cd when Cv is chosen', () => {
    expect(deriveParams('MAN', { flowCoefficient: 'Cd' }, { Cd: { value: 0.6, unit: '-', source: 'measured' } }).Cv).toBeUndefined();
    const out = deriveParams('MAN', { flowCoefficient: 'Cv' },
      { Cd: { value: 0.6, unit: '-', source: 'measured' }, Cv: { value: 4, unit: 'Cv', source: 'measured' } });
    expect(out.Cd).toBeUndefined();
    expect(out.Cv.value).toBe(4);
  });
});

describe('the supply effect, as the datasheet prints it', () => {
  it('stores 17 per 1000 as 17 psi/1000psi', () => {
    expect(supplyCoefficient(17, 1000, 'manufacturer')).toMatchObject({ value: 17, unit: 'psi/1000psi' });
  });

  it('scales a pair quoted per some other inlet drop', () => {
    expect(supplyCoefficient(8.5, 500, 'manufacturer')?.value).toBe(17);
  });

  it('keeps the pair in the reference', () => {
    expect(supplyCoefficient(8.5, 500, 'manufacturer')?.reference).toBe('8.5 psi outlet rise per 500 psi inlet drop');
  });

  it('refuses a zero or missing inlet drop', () => {
    expect(supplyCoefficient(17, 0, 'estimated')).toBeUndefined();
    expect(supplyCoefficient(NaN, 1000, 'estimated')).toBeUndefined();
  });
});

describe('what the line dialog writes from its choices', () => {
  const mm = (value: number) => ({ value, unit: 'mm', source: 'measured' as const });

  it('turns the material into a roughness with its source', () => {
    const { params, lineType } = deriveLineParams({ material: 'al6061', hose: 'no' }, {});
    expect(lineType).toBe('pipe');
    expect(params.roughness).toMatchObject({ value: 0.0015, unit: 'mm', source: 'default' });
    expect(params.roughness.reference).toMatch(/Moody/);
  });

  it('says when a stainless figure was measured on a different alloy', () => {
    const { params } = deriveLineParams({ material: 'ss316_polished', hose: 'no' }, {});
    expect(params.roughness.reference).toMatch(/UNVERIFIED/);
  });

  it('takes a custom roughness as typed', () => {
    const { params } = deriveLineParams({ material: 'custom', hose: 'no' }, { roughness_custom: mm(0.01) });
    expect(params.roughness.value).toBe(0.01);
    expect(params.roughness_custom).toBeUndefined();
  });

  it('stores a fall as a negative rise, in the same unit', () => {
    // 0.8 m of fall is what somebody measures; feed-twin defines a rise.
    const { params } = deriveLineParams({ material: 'al6061', hose: 'no' },
      { fall: { value: 0.8, unit: 'm', source: 'measured' } });
    expect(params.elevation_change).toMatchObject({ value: -0.8, unit: 'm', source: 'measured' });
    expect(params.fall).toBeUndefined();
  });

  it('makes a hose a flex_hose with its construction', () => {
    const out = deriveLineParams({ material: 'al6061', hose: 'convoluted' }, {});
    expect(out.lineType).toBe('flex_hose');
    expect(out.construction).toBe('convoluted');
  });
});
