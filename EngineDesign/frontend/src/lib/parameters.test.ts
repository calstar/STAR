import { describe, expect, it } from 'vitest';
import { friendlyValue, labelOf, listedSections, nestedUpdate, parseInput, unitOf } from './parameters';
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
    // Absolute pressures read psia; a difference stays psi.
    expect(unitOf(row({ path: 'design_requirements.max_lox_tank_pressure_psi' }))).toBe('psia');
    expect(unitOf(row({ path: 'lox_tank.initial_pressure_psi', unit: 'psi' }))).toBe('psia');
    expect(unitOf(row({ path: 'design_requirements.layer1_tank_equal_tol_psi', unit: 'psi' }))).toBe('psi');
    expect(unitOf(row({ path: 'stability.regulator_max_excursion_psi', unit: 'psi' }))).toBe('psi');
    expect(unitOf(row({ path: 'design_requirements.regulator_min_differential_psi', unit: 'psi' }))).toBe('psi');
    expect(labelOf('design_requirements.layer1_P_O_start_psi_min')).toBe('LOX tank pressure, search floor');
    expect(labelOf('design_requirements.frozen_parameters.P_F_start_psi')).toBe('Fuel tank pressure');
    expect(unitOf(row({ path: 'design_requirements.layer1_P_F_start_psi_max' }))).toBe('psia');
    expect(labelOf('design_requirements.optimal_of_ratio')).toBe('Optimal O/F ratio');
    expect(labelOf('discharge.oxidizer.orifice_l_over_d')).toBe('Orifice L/d');
    expect(labelOf('design_requirements.min_rail_exit_velocity_m_s')).toBe('Min rail exit velocity');
    expect(unitOf(row({ path: 'design_requirements.min_rail_exit_velocity_m_s' }))).toBe('m/s');
    expect(labelOf('design_requirements.min_static_margin_cal')).toBe('Min static margin');
    expect(labelOf('lox_tank.ullage_gas_temperature_K')).toBe('Ullage gas temperature');
    expect(unitOf(row({ unit: 'kg/m³', path: 'fluids.fuel.density' }))).toBe('kg/m³');
  });

  it('reads a Pa value in the unit a person uses', () => {
    const pa = (path: string, value: unknown) => friendlyValue(row({ path, unit: 'Pa', value }), value);
    expect(pa('chamber_geometry.design_pressure', 2413166)).toBe('350 psia');
    expect(pa('fluids.fuel.vapor_pressure', 101325)).toBe('14.7 psia');
    expect(pa('fluids.oxidizer.bulk_modulus_pa', 9.4e8)).toBe('940 MPa');
    expect(pa('combustion.cea.Pc_range', [1e6, 9e6])).toBe('145 psia to 1,305 psia');
    expect(pa('design_requirements.max_P_tank_O', null)).toBeNull();
    expect(friendlyValue(row({ path: 'fluids.fuel.viscosity', unit: 'Pa·s', value: 1e-4 }), 1e-4)).toBeNull();
  });

  it('lists a legacy section only while it holds a value, an internal one never', () => {
    const sec = (key: string, over: object = {}) => ({ key, label: key, count: 1, modified: 0, ...over });
    expect(listedSections([sec('fluids'), sec('chamber', { legacy: true }), sec('design_valid_for', { internal: true, modified: 1 })])
      .map((s) => s.key)).toEqual(['fluids']);
    expect(listedSections([sec('chamber', { legacy: true, modified: 1 })]).map((s) => s.key)).toEqual(['chamber']);
  });
});
