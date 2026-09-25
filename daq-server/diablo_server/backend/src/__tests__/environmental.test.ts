import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseElodinPacket } from '../elodin-protocol.js';
import { isPrimaryPhysicalStream, mapEntityToGroup } from '../board-scan-rate.js';
import type { ElodinClient } from '../elodin-client.js';

const { config } = vi.hoisted(() => ({ config: { boards: {} as Record<string, unknown> } }));
vi.mock('../routes/config.js', () => ({ readDeployedConfig: () => config }));
import { clearSubscriptionState, registerVTables, noteSubscriptionRejected } from '../elodin-vtable-registry.js';

function packet(): Buffer {
  const payload = Buffer.alloc(24);
  payload.writeBigUInt64LE(1_700_000_000_123_000_000n, 0);
  payload.writeFloatLE(-12.5, 8);
  payload.writeUInt32LE(101325, 12);
  payload.writeFloatLE(45.25, 16);
  payload.writeUInt32LE(4294967200, 20);
  return payload;
}

describe('environmental stream', () => {
  it('preserves units, signed temperature, epoch time, and full board identity', () => {
    expect(parseElodinPacket([0x25, 25], packet())).toEqual([
      { entity: 'ENV25', component: 'temperature_c', value: -12.5, timestamp: 1700000000123 },
      { entity: 'ENV25', component: 'pressure_pa', value: 101325, timestamp: 1700000000123 },
      { entity: 'ENV25', component: 'humidity_rh', value: 45.25, timestamp: 1700000000123 },
    ]);
    expect(parseElodinPacket([0x25, 35], packet())[0].entity).toBe('ENV35');
  });

  it('rejects short, oversized, invalid, and non-finite readings', () => {
    for (let size = 0; size < 24; size++) {
      expect(parseElodinPacket([0x25, 25], packet().subarray(0, size))).toEqual([]);
    }
    expect(parseElodinPacket([0x25, 25], Buffer.alloc(25))).toEqual([]);
    expect(parseElodinPacket([0x25, 0], packet())).toEqual([]);
    for (const [offset, value] of [[8, NaN], [8, Infinity], [16, NaN], [16, -1], [16, 101]]) {
      const p = packet();
      p.writeFloatLE(value, offset);
      expect(parseElodinPacket([0x25, 25], p)).toEqual([]);
    }
    const p = packet();
    p.writeUInt32LE(0, 12);
    expect(parseElodinPacket([0x25, 25], p)).toEqual([]);
  });

  it('counts one sample per packet, with separate rates per board', () => {
    const parsed = parseElodinPacket([0x25, 25], packet());
    expect(parsed.filter((p) => isPrimaryPhysicalStream(p.entity, p.component))).toHaveLength(1);
    expect(mapEntityToGroup('ENV25')).toBe('env25');
    expect(mapEntityToGroup('ENV35')).toBe('env35');
  });
});

describe('environmental subscriptions', () => {
  beforeEach(() => clearSubscriptionState());

  it('subscribes enabled BME280 boards once using their full ID', async () => {
    config.boards = {
      first: { type: 'ENVIRONMENTAL', board_id: 25, active_connectors: [1] },
      second: { type: 'ENVIRONMENTAL', board_id: 35, active_connectors: [1] },
      disabled: { type: 'ENVIRONMENTAL', board_id: 26, enabled: false, active_connectors: [1] },
      empty: { type: 'ENVIRONMENTAL', board_id: 27, active_connectors: [] },
      badId: { type: 'ENVIRONMENTAL', board_id: 256, active_connectors: [1] },
    };
    const sendRawMessage = vi.fn(() => true);
    const client = { isConnected: () => true, sendRawMessage,
      flushSubscriptionRequests: async () => {} } as unknown as ElodinClient;
    await registerVTables(client);
    const environmental = sendRawMessage.mock.calls
      .map((args) => (args as unknown[]).find((arg) => Buffer.isBuffer(arg)) as Buffer)
      .filter((payload) => payload?.[0] === 0x25);
    expect(environmental.map((p) => [...p])).toEqual([[0x25, 25], [0x25, 35]]);
    sendRawMessage.mockClear();
    await registerVTables(client);
    expect(sendRawMessage).not.toHaveBeenCalled();
  });

  it('retries rejected environmental streams after more than 255 subscriptions without duplicating accepted streams', async () => {
    config.boards = {
      env: { type: 'ENVIRONMENTAL', board_id: 25, active_connectors: [1] },
      quiet: { type: 'ENVIRONMENTAL', board_id: 35, active_connectors: [1] },
    };
    const sent: string[] = [];
    const batch = new Map<number, string>();
    let rejectEnvironmental = true;
    let fences = 0;
    const client = {
      isConnected: () => true,
      sendRawMessage: (_id: unknown, _type: unknown, payload: Buffer, requestId: number) => {
        expect(requestId).toBeGreaterThan(0);
        expect(requestId).toBeLessThan(255);
        expect(batch.has(requestId)).toBe(false);
        batch.set(requestId, [...payload].join(','));
        sent.push([...payload].join(','));
        return true;
      },
      flushSubscriptionRequests: async () => {
        // Deliver rejections only after the entire batch has been sent.
        for (const [id, key] of [...batch].reverse()) {
          if (rejectEnvironmental && key === '37,25') noteSubscriptionRejected(id, 'invalid msg id');
        }
        batch.clear();
        fences++;
      },
    } as unknown as ElodinClient;
    await registerVTables(client);
    expect(sent.length).toBeGreaterThan(255);
    expect(fences).toBeGreaterThan(1);
    sent.length = 0;
    rejectEnvironmental = false;
    await registerVTables(client);
    expect(sent).toEqual(['37,25']);
    sent.length = 0;
    await registerVTables(client);
    expect(sent).toEqual([]);
    clearSubscriptionState();
    await registerVTables(client);
    expect(sent).toContain('37,25');
    expect(sent).toContain('37,35');
  });

  it('serializes concurrent passes and stops when a fence fails', async () => {
    let failFence!: (error: Error) => void;
    const fence = new Promise<void>((_resolve, reject) => { failFence = reject; });
    const sendRawMessage = vi.fn(() => true);
    const disconnect = vi.fn();
    const client = { isConnected: () => true, sendRawMessage, disconnect,
      flushSubscriptionRequests: () => fence } as unknown as ElodinClient;
    const first = registerVTables(client);
    const second = registerVTables(client);
    expect(second).toBe(first);
    expect(sendRawMessage).toHaveBeenCalledTimes(254);
    failFence(new Error('Subscription fence timed out'));
    expect(await first).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(sendRawMessage).toHaveBeenCalledTimes(254);
  });
});
