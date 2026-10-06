import { stepDigits } from '../../layerx/format';
import { unitDigits } from './quantity';

/**
 * The y scale of a chart: the data, any band and limit lines, rounded out to round ticks so the
 * top and bottom gridlines are labelled values (400 / 450 / 500, never 368 / 517).
 */

export interface NiceRange {
  lo: number;
  hi: number;
  step: number;
  ticks: number[];
  /** Decimals a tick needs to print exactly. */
  digits: number;
}

/** Smallest and largest finite value across arrays (nulls and NaN skipped); null when none. */
export function extent(arrays: readonly (readonly (number | null | undefined)[])[], extra: readonly number[] = []): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  for (const v of extra) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

/** The step of 1, 2, 2.5 or 5 × 10ⁿ nearest `raw` on a log scale (format.ts's niceTicks rule). */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const best = [1, 2, 2.5, 5, 10].map((m) => m * mag)
    .reduce((b, c) => (Math.abs(Math.log(c / raw)) < Math.abs(Math.log(b / raw)) ? c : b));
  return Number(best.toPrecision(12));
}

/**
 * [lo, hi] widened to whole ticks, about `count` of them. A flat line gets a span around it so it
 * sits mid-plot rather than on an edge. `pin` fixes either end (null leaves it free).
 */
export function niceRange(lo: number, hi: number, count = 4, pin: readonly [number | null, number | null] = [null, null]): NiceRange {
  let a = pin[0] ?? lo;
  let b = pin[1] ?? hi;
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    a = 0;
    b = 1;
  }
  if (b < a) [a, b] = [b, a];
  if (b - a < 1e-12 * Math.max(1, Math.abs(a))) {
    const half = Math.abs(a) > 0 ? Math.abs(a) * 0.05 : 0.5;
    if (pin[0] === null) a -= half;
    if (pin[1] === null) b += half;
    if (b <= a) b = a + 2 * half;
  }
  // The step for about `count` ticks; the ends rounded out to it, and the ticks at that same step,
  // so the top and bottom of the axis are always labelled gridlines.
  const step = niceStep((b - a) / Math.max(count, 1));
  const lo2 = pin[0] ?? Number((Math.floor(a / step + 1e-9) * step).toPrecision(12));
  const hi2 = pin[1] ?? Number((Math.ceil(b / step - 1e-9) * step).toPrecision(12));
  const ticks: number[] = [];
  for (let k = Math.ceil(lo2 / step - 1e-9); k * step <= hi2 + step * 1e-9; k++) ticks.push(Number((k * step).toPrecision(12)));
  return { lo: lo2, hi: hi2, step, ticks, digits: stepDigits(step) };
}

/** How many ticks fit a span of `px` with at least `minGap` px between them (2 to 8). */
export function tickCount(px: number, minGap: number): number {
  return Math.max(2, Math.min(8, Math.floor(px / minGap)));
}

/** The least room between two y gridlines [px]. */
export const Y_MIN_GAP_PX = 28;

/**
 * A time chart's y axis: the series, any bands and limit lines, rounded out to round ticks about
 * 36 px apart over `plotPx`. A limit or band edge that sets an end of the axis is kept 4 % of the
 * span off the frame, where a dashed line would vanish into the border.
 */
export function yScaleFor(
  d: {
    series: readonly { values: readonly (number | null)[] }[];
    band?: { lo: number; hi: number } | null;
    bands?: readonly { lo: number; hi: number }[];
    limits?: readonly { value: number }[];
    yPin?: readonly [number | null, number | null];
    digits?: number;
    yUnit?: string;
  },
  plotPx: number,
): NiceRange & { readoutDigits: number } {
  const extra: number[] = [];
  for (const b of [...(d.bands ?? []), ...(d.band ? [d.band] : [])]) extra.push(b.lo, b.hi);
  for (const l of d.limits ?? []) extra.push(l.value);
  const ext = extent(d.series.map((s) => s.values), extra) ?? [0, 1];
  const data = extent(d.series.map((s) => s.values));
  const pad = 0.04 * Math.max(ext[1] - ext[0], 1e-9);
  for (const v of extra) {
    if (!Number.isFinite(v)) continue;
    if (!data || v <= data[0]) ext[0] = Math.min(ext[0], v - pad);
    if (!data || v >= data[1]) ext[1] = Math.max(ext[1], v + pad);
  }
  // Rounding the ends out adds up to a tick at each end: fewer asked for until the gridlines are
  // at least Y_MIN_GAP_PX apart.
  const px = Math.max(plotPx, 40);
  let count = tickCount(px, 36);
  let r = niceRange(ext[0], ext[1], count, d.yPin ?? [null, null]);
  while (count > 1 && r.ticks.length > 1 && px / (r.ticks.length - 1) < Y_MIN_GAP_PX) {
    count -= 1;
    r = niceRange(ext[0], ext[1], count, d.yPin ?? [null, null]);
  }
  // The readout is as fine as the ticks, and never coarser than the unit's resolution: a pressure in
  // bar reads 39.9, not 40, even on an axis ticked in whole bar.
  return { ...r, readoutDigits: d.digits ?? Math.max(r.digits, unitDigits(d.yUnit ?? '') ?? 0) };
}
