/**
 * The plot time base is the union of every series' samples, so a stored sample draws the
 * same in every frame no matter which series happens to be freshest.
 *
 * 2026-11-07: with all PTs on the Pressure History plot, the base was "the freshest series",
 * which changes nearly every 25 ms frame. An HPD-PT spike replayed from the live stream drew
 * at 1250 psi in some frames and at its decayed neighbour (703, 527) in others — the plot
 * flickered while the cache never changed. Shapes below are the measured ones: a channel at
 * 0 psi emitting one point per 100 ms envelope window, and the spike as a window's max at
 * its start with the decayed min ~50 ms later.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/websocket', () => ({
  getWebSocketClient: () => ({
    on: () => () => {},
    setHistoricalQueryProvider: () => {},
    onConnectionStatus: () => () => {},
    isConnected: () => true,
    connect: () => {},
    send: () => {},
  }),
  getApiBaseUrl: () => 'http://localhost:8081',
}));

const T0 = 1_800_000_000_000;
const SPIKE_T = T0 + 1040;

async function freshCache() {
  vi.resetModules();
  const plotTime = await import('@/lib/plot-time');
  plotTime.resetPlotTimeForTests();
  const { getDataCache } = await import('@/lib/data-cache');
  return getDataCache();
}

/** COPV-like: flat 0 psi, one point every 100 ms on the 00 ms phase, through `endMs`. */
function feedFlat(cache: Awaited<ReturnType<typeof freshCache>>, endMs: number) {
  for (let t = 0; t <= endMs; t += 100) cache.addDataPoint('COPV', 'pressure_psi', 0, T0 + t);
}

/** HPD-like: 0 psi on the 40 ms phase, with the spike window at 1040 (max) / 1090 (min). */
function feedHpd(cache: Awaited<ReturnType<typeof freshCache>>, endMs: number) {
  for (let t = 40; t <= endMs; t += 100) {
    if (t === 1040) {
      cache.addDataPoint('HPD', 'pressure_psi', 1250, T0 + 1040);
      cache.addDataPoint('HPD', 'pressure_psi', 703, T0 + 1090);
    } else {
      cache.addDataPoint('HPD', 'pressure_psi', 0, T0 + t);
    }
  }
}

function drawnPeak(h: { time: number[]; values: number[][] }, series: number): number {
  let m = -Infinity;
  for (let i = 0; i < h.time.length; i++) {
    const v = h.values[series][i];
    if (h.time[i] >= SPIKE_T - 50 && h.time[i] <= SPIKE_T + 200 && v > m) m = v;
  }
  return m;
}

describe('plot time base', () => {
  it('draws a stored spike at its true height whichever series is freshest', async () => {
    const ents = ['COPV', 'HPD'];
    const comps = ['pressure_psi', 'pressure_psi'];

    // Frame 1: COPV is freshest (its last sample, 3000, is newer than HPD's 2940).
    const a = await freshCache();
    feedHpd(a, 2940);
    feedFlat(a, 3000);
    const frame1 = a.getAlignedHistory(ents, comps, 600)!;

    // Frame 2: the same history, then HPD's next window closes and HPD is freshest.
    const b = await freshCache();
    feedFlat(b, 3000);
    feedHpd(b, 3040);
    const frame2 = b.getAlignedHistory(ents, comps, 600)!;

    expect(drawnPeak(frame1, 1)).toBe(1250);
    expect(drawnPeak(frame2, 1)).toBe(1250);
  });

  it('puts every series\' own samples on the grid', async () => {
    const c = await freshCache();
    feedHpd(c, 2940);
    feedFlat(c, 3000);
    const h = c.getAlignedHistory(['COPV', 'HPD'], ['pressure_psi', 'pressure_psi'], 600)!;
    const grid = new Set(h.time);
    for (const t of [0, 100, 1000, 3000]) expect(grid.has(T0 + t)).toBe(true);
    for (const t of [40, 1040, 1090, 2940]) expect(grid.has(T0 + t)).toBe(true);
    // ascending, no duplicates
    for (let i = 1; i < h.time.length; i++) expect(h.time[i]).toBeGreaterThan(h.time[i - 1]);
  });

  // ── Dense plots: the full pressure plot at 60 s / 5 min takes the fixed-bucket path ──

  /** Ten PT-like series at 20 pts/s (two envelope points per 100 ms window) through `endMs`,
   *  each on its own phase; HPD carries the measured spike window. */
  function feedPressurePlot(cache: Awaited<ReturnType<typeof freshCache>>, endMs: number, hpdEndMs = endMs) {
    for (let t = 0; t <= endMs; t += 100) {
      for (let s = 0; s < 9; s++) {
        const p = t + s * 9;
        cache.addDataPoint(`PT${s}`, 'pressure_psi', 500 + s, T0 + p);
        cache.addDataPoint(`PT${s}`, 'pressure_psi', 501 + s, T0 + p + 47);
      }
      const h = t + 40;
      if (h > hpdEndMs) continue;
      if (h === 1040) {
        cache.addDataPoint('HPD', 'pressure_psi', 1250, T0 + 1040);
        cache.addDataPoint('HPD', 'pressure_psi', 703, T0 + 1090);
      } else {
        cache.addDataPoint('HPD', 'pressure_psi', 0, T0 + h);
      }
    }
  }
  const DENSE = [...Array.from({ length: 9 }, (_, s) => `PT${s}`), 'HPD'];
  const DENSE_COMPS = DENSE.map(() => 'pressure_psi');

  it('dense plot: keeps the spike, bounds the grid, and settled history never changes', async () => {
    const c = await freshCache();
    feedPressurePlot(c, 30_000);
    const f1 = c.getAlignedHistory(DENSE, DENSE_COMPS, 60)!;
    // the next frame: more data at the right edge, a different series now freshest
    c.addDataPoint('HPD', 'pressure_psi', 0, T0 + 30_140);
    c.addDataPoint('PT3', 'pressure_psi', 503, T0 + 30_127);
    const f2 = c.getAlignedHistory(DENSE, DENSE_COMPS, 60)!;

    expect(f1.time.length).toBeLessThanOrEqual(3002);
    expect(drawnPeak(f1, 9)).toBe(1250);
    expect(drawnPeak(f2, 9)).toBe(1250);

    // Every bucket that had closed in frame 1 draws identically in frame 2.
    const settled = T0 + 29_000;
    const at2 = new Map(f2.time.map((t, i) => [t, i]));
    let compared = 0;
    for (let i = 0; i < f1.time.length && f1.time[i] < settled; i++) {
      const k = at2.get(f1.time[i]);
      expect(k).toBeDefined();
      for (let s = 0; s < DENSE.length; s++) expect(Object.is(f2.values[s][k!], f1.values[s][i])).toBe(true);
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('dense plot: a series that stops breaks after its hold, and a live one never dashes', async () => {
    const c = await freshCache();
    feedPressurePlot(c, 30_000, 10_000);   // HPD goes silent at 10 s
    const h = c.getAlignedHistory(DENSE, DENSE_COMPS, 60)!;
    const hpd = h.values[9], live = h.values[0];
    const after = h.time.findIndex((t) => t > T0 + 12_000);
    expect(after).toBeGreaterThan(0);
    expect(hpd.slice(after).every((v) => Number.isNaN(v))).toBe(true);
    // a live series has no hole anywhere between its first and last sample
    const first = h.time.findIndex((t) => t >= T0 + 100);
    expect(live.slice(first).some((v) => Number.isNaN(v))).toBe(false);
  });
});

