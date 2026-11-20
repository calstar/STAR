/**
 * A slow sensor's readout must not blank between its own samples.
 *
 * Reported on the stand 2026-11-09: the LOX / Fuel Scale readouts (and their live values in
 * the calibration menu) kept blacking out "as if connection was lost". The LC boards run
 * SINC4 at 20 SPS, which is ~1.2 Hz per scale and ~0.76 Hz per thrust load cell, and every
 * readout blanked 1.5 s after its newest sample. The staleness window is now stretched to
 * two of the channel's own sample periods; a fast channel keeps the old window exactly.
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

async function freshModules() {
  vi.resetModules();
  const plotTime = await import('@/lib/plot-time');
  plotTime.resetPlotTimeForTests();
  const sensorRate = await import('@/lib/sensor-rate');
  sensorRate.resetSensorRateForTests();
  return { plotTime, sensorRate };
}

const T0 = 1_800_000_000_000;

/** Feed `n` samples `periodMs` apart; return the newest sample's time. */
function feed(rate: typeof import('@/lib/sensor-rate'), key: [string, string], n: number, periodMs: number) {
  let t = T0;
  for (let i = 0; i < n; i++, t += periodMs) rate.recordSensorUpdate(key[0], key[1], t);
  return t - periodMs;
}

describe('slow sensor readouts', () => {
  for (const periodMs of [830, 1300]) {
    it(`a ${periodMs} ms load cell stays live until its next sample is due`, async () => {
      const { sensorRate, plotTime } = await freshModules();
      const last = feed(sensorRate, ['LC2_Cal.CH1', 'force_kg'], 8, periodMs);

      // Just before the next sample would arrive, plus some jitter: still live.
      plotTime.noteServerTimestamp(last + periodMs + 200);
      expect(sensorRate.isSensorKeyFresh('LC2_Cal.CH1.force_kg')).toBe(true);

      // Three periods with nothing: the sensor really has stopped.
      plotTime.noteServerTimestamp(last + 3 * periodMs);
      expect(sensorRate.isSensorKeyFresh('LC2_Cal.CH1.force_kg')).toBe(false);
    });
  }

  it('a fast PT keeps exactly the shared window', async () => {
    const { sensorRate, plotTime } = await freshModules();
    const last = feed(sensorRate, ['PT1_Cal.CH1', 'pressure_psi'], 8, 15);
    expect(sensorRate.staleWindowMsFor('PT1_Cal.CH1.pressure_psi')).toBe(sensorRate.staleWindowMs());
    plotTime.noteServerTimestamp(last + sensorRate.SENSOR_DATA_STALE_MS + 1);
    expect(sensorRate.isSensorKeyFresh('PT1_Cal.CH1.pressure_psi')).toBe(false);
  });

  it('bounds the stretch so a barely-alive channel cannot hold a number forever', async () => {
    const { sensorRate } = await freshModules();
    feed(sensorRate, ['LC1_Cal.CH1', 'force_kg'], 8, 60_000);
    expect(sensorRate.staleWindowMsFor('LC1_Cal.CH1.force_kg')).toBeLessThanOrEqual(
      sensorRate.staleWindowMs() + 8000,
    );
  });

  it('a burst of identical stamps does not shrink the period to zero', async () => {
    // Old firmware + the server's batch clamp: 9 samples land on one stamp every ~7 s.
    const { sensorRate } = await freshModules();
    for (let b = 0; b < 3; b++) {
      for (let i = 0; i < 9; i++) sensorRate.recordSensorUpdate('LC2.CH1', 'raw_adc_counts', T0 + b * 7400);
    }
    expect(sensorRate.samplePeriodMs('LC2.CH1.raw_adc_counts')).toBeCloseTo(7400, -1);
  });
});
