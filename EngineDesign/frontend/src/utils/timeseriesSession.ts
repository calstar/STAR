import type { TimeSeriesData, TimeSeriesSummary } from '../api/client';

export const TIMESERIES_RESULTS_KEY = 'timeseries_results';
export const TIMESERIES_UPDATED_EVENT = 'star:timeseries-updated';
/** Ask the Time-Series tab to run the burn it is set up for (Flight, when it has none to fly). */
export const TIMESERIES_RUN_EVENT = 'star:timeseries-run';
/** The Time-Series tab's answer when that run failed; `detail` is the message. */
export const TIMESERIES_RUN_FAILED_EVENT = 'star:timeseries-run-failed';

export function requestTimeSeriesRun(): void {
  window.dispatchEvent(new CustomEvent(TIMESERIES_RUN_EVENT));
}

export interface StoredTimeSeriesResults {
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
  timestamp: number;
  /** lib/engineIdentity.configFingerprint of the design the run was made on. */
  configFingerprint?: string;
}

export function saveTimeSeriesResults(results: {
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
}, configFingerprint?: string): void {
  const stored: StoredTimeSeriesResults = {
    ...results,
    timestamp: Date.now(),
    configFingerprint,
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
