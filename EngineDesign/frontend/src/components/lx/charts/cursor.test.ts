import { describe, expect, it } from 'vitest';
import { ownCursorStart } from './engine';

/**
 * A chart whose x is not the burn's clock (along the engine, the time-lag sweep) keeps a cursor of
 * its own. It opened on the first sample, so on the Hardware page "Heat load along the engine" read
 * "Peak 3.9 MW/m²" (the chamber head) on a chart whose peak is 28 at the throat.
 */
describe('a chart’s own cursor', () => {
  const x = [-120, -60, 0, 40, 80];                       // mm from the throat
  const along = {
    t: x, xTime: false,
    series: [
      { key: 'peak', label: 'Peak', color: '--lx-text-2', values: [3.9, 6.1, 28.2, 12.0, 4.4] },
      { key: 'now', label: 'Cursor', color: '--lx-hot', values: [2.8, 4.0, 10.5, 6.0, 2.0] },
    ],
  };

  it('opens on the peak of its first series, not its first sample', () => {
    expect(ownCursorStart(along)).toBe(0);
  });

  it('opens on the point it marks (the lag the burn used) when it marks one', () => {
    const tau = { t: [14.5, 20, 25, 30], xTime: false, events: [{ t: 22.1, key: 'nominal', label: 'nominal', kind: 'fire' }],
      series: [{ key: 'tau', label: 'Margin', color: '--lx-text', values: [1.43, 1.2, 1.0, 0.9] }] };
    expect(ownCursorStart(tau)).toBe(22.1);
  });

  it('on the clock it still opens on the first sample', () => {
    expect(ownCursorStart({ ...along, xTime: undefined })).toBe(-120);
  });
});
