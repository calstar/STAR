import type { LayerXResult } from '../../api/layerx';
import { G0 } from './format';

/**
 * A Layer X burn as CSV: one row per step from the lead-in to the end, every quantity the burn
 * recorded, units in the headers, and what produced it in `#` lines above. The eroding engine's
 * columns (from the replay) and the flight's acceleration are on the same rows, blank before Fire.
 */

type Col = { name: string; get: (i: number) => number | boolean | null | undefined };

function cell(v: number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return Number.isFinite(v) ? String(Number(v.toPrecision(7))) : '';
}

export function burnCsv(result: LayerXResult, runId = ''): string {
  const s = result.series;
  const dv = result.delivered;
  const firing = new Map<number, number>();
  let k = 0;
  s.firing.forEach((f, i) => { if (f) firing.set(i, k++); });
  const fromReplay = (col: (number | null)[] | null | undefined) => (i: number) => {
    const j = firing.get(i);
    return j === undefined || !col ? undefined : col[j];
  };
  const flight = result.flight?.ok ? result.flight : null;
  // The flight's acceleration on each step: one pass, since the rows are in time order.
  const accelAt: (number | undefined)[] = new Array(s.t.length).fill(undefined);
  if (flight) {
    const ts = flight.schedule.t;
    let j = 0;
    for (let i = 0; i < s.t.length; i++) {
      if (!s.firing[i]) continue;
      while (j < ts.length - 1 && ts[j + 1] <= s.t[i] + 1e-9) j++;
      accelAt[i] = flight.schedule.accel_m_s2[j] / G0;
    }
  }
  const accel = (i: number) => accelAt[i];
  // A header is a bare name: a regulator id with a comma or a quote must not break the columns.
  const safe = (name: string) => name.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  const side = (p: 'ox' | 'fuel', name: string): Col[] => [
    { name: `${name}_tank_psia`, get: (i) => s[p].tank_psia[i] },
    { name: `${name}_injector_psia`, get: (i) => s[p].manifold_psia?.[i] },
    { name: `${name}_injector_dp_psi`, get: (i) => s[p].dp_injector_psi?.[i] },
    { name: `${name}_dp_over_pc`, get: (i) => s[p].stiffness[i] },
    { name: `${name}_mdot_kg_s`, get: (i) => s[p].mdot[i] },
    { name: `${name}_liquid_kg`, get: (i) => s[p].liquid_kg[i] },
    { name: `${name}_ullage_K`, get: (i) => s[p].ullage_K[i] },
  ];
  const cols: Col[] = [
    { name: 't_s', get: (i) => s.t[i] },
    { name: 'firing', get: (i) => s.firing[i] },
    { name: 'bottle_psia', get: (i) => s.copv_psia[i] },
    { name: 'bottle_kg', get: (i) => s.copv_mass_kg[i] },
    ...Object.entries(s.regulators).map(([id, r]) => ({ name: `${safe(id)}_outlet_psia`, get: (i: number) => r.outlet_psia[i] })),
    ...side('ox', 'lox'),
    ...side('fuel', 'fuel'),
    { name: 'pc_psia', get: (i) => (s.firing[i] ? s.chamber.pc_psia[i] : undefined) },
    { name: 'of', get: (i) => (s.firing[i] ? s.chamber.mr[i] : undefined) },
    { name: 'thrust_N_as_built', get: (i) => (s.firing[i] ? s.chamber.thrust_N[i] : undefined) },
  ];
  if (dv) {
    cols.push(
      { name: 'thrust_N', get: fromReplay(dv.thrust_N) },
      { name: 'pc_psia_eroding', get: fromReplay(dv.pc_psia) },
      { name: 'isp_s', get: fromReplay(dv.isp_s) },
      { name: 'throat_area_ratio', get: fromReplay(dv.throat_area_ratio) },
      { name: 'throat_recession_mm', get: fromReplay(dv.recession_throat_mm) },
      { name: 'exit_psia', get: fromReplay(dv.p_exit_psia) },
      { name: 'ambient_psia', get: fromReplay(dv.ambient_psia) },
      { name: 'chamber_gas_K', get: fromReplay(dv.tc_K) },
      { name: 'exit_gas_K', get: fromReplay(dv.t_exit_K) },
      { name: 'chug_gain_margin', get: fromReplay(dv.chug_margin) },
    );
  }
  if (flight) cols.push({ name: 'accel_on_liquids_g', get: accel });

  const p = result.provenance;
  const settings = p.settings as unknown as Record<string, unknown>;
  const head = [
    `# Layer X burn${runId ? ` ${runId}` : ''}: drawing ${(p.drawing?.name ?? '-').replace(/[\r\n]+/g, ' ')}, design ${p.config_sha256?.slice(0, 12) ?? '-'}`,
    `# tanks ${p.derived?.target_lockup_psia ?? '-'} psia, bottle ${p.derived?.copv_psig ?? '-'} psig, `
      + `step ${settings.dt ?? '-'} s, erosion ${settings.replay === false ? 'off' : 'on'}, ${flight ? 'flown' : 'on the pad'}`,
    '# pressures absolute (psia) except dp; t = 0 at Fire; thrust_N is the eroding engine where it ran, thrust_N_as_built the feed model\'s',
  ];
  const lines = [...head, cols.map((c) => c.name).join(',')];
  for (let i = 0; i < s.t.length; i++) lines.push(cols.map((c) => cell(c.get(i))).join(','));
  return lines.join('\n') + '\n';
}
