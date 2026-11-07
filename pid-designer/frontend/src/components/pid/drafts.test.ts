import { describe, expect, it } from 'vitest';
import { fromDraft, pickProvenance, placeholderFor, toDraft } from './drafts';
import type { ParamSpec } from './spec';
import type { ParamValue } from './params';

const cv: ParamSpec = { key: 'Cv', label: 'Cv', dimension: 'flow_coefficient' };
const k: ParamSpec = {
  key: 'K_minor', label: 'Lumped fitting K', dimension: 'dimensionless',
  suggested: { value: 0, unit: '-' },
};

describe('a number survives being opened and saved', () => {
  it('keeps a manufacturer source as manufacturer', () => {
    // The bug: opening the dialog turned every datasheet number into
    // "measured" and every catalogue default into "estimated".
    const out = fromDraft(toDraft(cv, { value: 0.8, unit: 'Cv', source: 'manufacturer',
      reference: 'Tescom 26-1000 datasheet rev C' }));
    expect(out).toEqual({ value: 0.8, unit: 'Cv', source: 'manufacturer',
      reference: 'Tescom 26-1000 datasheet rev C' });
  });

  it('keeps a catalogue default as default, with its reference', () => {
    const out = fromDraft(toDraft(cv, { value: 10.21, unit: 'mm', source: 'default',
      reference: 'catalogue: 1/2 x 0.049 tube' }));
    expect(out?.source).toBe('default');
    expect(out?.reference).toBe('catalogue: 1/2 x 0.049 tube');
  });

  it('never drops the reference', () => {
    const out = fromDraft(toDraft(cv, { value: 4, unit: 'Cv', source: 'measured',
      reference: 'flow bench 2026-08-12' }));
    expect(out?.reference).toBe('flow bench 2026-08-12');
  });
});

describe('a suggestion is not a value', () => {
  it('leaves a field with a suggestion blank', () => {
    // Save on an untouched line used to write K_minor: 0, estimated.
    expect(toDraft(k).value).toBe('');
    expect(fromDraft(toDraft(k))).toBeUndefined();
  });

  it('shows the suggestion as what happens if nothing is typed', () => {
    expect(placeholderFor(k)).toBe('0 - if blank');
    expect(placeholderFor(cv)).toBe('—');
  });

  it('takes the suggested unit so a typed number lands in it', () => {
    expect(toDraft({ ...k, suggested: { value: 1.5e-3, unit: 'mm' }, dimension: 'length' }).unit).toBe('mm');
  });

  it('writes nothing for blank, garbage or whitespace', () => {
    expect(fromDraft({ value: '', unit: 'Cv', source: 'estimated' })).toBeUndefined();
    expect(fromDraft({ value: '  ', unit: 'Cv', source: 'estimated' })).toBeUndefined();
    expect(fromDraft({ value: 'abc', unit: 'Cv', source: 'estimated' })).toBeUndefined();
  });
});

describe('the two-way provenance select', () => {
  const sheet = { value: '0.8', unit: 'Cv', source: 'manufacturer' as const, reference: 'datasheet' };

  it('changes nothing when left where it already reads', () => {
    expect(pickProvenance(sheet, true)).toBe(sheet);
  });

  it('moves to the plain member of the other pair and drops the reference', () => {
    // "Estimate" said of a datasheet number: the sheet no longer describes it.
    expect(pickProvenance(sheet, false)).toEqual({ value: '0.8', unit: 'Cv', source: 'estimated' });
  });

  it('promotes an estimate to measured, not manufacturer', () => {
    expect(pickProvenance({ value: '4', unit: 'Cv', source: 'estimated' }, true).source).toBe('measured');
  });
});

describe('a pressure at a place, reopened', () => {
  const spec = (key: string) => ({ key, label: key, dimension: 'pressure' }) as ParamSpec;
  const at = (value: number, unit: string) => ({ value, unit, source: 'measured' }) as ParamValue;

  it('opens a gauge or bare psi in psia, the number the sheet prints', () => {
    // The COPV drawn at "4000 psi" is 4014.7 psia on the sheet; the dialog
    // said 4000 beside it.
    expect(toDraft(spec('pressure'), at(4000, 'psi'), 'KBOTTLE')).toMatchObject({ value: '4014.696', unit: 'psia', source: 'measured' });
    expect(toDraft(spec('burst_pressure'), at(15000, 'psig'), 'KBOTTLE')).toMatchObject({ value: '15014.696', unit: 'psia' });
  });

  it('keeps an engine pressure and a psia one as they are', () => {
    expect(toDraft(spec('chamber_pressure'), at(385, 'psi'), 'ENGINE')).toMatchObject({ value: '385', unit: 'psia' });
    expect(toDraft(spec('pressure'), at(600, 'psia'), 'TANK')).toMatchObject({ value: '600', unit: 'psia' });
  });

  it('says the reference of a metric pressure without converting it', () => {
    expect(toDraft(spec('pressure'), at(40, 'bar'), 'TANK')).toMatchObject({ value: '40', unit: 'barg' });
  });

  it('leaves a difference in plain psi', () => {
    expect(toDraft(spec('set_pressure'), at(750, 'psi'), 'RV')).toMatchObject({ value: '750', unit: 'psi' });
  });

  it('saves back to the same pressure, to a ten-thousandth of a psi', () => {
    const back = fromDraft(toDraft(spec('pressure'), at(4000, 'psi'), 'KBOTTLE'))!;
    expect(back.unit).toBe('psia');
    expect(Math.abs(back.value - 14.695948775513 - 4000)).toBeLessThan(1e-4);
  });
});

describe('a number reopened to a sensible precision', () => {
  const at = (value: number, unit: string) => ({ value, unit, source: 'estimated' }) as ParamValue;
  const length = (key: string) => ({ key, label: key, dimension: 'length' }) as ParamSpec;

  it('shows a sketch\'s inch bore and its fall without the binary noise', () => {
    // LE4 (3)'s junc_49-junc_48 line: 0.43 in times 25.4, and the fall off
    // the sketch's geometry, shown verbatim as 10.921999999999999 mm and
    // 0.8029517354603677 m.
    expect(toDraft(length('bore'), at(0.43 * 25.4, 'mm')).value).toBe('10.922');
    expect(toDraft(length('fall'), at(0.8029517354603677, 'm')).value).toBe('0.802952');
  });

  it('leaves a number with no more to it as it was typed', () => {
    expect(toDraft(length('length'), at(0.817, 'm')).value).toBe('0.817');
    expect(toDraft(cv, at(0.0015, 'Cv')).value).toBe('0.0015');
  });

  it('keeps a pressure to the thousandth of a psi it was typed to', () => {
    const p = { key: 'pressure', label: 'p', dimension: 'pressure' } as ParamSpec;
    expect(toDraft(p, at(15014.696, 'psia'), 'KBOTTLE').value).toBe('15014.696');
  });
});
