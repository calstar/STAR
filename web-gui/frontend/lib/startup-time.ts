/**
 * Global mission T+0 time — from backend's first packet timestamp.
 * Every TimeSeriesPlot uses this as the reference so the X-axis shows
 * continuous elapsed time since first data packet, not since the window opened.
 * 
 * Priority: Backend missionStartTime > localStorage fallback > current time
 */

const LS_KEY = 'diablo_daq_startup_ms';

/** Get the global startup timestamp (ms since epoch) from backend or fallback. */
export function getStartupTime(): number {
  if (typeof window === 'undefined') return Date.now();

  // Try to get from Zustand store (backend's mission start time)
  try {
    // Dynamic import to avoid circular dependency
    const { useSensorStore } = require('./store');
    const missionStartTime = useSensorStore.getState().missionStartTime;
    if (missionStartTime !== null && missionStartTime > 0) {
      return missionStartTime;
    }
  } catch (e) {
    // Store not available yet, fall back to localStorage
  }

  // Fallback to localStorage (for backwards compatibility or before backend sends time)
  const stored = localStorage.getItem(LS_KEY);
  if (stored) {
    const t = parseInt(stored, 10);
    if (!isNaN(t) && t > 0) return t;
  }
  
  // Last resort: current time (shouldn't happen if backend is working)
  return Date.now();
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




