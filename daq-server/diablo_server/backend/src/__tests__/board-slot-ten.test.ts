/**
 * The board-slot rule on a board whose id ends in 0: `board_id % 10`, with 0 → 10. The backend
 * holds four inline copies of that rule on the paths a config reaches without a running stack
 * (`sensor-config.ts` hpBoardNumbers and loadSensorRoleMap, `elodin-vtable-registry.ts`
 * buildVTableStreamSubscriptionList, `legacy/state-actuators.ts`
 * resolveActuatorBoardSlotAndChannel), and no other test feeds any of them a `% 10 == 0` board:
 * vtable-subscriptions.test.ts uses 21, 22, 12, 41 and the pipeline fixture's board 60 never
 * streams. Dropping the `0 → 10` half in any one copy (slot 0) must go red here.
 *
 * Boards 10 and 20 both land on slot 10; board 21 on slot 1. Only board 20 carries a sensor-role
 * section (10 and 20 would otherwise collide on the same reverse-map keys and the assertion
 * would depend on iteration order). Board 10 is the current-loop board, which is the only kind
 * hpBoardNumbers reports.
 */
import { describe, it, expect, vi } from 'vitest';

const config = {
  boards: {
    pt_10: {
      type: 'PT', board_id: 10, enabled: true, ip: '127.0.0.10', active_connectors: [1],
      pt_type: '4-20 mA absolute',
    },
    pt_20: { type: 'PT', board_id: 20, enabled: true, ip: '127.0.0.20', active_connectors: [1] },
    pt_21: { type: 'PT', board_id: 21, enabled: true, ip: '127.0.0.21', active_connectors: [1] },
  },
  sensor_roles_pt_20: { 'Tank Twenty': 1 },
  sensor_roles_pt_21: { 'Tank Twenty One': 1 },
  actuator_roles: {
    'Valve Twenty': ['NC', 1, 20],
    'Valve Ten': ['NC', 2, 10],
    'Valve Twenty One': ['NC', 3, 21],
  },
};
vi.mock('../routes/config.js', () => ({ readConfig: () => config, readDeployedConfig: () => config }));

const { hpBoardNumbers, loadSensorRoleMap } = await import('../sensor-config.js');
const { buildVTableStreamSubscriptionList } = await import('../elodin-vtable-registry.js');
const { resolveActuatorBoardSlotAndChannel, resolveActuatorCmdEntity } = await import('../legacy/state-actuators.js');

describe('board_id % 10 == 0 is slot 10', () => {
  it('hpBoardNumbers: the current-loop board 10 is slot 10, never 0', () => {
    const slots = hpBoardNumbers(config);
    expect(slots.has(10)).toBe(true);
    expect(slots.has(0)).toBe(false);
    expect([...slots]).toEqual([10]);
  });

  it('loadSensorRoleMap: board 20 keys its role at channel + (10 - 1) * 10, board 21 at channel + 0', () => {
    const { channelToEntityMap } = loadSensorRoleMap();
    expect(channelToEntityMap[91]).toBe('PT_Cal.Tank_Twenty');
    expect(channelToEntityMap[1]).toBe('PT_Cal.Tank_Twenty_One');
    // Slot 0 would key the role at 1 + (0 - 1) * 10 = -9.
    expect(channelToEntityMap[-9]).toBeUndefined();
  });

  it('buildVTableStreamSubscriptionList: slot 10 folds to 2 (the registry\'s (n-1) % 8 + 1), slot 1 stays 1', () => {
    const pairs = buildVTableStreamSubscriptionList(config);
    const has = (h: number, l: number) => pairs.some(([a, b]) => a === h && b === l);
    // Boards 10 and 20: slot 10 → fold 2 → low bytes (2 - 1) * 0x20 + 1 raw, + 0x10 calibrated.
    expect(has(0x20, 0x21)).toBe(true);
    expect(has(0x20, 0x31)).toBe(true);
    // Board 21: slot 1 → low bytes 0x01 / 0x11.
    expect(has(0x20, 0x01)).toBe(true);
    expect(has(0x20, 0x11)).toBe(true);
    // Slot 0 folds to ((0 - 1) % 8) + 1 = 0 and lands at (0 - 1) * 0x20 + 1 = -31.
    expect(pairs.some(([h, l]) => h === 0x20 && l < 0)).toBe(false);
    expect(pairs.filter(([h]) => h === 0x20)).toHaveLength(4);
  });

  it('resolveActuatorBoardSlotAndChannel: roles on boards 20 and 10 are slot 10, on 21 slot 1', () => {
    expect(resolveActuatorBoardSlotAndChannel('Valve Twenty')).toEqual({ bn: 10, localCh: 1, ballValve: false });
    expect(resolveActuatorBoardSlotAndChannel('Valve Ten')).toEqual({ bn: 10, localCh: 2, ballValve: false });
    expect(resolveActuatorBoardSlotAndChannel('Valve Twenty One')).toEqual({ bn: 1, localCh: 3, ballValve: false });
    expect(resolveActuatorCmdEntity('Valve Twenty')).toBe('ACT_CMD.B10.CH1');
    expect(resolveActuatorCmdEntity('Valve Twenty One')).toBe('ACT_CMD.B1.CH3');
  });
});
