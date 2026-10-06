import type { Series } from '../../api/layerx';

/** Shared by the Layer X views: number formatting and the propellant colours. */

export const LOX = 'var(--color-lox)';
export const FUEL = 'var(--color-fuel)';
/** One pound, in kilograms (exact by definition). */
export const LB = 0.45359237;
/** Feet per metre (exact: 0.3048 m per foot). */
export const FT = 1 / 0.3048;
/** Standard gravity [m/s²]. */
export const G0 = 9.80665;
/** One psi in pascals. */
export const PSI = 6894.757293168361;

/** A value of unknown scale at four significant figures: 1.5e-6 is not "0.0000". */
export function sig(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  return a < 1e-3 || a >= 1e6 ? v.toExponential(3) : String(Number(v.toPrecision(4)));
}

export function fmt(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  // A value that rounds to zero is zero: "-0" reads as a sign that means something.
  const shown = Number(v.toFixed(Math.min(Math.max(digits, 0), 20))) === 0 ? 0 : v;
  // Pinned: in a de-DE browser "6.804 N" reads as six newtons.
  return shown.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Decimals an axis needs so its ticks do not round into each other: a 232.4–233.2 s Isp axis
 * printed to whole seconds reads "232 / 233 / 233".
 */
export function tickDigits(lo: number, hi: number, ticks = 4): number {
  const span = Math.abs(hi - lo);
  if (!Number.isFinite(span) || span === 0) return 0;
  const step = span / Math.max(ticks - 1, 1);
  return Math.min(4, Math.max(0, -Math.floor(Math.log10(step))));
}

/**
 * Round ticks inside [lo, hi]: steps of 1, 2, 2.5 or 5 times a power of ten, about `count` of
 * them. An axis reads 400 / 450 / 500 / 550, not 368 / 443 / 517 / 592.
 */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
  const raw = (hi - lo) / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  // The candidate nearest the raw step, on a log scale.
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag)
    .reduce((best, c) => (Math.abs(Math.log(c / raw)) < Math.abs(Math.log(best / raw)) ? c : best));
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** Decimals a tick step needs to print exactly: 2.5 needs one, 0.25 two, 50 none. */
export function stepDigits(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  for (let k = 0; k < 6; k++) if (Math.abs(Math.round(step * 10 ** k) - step * 10 ** k) < 1e-6 * 10 ** k) return k;
  return 6;
}

/** A typed number, or null for anything that is not one (blank included). */
export function finite(text: string): number | null {
  const v = Number(text);
  return text.trim() !== '' && Number.isFinite(v) ? v : null;
}

/** Total impulse, one way everywhere: kN·s to two decimals. */
export function impulse(ns: number | null | undefined): string {
  return ns === null || ns === undefined ? '—' : fmt(ns / 1000, 2);
}

/** psia to psig at the run's own gauge zero (the stand reads gauge). */
export function psig(psia: number | null | undefined, gaugeZeroPsia = 14.6959): number | null {
  return psia === null || psia === undefined || !Number.isFinite(psia) ? null : psia - gaugeZeroPsia;
}

/**
 * The thresholds the verdicts grade by, in one place, each with what it is. None is a
 * requirement from the config; they are judgement, stated so a reader can disagree.
 */
export const VERDICT = {
  /** Bottle above tank lockup at burnout [psi]: the dome regulator needs supply over its outlet
   * to keep regulating. Assumed; the optimiser's headroom constraint defaults to the same number.
   * Replace with the regulator's measured dropout. */
  copvHeadroomPsi: 100,
  /** Tank droop from lockup [psi]: warn, bad. Assumed. */
  droopPsi: [30, 60] as const,
  /** Propellant stranded in the other tank [kg] above which to look. Assumed: ~2 % of the load. */
  residualKg: 0.2,
  /** Injector ΔP/Pc floor when the config states no band. A common chug rule of thumb. */
  stiffnessFloor: 0.15,
  /** Chug gain margin under which to look, though above 1 is predicted stable. Judgement: the
   * margin rests on an unmeasured mixing lag. */
  chugMarginWarn: 1.2,
  /** Peak pressure across a tank wall, as a fraction of its MAWP, above which to look. Judgement. */
  ratingUse: 0.8,
  /** Left-over propellant, as a fraction of the load, under which which tank runs dry first is
   * inside the orifice Cd's ±3 % scatter. */
  depletionTie: 0.03,
  /** Twin against the replay: fine, worth a look [fraction]. The card's own fit is ~0.02 %. */
  replayAgreement: [0.005, 0.02] as const,
};

const NOTHING = { tank_psia: [], outlet_psia: [], inlet_psia: [], dump_psi: [], manifold_psia: [], dp_injector_psi: [],
  stiffness: [], mdot: [], liquid_kg: [], ullage_K: [], liquid_K: [], fill_fraction: [] };

/** No burn yet: the hardware alone. */
export const EMPTY_SERIES: Series = {
  t: [], firing: [], converged: [], copv_psia: [], copv_mass_kg: [], copv_wall_K: [], regulators: {},
  ox: NOTHING, fuel: NOTHING,
  chamber: { pc_psia: [], mr: [], thrust_N: [], isp_s: [], cstar: [], extrapolated: [] },
};
