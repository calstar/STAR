import type { LayerXResult, SideSeries } from '../../../../api/layerx';

/**
 * A synthetic burn on the stand drawing, shaped like a real one (bottle 4,500 psia falling, a
 * regulated 578 psia, LOX and fuel tanks sagging and draining, Fire at t = 0), with numbers chosen
 * so each one is distinguishable in a test: every column says which quantity it is.
 * `network: true` adds a DATA-CONTRACT §2 network on the drawing's ids.
 */
export function standResult({ n = 21, network = false, diagnostics = false }: { n?: number; network?: boolean; diagnostics?: boolean } = {}): LayerXResult {
  const t = Array.from({ length: n }, (_, i) => -0.5 + i * 0.25);
  const firing = t.map((x) => x > 0);
  const lin = (a: number, b: number) => t.map((_, i) => a + ((b - a) * i) / (n - 1));
  const fire = (v: number) => firing.map((f) => (f ? v : 0));
  const side = (k: number, liquid0: number): SideSeries => ({
    tank_psia: lin(578 - k, 560 - k),
    outlet_psia: lin(579 - k, 561 - k),
    inlet_psia: firing.map((f, i) => (f ? 540 - k - i * 0.1 : 14.7)),
    dump_psi: fire(1),
    manifold_psia: firing.map((f) => (f ? 515 - k : 14.7)),
    dp_injector_psi: fire(120),
    stiffness: fire(0.3),
    mdot: fire(k === 0 ? 1.9 : 1.3),
    liquid_kg: t.map((_, i) => (firing[i] ? liquid0 * (1 - (i - n / 4) / n) : liquid0)),
    ullage_K: lin(293, 275 - k),
    liquid_K: lin(90 + k * 200, 91 + k * 200),
    fill_fraction: lin(0.38, 0.05),
  });
  const series = {
    t, firing, converged: t.map(() => true),
    copv_psia: lin(4510, 1600),
    copv_mass_kg: lin(0.9, 0.3),
    copv_wall_K: lin(293, 280),
    regulators: { PR_D: { label: 'PR-DOME', outlet_psia: t.map(() => 590) } },
    ox: side(0, 6.6),
    fuel: side(3, 4.4),
    chamber: { pc_psia: fire(396), mr: fire(1.45), thrust_N: fire(6970), isp_s: fire(224), cstar: fire(1570), extrapolated: fire(0) },
    instruments: { PT_OXU: { tag: 'PT-OX-UP', type: 'PT', unit: 'psia' as const, values: lin(578, 560) } },
  };
  const result = {
    series,
    summary: {} as LayerXResult['summary'],
    events: [],
    checks: [],
    provenance: {
      derived: { roles: { oxidiser: 'OXT', fuel: 'FUT' }, copv_id: 'KB1', dome_psig: 514, gauge_zero_pa: 101325, loads_kg: { OXT: 6.6, FUT: 4.4 } },
    } as unknown as LayerXResult['provenance'],
  } as unknown as LayerXResult & { network?: unknown; diagnostics?: unknown };
  if (network) {
    const node = (p: number, T: number, phase: 'gas' | 'liquid' = 'gas', kind = 'junction') => ({ kind, phase, p_psia: t.map(() => p), T_K: t.map(() => T) });
    const branch = (from: string, to: string, mdot: number, extra: Record<string, unknown> = {}) =>
      ({ kind: 'line', from, to, mdot: t.map(() => mdot), dp_psi: t.map(() => 0.5), ...extra });
    result.network = {
      t,
      nodes: {
        KB1: node(4000, 250, 'gas', 'bottle'), MF1: node(3990, 251), 'PR_D.in': node(3980, 252), 'PR_D.out': node(600, 240), MF2: node(598, 241),
        'SV_LOX_PRESS.in': node(597, 242), 'SV_LOX_PRESS.out': node(581, 243), OXT: node(580, 260, 'gas', 'tank'), 'OXT.liquid': node(585, 91, 'liquid', 'tank'),
        'MVO.in': node(570, 92, 'liquid'), 'MVO.out': node(560, 92, 'liquid'), 'ENG.oxidiser': node(550, 92, 'liquid'), 'ENG.chamber': node(400, 3300, 'gas', 'chamber'),
      },
      branches: {
        l_kb: branch('KB1', 'MF1', 0.031), l_reg: branch('MF1', 'PR_D.in', 0.030),
        PR_D: { kind: 'regulator', from: 'PR_D.in', to: 'PR_D.out', mdot: t.map(() => 0.03), dp_psi: t.map(() => 3380) },
        l_reg_out: branch('PR_D.out', 'MF2', 0.029), l_oxpress_in: branch('MF2', 'SV_LOX_PRESS.in', 0.017),
        SV_LOX_PRESS: { kind: 'solenoid', from: 'SV_LOX_PRESS.in', to: 'SV_LOX_PRESS.out', mdot: t.map(() => 0.017), state: t.map((x) => (x > 0 ? 1 : 0)) },
        l_oxpress: branch('SV_LOX_PRESS.out', 'OXT', 0.017),
        l_ox1: branch('OXT.liquid', 'MVO.in', 1.95), MVO: { kind: 'valve', from: 'MVO.in', to: 'MVO.out', mdot: t.map(() => 1.95), state: t.map(() => 1) },
        l_ox2: branch('MVO.out', 'ENG.oxidiser', 1.95),
      },
    };
  }
  if (diagnostics) {
    result.diagnostics = {
      saturation: { nodes: [{ id: 'OXT.liquid', label: 'LOX tank', side: 'ox', margin_psi: t.map(() => 420), min_psi: 420, t_min: 0 }] },
      regulator: { t: t.filter((x) => x >= 0), use_frac: t.filter((x) => x >= 0).map(() => 0.62) },
    };
  }
  return result;
}
