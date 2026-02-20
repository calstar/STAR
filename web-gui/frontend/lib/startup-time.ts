/**
 * Global mission T+0 time — shared across all windows via localStorage.
 * Every TimeSeriesPlot uses this as the reference so the X-axis shows
 * continuous elapsed time since system startup, not since the window opened.
 */

const LS_KEY = 'diablo_daq_startup_ms';

/** Get or create the global startup timestamp (ms since epoch). */
export function getStartupTime(): number {
  if (typeof window === 'undefined') return Date.now();

  const stored = localStorage.getItem(LS_KEY);
  if (stored) {
    const t = parseInt(stored, 10);
    if (!isNaN(t) && t > 0) return t;
  }
  // First window — set it now
  const now = Date.now();
  localStorage.setItem(LS_KEY, String(now));
  return now;
}

/** Reset mission T+0 (e.g. when user manually resets). */
export function resetStartupTime(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LS_KEY, String(Date.now()));
}

/** Elapsed seconds since T+0 */
export function elapsedSeconds(): number {
  return (Date.now() - getStartupTime()) / 1000;
}


