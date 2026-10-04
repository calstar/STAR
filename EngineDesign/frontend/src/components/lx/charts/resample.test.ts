import { describe, expect, it } from 'vitest';
import { valueAt } from '../time/search';
import { alignOnto, onlyWhere } from './resample';

describe('alignOnto', () => {
  it('reads the other run at this run\'s times, null outside it and across its gaps', () => {
    const t = [-0.5, 0, 0.25, 0.5, 1, 1.5, 2.5];
    const srcT = [0, 0.5, 1, 2];
    const src = [10, 20, null, 40];
    expect(alignOnto(t, srcT, src)).toEqual([null, 10, 15, 20, null, null, null]);
  });

  it('agrees with a point-by-point interpolation', () => {
    const srcT = Array.from({ length: 300 }, (_, i) => i * 0.013);
    const src = srcT.map((x) => Math.sin(x) * 100);
    const t = Array.from({ length: 500 }, (_, i) => -0.2 + i * 0.01);
    const got = alignOnto(t, srcT, src);
    t.forEach((q, i) => {
      const want = valueAt(srcT, src, q);
      if (want === null) expect(got[i]).toBeNull();
      else expect(got[i]).toBeCloseTo(want, 9);
    });
  });

  it('handles a single-sample and an empty source', () => {
    expect(alignOnto([0, 1], [1], [5])).toEqual([null, 5]);
    expect(alignOnto([0, 1], [], [])).toEqual([null, null]);
  });
});

describe('onlyWhere', () => {
  it('blanks the samples outside the mask', () => {
    expect(onlyWhere([1, 2, 3, 4], [false, true, true, false])).toEqual([null, 2, 3, null]);
  });
});
