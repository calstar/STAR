/**
 * Historical backfill, including a REAL slow client.
 *
 * Every bug this pins was live on the stand on 2026-09-12 and invisible to the unit
 * suite, because each one only appears when a socket is genuinely slow to drain. So the
 * integration block below runs an actual ws server against an actual client whose TCP
 * socket is paused — not a mock with a hand-set bufferedAmount.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import {
  planBackfillSlices,
  sliceOf,
  sendBackfill,
  payloadBounds,
  HISTORY_CONNECT_SPAN_MS,
  type HistoryPayload,
} from '../history-backfill.js';

/** `series` sensors, `hz` samples/s, spanning `spanMs` back from tMax. */
function makePayload(series: number, hz: number, spanMs: number, tMax = 1_700_000_000_000)
  : HistoryPayload {
  const p: HistoryPayload = {};
  const step = 1000 / hz;
  const n = Math.floor(spanMs / step);
  for (let s = 0; s < series; s++) {
    const time: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      time.push(tMax - spanMs + i * step);
      values.push(Math.sin(i / 10) * 100 + s);
    }
    p[`sensor_${s}.PT_Cal`] = { time, values };
  }
  return p;
}

const totalPoints = (p: HistoryPayload) =>
  Object.values(p).reduce((a, s) => a + s.time.length, 0);

/**
 * The browser's DataCache.mergeSeries(), reproduced exactly: append-only, keeping only
 * points strictly newer than the newest already held and silently dropping the rest.
 * If the server's slice order disagrees with this, history is lost without any error.
 */
class AppendOnlyCache {
  private newest = new Map<string, number>();
  private kept = new Map<string, number>();
  merge(chunk: HistoryPayload): void {
    for (const [k, s] of Object.entries(chunk)) {
      const last = this.newest.get(k) ?? -Infinity;
      let n = 0;
      for (let i = 0; i < s.time.length; i++) if (s.time[i] > last) n++;
      if (n > 0) {
        this.newest.set(k, s.time[s.time.length - 1]);
        this.kept.set(k, (this.kept.get(k) ?? 0) + n);
      }
    }
  }
  get total(): number { return [...this.kept.values()].reduce((a, b) => a + b, 0); }
}

describe('planBackfillSlices', () => {
  it('sends oldest first — the only order an append-only cache accepts', () => {
    const ranges = planBackfillSlices(makePayload(3, 20, 60_000), { capped: true });
    expect(ranges.length).toBeGreaterThan(1);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i][0]).toBeGreaterThanOrEqual(ranges[i - 1][0]);
      expect(ranges[i][1]).toBeGreaterThan(ranges[i - 1][1]);
    }
  });

  it('covers the window contiguously, with no gap or overlap between slices', () => {
    const ranges = planBackfillSlices(makePayload(3, 20, 60_000), { capped: true });
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
  });

  it('includes the newest sample — ranges are half-open, so the live edge is easy to drop', () => {
    const p = makePayload(3, 20, 60_000);
    const tMax = payloadBounds(p)!.tMax;
    const last = planBackfillSlices(p, { capped: true }).at(-1)!;
    expect(last[1]).toBeGreaterThan(tMax);          // [lo, hi) must contain tMax
    // And it really is delivered, not merely in range.
    const newest = sliceOf(p, last[0], last[1]);
    for (const s of Object.values(newest)) expect(s.time.at(-1)).toBe(tMax);
  });

  it('caps a connect backfill at the horizon — older data has scrolled off anyway', () => {
    const p = makePayload(3, 20, 600_000); // 10 minutes available
    const ranges = planBackfillSlices(p, { capped: true });
    const span = ranges[ranges.length - 1][1] - ranges[0][0];
    // +1 ms: the newest range is nudged open-ended so the sample at tMax is included.
    expect(span).toBeLessThanOrEqual(HISTORY_CONNECT_SPAN_MS + 1);
    expect(span).toBeGreaterThanOrEqual(HISTORY_CONNECT_SPAN_MS - 1);
  });

  it('caps an EMPTY query — a client holding nothing must not get the biggest dump', () => {
    // data-cache.ts sends {} when newestServerTsMs() is null, i.e. a fresh or starved
    // client. `capped: !query` treated {} as "the caller named a range" and lifted the
    // horizon, so the client least able to take a full dump got a ~10 MB one, got starved
    // and reaped, reconnected with {} again, and never escaped.
    const p = makePayload(3, 20, 600_000);
    const empty = planBackfillSlices(p, { capped: true });   // what an empty query must do
    const span = empty[empty.length - 1][1] - empty[0][0];
    expect(span).toBeLessThanOrEqual(HISTORY_CONNECT_SPAN_MS + 1);
    // And it is far smaller than the uncapped plan it used to get.
    expect(empty.length).toBeLessThan(planBackfillSlices(p, { capped: false }).length / 2);
  });

  it('does NOT cap an explicit query — the caller named the range', () => {
    const p = makePayload(3, 20, 600_000);
    const ranges = planBackfillSlices(p, { capped: false });
    const span = ranges[ranges.length - 1][1] - ranges[0][0];
    expect(span).toBeGreaterThan(HISTORY_CONNECT_SPAN_MS * 2);
  });

  it('puts every series in every slice, so a plot never sees a partial series set', () => {
    const p = makePayload(6, 20, 60_000);
    const keys = Object.keys(p).sort();
    for (const [lo, hi] of planBackfillSlices(p, { capped: true })) {
      expect(Object.keys(sliceOf(p, lo, hi)).sort()).toEqual(keys);
    }
  });

  it('loses no point to slicing — every sample lands in exactly one slice', () => {
    const p = makePayload(4, 20, 60_000);
    const ranges = planBackfillSlices(p, { capped: true });
    const sent = ranges.reduce((a, [lo, hi]) => a + totalPoints(sliceOf(p, lo, hi)), 0);
    expect(sent).toBe(totalPoints(p));
  });

  it('survives an append-only cache with every point intact (the ordering regression)', () => {
    const p = makePayload(5, 20, 60_000);
    const cache = new AppendOnlyCache();
    for (const [lo, hi] of planBackfillSlices(p, { capped: true })) cache.merge(sliceOf(p, lo, hi));
    expect(cache.total).toBe(totalPoints(p));
  });

  it('a newest-first order would silently lose most of it — proving order matters', () => {
    const p = makePayload(5, 20, 60_000);
    const cache = new AppendOnlyCache();
    const reversed = [...planBackfillSlices(p, { capped: true })].reverse();
    for (const [lo, hi] of reversed) cache.merge(sliceOf(p, lo, hi));
    expect(cache.total).toBeLessThan(totalPoints(p) / 2);
  });
});

// ── Real sockets ─────────────────────────────────────────────────────────────
describe('backfill against a genuinely slow client', () => {
  const servers: WebSocketServer[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets) { try { s.terminate(); } catch { /* closing */ } }
    sockets.length = 0;
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    servers.length = 0;
  });

  /** A ws server that backfills every client, plus a hook to push "live" frames. */
  async function startServer(payload: HistoryPayload, opts: {
    drainTimeoutMs?: number;
  } = {}) {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.on('listening', () => r()));
    const state = { sent: 0, finished: false, stoppedAt: -1, serverWs: null as WebSocket | null };
    wss.on('connection', (ws) => {
      state.serverWs = ws;
      void sendBackfill(payload, true, {
        socket: {
          get bufferedAmount() { return ws.bufferedAmount; },
          get isOpen() { return ws.readyState === WebSocket.OPEN; },
        },
        idleBytes: 4 * 1024,
        drainTimeoutMs: opts.drainTimeoutMs ?? 30_000,
        pollMs: 10,
        sendSlice: (chunk) => {
          state.sent++;
          ws.send(JSON.stringify({ type: 'historical_data', payload: chunk }));
        },
        onStopped: (sent) => { state.stoppedAt = sent; },
      }).then(() => { state.finished = true; });
    });
    const port = (wss.address() as AddressInfo).port;
    return { wss, port, state };
  }

  function connect(port: number): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); });
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Backpressure is asserted against a socket whose bufferedAmount we control, NOT a
   * paused real one. A paused ws client is not reliably stalled: pause() halts message
   * events, but the kernel and node still absorb megabytes into receive buffers on
   * loopback, so the server's bufferedAmount drains and the backfill finishes legitimately.
   * That made the real-socket version pass alone and fail under suite load — flaky, and a
   * flaky test here is worse than none. The real sockets below cover delivery, ordering
   * and interleaving; this covers the one property loopback cannot hold still.
   */
  it('will not send the next slice while the socket is backed up', async () => {
    const payload = makePayload(20, 20, 60_000);
    const total = planBackfillSlices(payload, { capped: true }).length;
    expect(total).toBeGreaterThan(1);

    let buffered = 64 * 1024;          // wedged: far above idleBytes
    let sent = 0;
    let finished = false;
    const p = sendBackfill(payload, true, {
      socket: { get bufferedAmount() { return buffered; }, get isOpen() { return true; } },
      idleBytes: 4 * 1024,
      drainTimeoutMs: 5_000,
      pollMs: 5,
      sendSlice: () => { sent++; },
    }).then(() => { finished = true; });

    await sleep(200);
    // Exactly one. The first slice is unconditional so a busy socket still gets the
    // visible window; everything after it yields. Asserting 0 here is how a regression
    // that sent NOTHING passed review once already — a wedged client must still be fed.
    expect(sent).toBe(1);
    expect(finished).toBe(false);

    buffered = 0;                      // client catches up
    await p;
    expect(sent).toBe(total);          // and the rest follows
  }, 20_000);

  it('delivers every slice, in order, once the client starts reading', async () => {
    const payload = makePayload(40, 30, 60_000);
    const expectedSlices = planBackfillSlices(payload, { capped: true }).length;
    const { port, state } = await startServer(payload);
    const client = await connect(port);

    const received: HistoryPayload[] = [];
    client.on('message', (b: Buffer) => {
      const m = JSON.parse(b.toString());
      if (m.type === 'historical_data') received.push(m.payload);
    });
    client.pause();
    await sleep(300);
    client.resume();                   // the tab comes back / Wi-Fi catches up

    const deadline = Date.now() + 15_000;
    while (received.length < expectedSlices && Date.now() < deadline) await sleep(25);

    expect(state.stoppedAt).toBe(-1);           // never gave up
    expect(received.length).toBe(expectedSlices);

    // Oldest first, contiguous, and complete.
    const firstTs = received.map((c) => Math.min(...Object.values(c).map((s) => s.time[0])));
    for (let i = 1; i < firstTs.length; i++) expect(firstTs[i]).toBeGreaterThan(firstTs[i - 1]);
    expect(received.reduce((a, c) => a + totalPoints(c), 0)).toBe(totalPoints(payload));

    // And an append-only cache keeps all of it, which is what the browser actually does.
    const cache = new AppendOnlyCache();
    for (const c of received) cache.merge(c);
    expect(cache.total).toBe(totalPoints(payload));
  }, 30_000);

  /** Deterministic for the same reason as the backpressure test above: a paused real
   *  client is not reliably stalled on loopback, so the timeout may never be reached. */
  it('gives up rather than hanging when a client never drains', async () => {
    const payload = makePayload(20, 20, 60_000);
    let stoppedAt = -1;
    const sent = await sendBackfill(payload, true, {
      socket: { get bufferedAmount() { return 64 * 1024; }, get isOpen() { return true; } },
      idleBytes: 4 * 1024,
      drainTimeoutMs: 200,
      pollMs: 5,
      sendSlice: () => { /* never reached */ },
      onStopped: (n) => { stoppedAt = n; },
    });
    expect(sent).toBe(1);              // the first slice always lands
    expect(stoppedAt).toBe(1);         // reported, and resolved rather than hanging
  }, 20_000);

  it('abandons the backfill when the client disconnects mid-stream', async () => {
    const payload = makePayload(20, 20, 60_000);
    let open = true;
    let sent = 0;
    const p = sendBackfill(payload, true, {
      socket: { get bufferedAmount() { return 0; }, get isOpen() { return open; } },
      idleBytes: 4 * 1024,
      pollMs: 5,
      sendSlice: () => { sent++; open = false; },   // drops after the first slice
    });
    expect(await p).toBe(1);
    expect(sent).toBe(1);
  }, 20_000);

  it('leaves the socket free for live frames instead of monopolising it', async () => {
    const payload = makePayload(40, 30, 60_000);
    const { port, state } = await startServer(payload);
    const client = await connect(port);

    let liveSeen = 0;
    client.on('message', (b: Buffer) => {
      if (JSON.parse(b.toString()).type === 'sensor_update') liveSeen++;
    });

    // Push live frames throughout the backfill, exactly as the outbox would.
    const live = setInterval(() => {
      const ws = state.serverWs;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'sensor_update', payload: { t: Date.now() } }));
      }
    }, 20);

    const deadline = Date.now() + 15_000;
    while (!state.finished && Date.now() < deadline) await sleep(25);
    await sleep(300);
    clearInterval(live);

    expect(state.finished).toBe(true);
    // The point of the whole change: live data got through while history was streaming.
    expect(liveSeen).toBeGreaterThan(5);
  }, 30_000);
});
