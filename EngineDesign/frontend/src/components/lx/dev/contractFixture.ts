import type { LayerXResult } from '../../../api/layerx';
import type {
  Col, ContractEvent, ContractResult, Diagnostics, LadderElement, LadderSide, Network, OpMap, ServerLimit,
} from '../contract';

/**
 * DEV ONLY. A real run dressed in every DATA-CONTRACT key with made-up numbers, so the pages can
 * be drawn and checked before the backend lands each block. Open a run with `&lxfixture=contract`
 * on a dev server; the page then says "Fixture data" in the top bar. Nothing here is physics:
 * shapes and magnitudes only, derived from the run's own series where that is easy.
 *
 * Also the unit tests' fixture for the accessors (contract.test.ts).
 */

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const map = (n: number, f: (i: number) => number | null): Col => Array.from({ length: n }, (_, i) => {
  const v = f(i);
  return finite(v) ? v : null;
});

export function withContract(result: LayerXResult, opts: { failed?: (keyof Diagnostics)[] } = {}): LayerXResult {
  const r = structuredClone(result) as unknown as ContractResult;
  const s = r.series;
  const t = s.t;
  const n = t.length;
  const firing = s.firing;
  const dv = r.delivered;
  const fi = new Map<number, number>();
  { let k = 0; firing.forEach((f, i) => { if (f) fi.set(i, k++); }); }
  const dvAt = (col: readonly (number | null)[] | undefined, i: number): number | null => {
    const k = fi.get(i);
    return k === undefined || !col ? null : (col[k] ?? null);
  };
  const pc = map(n, (i) => (firing[i] ? (dvAt(dv?.pc_psia, i) ?? s.chamber.pc_psia[i]) : null));
  const reg = Object.values(s.regulators)[0]?.outlet_psia ?? s.ox.tank_psia;
  const bottle = s.copv_psia;
  const fireIdx = firing.indexOf(true);
  const lastFire = firing.lastIndexOf(true);

  // ---- the ladder, bottle to chamber, per side
  const sideOf = (side: 'ox' | 'fuel'): LadderSide => {
    const ss = s[side];
    const el = (id: string, label: string, kind: string, f: (i: number) => number | null): LadderElement => ({ id: `${side}_${id}`, label, kind, dp_psi: map(n, f) });
    const elements = [
      el('reg', 'Regulator', 'regulator', (i) => (firing[i] ? bottle[i] - reg[i] : null)),
      el('sol', side === 'ox' ? 'LOX press solenoid' : 'Fuel press solenoid', 'solenoid', (i) => (firing[i] ? Math.max(0, reg[i] - ss.tank_psia[i]) * 0.6 : null)),
      el('check', 'Check valve', 'check', (i) => (firing[i] ? Math.max(0, reg[i] - ss.tank_psia[i]) * 0.4 : null)),
      el('head', 'Liquid head', 'tank', (i) => (firing[i] ? ss.tank_psia[i] - ss.outlet_psia[i] : null)),
      el('line', side === 'ox' ? 'LOX line' : 'Fuel line', 'line', (i) => (firing[i] ? (ss.outlet_psia[i] - ss.inlet_psia[i]) * 0.7 : null)),
      el('valve', side === 'ox' ? 'LOX main valve' : 'Fuel main valve', 'valve', (i) => (firing[i] ? (ss.outlet_psia[i] - ss.inlet_psia[i]) * 0.3 : null)),
      el('manifold', 'Into manifold', 'fitting', (i) => (firing[i] ? ss.inlet_psia[i] - ss.manifold_psia[i] : null)),
      el('inj', 'Injector', 'injector', (i) => (firing[i] && pc[i] !== null ? ss.manifold_psia[i] - (pc[i] as number) : null)),
    ];
    const total = map(n, (i) => (firing[i] && pc[i] !== null ? bottle[i] - (pc[i] as number) : null));
    for (const e of elements) e.share = map(n, (i) => (e.dp_psi[i] !== null && total[i] ? (e.dp_psi[i] as number) / (total[i] as number) : null));
    return { elements, total_psi: total };
  };

  const mdotGas = map(n, (i) => (i > 0 ? Math.max(0, (s.copv_mass_kg[i - 1] - s.copv_mass_kg[i]) / (t[i] - t[i - 1])) : 0));
  const capacity = map(n, (i) => 0.006 * Math.max(0, bottle[i] - reg[i]) ** 0.5 + 0.02);
  const use = map(n, (i) => (capacity[i] ? (mdotGas[i] ?? 0) / (capacity[i] as number) : null));
  const chug = map(n, (i) => dvAt(dv?.chug_margin ?? undefined, i));
  const chugMinIdx = chug.reduce<number>((b, v, i) => (v !== null && (b < 0 || v < (chug[b] as number)) ? i : b), -1);
  const ref = r.provenance.engine_reference;
  const ratioAt = (i: number) => dvAt(dv?.throat_area_ratio, i);

  const x = Array.from({ length: 61 }, (_, k) => -160 + k * 4.5);
  const r0 = x.map((xx) => (xx < -60 ? 63 : xx < 0 ? 15 + 48 * ((-xx) / 60) ** 1.4 : 15 + 22 * (xx / 110) ** 0.75));
  const frameT = [0, ...t.filter((_, i) => firing[i]).filter((_, k) => k % 4 === 0), t[lastFire]];
  const frames = {
    t: frameT,
    r_mm: frameT.map((tt) => {
      const g = Math.max(0, Math.min(1, tt / (t[lastFire] || 1)));
      return r0.map((rr, k) => rr + 0.5 * g * Math.exp(-((x[k] / 18) ** 2)) + 0.12 * g);
    }),
  };

  const diagnostics: Diagnostics = {
    ladder: { t, ox: sideOf('ox'), fuel: sideOf('fuel'), model: { name: 'Fixture ladder', source: 'dev/contractFixture.ts', assumptions: ['made-up split of the press drops'] } },
    regulator: {
      t, inlet_psia: [...bottle], outlet_psia: [...reg], mdot: mdotGas, capacity_mdot: capacity, use_frac: use,
      droop_psi: map(n, (i) => (firing[i] ? 8.3 * (use[i] ?? 0) : 0)), spe_psi: map(n, (i) => 0.002 * (4510 - bottle[i])),
      choked: t.map((_, i) => bottle[i] / Math.max(1, reg[i]) > 1.9), wide_open: t.map((_, i) => (use[i] ?? 0) > 0.95), cv: 0.8,
      model: { name: 'Fixture regulator', source: 'dev', assumptions: ['capacity curve invented'] },
    },
    solenoids: (['ox', 'fuel'] as const).map((side) => ({
      id: `SV_${side.toUpperCase()}P`, label: side === 'ox' ? 'LOX press' : 'Fuel press', side, cv: 0.35,
      dp_psi: map(n, (i) => (firing[i] ? Math.max(0, reg[i] - s[side].tank_psia[i]) * 0.6 : 0)),
      share_of_reg_to_tank: map(n, (i) => (firing[i] ? 0.6 : null)),
    })),
    pressurant: {
      species: String((r.provenance.derived as Record<string, unknown>).pressurant_gas ?? 'nitrogen'),
      loaded_kg: s.copv_mass_kg[0], used_kg: s.copv_mass_kg[0] - s.copv_mass_kg[n - 1], residual_kg: s.copv_mass_kg[n - 1],
      required_kg: (s.copv_mass_kg[0] - s.copv_mass_kg[n - 1]) * 1.6, margin_kg: s.copv_mass_kg[n - 1] - (s.copv_mass_kg[0] - s.copv_mass_kg[n - 1]) * 0.6,
      bottle_T_K: map(n, (i) => 293 - 40 * (1 - bottle[i] / bottle[0])), jt_dT_K: map(n, (i) => (firing[i] ? -6 : 0)),
      model: { name: 'Fixture pressurant', source: 'dev' },
    },
    saturation: {
      nodes: [
        { id: 'ox_tank_out', label: 'LOX tank outlet', side: 'ox', margin_psi: map(n, (i) => s.ox.outlet_psia[i] - 95), min_psi: null, t_min: null },
        { id: 'ox_manifold', label: 'LOX manifold', side: 'ox', margin_psi: map(n, (i) => (firing[i] ? s.ox.manifold_psia[i] - 120 : null)), min_psi: null, t_min: null },
        { id: 'fuel_manifold', label: 'Fuel manifold', side: 'fuel', margin_psi: map(n, (i) => (firing[i] ? s.fuel.manifold_psia[i] - 4 : null)), min_psi: null, t_min: null },
      ].map((node) => {
        const k = node.margin_psi.reduce<number>((b, v, i) => (v !== null && (b < 0 || v < (node.margin_psi[b] as number)) ? i : b), -1);
        return { ...node, side: node.side as 'ox' | 'fuel', min_psi: k >= 0 ? node.margin_psi[k] : null, t_min: k >= 0 ? t[k] : null };
      }),
      model: { name: 'Fixture saturation', source: 'dev' },
    },
    cavitation: {
      ox: { K: map(n, (i) => (firing[i] && pc[i] ? (s.ox.manifold_psia[i] - 95) / Math.max(1, s.ox.manifold_psia[i] - (pc[i] as number)) : null)), K_incipient: 1.8, L_over_d: 4, flip_risk: false, min_K: null, t_min: null },
      fuel: { K: map(n, (i) => (firing[i] && pc[i] ? (s.fuel.manifold_psia[i] - 4) / Math.max(1, s.fuel.manifold_psia[i] - (pc[i] as number)) : null)), K_incipient: 1.8, L_over_d: 4, flip_risk: false, min_K: null, t_min: null },
      model: { name: 'Fixture cavitation', source: 'dev' },
    },
    injector: {
      t, v_ox: map(n, (i) => (firing[i] ? 22 + 0.01 * s.ox.mdot[i] : null)), v_fuel: map(n, (i) => (firing[i] ? 27 : null)),
      momentum_ratio: map(n, (i) => (firing[i] ? 1.02 + 0.08 * Math.sin(i / 6) : null)), design_momentum_ratio: 1.05,
      resultant_angle_deg: map(n, (i) => (firing[i] ? 2 + 1.5 * Math.sin(i / 6) : null)),
      eta_cstar: map(n, (i) => (firing[i] ? 0.905 + 0.004 * Math.sin(i / 8) : null)),
      model: { name: 'Fixture injector', source: 'dev' },
    },
    stability: {
      basis: 'config', t, margin: chug, frequency_hz: map(n, (i) => (firing[i] ? 138 + 9 * Math.sin(i / 10) : null)),
      worst: chugMinIdx >= 0 ? { t: t[chugMinIdx], margin: chug[chugMinIdx] as number, frequency_hz: 141 } : null,
      settled_min: chugMinIdx >= 0 ? { t: t[chugMinIdx], margin: (chug[chugMinIdx] as number) + 0.03 } : null, start_window_s: 0.2,
      nyquist: {
        t: chugMinIdx >= 0 ? t[chugMinIdx] : 0,
        omega: Array.from({ length: 80 }, (_, k) => 50 + k * 10),
        re: Array.from({ length: 80 }, (_, k) => { const w = (50 + k * 10) / 140; return (0.75 * Math.cos(2.4 * w)) / (1 + 0.3 * w * w); }),
        im: Array.from({ length: 80 }, (_, k) => { const w = (50 + k * 10) / 140; return (-0.75 * Math.sin(2.4 * w)) / (1 + 0.3 * w * w); }),
      },
      tau_sweep: { tau_ms: Array.from({ length: 21 }, (_, k) => 0.5 + k * 0.25), margin: Array.from({ length: 21 }, (_, k) => 1.9 - 0.06 * k), nominal_ms: 2.0 },
      acoustic: [
        { line: 'LOX line', side: 'ox', length_m: 0.9, f_quarter_hz: 210, f_half_hz: 420, near_chug: false },
        { line: 'Fuel line', side: 'fuel', length_m: 1.2, f_quarter_hz: 245, f_half_hz: 490, near_chug: false },
        { line: 'LOX manifold', side: 'ox', length_m: 0.08, f_quarter_hz: 2800, f_half_hz: 5600, near_chug: false },
      ],
      other_basis: { basis: 'drawing', margin_min: chugMinIdx >= 0 ? (chug[chugMinIdx] as number) - 0.04 : null, t: 0.7 },
      model: { name: 'Fixture DTL chug', source: 'dev' },
    },
    hardware: {
      t,
      throat_d_mm: map(n, (i) => (ratioAt(i) !== null ? 30 * Math.sqrt(ratioAt(i) as number) : null)),
      At_ratio: map(n, (i) => ratioAt(i)),
      eps: map(n, (i) => (ratioAt(i) !== null ? 5.2 / (ratioAt(i) as number) : null)),
      Lstar_m: map(n, (i) => (ratioAt(i) !== null ? 1.0 / (ratioAt(i) as number) : null)),
      contraction: map(n, (i) => (ratioAt(i) !== null ? 4.4 / (ratioAt(i) as number) : null)),
      liner_min_mm: map(n, (i) => (firing[i] ? 12.7 - 0.6 * ((t[i] - t[fireIdx]) / (t[lastFire] - t[fireIdx] || 1)) : null)),
      insert_back_K: map(n, (i) => (firing[i] ? 293 + 40 * ((t[i] - t[fireIdx]) / (t[lastFire] - t[fireIdx] || 1)) ** 2 : null)),
      insert_back_basis: 'adiabatic upper bound',
      contour: { x_mm: x, r0_mm: r0, frames, liner_r_mm: r0.map((rr) => rr + 12.7) },
      separation: {
        pe_pa: map(n, (i) => (firing[i] ? 99000 + 2000 * Math.sin(i / 9) : null)), summerfield: t.map(() => false),
        schmucker_pa_crit_psia: map(n, (i) => (firing[i] ? 5.1 : null)), flag: false,
      },
      isp: {
        ideal_s: map(n, (i) => (firing[i] ? 248 : null)),
        cstar_loss_s: map(n, (i) => (firing[i] ? 248 * (1 - 0.91) : null)),
        nozzle_loss_s: map(n, (i) => (firing[i] ? 248 * 0.91 - (dvAt(dv?.isp_s, i) ?? 225) : null)),
        delivered_s: map(n, (i) => (firing[i] ? dvAt(dv?.isp_s, i) ?? 225 : null)),
      },
      soak: { available: true, peak_K: 612, t_peak_s: 41, station: 'throat insert back face', duration_s: 120, basis: 'adiabatic upper bound' },
      heatmap: 'sidecar:axial',
      model: { name: 'Fixture hardware', source: 'dev' },
    },
    thrust_shape: { mean_N: dv?.summary.mean_thrust_N ?? null, dev_max_pct: 4.2, dev_rms_pct: 1.6, target_N: 6800 },
    start: {
      available: true, t: Array.from({ length: 26 }, (_, k) => k * 0.02),
      pc_psia: Array.from({ length: 26 }, (_, k) => 400 * (1 - Math.exp(-k / 5)) + (k === 6 ? 40 : 0)),
      mdot_ox: Array.from({ length: 26 }, (_, k) => 1.9 * (1 - Math.exp(-k / 4))),
      mdot_fuel: Array.from({ length: 26 }, (_, k) => 1.3 * (1 - Math.exp(-(k + 2) / 4))),
      mr: Array.from({ length: 26 }, (_, k) => 1.45 + 0.6 * Math.exp(-k / 3) * Math.cos(k / 2)),
      fuel_lead_s: 0.1, valve_travel_s: 0.08, prime_ox_s: 0.12, prime_fuel_s: 0.09, ignition_s: 0.14, impulse_deficit_Ns: 210, hard_start: false,
      model: { name: 'Fixture start', source: 'dev' },
    },
    shutdown: { first_dry: r.summary.depleted_side === 'fuel' ? 'fuel' : 'ox', mode: r.summary.depleted_side === 'fuel' ? 'LOX-rich' : 'fuel-rich', tail_mr_max: 3.1, model: { name: 'Fixture shutdown', source: 'dev' } },
    water_hammer: [
      { line: 'LOX main', side: 'ox', closure_s: 0.08, joukowsky_psi: 610, slow_close_psi: 140, peak_psia: 720, rating_psia: 1000, ok: true },
      { line: 'Fuel main', side: 'fuel', closure_s: 0.08, joukowsky_psi: 480, slow_close_psi: 110, peak_psia: 690, rating_psia: 1000, ok: true },
    ],
    outflow: [
      { tank: 'LOX tank', side: 'ox', ingestion_onset_s: (t[lastFire] ?? 3) - 0.12, residual_kg: 0.04, outlet_d_mm: 12.7 },
      { tank: 'Fuel tank', side: 'fuel', ingestion_onset_s: (t[lastFire] ?? 3) - 0.05, residual_kg: 0.02, outlet_d_mm: 12.7 },
    ],
    vv: {
      mass: {
        ox: { loaded_kg: r.summary.ox.loaded_kg, burned_kg: r.summary.ox.loaded_kg - r.summary.ox.residual_kg, residual_kg: r.summary.ox.residual_kg, trapped_kg: 0.01, error_pct: 0.02 },
        fuel: { loaded_kg: r.summary.fuel.loaded_kg, burned_kg: r.summary.fuel.loaded_kg - r.summary.fuel.residual_kg, residual_kg: r.summary.fuel.residual_kg, trapped_kg: 0.01, error_pct: 0.03 },
      },
      pressurant: { bottle_out_kg: 0.71, ullage_in_kg: 0.70, vented_kg: 0.0, error_pct: 0.4 },
      energy: { error_pct: 0.8, basis: 'ullage first law over the burn' },
      convergence: (r.passes ?? []).map((p) => ({ pass: p.pass, throat_residual: p.schedule_change, accel_residual: p.accel_change ?? null })),
      dt_check: { dt_s: r.summary.dt, half_dt_s: r.summary.dt / 2, impulse_delta_pct: -0.056 },
    },
    ledger: [
      { key: 'tank', label: 'Tank pressure', design_value: 578, unit: 'psia', delivered: { min: Math.min(...s.ox.tank_psia), max: Math.max(...s.ox.tank_psia), mean: 570 }, series_ref: 'series.ox.tank_psia', replaced: 'yes', note: 'the drawing regulates it' },
      { key: 'of', label: 'O/F', design_value: ref?.MR ?? 1.42, unit: '', delivered: { min: r.summary.of_min, max: r.summary.of_max, mean: r.summary.of_mean }, series_ref: 'series.chamber.mr', replaced: 'partly' },
      { key: 'mr_inj', label: 'Momentum ratio', design_value: 1.05, unit: '', delivered: { min: 0.94, max: 1.1, mean: 1.02 }, series_ref: 'diagnostics.injector.momentum_ratio', replaced: 'no' },
      { key: 'eta', label: 'ηc*', design_value: ref?.eta_cstar ?? 0.91, unit: 'frac', delivered: { min: 0.901, max: 0.909, mean: 0.905 }, series_ref: 'diagnostics.injector.eta_cstar', replaced: 'yes' },
    ],
  };
  const opmap: OpMap = {
    t, of: map(n, (i) => (firing[i] ? s.chamber.mr[i] : null)), pc_psia: pc,
    design: ref ? { of: ref.MR, pc_psia: ref.Pc / 6894.757 } : null,
    boundaries: [
      { key: 'ox_lo', label: 'LOX ΔP/Pc 20 %', side: 'ox', edge: 'lo', of: [1.0, 1.3, 1.6, 1.9, 2.2], pc_psia: [520, 470, 445, 430, 420] },
      { key: 'fuel_lo', label: 'Fuel ΔP/Pc 20 %', side: 'fuel', edge: 'lo', of: [1.0, 1.3, 1.6, 1.9, 2.2], pc_psia: [400, 430, 460, 490, 520] },
    ],
  };
  (diagnostics as Record<string, unknown>).opmap = opmap;
  for (const k of opts.failed ?? []) (diagnostics as Record<string, unknown>)[k] = { available: false, error: `fixture: ${k} failed on purpose` };
  r.diagnostics = diagnostics;

  // ---- result.limits
  const lim = (x: Partial<ServerLimit> & Pick<ServerLimit, 'key' | 'label' | 'value' | 'grade'>): ServerLimit => ({ direction: 'min', ...x });
  const sat = diagnostics.saturation?.nodes ?? [];
  r.limits = [
    lim({ key: 'chug_margin', label: 'Chug margin', group: 'stability', value: chugMinIdx >= 0 ? chug[chugMinIdx] : null, unit: '', limit: 1, warn: 1.2, grade: chugMinIdx >= 0 && (chug[chugMinIdx] as number) < 1.2 ? 'warn' : 'ok', t_worst: chugMinIdx >= 0 ? t[chugMinIdx] : null, index_worst: chugMinIdx, series_ref: 'diagnostics.stability.margin', hint: 'Below 1 the feed-coupled loop is predicted unstable.' }),
    lim({ key: 'stiffness_ox', label: 'LOX injector ΔP/Pc', group: 'injector', value: r.summary.ox.stiffness_min, unit: '', limit: 0.2, warn: 0.22, grade: 'ok', t_worst: t[fireIdx + 4] ?? null, index_worst: fireIdx + 4, series_ref: 'series.ox.stiffness' }),
    lim({ key: 'stiffness_fuel', label: 'Fuel injector ΔP/Pc', group: 'injector', value: r.summary.fuel.stiffness_min, unit: '', limit: 0.2, warn: 0.22, grade: 'ok', t_worst: t[fireIdx + 3] ?? null, index_worst: fireIdx + 3, series_ref: 'series.fuel.stiffness' }),
    lim({ key: 'ox_tank_mawp', label: 'LOX tank peak vs MAWP', group: 'tanks', value: r.summary.ox.peak_psia ?? null, unit: 'psia', limit: 1014.7, warn: 900, direction: 'max', grade: 'ok', t_worst: t[lastFire] ?? null, index_worst: lastFire }),
    lim({ key: 'fuel_tank_design_cap', label: 'Fuel tank vs design cap', group: 'tanks', value: r.summary.fuel.peak_psia ?? null, unit: 'psia', limit: 600, warn: 580, direction: 'max', grade: 'warn', t_worst: t[lastFire] ?? null, index_worst: lastFire, hint: 'Design cap graded amber until D11 is decided.' }),
    lim({ key: 'bottle_over_lockup', label: 'Bottle over lockup', group: 'pressurant', value: (r.summary.copv_end_psia ?? 0) - 578, unit: 'psi', limit: 100, warn: 200, grade: 'ok', t_worst: t[lastFire] ?? null, index_worst: null }),
    ...sat.map((node) => lim({ key: `saturation_${node.id}`, label: `${node.label} saturation`, group: 'propellant', value: node.min_psi ?? null, unit: 'psi', limit: 0, warn: 25, grade: (node.min_psi ?? 0) < 25 ? 'warn' : 'ok', t_worst: node.t_min ?? null, index_worst: node.t_min !== null && node.t_min !== undefined ? t.indexOf(node.t_min) : null, series_ref: `diagnostics.saturation.nodes` })),
    lim({ key: 'water_hammer_ox', label: 'LOX main water hammer', group: 'hardware', value: 720, unit: 'psia', limit: 1000, warn: 850, direction: 'max', grade: 'ok', t_worst: null, index_worst: null }),
    lim({ key: 'static_margin_min', label: 'Static margin, lowest', group: 'flight', value: 7.73, unit: 'cal', limit: 1.5, warn: 2, grade: 'ok', t_worst: 0, index_worst: null }),
    lim({ key: 'max_q', label: 'Max-Q', group: 'flight', value: 182000, unit: 'Pa', limit: null, grade: 'info', t_worst: 3.1, index_worst: null }),
    lim({ key: 'conservation', label: 'Mass conservation', group: 'model', value: 0.0004, unit: '', limit: 0.01, warn: 0.005, direction: 'max', grade: 'ok', t_worst: null, index_worst: null }),
  ];

  // ---- result.network (a skeleton: two nodes per side and the branches between)
  const net: Network = {
    t,
    nodes: {
      bottle: { label: 'Bottle', kind: 'bottle', side: 'gas', p_psia: [...bottle], T_K: diagnostics.pressurant?.bottle_T_K, phase: 'gas' },
      ox_tank: { label: 'LOX tank', kind: 'tank', side: 'ox', p_psia: [...s.ox.tank_psia], phase: 'liquid' },
      fuel_tank: { label: 'Fuel tank', kind: 'tank', side: 'fuel', p_psia: [...s.fuel.tank_psia], phase: 'liquid' },
      chamber: { label: 'Chamber', kind: 'chamber', side: null, p_psia: pc },
    },
    branches: {
      ox_line: { label: 'LOX line', kind: 'line', from: 'ox_tank', to: 'chamber', side: 'ox', mdot: [...s.ox.mdot], dp_psi: map(n, (i) => s.ox.outlet_psia[i] - s.ox.inlet_psia[i]) },
      fuel_line: { label: 'Fuel line', kind: 'line', from: 'fuel_tank', to: 'chamber', side: 'fuel', mdot: [...s.fuel.mdot], dp_psi: map(n, (i) => s.fuel.outlet_psia[i] - s.fuel.inlet_psia[i]) },
    },
    paths: { ox: ['ox_line'], fuel: ['fuel_line'] },
  };
  r.network = net;

  // ---- keyed events, flight stability series
  const keyOf = (e: ContractEvent): string | undefined => {
    if (e.kind === 't0') return 't0';
    if (e.kind === 'fire') return 'fire';
    if (/dry|ran out|empty/i.test(e.label)) return /lox|oxid/i.test(e.label) ? 'dry_ox' : 'dry_fuel';
    return undefined;
  };
  r.events = r.events.map((e) => ({ ...e, key: keyOf(e) ?? e.key }));
  r.events.push({ t: (t[fireIdx] ?? 0) + 0.14, kind: 'min', label: 'Ignition', detail: 'fixture', key: 'ignition' });
  if (r.flight?.ok) {
    const ft = r.flight.trajectory.t.filter((tt) => tt <= (r.flight?.apogee_time_s ?? 0));
    r.flight.stability = {
      ...(r.flight.stability ?? {}),
      t: ft, static_margin_cal: ft.map((tt) => 7.7 + 1.1 * Math.min(1, tt / 3.5) - 0.3 * Math.max(0, (tt - 3.5) / 20)),
      cg_m: ft.map((tt) => 2.1 - 0.12 * Math.min(1, tt / 3.5)), cp_m: ft.map(() => 3.2), max_q_pa: 182000, max_q_t: 3.1, rail_exit_m_s: r.flight.rail_exit_velocity_m_s,
    };
  }
  return r as unknown as LayerXResult;
}

/** The axial sidecar the Hardware page fetches, for a dev server without one. */
export function axialFixture(result: LayerXResult): { x_mm: number[]; t: number[]; q_MW_m2: number[][]; T_wall_K: number[][] } {
  const t = (result.replay?.t ?? result.series.t).filter((x) => x >= 0);
  const x = Array.from({ length: 60 }, (_, k) => -160 + k * 4.6);
  const q = t.map((tt) => x.map((xx) => 2 + 9 * Math.exp(-((xx / 25) ** 2)) * (1 - 0.1 * tt / 4)));
  const T = t.map((tt) => x.map((xx) => 300 + (1500 + 800 * Math.exp(-((xx / 30) ** 2))) * (1 - Math.exp(-tt / 1.2))));
  return { x_mm: x, t, q_MW_m2: q, T_wall_K: T };
}
