import { describe, it, expect } from 'vitest';
import {
  parseGuiStreamConfig,
  envelopeWindowMs,
  EnvelopeAccumulator,
  DEFAULT_GUI_STREAM_CONFIG,
} from '../gui-stream.js';

describe('parseGuiStreamConfig', () => {
  it('returns defaults for missing/invalid config', () => {
    expect(parseGuiStreamConfig(null)).toEqual(DEFAULT_GUI_STREAM_CONFIG);
    expect(parseGuiStreamConfig(undefined)).toEqual(DEFAULT_GUI_STREAM_CONFIG);
    expect(parseGuiStreamConfig({})).toEqual(DEFAULT_GUI_STREAM_CONFIG);
    expect(parseGuiStreamConfig({ gui: 'nope' })).toEqual(DEFAULT_GUI_STREAM_CONFIG);
    expect(parseGuiStreamConfig({ gui: { downsample_mode: 'bogus', points_per_second: 'x' } }))
      .toEqual(DEFAULT_GUI_STREAM_CONFIG);
  });

  it('accepts valid mode and rate', () => {
    expect(parseGuiStreamConfig({ gui: { downsample_mode: 'throttle', points_per_second: 10 } }))
      .toEqual({ mode: 'throttle', pointsPerSecond: 10 });
    expect(parseGuiStreamConfig({ gui: { downsample_mode: 'envelope' } }))
      .toEqual({ mode: 'envelope', pointsPerSecond: 20 });
  });

  it('rejects out-of-range rates (bad config edit cannot take the stream down)', () => {
    expect(parseGuiStreamConfig({ gui: { points_per_second: 0 } }).pointsPerSecond).toBe(20);
    expect(parseGuiStreamConfig({ gui: { points_per_second: 1e9 } }).pointsPerSecond).toBe(20);
    expect(parseGuiStreamConfig({ gui: { points_per_second: -5 } }).pointsPerSecond).toBe(20);
  });

  it('computes window length as pointsPerSecond/2 windows per second', () => {
    expect(envelopeWindowMs({ mode: 'envelope', pointsPerSecond: 20 })).toBe(100);
    expect(envelopeWindowMs({ mode: 'envelope', pointsPerSecond: 10 })).toBe(200);
  });
});

describe('EnvelopeAccumulator', () => {
  const KEY = 'PT1_Cal.CH1.pressure_psi';
  const E = 'PT1_Cal.CH1';
  const C = 'pressure_psi';

  it('opens a window on the first sample without emitting', () => {
    const acc = new EnvelopeAccumulator(100);
    expect(acc.add(KEY, E, C, 1000, 5)).toEqual([]);
    expect(acc.openWindowCount).toBe(1);
  });

  it('emits min and max in chronological order when a window closes', () => {
    const acc = new EnvelopeAccumulator(100);
    acc.add(KEY, E, C, 1000, 50);   // opens window
    acc.add(KEY, E, C, 1010, 500);  // max at t=1010 (spike)
    acc.add(KEY, E, C, 1020, 10);   // min at t=1020
    acc.add(KEY, E, C, 1030, 60);
    const out = acc.add(KEY, E, C, 1100, 55); // starts next window → closes previous
    expect(out).toEqual([
      { tMs: 1010, value: 500 }, // max occurred first → emitted first
      { tMs: 1020, value: 10 },
    ]);
    expect(acc.openWindowCount).toBe(1); // new window holds the t=1100 sample
  });

  it('a spike inside the window always survives as the window max', () => {
    const acc = new EnvelopeAccumulator(100);
    acc.add(KEY, E, C, 0, 100);
    for (let t = 5; t < 100; t += 5) {
      acc.add(KEY, E, C, t, t === 50 ? 9999 : 100 + t * 0.01); // 5 ms spike at t=50
    }
    const out = acc.add(KEY, E, C, 150, 100);
    expect(out.some((p) => p.value === 9999 && p.tMs === 50)).toBe(true);
  });

  it('emits a single point for a single-sample window', () => {
    const acc = new EnvelopeAccumulator(100);
    acc.add(KEY, E, C, 1000, 42);
    const out = acc.add(KEY, E, C, 1200, 43);
    expect(out).toEqual([{ tMs: 1000, value: 42 }]);
  });

  it('emits a single point for a flat window (min === max)', () => {
    const acc = new EnvelopeAccumulator(100);
    acc.add(KEY, E, C, 1000, 7);
    acc.add(KEY, E, C, 1010, 7);
    acc.add(KEY, E, C, 1020, 7);
    const out = acc.add(KEY, E, C, 1200, 8);
    expect(out).toEqual([{ tMs: 1000, value: 7 }]);
  });

  it('nudges the second point +1ms when min and max share a timestamp', () => {
    const acc = new EnvelopeAccumulator(100);
    acc.add(KEY, E, C, 1000, 5);
    acc.add(KEY, E, C, 1000, 90); // same ms, different value
    const out = acc.add(KEY, E, C, 1200, 6);
    expect(out).toEqual([
      { tMs: 1000, value: 5 },
      { tMs: 1001, value: 90 },
    ]);
  });

  it('tracks independent windows per key', () => {
    const acc = new EnvelopeAccumulator(100);
    acc.add('a.x', 'a', 'x', 1000, 1);
    acc.add('b.y', 'b', 'y', 1000, 2);
    expect(acc.openWindowCount).toBe(2);
    const out = acc.add('a.x', 'a', 'x', 1200, 3);
    expect(out).toHaveLength(1);
    expect(acc.openWindowCount).toBe(2); // b.y untouched, a.x reopened
  });

  it('flushOlderThan closes idle windows (with grace) and leaves fresh ones', () => {
    const acc = new EnvelopeAccumulator(100);
    acc.add('old.k', 'old', 'k', 1000, 11);
    acc.add('new.k', 'new', 'k', 1400, 22);
    const flushed = acc.flushOlderThan(1500); // old: 500ms stale; new: 100ms (within grace)
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ key: 'old.k', entity: 'old', component: 'k' });
    expect(flushed[0].points).toEqual([{ tMs: 1000, value: 11 }]);
    expect(acc.openWindowCount).toBe(1);
  });

  it('setWindowMs applies to subsequent rollovers (config reload)', () => {
    const acc = new EnvelopeAccumulator(100);
    acc.add(KEY, E, C, 1000, 1);
    acc.setWindowMs(1000);
    expect(acc.add(KEY, E, C, 1500, 2)).toEqual([]); // now inside the longer window
    const out = acc.add(KEY, E, C, 2100, 3);
    expect(out).toEqual([
      { tMs: 1000, value: 1 },
      { tMs: 1500, value: 2 },
    ]);
  });
});
