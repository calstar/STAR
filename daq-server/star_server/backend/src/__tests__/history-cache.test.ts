import { describe, it, expect } from 'vitest';
import { HistoryCache } from '../history-cache.js';

const mk = (over: Partial<ConstructorParameters<typeof HistoryCache>[0]> = {}) =>
  new HistoryCache({ maxPoints: 16, maxKeys: 4, staleMs: 60_000, initialPoints: 4, ...over });

describe('HistoryCache', () => {
  it('records and reads back ascending epoch-ms series', () => {
    const h = mk();
    h.record('a.x', 1000, 1);
    h.record('a.x', 1001, 2);
    h.record('a.x', 1002, 3);
    expect(h.read('a.x')).toEqual({ time: [1000, 1001, 1002], values: [1, 2, 3] });
    expect(h.read('missing')).toBeNull();
  });

  it('overwrites the last value on identical timestamp', () => {
    const h = mk();
    h.record('a.x', 1000, 1);
    h.record('a.x', 1000, 9);
    expect(h.read('a.x')).toEqual({ time: [1000], values: [9] });
  });

  it('grows geometrically preserving order, then wraps at maxPoints keeping newest', () => {
    const h = mk({ maxPoints: 8, initialPoints: 2 });
    for (let i = 0; i < 20; i++) h.record('a.x', 1000 + i, i);
    const out = h.read('a.x')!;
    expect(out.time).toHaveLength(8); // grew 2 → 8 (cap), then ring-wrapped
    expect(out.time).toEqual([1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019]);
    expect(out.values).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
  });

  describe('buildPayload', () => {
    const filled = () => {
      const h = mk();
      for (let i = 0; i < 5; i++) h.record('a.x', 1000 + i * 10, i);
      for (let i = 0; i < 5; i++) h.record('b.y', 2000 + i * 10, i * 100);
      return h;
    };

    it('no query → full dump of every series', () => {
      const p = filled().buildPayload(undefined, 3000);
      expect(Object.keys(p).sort()).toEqual(['a.x', 'b.y']);
      expect(p['a.x'].time).toHaveLength(5);
    });

    it('keys filter restricts series; unknown keys are skipped', () => {
      const p = filled().buildPayload({ keys: ['b.y', 'nope.z'] }, 3000);
      expect(Object.keys(p)).toEqual(['b.y']);
    });

    it('sinceMs keeps only strictly newer points and drops fully-old series', () => {
      const p = filled().buildPayload({ sinceMs: 1020 }, 3000);
      expect(p['a.x']).toEqual({ time: [1030, 1040], values: [3, 4] }); // 1020 itself excluded
      expect(p['b.y'].time).toHaveLength(5); // all newer than 1020
      const p2 = filled().buildPayload({ keys: ['a.x'], sinceMs: 5000 }, 3000);
      expect(Object.keys(p2)).toEqual([]); // entirely older → omitted
    });

    it('maxSendPoints trims each series to its newest N', () => {
      const p = filled().buildPayload(undefined, 2);
      expect(p['a.x']).toEqual({ time: [1030, 1040], values: [3, 4] });
    });
  });

  describe('prune', () => {
    it('evicts stale series', () => {
      const h = mk({ staleMs: 1000 });
      h.record('a.x', 1000, 1);
      h.prune(Date.now() + 2000);
      expect(h.size).toBe(0);
    });

    it('evicts oldest-written series beyond maxKeys', () => {
      const h = mk({ maxKeys: 2 });
      h.record('k1', 1, 1);
      h.record('k2', 2, 2);
      h.record('k3', 3, 3);
      h.prune();
      expect(h.size).toBe(2);
      expect(h.read('k3')).not.toBeNull(); // newest survives
    });
  });
});
