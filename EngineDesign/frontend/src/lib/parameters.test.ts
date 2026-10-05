import { describe, expect, it } from 'vitest';
import { labelOf, nestedUpdate, parseInput, unitOf } from './parameters';
import type { ParameterRow } from './parameters';

const row = (over: Partial<ParameterRow>): ParameterRow => ({
  path: 'a.b', section: 'a', kind: 'field', type: 'float', choices: null, value: 1, default: 1,
  required: false, modified: false, unit: null, description: '', ...over,
});

describe('parameters', () => {
  it('turns dotted paths into the nested update PUT /api/config merges', () => {
    expect(nestedUpdate({ 'discharge.oxidizer.orifice_l_over_d': 5, 'discharge.fuel.inlet_geometry': 'sharp', x: 1 }))
      .toEqual({ discharge: { oxidizer: { orifice_l_over_d: 5 }, fuel: { inlet_geometry: 'sharp' } }, x: 1 });
  });

  it('parses against the row type; blank is null only where null is allowed', () => {
    expect(parseInput(row({ type: 'float | null' }), '')).toEqual({ value: null });
    expect(parseInput(row({ type: 'float', required: true }), '')).toEqual({ error: 'required' });
    expect(parseInput(row({ type: 'int' }), '2.5')).toEqual({ error: 'whole number' });
    expect(parseInput(row({ type: 'float' }), '1e-3')).toEqual({ value: 0.001 });
    expect(parseInput(row({ type: 'enum', choices: ['sharp', 'rounded'] }), 'rounded')).toEqual({ value: 'rounded' });
    expect(parseInput(row({ type: 'bool' }), 'false')).toEqual({ value: false });
  });

  it('reads units off the key and writes the team terms', () => {
    expect(labelOf('design_requirements.max_lox_tank_pressure_psi')).toBe('Max LOX tank pressure');
    expect(unitOf(row({ path: 'design_requirements.max_lox_tank_pressure_psi' }))).toBe('psi');
    expect(labelOf('design_requirements.optimal_of_ratio')).toBe('Optimal O/F ratio');
    expect(labelOf('discharge.oxidizer.orifice_l_over_d')).toBe('Orifice L/d');
    expect(labelOf('design_requirements.min_rail_exit_velocity_m_s')).toBe('Min rail exit velocity');
    expect(unitOf(row({ path: 'design_requirements.min_rail_exit_velocity_m_s' }))).toBe('m/s');
    expect(labelOf('design_requirements.min_static_margin_cal')).toBe('Min static margin');
    expect(labelOf('lox_tank.ullage_gas_temperature_K')).toBe('Ullage gas temperature');
    expect(unitOf(row({ unit: 'kg/m³', path: 'fluids.fuel.density' }))).toBe('kg/m³');
  });
});
