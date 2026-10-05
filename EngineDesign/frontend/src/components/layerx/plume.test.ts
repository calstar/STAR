import { describe, expect, it } from 'vitest';
import { areaRatio, boundary, machFromPressure, plume } from './plume';

// Checked against the isentropic tables (NACA 1135, gamma = 1.4), not against the code.
describe('the plume from the nozzle state', () => {
  it('reads the isentropic tables', () => {
    // M = 2: p/p0 = 0.12780, A/A* = 1.6875
    expect(machFromPressure(1, 0.1278, 1.4)).toBeCloseTo(2.0, 3);
    expect(areaRatio(2.0, 1.4)).toBeCloseTo(1.6875, 3);
    // M = 3: p/p0 = 0.02722, A/A* = 4.2346
    expect(machFromPressure(1, 0.02722, 1.4)).toBeCloseTo(3.0, 2);
    expect(areaRatio(3.0, 1.4)).toBeCloseTo(4.2346, 3);
  });

  it('is ideal, under- or over-expanded by pe against pa, and separates below 0.4', () => {
    const at = (pe: number) => plume({ pc_psia: 400, pe_psia: pe, pa_psia: 14, gamma: 1.2 })!;
    expect(at(14).regime).toBe('ideal');
    expect(at(14).djOverDe).toBeCloseTo(1, 6);
    expect(at(20).regime).toBe('under-expanded');
    expect(at(20).djOverDe).toBeGreaterThan(1);
    expect(at(9).regime).toBe('over-expanded');
    expect(at(9).djOverDe).toBeLessThan(1);
    expect(at(5).regime).toBe('separated');
  });

  it('spaces its shock cells by Prandtl-Pack, and its boundary starts at the lip', () => {
    // Ideally expanded at M_j = 2 (gamma 1.4): L_s = 1.22 D sqrt(3).
    const p = plume({ pc_psia: 1, pe_psia: 0.1278, pa_psia: 0.1278, gamma: 1.4 })!;
    expect(p.cellOverDe).toBeCloseTo(1.22 * Math.sqrt(3), 2);
    expect(boundary(p, 0)).toBeCloseTo(1, 6);
  });

  it('refuses a state that cannot be a nozzle flow', () => {
    expect(plume({ pc_psia: 10, pe_psia: 14, pa_psia: 14, gamma: 1.2 })).toBeNull();
    expect(plume({ pc_psia: 400, pe_psia: NaN, pa_psia: 14, gamma: 1.2 })).toBeNull();
  });
});
