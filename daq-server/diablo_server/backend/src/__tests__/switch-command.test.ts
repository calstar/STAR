import { describe, expect, it } from 'vitest';
import { planSwitchCommand, planSwitchDiscover } from '../switch-command.js';
import { CONTROL_COMMAND_TYPES } from '../control-commands.js';
import { parseElodinPacket } from '../elodin-protocol.js';

const CONFIG = {
  switch_service: { enabled: true, command_port: 8094 },
  switch_roles: { main: { role: 0, name: 'Main' }, backup: { role: 3, name: 'Backup' } },
};

describe('switch commands', () => {
  it('need an approved operator with control on, like every hardware command', () => {
    expect(CONTROL_COMMAND_TYPES.has('switch')).toBe(true);
  });

  it('become one absolute line for switch_service', () => {
    expect(planSwitchCommand({ switchRole: 3, switchOutput: 1, switchCommandId: 513 }, CONFIG))
      .toEqual({ line: '513 3 1\n', port: 8094 });
    expect(planSwitchCommand({ switchRole: 0, switchOutput: 0, switchCommandId: 0 }, CONFIG))
      .toEqual({ line: '0 0 0\n', port: 8094 });
  });

  it('are refused for an unlisted role, a toggle, a bad id, or switches off', () => {
    const err = (d: object, c: unknown = CONFIG) => 'error' in planSwitchCommand(d, c);
    expect(err({ switchRole: 1, switchOutput: 1, switchCommandId: 1 })).toBe(true);
    expect(err({ switchRole: 0, switchOutput: 2, switchCommandId: 1 })).toBe(true);
    expect(err({ switchRole: 0, switchCommandId: 1 })).toBe(true);
    expect(err({ switchRole: 0, switchOutput: 1, switchCommandId: 70000 })).toBe(true);
    expect(err({ switchRole: 0, switchOutput: 1 })).toBe(true);
    expect(err({ switchRole: 0, switchOutput: 1, switchCommandId: 1 },
      { ...CONFIG, switch_service: { enabled: false } })).toBe(true);
    expect(err({ switchRole: 0, switchOutput: 1, switchCommandId: 1 }, null)).toBe(true);
  });

  it('results decode onto SW<role>', () => {
    const p = Buffer.alloc(12);
    p.writeBigUInt64LE(1_700_000_000_000_000_000n, 0);
    p.writeUInt16LE(513, 8);
    p.writeUInt8(1, 10);
    p.writeUInt8(1, 11);  // no link
    expect(parseElodinPacket([0x28, 3], p)).toEqual([
      { entity: 'SW3', component: 'cmd_id', value: 513, timestamp: 1700000000000 },
      { entity: 'SW3', component: 'cmd_output', value: 1, timestamp: 1700000000000 },
      { entity: 'SW3', component: 'cmd_result', value: 1, timestamp: 1700000000000 },
    ]);
    expect(parseElodinPacket([0x28, 3], Buffer.alloc(11))).toEqual([]);
    expect(parseElodinPacket([0x28, 5], p)).toEqual([]);
  });

  it('"Find switches" is one line, not gated, and needs the service on', () => {
    expect(CONTROL_COMMAND_TYPES.has('switch_discover')).toBe(false);
    expect(planSwitchDiscover(CONFIG)).toEqual({ line: 'discover\n', port: 8094 });
    expect('error' in planSwitchDiscover({ switch_service: { enabled: false } })).toBe(true);
  });

  it('seen switches decode onto SWSEEN<slot>', () => {
    const p = Buffer.alloc(17);
    p.writeBigUInt64LE(1_700_000_000_000_000_000n, 0);
    p.writeBigUInt64LE(0x58cf7901abcdn, 8);
    p.writeInt8(-80, 16);
    expect(parseElodinPacket([0x29, 7], p)).toEqual([
      { entity: 'SWSEEN7', component: 'mac', value: 0x58cf7901abcd, timestamp: 1700000000000 },
      { entity: 'SWSEEN7', component: 'rssi', value: -80, timestamp: 1700000000000 },
    ]);
    expect(parseElodinPacket([0x29, 8], p)).toEqual([]);
  });
});
