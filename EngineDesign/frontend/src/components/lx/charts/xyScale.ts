import { linearTicks, logTicks, timeTicks, xTickLabels } from './axis';
import { num } from './measure';
import { extent, niceRange } from './scale';
import type { HeatLayer, XYData } from './xyTypes';

/**
 * The scales of an x–y chart, pure so the rules are tested rather than eyeballed:
 *   - an axis a heat layer covers runs exactly over the layer's cells (no blank strip at an end);
 *   - otherwise it is rounded out to round ticks around everything drawn on it;
 *   - a time axis ticks like every other chart on the page (axis.ts timeTicks);
 *   - `equalAspect` widens the tighter axis about its middle until one unit is as long on both.
 */

export interface AxisScale {
  lo: number;
  hi: number;
  log: boolean;
  ticks: number[];
  labels: string[];
  /** Decimals of the tick labels (a log axis prints each tick's own). */
  digits: number;
}

/** Cell edges of a grid: half-way between points, the ends extended by half a step. */
export function cellEdges(v: readonly number[]): number[] {
  const n = v.length;
  if (n === 0) return [];
  if (n === 1) return [v[0] - 0.5, v[0] + 0.5];
  const e = [v[0] - (v[1] - v[0]) / 2];
  for (let i = 0; i + 1 < n; i++) e.push((v[i] + v[i + 1]) / 2);
  e.push(v[n - 1] + (v[n - 1] - v[n - 2]) / 2);
  return e;
}

/** The finite extent of a heat field, or null. */
export function heatExtent(h: HeatLayer): [number, number] | null {
  if (h.range) return [Math.min(h.range[0], h.range[1]), Math.max(h.range[0], h.range[1])];
  return extent(h.z);
}

function ticksFor(lo: number, hi: number, px: number, opts: { time: boolean; log: boolean; unit: string; minGap: number }): AxisScale {
  if (opts.log) {
    const t = logTicks(lo, hi, px);
    const labels = t.labels.map((l, k) => (k === t.labels.length - 1 && opts.unit ? `${l}\u00a0${opts.unit}` : l));
    return { lo, hi, log: true, ticks: t.ticks, labels, digits: 0 };
  }
  const t = opts.time ? timeTicks(lo, hi, px) : linearTicks(lo, hi, Math.max(2, Math.min(8, Math.floor(px / opts.minGap))));
  return { lo, hi, log: false, ticks: t.ticks, labels: xTickLabels(t.ticks, t.digits, opts.unit), digits: t.digits };
}

/** y tick labels carry no unit (it heads the column). */
function yLabels(s: AxisScale): AxisScale {
  return s.log ? s : { ...s, labels: s.ticks.map((v) => num(v, s.digits)) };
}

export function xyScales(d: XYData, plotW: number, plotH: number): { x: AxisScale; y: AxisScale } {
  const w = Math.max(plotW, 40);
  const h = Math.max(plotH, 40);
  const xUnitText = [d.xName, d.xUnit].filter(Boolean).join('\u00a0');
  const heat = d.heat && d.heat.x.length && d.heat.y.length ? d.heat : null;

  const along = (axis: 'x' | 'y') => {
    const vals: (number | null)[][] = d.series.map((s) => [...(axis === 'x' ? s.x : s.y)]);
    const extra: number[] = [];
    for (const m of d.marks ?? []) extra.push(axis === 'x' ? m.x : m.y);
    for (const r of d.regions ?? []) for (const p of r.points) extra.push(axis === 'x' ? p[0] : p[1]);
    for (const l of d.lines ?? []) if (l.axis === axis) extra.push(l.value);
    return { vals, extra };
  };

  const axisScale = (axis: 'x' | 'y', px: number): AxisScale => {
    const time = d.timeAxis === axis;
    const log = axis === 'x' && !!d.xLog;
    const unit = axis === 'x' ? xUnitText : '';
    const pin = (axis === 'x' ? d.xPin : d.yPin) ?? [null, null];
    if (heat) {
      const e = cellEdges(axis === 'x' ? heat.x : heat.y);
      const lo = pin[0] ?? e[0];
      const hi = pin[1] ?? e[e.length - 1];
      return ticksFor(Math.min(lo, hi), Math.max(lo, hi), px, { time, log, unit, minGap: axis === 'x' ? 72 : 36 });
    }
    const { vals, extra } = along(axis);
    let ext = extent(vals, extra) ?? [0, 1];
    if (log) {
      const pos = vals.flat().concat(extra).filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
      ext = pos.length ? [Math.min(...pos), Math.max(...pos)] : [1, 10];
      if (ext[1] <= ext[0]) ext = [ext[0] / 2, ext[0] * 2];
      return ticksFor(pin[0] ?? ext[0], pin[1] ?? ext[1], px, { time: false, log: true, unit, minGap: 72 });
    }
    if (time) {
      const lo = pin[0] ?? ext[0];
      const hi = pin[1] ?? ext[1];
      return ticksFor(lo, hi > lo ? hi : lo + 1, px, { time: true, log: false, unit, minGap: 72 });
    }
    const r = niceRange(ext[0], ext[1], Math.max(2, Math.min(8, Math.floor(px / (axis === 'x' ? 80 : 40)))), pin);
    const labels = xTickLabels(r.ticks, r.digits, unit);
    return { lo: r.lo, hi: r.hi, log: false, ticks: r.ticks, labels, digits: r.digits };
  };

  let x = axisScale('x', w);
  let y = yLabels(axisScale('y', h));

  if (d.equalAspect && !x.log) {
    // Units per pixel on each axis; the smaller one grows about its middle to match.
    const ux = (x.hi - x.lo) / w;
    const uy = (y.hi - y.lo) / h;
    if (ux > uy) {
      const mid = (y.lo + y.hi) / 2;
      const half = (ux * h) / 2;
      const t = linearTicks(mid - half, mid + half, Math.max(2, Math.min(8, Math.floor(h / 40))));
      y = { lo: mid - half, hi: mid + half, log: false, ticks: t.ticks, labels: t.ticks.map((v) => num(v, t.digits)), digits: t.digits };
    } else if (uy > ux) {
      const mid = (x.lo + x.hi) / 2;
      const half = (uy * w) / 2;
      const t = linearTicks(mid - half, mid + half, Math.max(2, Math.min(8, Math.floor(w / 80))));
      x = { lo: mid - half, hi: mid + half, log: false, ticks: t.ticks, labels: xTickLabels(t.ticks, t.digits, xUnitText), digits: t.digits };
    }
  }
  return { x, y };
}

/** A value's position along an axis drawn from `p0` to `p1` px (p1 < p0 for a y axis). */
export function toPx(s: AxisScale, v: number, p0: number, p1: number): number {
  if (s.log) {
    if (!(v > 0)) return Number.NaN;
    return p0 + ((Math.log10(v) - Math.log10(s.lo)) / (Math.log10(s.hi) - Math.log10(s.lo))) * (p1 - p0);
  }
  return p0 + ((v - s.lo) / (s.hi - s.lo || 1)) * (p1 - p0);
}

/** The inverse of toPx. */
export function fromPx(s: AxisScale, px: number, p0: number, p1: number): number {
  const f = (px - p0) / (p1 - p0 || 1);
  if (s.log) return 10 ** (Math.log10(s.lo) + f * (Math.log10(s.hi) - Math.log10(s.lo)));
  return s.lo + f * (s.hi - s.lo);
}

/** Contour levels: the given ones, or about `count` round values inside the field's extent. */
export function contourLevels(h: HeatLayer): number[] {
  const c = h.contours;
  if (!c) return [];
  if (Array.isArray(c)) return [...c];
  const ext = extent(h.z);
  if (!ext || ext[1] <= ext[0]) return [];
  const t = linearTicks(ext[0], ext[1], Math.max(2, (c as { count: number }).count));
  return t.ticks.filter((v) => v > ext[0] && v < ext[1]);
}
