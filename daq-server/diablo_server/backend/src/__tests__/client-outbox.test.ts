import { describe, it, expect } from 'vitest';
import {
  ClientOutbox,
  FlushPacer,
  mergeWindows,
  SOCKET_IDLE_BYTES,
  type OutboxWindow,
} from '../client-outbox.js';

const W = (t0: number, t1: number, min: number, minTs: number, max: number, maxTs: number)
  : OutboxWindow => ({ t0, t1, min, minTs, max, maxTs });

/** Feed one closed envelope window (min then max, chronological). */
function pushWindow(ob: ClientOutbox, key: string, tMs: number, min: number, max: number): void {
  ob.push(key, 'PT_Cal', 'CH3', min === max
    ? [{ tMs, value: min }]
    : [{ tMs, value: min }, { tMs: tMs + 50, value: max }]);
}

/** Every point of a drain, flattened in the order it would go on the wire. */
function drainPoints(ob: ClientOutbox) {
  return ob.drain().flatMap((s) => s.points);
}

describe('mergeWindows', () => {
  it('keeps each extreme with its own original timestamp', () => {
    const a = W(0, 100, 10, 20, 50, 80);
    const b = W(100, 200, 3, 190, 40, 110);
    const m = mergeWindows(a, b);
    expect(m).toEqual({ t0: 0, t1: 200, min: 3, minTs: 190, max: 50, maxTs: 80 });
  });

  it('widens the span to cover both windows', () => {
    const m = mergeWindows(W(5, 10, 1, 6, 2, 7), W(10, 25, 1, 11, 2, 12));
    expect(m.t0).toBe(5);
    expect(m.t1).toBe(25);
  });
});

describe('ClientOutbox ladder', () => {
  it('holds nothing back for a client that drains every tick', () => {
    const ob = new ClientOutbox();
    // A healthy client flushes after every window, so level 0 never fills and
    // the compaction path never runs at all.
    const seen: number[] = [];
    for (let i = 0; i < 200; i++) {
      pushWindow(ob, 'k', i * 100, i, i + 1);
      expect(ob.windowsHeld).toBe(1);
      seen.push(...drainPoints(ob).map((p) => p.value));
    }
    // Every produced point arrived, none merged.
    expect(seen).toHaveLength(400);
    expect(ob.resolutionRatio()).toBe(1);
  });

  it('never exceeds levelCapacity x levelCount windows however long the stall', () => {
    const ob = new ClientOutbox({ levelCapacity: 8, levelCount: 8 });
    for (let i = 0; i < 20_000; i++) pushWindow(ob, 'k', i * 100, i, i + 1);
    expect(ob.windowsHeld).toBeLessThanOrEqual(64);
  });

  it('preserves the run peak at its exact timestamp across many compactions', () => {
    const ob = new ClientOutbox({ levelCapacity: 8, levelCount: 8 });
    // 600 windows = a 60 s stall at 100 ms windows, with one spike partway in.
    for (let i = 0; i < 600; i++) {
      if (i === 82) pushWindow(ob, 'k', 8200, 400, 620);   // the ignition spike
      else pushWindow(ob, 'k', i * 100, 440, 460);
    }
    const pts = drainPoints(ob);
    const peak = pts.reduce((a, p) => (p.value > a.value ? p : a));
    expect(peak.value).toBe(620);
    expect(peak.tMs).toBe(8250);   // max point of that window, unmoved
  });

  it('emits strictly ascending timestamps through a stall-then-drain cycle', () => {
    // data-cache.ts addDataPoint drops anything older than its ring head, so a
    // single inversion here would silently lose points in the browser.
    const ob = new ClientOutbox({ levelCapacity: 4, levelCount: 6 });
    for (let i = 0; i < 500; i++) {
      pushWindow(ob, 'k', i * 100, Math.sin(i) * 10, Math.cos(i) * 10 + 20);
    }
    const pts = drainPoints(ob);
    expect(pts.length).toBeGreaterThan(1);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].tMs).toBeGreaterThan(pts[i - 1].tMs);
    }
  });

  it('drops the oldest data, not the newest, once coverage is exceeded', () => {
    const ob = new ClientOutbox({ levelCapacity: 2, levelCount: 3 });  // tiny coverage
    for (let i = 0; i < 400; i++) pushWindow(ob, 'k', i * 100, i, i + 1);
    const pts = drainPoints(ob);
    const newest = pts[pts.length - 1];
    // The most recent window must always survive; the run started at t=0 and
    // that end is what should have fallen off.
    expect(newest.tMs).toBeGreaterThan(39_000);
    expect(pts[0].tMs).toBeGreaterThan(0);
  });

  it('keeps each series independent', () => {
    const ob = new ClientOutbox();
    for (let i = 0; i < 50; i++) {
      pushWindow(ob, 'a', i * 100, 1, 2);
      pushWindow(ob, 'b', i * 100, 5, 6);
    }
    const flush = ob.drain();
    expect(flush.map((f) => f.key).sort()).toEqual(['a', 'b']);
    expect(flush.find((f) => f.key === 'a')!.points.every((p) => p.value <= 2)).toBe(true);
    expect(flush.find((f) => f.key === 'b')!.points.every((p) => p.value >= 5)).toBe(true);
  });
});

describe('ClientOutbox.squeeze', () => {
  it('brings a dump under budget across three orders of magnitude', () => {
    for (const budget of [2_000_000, 200_000, 20_000, 2_000]) {
      const ob = new ClientOutbox({ levelCapacity: 8, levelCount: 10 });
      for (let k = 0; k < 47; k++) {
        for (let i = 0; i < 600; i++) pushWindow(ob, `k${k}`, i * 100, i, i + 1);
      }
      ob.squeeze(budget);
      // Floor: one window per series is never squeezed away, so a budget below
      // that cannot be met — assert the floor rather than the budget there.
      const floor = 47 * 2 * 135;
      expect(ob.estimatedBytes()).toBeLessThanOrEqual(Math.max(budget, floor));
    }
  });

  it('never squeezes a series below one window', () => {
    const ob = new ClientOutbox();
    for (let i = 0; i < 600; i++) pushWindow(ob, 'k', i * 100, i, i + 1);
    ob.squeeze(1);
    expect(ob.windowsHeld).toBe(1);
    expect(drainPoints(ob).length).toBeGreaterThan(0);
  });

  it('still preserves the peak after being squeezed hard', () => {
    const ob = new ClientOutbox();
    for (let i = 0; i < 600; i++) {
      if (i === 82) pushWindow(ob, 'k', 8200, 400, 620);
      else pushWindow(ob, 'k', i * 100, 440, 460);
    }
    ob.squeeze(500);
    const pts = drainPoints(ob);
    expect(Math.max(...pts.map((p) => p.value))).toBe(620);
  });

  it('reports whether it dropped anything, for the operator badge', () => {
    const quiet = new ClientOutbox();
    pushWindow(quiet, 'k', 0, 1, 2);
    quiet.squeeze(10_000_000);
    expect(quiet.squeezeDroppedLast).toBe(false);

    const busy = new ClientOutbox();
    for (let i = 0; i < 600; i++) pushWindow(busy, 'k', i * 100, i, i + 1);
    busy.squeeze(1000);
    expect(busy.squeezeDroppedLast).toBe(true);
  });
});

describe('FlushPacer', () => {
  it('holds off while the socket still has a backlog', () => {
    const p = new FlushPacer();
    expect(p.shouldFlush(SOCKET_IDLE_BYTES * 10, 1000)).toBe(false);
    expect(p.shouldFlush(0, 1000)).toBe(true);
  });

  it('learns the drain rate from how long a dump took to clear', () => {
    const p = new FlushPacer(1500, 1_000_000);
    // 100 KB handed over, socket empty 2 s later => ~50 KB/s.
    p.noteFlush(100_000, 0);
    p.shouldFlush(0, 2000);
    expect(p.measuredRateBps).toBeGreaterThan(100_000);
    expect(p.measuredRateBps).toBeLessThan(1_000_000);
    for (let i = 0; i < 30; i++) {                 // let the EMA settle
      p.noteFlush(100_000, i * 2000);
      p.shouldFlush(0, i * 2000 + 2000);
    }
    expect(p.measuredRateBps).toBeGreaterThan(45_000);
    expect(p.measuredRateBps).toBeLessThan(55_000);
  });

  it('turns the measured rate into a latency budget', () => {
    const p = new FlushPacer(1500, 50_000);
    expect(p.budgetBytes).toBe(75_000);   // 50 KB/s x 1.5 s
  });
});

describe('lag stays within the budget on a slow link', () => {
  // The assertion that actually pins the design. A regression to fixed-K
  // compaction (no squeeze) shows up here as multi-second lag on 50 KB/s.
  it.each([
    ['2000 KB/s', 2000 * 1024],
    ['200 KB/s', 200 * 1024],
    ['50 KB/s', 50 * 1024],
    ['20 KB/s', 20 * 1024],
  ])('%s', (_label, linkBps) => {
    const TICK = 100, TARGET = 1500, KEYS = 47;
    const ob = new ClientOutbox();
    const pacer = new FlushPacer(TARGET, linkBps);
    let buffered = 0, lastFlush = 0, maxLag = 0;

    for (let tick = 1; tick <= 3000; tick++) {
      const now = tick * TICK;
      buffered = Math.max(0, buffered - (linkBps * TICK) / 1000);
      for (let k = 0; k < KEYS; k++) pushWindow(ob, `k${k}`, now, k, k + 1);

      if (pacer.shouldFlush(buffered, now)) {
        ob.squeeze(pacer.budgetBytes);
        const bytes = ob.estimatedBytes();
        ob.drain();
        buffered += bytes;
        pacer.noteFlush(bytes, now);
        lastFlush = now;
      }
      if (tick > 1000) maxLag = Math.max(maxLag, now - lastFlush);
    }
    expect(maxLag).toBeLessThanOrEqual(TARGET * 2);
  });
});
