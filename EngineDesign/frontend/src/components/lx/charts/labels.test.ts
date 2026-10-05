import { describe, expect, it } from 'vitest';
import { boxesOverlap, leaderFor, noteCost, placeLabels, placeNote, segmentHitsBox, type LabelItem } from './labels';

const H = 14;
const item = (key: string, y: number, h = H): LabelItem => ({ key, y, h });

/** Overlaps between consecutive placed labels (with the gap), in placement order. */
function collisions(items: LabelItem[], placed: Map<string, number>, gap: number): string[] {
  const rows = items.map((it) => ({ ...it, c: placed.get(it.key)! })).sort((a, b) => a.c - b.c);
  const bad: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prevBottom = rows[i - 1].c + rows[i - 1].h / 2;
    const top = rows[i].c - rows[i].h / 2;
    if (top < prevBottom + gap - 1e-9) bad.push(`${rows[i - 1].key}/${rows[i].key}`);
  }
  return bad;
}

describe('placeLabels', () => {
  it('leaves labels that do not collide where they are', () => {
    const items = [item('a', 20), item('b', 80), item('c', 140)];
    const p = placeLabels(items, 0, 200);
    expect(p.get('a')).toBe(20);
    expect(p.get('b')).toBe(80);
    expect(p.get('c')).toBe(140);
  });

  it('pushes two labels at one height apart symmetrically', () => {
    const p = placeLabels([item('lox', 100), item('fuel', 100)], 0, 200, 2);
    const a = p.get('lox')!;
    const b = p.get('fuel')!;
    expect(Math.abs(b - a)).toBeCloseTo(H + 2, 9);
    expect((a + b) / 2).toBeCloseTo(100, 9);
    // Equal heights keep the given order.
    expect(a).toBeLessThan(b);
  });

  it('keeps order and clears every overlap in a crowd', () => {
    const items = [item('tank', 50), item('inj', 53), item('pc', 55), item('x', 120), item('y', 121)];
    const p = placeLabels(items, 0, 200, 2);
    expect(collisions(items, p, 2)).toEqual([]);
    const order = [...items].sort((a, b) => p.get(a.key)! - p.get(b.key)!).map((i) => i.key);
    expect(order).toEqual(['tank', 'inj', 'pc', 'x', 'y']);
  });

  it('stays inside the plot, pushed off the edges', () => {
    const items = [item('a', -10), item('b', -5), item('c', 205)];
    const p = placeLabels(items, 0, 200, 2);
    expect(collisions(items, p, 2)).toEqual([]);
    for (const it of items) {
      expect(p.get(it.key)! - it.h / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(p.get(it.key)! + it.h / 2).toBeLessThanOrEqual(200 + 1e-9);
    }
  });

  it('moves the crowd least: a lone label far away does not move', () => {
    const items = [item('a', 100), item('b', 101), item('c', 102), item('far', 190)];
    const p = placeLabels(items, 0, 400, 0);
    expect(p.get('far')).toBe(190);
    // The three are centred on their mean.
    const mean = (p.get('a')! + p.get('b')! + p.get('c')!) / 3;
    expect(mean).toBeCloseTo(101, 9);
  });

  it('stacks from the top when they cannot all fit, and ignores NaN', () => {
    const items = [item('a', 5), item('b', 5), item('c', 5)];
    const p = placeLabels(items, 0, 20, 2);
    expect(p.get('a')).toBe(7);
    expect(collisions(items, p, 2)).toEqual([]);
    expect(placeLabels([item('n', Number.NaN)], 0, 10).size).toBe(0);
  });
});

describe('placeNote', () => {
  const bounds = { x: 0, y: 0, w: 400, h: 200 };
  const size = { w: 120, h: 14 };

  it('goes above and to the right of the ring when nothing is there', () => {
    const b = placeNote({ x: 100, y: 100 }, size, bounds, {});
    expect(b.x).toBeGreaterThan(100);
    expect(b.y + b.h).toBeLessThan(100);
  });

  it('never sits on a limit line when a free spot exists', () => {
    // A limit line just above the worst point, where the first choice would go.
    const obs = { hlines: [90] };
    const b = placeNote({ x: 100, y: 100 }, size, bounds, obs);
    expect(noteCost(b, obs)).toBeLessThan(1000);
    expect(90 >= b.y - 1 && 90 <= b.y + b.h + 1).toBe(false);
  });

  it('keeps off the data lines, choosing the side the line leaves free', () => {
    // A line rising to the right, through the worst point: above-right and below-left are crossed.
    const line = [0, 200, 100, 100, 400, -200];
    const b = placeNote({ x: 100, y: 100 }, size, bounds, { polylines: [line] });
    expect(noteCost(b, { polylines: [line] })).toBe(0);
  });

  it('stays inside the plot at its edges', () => {
    for (const a of [{ x: 395, y: 5 }, { x: 2, y: 198 }, { x: 395, y: 198 }]) {
      const b = placeNote(a, size, bounds, {});
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(400 + 1e-9);
      expect(b.y + b.h).toBeLessThanOrEqual(200 + 1e-9);
      // ...and off its own ring.
      expect(boxesOverlap(b, { x: a.x - 6, y: a.y - 6, w: 12, h: 12 })).toBe(false);
    }
  });

  it('keeps off text already placed', () => {
    const taken = { x: 108, y: 70, w: 200, h: 26 };
    const b = placeNote({ x: 100, y: 100 }, size, bounds, { boxes: [taken] });
    expect(boxesOverlap(b, taken, 2)).toBe(false);
  });
});

describe('segmentHitsBox', () => {
  it('finds a crossing and misses a near pass', () => {
    const box = { x: 10, y: 10, w: 10, h: 10 };
    expect(segmentHitsBox(0, 15, 30, 15, box)).toBe(true);
    expect(segmentHitsBox(0, 0, 30, 30, box)).toBe(true);
    expect(segmentHitsBox(0, 25, 30, 25, box)).toBe(false);
    expect(segmentHitsBox(0, 0, 5, 30, box)).toBe(false);
  });
});

describe('placeNote between lines', () => {
  it('finds the gap between two data lines rather than lying on one', () => {
    // The gallery's case: the ring on a dip under a limit line (y 186) with a second limit at 208
    // and two flat data lines above at 148 and 170; the only clear band is 150-168.
    const flat = (y: number) => [0, y, 400, y];
    const obs = { polylines: [flat(148), flat(170), [100, 170, 120, 200, 140, 170]], hlines: [186, 208] };
    // The plot ends at 214, so nothing fits under the ring either.
    const b = placeNote({ x: 120, y: 200 }, { w: 130, h: 14 }, { x: 0, y: 0, w: 400, h: 214 }, obs);
    expect(noteCost(b, obs)).toBeLessThan(40);
    expect(b.y).toBeGreaterThan(148);
    expect(b.y + b.h).toBeLessThan(170);
  });
});

describe('leaderFor', () => {
  it('draws nothing for a note beside its ring, a hairline for one set apart', () => {
    expect(leaderFor({ x: 100, y: 100 }, { x: 110, y: 80, w: 100, h: 14 }, 5)).toBeNull();
    const l = leaderFor({ x: 100, y: 100 }, { x: 60, y: 40, w: 100, h: 14 }, 5);
    expect(l).not.toBeNull();
    const [x0, y0, x1, y1] = l as number[];
    // From the ring's edge straight up to the note's bottom edge.
    expect(x0).toBeCloseTo(100, 9);
    expect(y0).toBeCloseTo(93.5, 9);
    expect(x1).toBeCloseTo(100, 9);
    expect(y1).toBeCloseTo(55.5, 9);
  });
});
