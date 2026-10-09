import { describe, expect, it } from 'vitest';
import { firingSpan, formatT, layoutMarkers, priorityOf, timeDigits, type PlacedMarker } from './markers';
import type { TimeEvent } from './store';

const ev = (t: number, key: string, label: string, kind: string): TimeEvent => ({ t, key, label, kind });

/** 6.5 px a character, like 11 px Inter. */
const measure = (s: string) => s.length * 6.5;

function overlaps(ms: PlacedMarker[], gap = 8): string[] {
  const shown = ms.filter((m) => m.showLabel).sort((a, b) => a.labelLeft - b.labelLeft);
  const bad: string[] = [];
  for (let i = 1; i < shown.length; i++) {
    if (shown[i].labelLeft < shown[i - 1].labelLeft + shown[i - 1].labelWidth + gap) bad.push(`${shown[i - 1].label}/${shown[i].label}`);
  }
  return bad;
}

const EVENTS = [
  ev(-0.5, 'lead', 'Fuel lead', 'lead'),
  ev(0, 't0', 'T−0', 't0'),
  ev(0, 'fire', 'Fire', 'fire'),
  ev(0.12, 'ign', 'Ignition', 'ignition'),
  ev(0.04, 'chug', 'Min chug', 'min'),
  ev(3.4, 'fuel_dry', 'Fuel dry', 'dry'),
  ev(3.52, 'lox_dry', 'LOX dry', 'dry'),
  ev(3.6, 'burnout', 'Burnout', 'burnout'),
];

describe('layoutMarkers', () => {
  it('never lets two shown labels overlap, at any width', () => {
    for (const width of [120, 240, 400, 700, 1200, 1800]) {
      const x = (t: number) => ((t + 1) / 5) * width;
      const ms = layoutMarkers(EVENTS, { x, width, measure });
      expect(overlaps(ms), `width ${width}`).toEqual([]);
      for (const m of ms.filter((m) => m.showLabel)) {
        expect(m.labelLeft).toBeGreaterThanOrEqual(0);
        expect(m.labelLeft + m.labelWidth).toBeLessThanOrEqual(width + 1e-9);
      }
    }
  });

  it('keeps every tick even when its label is dropped', () => {
    const width = 200;
    const ms = layoutMarkers(EVENTS, { x: (t) => ((t + 1) / 5) * width, width, measure });
    const ticks = ms.flatMap((m) => m.events.map((e) => e.key)).sort();
    expect(ticks).toEqual(EVENTS.map((e) => e.key).sort());
    expect(ms.some((m) => !m.showLabel)).toBe(true);
  });

  it('gives a crowd to the label that matters more', () => {
    // A minimum 20 ms before Fire on a narrow track: Fire's label wins although it comes later.
    const width = 300;
    const ms = layoutMarkers([ev(0.1, 'chug', 'Min chug', 'min'), ev(0.12, 'fire', 'Fire', 'fire')],
                             { x: (t) => t * 100, width, measure, mergePx: 0 });
    const shown = ms.filter((m) => m.showLabel).map((m) => m.key);
    expect(shown).toEqual(['fire']);
  });

  it('merges ticks that would draw on each other, labelled by the stronger', () => {
    const ms = layoutMarkers([ev(0, 't0', 'T−0', 't0'), ev(0, 'fire', 'Fire', 'fire')],
                             { x: (t) => 50 + t, width: 400, measure });
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ label: 'Fire', showLabel: true });
    expect(ms[0].events.map((e) => e.key).sort()).toEqual(['fire', 't0']);
  });

  it('drops events outside the track and handles a zero width', () => {
    const ms = layoutMarkers([ev(-9, 'a', 'A', 'warn'), ev(1, 'b', 'B', 'warn')], { x: (t) => t * 10, width: 100, measure });
    expect(ms.map((m) => m.key)).toEqual(['b']);
    expect(layoutMarkers(EVENTS, { x: (t) => t, width: 0, measure })).toEqual([]);
  });
});

describe('formatT', () => {
  it('says T+ and T− with a real minus, no negative zero, and a no-break space', () => {
    expect(formatT(1.85)).toBe('T+1.85\u00a0s');
    expect(formatT(-0.4)).toBe('T−0.40\u00a0s');
    expect(formatT(-0.001)).toBe('T+0.00\u00a0s');
    expect(formatT(12.3456, 3)).toBe('T+12.346\u00a0s');
  });
});

describe('timeDigits', () => {
  it('shows enough decimals to tell two samples apart', () => {
    const ax = (dt: number) => Array.from({ length: 11 }, (_, i) => i * dt);
    expect(timeDigits(ax(0.01))).toBe(2);
    expect(timeDigits(ax(0.05))).toBe(2);
    expect(timeDigits(ax(0.1))).toBe(1);
    expect(timeDigits(ax(0.001))).toBe(3);
    expect(timeDigits([])).toBe(2);
  });
});

describe('firingSpan', () => {
  it('runs from Fire to burnout, or to the first tank dry without one', () => {
    expect(firingSpan(EVENTS)).toEqual([0, 3.6]);
    expect(firingSpan(EVENTS.filter((e) => e.kind !== 'burnout'))).toEqual([0, 3.4]);
    expect(firingSpan(EVENTS.filter((e) => e.kind !== 'fire'))).toBeNull();
  });
});

describe('layoutMarkers, over many crowds', () => {
  /** Deterministic pseudo-random in [0, 1). */
  const rand = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const KINDS = ['t0', 'lead', 'fire', 'ignition', 'min', 'dry', 'burnout', 'end', 'warn', 'trip', 'other'];
  const WORDS = ['Fire', 'Burnout', 'Min ΔP/Pc', 'Regulator wide open', 'LOX tank low', 'T−0', 'Ignition', 'Fuel dry', 'Trip: LOX tank MAWP'];

  it('never lets two labels touch or leave the track, and always shows the most important one', () => {
    const r = rand(7);
    for (let trial = 0; trial < 400; trial++) {
      const width = 120 + Math.floor(r() * 1400);
      const n = 1 + Math.floor(r() * 16);
      const events = Array.from({ length: n }, (_, i) => ev(r() * 4 - 0.5, `e${i}`, WORDS[Math.floor(r() * WORDS.length)], KINDS[Math.floor(r() * KINDS.length)]));
      const ms = layoutMarkers(events, { x: (t) => ((t + 0.5) / 4) * width, width, measure });
      expect(overlaps(ms), `trial ${trial}`).toEqual([]);
      for (const m of ms.filter((x) => x.showLabel)) {
        expect(m.labelLeft).toBeGreaterThanOrEqual(-1e-9);
        expect(m.labelLeft + m.labelWidth).toBeLessThanOrEqual(width + 1e-9);
      }
      // The top-priority group (earliest on a tie) always keeps its label.
      const top = [...ms].sort((a, b) => priorityOf(b) - priorityOf(a) || a.t - b.t)[0];
      expect(top.showLabel, `trial ${trial}`).toBe(true);
    }
  });

  it('ranks a trip over Fire', () => {
    const ms = layoutMarkers([ev(1, 'fire', 'Fire', 'fire'), ev(1.01, 'trip', 'Trip', 'trip')], { x: (t) => t * 100, width: 400, measure });
    expect(ms.find((m) => m.kind === 'trip')?.showLabel).toBe(true);
  });
});
