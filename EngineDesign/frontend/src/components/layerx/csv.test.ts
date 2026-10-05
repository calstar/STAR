import { describe, expect, it } from 'vitest';
import type { LayerXResult } from '../../api/layerx';
import { EMPTY_SERIES } from './format';
import { burnCsv } from './csv';

// A three-step burn written by hand: one lead-in step, two firing steps, replayed and flown.
function burn(): LayerXResult {
  const side = (tank: number) => ({
    tank_psia: [tank, tank - 5, tank - 6], outlet_psia: [0, 0, 0], inlet_psia: [0, 0, 0], dump_psi: [0, 0, 0],
    manifold_psia: [0, 520, 519], dp_injector_psi: [0, 138, 137], stiffness: [0, 0.36, 0.359], mdot: [0, 1.8, 1.79],
    liquid_kg: [6.6, 6.5, 6.4], ullage_K: [293, 290, 288], liquid_K: [90, 90, 90], fill_fraction: [0.4, 0.39, 0.38],
  });
  return {
    series: { ...EMPTY_SERIES, t: [-0.05, 0.05, 0.1], firing: [false, true, true], converged: [true, true, true],
              copv_psia: [4514, 4400, 4300], copv_mass_kg: [1.45, 1.43, 1.41], copv_wall_K: [293, 293, 293], regulators: {},
              ox: side(578), fuel: side(577),
              chamber: { pc_psia: [0, 382, 383], mr: [0, 1.51, 1.52], thrust_N: [0, 6700, 6710], isp_s: [0, 224, 224],
                         cstar: [0, 0, 0], extrapolated: [0, 0, 0] } },
    delivered: { t: [0.05, 0.1], thrust_N: [6720, 6731], pc_psia: [383, 384], isp_s: [224, 224.1], throat_area_ratio: [1, 1.001],
                 recession_throat_mm: [0, 0.01], ambient_psia: [13.6, 13.5], p_exit_psia: [14.1, 14.2] },
    flight: { ok: true, schedule: { t: [0.05, 0.1], accel_m_s2: [8 * 9.80665, 8.1 * 9.80665] } },
    provenance: { drawing: { name: 'stand' }, config_sha256: 'abcdef0123456789', settings: { dt: 0.05 },
                  derived: { target_lockup_psia: 578, copv_psig: 4500 } },
  } as unknown as LayerXResult;
}

describe('a burn as CSV', () => {
  const text = burnCsv(burn(), 'run1');
  const rows = text.trim().split('\n').filter((l) => !l.startsWith('#'));
  const head = rows[0].split(',');
  const col = (name: string) => rows.slice(1).map((r) => r.split(',')[head.indexOf(name)]);

  it('has a row per step and a column per quantity, units in the names', () => {
    expect(rows.length).toBe(1 + 3);
    expect(rows.slice(1).every((r) => r.split(',').length === head.length)).toBe(true);
    expect(col('lox_tank_psia')).toEqual(['578', '573', '572']);
  });

  it('puts the eroding engine and the flight on the firing rows only', () => {
    expect(col('thrust_N')).toEqual(['', '6720', '6731']);
    expect(col('thrust_N_as_built')).toEqual(['', '6700', '6710']);
    expect(col('accel_on_liquids_g')).toEqual(['', '8', '8.1']);
  });

  it('says what made it', () => {
    expect(text.startsWith('# Layer X burn run1: drawing stand, design abcdef012345')).toBe(true);
  });
});

describe('a burn without the replay or the flight, with an awkward regulator id', () => {
  const b = burn();
  delete (b as { delivered?: unknown }).delivered;
  (b as { flight?: unknown }).flight = { ok: false };
  b.series.regulators = { 'PR,1 "dome"': { label: 'Dome', outlet_psia: [590, 585, 584] } };
  const text = burnCsv(b);
  const rows = text.trim().split('\n').filter((l) => !l.startsWith('#'));
  const head = rows[0].split(',');

  it('keeps every row the width of its header', () => {
    expect(rows.slice(1).every((r) => r.split(',').length === head.length)).toBe(true);
    expect(head).toContain('PR_1_dome_outlet_psia');
  });

  it('leaves out what the burn did not compute', () => {
    expect(head).not.toContain('thrust_N');
    expect(head).not.toContain('accel_on_liquids_g');
    expect(head).toContain('thrust_N_as_built');
  });
});
