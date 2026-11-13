/**
 * Data-layer refactor tests: server-timestamp-keyed cache, merge-not-wipe
 * HISTORICAL_DATA, sinceMs backfill provider, and the plot time base.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── websocket mock (data-cache wires itself to the WS client in start()) ─────
const listeners = new Map<string, (payload: unknown) => void>();
let queryProvider: (() => { keys?: string[]; sinceMs?: number }) | null = null;

vi.mock('@/lib/websocket', () => ({
  getWebSocketClient: () => ({
    on: (type: string, cb: (payload: unknown) => void) => {
      listeners.set(type, cb);
      return () => listeners.delete(type);
    },
    setHistoricalQueryProvider: (p: () => { keys?: string[]; sinceMs?: number }) => {
      queryProvider = p;
    },
    onConnectionStatus: () => () => {},
    isConnected: () => true,
    connect: () => {},
    send: () => {},
  }),
  getApiBaseUrl: () => 'http://localhost:8081',
}));

async function freshModules() {
  vi.resetModules();
  listeners.clear();
  queryProvider = null;
  const plotTime = await import('@/lib/plot-time');
  plotTime.resetPlotTimeForTests();
  const dataCache = await import('@/lib/data-cache');
  // No markFresh() any more: getAlignedHistory no longer consults readout freshness, so
  // a test does not have to pretend a stream is fresh to see its own data back. Plots
  // draw what the cache holds and end each line at its last sample.
  return { plotTime, dataCache };
}

const T0 = 1_800_000_000_000; // arbitrary epoch-ms base

describe('plot-time', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('serverNowMs tracks the freshest server timestamp and never goes backwards', async () => {
    const { plotTime } = await freshModules();
    plotTime.noteServerTimestamp(T0);
    expect(plotTime.serverNowMs()).toBeGreaterThanOrEqual(T0);

    plotTime.noteServerTimestamp(T0 + 5000);
    const after = plotTime.serverNowMs();
    expect(after).toBeGreaterThanOrEqual(T0 + 5000);

    // A stale/out-of-order timestamp must not rewind "now".
    plotTime.noteServerTimestamp(T0 + 1000);
    expect(plotTime.serverNowMs()).toBeGreaterThanOrEqual(after);
  });

  it('advances between reads even with no new messages (stalled stream)', async () => {
    const { plotTime } = await freshModules();
    plotTime.noteServerTimestamp(T0);
    const a = plotTime.serverNowMs();
    const waitUntil = performance.now() + 15;
    while (performance.now() < waitUntil) { /* spin ~15ms */ }
    expect(plotTime.serverNowMs()).toBeGreaterThan(a);
  });

  it('tracks first/newest seen timestamps for T+ fallback and backfills', async () => {
    const { plotTime } = await freshModules();
    expect(plotTime.firstSeenServerTsMs()).toBeNull();
    expect(plotTime.newestServerTsMs()).toBeNull();
    plotTime.noteServerTimestamp(T0 + 100);
    plotTime.noteServerTimestamp(T0 + 50);
    plotTime.noteServerTimestamp(T0 + 200);
    expect(plotTime.firstSeenServerTsMs()).toBe(T0 + 50);
    expect(plotTime.newestServerTsMs()).toBe(T0 + 200);
  });
});

describe('data-cache (server-timestamp keyed)', () => {
  it('addDataPoint stores points at their server timestamps; live window reads them back', async () => {
    const { dataCache } = await freshModules();
    const cache = dataCache.getDataCache();
    for (let i = 0; i < 10; i++) {
      cache.addDataPoint('PT1_Cal.CH1', 'pressure_psi', 100 + i, T0 + i * 50);
    }
    const out = cache.getAlignedHistory(['PT1_Cal.CH1'], ['pressure_psi'], 60);
    expect(out).not.toBeNull();
    expect(out!.time).toHaveLength(10);
    expect(out!.time[0]).toBe(T0);
    expect(out!.time[9]).toBe(T0 + 450);
    expect(out!.values[0][9]).toBe(109);
  });

  it('drops strictly-older points and overwrites same-instant points', async () => {
    const { dataCache } = await freshModules();
    const cache = dataCache.getDataCache();
    cache.addDataPoint('e', 'c', 1, T0 + 100);
    cache.addDataPoint('e', 'c', 2, T0 + 50);   // older → dropped
    cache.addDataPoint('e', 'c', 3, T0 + 100);  // same instant → overwrite
    const out = cache.getAlignedHistory(['e'], ['c'], 60)!;
    expect(out.time).toEqual([T0 + 100]);
    expect(out.values[0]).toEqual([3]);
  });

  it('HISTORICAL_DATA merges by timestamp — never wipes live data (the reset bug)', async () => {
    const { dataCache } = await freshModules();
    const cache = dataCache.getDataCache();
    cache.start();
    const historical = listeners.get('historical_data');
    expect(historical).toBeTypeOf('function');

    // Live data present first (points the backend may no longer have).
    cache.addDataPoint('e', 'c', 10, T0 + 1000);
    cache.addDataPoint('e', 'c', 11, T0 + 2000);

    // Backfill arrives: overlaps the live points and extends past them.
    historical!({
      'e.c': {
        time: [T0 + 1500, T0 + 2000, T0 + 3000, T0 + 4000],
        values: [99, 99, 12, 13],
      },
    });

    const out = cache.getAlignedHistory(['e'], ['c'], 60)!;
    // Pre-existing points kept (no wipe), overlap deduped, gap appended.
    expect(out.time).toEqual([T0 + 1000, T0 + 2000, T0 + 3000, T0 + 4000]);
    expect(out.values[0]).toEqual([10, 11, 12, 13]);
  });

  it('registers a sinceMs backfill provider once data is held', async () => {
    const { dataCache } = await freshModules();
    const cache = dataCache.getDataCache();
    cache.start();
    expect(queryProvider).toBeTypeOf('function');
    expect(queryProvider!()).toEqual({}); // nothing held yet → full dump

    cache.addDataPoint('e', 'c', 1, T0 + 10_000);
    const q = queryProvider!();
    expect(q.sinceMs).toBeDefined();
    expect(q.sinceMs!).toBeLessThanOrEqual(T0 + 10_000); // includes overlap margin
    expect(q.sinceMs!).toBeGreaterThan(T0);
  });
});

describe('T+ axis labeling', () => {
  it('labels relative to missionStartTime and relabels when it changes — data untouched', async () => {
    const { dataCache } = await freshModules();
    const { useSensorStore } = await import('@/lib/store');
    const { tPlusAxisValues } = await import('@/lib/plot-shared');

    const cache = dataCache.getDataCache();
    cache.addDataPoint('e', 'c', 1, T0 + 30_000);

    useSensorStore.setState({ missionStartTime: T0 });
    const labels1 = tPlusAxisValues(null as never, [T0 + 10_000, T0 + 30_000]);
    expect(labels1).toEqual(['10', '30']);

    // Mission start re-anchors (e.g. backend restart) → labels shift…
    useSensorStore.setState({ missionStartTime: T0 + 10_000 });
    const labels2 = tPlusAxisValues(null as never, [T0 + 10_000, T0 + 30_000]);
    expect(labels2).toEqual(['0', '20']);

    // …but cached data is untouched.
    const out = cache.getAlignedHistory(['e'], ['c'], 60)!;
    expect(out.time).toEqual([T0 + 30_000]);
  });
});

describe('gap rendering — draw what arrived, stop where it ends', () => {
  /** getAlignedHistory windows on serverNowMs(), so pin "now" past the data. */
  const pinNow = (plotTime: any, tsMs: number) => plotTime.noteServerTimestamp(tsMs);

  it('a stalled series keeps its history and stops at its last sample', async () => {
    // The headline regression. A stalled stream used to be blanked ACROSS THE WHOLE
    // WINDOW, erasing measurements the rig really sent.
    const { dataCache, plotTime } = await freshModules();
    const cache = dataCache.getDataCache();
    for (let i = 0; i < 20; i++) cache.addDataPoint('stalled', 'c', i, T0 + i * 50);      // ends T0+950
    for (let i = 0; i < 200; i++) cache.addDataPoint('live', 'c', i, T0 + i * 50);        // ends T0+9950
    pinNow(plotTime, T0 + 9950);

    const out = cache.getAlignedHistory(['stalled', 'live'], ['c', 'c'], 60)!;
    const stalled = out.values[0];
    // Its real history survives ...
    expect(stalled.slice(0, 20).every((v) => Number.isFinite(v))).toBe(true);
    // ... and the line ends rather than coasting to the right edge.
    expect(Number.isNaN(stalled[stalled.length - 1])).toBe(true);
  });

  it('a mid-window dropout is a gap, not a flat line', async () => {
    const { dataCache, plotTime } = await freshModules();
    const cache = dataCache.getDataCache();
    for (let i = 0; i < 40; i++) cache.addDataPoint('e', 'c', 1, T0 + i * 50);            // ends T0+1950
    for (let i = 0; i < 40; i++) cache.addDataPoint('e', 'c', 2, T0 + 7000 + i * 50);     // 5 s hole
    pinNow(plotTime, T0 + 8950);

    const out = cache.getAlignedHistory(['e'], ['c'], 60)!;
    const v = out.values[0];
    expect(v.some((x) => Number.isNaN(x))).toBe(true);              // the hole is drawn as a hole
    expect(v.filter((x) => x === 1).length).toBeGreaterThan(0);     // both sides survive
    expect(v.filter((x) => x === 2).length).toBeGreaterThan(0);
  });

  it('a 10 Hz sensor is not gapped against a 75 Hz time base', async () => {
    // Guards MIN_HOLD_MS / GAP_FACTOR against being re-tightened: slow sensors are
    // normal here (actuators ~10 Hz, PTs ~75 Hz), not a fault.
    const { dataCache, plotTime } = await freshModules();
    const cache = dataCache.getDataCache();
    for (let i = 0; i < 300; i++) cache.addDataPoint('fast', 'c', i, T0 + i * 13);   // ~75 Hz
    for (let i = 0; i < 40; i++)  cache.addDataPoint('slow', 'c', i, T0 + i * 100);  // ~10 Hz
    pinNow(plotTime, T0 + 3900);

    const out = cache.getAlignedHistory(['fast', 'slow'], ['c', 'c'], 60)!;
    const slow = out.values[1];
    const upTo = out.time.findIndex((t) => t > T0 + 3900);
    const drawn = upTo === -1 ? slow : slow.slice(0, upTo);
    expect(drawn.some((x) => Number.isNaN(x))).toBe(false);
  });

  it('a min/max decimated stream is not gapped between its pairs', async () => {
    // The bimodality guard, and the test most likely to catch a later "just use the
    // median" simplification: the outbox emits both extremes of a window with their
    // ORIGINAL timestamps, so deltas alternate ~5 ms and ~500 ms.
    const { dataCache, plotTime } = await freshModules();
    const cache = dataCache.getDataCache();
    for (let w = 0; w < 20; w++) {
      cache.addDataPoint('dec', 'c', 10, T0 + w * 500);
      cache.addDataPoint('dec', 'c', 90, T0 + w * 500 + 5);
    }
    pinNow(plotTime, T0 + 9505);

    const out = cache.getAlignedHistory(['dec'], ['c'], 60)!;
    expect(out.values[0].some((x) => Number.isNaN(x))).toBe(false);
  });

  it('history is never erased just because delivery paused (the iPad case)', async () => {
    // 1.5 s of sample-time data arriving every 1.5 s: continuous in sample time, bursty
    // on the wire. The display must not blank between bursts.
    const { dataCache, plotTime } = await freshModules();
    const cache = dataCache.getDataCache();
    for (let i = 0; i < 300; i++) cache.addDataPoint('pt', 'c', i, T0 + i * 50);   // 15 s @20Hz
    pinNow(plotTime, T0 + 14950);

    const out = cache.getAlignedHistory(['pt'], ['c'], 60)!;
    const v = out.values[0];
    expect(v.every((x) => Number.isNaN(x))).toBe(false);
    expect(v.filter((x) => Number.isFinite(x)).length).toBe(v.length);
  });
});
