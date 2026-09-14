import { describe, expect, it } from 'vitest';
import { transitionBetween, transitionsOf, fittingCount, knownK, methodOf, FITTING_KINDS, FITTING_LABELS,
  cutTubeOf, joinFamilyOf, joinSizeOf, jointFaultsOf, jointsForRow, jointsOf,
  mismatchesOf, needsOwnSize, needsThreadLength, nextRowId, nextSegmentId,
  overlapOf } from './segments';
import type { FittingRow } from './segments';
import { engagementOf, isMissing } from './terminations';
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

describe('how much the joints take out of a run', () => {
  /** A run of `n` identical elbows, each 30 mm long, at one joint standard. */
  const run = (n: number, over: Partial<LineSegment> = {}): LineSegment => ({
    id: 's1', standard: 'tube', tubeSize: '1/2 x 0.049',
    fittings: [{ id: 'f1', kind: 'elbow_90', count: n, lengthMm: 30 }],
    ...over,
  });

  it('refuses a figure when nobody has said how the fittings join', () => {
    // The whole point of the `unset` family. A tube run says what the tube is
    // and nothing about how the fittings grip it, so there is no overlap to
    // report -- and reporting zero would read exactly like a checked zero.
    const seg = run(3);
    expect(overlapOf(seg)).toBeNull();
    const cut = cutTubeOf(seg, 1000);
    expect('needs' in cut).toBe(true);
    if ('needs' in cut) expect(cut.needs).toMatch(/how the fittings/);
  });

  it('works the overlap out from one answer on the run', () => {
    // Answered once, and three elbows in a row have two joints between them.
    const seg = run(3, { standard: 'NPT', tubeSize: '1/2', joinBy: 'NPT' });
    const one = engagementOf(
      { family: 'NPT', size: '1/2', gender: 'male' },
      { family: 'NPT', size: '1/2', gender: 'female' },
    );
    expect(isMissing(one)).toBe(false);
    if (isMissing(one)) return;
    expect(overlapOf(seg)).toEqual({ mm: one.mm * 2, unverified: 2 });
  });

  it('takes the joint family from the line standard when that names one', () => {
    // An NPT line is NPT throughout; the user is asked nothing.
    expect(joinFamilyOf({ id: 's', standard: 'NPT' })).toBe('NPT');
    expect(joinFamilyOf({ id: 's', standard: 'JIC' })).toBe('JIC');
    // A tube standard implies no joint at all, on purpose.
    expect(joinFamilyOf({ id: 's', standard: 'tube' })).toBeUndefined();
  });

  it('lets the run override a standard that does name a family', () => {
    expect(joinFamilyOf({ id: 's', standard: 'NPT', joinBy: 'weld' })).toBe('weld');
  });

  it('makes a welded run overlap by nothing, and says so', () => {
    const seg = run(3, { joinBy: 'weld' });
    expect(overlapOf(seg)).toEqual({ mm: 0, unverified: 0 });
    // Stated zero, so the cut length is just the tube between the bodies.
    expect(cutTubeOf(seg, 1000)).toEqual({ mm: 910, unverified: 0 });
  });

  it('gives back the tube to cut, joints and bodies both accounted for', () => {
    const seg = run(3, { standard: 'NPT', tubeSize: '1/2', joinBy: 'NPT' });
    const cut = cutTubeOf(seg, 1000);
    expect('needs' in cut).toBe(false);
    if ('needs' in cut) return;
    const overlap = overlapOf(seg)!;
    // overall - bodies + overlap: the joints give length back.
    expect(cut.mm).toBeCloseTo(1000 - 90 + overlap.mm, 3);
    expect(cut.mm).toBeGreaterThan(1000 - 90);
  });

  it('will not guess a swage insertion depth', () => {
    const seg = run(2, { joinBy: 'swage' });
    expect(overlapOf(seg)).toBeNull();
    const cut = cutTubeOf(seg, 1000);
    if ('needs' in cut) expect(cut.needs).toMatch(/insertion depth/);
    else throw new Error('a swage depth is a manufacturer number, not ours to invent');
  });
});

describe('the joints either side of one fitting', () => {
  const seg: LineSegment = {
    id: 's1', standard: 'NPT', tubeSize: '1/2', joinBy: 'NPT',
    fittings: [
      { id: 'a', kind: 'elbow_90', count: 1, lengthMm: 30 },
      { id: 'b', kind: 'ball_valve_full', count: 1, lengthMm: 80 },
      { id: 'c', kind: 'elbow_90', count: 1, lengthMm: 30 },
    ],
  };

  it('pairs a fitting against its neighbours, never against itself', () => {
    // An elbow's own inlet and outlet do not screw into each other; the panel
    // used to show exactly that, which is how this test came to exist.
    const { inlet, outlet } = jointsForRow(seg, 'b');
    expect(inlet).not.toBeNull();
    expect(outlet).not.toBeNull();
    expect(inlet!.rowId).toBe('b');      // the joint on b's inlet side
    expect(outlet!.rowId).toBe('c');     // b's outlet against c's inlet
  });

  it('gives the first fitting no inlet joint and the last no outlet', () => {
    expect(jointsForRow(seg, 'a').inlet).toBeNull();
    expect(jointsForRow(seg, 'c').outlet).toBeNull();
  });

  it('reads the bore off the male half at every joint', () => {
    // The reason gender is modelled at all: the female is a bigger hole with
    // threads cut in it, so a run measured off the female halves reports a
    // restriction that is not there.
    for (const j of jointsOf(seg)) expect(j.restricting.gender).toBe('male');
  });

  it('has nothing to show on a run with a single fitting', () => {
    const one: LineSegment = { ...seg, fittings: [seg.fittings![0]] };
    expect(jointsForRow(one, 'a')).toEqual({ inlet: null, outlet: null });
    expect(overlapOf(one)).toEqual({ mm: 0, unverified: 0 });
  });
});

describe('which size a joint is made at', () => {
  it('takes a thread size from the run, never from the tube', () => {
    // 1/2 x 0.049 tube into 1/4 NPT ports: ordinary, and `1/2 x 0.049` is not
    // an NPT size at all. Without an answer the joint says what it is missing.
    const seg: LineSegment = {
      id: 's', standard: 'tube', tubeSize: '1/2 x 0.049', joinBy: 'NPT',
      fittings: [{ id: 'f', kind: 'elbow_90', count: 2, lengthMm: 30 }],
    };
    expect(joinSizeOf(seg)).toBe('');
    const cut = cutTubeOf(seg, 1000);
    if ('needs' in cut) expect(cut.needs).toMatch(/thread size/);
    else throw new Error('a blank thread size is not a size');

    expect(joinSizeOf({ ...seg, joinSize: '1/4' })).toBe('1/4');
    expect(overlapOf({ ...seg, joinSize: '1/4' })).not.toBeNull();
  });

  it('sizes a swage joint by the tube it grips', () => {
    // There is no second size: a 1/2 inch swage fitting takes 1/2 inch tube.
    const seg: LineSegment = { id: 's', standard: 'tube', tubeSize: '1/2 x 0.049', joinBy: 'swage' };
    expect(joinSizeOf(seg)).toBe('1/2 x 0.049');
    expect(needsOwnSize('swage')).toBe(false);
    expect(needsOwnSize('weld')).toBe(false);
    expect(needsOwnSize('NPT')).toBe(true);
    expect(needsOwnSize('JIC')).toBe(true);
  });

  it('needs nothing said when the line standard is the joint', () => {
    const seg: LineSegment = { id: 's', standard: 'NPT', tubeSize: '1/2' };
    expect(joinFamilyOf(seg)).toBe('NPT');
    expect(joinSizeOf(seg)).toBe('1/2');
  });
});

describe('a joint that cannot be made', () => {
  /** Three elbows whose outlet is 1/4 while the next inlet is 1/2. */
  const clash: LineSegment = {
    id: 's', standard: 'tube', tubeSize: '1/2 x 0.049', joinBy: 'NPT', joinSize: '1/2',
    fittings: [
      { id: 'a', kind: 'elbow_90', count: 3, lengthMm: 30,
        ends: { a: { family: 'NPT', size: '1/2', gender: 'male' },
                b: { family: 'NPT', size: '1/4', gender: 'female' } } },
      { id: 'b', kind: 'ball_valve_full', count: 1, lengthMm: 80 },
    ],
  };

  it('reports no overlap at all rather than a confident wrong one', () => {
    // The bug: `engagementOf` reads the male's size and answers, so a 1/4 male
    // in a 1/2 female came back as 13.57 mm -- a number stated as fact on a
    // joint the same panel was calling impossible.
    expect(mismatchesOf(clash).length).toBeGreaterThan(0);
    expect(overlapOf(clash)).toBeNull();
  });

  it('refuses a cut length and names the joint as the reason', () => {
    const cut = cutTubeOf(clash, 1000);
    if ('needs' in cut) expect(cut.needs).toMatch(/needs an adapter/);
    else throw new Error('a run with an impossible joint has no cut length');
  });

  it('says each distinct fault once, with how many joints it hits', () => {
    // Three identical elbows make the same complaint three times; printing it
    // three times reads as three separate faults.
    const faults = jointFaultsOf(clash);
    expect(faults).toHaveLength(1);
    expect(faults[0].why).toMatch(/1\/4 to 1\/2/);
    expect(faults[0].joints).toBe(3);
  });

  it('has nothing to complain about on a run that fits together', () => {
    const ok: LineSegment = { ...clash, fittings: [
      { id: 'a', kind: 'elbow_90', count: 3, lengthMm: 30 },
      { id: 'b', kind: 'ball_valve_full', count: 1, lengthMm: 80 },
    ] };
    expect(jointFaultsOf(ok)).toEqual([]);
    expect(overlapOf(ok)).not.toBeNull();
  });
});

describe('the length a cone or a shoulder closes on', () => {
  const jic = (over: Partial<LineSegment> = {}): LineSegment => ({
    id: 's', standard: 'JIC', tubeSize: '-8',
    fittings: [{ id: 'a', kind: 'elbow_90', count: 2, lengthMm: 30 }],
    ...over,
  });

  it('is asked once on the run, not once per fitting', () => {
    // A JIC cone stops at a length rather than at a figure from a table, so
    // it has to be asked -- but a run of one fitting series has one such
    // length, and asking per fitting is that number typed over and over.
    expect(overlapOf(jic())).toBeNull();
    expect(overlapOf(jic({ joinThreadMm: 12.7 }))).toEqual({ mm: 12.7, unverified: 0 });
  });

  it('lets one odd fitting override the run', () => {
    const seg = jic({
      joinThreadMm: 12.7,
      fittings: [
        { id: 'a', kind: 'elbow_90', count: 1, lengthMm: 30 },
        { id: 'b', kind: 'elbow_90', count: 1, lengthMm: 30, threadMm: 9.5,
          ends: { a: { family: 'JIC', size: '-8', gender: 'male' },
                  b: { family: 'JIC', size: '-8', gender: 'female' } } },
      ],
    });
    // One joint, and its male half is b's -- so b's own figure is the one used.
    expect(overlapOf(seg)).toEqual({ mm: 9.5, unverified: 0 });
  });

  it('says which families need it and which do not', () => {
    expect(needsThreadLength('JIC')).toBe(true);
    expect(needsThreadLength('AN')).toBe(true);
    expect(needsThreadLength('ORB')).toBe(true);
    // NPT comes out of the standard, and a weld closes on nothing.
    expect(needsThreadLength('NPT')).toBe(false);
    expect(needsThreadLength('weld')).toBe(false);
    expect(needsThreadLength('swage')).toBe(false);
  });
});

describe('ids of things added to a saved drawing', () => {
  it('never reissues a fitting id already on the line', () => {
    // The bug: the counter behind `nextRowId` was module state that nothing
    // seeded when a drawing was opened, so a line loaded with fit_1 and fit_2
    // got fit_1 again for the next fitting. Rows are matched by id, so the
    // duplicate meant editing one edited both and deleting one deleted both.
    const loaded: FittingRow[] = [
      { id: 'fit_1', kind: 'elbow_90', count: 1 },
      { id: 'fit_2', kind: 'tee_run', count: 1 },
    ];
    const added = nextRowId(loaded);
    expect(loaded.some(r => r.id === added)).toBe(false);
  });

  it('keeps finding a free one as a line fills up', () => {
    const rows: FittingRow[] = [];
    for (let i = 0; i < 25; i++) {
      rows.push({ id: nextRowId(rows), kind: 'elbow_90', count: 1 });
    }
    expect(new Set(rows.map(r => r.id)).size).toBe(25);
  });

  it('steps over a gap left by a deletion', () => {
    // Ids left by a delete are not reused while their neighbours remain.
    const rows: FittingRow[] = [
      { id: 'fit_1', kind: 'elbow_90', count: 1 },
      { id: 'fit_3', kind: 'elbow_90', count: 1 },
    ];
    const added = nextRowId(rows);
    expect(['fit_1', 'fit_3']).not.toContain(added);
  });

  it('does the same for a second size along a run', () => {
    const segs: LineSegment[] = [{ id: 'seg_1' }, { id: 'seg_2' }];
    const added = nextSegmentId(segs);
    expect(segs.some(s => s.id === added)).toBe(false);
  });
});

describe('a swage depth comes from the catalogue', () => {
  const swaged = (partId?: string): LineSegment => ({
    id: 's', standard: 'tube', tubeSize: '1/2 x 0.049', joinBy: 'swage',
    fittings: [{ id: 'a', kind: 'elbow_90', count: 2, lengthMm: 30, partId }],
  });

  it('asks for a part rather than inventing an insertion depth', () => {
    // The number is the manufacturer's for that series. This app does not
    // know it and must not make one up.
    const cut = cutTubeOf(swaged(), 1000);
    if ('needs' in cut) expect(cut.needs).toMatch(/insertion depth/);
    else throw new Error('an uncatalogued swage joint has no depth');
  });

  it('uses the depth off the part the fitting was picked from', () => {
    const depths = (id: string) => (id === 'SS-810-9' ? 11.4 : undefined);
    expect(overlapOf(swaged('SS-810-9'), depths)).toEqual({ mm: 11.4, unverified: 0 });
    const cut = cutTubeOf(swaged('SS-810-9'), 1000, depths);
    if ('needs' in cut) throw new Error('a catalogued depth is an answer');
    expect(cut.mm).toBeCloseTo(1000 - 60 + 11.4, 3);
  });

  it('still refuses when the part carries no depth', () => {
    // A catalogue entry with only a bore is a valid entry, and it is not a
    // depth. Absent means not stated.
    const cut = cutTubeOf(swaged('SS-810-9'), 1000, () => undefined);
    expect('needs' in cut).toBe(true);
  });
});
