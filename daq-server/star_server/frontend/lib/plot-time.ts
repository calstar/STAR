/**
 * Plot time base — ONE clock for all plotting.
 *
 * Every data point carries a server timestamp (epoch ms, stamped upstream and
 * delivered in SENSOR_UPDATE / HISTORICAL_DATA). Plots window on that
 * timeline. The only derived quantity is "now": the freshest server timestamp
 * seen, advanced by the local monotonic clock between messages. No wall-clock
 * sync, no EMA offset, no startup anchor — a jump in any local clock can no
 * longer orphan cached data (the root cause of the old "plots reset until
 * refresh" bug).
 */

let maxSeenTsMs = 0;
let perfAtMaxSeen = 0;
let minSeenTsMs = 0;

const perfNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** Record a server timestamp (called by the WS client for every message). */
export function noteServerTimestamp(tsMs: number): void {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return;
  if (tsMs > maxSeenTsMs) {
    maxSeenTsMs = tsMs;
    perfAtMaxSeen = perfNow();
  }
  if (minSeenTsMs === 0 || tsMs < minSeenTsMs) minSeenTsMs = tsMs;
}

/** "Now" on the server timeline (epoch ms): freshest server timestamp plus
 *  local monotonic elapsed since it arrived. Before any message arrives,
 *  falls back to the local clock (plots are empty then anyway). */
export function serverNowMs(): number {
  if (maxSeenTsMs === 0) return Date.now();
  return maxSeenTsMs + (perfNow() - perfAtMaxSeen);
}

/** Earliest server timestamp seen this session — T+ axis fallback when the
 *  backend hasn't sent MISSION_START_TIME yet. */
export function firstSeenServerTsMs(): number | null {
  return minSeenTsMs > 0 ? minSeenTsMs : null;
}

/** Newest server timestamp seen (for QUERY_HISTORICAL sinceMs backfills). */
export function newestServerTsMs(): number | null {
  return maxSeenTsMs > 0 ? maxSeenTsMs : null;
}

/** Test helper. */
export function resetPlotTimeForTests(): void {
  maxSeenTsMs = 0;
  perfAtMaxSeen = 0;
  minSeenTsMs = 0;
}
