/**
 * The iPad case, end to end.
 *
 * Reported on the stand 2026-09-12: plots "light up for a second and then disappear" on a
 * throttled link, while the same page over a fast route is fine. The client was receiving
 * ~98% of its data — nothing was lost. The display was erasing it.
 *
 * Cause: the backend deliberately paces a throttled client to a lag target of
 * DEFAULT_TARGET_LAG_MS = 1500 (client-outbox.ts), delivering ~1.5 s bursts; the frontend
 * called a sensor stale after SENSOR_DATA_STALE_MS = 1500 and blanked it. Two packages,
 * the same number, one a target and the other a deadline, zero margin between them.
 *
 * These tests assert the two halves of the fix: plots keep real history regardless of
 * delivery cadence, and readouts get a staleness budget sized to the reported lag.
 */
import { describe, it, expect, vi } from 'vitest';

const listeners = new Map<string, ((p: unknown) => void)[]>();
vi.mock('@/lib/websocket', () => ({
  getWebSocketClient: () => ({
    on: (t: string, cb: (p: unknown) => void) => {
      const l = listeners.get(t) ?? [];
      l.push(cb);
      listeners.set(t, l);
      return () => {};
    },
    setHistoricalQueryProvider: () => {},
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
  const plotTime = await import('@/lib/plot-time');
  plotTime.resetPlotTimeForTests();
  const sensorRate = await import('@/lib/sensor-rate');
  sensorRate.resetSensorRateForTests();
  const dataCache = await import('@/lib/data-cache');
  return { plotTime, sensorRate, dataCache };
}

const T0 = 1_800_000_000_000;
/** What the backend does to a throttled client: 1.5 s of samples, once every 1.5 s. */
const BURST_MS = 1500;
const SAMPLE_MS = 50;   // 20 Hz after GUI downsampling

describe('a throttled client still sees its data', () => {
  it('plots keep every sample across burst delivery — never an empty series', async () => {
    const { dataCache, plotTime } = await freshModules();
    const cache = dataCache.getDataCache();

    // Ten bursts. Samples are continuous in SERVER time; only their arrival is chunky,
    // which is precisely the case the old whole-series blanking could not tell apart
    // from a dead sensor.
    let t = T0;
    for (let burst = 0; burst < 10; burst++) {
      for (let i = 0; i < BURST_MS / SAMPLE_MS; i++) {
        cache.addDataPoint('PT1_Cal.CH1', 'pressure_psi', 100 + i, t);
        t += SAMPLE_MS;
      }
      plotTime.noteServerTimestamp(t);   // the burst lands; "now" jumps forward
    }

    const out = cache.getAlignedHistory(['PT1_Cal.CH1'], ['pressure_psi'], 60);
    expect(out).not.toBeNull();
    const v = out!.values[0];
    // The regression: this used to be every element NaN.
    expect(v.every((x) => Number.isNaN(x))).toBe(false);
    expect(v.filter((x) => Number.isFinite(x)).length).toBe(v.length);
  });

  it('a burst gap does not blank history that already arrived', async () => {
    const { dataCache, plotTime } = await freshModules();
    const cache = dataCache.getDataCache();
    for (let i = 0; i < 60; i++) {
      cache.addDataPoint('pt', 'c', i, T0 + i * SAMPLE_MS);
    }
    // "now" runs 1.4 s past the newest sample — inside one burst period, which is normal
    // for a throttled client and used to erase the entire trace.
    plotTime.noteServerTimestamp(T0 + 60 * SAMPLE_MS + 1400);

    const out = cache.getAlignedHistory(['pt'], ['c'], 60)!;
    expect(out.values[0].some((x) => Number.isFinite(x))).toBe(true);
  });
});

describe('readout staleness is sized to the reported link lag', () => {
  it('without a lag report, the base window still applies', async () => {
    const { sensorRate } = await freshModules();
    expect(sensorRate.staleWindowMs()).toBe(sensorRate.SENSOR_DATA_STALE_MS);
  });

  it('a reported 1500 ms lag buys enough margin to survive a burst period', async () => {
    const { sensorRate } = await freshModules();
    sensorRate.setDeliveryLagAllowanceMs(1500);
    // 2x lag + 250 ms jitter. Must clear one full burst, or readouts dash between them.
    expect(sensorRate.staleWindowMs()).toBeGreaterThan(BURST_MS * 2);
  });

  it('keeps a readout alive across a burst period at the reported lag', async () => {
    const { sensorRate, plotTime } = await freshModules();
    sensorRate.setDeliveryLagAllowanceMs(1500);
    sensorRate.recordSensorUpdate('e', 'c', T0);
    plotTime.noteServerTimestamp(T0 + BURST_MS + 200);   // one burst late, plus jitter
    expect(sensorRate.isSensorKeyFresh('e.c')).toBe(true);
  });

  it('still goes stale eventually — the allowance is margin, not an off switch', async () => {
    const { sensorRate, plotTime } = await freshModules();
    sensorRate.setDeliveryLagAllowanceMs(1500);
    sensorRate.recordSensorUpdate('e', 'c', T0);
    plotTime.noteServerTimestamp(T0 + 20_000);
    expect(sensorRate.isSensorKeyFresh('e.c')).toBe(false);
  });

  it('caps a pathological lag report rather than disabling staleness', async () => {
    const { sensorRate } = await freshModules();
    sensorRate.setDeliveryLagAllowanceMs(10 * 60 * 1000);
    expect(sensorRate.staleWindowMs()).toBeLessThanOrEqual(sensorRate.SENSOR_DATA_STALE_MS + 5000);
  });

  it('ignores a missing or nonsense lag value', async () => {
    const { sensorRate } = await freshModules();
    sensorRate.setDeliveryLagAllowanceMs(undefined);
    expect(sensorRate.staleWindowMs()).toBe(sensorRate.SENSOR_DATA_STALE_MS);
    sensorRate.setDeliveryLagAllowanceMs(NaN);
    expect(sensorRate.staleWindowMs()).toBe(sensorRate.SENSOR_DATA_STALE_MS);
    sensorRate.setDeliveryLagAllowanceMs(-5000);
    expect(sensorRate.staleWindowMs()).toBe(sensorRate.SENSOR_DATA_STALE_MS);
  });
});
