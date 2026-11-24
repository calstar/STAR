/**
 * C1-6: the Elodin parser resyncs instead of waiting forever.
 *
 * A length field that makes no sense (here 0xFFFFFFFF) means the stream can no longer be framed.
 * The parser used to check plausibility only AFTER waiting for the whole "packet", so it waited
 * for 4 GB that would never come, buffered every later byte up to its 128 MB cap and re-scheduled
 * itself with setImmediate on every tick. Now it drops the connection, which reconnects through
 * the ordinary path and starts again on a clean stream.
 */
import { createServer, type Server, type Socket } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElodinClient, ElodinPacketType } from '../elodin-client.js';

async function waitFor(cond: () => boolean, what: string, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function frame(id: [number, number], payload: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(4 + payload.length, 0);
  h[4] = ElodinPacketType.TABLE;
  h[5] = id[0];
  h[6] = id[1];
  return Buffer.concat([h, payload]);
}

const internals = (c: ElodinClient) =>
  c as unknown as { buffer: Buffer; processingPackets: boolean; reconnectTimer: unknown; handleData(d: Buffer): void };

let server: Server | null = null;
let client: ElodinClient | null = null;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  client?.disconnect();
  client = null;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  vi.restoreAllMocks();
});

describe('ElodinClient resync (C1-6)', () => {
  it('drops the connection on an implausible length instead of buffering forever', async () => {
    const conns: Socket[] = [];
    server = createServer((c) => conns.push(c));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    client = new ElodinClient('127.0.0.1', port);
    const packets: number[][] = [];
    let disconnects = 0;
    client.on('packet', (h) => packets.push(h.packetId));
    client.on('disconnected', () => disconnects++);
    expect(await client.connect()).toBe(true);
    await waitFor(() => conns.length === 1, 'the server to accept');

    // One good row, then a header claiming 0xFFFFFFFF bytes, then more bytes that would be
    // decoded as packets if the parser guessed its way forward.
    const garbage = Buffer.alloc(8);
    garbage.writeUInt32LE(0xFFFFFFFF, 0);
    conns[0].write(Buffer.concat([
      frame([0x20, 0x01], Buffer.from([1, 2, 3, 4])),
      garbage,
      frame([0x20, 0x02], Buffer.from([5, 6, 7, 8])),
    ]));

    await waitFor(() => disconnects === 1, 'the client to drop the connection');
    expect(packets).toEqual([[0x20, 0x01]]); // nothing after the bad length was decoded
    expect(internals(client).buffer.length).toBe(0);
    expect(internals(client).processingPackets).toBe(false);
    expect(client.isConnected()).toBe(false);
    // The ordinary reconnect is armed (disconnect() was not called: this is not a shutdown).
    expect(internals(client).reconnectTimer).not.toBeNull();
  });

  it('a too-short length (< 4) resyncs too', async () => {
    client = new ElodinClient();
    const destroy = vi.fn();
    (client as unknown as { socket: { destroy: () => void } }).socket = { destroy };
    const bad = Buffer.alloc(8);
    bad.writeUInt32LE(2, 0);
    internals(client).handleData(bad);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(internals(client).buffer.length).toBe(0);
  });

  it('waits for an incomplete packet without re-scheduling itself every tick', async () => {
    client = new ElodinClient();
    const packets: number[][] = [];
    client.on('packet', (h) => packets.push(h.packetId));
    const whole = frame([0x20, 0x03], Buffer.alloc(16, 7));
    const immediate = vi.spyOn(global, 'setImmediate');

    internals(client).handleData(whole.subarray(0, 10));
    await new Promise((r) => setTimeout(r, 20));
    expect(internals(client).processingPackets).toBe(false);
    expect(immediate).not.toHaveBeenCalled();
    expect(packets).toEqual([]);

    internals(client).handleData(whole.subarray(10));
    expect(packets).toEqual([[0x20, 0x03]]);
  });
});
