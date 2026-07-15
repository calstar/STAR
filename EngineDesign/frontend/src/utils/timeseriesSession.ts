import type { TimeSeriesData, TimeSeriesSummary } from '../api/client';

export const TIMESERIES_RESULTS_KEY = 'timeseries_results';
export const TIMESERIES_UPDATED_EVENT = 'star:timeseries-updated';

export interface StoredTimeSeriesResults {
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
  timestamp: number;
}

export function saveTimeSeriesResults(results: {
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
}): void {
  const stored: StoredTimeSeriesResults = {
    ...results,
    timestamp: Date.now(),
  };
  sessionStorage.setItem(TIMESERIES_RESULTS_KEY, JSON.stringify(stored));
  window.dispatchEvent(new CustomEvent(TIMESERIES_UPDATED_EVENT, { detail: stored }));
}

export function loadTimeSeriesResults(): StoredTimeSeriesResults | null {
  try {
    const raw = sessionStorage.getItem(TIMESERIES_RESULTS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredTimeSeriesResults;
  } catch {
    return null;
  }
}

export function loadTimeSeriesData(): TimeSeriesData | null {
  return loadTimeSeriesResults()?.data ?? null;
}

export function loadTimeSeriesSummary(): TimeSeriesSummary | null {
  return loadTimeSeriesResults()?.summary ?? null;
}
