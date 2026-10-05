import type { LayerXResult, RunView, SweepResult } from '../../api/layerx';
import { fmt, PSI, VERDICT } from './format';

/**
 * A run as the test card a stand operator and a reviewer read: what to dial, what each channel
 * should read and when, the lines not to cross, and what the numbers leave out. A plain page
 * (light, print-ready), opened in its own window so it can be printed or saved as PDF.
 */

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export function testCardHtml(result: LayerXResult, run: RunView, channels: Record<string, string>, sweep?: SweepResult | null): string {
  const p = result.provenance;
  const d = (p.derived ?? {}) as Record<string, unknown>;
  const s = result.series;
  const sum = result.summary;
  const dv = result.delivered?.summary;
  const gauge = (typeof d.gauge_zero_pa === 'number' ? (d.gauge_zero_pa as number) : 101325) / PSI;
  const ambient = (typeof d.ambient_pa === 'number' ? (d.ambient_pa as number) : 101325) / PSI;
  const lockup = d.target_lockup_psia as number | undefined;
  const roles = (d.roles ?? {}) as Record<string, string>;
  const mawp = (d.tank_mawp_psi ?? {}) as Record<string, number>;
  const loads = (d.loads_kg ?? {}) as Record<string, number>;
  const band = (b: number[] | null | undefined) => b?.[0] ?? VERDICT.stiffnessFloor;
  const stiff = (d.stiffness_band ?? {}) as Record<string, number[] | null>;
  const at = (values: number[], t: number) => {
    let k = 0;
    while (k < s.t.length - 1 && s.t[k + 1] <= t + 1e-9) k++;
    return values[k];
  };
  const fire = s.firing.findIndex(Boolean);
  const times: [string, number][] = [['T−0', -1], ['T+0.5 s', 0.5], ['T+1 s', 1], ['T+2 s', 2], ['Burnout', Infinity]];
  const value = (values: number[], t: number) => (t === -1 ? values[Math.max(fire - 1, 0)] : t === Infinity ? values[values.length - 1] : at(values, t));
  const instruments = Object.entries(s.instruments ?? {});
  const band2 = (k: keyof NonNullable<SweepResult['band_low']>, scale = 1, digits = 0) => {
    const lo = sweep?.band_low?.[k] ?? sweep?.band?.[k];
    const hi = sweep?.band_high?.[k] ?? sweep?.band?.[k];
    return lo == null || hi == null ? '' : ` <span class="m">−${fmt(lo * scale, digits)} / +${fmt(hi * scale, digits)}</span>`;
  };
  const reproduce = (p as unknown as { reproduce?: { code?: string } }).reproduce;
  const pcMean = dv?.pc_mean_psia ?? sum.pc_mean_psia ?? 0;

  const rows: string[] = instruments.map(([id, ins]) => {
    const isT = ins.unit === 'K';
    const vals = isT ? ins.values : ins.values.map((v) => v - gauge);
    return `<tr><td>${esc(ins.tag)}</td><td>${esc(channels[id] ?? '—')}</td><td class="u">${isT ? 'K' : 'psig'}</td>`
      + times.map(([, t]) => `<td class="n">${fmt(value(vals, t), isT ? 1 : 0)}</td>`).join('') + '</tr>';
  });
  // The eroding engine's thrust where the replay ran, as the headline has it; the feed model's otherwise.
  const thrust = s.t.map((_, i) => (s.firing[i] ? s.chamber.thrust_N[i] : 0));
  const replayed = result.delivered?.thrust_N;
  if (replayed) {
    let k = 0;
    s.firing.forEach((f, i) => { if (f) thrust[i] = replayed[k++] ?? thrust[i]; });
  }
  rows.push(`<tr><td>Thrust</td><td>sum of LC_*</td><td class="u">N</td>${times.map(([, t]) => `<td class="n">${fmt(value(thrust, t), 0)}</td>`).join('')}</tr>`);

  const redlines: string[] = [];
  for (const [side, label] of [['oxidiser', 'LOX tank'], ['fuel', 'Fuel tank']] as const) {
    const rating = mawp[roles[side]];
    const peak = (side === 'oxidiser' ? sum.ox : sum.fuel).peak_psia;
    if (rating) redlines.push(`<tr><td>${label}</td><td class="n">${fmt(rating + ambient - gauge, 0)} psig</td><td>MAWP ${fmt(rating, 0)} psi on the drawing${peak ? `; expected peak ${fmt(peak - gauge, 0)} psig` : ''}</td></tr>`);
  }
  if (lockup) redlines.push(`<tr><td>Bottle</td><td class="n">≥ ${fmt(lockup - gauge + VERDICT.copvHeadroomPsi, 0)} psig</td><td>${VERDICT.copvHeadroomPsi} psi above lockup, or the regulator stops holding tank pressure; expected at burnout ${fmt((sum.copv_end_psia ?? NaN) - gauge, 0)} psig</td></tr>`);
  for (const [side, label, key] of [['oxidiser', 'LOX injector inlet', 'ox'], ['fuel', 'Fuel injector inlet', 'fuel']] as const) {
    const floor = band(stiff[side]);
    const min = (key === 'ox' ? sum.ox : sum.fuel).dp_injector_min_psi;
    redlines.push(`<tr><td>${label}</td><td class="n">≥ ${fmt(pcMean * (1 + floor) - gauge, 0)} psig</td><td>ΔP/Pc floor ${fmt(floor * 100, 0)} % at ${fmt(pcMean, 0)} psia chamber (chug); expected lowest ΔP ${fmt(min, 0)} psi</td></tr>`);
  }
  if (dv?.chug_margin_min != null) redlines.push(`<tr><td>Chug margin</td><td class="n">&gt; 1</td><td>predicted lowest ${fmt(dv.chug_margin_min, 2)} at ${fmt(dv.chug_margin_min_t ?? NaN, 2)} s</td></tr>`);

  const settings = p.settings;
  const off = [!settings.ullage_collapse && 'ullage collapse', !settings.ullage_vapour && 'propellant vapour', !settings.line_walls && 'line-wall heat'].filter(Boolean);
  const when = new Date(run.started * 1000).toLocaleString('en-US');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Test card · ${esc(p.drawing.name)} · ${esc(run.meta?.name || when)}</title>
<style>
body{font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;margin:28px;max-width:960px}
h1{font-size:20px;margin:0 0 2px} h2{font-size:14px;margin:22px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}
.m{color:#666} table{border-collapse:collapse;width:100%} td,th{padding:3px 8px 3px 0;text-align:left;vertical-align:top}
th{font-weight:500;color:#555;border-bottom:1px solid #ddd} .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.u{color:#666} .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 24px} .big{font-size:18px;font-weight:600}
@media print{body{margin:12mm} button{display:none}}
</style></head><body>
<button onclick="window.print()" style="float:right">Print / save as PDF</button>
<h1>Test card: ${esc(p.drawing.name)}</h1>
<div class="m">${esc(run.meta?.name ? `${run.meta.name} · ` : '')}run ${esc(run.id)} · ${esc(when)} · design ${esc(p.config_sha256.slice(0, 12))} · drawing ${esc(p.drawing.sha256?.slice(0, 12) ?? '')}${reproduce?.code ? ` · code ${esc(reproduce.code)}` : ''}${result.flight?.ok ? ' · flown' : ' · on the pad'}</div>
${run.meta?.note ? `<p>${esc(run.meta.note)}</p>` : ''}

<h2>Set</h2>
<div class="grid">
<div>Dome regulator<div class="big">${fmt(d.dome_psig as number, 1)} psig</div></div>
<div>Tank lockup<div class="big">${fmt((lockup ?? NaN) - gauge, 1)} psig</div><span class="m">${fmt(lockup, 1)} psia</span></div>
<div>Bottle fill<div class="big">${fmt(d.copv_psig as number, 0)} psig</div><span class="m">${esc(settings.pressurant ?? 'as drawn')}</span></div>
<div>LOX load<div class="big">${fmt(loads[roles.oxidiser], 2)} kg</div></div>
<div>Fuel load<div class="big">${fmt(loads[roles.fuel], 2)} kg</div></div>
<div>Unusable propellant<div class="big">${fmt(settings.dry_kg, 3)} kg</div><span class="m">${(settings.dry_kg ?? 0) <= 0.002 ? 'burnt dry (not measured)' : 'as weighed'}</span></div>
</div>

<h2>Expect${sweep ? ' <span class="m">(spread from the uncertainty sweep)</span>' : ''}</h2>
<div class="grid">
<div>Burn time<div class="big">${fmt(sum.burn_time_s, 2)} s${band2('burn_time_s', 1, 2)}</div><span class="m">${sum.depleted_side === 'oxidiser' ? 'LOX' : 'fuel'} runs dry first</span></div>
<div>Total impulse<div class="big">${fmt((dv?.total_impulse_Ns ?? sum.total_impulse_Ns) / 1000, 2)} kN·s${band2('total_impulse_Ns', 1e-3, 2)}</div></div>
<div>Mean thrust<div class="big">${fmt(dv?.mean_thrust_N ?? sum.mean_thrust_N, 0)} N${band2('mean_thrust_N')}</div></div>
<div>Chamber<div class="big">${fmt(pcMean, 0)} psia</div></div>
<div>O/F<div class="big">${fmt(sum.of_mean, 3)}${band2('of_mean', 1, 3)}</div></div>
<div>Isp<div class="big">${fmt(dv?.isp_mean_s ?? sum.isp_mean_s, 1)} s</div></div>
</div>

<h2>Each channel</h2>
<table><tr><th>On the drawing</th><th>DAQ</th><th></th>${times.map(([l]) => `<th class="n">${l}</th>`).join('')}</tr>${rows.join('')}</table>

<h2>Lines not to cross</h2>
<table><tr><th>Where</th><th class="n">Limit</th><th>Why, and what is expected</th></tr>${redlines.join('')}</table>

<h2>Not in these numbers</h2>
<p>Start transient (−0.7 to −1.5 % impulse)${(settings.dry_kg ?? 0) <= 0.002 ? '; propellant the sump keeps (burnt dry here)' : ''}${off.length ? `; run without ${off.join(', ')}` : ''}. Pressures are gauge at ${fmt(gauge, 2)} psia; the stand's atmosphere is ${fmt(ambient, 2)} psia.</p>
</body></html>`;
}
