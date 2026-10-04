import { niceTicks, stepDigits } from '../../layerx/format';
import { num } from './measure';

/**
 * Tick rules every Layer X chart shares (the uPlot time charts, the x-y charts, the heatmap and the
 * timeline), so two charts on one page never disagree about how an axis reads.
 *
 * - Ticks fall on round values only.
 * - One axis prints one number of decimals, from its step: 0 / 1 / 2 / 3, or 0.0 / 0.5 / 1.0.
 * - A time axis takes its step from the span, not from the chart's width, so every chart over
 *   the same burn ticks the same seconds; only a chart too narrow for that step coarsens.
 * - The unit rides on the last x tick ("3 s"); a y axis's unit heads its tick column.
 */

/** Steps a time axis may take, per decade: whole seconds, halves and fifths read cleanly; 2.5 s
 * and 0.25 s do not. */
const TIME_MANTISSAS = [1, 2, 5];
/** At most this many ticks across a time axis. */
export const TIME_MAX_TICKS = 7;
/** The least room between two time ticks [px]: "0.5" and its neighbour with air between. */
export const TIME_MIN_GAP_PX = 44;

/** The smallest step of 1, 2 or 5 × 10ⁿ at or above `x`. */
function stepAtLeast(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  let mag = 10 ** Math.floor(Math.log10(x));
  for (;;) {
    for (const m of TIME_MANTISSAS) {
      const c = Number((m * mag).toPrecision(12));
      if (c >= x * (1 - 1e-9)) return c;
    }
    mag *= 10;
  }
}

/**
 * The tick step of a time axis spanning `span` seconds drawn `px` wide: the finest step that
 * keeps the axis to TIME_MAX_TICKS (a function of the span alone, so charts over the same burn
 * agree), coarsened only when the chart is too narrow to fit it.
 */
export function timeStep(span: number, px: number, opts: { maxTicks?: number; minGapPx?: number } = {}): number {
  const maxTicks = opts.maxTicks ?? TIME_MAX_TICKS;
  const minGap = opts.minGapPx ?? TIME_MIN_GAP_PX;
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  let step = stepAtLeast(span / Math.max(1, maxTicks - 1));
  // Too narrow for that step: the next one up until the ticks have room (or only two are left).
  while (px > 0 && (px * step) / span < minGap && span / step > 1) step = stepAtLeast(step * 1.0001);
  return step;
}

/** Multiples of `step` inside [lo, hi], printed exactly. */
export function ticksAt(lo: number, hi: number, step: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(step > 0) || hi < lo) return [];
  const out: number[] = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) out.push(Number((k * step).toPrecision(12)));
  return out;
}

export interface AxisTicks {
  ticks: number[];
  step: number;
  /** Decimals every tick on the axis prints. */
  digits: number;
}

/** A time axis over [lo, hi] drawn `px` wide. */
export function timeTicks(lo: number, hi: number, px: number): AxisTicks {
  const step = timeStep(hi - lo, px);
  return { ticks: ticksAt(lo, hi, step), step, digits: stepDigits(step) };
}

/** A plain linear axis over [lo, hi] (no shared-span rule): about `count` round ticks. */
export function linearTicks(lo: number, hi: number, count: number): AxisTicks {
  const ticks = niceTicks(lo, hi, count);
  const step = ticks.length > 1 ? Number((ticks[1] - ticks[0]).toPrecision(12)) : 1;
  return { ticks, step, digits: ticks.length > 1 ? stepDigits(step) : 0 };
}

/**
 * Ticks of a log axis over [lo, hi] (both > 0) drawn `px` wide: every decade, and 2 and 5 between
 * them when there is room. Each tick prints the decimals it needs and no more (0.2, 1, 50).
 */
export function logTicks(lo: number, hi: number, px: number, minGapPx = 34): { ticks: number[]; labels: string[] } {
  if (!(lo > 0) || !(hi > lo) || !Number.isFinite(hi)) return { ticks: [], labels: [] };
  const d0 = Math.floor(Math.log10(lo) + 1e-9);
  const d1 = Math.ceil(Math.log10(hi) - 1e-9);
  const decades = Math.max(1, Math.log10(hi / lo));
  const perDecade = px / decades;
  const within = (mants: number[]) => {
    const out: number[] = [];
    for (let d = d0; d <= d1; d++) {
      for (const m of mants) {
        const v = Number((m * 10 ** d).toPrecision(12));
        if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) out.push(v);
      }
    }
    return out;
  };
  // Decades; 1-2-5 when a decade has room for three labels, or when decades alone leave fewer
  // than two ticks; every integer mantissa on an axis shorter than that.
  let ticks = within(perDecade >= 3 * minGapPx ? [1, 2, 5] : [1]);
  if (ticks.length < 2) ticks = within([1, 2, 5]);
  if (ticks.length < 2) ticks = within([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const labels = ticks.map((v) => num(v, Math.max(0, -Math.floor(Math.log10(v) + 1e-9))));
  return { ticks, labels };
}

/** The x tick labels: every tick at the axis's decimals, the unit on the last one. */
export function xTickLabels(ticks: readonly number[], digits: number, unit: string): string[] {
  return ticks.map((v, k) => (k === ticks.length - 1 && unit ? `${num(v, digits)}\u00a0${unit}` : num(v, digits)));
}

/**
 * The x range a time chart is drawn over: its data's [min, max], widened to the page's span when it
 * follows the page's cursor, so every chart on a page spans the same seconds and their cursors and
 * ticks stand in one vertical line. A single point is given half a second either side.
 */
export function spanRange(min: number, max: number, shared: readonly [number, number] | null): [number, number] {
  const lo = shared && Number.isFinite(shared[0]) ? Math.min(min, shared[0]) : min;
  const hi = shared && Number.isFinite(shared[1]) ? Math.max(max, shared[1]) : max;
  return lo === hi ? [lo - 0.5, hi + 0.5] : [lo, hi];
}
