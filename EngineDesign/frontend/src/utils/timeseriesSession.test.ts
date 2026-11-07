import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimeSeriesData, TimeSeriesSummary } from '../api/client';
import { loadTimeSeriesResults, saveTimeSeriesResults, saveTimeSeriesResultsUnlessOvertaken } from './timeseriesSession';

/**
 * The stored burn Forward and Flight read. Layer X's 'Send to Forward & Flight' stored its burn while the
 * Time-Series tab's auto-run of page load was still going, and the auto-run's save then overwrote it:
 * Flight flew the 578 psia Time-Series burn (101 points, 27.6 kN·s) under a menu that said 'Sent ✓'.
 */

const burn = (n: number) => ({ data: { time: new Array(n).fill(0) } as unknown as TimeSeriesData, summary: {} as TimeSeriesSummary });

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal('window', { dispatchEvent: () => true });
});

describe('the stored Time-Series burn', () => {
  it('an auto-run overtaken by a send keeps the sent burn', () => {
    const since = loadTimeSeriesResults()?.timestamp ?? null;            // the auto-run starts: nothing stored
    saveTimeSeriesResults(burn(78), 'fp', 'the Layer X burn Nov 2, 12:44 PM');   // Layer X sends meanwhile
    expect(saveTimeSeriesResultsUnlessOvertaken(burn(101), 'fp', since)).toBe(false);
    const kept = loadTimeSeriesResults();
    expect(kept?.data.time.length).toBe(78);
    expect(kept?.source).toBe('the Layer X burn Nov 2, 12:44 PM');
  });

  it('an auto-run nobody overtook stores, as before', () => {
    expect(saveTimeSeriesResultsUnlessOvertaken(burn(101), 'fp', null)).toBe(true);
    expect(loadTimeSeriesResults()?.data.time.length).toBe(101);
    expect(loadTimeSeriesResults()?.source).toBeUndefined();
  });
});
