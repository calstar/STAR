import { describe, expect, it } from 'vitest';
import {
  engagementOf, isMissing, restrictingEnd, whyNotMated,
  MAKEUP, NPT_L1_IN, NPT_TPI, NPT_WRENCH_TURNS, FAMILY_LABELS,
} from './terminations';
import type { Family, Gender, Termination } from './terminations';

const end = (family: Family, size: string, gender: Gender): Termination =>
  ({ family, size, gender });

describe('how far a joint goes together', () => {
  it('lets an ORB male run all the way in', () => {
    // The shoulder bottoms on the boss face, so the thread length *is* the
    // engagement -- no table, no guess, nothing left between flats and face.
    const e = engagementOf(end('ORB', '-8', 'male'), end('ORB', '-8', 'female'),
      { maleThreadMm: 12.7 });
    expect(isMissing(e)).toBe(false);
    if (isMissing(e)) return;
    expect(e.mm).toBe(12.7);
    expect(e.basis).toBe('rule');
    expect(e.verified).toBe(true);
  });

  it('closes a JIC joint on the cone, not the thread', () => {
    const e = engagementOf(end('JIC', '-8', 'male'), end('JIC', '-8', 'female'),
      { maleThreadMm: 9.5 });
    if (isMissing(e)) throw new Error(e.needs);
    expect(e.mm).toBe(9.5);
    expect(e.reference).toContain('cone');
  });

  it('works an NPT joint out from the standard and the pitch', () => {
    // L1 plus three turns at 14 TPI, in millimetres. The arithmetic is the
    // point: nobody types this, and changing the turns changes every joint.
    const e = engagementOf(end('NPT', '1/2', 'male'), end('NPT', '1/2', 'female'));
    if (isMissing(e)) throw new Error(e.needs);
    const expected = (NPT_L1_IN['1/2'].in + NPT_WRENCH_TURNS / NPT_TPI['1/2']) * 25.4;
    expect(e.mm).toBeCloseTo(expected, 3);
    expect(e.basis).toBe('standard');
  });

  it('says an NPT figure is unchecked while it is', () => {
    // Seeded from memory on purpose, and it has to admit that: a number
    // somebody cuts a tube to cannot quietly look like a citation.
    const e = engagementOf(end('NPT', '1/4', 'male'), end('NPT', '1/4', 'female'));
    if (isMissing(e)) throw new Error(e.needs);
    expect(e.verified).toBe(false);
    expect(e.reference).toContain('not yet checked');
  });

  it('asks for a swage insertion depth rather than inventing one', () => {
    // Varies by series, so it is a catalogue number and this file says so.
    const e = engagementOf(end('swage', '-8', 'male'), end('swage', '-8', 'female'));
    expect(isMissing(e)).toBe(true);
    if (!isMissing(e)) return;
    expect(e.needs).toContain('catalogue');
  });

  it('gives a welded joint no overlap at all', () => {
    const e = engagementOf(end('weld', '1/2', 'male'), end('tube', '1/2', 'female'));
    if (isMissing(e)) throw new Error(e.needs);
    expect(e.mm).toBe(0);
  });

  it('asks for the thread length where the rule needs one', () => {
    const e = engagementOf(end('ORB', '-8', 'male'), end('ORB', '-8', 'female'));
    expect(isMissing(e)).toBe(true);
  });

  it('never returns a length without saying where it came from', () => {
    for (const family of Object.keys(MAKEUP) as Family[]) {
      const e = engagementOf(end(family, '1/2', 'male'), end(family, '1/2', 'female'),
        { maleThreadMm: 10, insertionMm: 8 });
      if (isMissing(e)) continue;
      expect(e.reference.length, family).toBeGreaterThan(8);
      expect(['rule', 'standard', 'catalogue'], family).toContain(e.basis);
    }
  });
});

describe('which bore the fluid sees', () => {
  it('is the male side, every time', () => {
    // The female at a joint is a bigger hole with threads cut in it. Taking
    // the bore off that half reports a restriction that is not there.
    const male = end('NPT', '1/2', 'male');
    const female = end('NPT', '1/2', 'female');
    expect(restrictingEnd(male, female)).toBe(male);
    expect(restrictingEnd(female, male)).toBe(male);
  });
});

describe('what will not go together', () => {
  it('refuses two of the same gender', () => {
    expect(whyNotMated(end('NPT', '1/2', 'male'), end('NPT', '1/2', 'male')))
      .toContain('two male ends');
    expect(whyNotMated(end('NPT', '1/2', 'female'), end('NPT', '1/2', 'female')))
      .toContain('two female ends');
  });

  it('refuses two different families', () => {
    const why = whyNotMated(end('NPT', '1/2', 'male'), end('ORB', '1/2', 'female'));
    expect(why).toContain(FAMILY_LABELS.NPT);
    expect(why).toContain(FAMILY_LABELS.ORB);
  });

  it('lets the two cone families interchange, because they do', () => {
    expect(whyNotMated(end('JIC', '-8', 'male'), end('AN', '-8', 'female'))).toBeNull();
  });

  it('refuses a size mismatch, and says an adapter is what is missing', () => {
    expect(whyNotMated(end('NPT', '1/2', 'male'), end('NPT', '3/8', 'female')))
      .toContain('adapter');
  });

  it('is happy with a good joint', () => {
    expect(whyNotMated(end('NPT', '1/2', 'male'), end('NPT', '1/2', 'female'))).toBeNull();
    expect(whyNotMated(end('ORB', '-8', 'female'), end('ORB', '-8', 'male'))).toBeNull();
  });

  it('does not police bare tube against bare tube', () => {
    expect(whyNotMated(end('tube', '1/2 × 0.049', 'male'), end('tube', '1/2 × 0.049', 'male')))
      .toBeNull();
  });
});

describe('a joint whose size nobody has picked', () => {
  it('asks for the size, not for a figure out of the standard', () => {
    // The wording bug this exists for: with a blank size the NPT branch asked
    // for "hand-tight engagement for NPT " -- a question about a standard,
    // when what is missing is one dropdown on the run.
    for (const family of ['NPT', 'JIC', 'AN', 'ORB', 'swage'] as const) {
      const e = engagementOf(
        { family, size: '', gender: 'male' },
        { family, size: '', gender: 'female' },
        { maleThreadMm: 12, insertionMm: 9 },
      );
      expect(isMissing(e), family).toBe(true);
      if (isMissing(e)) expect(e.needs, family).toMatch(/thread size/);
    }
  });

  it('still gives a weld zero, size or no size', () => {
    const e = engagementOf(
      { family: 'weld', size: '', gender: 'male' },
      { family: 'weld', size: '', gender: 'female' },
    );
    expect(isMissing(e)).toBe(false);
    if (!isMissing(e)) expect(e.mm).toBe(0);
  });

  it('owes nothing at all until somebody says how the run joins', () => {
    const e = engagementOf(
      { family: 'unset', size: '1/2', gender: 'male' },
      { family: 'unset', size: '1/2', gender: 'female' },
    );
    expect(isMissing(e)).toBe(true);
    if (isMissing(e)) expect(e.needs).toMatch(/how the fittings/);
  });

  it('does not call an unanswered end a mismatch', () => {
    // Otherwise every fitting on a fresh run wears a red line whose only
    // cause is that the run has not been answered yet.
    expect(whyNotMated(
      { family: 'unset', size: '', gender: 'male' },
      { family: 'unset', size: '', gender: 'female' },
    )).toBeNull();
    expect(whyNotMated(
      { family: 'unset', size: '', gender: 'male' },
      { family: 'NPT', size: '1/2', gender: 'female' },
    )).toBeNull();
  });
});
