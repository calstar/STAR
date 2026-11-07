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
  /** Who made it, in words, when not the Time-Series tab: "Layer X burn Nov 2, 12:44 PM". */
  source?: string;
}

export function saveTimeSeriesResults(results: {
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
}, configFingerprint?: string, source?: string): void {
  const stored: StoredTimeSeriesResults = {
    ...results,
    timestamp: Date.now(),
    configFingerprint,
    ...(source ? { source } : {}),
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

/**
 * Store a run the Time-Series tab made by itself, unless the stored burn changed since it started (`since`:
 * the stored timestamp then, or null for none). Layer X's 'Send to Forward & Flight' stored its burn while
 * the auto-run of page load was still going; the auto-run then overwrote it and Flight flew the 578 psia
 * Time-Series burn under a menu that said 'Sent'. Returns whether it stored.
 */
export function saveTimeSeriesResultsUnlessOvertaken(results: { data: TimeSeriesData; summary: TimeSeriesSummary },
                                                      configFingerprint: string | undefined, since: number | null): boolean {
  if ((loadTimeSeriesResults()?.timestamp ?? null) !== since) return false;
  saveTimeSeriesResults(results, configFingerprint);
  return true;
}

export function loadTimeSeriesData(): TimeSeriesData | null {
  return loadTimeSeriesResults()?.data ?? null;
}

export function loadTimeSeriesSummary(): TimeSeriesSummary | null {
  return loadTimeSeriesResults()?.summary ?? null;
}
