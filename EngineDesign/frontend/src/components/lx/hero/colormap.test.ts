import { describe, expect, it } from 'vitest';
import { colorbarTicks, contrast, flowWidth, luminance, pressureRange, pressureScale, seqColor, VIRIDIS, viridis, WIDTH_MAX, WIDTH_MIN, WINDOW } from './colormap';

const SURFACE = { dark: '#13161a', light: '#ffffff' } as const;

describe('viridis', () => {
  it('hits its stops exactly and clamps outside 0..1', () => {
    expect(viridis(0)).toBe('#440154');
    expect(viridis(1)).toBe('#fde725');
    expect(viridis(0.5)).toBe(VIRIDIS[8]);
    expect(viridis(-3)).toBe('#440154');
    expect(viridis(7)).toBe('#fde725');
    expect(viridis(NaN)).toBe('#440154');
  });

  it('interpolates between stops', () => {
    // Halfway between #440154 and #48186a.
    expect(viridis(1 / 32)).toBe('#460d5f');
  });

  it('rises in lightness all the way (order reads without hue)', () => {
    let prev = -1;
    for (let k = 0; k <= 200; k++) {
      const L = luminance(viridis(k / 200));
      expect(L).toBeGreaterThan(prev);
      prev = L;
    }
  });
});

describe('seqColor per theme', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`${theme}: every colour is a 3:1 line on the panel`, () => {
      for (let k = 0; k <= 50; k++) expect(contrast(seqColor(k / 50, theme)!, SURFACE[theme])).toBeGreaterThanOrEqual(2.95);
    });
  }

  it('runs low to high the same way in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(luminance(seqColor(1, theme)!)).toBeGreaterThan(luminance(seqColor(0, theme)!));
    }
    expect(seqColor(0, 'dark')).toBe(viridis(WINDOW.dark[0]));
    expect(seqColor(1, 'light')).toBe(viridis(WINDOW.light[1]));
  });

  it('has no colour for no value', () => {
    expect(seqColor(null, 'dark')).toBeNull();
    expect(seqColor(NaN, 'light')).toBeNull();
  });
});

describe('pressureScale', () => {
  const s = pressureScale(14.7, 4500);

  it('is logarithmic: equal ratios are equal steps', () => {
    expect(s.norm(14.7)).toBe(0);
    expect(s.norm(4500)).toBe(1);
    const mid = Math.sqrt(14.7 * 4500);
    expect(s.norm(mid)).toBeCloseTo(0.5, 9);
    expect(s.norm(147) - s.norm(14.7)).toBeCloseTo(s.norm(1470) - s.norm(147), 9);
  });

  it('clamps, and has no position for no value', () => {
    expect(s.norm(1)).toBe(0);
    expect(s.norm(1e6)).toBe(1);
    expect(s.norm(null)).toBeNaN();
  });

  it('survives a degenerate or reversed range', () => {
    const z = pressureScale(500, 500);
    expect(z.hi).toBeGreaterThan(z.lo);
    expect(z.norm(500)).toBe(0);
    const r = pressureScale(4500, 14.7);
    expect(r.lo).toBeCloseTo(14.7, 9);
    expect(pressureScale(0, 100).lo).toBe(1);
  });

  it('pressureRange spans finite positive values only', () => {
    expect(pressureRange([[14.7, null, 600], [4500, NaN, 0, -3]])).toEqual([14.7, 4500]);
    expect(pressureRange([[null]])).toBeNull();
  });
});

describe('colorbarTicks', () => {
  const s = pressureScale(14.7, 4510);
  const width = (v: number) => String(Math.round(v)).length * 7;
  const ticks = colorbarTicks(s, (p) => p, (d) => d, { barPx: 160, widthOf: width, gapPx: 8 });

  it('labels both ends and round values between, in order', () => {
    expect(ticks[0]).toEqual({ u: 0, value: 14.7 });
    expect(ticks[ticks.length - 1]).toEqual({ u: 1, value: 4510 });
    const inner = ticks.slice(1, -1);
    expect(inner.length).toBeGreaterThanOrEqual(1);
    for (const t of inner) expect([1, 2, 5]).toContain(t.value / 10 ** Math.floor(Math.log10(t.value)));
    expect(inner.map((t) => t.value)).toContain(100);
  });

  it('keeps every label clear of the next', () => {
    const spans = ticks.map((t, k) => {
      const w = width(t.value);
      const x = t.u * 160;
      return k === 0 ? [x, x + w] : k === ticks.length - 1 ? [x - w, x] : [x - w / 2, x + w / 2];
    });
    for (let k = 1; k < spans.length; k++) expect(spans[k][0] - spans[k - 1][1]).toBeGreaterThanOrEqual(8);
  });

  it('drops interior ticks on a bar too short for them', () => {
    expect(colorbarTicks(s, (p) => p, (d) => d, { barPx: 50, widthOf: width })).toHaveLength(2);
  });
});

describe('flowWidth', () => {
  it('1 px for none, 5 px for the largest, square root between', () => {
    expect(flowWidth(0, 2)).toBe(WIDTH_MIN);
    expect(flowWidth(null, 2)).toBe(WIDTH_MIN);
    expect(flowWidth(2, 2)).toBe(WIDTH_MAX);
    expect(flowWidth(5, 2)).toBe(WIDTH_MAX);
    expect(flowWidth(0.5, 2)).toBeCloseTo(1 + 4 * Math.sqrt(0.25), 9);
    expect(flowWidth(1, 0)).toBe(WIDTH_MIN);
  });

  it('keeps a gas line (a few g/s) visibly above no flow', () => {
    expect(flowWidth(0.03, 1.95)).toBeGreaterThan(1.4);
  });
});
