import { RESOLUTION, type PressureKind, type QuantityKind, type Units } from '../units';
import type { ChartData } from './types';

/**
 * A chart given in the model's units (psia, N, kg, a fraction for a percent...) shown in the page's
 * unit system: the series, bands, limit lines and a pinned axis end converted, the y unit and the
 * readout's decimals taken from the quantity. A chart that says what it plots this way can never
 * be left in psi when the page switches to bar.
 */

export interface ChartQuantity {
  kind: QuantityKind;
  /** Pressure only: absolute (default) or gauge. */
  pressure?: PressureKind;
  /** Pressure only: the gauge zero [psia]; default the page's. */
  gaugeZeroPsia?: number;
}

export function toQuantity(q: ChartQuantity | QuantityKind): ChartQuantity {
  return typeof q === 'string' ? { kind: q } : q;
}

export function inUnits(data: ChartData, quantity: ChartQuantity | QuantityKind, units: Units): ChartData {
  const q = toQuantity(quantity);
  const s = units.scale(q.kind, { pressure: q.pressure, gaugeZeroPsia: q.gaugeZeroPsia });
  const to = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : s.to(v));
  const band = (b: { lo: number; hi: number; status: 'ok' | 'warn' | 'bad' }) => ({ ...b, lo: s.to(b.lo), hi: s.to(b.hi) });
  return {
    ...data,
    series: data.series.map((x) => ({ ...x, values: x.values.map(to) })),
    band: data.band ? band(data.band) : data.band,
    bands: data.bands?.map(band),
    limits: data.limits?.map((l) => ({ ...l, value: s.to(l.value) })),
    yPin: data.yPin ? [data.yPin[0] === null ? null : s.to(data.yPin[0]), data.yPin[1] === null ? null : s.to(data.yPin[1])] : data.yPin,
    yUnit: s.unit,
    digits: data.digits ?? s.digits,
  };
}

/**
 * The decimals a unit's quantity is resolved to (units.ts RESOLUTION), when the unit names one
 * quantity unambiguously: "bar(a)" 1, "psia" 0, "kg" 2, "lb/s" 3. Null for a unit two quantities
 * share at different resolutions ("psi" is a drop to 0.1 or a gap to 1; "s" is a time or an Isp).
 */
export function unitDigits(unit: string): number | null {
  if (!unit) return null;
  const found = new Set<number>();
  for (const table of Object.values(RESOLUTION)) {
    const d = (table as Record<string, number>)[unit];
    if (d !== undefined) found.add(d);
  }
  return found.size === 1 ? [...found][0] : null;
}
