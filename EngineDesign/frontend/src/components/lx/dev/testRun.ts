import type { LayerXResult, SideSeries, SideSummary, Summary } from '../../../api/layerx';

/**
 * A small burn built by hand, for the unit tests (useRunData, contract, the pages' render test).
 * Not a fixture of the physics: just enough of a LayerXResult to exercise the derivations.
 */

// ------------------------------------------------------------------ a small burn, built by hand
//
//   t      -0.10 -0.05  0.00  0.05  0.10  0.15  0.20  0.25  0.30
//   firing   no    no    no   yes   yes   yes   yes   yes    no
//
// Fire at 0, burnout at 0.25 (the last firing step).

export const T = [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3];
export const FIRING = [false, false, false, true, true, true, true, true, false];

export function side(over: Partial<SideSeries> = {}): SideSeries {
  const n = T.length;
  const z = () => new Array(n).fill(0);
  return {
    tank_psia: [578, 578, 578, 560, 552, 555, 557, 559, 580],
    outlet_psia: z(), inlet_psia: z(), dump_psi: z(),
    manifold_psia: [0, 0, 0, 520, 515, 518, 519, 520, 0],
    dp_injector_psi: z(),
    // Lowest while firing: 0.28 at 0.10. The same 0.28 at -0.05 is before Fire and must not count.
    stiffness: [0, 0.28, 0, 0.32, 0.28, 0.30, 0.31, 0.33, 0],
    mdot: [0, 0, 0, 2, 2, 2, 2, 2, 0],
    liquid_kg: z(), ullage_K: z(), liquid_K: z(), fill_fraction: z(),
    ...over,
  };
}

export function sideSummary(over: Partial<SideSummary> = {}): SideSummary {
  return {
    t0_psia: 578, min_psia: 552, end_psia: 580, ignition_dip_psi: 26, inlet_mean_psia: 540, dp_injector_min_psi: 110,
    stiffness_min: 0.28, stiffness_mean: 0.3, peak_psia: 580, loaded_kg: 6.6, residual_kg: 0.02, ...over,
  };
}

export function summary(over: Partial<Summary> = {}): Summary {
  return {
    burn_time_s: 0.25, depleted_tank: 'FUT', depleted_side: 'fuel', total_impulse_Ns: 1000, mean_thrust_N: 7000, peak_thrust_N: 7200,
    min_thrust_N: 6800, thrust_t0_N: 7000, pc_mean_psia: 395, pc_min_psia: 391, pc_max_psia: 397, of_mean: 1.5, of_min: 1.49, of_max: 1.53,
    isp_mean_s: 224, propellant_used_kg: 11, ox: sideSummary(), fuel: sideSummary({ min_psia: 550, stiffness_min: 0.25, loaded_kg: 4.4, residual_kg: 0.001 }),
    copv_t0_psia: 4510, copv_end_psia: 1406, copv_used_kg: 0.64, regulators: {}, steps: T.length, failed_steps: 0, extrapolated_steps: 0,
    t0_settled: true, dt: 0.05, ...over,
  };
}

export function result(over: Partial<LayerXResult> = {}): LayerXResult {
  const fuel = side({
    tank_psia: [578, 578, 578, 562, 556, 550, 553, 558, 582],
    // Fuel's lowest stiffness 0.25 at 0.20 s.
    stiffness: [0, 0, 0, 0.30, 0.29, 0.27, 0.25, 0.26, 0],
  });
  return {
    series: {
      t: T, firing: FIRING, converged: FIRING.map(() => true),
      copv_psia: [4510, 4510, 4510, 4000, 3200, 2500, 1900, 1406, 1406], copv_mass_kg: [], copv_wall_K: [], regulators: {},
      ox: side(), fuel,
      chamber: {
        pc_psia: [0, 0, 0, 390, 395, 396, 397, 391, 0], mr: [0, 0, 0, 1.5, 1.5, 1.5, 1.5, 1.5, 0],
        thrust_N: [0, 0, 0, 6900, 7000, 7100, 7200, 6800, 0], isp_s: [0, 0, 0, 224, 224, 224, 224, 224, 0], cstar: [], extrapolated: [],
      },
    },
    summary: summary(),
    events: [
      { t: 0, kind: 't0', label: 'T-0 state', detail: '' },
      { t: 0, kind: 'fire', label: 'Fire', detail: 'Mains commanded open' },
      { t: 0.15, kind: 'min', label: 'Fuel tank lowest', detail: '550 psia' },
      { t: 0.1, kind: 'min', label: 'LOX tank lowest', detail: '552 psia' },
      { t: 0.25, kind: 'end', label: 'Fuel tank dry', detail: '' },
    ],
    provenance: {
      drawing: { id: 'd', name: 'copv_study_he', source: '', sha256: '' }, config_sha256: 'abc', settings: {} as LayerXResult['provenance']['settings'],
      derived: {
        stiffness_band: { oxidiser: [0.2, 0.4], fuel: [0.2, 0.4] }, roles: { oxidiser: 'OXT', fuel: 'FUT' },
        tank_mawp_psi: { OXT: 1000, FUT: 1000 }, ambient_pa: 94069.72, gauge_zero_pa: 101325,
      },
      setup: {}, plan: {}, calibration: null, engine_reference: null,
      assembly: { symbols: 0, lines: 0, nodes: 0, branches: 0, unstated: 0, assumptions: [], warnings: [] },
      notes: [], probes: {}, created: 0, phase: 0,
    },
    checks: [],
    delivered: {
      t: [0.05, 0.1, 0.15, 0.2, 0.25],
      thrust_N: [6950, 7050, 7150, 7250, 6850], pc_psia: [389, 394, 395, 396, 390], mdot_O: [], mdot_F: [], isp_s: [223, 223, 223, 223, 223],
      mr: [1.49, 1.5, 1.5, 1.5, 1.51], throat_area_ratio: [], recession_throat_mm: [],
      // Lowest chug 1.18 at 0.15 s; the summary names that moment.
      chug_margin: [1.25, 1.2, 1.18, 1.19, 1.22],
      summary: {
        total_impulse_Ns: 999, mean_thrust_N: 7050, peak_thrust_N: 7250, min_thrust_N: 6850, pc_mean_psia: 393, pc_min_psia: 389, pc_max_psia: 396,
        isp_mean_s: 223, propellant_burned_kg: 10.9, throat_area_growth: 0.055, throat_recession_mm: 0.65, chug_margin_min: 1.18, chug_margin_min_t: 0.15,
      },
    },
    converged: true,
    ...over,
  };
}

