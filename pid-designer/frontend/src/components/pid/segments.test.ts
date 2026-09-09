import { describe, expect, it } from 'vitest';
import { transitionBetween, transitionsOf, fittingCount, FITTING_KINDS, FITTING_LABELS } from './segments';
import type { LineSegment } from './segments';
import { boreForTube, suggestBore, THROUGH_BORE, tubeBoreMm } from './tubing';
import type { ParamValue } from './params';

const mm = (v: number): ParamValue => ({ value: v, unit: 'mm', source: 'measured' });
const seg = (id: string, bore?: ParamValue, fittings = {}): LineSegment =>
  ({ id, bore, fittings });

describe('tube bore is arithmetic', () => {
  it('is OD minus two walls', () => {
    // 1/2 x 0.035 -> 0.430 in; the number every catalogue prints.
    expect(tubeBoreMm(0.5, 0.035)).toBeCloseTo(10.922, 3);
    expect(boreForTube('1/2 × 0.035')).toBeCloseTo(10.922, 3);
    expect(boreForTube('3/8 × 0.035')).toBeCloseTo(7.747, 3);
  });

  it('carries where it came from, so a report can trace it', () => {
    expect(suggestBore('tube', '1/2 × 0.035')!.reference).toContain('OD − 2 × wall');
  });

  it('says nothing for a size it does not know', () => {
    expect(boreForTube('9/16 × 0.042')).toBeNull();
  });
});

describe('fitting standards are catalogue data, not memory', () => {
  it('ships empty rather than guessing', () => {
    // A number invented here would reach feed-twin wearing a source and a
    // reference, looking checked, and be wrong.
    for (const std of Object.keys(THROUGH_BORE) as (keyof typeof THROUGH_BORE)[]) {
      expect(Object.keys(THROUGH_BORE[std])).toEqual([]);
    }
  });

  it('returns null so the dialog asks instead of guessing', () => {
    expect(suggestBore('JIC', '-8')).toBeNull();
  });
});

describe('a change of bore is a derived transition', () => {
  it('is an expansion when the bore grows, by Borda–Carnot', () => {
    const t = transitionBetween(seg('a', mm(7.75)), seg('b', mm(10.92)))!;
    expect(t.kind).toBe('expansion');
    const beta2 = (7.75 * 7.75) / (10.92 * 10.92);
    expect(t.K).toBeCloseTo((1 - beta2) ** 2, 6);
  });

  it('is a contraction when the bore shrinks', () => {
    const t = transitionBetween(seg('a', mm(10.92)), seg('b', mm(7.75)))!;
    expect(t.kind).toBe('contraction');
  });

  it('is nothing at all when the bore is unchanged', () => {
    expect(transitionBetween(seg('a', mm(10)), seg('b', mm(10)))).toBeNull();
  });

  it('is nothing when a bore has not been stated — absent is not zero', () => {
    expect(transitionBetween(seg('a'), seg('b', mm(10)))).toBeNull();
  });

  it('compares across units', () => {
    const inches: ParamValue = { value: 0.43, unit: 'in', source: 'measured' };
    expect(transitionBetween(seg('a', inches), seg('b', mm(10.922)))).toBeNull();
  });

  it('lines transitions up with the gaps between segments', () => {
    const segs = [seg('a', mm(12)), seg('b', mm(8)), seg('c', mm(8))];
    const ts = transitionsOf(segs);
    expect(ts).toHaveLength(2);
    expect(ts[0]!.kind).toBe('contraction');
    expect(ts[1]).toBeNull();
  });
});

describe('the fitting tally', () => {
  it('counts the bag and the detailed ones together', () => {
    const s: LineSegment = {
      id: 'a',
      fittings: { elbow_90: 3, tee_run: 1 },
      detailed: [{ kind: 'contraction' }],
    };
    expect(fittingCount(s)).toBe(5);
  });

  it('names every kind feed-twin registers, and no others', () => {
    // These strings are the contract with correlations.py. A kind that is not
    // registered there has no correlation behind it and would price at zero.
    expect(FITTING_KINDS).toHaveLength(15);
    expect(Object.keys(FITTING_LABELS).sort()).toEqual([...FITTING_KINDS].sort());
  });
});
