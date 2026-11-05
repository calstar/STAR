/**
 * The config editor's Pressure Limits rows come from the CURRENT PT roles, not from whatever
 * [pressure_limits.*] keys the file holds. The section used to list the file's keys only, so a
 * stand whose PTs had been renamed showed an older stand's names and offered no row for its own.
 */
import { describe, it, expect } from 'vitest';
import { pressureLimitRows, pressureLimitKeyForRole } from '@/lib/pressure-limit-rows';

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
