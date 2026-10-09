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

/**
 * Two boards of one type, both reporting on connector 1.
 *
 * Seen on the stand 2026-09-13 with LC 41 and LC 42 plugged in together — a first for
 * this rig. The LC panel drew two rows that carried identical readings and moved only
 * with board 41. Neither board was broken and no data was lost: the panes built their
 * rows from bare CHANNEL NUMBERS, so both boards produced the single key LC_Cal.CH1,
 * and the store's alias table maps that one name onto both board streams and returns
 * whichever it finds first. One board, drawn twice, under two labels that also read the
 * same ("LC Ch1" and "LC Ch1").
 *
 * Board scope has to survive all the way to the label, or the display is a coin flip.
 */
const TWO_LC_BOARDS: Record<string, unknown> = {
  lc_board: { type: 'LC', enabled: true, board_id: 41, active_connectors: [1], voltage_reference: 1 },
  lc_board_2: { type: 'LC', enabled: true, board_id: 42, active_connectors: [1], voltage_reference: 0 },
};

describe('two boards of one type sharing a connector number', () => {
  it('gives each board its own entity — never one key for both', () => {
    const rows = buildLcDataFromBoards(TWO_LC_BOARDS);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.entity)).toEqual(['LC1.CH1', 'LC2.CH1']);
    expect(rows.map((r) => r.calEntity)).toEqual(['LC1_Cal.CH1', 'LC2_Cal.CH1']);
    expect(new Set(rows.map((r) => r.calEntity)).size).toBe(rows.length);
  });

  it('gives each board its own LABEL — the regression this block exists for', () => {
    const labels = buildLcDataFromBoards(TWO_LC_BOARDS).map((r) => r.label);
    expect(new Set(labels).size).toBe(2);
    // Named by config board_id, which is what the boards panel and config page show.
    expect(labels).toEqual(['LC41 Ch1', 'LC42 Ch1']);
  });

  it('never emits a board-less key that the alias table would have to guess at', () => {
    for (const row of buildLcDataFromBoards(TWO_LC_BOARDS)) {
      expect(row.entity).not.toBe('LC.CH1');
      expect(row.calEntity).not.toBe('LC_Cal.CH1');
      expect(row.entity).toMatch(/^LC\d+\.CH\d+$/);
    }
  });

  it('keeps the short label on a single-board rig — no churn where there is no ambiguity', () => {
    const one = { lc_board: (TWO_LC_BOARDS as Record<string, unknown>).lc_board };
    expect(buildLcDataFromBoards(one).map((r) => r.label)).toEqual(['LC Ch1']);
  });

  it('ignores a disabled twin when deciding whether to disambiguate', () => {
    const boards = {
      lc_board: { type: 'LC', enabled: true, board_id: 41, active_connectors: [1] },
      lc_board_2: { type: 'LC', enabled: false, board_id: 42, active_connectors: [1] },
    };
    expect(buildLcDataFromBoards(boards).map((r) => r.label)).toEqual(['LC Ch1']);
  });

  it('applies the same rule to TC and RTD, which share the shape', () => {
    const boards = {
      tc_a: { type: 'TC', enabled: true, board_id: 51, active_connectors: [2], voltage_reference: 0 },
      tc_b: { type: 'TC', enabled: true, board_id: 52, active_connectors: [2], voltage_reference: 2 },
      rtd_a: { type: 'RTD', enabled: true, board_id: 31, active_connectors: [1] },
      rtd_b: { type: 'RTD', enabled: true, board_id: 32, active_connectors: [1] },
    };
    const tc = buildTcDataFromBoards(boards);
    expect(tc.map((r) => r.calEntity)).toEqual(['TC1_Cal.CH2', 'TC2_Cal.CH2']);
    expect(tc.map((r) => r.label)).toEqual(['TC51 Ch2', 'TC52 Ch2']);
    // Each board's own ADC reference travels with its row; there is no "first board wins".
    expect(tc.map((r) => r.voltageReference)).toEqual([0, 2]);

    const rtd = buildRtdDataFromBoards(boards);
    expect(rtd.map((r) => r.calEntity)).toEqual(['RTD1_Cal.CH1', 'RTD2_Cal.CH1']);
    expect(new Set(rtd.map((r) => r.label)).size).toBe(2);
  });
});
