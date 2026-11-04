/**
 * A LabJack T7 channel is one more PT / TC / LC to the GUI.
 *
 * t7_bridge publishes T7<slot>_Cal.AIN<n> in psi / °C / kg. Pinned here: the role keys every pane
 * already uses (PT_Cal.<Role>, TC_Cal.<Role>, LC_Cal.<Role>) reach those streams, and the TC / LC
 * row builders the plot pages share include T7 channels beside the ESP32 boards'.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildSenseRowsFromBoards } from '@/lib/sensor-info-entities';

vi.mock('@/lib/websocket', () => ({
  getWebSocketClient: () => ({
    on: () => () => {},
    setHistoricalQueryProvider: () => {},
    onConnectionStatus: () => () => {},
    isConnected: () => true,
    connect: () => {},
    send: () => {},
  }),
  getApiBaseUrl: () => 'http://localhost:8081',
}));

const T0 = 1_700_000_000_000;

const CONFIG = {
  boards: {
    tc_board: { type: 'TC', board_id: 51, enabled: true, active_connectors: [2] },
    labjack_1: {
      type: 'T7', ip: '192.168.2.82', board_id: 82, enabled: true,
      channels: [
        { ain: 1, kind: 'PT', role: 'LOX Tank', signal: '0-5V', full_scale: 1000 },
        { ain: 2, kind: 'TC', role: 'Nozzle TC', tc_type: 'K' },
        { ain: 4, kind: 'LC', role: 'Thrust', full_scale: 500, sensitivity_mv_per_v: 2, excitation_v: 10 },
        { ain: 6, kind: 'VOLTAGE' },
      ],
    },
    labjack_off: {
      type: 'T7', board_id: 83, enabled: false,
      channels: [{ ain: 3, kind: 'PT', role: 'Off PT', signal: '0-5V', full_scale: 1 }],
    },
  },
  sensor_roles_tc_board: { 'Chamber TC': 2 },
};

async function freshModules() {
  vi.resetModules();
  const plotTime = await import('@/lib/plot-time');
  plotTime.resetPlotTimeForTests();
  const store = await import('@/lib/store');
  const dataCache = await import('@/lib/data-cache');
  return { store, dataCache };
}

describe('T7 role aliases', () => {
  it('PT_Cal / TC_Cal / LC_Cal role keys reach the T7 streams', async () => {
    const { store, dataCache } = await freshModules();
    store.buildAliasesFromConfig(CONFIG);
    const cache = dataCache.getDataCache();
    for (let i = 0; i < 5; i++) {
      cache.addDataPoint('T72_Cal.AIN1', 'pressure_psi', 300 + i, T0 + i * 50);
      cache.addDataPoint('T72_Cal.AIN2', 'temperature_c', 60 + i, T0 + i * 50);
      cache.addDataPoint('T72_Cal.AIN4', 'force_kg', 100 + i, T0 + i * 50);
    }
    const out = cache.getAlignedHistory(
      ['PT_Cal.LOX_Tank', 'TC_Cal.Nozzle_TC', 'LC_Cal.Thrust', 'T72_Cal.LOX_Tank'],
      ['pressure_psi', 'temperature_c', 'force_kg', 'pressure_psi'],
      60,
    );
    expect(out).not.toBeNull();
    expect(out!.values[0][4]).toBe(304);
    expect(out!.values[1][4]).toBe(64);
    expect(out!.values[2][4]).toBe(104);
    expect(out!.values[3][4]).toBe(304);
  });

  it('a disabled T7 gets no aliases', async () => {
    const { store, dataCache } = await freshModules();
    store.buildAliasesFromConfig(CONFIG);
    const cache = dataCache.getDataCache();
    // Data under the disabled board's entity must not surface under its role.
    for (let i = 0; i < 3; i++) cache.addDataPoint('T73_Cal.AIN3', 'pressure_psi', 5, T0 + i * 50);
    const out = cache.getAlignedHistory(['PT_Cal.Off_PT'], ['pressure_psi'], 60);
    expect(out === null || out.values[0].every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe('TC / LC rows', () => {
  it('include each T7 channel of the kind, labelled by its role, after the ESP32 rows', () => {
    const tc = buildSenseRowsFromBoards(CONFIG.boards, 'TC');
    expect(tc.map((r) => [r.calEntity, r.label, r.source])).toEqual([
      ['TC1_Cal.CH2', 'TC Ch2', undefined],
      ['T72_Cal.AIN2', 'Nozzle TC', 'T7'],
    ]);
    expect(tc[1]).toMatchObject({ entity: 'T72.AIN2', boardId: 82, boardNumber: 2, channel: 2 });

    const lc = buildSenseRowsFromBoards(CONFIG.boards, 'LC');
    expect(lc.map((r) => r.calEntity)).toEqual(['T72_Cal.AIN4']);
  });

  it('never put a T7 PT, VOLTAGE channel or disabled board into them', () => {
    const all = [...buildSenseRowsFromBoards(CONFIG.boards, 'TC'),
      ...buildSenseRowsFromBoards(CONFIG.boards, 'LC'),
      ...buildSenseRowsFromBoards(CONFIG.boards, 'RTD')];
    expect(all.some((r) => /AIN1$|AIN6$|^T73/.test(r.calEntity))).toBe(false);
  });
});
