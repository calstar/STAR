import { createServer, type Server, type Socket } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElodinClient } from '../elodin-client.js';

// Real sockets, fake timers: the retry clock is ours to advance, the TCP events are not.
// setImmediate is left real so `settle` can wait for socket events to land.

const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

// Bounded by wall time (Date is not faked): loopback I/O is fast but not a fixed number of
// event-loop turns away.
async function waitFor(cond: () => boolean, what: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A port nothing listens on: bind one, then let it go. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let servers: Server[] = [];
let clients: ElodinClient[] = [];

async function listening(): Promise<{ port: number; conns: Socket[] }> {
  const conns: Socket[] = [];
  const s = createServer((c) => conns.push(c));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { port: (s.address() as { port: number }).port, conns };
}

const failures = (c: ElodinClient) => (c as unknown as { failedAttempts: number }).failedAttempts;

/** Fire the next retry and wait for its refusal to come back over the real socket. Fake time
 *  must not run ahead of it, or the attempt's own 5 s connect timeout fires first. */
async function nextRefusal(c: ElodinClient) {
  const before = failures(c);
  // 'close' follows 'error' a tick later and is what schedules the retry.
  await waitFor(() => (c as unknown as { reconnectTimer: unknown }).reconnectTimer != null, 'a retry to be scheduled');
  await vi.advanceTimersByTimeAsync(5000);
  await waitFor(() => failures(c) > before, 'the retry to be refused');
}

function client(port: number) {
  const c = new ElodinClient('127.0.0.1', port);
  clients.push(c);
  return c;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const c of clients) c.disconnect();
  for (const s of servers) {
    s.close();
  }
  clients = [];
  servers = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ElodinClient against a DB that is not there', () => {
  it('never reports a disconnect for a connection that never existed', async () => {
    const c = client(await closedPort());
    const disconnects = vi.fn();
    c.on('disconnected', disconnects);

    expect(await c.connect()).toBe(false);
    for (let i = 0; i < 3; i++) await nextRefusal(c);

    expect(failures(c)).toBe(4);
    expect(disconnects).not.toHaveBeenCalled();
  });

  it('logs the first refusal and not the repeats', async () => {
    const c = client(await closedPort());
    expect(await c.connect()).toBe(false);
    for (let i = 0; i < 4; i++) await nextRefusal(c);

    const lines = [console.log, console.warn, console.error].flatMap((f) =>
      vi.mocked(f).mock.calls.map((a) => String(a[0])),
    );
    expect(lines.filter((l) => l.includes('Cannot reach'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('Connection closed'))).toHaveLength(0);
    expect(lines.filter((l) => l.includes('Reconnecting'))).toHaveLength(0);
  });

  it('stops retrying once disconnect() is called', async () => {
    const c = client(await closedPort());
    expect(await c.connect()).toBe(false);
    await settle();
    const attempts = vi.spyOn(c, 'connect');

    c.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(attempts).not.toHaveBeenCalled();
  });
});

describe('ElodinClient against a live DB', () => {
  it('disconnect() closes it for good, with exactly one disconnected event', async () => {
    const db = await listening();
    const c = client(db.port);
    const disconnects = vi.fn();
    c.on('disconnected', disconnects);

    expect(await c.connect()).toBe(true);
    await waitFor(() => db.conns.length === 1, 'the server to accept');
    c.disconnect();
    await settle();
    // The bug this guards: destroying the socket fired its 'close' handler, which re-armed
    // the reconnect timer disconnect() had just cleared.
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(disconnects).toHaveBeenCalledTimes(1);
    expect(c.isConnected()).toBe(false);
    expect(db.conns).toHaveLength(1);
  });

  it('still reconnects after the DB drops it unasked', async () => {
    const db = await listening();
    const c = client(db.port);
    const disconnects = vi.fn();
    c.on('disconnected', disconnects);

    expect(await c.connect()).toBe(true);
    await waitFor(() => db.conns.length === 1, 'the server to accept');
    db.conns[0].destroy();
    await waitFor(() => !c.isConnected(), 'the client to see the drop');
    expect(disconnects).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => db.conns.length === 2 && c.isConnected(), 'the reconnect');
  });

  it('connect() after disconnect() works again', async () => {
    const db = await listening();
    const c = client(db.port);
    expect(await c.connect()).toBe(true);
    c.disconnect();
    expect(await c.connect()).toBe(true);
    await waitFor(() => db.conns.length === 2, 'the second accept');
  });
});
