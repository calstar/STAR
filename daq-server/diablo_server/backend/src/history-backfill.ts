/**
 * Historical backfill: how a connecting client's plot history goes on the wire.
 *
 * Extracted from server.ts so it can be driven by a real socket in tests. Every rule
 * below was learned from a live failure on the stand (2026-09-12, an iPad on site
 * Wi-Fi), and each one is pinned by a test in __tests__/history-backfill.test.ts.
 *
 *  1. SLICE IT. A full dump is MAX_SEND_POINTS *per series*: 177 sensors put ~15 MB
 *     into one ws.send(). ClientOutbox.shouldFlush() only flushes when bufferedAmount
 *     is under SOCKET_IDLE_BYTES, and a socket holding megabytes never returns there —
 *     so the client got its handshake and then not one live sample, permanently. The
 *     keepalive ping queued behind the same bytes, so the reaper killed it and the
 *     reconnect replayed the whole thing.
 *
 *  2. SLICE ON TIME, NOT ON KEYS. getAlignedHistory() takes its time base from "the
 *     first series with data in the window" and NaN-fills the rest, so a plot whose
 *     series arrive in different chunks flips base and blanks until the last one lands.
 *     Every slice carries EVERY key, so a plot's series set is always consistent.
 *
 *  3. SEND OLDEST FIRST. DataCache.mergeSeries() is append-only: it keeps only points
 *     strictly newer than the newest it already holds and silently drops the rest. A
 *     newest-first order therefore delivers slice 1 and throws away everything behind
 *     it. Oldest-first is the only order that cache accepts.
 *
 *  4. WAIT FOR THE SOCKET BETWEEN SLICES, so live data and the keepalive ping interleave
 *     instead of queueing behind the backfill.
 *
 *  5. CAP THE CONNECT HORIZON. A plot shows a scrolling window; anything older than that
 *     is still arriving after it has scrolled off the left edge. Explicit queries are
 *     uncapped — the caller named a range and is not the connect path.
 */

export interface HistorySeries {
  time: number[];
  values: number[];
}
export type HistoryPayload = Record<string, HistorySeries>;

/** Slice widths from "now" backwards. The newest slice is smallest so the visible
 *  window paints first; older slices are off-screen detail and can be coarser. */
export const HISTORY_SLICE_WIDTHS_MS = [8_000, 16_000, 36_000];
/** How far back a connect backfill reaches. Must comfortably exceed the default plot
 *  window (60 s) or plots start out short. */
export const HISTORY_CONNECT_SPAN_MS = 60_000;
export const HISTORY_MAX_SLICES = 40;
export const HISTORY_DRAIN_TIMEOUT_MS = 30_000;

/** Newest and oldest timestamp across every series. */
export function payloadBounds(p: HistoryPayload): { tMin: number; tMax: number } | null {
  let tMax = -Infinity;
  let tMin = Infinity;
  for (const k of Object.keys(p)) {
    const t = p[k]?.time;
    if (!t?.length) continue;
    if (t[t.length - 1] > tMax) tMax = t[t.length - 1];
    if (t[0] < tMin) tMin = t[0];
  }
  return Number.isFinite(tMax) && Number.isFinite(tMin) ? { tMin, tMax } : null;
}

/**
 * The [lo, hi) ranges to send, **oldest first**.
 *
 * Ranges are computed newest-first so the widths ramp away from "now" and the horizon is
 * measured from it, then reversed for sending (rule 3).
 */
export function planBackfillSlices(
  p: HistoryPayload,
  opts: { capped: boolean; connectSpanMs?: number; widthsMs?: number[]; maxSlices?: number } ,
): Array<[number, number]> {
  const bounds = payloadBounds(p);
  if (!bounds) return [];
  const { tMin, tMax } = bounds;
  const widths = opts.widthsMs ?? HISTORY_SLICE_WIDTHS_MS;
  const maxSlices = opts.maxSlices ?? HISTORY_MAX_SLICES;
  const horizon = opts.capped ? tMax - (opts.connectSpanMs ?? HISTORY_CONNECT_SPAN_MS) : -Infinity;

  const ranges: Array<[number, number]> = [];
  let cursor = tMax;
  for (let i = 0; i < maxSlices; i++) {
    const width = widths[Math.min(i, widths.length - 1)];
    if (cursor <= tMin || cursor <= horizon) break;
    ranges.push([cursor - width, cursor]);
    cursor -= width;
  }
  // Ranges are half-open [lo, hi), so the newest sample — the one sitting exactly at
  // tMax — would fall outside every slice and never be sent. Nudge the newest range's
  // end past it. One point per series, which is precisely the live edge of the plot.
  if (ranges.length > 0) ranges[0][1] = tMax + 1;
  ranges.reverse();
  return ranges;
}

/** Every series' points falling in [lo, hi). Keys with nothing in range are omitted. */
export function sliceOf(p: HistoryPayload, lo: number, hi: number): HistoryPayload {
  const chunk: HistoryPayload = {};
  for (const k of Object.keys(p)) {
    const s = p[k];
    const t = s?.time;
    if (!t?.length) continue;
    // time is ascending
    let a = 0;
    while (a < t.length && t[a] < lo) a++;
    let b = a;
    while (b < t.length && t[b] < hi) b++;
    if (b > a) chunk[k] = { time: t.slice(a, b), values: s.values.slice(a, b) };
  }
  return chunk;
}

/** Minimal view of the socket, so tests can drive a real ws or a fake one. */
export interface DrainableSocket {
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
}

/** Resolve once the socket has drained to idle. False = gave up (closed, or still
 *  backed up after timeoutMs), which abandons the rest of the backfill on purpose:
 *  partial history plus live data beats complete history and a dead feed. */
export async function waitForSocketDrain(
  ws: DrainableSocket,
  idleBytes: number,
  timeoutMs = HISTORY_DRAIN_TIMEOUT_MS,
  pollMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ws.bufferedAmount >= idleBytes) {
    if (!ws.isOpen) return false;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}

export interface BackfillDeps {
  socket: DrainableSocket;
  /** Put one HISTORICAL_DATA slice on the wire. */
  sendSlice: (chunk: HistoryPayload) => void;
  idleBytes: number;
  drainTimeoutMs?: number;
  pollMs?: number;
  onStopped?: (sentSlices: number, totalSlices: number) => void;
}

/**
 * Send `payload` as time slices, oldest first, pausing for the socket between each.
 * Returns the number of slices actually sent.
 */
export async function sendBackfill(
  payload: HistoryPayload,
  capped: boolean,
  deps: BackfillDeps,
): Promise<number> {
  const ranges = planBackfillSlices(payload, { capped });
  let sent = 0;
  for (const [lo, hi] of ranges) {
    if (!deps.socket.isOpen) return sent;
    // The FIRST slice goes out unconditionally. Waiting for idle before it starves the
    // client completely on a busy socket: live data keeps bufferedAmount above idleBytes
    // more or less permanently, so the backfill gives up having sent nothing and the
    // operator sees an empty plot forever ("stopped after 0/19 slices" on the stand).
    // Sending one slice was never the problem — sending ALL of it in one go was. From the
    // second slice on, yield to the socket so live data and the ping interleave.
    if (sent > 0 && !(await waitForSocketDrain(
      deps.socket, deps.idleBytes, deps.drainTimeoutMs, deps.pollMs))) {
      deps.onStopped?.(sent, ranges.length);
      return sent;
    }
    const chunk = sliceOf(payload, lo, hi);
    if (Object.keys(chunk).length === 0) continue;
    deps.sendSlice(chunk);
    sent++;
  }
  return sent;
}
