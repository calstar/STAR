import { describe, expect, it } from 'vitest';
import {
  buildActChannelsFromBoards,
  buildEncoderDataFromBoards,
  buildLcDataFromBoards,
  buildRtdDataFromBoards,
  buildTcDataFromBoards,
  elodinSlotFromBoardId,
} from '../lib/sensor-info-entities';

/** Minimal boards blob matching integration test config.toml shape. */
const INTEGRATION_LIKE_BOARDS: Record<string, unknown> = {
  tc_board: {
    type: 'TC',
    enabled: true,
    board_id: 51,
    active_connectors: [2, 3, 4, 5],
    voltage_reference: 0,
  },
  rtd_board: {
    type: 'RTD',
    enabled: true,
    board_id: 31,
    active_connectors: [1, 2, 3, 4],
  },
  lc_board_2: {
    type: 'LC',
    enabled: true,
    board_id: 42,
    active_connectors: [1, 2, 6],
  },
  actuator_board_2: {
    type: 'ACTUATOR',
    enabled: true,
    board_id: 12,
    active_connectors: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  actuator_board_4: {
    type: 'ACTUATOR',
    enabled: true,
    board_id: 14,
    active_connectors: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  encoder_board: {
    type: 'ENCODER',
    enabled: true,
    board_id: 61,
    active_connectors: [1, 2],
    num_sensors: 2,
  },
};

describe('elodinSlotFromBoardId', () => {
  it('maps 12→2 and 14→4 and 20→10', () => {
    expect(elodinSlotFromBoardId(12)).toBe(2);
    expect(elodinSlotFromBoardId(14)).toBe(4);
    expect(elodinSlotFromBoardId(20)).toBe(10);
    expect(elodinSlotFromBoardId(21)).toBe(1);
  });
});

describe('Sensor Info entity names (must match Elodin /api/sensor-config)', () => {
  it('builds TC/RTD/LC/ACT entities board-scoped like test/ws_data_flow_test EXPECTED_ENTITIES', () => {
    const tc = buildTcDataFromBoards(INTEGRATION_LIKE_BOARDS);
    expect(tc.map((r) => r.entity)).toEqual([
      'TC1.CH2', 'TC1.CH3', 'TC1.CH4', 'TC1.CH5',
    ]);
    expect(tc[0].calEntity).toBe('TC1_Cal.CH2');

    const rtd = buildRtdDataFromBoards(INTEGRATION_LIKE_BOARDS);
    expect(rtd.map((r) => r.entity)).toEqual([
      'RTD1.CH1', 'RTD1.CH2', 'RTD1.CH3', 'RTD1.CH4',
    ]);

    const lc = buildLcDataFromBoards(INTEGRATION_LIKE_BOARDS);
    expect(lc.map((r) => r.entity)).toEqual(['LC2.CH1', 'LC2.CH2', 'LC2.CH6']);
    expect(lc.map((r) => r.calEntity)).toEqual(['LC2_Cal.CH1', 'LC2_Cal.CH2', 'LC2_Cal.CH6']);

    const act = buildActChannelsFromBoards(INTEGRATION_LIKE_BOARDS);
    const act2 = act.filter((a) => a.entity.startsWith('ACT2.'));
    const act4 = act.filter((a) => a.entity.startsWith('ACT4.'));
    expect(act2).toHaveLength(10);
    expect(act4).toHaveLength(10);
    expect(act2[0]).toMatchObject({
      entity: 'ACT2.CH1',
      calEntity: 'ACT2_Cal.CH1',
      label: 'B12 Ch1',
      boardId: 12,
      localCh: 1,
    });
    expect(act4[9]).toMatchObject({
      entity: 'ACT4.CH10',
      calEntity: 'ACT4_Cal.CH10',
      label: 'B14 Ch10',
      boardId: 14,
      localCh: 10,
    });

    const enc = buildEncoderDataFromBoards(INTEGRATION_LIKE_BOARDS, {
      'Encoder 1': 1,
      'Encoder 2': 2,
    });
    expect(enc).toEqual([
      { entity: 'ENC1.CH1', label: 'Encoder 1', boardId: 61 },
      { entity: 'ENC1.CH2', label: 'Encoder 2', boardId: 61 },
    ]);
  });
});
