/**
 * D-IDLETIMEOUT and D-LATE (issue #234), backend half.
 *
 * - sendToSequencer's guard is an OVERALL deadline. It used to be a 2 s socket *idle* timeout, so
 *   a sequencer that trickled bytes without a newline reset it forever and the request hung.
 * - A reply that does not say whether the command ran (no reply before the deadline, or the
 *   sequencer's own `ERR:pending:`) reaches the operator as "state unknown, resyncing" — a
 *   warning plus a state_update re-broadcast — never as "failed". A known refusal, including the
 *   sequencer's `ERR:not executed:` (cancelled at its deadline), is still a failure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';

// ── A trickling sequencer: one byte every 50 ms, never a newline ─────────────────────────────────
let server: net.Server;
const sockets: net.Socket[] = [];
beforeAll(async () => {
  server = net.createServer((sock) => {
    sockets.push(sock);
    const t = setInterval(() => { if (!sock.destroyed) sock.write('x'); }, 50);
    sock.on('close', () => clearInterval(t));
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.ACTUATOR_SERVICE_PORT = String((server.address() as net.AddressInfo).port);
});
afterAll(async () => {
  sockets.forEach((s) => s.destroy());
  await new Promise<void>((r) => server.close(() => r()));
});

describe('sendToSequencer deadline', () => {
  it('is 5 s, longer than the sequencer\'s own 1.5 s + 3 s', async () => {
    const { SEQUENCER_REPLY_DEADLINE_MS } = await import('../sequencer-client.js');
    expect(SEQUENCER_REPLY_DEADLINE_MS).toBe(5000);
  });

  it('fires on a server that trickles bytes and never sends a newline', async () => {
    const { sendToSequencer } = await import('../sequencer-client.js');
    const t0 = Date.now();
    const r = await Promise.race([
      sendToSequencer('TRANSITION:Idle\n', { quiet: true, deadlineMs: 600 }),
      new Promise<'hung'>((res) => setTimeout(() => res('hung'), 3000)),
    ]);
    expect(r).not.toBe('hung');
    if (r === 'hung') return;
    expect(r).toEqual({ ok: false, reply: 'timeout', timedOut: true });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

// ── What the operator is told ────────────────────────────────────────────────────────────────────
describe('unknown outcome text', () => {
  it('a backend timeout is "state unknown, resyncing", not "failed"', async () => {
    const { outcomeUnknown, resyncText } = await import('../sequencer-outcome.js');
    const r = { reply: 'timeout', timedOut: true };
    expect(outcomeUnknown(r)).toBe(true);
    const text = resyncText('State transition', r);
    expect(text).toContain('state unknown, resyncing');
    expect(text).not.toMatch(/fail/i);
  });

  it('ERR:pending is unknown; ERR:not executed and a refusal are known', async () => {
    const { outcomeUnknown } = await import('../sequencer-outcome.js');
    expect(outcomeUnknown({ reply: 'ERR:pending: still running; outcome unknown' })).toBe(true);
    expect(outcomeUnknown({ reply: 'ERR:not executed: still queued after 1500 ms (sequencer busy)' })).toBe(false);
    expect(outcomeUnknown({ reply: 'ERR:transition rejected' })).toBe(false);
    expect(outcomeUnknown({ reply: 'timeout' })).toBe(false); // only the flag means no reply
  });
});
