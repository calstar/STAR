import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElodinClient, ElodinPacketType } from '../elodin-client.js';

function reply(id: [number, number], requestId = 255, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(4 + payload.length);
  header[4] = ElodinPacketType.MSG;
  header[5] = id[0];
  header[6] = id[1];
  header[7] = requestId;
  return Buffer.concat([header, payload]);
}

function receive(client: ElodinClient, bytes: Buffer) {
  (client as unknown as { handleData(data: Buffer): void }).handleData(bytes);
}

afterEach(() => vi.useRealTimers());

describe('subscription fence', () => {
  it('delivers preceding errors before resolving, ignoring other replies', async () => {
    const client = new ElodinClient();
    const send = vi.spyOn(client, 'sendRawMessage').mockReturnValue(true);
    const errors: number[] = [];
    client.on('dbError', (id) => errors.push(id));
    let resolved = false;
    const pending = client.flushSubscriptionRequests().then(() => { resolved = true; });
    expect(send).toHaveBeenCalledWith([0xE0, 0x16], ElodinPacketType.MSG, Buffer.alloc(0), 255);
    receive(client, reply([0xE0, 0x17], 1));
    await Promise.resolve();
    expect(resolved).toBe(false);
    receive(client, Buffer.concat([
      reply([0xE0, 0x1D], 17, Buffer.from([3, ...Buffer.from('bad')])),
      reply([0xE0, 0x17]),
    ]));
    await pending;
    expect(errors).toEqual([17]);
    expect(client.listenerCount('subscriptionFence')).toBe(0);
    expect(client.listenerCount('disconnected')).toBe(0);
  });

  it.each(['timeout', 'disconnect', 'rejection', 'write failure'])(
    'rejects on %s and removes its listeners', async (failure) => {
      vi.useFakeTimers();
      const client = new ElodinClient();
      vi.spyOn(client, 'sendRawMessage').mockReturnValue(failure !== 'write failure');
      const result = expect(client.flushSubscriptionRequests()).rejects.toThrow();
      if (failure === 'timeout') await vi.advanceTimersByTimeAsync(5000);
      if (failure === 'disconnect') client.emit('disconnected');
      if (failure === 'rejection') receive(client, reply([0xE0, 0x1D], 255, Buffer.from([0])));
      await result;
      expect(client.listenerCount('subscriptionFence')).toBe(0);
      expect(client.listenerCount('dbError')).toBe(0);
      expect(client.listenerCount('disconnected')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
});
