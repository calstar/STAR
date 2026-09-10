import { describe, expect, it } from 'vitest';
import { transitionBetween, transitionsOf, fittingCount, knownK, methodOf, FITTING_KINDS, FITTING_LABELS } from './segments';
import type { LineSegment } from './segments';
import { boreForTube, cutLength, suggestBore, tubeBoreMm, dashToTubeOdIn } from './catalog';
import type { ParamValue } from './params';

const mm = (v: number): ParamValue => ({ value: v, unit: 'mm', source: 'measured' });
const seg = (id: string, bore?: ParamValue): LineSegment => ({ id, bore, fittings: [] });

describe('tube bore is arithmetic', () => {
  it('is OD minus two walls', () => {
    // 1/2 x 0.035 -> 0.430 in; the number every catalogue prints.
    expect(tubeBoreMm(0.5, 0.035)).toBeCloseTo(10.922, 3);
    expect(boreForTube('1/2 × 0.035')).toBeCloseTo(10.922, 3);
    expect(boreForTube('3/8 × 0.035')).toBeCloseTo(7.747, 3);
  });

  it('carries where it came from, so a report can trace it', () => {
    expect(suggestBore('tube', '1/2 × 0.035', [])!.reference).toContain('OD − 2 × wall');
  });

  it('says nothing for a size it does not know', () => {
    expect(boreForTube('9/16 × 0.042')).toBeNull();
  });
});

describe('what is standard, and what is catalogue', () => {
  it('knows a dash size is sixteenths of an inch of tube OD', () => {
    expect(dashToTubeOdIn(8)).toBeCloseTo(0.5, 6);
    expect(dashToTubeOdIn(4)).toBeCloseTo(0.25, 6);
  });

  it('will not invent a through-bore for a fitting standard', () => {
    // A number made up here would reach feed-twin wearing a source and a
    // reference, looking checked, and be wrong. Null makes the dialog ask.
    expect(suggestBore('JIC', '-8', [])).toBeNull();
    expect(suggestBore('NPT', '3/8', [])).toBeNull();
  });

  it('uses a catalogued part once the team has entered one', () => {
    const hit = suggestBore('JIC', '-8', [{
      id: 'p1', label: 'JIC -8', standard: 'JIC', size: '-8',
      boreMm: 9.4, source: 'Parker cat. 4300, p.12',
    }])!;
    expect(hit.mm).toBe(9.4);
    expect(hit.basis).toBe('catalog');
    expect(hit.reference).toContain('Parker');
  });

  it('marks tube arithmetic as arithmetic, not catalogue', () => {
    expect(suggestBore('tube', '1/2 × 0.035', [])!.basis).toBe('arithmetic');
  });
});

describe('the cut list', () => {
  it('takes the fittings out of an end-to-end measurement', () => {
    // 1000 mm overall, two fittings 30 long that each swallow 10 of tube.
    expect(cutLength(1000, [
      { lengthMm: 30, engagementMm: 10 },
      { lengthMm: 30, engagementMm: 10 },
    ])).toBeCloseTo(960, 6);
  });

  it('refuses when a fitting has no length — a partial answer is a mis-cut part', () => {
    expect(cutLength(1000, [{ lengthMm: 30 }, {}])).toBeNull();
  });
});

describe('how a segment says its loss is known', () => {
  it('defaults to itemised', () => {
    expect(methodOf({ id: 'a' })).toBe('itemised');
  });

  it('takes the stated method when there is one', () => {
    expect(methodOf({ id: 'a', method: 'measured_K' })).toBe('measured_K');
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
  it('counts every row by how many of it there are', () => {
    const s: LineSegment = {
      id: 'a',
      fittings: [
        { id: 'r1', kind: 'elbow_90', count: 3 },
        { id: 'r2', kind: 'tee_run', count: 1 },
      ],
    };
    expect(fittingCount(s)).toBe(4);
  });

  it('sums only the K this drawing actually knows', () => {
    // Everything else is priced by feed-twin, which has the Reynolds number.
    const s: LineSegment = {
      id: 'a',
      fittings: [
        { id: 'r1', kind: 'elbow_90', count: 2, K: 0.75 },
        { id: 'r2', kind: 'tee_run', count: 1 },
      ],
    };
    expect(knownK(s)).toBeCloseTo(1.5, 6);
  });

  it('names every kind feed-twin registers, and no others', () => {
    // These strings are the contract with correlations.py. A kind that is not
    // registered there has no correlation behind it and would price at zero.
    expect(FITTING_KINDS).toHaveLength(15);
    expect(Object.keys(FITTING_LABELS).sort()).toEqual([...FITTING_KINDS].sort());
  });
});
