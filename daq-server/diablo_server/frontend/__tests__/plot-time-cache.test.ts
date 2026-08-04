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
  const sensorRate = await import('@/lib/sensor-rate');
  // getAlignedHistory masks stale streams as NaN; mark streams fresh the same
  // way the live path does (store.updateSensor → recordSensorUpdate).
  const markFresh = (entity: string, component: string) =>
    sensorRate.recordSensorUpdate(entity, component);
  return { plotTime, dataCache, markFresh };
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
    const { dataCache, markFresh } = await freshModules();
    const cache = dataCache.getDataCache();
    markFresh('PT1_Cal.CH1', 'pressure_psi');
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
    const { dataCache, markFresh } = await freshModules();
    const cache = dataCache.getDataCache();
    markFresh('e', 'c');
    cache.addDataPoint('e', 'c', 1, T0 + 100);
    cache.addDataPoint('e', 'c', 2, T0 + 50);   // older → dropped
    cache.addDataPoint('e', 'c', 3, T0 + 100);  // same instant → overwrite
    const out = cache.getAlignedHistory(['e'], ['c'], 60)!;
    expect(out.time).toEqual([T0 + 100]);
    expect(out.values[0]).toEqual([3]);
  });

  it('HISTORICAL_DATA merges by timestamp — never wipes live data (the reset bug)', async () => {
    const { dataCache, markFresh } = await freshModules();
    const cache = dataCache.getDataCache();
    markFresh('e', 'c');
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
