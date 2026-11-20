/**
 * The config editor's Pressure Limits rows come from the CURRENT PT roles, not from whatever
 * [pressure_limits.*] keys the file holds. The section used to list the file's keys only, so a
 * stand whose PTs had been renamed showed an older stand's names and offered no row for its own.
 */
import { describe, it, expect } from 'vitest';
import {
  pressureLimitRows, pressureLimitKeyForRole,
  renamePressureLimitRole, removePressureLimitRole, pruneOrphanPressureLimits,
} from '@/lib/pressure-limit-rows';

// A stand whose PTs were renamed since its limits were written.
const config = {
  boards: {
    pt_board: { type: 'PT', board_id: 21 },
    act_board: { type: 'ACTUATOR', board_id: 12 },
  },
  sensor_roles_pt_board: { 'Ox Tank': 1, 'Fuel Tank': 2, 'Chamber A': 3, 'Chamber B': 4 },
  sensor_roles_act_board: { 'Not A PT': 1 },
  pressure_limits: {
    Fuel_Tank: { NOP: 500, MEOP: 600, POP: 700 },
    Chamber: { NOP: 300, MEOP: 400, POP: 500 },
    GN2_High: { NOP: 4000, MEOP: 5000, POP: 6000 },
  },
  gui: {
    pressure_bars: [
      { label: 'FUEL', role: 'Fuel Tank', limits: 'Fuel_Tank' },
      { label: 'CHAMBER', avg_roles: ['Chamber A', 'Chamber B'], limits: 'Chamber' },
    ],
  },
};

describe('pressureLimitRows', () => {
  const rows = pressureLimitRows(config);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  it('has a row for every current PT role, defined or not, and none for other boards', () => {
    const pt = rows.filter((r) => r.kind === 'pt').map((r) => r.label);
    expect(pt).toEqual(['Chamber A', 'Chamber B', 'Fuel Tank', 'Ox Tank']);
    expect(byKey.Ox_Tank.defined).toBe(false);
    expect(byKey.Fuel_Tank.defined).toBe(true);
    expect(byKey.Not_A_PT).toBeUndefined();
  });

  it('keeps a shared key a gauge points at, and says which gauge', () => {
    expect(byKey.Chamber.kind).toBe('gauge');
    expect(byKey.Chamber.gauges).toEqual(['CHAMBER']);
  });

  it('marks a leftover key from an older config as an orphan', () => {
    expect(byKey.GN2_High.kind).toBe('orphan');
    expect(byKey.GN2_High.gauges).toEqual([]);
  });

  it('lists PTs first, then shared keys, then orphans', () => {
    expect(rows.map((r) => r.kind)).toEqual(['pt', 'pt', 'pt', 'pt', 'gauge', 'orphan']);
  });

  it('links a role to its key with spaces as underscores', () => {
    expect(pressureLimitKeyForRole('GN2  Regulated ')).toBe('GN2_Regulated');
  });
});

// Orphans came from two editor paths that moved every other per-role map but not this one.
describe('a PT limits row follows its role', () => {
  const cfg = {
    boards: { pt_board: { type: 'PT', board_id: 21 } },
    sensor_roles_pt_board: { 'Ox Tank': 1, 'Fuel Tank': 2 },
    pressure_limits: {
      Ox_Tank: { NOP: 500, MEOP: 600, POP: 700 },
      Fuel_Tank: { NOP: 400, MEOP: 500, POP: 600 },
      GN2_High: { NOP: 4000, MEOP: 5000, POP: 6000 },
    },
    gui: { pressure_bars: [{ label: 'Ox Tank', role: 'Ox Tank', limits: 'Ox_Tank' }] },
  };

  it('a rename moves the row and the gauge with it', () => {
    const p = renamePressureLimitRole(cfg, 'Ox Tank', 'OU-PT-R');
    expect(Object.keys(p.pressure_limits)).toEqual(['OU-PT-R', 'Fuel_Tank', 'GN2_High']);
    expect(p.pressure_limits['OU-PT-R'].NOP).toBe(500);
    expect(p.gui.pressure_bars[0]).toEqual({ label: 'OU-PT-R', role: 'OU-PT-R', limits: 'OU-PT-R' });
  });

  it('a remove drops the row, unless a gauge still uses the key', () => {
    expect(Object.keys(removePressureLimitRole(cfg, 'Fuel Tank').pressure_limits)).toEqual(['Ox_Tank', 'GN2_High']);
    expect(removePressureLimitRole(cfg, 'Ox Tank')).toEqual({});
  });

  it('save prunes rows no PT or gauge uses', () => {
    expect(Object.keys(pruneOrphanPressureLimits(cfg).pressure_limits)).toEqual(['Ox_Tank', 'Fuel_Tank']);
  });
});

describe('a PT on a LabJack T7', () => {
  // A T7 names its PT in its channel row, not in a sensor_roles_ section; #170's rows were built
  // from sensor_roles_ alone, so a T7 PT had no limits row and its gauge used generic thresholds.
  const t7 = {
    ...config,
    boards: {
      ...config.boards,
      labjack_1: {
        type: 'T7', board_id: 81, channels: [
          { ain: 1, kind: 'PT', role: 'T7 Tank PT', signal: '4-20mA', shunt_ohms: 250, full_scale: 1000 },
          { ain: 2, kind: 'TC', role: 'T7 Nozzle TC', tc_type: 'K', range: 0.1 },
        ],
      },
    },
  };

  it('has a limits row; its TC does not', () => {
    const rows = pressureLimitRows(t7);
    expect(rows.find((r) => r.key === 'T7_Tank_PT')).toMatchObject({ kind: 'pt', label: 'T7 Tank PT', defined: false });
    expect(rows.some((r) => r.label === 'T7 Nozzle TC')).toBe(false);
  });

  it('keeps its limits across a rename', () => {
    const named = { ...t7, pressure_limits: { ...t7.pressure_limits, T7_Tank_PT: { NOP: 400, MEOP: 500, POP: 600 } } };
    const patch = renamePressureLimitRole(named, 'T7 Tank PT', 'Run Tank');
    expect(patch.pressure_limits.Run_Tank).toEqual({ NOP: 400, MEOP: 500, POP: 600 });
    expect(patch.pressure_limits.T7_Tank_PT).toBeUndefined();
  });
});
