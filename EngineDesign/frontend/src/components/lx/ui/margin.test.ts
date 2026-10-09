import { describe, expect, it } from 'vitest';
import { compareMargins, directionWords, gradeLimit, marginScale, niceCeil, sortWorstFirst, type LimitSpec } from './margin';

// The LE4 limits the gallery shows.
const chug: LimitSpec = { limit: 1, warn: 1.2, direction: 'higher-is-safer' };
const loxStiff: LimitSpec = { limit: 20, direction: 'higher-is-safer', far: { warn: 40 } };
const tankPeak: LimitSpec = { limit: 1000, warn: 800, direction: 'lower-is-safer' };
const bottle: LimitSpec = { limit: 100, warn: 200, direction: 'higher-is-safer' };
const sag: LimitSpec = { limit: 60, warn: 30, direction: 'lower-is-safer' };

describe('gradeLimit', () => {
  it('grades higher-is-safer: under the limit bad, in the band amber, above ok', () => {
    expect(gradeLimit(chug, 0.9)).toBe('bad');
    expect(gradeLimit(chug, 1.1)).toBe('warn');
    expect(gradeLimit(chug, 1.33)).toBe('ok');
  });

  it('grades lower-is-safer the other way round', () => {
    expect(gradeLimit(tankPeak, 564)).toBe('ok');
    expect(gradeLimit(tankPeak, 900)).toBe('warn');
    expect(gradeLimit(tankPeak, 1001)).toBe('bad');
    expect(gradeLimit(sag, 25.4)).toBe('ok');
  });

  it('a value exactly on an edge takes the safer grade, as the old verdicts did', () => {
    expect(gradeLimit(chug, 1)).toBe('warn');
    expect(gradeLimit(chug, 1.2)).toBe('ok');
    expect(gradeLimit(tankPeak, 1000)).toBe('warn');
  });

  it('grades a two-sided band on both edges', () => {
    expect(gradeLimit(loxStiff, 35.6)).toBe('ok');
    expect(gradeLimit(loxStiff, 19)).toBe('bad');
    expect(gradeLimit(loxStiff, 41)).toBe('warn');
    expect(gradeLimit({ ...loxStiff, far: { warn: 40, limit: 60 } }, 61)).toBe('bad');
  });

  it('no value is amber, never ok', () => {
    expect(gradeLimit(chug, NaN)).toBe('warn');
    expect(marginScale(chug, null).status).toBe('warn');
  });
});

describe('marginScale', () => {
  it('places the chug margin on a 0-based track with the red line and amber band where they belong', () => {
    const s = marginScale(chug, 1.33);
    expect(s.span[0]).toBe(0);
    expect(s.span[1]).toBeGreaterThan(1.33);
    const at = (x: number) => (x - s.span[0]) / (s.span[1] - s.span[0]);
    expect(s.pos).toBeCloseTo(at(1.33), 12);
    expect(s.zones.map((z) => z.status)).toEqual(['bad', 'warn', 'ok']);
    expect(s.zones[0].to).toBeCloseTo(at(1), 12);
    expect(s.zones[1].to).toBeCloseTo(at(1.2), 12);
    expect(s.status).toBe('ok');
    expect(s.tickDigits).toBe(1); // "1.0" and "1.2", alike
  });

  it('mirrors the zones for lower-is-safer', () => {
    const s = marginScale(tankPeak, 564);
    expect(s.zones.map((z) => z.status)).toEqual(['ok', 'warn', 'bad']);
    expect(s.pos).toBeCloseTo(564 / s.span[1], 12);
  });

  it('colours a two-sided band bad / ok / warn', () => {
    const s = marginScale(loxStiff, 35.6);
    expect(s.zones.map((z) => z.status)).toEqual(['bad', 'ok', 'warn']);
    expect(s.span).toEqual([0, 50]);
  });

  it('zones always cover the whole track with no gaps', () => {
    for (const [spec, v] of [[chug, 1.33], [loxStiff, 35.6], [tankPeak, 564], [bottle, 631], [sag, 25.4], [chug, 7]] as const) {
      const s = marginScale(spec, v);
      expect(s.zones[0].from).toBe(0);
      expect(s.zones[s.zones.length - 1].to).toBe(1);
      for (let i = 1; i < s.zones.length; i++) expect(s.zones[i].from).toBe(s.zones[i - 1].to);
    }
  });

  it('rounds the auto span to a number a person would write', () => {
    expect(marginScale(bottle, 631).span).toEqual([0, 800]);
    expect(marginScale(sag, 25.4).span).toEqual([0, 80]);
    expect(marginScale(tankPeak, 564).span).toEqual([0, 1200]);
  });

  it('clamps a value off a given span to the end it left by', () => {
    const above = marginScale({ ...chug, span: [0, 2] }, 3.1);
    expect(above.pos).toBe(1);
    expect(above.clamped).toBe('above');
    const below = marginScale({ ...bottle, span: [0, 800] }, -40);
    expect(below.pos).toBe(0);
    expect(below.clamped).toBe('below');
    expect(below.status).toBe('bad');
  });

  it('no value has no marker', () => {
    const s = marginScale(chug, undefined);
    expect(s.pos).toBeNull();
    expect(s.clamped).toBeNull();
    expect(Number.isNaN(s.margin)).toBe(true);
  });

  it('thins colliding labels, keeping the red line', () => {
    const s = marginScale({ limit: 1, warn: 1.05, direction: 'higher-is-safer', span: [0, 2] }, 1.5);
    expect(s.ticks.find((t) => t.kind === 'limit')?.label).toBe(true);
    expect(s.ticks.find((t) => t.kind === 'warn')?.label).toBe(false);
  });

  it('keeps both labels when they fit at the drawn width, and drops one when the track is narrow', () => {
    const wide = marginScale(chug, 1.33, { trackPx: 300 });
    expect(wide.ticks.map((t) => [t.text, t.label])).toEqual([['1.0', true], ['1.2', true]]);
    const narrow = marginScale(chug, 1.33, { trackPx: 120 });
    expect(narrow.ticks.map((t) => t.label)).toEqual([true, false]);
  });

  it('measures margin in warn-band widths: 0 at the red line, 1 at the amber edge', () => {
    expect(marginScale(chug, 1).margin).toBeCloseTo(0, 12);
    expect(marginScale(chug, 1.2).margin).toBeCloseTo(1, 12);
    expect(marginScale(chug, 1.33).margin).toBeCloseTo(1.65, 12);
    expect(marginScale(tankPeak, 900).margin).toBeCloseTo(0.5, 12);
    expect(marginScale(chug, 0.9).margin).toBeLessThan(0);
  });

  it('takes the nearer side of a two-sided band', () => {
    const near40 = marginScale(loxStiff, 39).margin;
    const mid = marginScale(loxStiff, 30).margin;
    expect(near40).toBeLessThan(mid);
  });
});

describe('compareMargins', () => {
  it('sorts worst first: bad, then amber by margin, then ok by margin, ungraded last in its grade', () => {
    const items = [
      { k: 'sag', s: marginScale(sag, 25.4) },
      { k: 'chug', s: marginScale(chug, 1.33) },
      { k: 'bottle-tight', s: marginScale(bottle, 150) },
      { k: 'unknown', s: marginScale(bottle, null) },
      { k: 'peak-over', s: marginScale(tankPeak, 1100) },
      { k: 'bottle', s: marginScale(bottle, 631) },
    ];
    items.sort((a, b) => compareMargins(a.s, b.s));
    // The sag (1.15 band widths from amber) is nearer trouble than the chug margin (1.65).
    expect(items.map((i) => i.k)).toEqual(['peak-over', 'bottle-tight', 'unknown', 'sag', 'chug', 'bottle']);
  });
});

describe('niceCeil', () => {
  it('rounds up to 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ', () => {
    expect(niceCeil(757)).toBe(800);
    expect(niceCeil(1.596)).toBe(2);
    expect(niceCeil(1200)).toBe(1200);
    expect(niceCeil(48)).toBe(50);
    expect(niceCeil(0.031)).toBe(0.04);
  });
});

describe('a two-sided band (ΔP/Pc 20–40 %)', () => {
  it('reads as a band, not as "higher is safer"', () => {
    const s = marginScale(loxStiff, 35.6);
    expect(s.band).toEqual([20, 40]);
    expect(directionWords(s)).toBe('Safe between 20 and 40');
    expect(directionWords(marginScale(chug, 1.33))).toBe('Higher is safer');
    expect(directionWords(marginScale(sag, 25))).toBe('Lower is safer');
    expect(marginScale(chug, 1.33).band).toBeNull();
  });

  it('grades the far side amber and the near side red, with both edges labelled', () => {
    expect(marginScale(loxStiff, 43).status).toBe('warn');
    expect(marginScale(loxStiff, 18).status).toBe('bad');
    expect(marginScale(loxStiff, 30).status).toBe('ok');
    const s = marginScale(loxStiff, 30, { trackPx: 260 });
    expect(s.ticks.filter((t) => t.label).map((t) => t.text)).toEqual(['20', '40']);
  });

  it('puts the marker inside the ok zone for a value inside the band', () => {
    const s = marginScale(loxStiff, 30);
    const zone = s.zones.find((z) => (s.pos as number) >= z.from && (s.pos as number) <= z.to);
    expect(zone?.status).toBe('ok');
  });
});

describe('sortWorstFirst', () => {
  it('orders bad, amber, ok, nearest the edge first, keeping ties in their given order', () => {
    const mk = (k: string, spec: LimitSpec, v: number | null) => {
      const scale = marginScale(spec, v);
      return { k, status: scale.status, scale };
    };
    const items = [
      mk('chug-ok', chug, 1.33), mk('stiff-hi', loxStiff, 43), mk('sag-bad', sag, 71), mk('bottle-ok', bottle, 2200),
      mk('tie-a', chug, 1.5), mk('tie-b', chug, 1.5), mk('stiff-near', loxStiff, 21),
    ];
    expect(sortWorstFirst(items).map((i) => i.k)).toEqual(['sag-bad', 'stiff-hi', 'stiff-near', 'chug-ok', 'tie-a', 'tie-b', 'bottle-ok']);
  });
});

describe('edge labels after a unit conversion', () => {
  it('print the round number meant, not the conversion noise', () => {
    // 0.33 kg in the model is 0.7275... lb; an edge set at 0.3307 kg is printed 0.33, its zero 0.00.
    const s = marginScale({ limit: 0, warn: 0.3307, direction: 'higher-is-safer', span: [0, 0.4] }, 0.02, { trackPx: 300 });
    expect(s.ticks.map((t) => t.text)).toEqual(['0.00', '0.33']);
    // A real 0.25 keeps its two decimals.
    expect(marginScale({ limit: 0.25, direction: 'higher-is-safer', span: [0, 1] }, 0.5).ticks[0].text).toBe('0.25');
  });
});
