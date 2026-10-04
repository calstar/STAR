import { useMemo } from 'react';
import type { BurnEvent, Delivered, EngineCheck, FlightResult, LayerXResult, Series, Summary } from '../../api/layerx';
import { fmt, PSI, VERDICT } from '../layerx/format';
import { alignOnto } from './charts/resample';
import type { ChartSeries } from './charts/types';
import type { GlossaryKey } from './glossary';
import { eventKeyOf, serverGrading, trippedOf } from './contract';
import type { TimeEvent } from './time/store';
import { compareMargins, delta, deltaText, gradeLimit, marginScale, worst, type LimitSpec, type Status } from './ui';
import { STD_ATM_PSIA, type Quantity, type QuantityKind, type Units } from './units';

/**
 * Everything the Burn pages read from one LayerXResult, derived once per run.
 *
 *   clock       the twin's steps, on the burn clock (Fire = 0, as the backend writes them)
 *   chamber     EngineDesign's delivered values (the erosion replay) on the twin's firing steps,
 *               the twin's own where there is no replay; null off the firing steps
 *   events      the timeline's: T−0, Fire, each tank's lowest and dry, burnout, the closest
 *               margins' worst moments
 *   limits      every graded limit, ported from layerx/LayerXResult.tsx verdictItems, each with the
 *               moment it was worst (found in the series) so a margin bar can jump there
 *
 * Pure apart from the memo at the bottom: the tests call `deriveRunData` directly.
 */

export type Side = 'oxidiser' | 'fuel';
/** The display quantity a limit's numbers are in (lx/units.ts). Model units: fraction for percent,
 * psi for pgap and dp, kg for mass. */
export type LimitKind = Extract<QuantityKind,
  'ratio' | 'percent' | 'pgap' | 'dp' | 'mass' | 'pressure' | 'mdot' | 'time' | 'length' | 'force' | 'temp' | 'frequency' | 'velocity'>;

export interface GradedLimit {
  key: string;
  label: string;
  kind: LimitKind;
  /** In model units; null when the run does not carry it. */
  value: number | null;
  /** In model units. */
  spec: LimitSpec;
  status: Status;
  /** Distance to the nearest edge in amber-band widths (unit-free): for sorting worst-first. */
  margin: number;
  /** When it was worst [s, burn clock]; null when it has no moment. */
  worstT: number | null;
  /** "min" / "max" / "at": how the worst moment is named ("min at T+3.52 s"). */
  worstWord: 'min' | 'max' | 'at' | 'worst';
  /** The chart series the worst point lies on: a focus ring lands there. */
  focusKey: string;
  hint: string;
  termKey?: GlossaryKey;
  /** Graded "info" by the backend (max-Q): shown, never counted in the verdict, no bar. */
  info?: boolean;
  /** The backend's group (stability, injector, tanks, ...), when it grades the run. */
  group?: string;
  /** The backend states no red line for it (an amber edge or a count only): a status row, not a bar. */
  noLine?: boolean;
  /** From a new diagnostic, graded amber at worst until the team reviews it. */
  reviewPending?: boolean;
  /** An AUDIT decision it waits on. */
  decision?: string;
  /** The value and the limit as printed, in the page's units. */
  text(u: Units): { value: string; limit: string };
}

/** A graded check with no scale to draw: the model's own health. */
export interface CheckRow {
  key: string;
  label: string;
  status: Status;
  value: string;
  limit: string;
  hint: string;
  /** The value and the limit in the page's units, when the row has a quantity (the server's rows). */
  text?: (u: Units) => { value: string; limit: string };
  worstT?: number | null;
}

export interface Figures {
  burnTime: number;
  /** "LOX ran out" / "fuel ran out" / "still burning at the horizon". */
  dryWords: string;
  impulseNs: number;
  burnedKg: number;
  meanThrustN: number | null;
  minThrustN: number | null;
  peakThrustN: number | null;
  pcMeanPsia: number | null;
  pcMinPsia: number | null;
  pcMaxPsia: number | null;
  ofMean: number | null;
  ofMin: number | null;
  ofMax: number | null;
  ispMean: number | null;
  throatGrowth: number | null;
  apogeeM: number | null;
  bottleEndPsia: number | null;
  /** Bottle over the tanks' lockup at burnout [psi]. */
  bottleMarginPsi: number | null;
}

/** One run's columns on its own clock. Firing-only quantities are null off the firing steps. */
export interface RunColumns {
  thrust: (number | null)[];
  /** The twin's own thrust (as built) when the delivered replaces it; else null. */
  thrustAsBuilt: (number | null)[] | null;
  pc: (number | null)[];
  isp: (number | null)[];
  of: (number | null)[];
  mdotO: (number | null)[];
  mdotF: (number | null)[];
  stiffO: (number | null)[];
  stiffF: (number | null)[];
  chug: (number | null)[] | null;
  injO: (number | null)[];
  injF: (number | null)[];
  tankO: number[];
  tankF: number[];
  bottlePsia: number[];
  ullageO: number[];
  ullageF: number[];
  liquidO: number[];
  liquidF: number[];
}

export interface RunData {
  result: LayerXResult;
  t: number[];
  firing: boolean[];
  /** Series index → delivered index, for the firing steps. */
  firingIndex: Map<number, number>;
  fireT: number;
  burnoutT: number;
  /** What psig is read against (the DAQ's standard atmosphere unless the run says otherwise). */
  gaugeZeroPsia: number;
  /** The site's atmosphere, which the tank walls see. */
  ambientPsia: number;
  band: Record<Side, [number, number] | null>;
  cols: RunColumns;
  events: TimeEvent[];
  /** Worst first. */
  limits: GradedLimit[];
  checks: CheckRow[];
  verdict: Status;
  figures: Figures;
  flight: FlightResult | null;
}

// ------------------------------------------------------------------ small pure helpers

/** Series index → delivered index for each firing step: the replay is written on firing steps only. */
export function firingIndexOf(series: Pick<Series, 'firing'>): Map<number, number> {
  const m = new Map<number, number>();
  let k = 0;
  series.firing.forEach((f, i) => { if (f) m.set(i, k++); });
  return m;
}

/** A delivered column on the twin's clock: its value on each firing step, null elsewhere. */
export function alignFiring(n: number, firingIndex: Map<number, number>, col: readonly (number | null)[] | undefined | null): (number | null)[] {
  const out: (number | null)[] = new Array(n).fill(null);
  if (!col) return out;
  for (const [i, k] of firingIndex) {
    const v = col[k];
    out[i] = v === undefined || v === null || !Number.isFinite(v) ? null : v;
  }
  return out;
}

/** The values on the firing steps only. */
export function firingOnly(values: readonly (number | null | undefined)[], firing: readonly boolean[]): (number | null)[] {
  return firing.map((f, i) => {
    const v = values[i];
    return f && v !== null && v !== undefined && Number.isFinite(v) ? v : null;
  });
}

/** Index of the lowest (or highest) finite value inside `mask`; -1 when there is none. Ties: the first. */
export function argExtreme(values: readonly (number | null | undefined)[], which: 'min' | 'max', mask?: readonly boolean[]): number {
  let best = -1;
  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (best < 0 || (which === 'min' ? v < (values[best] as number) : v > (values[best] as number))) best = i;
  }
  return best;
}

/**
 * Index where the series reads the value a summary reports (the backend's own min, which may
 * leave out a window such as ignition): nearest in value inside `mask`, the first of equals.
 * -1 when there is none.
 */
export function indexOfValue(values: readonly (number | null | undefined)[], target: number | null | undefined, mask?: readonly boolean[]): number {
  if (target === null || target === undefined || !Number.isFinite(target)) return -1;
  let best = -1;
  let gap = Infinity;
  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const d = Math.abs(v - target);
    if (d < gap - 1e-12) { gap = d; best = i; }
  }
  return best;
}

const at = (t: readonly number[], i: number): number | null => (i >= 0 && i < t.length ? t[i] : null);

/** A limit's spec in the page's units (each limit kind converts linearly, with no offset). */
export function displaySpec(spec: LimitSpec, to: (x: number) => number): LimitSpec {
  const m = (x: number | undefined) => (x === undefined ? undefined : to(x));
  return {
    limit: to(spec.limit),
    warn: m(spec.warn),
    direction: spec.direction,
    span: spec.span ? [to(spec.span[0]), to(spec.span[1])] : undefined,
    far: spec.far ? { warn: m(spec.far.warn), limit: m(spec.far.limit) } : undefined,
  };
}

// ------------------------------------------------------------------ events

/** The backend's stable event keys (DATA-CONTRACT 4) and what the timeline calls them. */
const KEYED: Record<string, { label: string; kind: string }> = {
  t0: { label: 'T−0', kind: 't0' },
  fuel_lead: { label: 'Fuel lead', kind: 'lead' },
  fire: { label: 'Fire', kind: 'fire' },
  ignition: { label: 'Ignition', kind: 'ignition' },
  min_chug: { label: 'Min chug', kind: 'min' },
  dry_ox: { label: 'LOX dry', kind: 'dry' },
  dry_fuel: { label: 'Fuel dry', kind: 'dry' },
  burnout: { label: 'Burnout', kind: 'burnout' },
  // A trip stops the burn: the timeline's strongest marker, in the failure colour.
  trip: { label: 'Trip', kind: 'trip' },
};

/** The backend's event labels are sentences; the timeline wants a word or two. */
function shortLabel(e: BurnEvent): string {
  const k = eventKeyOf(e);
  if (k && KEYED[k]) return KEYED[k].label;
  if (e.kind === 't0') return 'T−0';
  if (e.kind === 'fire') return 'Fire';
  const side = /\blox\b|oxid/i.test(e.label) ? 'LOX' : /fuel|ethanol/i.test(e.label) ? 'Fuel' : '';
  if (/dry|empty|ran out/i.test(e.label)) return side ? `${side} dry` : 'Dry';
  if (e.kind === 'min' && /lowest|min/i.test(e.label)) return side ? `${side} tank low` : 'Lowest';
  return e.label.length > 18 ? `${e.label.slice(0, 17)}…` : e.label;
}

function eventKind(e: BurnEvent): string {
  const k = eventKeyOf(e);
  if (k && KEYED[k]) return KEYED[k].kind;
  if (k?.startsWith('warn')) return 'warn';
  if (e.kind === 'end' && /dry|empty|ran out/i.test(e.label)) return 'dry';
  return e.kind;
}

/**
 * The timeline's events: the backend's (T−0, Fire, lows, dry, warnings), burnout, and the worst
 * moment of the closest margins (chug, the lower ΔP/Pc). Keys are unique; the backend's own keys
 * are kept when it writes them, and a moment it already marks (burnout, min chug) is not added
 * twice.
 */
export function timelineEvents(events: readonly BurnEvent[], burnoutT: number | null, limits: readonly GradedLimit[]): TimeEvent[] {
  const out: TimeEvent[] = [];
  const seen = new Map<string, number>();
  const key = (base: string) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  const backendKeys = new Set<string>();
  for (const e of events) {
    if (!Number.isFinite(e.t)) continue;
    const kind = eventKind(e);
    const own = eventKeyOf(e);
    if (own) backendKeys.add(own);
    const base = own ?? (kind === 't0' || kind === 'fire' ? kind : `${kind}-${shortLabel(e).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    out.push({ t: e.t, key: key(base), label: shortLabel(e), kind });
  }
  if (burnoutT !== null && Number.isFinite(burnoutT) && !backendKeys.has('burnout')) out.push({ t: burnoutT, key: key('burnout'), label: 'Burnout', kind: 'burnout' });
  const chug = limits.find((l) => l.focusKey === 'chug');
  if (chug && chug.worstT !== null && !backendKeys.has('min_chug')) out.push({ t: chug.worstT, key: key('min-chug'), label: 'Min chug', kind: 'min' });
  const stiff = limits.filter((l) => l.focusKey === 'stiff_lox' || l.focusKey === 'stiff_fuel').filter((l) => l.value !== null && l.worstT !== null)
    .sort((a, b) => (a.value as number) - (b.value as number))[0];
  if (stiff) out.push({ t: stiff.worstT as number, key: key('min-stiff'), label: 'Min ΔP/Pc', kind: 'min' });
  return out.sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ limits (verdictItems, ported)

interface VerdictContext {
  chug?: { min: number | null | undefined; t: number | null | undefined } | null;
  /** psi across the wall, per side, from the drawing; and the site's atmosphere [psia]. */
  mawp?: { oxidiser?: number; fuel?: number; ambientPsia: number } | null;
  converged?: boolean;
  cardOutside?: number | null;
}

interface Clock {
  t: readonly number[];
  firing: readonly boolean[];
  burnoutT: number | null;
  stiffO: readonly (number | null)[];
  stiffF: readonly (number | null)[];
  tankO: readonly number[];
  tankF: readonly number[];
  chug: readonly (number | null)[] | null;
}

const pctText = (x: number) => `${fmt(x * 100)}`;

function limitOf(base: Omit<GradedLimit, 'status' | 'margin'>): GradedLimit {
  const v = base.value;
  const status = v === null || !Number.isFinite(v) ? 'warn' : gradeLimit(base.spec, v);
  const margin = marginScale(base.spec, v).margin;
  return { ...base, status, margin };
}

/**
 * Every limit the burn is graded against, with the thresholds of layerx/LayerXResult.tsx
 * verdictItems (VERDICT in layerx/format.ts), plus when each was worst. Unsorted.
 */
export function gradeRun(s: Summary, band: Record<Side, [number, number] | null>, clock: Clock, engine: EngineCheck | undefined,
                         ctx: VerdictContext = {}): { limits: GradedLimit[]; checks: CheckRow[] } {
  const limits: GradedLimit[] = [];
  const checks: CheckRow[] = [];
  const tOf = (i: number) => at(clock.t, i);

  // Chug: the replay's gain margin, lowest over the burn (ignition included).
  if (ctx.chug && ctx.chug.min !== null && ctx.chug.min !== undefined && Number.isFinite(ctx.chug.min)) {
    const min = ctx.chug.min;
    const tWorst = ctx.chug.t !== null && ctx.chug.t !== undefined && Number.isFinite(ctx.chug.t)
      ? ctx.chug.t : tOf(clock.chug ? argExtreme(clock.chug, 'min', clock.firing) : -1);
    limits.push(limitOf({
      key: 'chug', label: 'Chug margin', kind: 'ratio', value: min, worstT: tWorst, worstWord: 'min', focusKey: 'chug', termKey: 'chugMargin',
      spec: { limit: 1, warn: VERDICT.chugMarginWarn, direction: 'higher-is-safer' },
      hint: `EngineDesign's feed-coupled gain margin, the lowest over the whole burn (ignition included), worst over the mixing-lag band. Below 1 the loop is predicted unstable; amber under ${VERDICT.chugMarginWarn}.`,
      text: (u) => ({ value: u.fmt(u.ratio(min)), limit: '> 1' }),
    }));
  }

  // Injector stiffness, each side: the design's band, or the floor when it sets none.
  for (const side of ['oxidiser', 'fuel'] as const) {
    const ss = side === 'oxidiser' ? s.ox : s.fuel;
    const b = band[side];
    const v = ss.stiffness_min;
    const series = side === 'oxidiser' ? clock.stiffO : clock.stiffF;
    const name = side === 'oxidiser' ? 'LOX' : 'Fuel';
    const spec: LimitSpec = b
      ? { limit: b[0], direction: 'higher-is-safer', far: { warn: b[1] } }
      : { limit: VERDICT.stiffnessFloor, direction: 'higher-is-safer' };
    const limitWords = b ? `${pctText(b[0])}–${pctText(b[1])} %` : `≥ ${pctText(VERDICT.stiffnessFloor)} %`;
    limits.push(limitOf({
      key: side === 'oxidiser' ? 'stiff_lox' : 'stiff_fuel', label: `${name} injector ΔP/Pc`, kind: 'percent', value: v,
      worstT: tOf(indexOfValue(series, v, clock.firing)), worstWord: 'min', focusKey: side === 'oxidiser' ? 'stiff_lox' : 'stiff_fuel',
      termKey: 'stiffness', spec,
      hint: `Lowest injector pressure drop over chamber pressure through the burn; ${b ? `the design's band is ${pctText(b[0])}–${pctText(b[1])} %` : `the design sets no band, so it is graded against ${pctText(VERDICT.stiffnessFloor)} %`}. Too low invites chug.`,
      text: (u) => ({ value: u.fmt(u.pct(v)), limit: limitWords }),
    }));
  }

  // Tank peak across the wall against the drawing's MAWP.
  for (const side of ['oxidiser', 'fuel'] as const) {
    const peak = (side === 'oxidiser' ? s.ox : s.fuel).peak_psia;
    const rating = ctx.mawp?.[side];
    if (peak === null || peak === undefined || rating === null || rating === undefined || !ctx.mawp) continue;
    const across = peak - ctx.mawp.ambientPsia;
    const tank = side === 'oxidiser' ? clock.tankO : clock.tankF;
    const name = side === 'oxidiser' ? 'LOX' : 'Fuel';
    limits.push(limitOf({
      key: side === 'oxidiser' ? 'peak_lox' : 'peak_fuel', label: `${name} tank peak`, kind: 'pgap', value: across,
      worstT: tOf(argExtreme(tank, 'max')), worstWord: 'max', focusKey: side === 'oxidiser' ? 'lox_tank' : 'fuel_tank', termKey: 'mawp',
      spec: { limit: rating, warn: VERDICT.ratingUse * rating, direction: 'lower-is-safer' },
      hint: `Highest pressure across the wall over the hold and the burn: ${fmt((across / rating) * 100, 0)} % of the drawing's MAWP (amber above ${fmt(VERDICT.ratingUse * 100, 0)} %).`,
      text: (u) => ({ value: u.fmt(u.gap(across)), limit: `≤ ${u.fmt(u.gap(rating))} MAWP` }),
    }));
  }

  // The bottle over the tanks' lockup at burnout.
  const lockup = Math.max(s.ox.t0_psia, s.fuel.t0_psia);
  const copvMargin = s.copv_end_psia !== null && s.copv_end_psia !== undefined ? s.copv_end_psia - lockup : null;
  limits.push(limitOf({
    key: 'bottle', label: 'Bottle over lockup at burnout', kind: 'pgap', value: copvMargin, worstT: clock.burnoutT, worstWord: 'at', focusKey: 'bottle',
    termKey: 'lockup',
    spec: { limit: VERDICT.copvHeadroomPsi, warn: 2 * VERDICT.copvHeadroomPsi, direction: 'higher-is-safer' },
    hint: `How far the bottle is above the tanks' lockup when the burn ends. Under ${VERDICT.copvHeadroomPsi} psi the regulator stops holding tank pressure; amber under ${2 * VERDICT.copvHeadroomPsi}.`,
    text: (u) => ({ value: u.fmt(u.gap(copvMargin)), limit: `≥ ${u.fmt(u.gap(VERDICT.copvHeadroomPsi))} over lockup` }),
  }));

  // Tank sag: the deeper side's dip below lockup while firing.
  const droopO = s.ox.t0_psia - (s.ox.min_psia ?? s.ox.t0_psia);
  const droopF = s.fuel.t0_psia - (s.fuel.min_psia ?? s.fuel.t0_psia);
  const droop = Math.max(droopO, droopF);
  const sagSide: Side = droopF > droopO ? 'fuel' : 'oxidiser';
  limits.push(limitOf({
    key: 'sag', label: 'Tank pressure sag', kind: 'dp', value: droop,
    worstT: tOf(argExtreme(sagSide === 'oxidiser' ? clock.tankO : clock.tankF, 'min', clock.firing)), worstWord: 'min',
    focusKey: sagSide === 'oxidiser' ? 'lox_tank' : 'fuel_tank', termKey: 'tankPressure',
    spec: { limit: VERDICT.droopPsi[1], warn: VERDICT.droopPsi[0], direction: 'lower-is-safer' },
    hint: `Deepest dip below the set tank pressure while firing (${sagSide === 'oxidiser' ? 'LOX' : 'fuel'} side; amber over ${VERDICT.droopPsi[0]}, red over ${VERDICT.droopPsi[1]} psi).`,
    text: (u) => ({ value: u.fmt(u.dp(droop)), limit: `< ${u.fmt(u.dp(VERDICT.droopPsi[0]))}` }),
  }));

  // Which tank runs dry first, and by how much: inside the Cd scatter it is a coin toss.
  const residual = s.depleted_side === 'oxidiser' ? s.fuel.residual_kg : s.depleted_side === 'fuel' ? s.ox.residual_kg : null;
  const first = s.depleted_side === 'oxidiser' ? 'LOX' : s.depleted_side === 'fuel' ? 'Fuel' : null;
  const tie = VERDICT.depletionTie * (s.ox.loaded_kg + s.fuel.loaded_kg);
  if (residual !== null && first) {
    limits.push(limitOf({
      key: 'dry_first', label: 'Runs dry first', kind: 'mass', value: residual, worstT: clock.burnoutT, worstWord: 'at', focusKey: 'burnout',
      termKey: 'residual',
      // Information only: one tank always runs dry first (the team, 2026-10-03). Left-over propellant
      // above VERDICT.residualKg is the check worth a look.
      spec: { limit: 0, direction: 'higher-is-safer' },
      info: true,
      hint: `Propellant still in the other tank when ${first === 'LOX' ? 'the LOX' : 'the fuel'} runs out. Under ${fmt(VERDICT.depletionTie * 100, 0)} % of the load (${fmt(tie, 2)} kg) the orifice Cd's ±3 % scatter decides which tank empties first: on the stand it may be the other one.`,
      text: (u) => ({ value: `${first}, by ${u.fmt(u.m(residual))}`, limit: `clear by ≥ ${u.fmt(u.m(tie))}` }),
    }));
  }

  // The burn against EngineDesign: a bar only when it is worth a look.
  const engineGap = engine?.available && engine.worst
    ? Math.max(engine.worst.pc, engine.worst.mdot_O, engine.worst.mdot_F, engine.against === 'replay' ? 0 : engine.worst.thrust) : null;
  if (engineGap !== null && engineGap >= VERDICT.replayAgreement[0]) {
    const rows = engine?.rows ?? [];
    const gapOf = (r: (typeof rows)[number]) => {
      const x = r.rel;
      if (!x) return null;
      const parts = [x.pc, x.mdot_O, x.mdot_F, engine?.against === 'replay' ? 0 : x.thrust].filter((p): p is number => p !== null && p !== undefined);
      return parts.length ? Math.max(...parts.map(Math.abs)) : null;
    };
    const worstRow = argExtreme(rows.map(gapOf), 'max');
    limits.push(limitOf({
      key: 'engine_fit', label: 'Engine fit', kind: 'percent', value: engineGap, worstT: worstRow >= 0 ? rows[worstRow].t : null, worstWord: 'max',
      focusKey: 'pc', spec: { limit: VERDICT.replayAgreement[1], warn: VERDICT.replayAgreement[0], direction: 'lower-is-safer' },
      hint: 'The burn and EngineDesign disagree on chamber pressure or flow by this much. See Record → Engine fit.',
      text: (u) => ({ value: `${u.fmt(u.pct(engineGap))} off`, limit: `< ${fmt(VERDICT.replayAgreement[0] * 100, 1)} %` }),
    }));
  }

  if (residual !== null && residual > VERDICT.residualKg) {
    checks.push({ key: 'leftover', label: 'Propellant left over', status: 'warn', value: `${fmt(residual, 2)} kg`, limit: `< ${VERDICT.residualKg} kg`,
      hint: 'Propellant carried to burnout and never burned: dead mass in flight.' });
  }
  if (ctx.converged === false) {
    checks.push({ key: 'model', label: 'Model', status: 'warn', value: 'not settled', limit: 'settled',
      hint: 'The erosion replay or the flight coupling did not settle, or the replay failed: thrust and Pc may be the as-built throat\'s. See Record → Events.' });
  }
  if (ctx.cardOutside) {
    checks.push({ key: 'card', label: 'Engine table', status: 'warn', value: `${ctx.cardOutside} steps outside`, limit: 'none outside',
      hint: 'The burn asked the engine table about points outside what it was fitted to; those steps are extrapolated.' });
  }
  if (s.failed_steps || !s.t0_settled) {
    checks.push({ key: 'solver', label: 'Solver', status: 'warn', value: s.failed_steps ? `${s.failed_steps} of ${s.steps} steps held` : 'did not settle',
      limit: 'every step solved', hint: 'A step the solver could not close holds its last good flows.' });
  }
  return { limits, checks };
}

/** The headline as the verdict strip says it. */
export function verdictLine(limits: readonly Pick<GradedLimit, 'status' | 'info'>[], checks: readonly Pick<CheckRow, 'status'>[]): { status: Status; title: string } {
  const all = [...limits.filter((l) => !l.info), ...checks];
  const status = worst(all.map((x) => x.status));
  const bad = all.filter((x) => x.status === 'bad').length;
  const warn = all.filter((x) => x.status === 'warn').length;
  const title = status === 'bad' ? `Breaks ${bad} limit${bad > 1 ? 's' : ''}`
    : status === 'warn' ? `Within limits, ${warn} to check` : `Within all ${all.length} limits`;
  return { status, title };
}

// ------------------------------------------------------------------ the whole run

function figuresOf(s: Summary, d: Delivered['summary'] | undefined, flight: FlightResult | null): Figures {
  const lockup = Math.max(s.ox.t0_psia, s.fuel.t0_psia);
  return {
    burnTime: s.burn_time_s,
    dryWords: s.depleted_side === 'oxidiser' ? 'LOX ran out' : s.depleted_side === 'fuel' ? 'Fuel ran out' : 'Still burning at the horizon',
    impulseNs: d?.total_impulse_Ns ?? s.total_impulse_Ns,
    burnedKg: d?.propellant_burned_kg ?? s.propellant_used_kg,
    meanThrustN: d?.mean_thrust_N ?? s.mean_thrust_N,
    minThrustN: d?.min_thrust_N ?? s.min_thrust_N,
    peakThrustN: d?.peak_thrust_N ?? s.peak_thrust_N,
    pcMeanPsia: d?.pc_mean_psia ?? s.pc_mean_psia,
    pcMinPsia: d?.pc_min_psia ?? s.pc_min_psia,
    pcMaxPsia: d?.pc_max_psia ?? s.pc_max_psia,
    ofMean: s.of_mean,
    ofMin: s.of_min,
    ofMax: s.of_max,
    ispMean: d?.isp_mean_s ?? s.isp_mean_s,
    throatGrowth: d?.throat_area_growth ?? null,
    apogeeM: flight?.ok ? flight.apogee_agl_m : null,
    bottleEndPsia: s.copv_end_psia,
    bottleMarginPsi: s.copv_end_psia !== null && s.copv_end_psia !== undefined ? s.copv_end_psia - lockup : null,
  };
}

export function deriveRunData(result: LayerXResult): RunData {
  const { series, summary, provenance } = result;
  const t = series.t;
  const n = t.length;
  const firing = series.firing;
  const firingIndex = firingIndexOf(series);
  const dv = result.delivered ?? null;
  const derived = (provenance.derived ?? {}) as Record<string, unknown>;

  const firstFiring = firing.indexOf(true);
  const lastFiring = firing.lastIndexOf(true);
  const fireEvent = result.events.find((e) => e.kind === 'fire');
  const fireT = fireEvent?.t ?? (firstFiring > 0 ? t[firstFiring - 1] : t[0] ?? 0);
  const burnoutT = lastFiring >= 0 ? t[lastFiring] : (t[n - 1] ?? 0);

  const gaugeZeroPsia = typeof derived.gauge_zero_pa === 'number' ? derived.gauge_zero_pa / PSI : STD_ATM_PSIA;
  const ambientPsia = typeof derived.ambient_pa === 'number' ? derived.ambient_pa / PSI : STD_ATM_PSIA;
  const rawBand = (derived.stiffness_band ?? {}) as Record<string, number[] | null | undefined>;
  const bandOf = (k: Side): [number, number] | null => {
    const b = rawBand[k];
    return Array.isArray(b) && b.length >= 2 && Number.isFinite(b[0]) && Number.isFinite(b[1]) ? [b[0], b[1]] : null;
  };
  const band = { oxidiser: bandOf('oxidiser'), fuel: bandOf('fuel') };

  const fire = (v: readonly (number | null | undefined)[]) => firingOnly(v, firing);
  const dvCol = (k: keyof Delivered) => alignFiring(n, firingIndex, dv?.[k] as (number | null)[] | undefined);
  const twinThrust = fire(series.chamber.thrust_N);
  const cols: RunColumns = {
    thrust: dv ? dvCol('thrust_N') : twinThrust,
    thrustAsBuilt: dv ? twinThrust : null,
    pc: dv ? dvCol('pc_psia') : fire(series.chamber.pc_psia),
    isp: dv ? dvCol('isp_s') : fire(series.chamber.isp_s),
    of: dv?.mr ? dvCol('mr') : fire(series.chamber.mr),
    mdotO: fire(series.ox.mdot),
    mdotF: fire(series.fuel.mdot),
    stiffO: fire(series.ox.stiffness),
    stiffF: fire(series.fuel.stiffness),
    chug: dv?.chug_margin ? dvCol('chug_margin') : null,
    injO: fire(series.ox.manifold_psia),
    injF: fire(series.fuel.manifold_psia),
    tankO: series.ox.tank_psia,
    tankF: series.fuel.tank_psia,
    bottlePsia: series.copv_psia,
    ullageO: series.ox.ullage_K,
    ullageF: series.fuel.ullage_K,
    liquidO: series.ox.liquid_kg,
    liquidF: series.fuel.liquid_kg,
  };

  const roles = (derived.roles ?? {}) as Record<string, string>;
  const mawps = (derived.tank_mawp_psi ?? {}) as Record<string, number>;
  const ctx: VerdictContext = {
    chug: dv?.summary ? { min: dv.summary.chug_margin_min, t: dv.summary.chug_margin_min_t } : null,
    mawp: { oxidiser: mawps[roles.oxidiser], fuel: mawps[roles.fuel], ambientPsia },
    converged: result.converged,
    cardOutside: summary.card_outside_steps ?? null,
  };
  const clock: Clock = {
    t, firing, burnoutT, stiffO: cols.stiffO, stiffF: cols.stiffF, tankO: cols.tankO, tankF: cols.tankF, chug: cols.chug,
  };
  // The backend's graded list when it writes one (DATA-CONTRACT 1): its bars and its status rows
  // replace the ported thresholds and checks; a run saved before it carries the ported ones.
  const server = serverGrading(result);
  const graded = server ?? gradeRun(summary, band, clock, result.engine_check, ctx);
  const limits = [...graded.limits].sort((a, b) => compareMargins(a, b));
  const flight = result.flight ?? null;

  return {
    result, t, firing, firingIndex, fireT, burnoutT, gaugeZeroPsia, ambientPsia, band, cols,
    events: timelineEvents(result.events, burnoutT, limits),
    limits, checks: graded.checks,
    // A trip stops the burn where it is (DATA-CONTRACT 4): the run fails whatever its margins say.
    verdict: trippedOf(result) ? 'bad' : verdictLine(limits, graded.checks).status,
    figures: figuresOf(summary, dv?.summary, flight),
    flight,
  };
}

/** Another run's column on this run's clock (both have Fire = 0); null outside its samples. */
export function ghostOf(here: Pick<RunData, 't'>, ref: Pick<RunData, 't'> | null, values: readonly (number | null)[] | null | undefined): (number | null)[] | null {
  if (!ref || !values) return null;
  return alignOnto(here.t, ref.t, values);
}

/** A column through a display conversion, gaps kept. */
export function convert(values: readonly (number | null | undefined)[] | null | undefined, to: (x: number) => number): (number | null)[] {
  return (values ?? []).map((v) => (v === null || v === undefined || !Number.isFinite(v) ? null : to(v)));
}

/**
 * The compared run's column as the chart's grey line (one per chart, unlabelled: the readout says
 * "vs"), on this run's clock; nothing when there is no comparison.
 */
export function ghostSeries(key: string, here: Pick<RunData, 't'>, vs: RunData | null,
                            pick: (r: RunData) => readonly (number | null)[] | null | undefined, to: (x: number) => number = (x) => x): ChartSeries[] {
  if (!vs) return [];
  const g = ghostOf(here, vs, pick(vs));
  return g ? [{ key: `${key}_vs`, label: '', color: '', values: convert(g, to), ghost: true }] : [];
}

/** A figure's change against the compared run, at the figure's own digits: "+0.11 s", "−2.9 %". */
export function figureDelta(cur: Quantity, ref: Quantity | null | undefined, mode: 'abs' | 'pct' | 'both' = 'abs'): string | null {
  if (!ref) return null;
  return deltaText(delta(cur.value, ref.value, cur.digits), { digits: cur.digits, unit: differenceUnit(cur.unit), mode });
}

/** A change in a pressure is a difference, which has no datum: "+401 psi", never "+401 psig". */
export function differenceUnit(unit: string): string {
  return unit.replace(/^psi[ag]$/, 'psi').replace(/^bar\([ag]\)$/, 'bar');
}

/** The run's derived data, once per result; and the compared run's, once per pick. */
export function useRunData(result: LayerXResult | null, reference: LayerXResult | null): { data: RunData | null; ref: RunData | null } {
  const data = useMemo(() => (result ? deriveRunData(result) : null), [result]);
  const ref = useMemo(() => (reference ? deriveRunData(reference) : null), [reference]);
  return { data, ref };
}
