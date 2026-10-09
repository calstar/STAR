import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceArea, ReferenceLine,
} from 'recharts';
import type { LayerXResult, Series, Summary, BurnEvent, CrossCheck, Provenance, Calibration, EngineCheck, Delivered, Replay, ReplayPass } from '../../api/layerx';
import { useViewState } from '../../lib/viewState';
import { Hint } from '../Hint';
import { fmt, niceTicks, sig, stepDigits, FT, LOX, FUEL, PSI, VERDICT } from './format';
import { FeedFitSummary, FeedFitView } from './FeedFit';
import { FeedSchematic } from './FeedSchematic';
import type { NozzleState } from './plume';
import { FlightSummary, FlightView } from './Flight';
import { MeasuredView } from './Measured';

/**
 * A Layer X burn, as pages:
 *
 *   Summary      pass or fail against every limit, the figures, the hardware animated
 *   Plots        everything over the burn, on one shared cursor
 *   Flight       when flown
 *   Stand        the test card and the DAQ comparison
 *   Uncertainty  the sweep of the unmeasured inputs
 *   Details      the run's name and note, what is left out, the injector feed, events, erosion,
 *                the engine fit, Forward mode's feed losses, provenance
 *
 * Everything shown is computed by engine/layerx; this lays it out.
 */

const SANS = { fontFamily: 'Inter, system-ui, sans-serif' };
const REG = '#c4b5fd';
const CHAMBER = 'var(--color-text-primary)';
const OK = 'var(--color-success)';
const WARN = 'var(--color-warning)';
const BAD = 'var(--color-danger)';

const axisTick = { fill: 'var(--color-text-muted)', fontSize: 10 };
const tooltipStyle = { background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 11 };

function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h3 className="text-[13px] font-medium text-[var(--color-text-primary)]">{children}</h3>
      {aside}
    </div>
  );
}

// ------------------------------------------------------------------ figures

type Cell = { label: string; value: string; unit: string; sub: string; hint: string; num?: number | null; digits?: number; delta?: string };

function figureCells(s: Summary, delivered?: Delivered | null, apogee?: number | null): Cell[] {
  const dry = s.depleted_side === 'oxidiser' ? 'LOX ran out' : s.depleted_side === 'fuel' ? 'fuel ran out' : 'still burning at the horizon';
  // The replay's numbers when there is one (EngineDesign's engine, throat eroding); the twin's otherwise.
  const d = delivered?.summary;
  const impulse = (d?.total_impulse_Ns ?? s.total_impulse_Ns) / 1000;
  const cells: Cell[] = [
    { label: 'Burn time', value: fmt(s.burn_time_s, 2), unit: 's', sub: dry, num: s.burn_time_s, digits: 2,
      hint: 'Fire to the first tank running dry.' },
    { label: 'Total impulse', value: fmt(impulse, 2), unit: 'kN·s', num: impulse, digits: 2,
      sub: `${fmt(d?.propellant_burned_kg ?? s.propellant_used_kg, 2)} kg burned`, hint: 'Thrust over the whole burn.' },
    { label: 'Mean thrust', value: fmt(d?.mean_thrust_N ?? s.mean_thrust_N, 0), unit: 'N', num: d?.mean_thrust_N ?? s.mean_thrust_N, digits: 0,
      sub: `${fmt(d?.min_thrust_N ?? s.min_thrust_N, 0)}–${fmt(d?.peak_thrust_N ?? s.peak_thrust_N, 0)}`, hint: 'Lowest and highest over the burn.' },
    { label: 'Chamber', value: fmt(d?.pc_mean_psia ?? s.pc_mean_psia, 0), unit: 'psia', num: d?.pc_mean_psia ?? s.pc_mean_psia, digits: 1,
      sub: `${fmt(d?.pc_min_psia ?? s.pc_min_psia, 0)}–${fmt(d?.pc_max_psia ?? s.pc_max_psia, 0)}`, hint: 'Chamber pressure, after ignition.' },
    { label: 'O/F', value: fmt(s.of_mean, 3), unit: '', sub: `${fmt(s.of_min, 2)}–${fmt(s.of_max, 2)}`, num: s.of_mean, digits: 3,
      hint: 'LOX burned over fuel burned.' },
    { label: 'Isp', value: fmt(d?.isp_mean_s ?? s.isp_mean_s, 1), unit: 's', num: d?.isp_mean_s ?? s.isp_mean_s, digits: 1,
      sub: d?.throat_area_growth != null ? `throat +${fmt(d.throat_area_growth * 100, 1)} %` : '', hint: 'Delivered, over the burn.' },
  ];
  if (apogee !== undefined && apogee !== null) {
    cells.push({ label: 'Apogee', value: fmt(apogee * FT, 0), unit: 'ft', num: apogee * FT, digits: 0,
                 sub: `${fmt(apogee, 0)} m AGL`, hint: 'Flown: vertical, windless, from the delivered thrust and flows.' });
  }
  return cells;
}

/** The figures, each with its change against the compared burn when there is one. */
function withDeltas(cells: Cell[], ref: Cell[] | null): Cell[] {
  if (!ref) return cells;
  return cells.map((c) => {
    const r = ref.find((x) => x.label === c.label);
    if (!r || c.num == null || r.num == null || !Number.isFinite(c.num) || !Number.isFinite(r.num)) return c;
    const dv = c.num - r.num;
    const pct = r.num !== 0 ? (dv / Math.abs(r.num)) * 100 : null;
    // Below the figure's own last digit, and under 0.05 %, it is the same number.
    const same = Math.abs(dv) < 0.5 * 10 ** -(c.digits ?? 0) && (pct === null || Math.abs(pct) < 0.05);
    return { ...c, delta: same ? 'same' : `${dv >= 0 ? '+' : '−'}${fmt(Math.abs(dv), c.digits ?? 0)}${pct !== null ? ` (${dv >= 0 ? '+' : '−'}${fmt(Math.abs(pct), 1)} %)` : ''}` };
  });
}

function Figures({ cells }: { cells: Cell[] }) {
  return (
    <div className="grid gap-x-6 gap-y-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(8.5rem, 1fr))' }}>
      {cells.map((c) => (
        <div key={c.label} className="min-w-0">
          <Hint text={c.hint}><span className="text-[12px] text-[var(--color-text-secondary)]">{c.label}</span></Hint>
          <div className="mt-1 flex items-baseline gap-1 whitespace-nowrap">
            <span className="text-[1.6rem] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-text-primary)]">{c.value}</span>
            {c.unit && <span className="text-[12px] text-[var(--color-text-muted)]">{c.unit}</span>}
          </div>
          {c.sub && <div className="mt-1.5 truncate text-[11px] tabular-nums text-[var(--color-text-muted)]" title={c.sub}>{c.sub}</div>}
          {c.delta && <div className="mt-0.5 truncate text-[11px] tabular-nums text-[var(--color-accent)]">{c.delta}</div>}
        </div>
      ))}
    </div>
  );
}

/** What the figures leave out: each term the model does not carry, and the thermal models this
 * burn ran without (feed-twin's cockpit runs with them on, so the two answer differently). */
function leftOut(settings: Provenance['settings']): { off: string[]; terms: string[]; dry: boolean } {
  const off = [
    !settings.ullage_collapse && 'ullage collapse',
    !settings.ullage_vapour && 'propellant vapour',
    !settings.line_walls && 'line-wall heat',
  ].filter(Boolean) as string[];
  const dry = (settings.dry_kg ?? 0.001) <= 0.002;
  const terms = [
    'The start transient: −0.7 to −1.5 % impulse.',
    ...(dry ? ['Propellant the sump keeps: burnt dry here; −1.5 to −2.7 % impulse if 0.2 kg stays behind. Enter a weighed residual under Advanced → Unusable propellant.'] : []),
  ];
  return { off, terms, dry };
}

// ------------------------------------------------------------------ limits

type Grade = 'ok' | 'warn' | 'bad';
const GRADE_COLOR: Record<Grade, string> = { ok: OK, warn: WARN, bad: BAD };
// Shape as well as colour: a red-green reader still sees which one failed.
const GRADE_MARK: Record<Grade, string> = { ok: '✓', warn: '!', bad: '✗' };
const GRADE_WORD: Record<Grade, string> = { ok: 'within limits', warn: 'worth a look', bad: 'fails' };

type VerdictItem = { label: string; value: string; grade: Grade; hint: string; limit: string };

/** What the limits read beyond the summary: the replay's chug margin, the drawing's ratings, the
 * run's own health. */
interface VerdictContext {
  chug?: { min: number | null | undefined; t: number | null | undefined } | null;
  /** psi across the wall, per side, from the drawing; and the site's atmosphere [psia]. */
  mawp?: { oxidiser?: number; fuel?: number; ambientPsia: number } | null;
  converged?: boolean;
  cardOutside?: number | null;
}

/** Every limit the burn is graded against, most consequential first. */
function verdictItems(s: Summary, band: Record<string, number[] | null> | undefined, engine?: EngineCheck, ctx: VerdictContext = {}): VerdictItem[] {
  const stiff = (v: number | null, b: number[] | null | undefined): Grade =>
    v === null ? 'warn' : b ? (v < b[0] ? 'bad' : v > b[1] ? 'warn' : 'ok') : v < VERDICT.stiffnessFloor ? 'bad' : 'ok';
  const stiffLimit = (b: number[] | null | undefined) => (b ? `${fmt(b[0] * 100)}–${fmt(b[1] * 100)} %` : `≥ ${fmt(VERDICT.stiffnessFloor * 100)} %`);
  const bandText = (b: number[] | null | undefined) => (b ? `the design's band is ${fmt(b[0] * 100)}–${fmt(b[1] * 100)} %` : `the design sets no band, so it is graded against ${fmt(VERDICT.stiffnessFloor * 100)} %`);
  const lockup = Math.max(s.ox.t0_psia, s.fuel.t0_psia);
  const copvMargin = s.copv_end_psia !== null ? s.copv_end_psia - lockup : null;
  const residual = s.depleted_side === 'oxidiser' ? s.fuel.residual_kg : s.depleted_side === 'fuel' ? s.ox.residual_kg : null;
  const tie = VERDICT.depletionTie * (s.ox.loaded_kg + s.fuel.loaded_kg);
  const droop = Math.max(s.ox.t0_psia - (s.ox.min_psia ?? s.ox.t0_psia), s.fuel.t0_psia - (s.fuel.min_psia ?? s.fuel.t0_psia));
  const engineGap = engine?.available && engine.worst
    ? Math.max(engine.worst.pc, engine.worst.mdot_O, engine.worst.mdot_F, engine.against === 'replay' ? 0 : engine.worst.thrust) : null;
  const first = s.depleted_side === 'oxidiser' ? 'LOX' : s.depleted_side === 'fuel' ? 'Fuel' : null;
  return [
    ...(ctx.chug && ctx.chug.min != null && Number.isFinite(ctx.chug.min) ? [{
      label: 'Chug margin', value: fmt(ctx.chug.min, 2),
      grade: (ctx.chug.min < 1 ? 'bad' : ctx.chug.min < VERDICT.chugMarginWarn ? 'warn' : 'ok') as Grade, limit: '> 1',
      hint: `EngineDesign's feed-coupled gain margin, the lowest over the whole burn (at ${fmt(ctx.chug.t ?? NaN, 2)} s, ignition included), worst over the mixing-lag band. Below 1 the loop is predicted unstable; amber under ${VERDICT.chugMarginWarn}.` }] : []),
    { label: 'LOX injector ΔP/Pc', value: `${fmt((s.ox.stiffness_min ?? NaN) * 100, 1)} %`, grade: stiff(s.ox.stiffness_min, band?.oxidiser),
      limit: stiffLimit(band?.oxidiser),
      hint: `Lowest injector pressure drop over chamber pressure through the burn; ${bandText(band?.oxidiser)}. Too low invites chug.` },
    { label: 'Fuel injector ΔP/Pc', value: `${fmt((s.fuel.stiffness_min ?? NaN) * 100, 1)} %`, grade: stiff(s.fuel.stiffness_min, band?.fuel),
      limit: stiffLimit(band?.fuel),
      hint: `Lowest injector pressure drop over chamber pressure through the burn; ${bandText(band?.fuel)}.` },
    ...(['oxidiser', 'fuel'] as const).flatMap((side) => {
      const peak = (side === 'oxidiser' ? s.ox : s.fuel).peak_psia;
      const rating = ctx.mawp?.[side];
      if (peak == null || rating == null || !ctx.mawp) return [];
      const across = peak - ctx.mawp.ambientPsia;
      const use = across / rating;
      return [{ label: `${side === 'oxidiser' ? 'LOX' : 'Fuel'} tank peak`, value: `${fmt(across, 0)} psi`,
        grade: (use > 1 ? 'bad' : use > VERDICT.ratingUse ? 'warn' : 'ok') as Grade, limit: `≤ ${fmt(rating, 0)} psi MAWP`,
        hint: `Highest pressure across the wall over the hold and the burn: ${fmt(use * 100, 0)} % of the drawing's MAWP (amber above ${fmt(VERDICT.ratingUse * 100, 0)} %).` }];
    }),
    { label: 'Bottle at burnout', value: copvMargin === null ? '—' : `${fmt(copvMargin, 0)} psi`,
      grade: copvMargin === null ? 'warn' : copvMargin < VERDICT.copvHeadroomPsi ? 'bad' : copvMargin < 2 * VERDICT.copvHeadroomPsi ? 'warn' : 'ok',
      limit: `≥ ${VERDICT.copvHeadroomPsi} psi over lockup`,
      hint: `How far the bottle is above the tanks' lockup when the burn ends (${fmt(s.copv_end_psia, 0)} psia). Under ${VERDICT.copvHeadroomPsi} psi the regulator stops holding tank pressure; amber under ${2 * VERDICT.copvHeadroomPsi}.` },
    { label: 'Tank pressure sag', value: `${fmt(droop, 1)} psi`, grade: droop > VERDICT.droopPsi[1] ? 'bad' : droop > VERDICT.droopPsi[0] ? 'warn' : 'ok',
      limit: `< ${VERDICT.droopPsi[0]} psi`,
      hint: `Deepest dip below the set tank pressure while firing (amber over ${VERDICT.droopPsi[0]}, red over ${VERDICT.droopPsi[1]} psi).` },
    ...(residual !== null && first ? [{
      // Which tank runs dry first is decided inside the injector's own scatter when the other is
      // within a few percent: say so rather than grade a 0.4 % margin green.
      label: 'Runs dry first', value: `${first}, by ${fmt(residual, 2)} kg`, grade: (residual < tie ? 'warn' : 'ok') as Grade,
      limit: `clear by ≥ ${fmt(tie, 2)} kg`,
      hint: `Propellant still in the other tank when ${first === 'LOX' ? 'the LOX' : 'the fuel'} runs out. Under ${fmt(VERDICT.depletionTie * 100, 0)} % of the load (${fmt(tie, 2)} kg) the orifice Cd's ±3 % scatter decides which tank empties first: on the stand it may be the other one.` }] : []),
    ...(residual !== null && residual > VERDICT.residualKg ? [{
      label: 'Propellant left over', value: `${fmt(residual, 2)} kg`, grade: 'warn' as Grade, limit: `< ${VERDICT.residualKg} kg`,
      hint: 'Propellant carried to burnout and never burned: dead mass in flight.' }] : []),
    ...(ctx.converged === false ? [{
      label: 'Model', value: 'not settled', grade: 'warn' as Grade, limit: 'settled',
      hint: 'The erosion replay or the flight coupling did not settle, or the replay failed: thrust and Pc may be the as-built throat\'s. See Details → Events.' }] : []),
    ...(ctx.cardOutside ? [{
      label: 'Engine table', value: `${ctx.cardOutside} steps outside`, grade: 'warn' as Grade, limit: 'none outside',
      hint: 'The burn asked the engine table about points outside what it was fitted to; those steps are extrapolated.' }] : []),
    // Only when something is off: the model's own health lives under Details.
    ...(engineGap !== null && engineGap >= VERDICT.replayAgreement[0] ? [{
      label: 'Engine fit', value: `${fmt(engineGap * 100, 2)} % off`, grade: (engineGap < VERDICT.replayAgreement[1] ? 'warn' : 'bad') as Grade,
      limit: `< ${fmt(VERDICT.replayAgreement[0] * 100, 1)} %`,
      hint: 'The burn and EngineDesign disagree on chamber pressure or flow by this much. See Details → Engine fit.' }] : []),
    ...(s.failed_steps || !s.t0_settled ? [{
      label: 'Solver', value: s.failed_steps ? `${s.failed_steps} of ${s.steps} steps held` : 'did not settle', grade: 'warn' as Grade, limit: 'every step solved',
      hint: 'A step the solver could not close holds its last good flows.' }] : []),
  ];
}

function overall(items: VerdictItem[]): Grade {
  return items.some((v) => v.grade === 'bad') ? 'bad' : items.some((v) => v.grade === 'warn') ? 'warn' : 'ok';
}

const STATUS_CLASS: Record<Grade, string> = {
  ok: 'border-[var(--color-success)]/35 bg-[var(--color-success)]/[0.06]',
  warn: 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/[0.06]',
  bad: 'border-[var(--color-danger)]/50 bg-[var(--color-danger)]/10',
};

/** One line at the top: a failing burn must not look like a good one. */
function Status({ items }: { items: VerdictItem[] }) {
  const g = overall(items);
  const bad = items.filter((v) => v.grade === 'bad');
  const warn = items.filter((v) => v.grade === 'warn');
  const title = g === 'bad' ? `Breaks ${bad.length} limit${bad.length > 1 ? 's' : ''}`
    : g === 'warn' ? `Within limits, ${warn.length} to check` : `Within all ${items.length} limits`;
  const which = (g === 'bad' ? bad : g === 'warn' ? warn : []).map((v) => `${v.label} ${v.value}`).join(' · ');
  return (
    <div role={g === 'bad' ? 'alert' : 'status'} className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border px-4 py-3 ${STATUS_CLASS[g]}`}>
      <span className="text-[15px] font-semibold" style={{ color: GRADE_COLOR[g] }}>{GRADE_MARK[g]} {title}</span>
      {which && <span className="text-[13px] tabular-nums text-[var(--color-text-secondary)]">{which}</span>}
    </div>
  );
}

function Limits({ items }: { items: VerdictItem[] }) {
  return (
    <table className="w-full text-[13px] tabular-nums">
      <thead>
        <tr className="text-left text-[11px] text-[var(--color-text-muted)]">
          <th className="w-5 pb-1.5 font-normal"><span className="sr-only">Status</span></th>
          <th className="pb-1.5 font-normal">Check</th>
          <th className="pb-1.5 text-right font-normal">This burn</th>
          <th className="pb-1.5 pl-4 text-right font-normal">Limit</th>
        </tr>
      </thead>
      <tbody>
        {items.map((v) => (
          <tr key={v.label} className="border-t border-[var(--color-border)]/70">
            <td className="py-2 text-[12px] font-semibold" style={{ color: GRADE_COLOR[v.grade] }}>
              <span aria-label={GRADE_WORD[v.grade]}>{GRADE_MARK[v.grade]}</span>
            </td>
            <td className="py-2 pr-3"><Hint text={v.hint}><span className="text-[var(--color-text-secondary)]">{v.label}</span></Hint></td>
            <td className="whitespace-nowrap py-2 text-right font-medium" style={{ color: v.grade === 'ok' ? 'var(--color-text-primary)' : GRADE_COLOR[v.grade] }}>{v.value}</td>
            <td className="whitespace-nowrap py-2 pl-4 text-right text-[12px] text-[var(--color-text-muted)]">{v.limit}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ over the burn

interface MiniPlot {
  key: string;
  title: string;
  unit: string;
  digits: number;
  wide?: boolean;
  lines: { key: string; label: string; color: string; dash?: string; get: (s: Series, i: number) => number | undefined }[];
  band?: [number, number] | null;
  /** The least span the axis shows, from the data's middle: so noise is not drawn as drama. */
  minSpan?: (mid: number) => number;
}

function burnPlots(band: Record<string, number[] | null> | undefined, delivered?: Delivered | null, firingIndex?: Map<number, number>,
                   gaugeZeroPsia = 14.6959): MiniPlot[] {
  const firing = (s: Series, i: number, v: number) => (s.firing[i] ? v : undefined);
  // One shaded band on the shared ΔP/Pc plot: only when both sides have the same one.
  const bO = band?.oxidiser ?? null;
  const bF = band?.fuel ?? null;
  const b = bO && bF ? (JSON.stringify(bO) === JSON.stringify(bF) ? bO : null) : (bO ?? bF);
  // EngineDesign's delivered values, on the twin's firing steps, when the burn was replayed.
  const dv = (key: keyof Delivered, i: number): number | undefined => {
    const k = firingIndex?.get(i);
    const col = delivered?.[key] as number[] | undefined;
    return k === undefined || !col ? undefined : col[k];
  };
  const thrustLines: MiniPlot['lines'] = delivered
    ? [{ key: 'F', label: 'Thrust', color: CHAMBER, get: (_s, i) => dv('thrust_N', i) },
       { key: 'Ft', label: 'as built', color: 'var(--color-text-muted)', dash: '3 3', get: (s, i) => firing(s, i, s.chamber.thrust_N[i]) }]
    : [{ key: 'F', label: 'Thrust', color: CHAMBER, get: (s, i) => firing(s, i, s.chamber.thrust_N[i]) }];
  return [
    { key: 'press', title: 'Pressures', unit: 'psia', digits: 0, wide: true, minSpan: () => 50, lines: [
      { key: 'to', label: 'LOX tank', color: LOX, get: (s, i) => s.ox.tank_psia[i] },
      { key: 'io', label: 'LOX injector', color: LOX, dash: '4 3', get: (s, i) => firing(s, i, s.ox.manifold_psia[i]) },
      { key: 'tf', label: 'Fuel tank', color: FUEL, get: (s, i) => s.fuel.tank_psia[i] },
      { key: 'if', label: 'Fuel injector', color: FUEL, dash: '4 3', get: (s, i) => firing(s, i, s.fuel.manifold_psia[i]) },
      { key: 'pc', label: 'Chamber', color: CHAMBER, get: (s, i) => (delivered ? dv('pc_psia', i) : firing(s, i, s.chamber.pc_psia[i])) } ] },
    { key: 'thrust', title: 'Thrust', unit: 'N', digits: 0, minSpan: (m) => 0.1 * Math.abs(m), lines: thrustLines },
    { key: 'stiff', title: 'Injector ΔP / Pc', unit: '%', digits: 1, minSpan: () => 10, band: b ? [b[0] * 100, b[1] * 100] : null, lines: [
      { key: 'so', label: 'LOX', color: LOX, get: (s, i) => firing(s, i, s.ox.stiffness[i] * 100) },
      { key: 'sf', label: 'Fuel', color: FUEL, get: (s, i) => firing(s, i, s.fuel.stiffness[i] * 100) } ] },
    { key: 'flow', title: 'Propellant flow', unit: 'kg/s', digits: 3, minSpan: (m) => 0.2 * Math.abs(m), lines: [
      { key: 'mo', label: 'LOX', color: LOX, get: (s, i) => firing(s, i, s.ox.mdot[i]) },
      { key: 'mf', label: 'Fuel', color: FUEL, get: (s, i) => firing(s, i, s.fuel.mdot[i]) } ] },
    { key: 'of', title: 'O/F', unit: '', digits: 3, minSpan: () => 0.1, lines: [
      { key: 'mr', label: 'O/F', color: CHAMBER, get: (s, i) => firing(s, i, s.chamber.mr[i]) } ] },
    { key: 'inv', title: 'Propellant in tank', unit: 'kg', digits: 2, lines: [
      { key: 'lo', label: 'LOX', color: LOX, get: (s, i) => s.ox.liquid_kg[i] },
      { key: 'lf', label: 'Fuel', color: FUEL, get: (s, i) => s.fuel.liquid_kg[i] } ] },
    { key: 'copv', title: 'Bottle', unit: 'psig', digits: 0, lines: [
      { key: 'cp', label: 'Bottle', color: REG, get: (s, i) => s.copv_psia[i] - gaugeZeroPsia } ] },
    { key: 'ullage', title: 'Gas in the tank', unit: 'K', digits: 0, minSpan: () => 20, lines: [
      { key: 'uo', label: 'LOX', color: LOX, get: (s, i) => s.ox.ullage_K[i] },
      { key: 'uf', label: 'Fuel', color: FUEL, get: (s, i) => s.fuel.ullage_K[i] } ] },
    { key: 'isp', title: 'Isp', unit: 's', digits: 1, minSpan: () => 4, lines: [
      { key: 'isp', label: 'Isp', color: CHAMBER, get: (s, i) => (delivered ? dv('isp_s', i) : firing(s, i, s.chamber.isp_s[i])) } ] },
  ];
}

/** Another burn on the same chart: its lines, ghosted, on its own clock (both start at Fire = 0). */
export interface Ghost { label: string; series: Series; plots: MiniPlot[] }

function MiniChart({ plot, series, cursor, setCursor, ghost }: {
  plot: MiniPlot; series: Series; cursor: number; setCursor: (i: number) => void; ghost?: Ghost | null;
}) {
  const ghostPlot = ghost?.plots.find((p) => p.key === plot.key);
  const rows = useMemo(() => {
    const out: Record<string, number | undefined>[] = series.t.map((t, i) => {
      const row: Record<string, number | undefined> = { t };
      for (const l of plot.lines) row[l.key] = l.get(series, i);
      return row;
    });
    if (!ghost || !ghostPlot) return out;
    // Merged on time: equal steps share a row; the rest are rows of their own, sorted in.
    const at = new Map(out.map((r, i) => [Number(r.t).toFixed(4), i]));
    ghost.series.t.forEach((t, i) => {
      const key = t.toFixed(4);
      let k = at.get(key);
      if (k === undefined) { out.push({ t }); k = out.length - 1; at.set(key, k); }
      for (const l of ghostPlot.lines) out[k][`g_${l.key}`] = l.get(ghost.series, i);
    });
    return out.sort((a, b) => Number(a.t) - Number(b.t));
  }, [series, plot, ghost, ghostPlot]);
  // The axis: the data's range, widened to the plot's least span so a 1 % ripple is drawn as one,
  // and ticks with as many decimals as it takes not to repeat.
  const domain = useMemo<[number, number] | null>(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rows) for (const [k, v] of Object.entries(r)) {
      if (k === 't' || v === undefined || v === null || !Number.isFinite(v)) continue;
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    if (plot.band) { lo = Math.min(lo, plot.band[0]); hi = Math.max(hi, plot.band[1]); }
    if (!Number.isFinite(lo)) return null;
    const least = plot.minSpan ? plot.minSpan((lo + hi) / 2) : 0;
    if (hi - lo < least) { const mid = (lo + hi) / 2; lo = mid - least / 2; hi = mid + least / 2; }
    const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.02 || 1;
    return [lo - pad, hi + pad];
  }, [rows, plot]);
  const yTicks = useMemo(() => (domain ? niceTicks(domain[0], domain[1], 4) : []), [domain]);
  const digits = yTicks.length > 1 ? stepDigits(yTicks[1] - yTicks[0]) : 0;
  const xTicks = useMemo(() => {
    const ts = series.t;
    return ts.length ? niceTicks(ts[0], ts[ts.length - 1], 5) : [];
  }, [series.t]);
  const cursorT = series.t[cursor];
  return (
    <div className={`min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)]/40 px-3 pb-2 pt-3 ${plot.wide ? 'lg:col-span-2' : ''}`}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
        <span className="text-[13px] text-[var(--color-text-primary)]">
          {plot.title}{plot.unit ? <span className="text-[var(--color-text-muted)]"> {plot.unit}</span> : null}
        </span>
        {/* Each line's value at the cursor: the cursor drives every number, no hover needed. */}
        <span className="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-0.5">
          {plot.lines.map((l) => {
            const v = l.get(series, cursor);
            return (
              <span key={l.key} className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] tabular-nums text-[var(--color-text-muted)]">
                <svg width="14" height="6" aria-hidden><line x1="0" y1="3" x2="14" y2="3" stroke={l.color} strokeWidth="2" strokeDasharray={l.dash} /></svg>
                {plot.lines.length > 1 ? l.label : null}
                <span className="text-[12px] text-[var(--color-text-primary)]">{v === undefined || !Number.isFinite(v) ? '—' : fmt(v, plot.digits)}</span>
              </span>
            );
          })}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={plot.wide ? 230 : 180}>
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                   onMouseMove={(e: { activeLabel?: number | string }) => {
                     // The rows may hold the reference's steps too: the cursor is this burn's step nearest in time.
                     const t = Number(e?.activeLabel);
                     if (!Number.isFinite(t) || !series.t.length) return;
                     let k = 0;
                     for (let j = 1; j < series.t.length; j++) if (Math.abs(series.t[j] - t) < Math.abs(series.t[k] - t)) k = j;
                     setCursor(k);
                   }}>
          {plot.band && <ReferenceArea y1={plot.band[0]} y2={plot.band[1]} fill="var(--color-success)" fillOpacity={0.07} ifOverflow="hidden" />}
          <ReferenceLine x={0} stroke="var(--color-text-muted)" strokeOpacity={0.5} strokeDasharray="2 3" />
          {cursorT !== undefined && <ReferenceLine x={cursorT} stroke="var(--color-accent)" strokeOpacity={0.8} />}
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} ticks={xTicks} axisLine={false} tickLine={false}
                 tick={axisTick} tickFormatter={(v: number) => `${fmt(v, stepDigits(xTicks[1] - xTicks[0]))} s`} height={20} />
          <YAxis domain={domain ?? ['auto', 'auto']} allowDataOverflow width={48} tick={axisTick} tickFormatter={(v: number) => fmt(v, digits)}
                 axisLine={false} tickLine={false} ticks={yTicks.length ? yTicks : undefined} />
          {yTicks.map((v) => <ReferenceLine key={`grid${v}`} y={v} stroke="var(--color-border)" strokeOpacity={0.45} />)}
          {ghostPlot && ghostPlot.lines.map((l) => (
            // The other burn: one thin grey for every series, so grey always means "the other run".
            <Line key={`g_${l.key}`} type="monotone" dataKey={`g_${l.key}`} name={`${l.label} · ${ghost!.label}`} dot={false}
                  strokeWidth={1.1} stroke="var(--color-text-muted)" strokeDasharray={l.dash} isAnimationActive={false} connectNulls />
          ))}
          {plot.lines.map((l) => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.label} dot={false} strokeWidth={1.8} stroke={l.color}
                  strokeDasharray={l.dash} isAnimationActive={false} connectNulls={!!ghost} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ------------------------------------------------------------------ sections

function Section({ title, summary, open, onToggle, children }: { title: string; summary: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="border-t border-[var(--color-border)]">
      <button type="button" onClick={onToggle} aria-expanded={open}
              className="flex w-full items-center gap-6 py-3.5 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)]">
        <span className="w-44 shrink-0 text-sm font-medium text-[var(--color-text-primary)]">{title}</span>
        <span className="flex-1 min-w-0 text-[13px] text-[var(--color-text-muted)] truncate">{summary}</span>
        <svg className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
      {open && <div className="pb-6">{children}</div>}
    </div>
  );
}

const EVENT_COLOR: Record<BurnEvent['kind'], string> = {
  t0: 'var(--color-text-secondary)', fire: 'var(--color-text-primary)', min: LOX, end: 'var(--color-text-primary)', warn: WARN,
  fail: BAD,
};
const eventColor = (e: BurnEvent) => (e.kind === 'min' && /fuel/i.test(e.label) ? FUEL : EVENT_COLOR[e.kind]);

function groupByTime(events: BurnEvent[]): BurnEvent[][] {
  const out: BurnEvent[][] = [];
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0].t - e.t) < 1e-6) last.push(e); else out.push([e]);
  }
  return out;
}

function Events({ events, burn }: { events: BurnEvent[]; burn: number }) {
  const t0 = Math.min(...events.map((e) => e.t), 0);
  const span = Math.max(burn - t0, 1e-6);
  return (
    <div className="space-y-4">
      <div className="relative h-8 rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
        <div className="absolute inset-y-0 bg-[var(--color-bg-tertiary)]" style={{ left: 0, width: `${((0 - t0) / span) * 100}%` }} />
        {/* Events at the same instant (horizon, card and settle warnings all land on the last step) are one marker. */}
        {groupByTime(events).map((g, k) => (
          <span key={k} className="absolute top-1/2 -translate-y-1/2" style={{ left: `calc(${((g[0].t - t0) / span) * 100}% - 6px)` }}>
            <Hint text={<>{fmt(g[0].t, 2)} s · {g.map((e) => `${e.label}: ${e.detail}`).join(' · ')}</>}>
              <span className="flex h-3 min-w-3 items-center justify-center rounded-full border-2 border-[var(--color-bg-primary)] px-0.5 text-[8px] font-semibold text-[var(--color-bg-primary)]"
                    style={{ background: eventColor(g.find((e) => e.kind === 'warn') ?? g[0]) }}>{g.length > 1 ? g.length : ''}</span>
            </Hint>
          </span>
        ))}
      </div>
      <table className="w-full text-[12px] tabular-nums">
        <tbody>
          {events.map((e, k) => (
            <tr key={k} className="border-t border-[var(--color-border)]/50">
              <td className="py-1 pr-4 w-20 text-right text-[var(--color-text-secondary)]">{fmt(e.t, 2)} s</td>
              <td className="py-1 pr-4 w-48" style={{ color: e.kind === 'warn' ? WARN : 'var(--color-text-primary)' }}>{e.label}</td>
              <td className="py-1 text-[var(--color-text-muted)]">{e.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CrossCheckTable({ cc }: { cc: CrossCheck }) {
  if (!cc.available || !cc.rows) return <div className="text-[13px] text-[var(--color-text-muted)]">{cc.error ?? 'Not available for this run.'}</div>;
  return (
    <div className="space-y-3">
      <div className="text-[12px] text-[var(--color-text-muted)] max-w-3xl">
        At t = {fmt(cc.t, 2)} s, tanks {fmt(cc.tank_psia_O, 1)} / {fmt(cc.tank_psia_F, 1)} psia. {cc.basis}
      </div>
      <table className="w-full max-w-3xl text-[12px] tabular-nums">
        <thead>
          <tr className="text-left text-[var(--color-text-muted)]">
            <th className="py-1 font-normal">Quantity</th>
            <th className="py-1 font-normal text-right">Layer X</th>
            <th className="py-1 font-normal text-right">Forward mode</th>
            <th className="py-1 font-normal text-right">Difference</th>
          </tr>
        </thead>
        <tbody>
          {cc.rows.map((r) => {
            const big = r.rel !== null && Math.abs(r.rel) > 0.02;
            const digits = r.unit === 'kg/s' || r.unit === '' ? 3 : r.unit === 's' ? 1 : r.unit === 'N' ? 0 : 1;
            return (
              <tr key={r.key} className="border-t border-[var(--color-border)]/50">
                <td className="py-1 text-[var(--color-text-secondary)]">{r.label}{r.unit ? <span className="text-[var(--color-text-muted)]"> {r.unit}</span> : null}</td>
                <td className="py-1 text-right text-[var(--color-text-primary)]">{fmt(r.layerx, digits)}</td>
                <td className="py-1 text-right text-[var(--color-text-secondary)]">{fmt(r.enginedesign, digits)}</td>
                <td className="py-1 text-right" style={{ color: big ? WARN : 'var(--color-text-muted)' }}>
                  {r.rel === null ? '—' : `${r.rel >= 0 ? '+' : ''}${fmt(r.rel * 100, 2)} %`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReplayBlock({ replay, passes, delivered }: { replay: Replay; passes: ReplayPass[]; delivered: Delivered | null }) {
  if (!replay.available) return <div className="text-[13px] text-[var(--color-text-muted)]">{replay.error ?? 'No replay.'}</div>;
  const rows = replay.t.map((t, k) => ({
    t,
    growth: replay.throat_area_ratio[k] !== null ? ((replay.throat_area_ratio[k] as number) - 1) * 100 : undefined,
    rec: replay.recession_throat_mm?.[k] ?? undefined,
    q: replay.heat_flux_throat_MW_m2?.[k] ?? undefined,
    Tg: replay.T_graphite_surface_K?.[k] ?? undefined,
  }));
  const plot = (key: 'growth' | 'rec' | 'q' | 'Tg', title: string, unit: string, digits: number) => (
    <div>
      <div className="text-xs text-[var(--color-text-secondary)] mb-1">{title}<span className="text-[var(--color-text-muted)]"> {unit}</span></div>
      <ResponsiveContainer width="100%" height={110}>
        <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickCount={4} axisLine={false} tickLine={false}
                 tick={axisTick} tickFormatter={(v: number) => `${fmt(v, 1)} s`} height={18} />
          <YAxis domain={['auto', 'auto']} width={44} tick={axisTick} tickFormatter={(v: number) => fmt(v, digits)} axisLine={false} tickLine={false} tickCount={3} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(t: number) => `t = ${fmt(t, 2)} s`} formatter={(v: number) => [fmt(v, digits + 1), title]} />
          <Line type="monotone" dataKey={key} dot={false} strokeWidth={1.6} stroke={CHAMBER} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
  return (
    <div className="space-y-5">
      <div className="text-[12px] text-[var(--color-text-muted)] max-w-3xl">
        Recession of the{replay.throat_ablation ? ' graphite throat' : ''}{replay.throat_ablation && replay.liner_ablation ? ' and' : ''}{replay.liner_ablation ? ' ablative liner' : ''} from
        EngineDesign's time-varying solver at this burn's line-exit pressures. The throat history is fed back into the feed
        simulation until it converges. The headline thrust, chamber pressure and Isp come from this solve.
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-5 gap-y-6">
        {plot('growth', 'Throat area growth', '%', 1)}
        {plot('rec', 'Throat recession', 'mm', 2)}
        {replay.heat_flux_throat_MW_m2 && plot('q', 'Throat heat flux', 'MW/m²', 1)}
        {replay.T_graphite_surface_K && plot('Tg', 'Graphite surface', 'K', 0)}
      </div>
      <table className="w-full max-w-3xl text-[12px] tabular-nums">
        <thead>
          <tr className="text-left text-[var(--color-text-muted)]">
            <th className="py-1 font-normal">Pass</th>
            <th className="py-1 font-normal">Throat</th>
            <th className="py-1 font-normal text-right">Burn</th>
            <th className="py-1 font-normal text-right">Throat growth</th>
            <th className="py-1 font-normal text-right">History moved</th>
            <th className="py-1 font-normal text-right">Twin vs replay (flow, Pc)</th>
          </tr>
        </thead>
        <tbody>
          {passes.map((p) => (
            <tr key={p.pass} className="border-t border-[var(--color-border)]/50">
              <td className="py-1 text-[var(--color-text-secondary)]">{p.pass}</td>
              <td className="py-1 text-[var(--color-text-secondary)]">{p.throat_applied ? 'previous replay' : 'as built'}</td>
              <td className="py-1 text-right text-[var(--color-text-primary)]">{fmt(p.burn_time_s, 2)} s</td>
              <td className="py-1 text-right text-[var(--color-text-primary)]">{p.throat_growth === null ? '—' : `${p.throat_growth >= 0 ? '+' : ''}${fmt(p.throat_growth * 100, 2)} %`}</td>
              <td className="py-1 text-right text-[var(--color-text-secondary)]">{fmt(p.schedule_change * 100, 3)} %</td>
              <td className="py-1 text-right text-[var(--color-text-secondary)]">
                {p.agreement.worst && p.agreement.worst.mdot_O !== null && p.agreement.worst.mdot_F !== null ? `${fmt(Math.max(p.agreement.worst.mdot_O, p.agreement.worst.mdot_F) * 100, 2)} %, ${fmt(p.agreement.worst.pc * 100, 2)} %` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {delivered && (
        <div className="text-[12px] text-[var(--color-text-muted)] tabular-nums">
          Throat recession by burnout {fmt(delivered.summary.throat_recession_mm, 2)} mm. EngineDesign's ablative and graphite models are
          not yet checked against a firing (docs/layer-x.md, phase 5); treat the erosion as the model's, not a measurement.
        </div>
      )}
    </div>
  );
}

function EngineCheckTable({ check }: { check: EngineCheck }) {
  if (!check.available || !check.rows) return null;
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${fmt(v * 100, 3)} %`);
  const tone = (v: number | null | undefined) => (v !== null && v !== undefined && Math.abs(v) > 0.002 ? WARN : 'var(--color-text-muted)');
  return (
    <div className="space-y-2">
      <div className="text-[12px] text-[var(--color-text-muted)] max-w-3xl">{check.basis}</div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full max-w-4xl text-[12px] tabular-nums">
          <thead className="sticky top-0 bg-[var(--color-bg-secondary)]">
            <tr className="text-left text-[var(--color-text-muted)]">
              <th className="py-1 font-normal text-right">t</th>
              <th className="py-1 font-normal text-right">Line exit LOX / fuel</th>
              <th className="py-1 font-normal text-right">Pc Layer X</th>
              <th className="py-1 font-normal text-right">Pc EngineDesign</th>
              <th className="py-1 font-normal text-right">ΔPc</th>
              <th className="py-1 font-normal text-right">ΔF</th>
              <th className="py-1 font-normal text-right">Δṁ LOX</th>
              <th className="py-1 font-normal text-right">Δṁ fuel</th>
            </tr>
          </thead>
          <tbody>
            {check.rows.map((r, k) => (
              <tr key={k} className="border-t border-[var(--color-border)]/50">
                <td className="py-1 text-right text-[var(--color-text-secondary)]">{fmt(r.t, 2)} s</td>
                <td className="py-1 text-right text-[var(--color-text-secondary)]">{fmt(r.inlet_O_psia, 1)} / {fmt(r.inlet_F_psia, 1)}</td>
                <td className="py-1 text-right text-[var(--color-text-primary)]">{fmt(r.layerx?.pc, 2)}</td>
                <td className="py-1 text-right text-[var(--color-text-secondary)]">{fmt(r.enginedesign?.pc, 2)}</td>
                <td className="py-1 text-right" style={{ color: tone(r.rel?.pc) }}>{pct(r.rel?.pc)}</td>
                <td className="py-1 text-right" style={{ color: tone(r.rel?.thrust) }}>{pct(r.rel?.thrust)}</td>
                <td className="py-1 text-right" style={{ color: tone(r.rel?.mdot_O) }}>{pct(r.rel?.mdot_O)}</td>
                <td className="py-1 text-right" style={{ color: tone(r.rel?.mdot_F) }}>{pct(r.rel?.mdot_F)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EngineLinkBlock({ cal, reference, check }: { cal: Calibration | null; reference: Record<string, number> | null; check?: EngineCheck }) {
  if (!cal) return null;
  const row = (label: string, value: string, hint: string) => (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <Hint text={hint}><span className="text-[13px] text-[var(--color-text-secondary)]">{label}</span></Hint>
      <span className="text-[13px] tabular-nums text-[var(--color-text-primary)]">{value}</span>
    </div>
  );
  let head: ReactNode = null;
  if (cal.mode === 'card' && cal.fit && cal.card) {
    const f = cal.fit;
    const c = cal.card;
    head = (
      <>
        <div className="text-[12px] text-[var(--color-text-muted)] max-w-3xl">
          EngineDesign's injector and chamber, solved at {c.samples} line-exit pressure pairs around {fmt(c.center_psia, 1)} psia and
          interpolated at every time step. Built in {fmt(c.built_s, 1)} s.
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 max-w-4xl">
          {row('Chamber pressure, held out', `${fmt(f.envelope_closed_pc * 100, 3)} %`, `Largest error against ${f.envelope_points} EngineDesign solves the card was not fitted to, inside the burn envelope (line pressure ${fmt(c.envelope_levels[0] * 100)}–${fmt(c.envelope_levels[1] * 100)} % of T-0, fuel/LOX ${fmt(c.envelope_ratios[0], 2)}–${fmt(c.envelope_ratios[1], 2)}), the card solved as a whole.`)}
          {row('Thrust, held out', `${fmt(f.envelope_closed_thrust * 100, 3)} %`, 'As chamber pressure.')}
          {row('Flow, held out', `${fmt(f.envelope_closed_mdot * 100, 3)} %`, 'Either propellant.')}
          {row('Injector Δp, held out', `${fmt(Math.max(f.envelope_dp_O, f.envelope_dp_F) * 100, 4)} %`, 'Line exit to chamber, at EngineDesign\'s flow and line pressure.')}
          {row('Whole scan', `${fmt(f.box_closed_pc * 100, 2)} %`, `Pc error over the whole sampled box (line pressure ${fmt(c.scan_levels[0] * 100)}–${fmt(c.scan_levels[1] * 100)} % of T-0). Larger at high O/F, where EngineDesign's mixing efficiency steps irregularly; a regulated burn does not go there.`)}
          {row('Tolerance', `${fmt(f.tolerance * 100, 1)} %  ${c.within_tolerance ? '· met' : '· NOT met'}`, 'docs/layer-x.md, phase 2.')}
          {cal.of_range && row('Tabulated O/F', `${fmt(cal.of_range[0], 2)}–${fmt(cal.of_range[1], 2)}`, 'Beyond the samples the card clamps and the step is flagged.')}
          {cal.mdot_range && row('Tabulated flow', `${fmt(cal.mdot_range[0], 2)}–${fmt(cal.mdot_range[1], 2)} kg/s`, 'Total.')}
          {row('Boundary', 'line exit', c.boundary)}
          {row('Config', c.config_sha256.slice(0, 12), 'The card is rebuilt whenever the design changes; a card is never served for a config it was not built from.')}
        </div>
      </>
    );
  } else if (cal.mode === 'calibrated') {
    head = (
      <>
        <div className="text-[12px] text-[var(--color-text-muted)] max-w-3xl">
          The twin's engine with four constants fitted so it reproduces EngineDesign at the T-0 line pressures
          (residual {fmt(Math.abs(cal.residual_pc ?? 0) * 100, 4)} % in Pc), then held through the burn. The engine card follows
          EngineDesign everywhere; this is kept to show what that buys.
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 max-w-4xl">
          {row('LOX Cd', `${fmt(cal.cd_O, 3)}  (twin's own ${fmt(cal.native_cd_O, 3)})`, 'Line exit to chamber, so it includes the dump into the manifold.')}
          {row('Fuel Cd', `${fmt(cal.cd_F, 3)}  (twin's own ${fmt(cal.native_cd_F, 3)})`, 'As LOX.')}
          {row('η c*', fmt(cal.eta_cstar, 4), `On the twin's CEA c* table. EngineDesign's own η_c* at T-0: ${fmt(cal.ed_eta_cstar, 4)}.`)}
          {row('η nozzle', fmt(cal.eta_n, 4), "On the table's C_F, at the site's ambient pressure.")}
        </div>
      </>
    );
  } else {
    head = (
      <div className="text-[13px] text-[var(--color-text-secondary)] max-w-3xl">
        The twin's own engine: the config's Reynolds-law Cd (LOX {fmt(cal.native_cd_O, 3)}, fuel {fmt(cal.native_cd_F, 3)}) and η_c* = 1.
        Chamber pressure is an upper bound and the flows are not EngineDesign's. Use it to see what the card changes, not to quote a number.
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {head}
      {reference && (
        <div className="text-[12px] text-[var(--color-text-muted)] tabular-nums">
          EngineDesign at the T-0 line pressures: {fmt(reference.Pc / PSI, 1)} psia, {fmt(reference.F, 0)} N,
          line exit to chamber {fmt(reference.dp_line_O / PSI, 1)} / {fmt(reference.dp_line_F / PSI, 1)} psi.
        </div>
      )}
      {check && (
        <div>
          <div className="mb-2 text-[13px] text-[var(--color-text-primary)]">Through the burn</div>
          <EngineCheckTable check={check} />
        </div>
      )}
    </div>
  );
}

function kv(obj: Record<string, unknown>): [string, string][] {
  return Object.entries(obj)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => [k, typeof v === 'number' ? (Number.isInteger(v) ? String(v) : sig(v as number)) : String(v)]);
}

const SOURCE_LABEL: Record<string, string> = {
  default: 'Default', estimated: 'Estimated', manufacturer: 'Datasheet', measured: 'Measured', drawing: 'Drawing',
};

function Pairs({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div>
      <div className="mb-1 text-[var(--color-text-primary)]">{title}</div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 py-0.5">
          <span className="text-[var(--color-text-muted)]">{k}</span>
          <span className="truncate tabular-nums text-[var(--color-text-secondary)]" title={v}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function ProvenanceBlock({ p }: { p: Provenance }) {
  const [all, setAll] = useState(false);
  const defaults = p.assembly.assumptions.filter((a) => a.source === 'default');
  const rows = all ? p.assembly.assumptions : defaults;
  const short = (h: string) => (h ? h.slice(0, 12) : '—');
  const record: [string, string][] = [
    ['Drawing', p.drawing.name],
    ['Drawing source', p.drawing.source],
    ['Drawing hash', short(p.drawing.sha256)],
    ['Engine config hash', short(p.config_sha256)],
    ['Feed network', `${p.assembly.nodes} nodes, ${p.assembly.branches} branches`],
    ['Feed model', p.feedtwin_version ? `feedtwin ${p.feedtwin_version}` : 'feedtwin'],
    ['Solve time', `${fmt(p.wall_s ?? null, 1)} s`],
    ['Run', new Date(p.created * 1000).toLocaleString()],
  ];
  return (
    <div className="space-y-6 text-[12px]">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-x-12 gap-y-6 max-w-5xl">
        <Pairs title="Run record" rows={record} />
        <Pairs title="Solver settings" rows={kv(p.setup)} />
        <Pairs title="Burn settings" rows={kv(p.plan)} />
      </div>
      <div>
        <div className="mb-1 flex items-baseline gap-4">
          <span className="text-[var(--color-text-primary)]">Unspecified parameters</span>
          <div className="ml-auto flex rounded-md border border-[var(--color-border)] p-0.5">
            {([[false, `Defaults (${defaults.length})`], [true, `All assumed (${p.assembly.assumptions.length})`]] as const).map(([v, label]) => (
              <button key={label} type="button" onClick={() => setAll(v)}
                      className={`rounded px-2 py-0.5 ${all === v ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-72 overflow-auto rounded border border-[var(--color-border)]">
          <table className="w-full tabular-nums">
            <thead className="sticky top-0 bg-[var(--color-bg-secondary)]">
              <tr className="text-left text-[var(--color-text-muted)]">
                <th className="px-2 py-1 font-normal">Component</th><th className="px-2 py-1 font-normal">Parameter</th>
                <th className="px-2 py-1 font-normal text-right">Value</th><th className="px-2 py-1 font-normal">Basis</th><th className="px-2 py-1 font-normal">Reference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, k) => (
                <tr key={k} className="border-t border-[var(--color-border)]/50">
                  <td className="px-2 py-0.5 text-[var(--color-text-secondary)]">{a.component}</td>
                  <td className="px-2 py-0.5 text-[var(--color-text-secondary)]">{a.parameter}</td>
                  <td className="px-2 py-0.5 text-right text-[var(--color-text-primary)]">{sig(a.value)} <span className="text-[var(--color-text-muted)]">{a.unit}</span></td>
                  <td className="px-2 py-0.5" style={{ color: a.source === 'default' ? WARN : 'var(--color-text-muted)' }}>{SOURCE_LABEL[a.source] ?? a.source}</td>
                  <td className="px-2 py-0.5 text-[var(--color-text-muted)] truncate max-w-[22rem]" title={a.reference}>{a.reference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {p.notes.length > 0 && (
        <div>
          <div className="mb-1 text-[var(--color-text-primary)]">Model assumptions</div>
          <ul className="space-y-1 text-[var(--color-text-muted)] max-w-4xl list-disc pl-4">
            {p.notes.map((n, k) => <li key={k}>{n}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the whole result

function firingIndexOf(series: Series): Map<number, number> {
  const m = new Map<number, number>();
  let k = 0;
  series.firing.forEach((f, i) => { if (f) m.set(i, k++); });
  return m;
}

export type ResultPage = 'summary' | 'plots' | 'flight' | 'stand' | 'uncertainty' | 'details';

function PageTabs({ page, setPage, pages }: { page: ResultPage; setPage: (p: ResultPage) => void; pages: { key: ResultPage; label: ReactNode }[] }) {
  return (
    <div role="tablist" aria-label="Burn pages" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-[var(--color-border)]">
      {pages.map((p) => (
        <button key={p.key} type="button" role="tab" aria-selected={page === p.key} onClick={() => setPage(p.key)}
                className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-[13px] ${page === p.key
                  ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]'
                  : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}`}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

export function LayerXResultView({ result, uncertainty, runId = '', onConfigUpdated, designMoved = false, whatIf = false, reference = null,
                                   runPanel = null, standActions = null }: {
  result: LayerXResult; uncertainty?: { node: ReactNode; summary: ReactNode }; runId?: string; designMoved?: boolean; whatIf?: boolean;
  /** Another burn to compare against: ghosted on every chart, its figures as deltas. */
  reference?: { label: string; result: LayerXResult } | null;
  onConfigUpdated?: (config: import('../../api/client').EngineConfig) => void;
  /** The run's name and note, at the top of Details. */
  runPanel?: ReactNode;
  /** The stand's own actions (the test card), at the top of Stand. */
  standActions?: ReactNode;
}) {
  const { series, summary, events, provenance } = result;
  const [storedPage, setPage] = useViewState<ResultPage>('layerx.page', 'summary');
  const band = (provenance.derived?.stiffness_band ?? undefined) as Record<string, number[] | null> | undefined;
  const firstFire = series.firing.findIndex(Boolean);
  const [cursor, setCursor] = useState(() => Math.max(firstFire + Math.floor((series.t.length - firstFire) / 2), 0));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (k: string, dflt = false) => open[k] ?? dflt;
  const toggle = (k: string, dflt = false) => setOpen((o) => ({ ...o, [k]: !(o[k] ?? dflt) }));
  const firingIndex = useMemo(() => firingIndexOf(series), [series]);
  const gaugeZero = ((provenance.derived?.gauge_zero_pa as number | undefined) ?? 101325) / PSI;
  const vctx = useMemo<VerdictContext>(() => {
    const d = provenance.derived as Record<string, unknown> | undefined;
    const roles = (d?.roles ?? {}) as Record<string, string>;
    const mawps = (d?.tank_mawp_psi ?? {}) as Record<string, number>;
    const ambient = typeof d?.ambient_pa === 'number' ? (d.ambient_pa as number) / PSI : 14.6959;
    return {
      chug: result.delivered?.summary ? { min: result.delivered.summary.chug_margin_min, t: result.delivered.summary.chug_margin_min_t } : null,
      mawp: { oxidiser: mawps[roles.oxidiser], fuel: mawps[roles.fuel], ambientPsia: ambient },
      converged: result.converged,
      cardOutside: summary.card_outside_steps ?? null,
    };
  }, [provenance, result.delivered, result.converged, summary]);
  const items = useMemo(() => verdictItems(summary, band, result.engine_check, vctx), [summary, band, result.engine_check, vctx]);
  const grade = overall(items);
  const plots = useMemo(() => burnPlots(band, result.delivered, firingIndex, gaugeZero), [band, result.delivered, firingIndex, gaugeZero]);
  const ghost = useMemo<Ghost | null>(() => {
    const r = reference?.result;
    if (!r?.series) return null;
    return { label: reference!.label, series: r.series, plots: burnPlots(band, r.delivered, firingIndexOf(r.series), gaugeZero) };
  }, [reference, band, gaugeZero]);
  const thrustAt = useCallback((i: number) => {
    const k = firingIndex.get(i);
    return k === undefined ? undefined : result.delivered?.thrust_N?.[k] ?? undefined;
  }, [firingIndex, result.delivered]);
  const nozzleAt = useCallback((i: number): NozzleState | undefined => {
    const k = firingIndex.get(i);
    const dv = result.delivered;
    if (k === undefined || !dv?.p_exit_psia || !dv.ambient_psia || !dv.gamma_exit) return undefined;
    return { pc_psia: dv.pc_psia[k], pe_psia: dv.p_exit_psia[k], pa_psia: dv.ambient_psia[k], gamma: dv.gamma_exit[k],
             tc_K: dv.tc_K?.[k], te_K: dv.t_exit_K?.[k] };
  }, [firingIndex, result.delivered]);
  const flight = result.flight?.ok ? result.flight : null;
  const accelAt = useMemo(() => {
    if (!flight) return undefined;
    const ts = flight.schedule.t;
    const as = flight.schedule.accel_m_s2;
    return (t: number) => {
      if (!ts.length) return undefined;
      let k = 0;
      while (k < ts.length - 1 && ts[k + 1] <= t) k++;
      return as[k];
    };
  }, [flight]);
  const cells = useMemo(() => {
    const ref = reference?.result?.summary
      ? figureCells(reference.result.summary, reference.result.delivered, reference.result.flight?.ok ? reference.result.flight.apogee_agl_m : null) : null;
    return withDeltas(figureCells(summary, result.delivered, flight ? flight.apogee_agl_m : null), ref);
  }, [summary, result.delivered, flight, reference]);
  const out = leftOut(provenance.settings);
  const cc = result.cross_check;
  const warnEvents = events.filter((e) => e.kind === 'warn').length;
  const w = result.engine_check?.worst;
  const engineGap = w ? Math.max(w.pc, w.mdot_O, w.mdot_F, result.engine_check?.against === 'replay' ? 0 : w.thrust) : null;
  const instruments = Object.keys(series.instruments ?? {}).length;

  const pages: { key: ResultPage; label: ReactNode }[] = [
    { key: 'summary', label: <><span aria-hidden className="text-[12px] font-semibold" style={{ color: GRADE_COLOR[grade] }}>{GRADE_MARK[grade]}</span>Summary</> },
    { key: 'plots', label: 'Plots' },
    ...(result.flight ? [{ key: 'flight' as const, label: 'Flight' }] : []),
    { key: 'stand', label: 'Stand' },
    ...(uncertainty ? [{ key: 'uncertainty' as const, label: 'Uncertainty' }] : []),
    { key: 'details', label: <>Details{warnEvents ? <span className="text-[11px]" style={{ color: WARN }}>{warnEvents}</span> : null}</> },
  ];
  const page: ResultPage = pages.some((p) => p.key === storedPage) ? storedPage : 'summary';
  const greyKey = reference && (
    <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
      <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke="var(--color-text-muted)" strokeWidth="1.2" /></svg>
      grey: {reference.label}
    </div>
  );

  return (
    <div className="space-y-6" style={SANS}>
      <PageTabs page={page} setPage={setPage} pages={pages} />

      {page === 'summary' && (
        <div className="space-y-8">
          <Status items={items} />
          <div className="grid grid-cols-1 gap-x-10 gap-y-8 xl:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]">
            <section className="max-w-2xl">
              <Heading>Limits</Heading>
              <Limits items={items} />
            </section>
            <section>
              <Heading aside={
                <Hint text={<>Not in these figures: {out.terms.join(' ')}{out.off.length ? ` Run without ${out.off.join(', ')} (Advanced); line walls and vapour on add ~190 psi to the bottle at burnout on the 6.8 kN stand.` : ''}</>}>
                  <span className="text-[12px] text-[var(--color-text-muted)]">what's left out</span>
                </Hint>
              }>Performance</Heading>
              <Figures cells={cells} />
              {greyKey && <div className="mt-4">{greyKey}</div>}
            </section>
          </div>
          <section>
            <Heading>Feed system</Heading>
            <FeedSchematic series={series} cursor={cursor} setCursor={setCursor}
                           thrustAt={result.delivered ? thrustAt : undefined} accelAt={accelAt} nozzleAt={nozzleAt} gaugeZeroPsia={gaugeZero} />
          </section>
        </div>
      )}

      {page === 'plots' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-[var(--color-text-muted)]">
            <span className="tabular-nums">
              Cursor <span className="text-[var(--color-text-primary)]">T{(series.t[cursor] ?? 0) < 0 ? '−' : '+'}{fmt(Math.abs(series.t[cursor] ?? 0), 2)} s</span>
              <span> · move over any chart</span>
            </span>
            {greyKey}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {plots.map((p) => <MiniChart key={p.key} plot={p} series={series} cursor={cursor} setCursor={setCursor} ghost={ghost} />)}
          </div>
        </div>
      )}

      {page === 'flight' && result.flight && (
        <div className="space-y-6">
          <div className="text-[13px] text-[var(--color-text-secondary)]"><FlightSummary flight={result.flight} /></div>
          <FlightView flight={result.flight} />
        </div>
      )}

      {page === 'stand' && (
        <div className="space-y-6">
          {standActions}
          <section>
            <Heading aside={<span className="text-[12px] text-[var(--color-text-muted)]">{instruments} instruments on the drawing</span>}>Measured against predicted</Heading>
            <MeasuredView result={result} />
          </section>
        </div>
      )}

      {page === 'uncertainty' && uncertainty && <div>{uncertainty.node}</div>}

      {page === 'details' && (
        <div className="space-y-8">
          {runPanel}
          <section>
            <Heading>What these figures leave out</Heading>
            <ul className="max-w-3xl list-disc space-y-1 pl-4 text-[13px] text-[var(--color-text-secondary)]">
              {out.terms.map((t) => <li key={t}>{t}</li>)}
              {out.off.length > 0 && (
                <li>Run without {out.off.join(', ')} (Advanced). The bottle at burnout moves most with them: line walls and vapour on add ~190 psi on the 6.8 kN stand. The uncertainty sweep includes them.</li>
              )}
            </ul>
          </section>
          <div className="border-b border-[var(--color-border)]">
            {result.feed_fit && (
              <Section title="Injector feed" open={isOpen('feed')} onToggle={() => toggle('feed')}
                       summary={<FeedFitSummary fit={result.feed_fit} />}>
                <FeedFitView fit={result.feed_fit} runId={runId} onConfigUpdated={onConfigUpdated} designMoved={designMoved} whatIf={whatIf}
                             designSha={provenance.config_sha256} />
              </Section>
            )}
            <Section title="Events" open={isOpen('events')} onToggle={() => toggle('events')}
                     summary={<>{events.length} events{warnEvents ? <span style={{ color: WARN }}> · {warnEvents} warning{warnEvents > 1 ? 's' : ''}</span> : null}
                       {result.converged === false ? <span style={{ color: WARN }}> · erosion/flight coupling not settled</span> : null}</>}>
              <Events events={events} burn={summary.burn_time_s} />
            </Section>
            {result.replay && (
              <Section title="Nozzle erosion" open={isOpen('erosion')} onToggle={() => toggle('erosion')}
                       summary={result.delivered?.summary.throat_area_growth != null
                         ? <>throat area +{fmt(result.delivered.summary.throat_area_growth * 100, 1)} % by burnout · {fmt(result.delivered.summary.throat_recession_mm, 2)} mm recession</>
                         : 'not replayed'}>
                <ReplayBlock replay={result.replay} passes={result.passes ?? []} delivered={result.delivered ?? null} />
              </Section>
            )}
            <Section title="Engine fit" open={isOpen('engine')} onToggle={() => toggle('engine')}
                     summary={<>{summary.failed_steps ? `${summary.failed_steps} steps held` : `${summary.steps} steps solved`}{engineGap !== null && <> · burn vs EngineDesign {fmt(engineGap * 100, 2)} %</>}</>}>
              <EngineLinkBlock cal={provenance.calibration} reference={provenance.engine_reference} check={result.engine_check} />
            </Section>
            {cc && (
              <Section title="Feed vs Forward mode" open={isOpen('cc')} onToggle={() => toggle('cc')}
                       summary="this burn's feed network against Forward mode's feed losses">
                <CrossCheckTable cc={cc} />
              </Section>
            )}
            <Section title="Run record" open={isOpen('prov')} onToggle={() => toggle('prov')}
                     summary={<>{provenance.drawing.name} · design {provenance.config_sha256.slice(0, 8)} · {provenance.assembly.assumptions.filter((a) => a.source === 'default').length} defaulted parameters</>}>
              <ProvenanceBlock p={provenance} />
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}
