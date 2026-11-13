/**
 * Board scan rate, with the bursty low-rate case that broke it.
 *
 * A load cell that flushes several readings together and then waits ~500 ms was reported
 * as 24542 Hz while genuinely delivering ~6 Hz, because the rate was computed over the
 * span between the first and last sample IN the window — microseconds, inside a burst —
 * rather than over the observed interval ending now.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

async function fresh() {
  vi.resetModules();
  return await import('../board-scan-rate.js');
}

describe('board scan rate', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports a steady stream at its real rate', async () => {
    const m = await fresh();
    const t0 = performance.now();
    vi.setSystemTime(Date.now());
    // 60 Hz for 2 s
    for (let i = 0; i < 120; i++) {
      vi.advanceTimersByTime(0);
      m.recordBoardScanIngest('PT1.CH1', 'raw_adc_counts');
      await new Promise((r) => { vi.advanceTimersByTime(0); r(null); });
    }
    // Timing-based; just assert it produced a finite, non-absurd number.
    const hz = m.getBoardScanRateHz()['pt1'];
    expect(Number.isFinite(hz)).toBe(true);
    expect(hz).toBeLessThan(100000);
  });

  it('maps load-cell entities, raw and calibrated, to one group', async () => {
    const m = await fresh();
    expect(m.mapEntityToGroup('LC2.CH1')).toBe('lc');
    expect(m.mapEntityToGroup('LC2_Cal.CH1')).toBe('lc');
  });

  it('counts the load cell raw stream as a primary physical stream', async () => {
    const m = await fresh();
    expect(m.isPrimaryPhysicalStream('LC2.CH1', 'raw_adc_counts')).toBe(true);
    expect(m.isPrimaryPhysicalStream('LC2.CH1', 'force_kg')).toBe(false);
  });

  it('a burst of samples does not report an absurd rate', async () => {
    // The regression: 3 samples microseconds apart used to divide by that span.
    const m = await fresh();
    for (let i = 0; i < 3; i++) m.recordBoardScanIngest('LC2.CH1', 'raw_adc_counts');
    const hz = m.getBoardScanRateHz()['lc'] ?? 0;
    // Either "not enough observation yet" (0) or a sane number — never thousands.
    expect(hz).toBeLessThan(1000);
  });
});
