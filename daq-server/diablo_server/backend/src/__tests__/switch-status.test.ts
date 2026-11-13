import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseElodinPacket } from '../elodin-protocol.js';
import type { ElodinClient } from '../elodin-client.js';

const { config } = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock('../routes/config.js', () => ({ readDeployedConfig: () => config }));
import { clearSubscriptionState, registerVTables, setClockForTests } from '../elodin-vtable-registry.js';

// One row as daq_bridge logs it (lib/include/streams/SwitchStatusMessage.hpp, 34 bytes).
function row(): Buffer {
  const p = Buffer.alloc(34);
  p.writeBigUInt64LE(1_700_000_000_456_000_000n, 0);
  p.writeUInt8(1, 8);          // link up
  p.writeInt8(-67, 9);         // rssi
  p.writeUInt16LE(420, 10);    // age_ms
  p.writeUInt32LE(0xcafef00d, 12);
  p.writeUInt8(1, 16);         // status_valid
  p.writeUInt8(1, 17);         // output
  p.writeUInt8(3, 18);         // sense live
  p.writeUInt8(3, 19);         // flags
  p.writeUInt16LE(8412, 20);
  p.writeInt16LE(-123, 22);
  p.writeUInt16LE(1035, 24);
  p.writeUInt16LE(2471, 26);
  p.writeUInt32LE(0x01020304, 28);
  p.writeUInt8(9, 32);
  p.writeUInt8(1, 33);
  return p;
}

describe('switch status stream', () => {
  it('decodes every field under SW<role>, signed where signed', () => {
    const parsed = parseElodinPacket([0x27, 2], row());
    const v = Object.fromEntries(parsed.map((p) => [p.component, p.value]));
    expect(new Set(parsed.map((p) => p.entity))).toEqual(new Set(['SW2']));
    expect(parsed[0].timestamp).toBe(1700000000456);
    expect(v).toEqual({
      link: 1, rssi: -67, age_ms: 420, config_hash: 0xcafef00d, status_valid: 1, output: 1,
      sense: 3, flags: 3, supply_mv: 8412, current_ma: -123, power_mw: 1035, sense_mv: 2471,
      uptime_s: 0x01020304, reset_reason: 9, status_version: 1,
    });
  });

  it('rejects wrong sizes and roles past the last', () => {
    expect(parseElodinPacket([0x27, 2], row().subarray(0, 33))).toEqual([]);
    expect(parseElodinPacket([0x27, 2], Buffer.alloc(35))).toEqual([]);
    expect(parseElodinPacket([0x27, 5], row())).toEqual([]);
  });
});

describe('switch subscriptions', () => {
  beforeEach(() => {
    clearSubscriptionState();
    setClockForTests(() => 1_000_000);
  });

  async function subscribed(): Promise<number[][]> {
    const sendRawMessage = vi.fn(() => true);
    const client = { isConnected: () => true, sendRawMessage,
      flushSubscriptionRequests: async () => {} } as unknown as ElodinClient;
    await registerVTables(client);
    return sendRawMessage.mock.calls
      .map((args) => (args as unknown[]).find((arg) => Buffer.isBuffer(arg)) as Buffer)
      .filter((p) => p?.[0] === 0x27)
      .map((p) => [...p]);
  }

  it('subscribes one table per configured role while the service is on', async () => {
    Object.assign(config, {
      boards: {},
      switch_service: { enabled: true },
      switch_roles: { main: { role: 0, name: 'Main' }, backup: { role: 3, name: 'Backup' },
        bad: { role: 7 } },
    });
    expect(await subscribed()).toEqual([[0x27, 0], [0x27, 3]]);
  });

  it('subscribes none while the service is off', async () => {
    Object.assign(config, {
      boards: {},
      switch_service: { enabled: false },
      switch_roles: { main: { role: 0 } },
    });
    expect(await subscribed()).toEqual([]);
  });
});
