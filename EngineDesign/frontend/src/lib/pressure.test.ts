import { describe, expect, it } from 'vitest';
import { friendlyPressureText, isPressureDifference, psiUnitFor } from './pressure';

describe('pressure labels', () => {
  it('names an absolute pressure psia and a difference psi', () => {
    expect(psiUnitFor('max_lox_tank_pressure_psi')).toBe('psia');
    expect(psiUnitFor('target_chamber_pressure_psi')).toBe('psia');
    expect(psiUnitFor('initial_pressure_psi')).toBe('psia');
    expect(psiUnitFor('regulator_min_differential_psi')).toBe('psi');
    expect(psiUnitFor('layer1_tank_equal_tol_psi')).toBe('psi');
    expect(psiUnitFor('regulator_max_excursion_psi')).toBe('psi');
  });
  it('reads the quantity, not the formula after it', () => {
    // "P_inj_O = P_tank - dP_feed" is an absolute pressure, though its formula holds a dP.
    expect(isPressureDifference('P_inj_O = P_tank - dP_feed')).toBe(false);
    expect(isPressureDifference('dP_inj_O / Pc')).toBe(true);
    expect(isPressureDifference('ΔP feed LOX')).toBe(true);
  });
  it('turns the check table\'s pascals into psia', () => {
    // 2026-10-17 dry run: "3.6964e+06 Pa" in the Forward Mode check table.
    expect(friendlyPressureText('P_inj_O = P_tank - dP_feed', '3.6964e+06 Pa')).toBe('536.1 psia');
    expect(friendlyPressureText('exit pressure', '98019 Pa')).toBe('14.2 psia');
    expect(friendlyPressureText('c* ideal', '1724.3 m/s')).toBe('1724.3 m/s');
  });
});
