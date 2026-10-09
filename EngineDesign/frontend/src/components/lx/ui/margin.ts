import { fmt } from '../../layerx/format';
import { statusRank, type Status } from './status';

/**
 * One graded limit, mapped onto a 0..1 track for MarginBar (docs/layerx/GUI-SPEC.md, MarginBar).
 *
 * All numbers are in the units the bar displays (convert with lx/units first).
 *
 *   higher-is-safer   value < limit is bad, limit..warn is amber, above warn is ok   (chug margin,
 *                     bottle over lockup, injector ΔP/Pc's floor)
 *   lower-is-safer    value > limit is bad, warn..limit is amber, below warn is ok   (tank peak vs
 *                     MAWP, tank pressure sag)
 *
 * `far` is the other edge of a two-sided band: ΔP/Pc is graded bad under 20 % and amber over 40 %,
 * so it is { limit: 20, direction: 'higher-is-safer', far: { warn: 40 } }. A value exactly on an
 * edge takes the safer grade, as the old verdicts did (a chug margin of exactly 1 is amber).
 */
export type Direction = 'higher-is-safer' | 'lower-is-safer';

export interface LimitSpec {
  /** The red line. */
  limit: number;
  /** The amber edge, on the safe side of the limit. Omit for no amber band. */
  warn?: number;
  direction: Direction;
  /** The track's extent [lo, hi]. Default: from 0 (or the lowest edge) to a round number past the
   * highest edge or value. */
  span?: [number, number];
  /** The opposite edge of a two-sided band. */
  far?: { warn?: number; limit?: number };
}

export interface Zone { from: number; to: number; status: Status }
export type TickKind = 'limit' | 'warn' | 'far-warn' | 'far-limit';
export interface Tick { pos: number; value: number; kind: TickKind; label: boolean; text: string }

export interface MarginScale {
  direction: Direction;
  span: [number, number];
  /** Where the value sits on the track, 0..1; null when there is no value. */
  pos: number | null;
  /** The value lies off the track: the marker sits at that end. */
  clamped: 'below' | 'above' | null;
  /** The track coloured by grade, left to right, covering 0..1 with no gaps. */
  zones: Zone[];
  /** Each edge on the track. `label` is false where a label would collide with a stronger one. */
  ticks: Tick[];
  /** Decimals the tick labels need to print every edge exactly and alike ("1.0", "1.2"). */
  tickDigits: number;
  /** The grade, from the spec alone. No value grades amber: unknown is not fine. */
  status: Status;
  /**
   * A two-sided limit's safe band [lo, hi] (ΔP/Pc's 20–40 %), between its two nearest edges; null
   * for a one-sided limit. The bar states its direction as "safe between", not "higher is safer".
   */
  band: [number, number] | null;
  /**
   * Distance to the nearest grade edge, in warn-band widths: 0 at the red line, 1 at the amber
   * edge, above 1 clear of both, below 0 past the limit. For sorting worst-first; NaN with no value.
   */
  margin: number;
}

/** A tick label's character advance: 11 px JetBrains Mono is 0.6 em. */
const CHAR_PX = 6.6;
/** Breathing room between two labels, px. */
const LABEL_PAD_PX = 4;

/** What an edge's label gives way to: the red line wins. */
const TICK_PRIORITY: Record<TickKind, number> = { limit: 0, 'far-limit': 1, warn: 2, 'far-warn': 3 };

export function gradeLimit(spec: LimitSpec, v: number): Status {
  if (!Number.isFinite(v)) return 'warn';
  const up = spec.direction === 'higher-is-safer';
  // Near side: the limit and its amber band.
  const beyond = (edge: number | undefined, safeIsAbove: boolean) =>
    edge !== undefined && (safeIsAbove ? v < edge : v > edge);
  let s: Status = 'ok';
  if (beyond(spec.limit, up)) return 'bad';
  if (beyond(spec.warn, up)) s = 'warn';
  // Far side: the same, mirrored.
  if (beyond(spec.far?.limit, !up)) return 'bad';
  if (beyond(spec.far?.warn, !up)) s = 'warn';
  return s;
}

/** A round number at or above x: 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ. */
export function niceCeil(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  if (x < 0) return -niceFloor(-x);
  const mag = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const c = Number((m * mag).toPrecision(12));
    if (c >= x * (1 - 1e-12)) return c;
  }
  return 10 * mag;
}

function niceFloor(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  if (x < 0) return -niceCeil(-x);
  const mag = 10 ** Math.floor(Math.log10(x));
  let best = mag;
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const c = Number((m * mag).toPrecision(12));
    if (c <= x * (1 + 1e-12)) best = c;
  }
  return best;
}

function autoSpan(spec: LimitSpec, v: number): [number, number] {
  const pts = [spec.limit, spec.warn, spec.far?.warn, spec.far?.limit, Number.isFinite(v) ? v : undefined]
    .filter((x): x is number => x !== undefined && Number.isFinite(x));
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  // Zero is the natural floor of a margin, a pressure or a ratio; a span that goes negative pads.
  const lo = min >= 0 ? 0 : niceFloor(min - 0.2 * (max - min || Math.abs(min)));
  const hi = max <= 0 ? 0 : niceCeil(max + 0.2 * (max - lo || Math.abs(max)));
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/**
 * Decimals that print an edge to within `tol` (1 → 0, 1.2 → 1, 0.25 → 2), at most 3. An edge that
 * came through a unit conversion (0.33 kg is 0.3307...) prints as the round number it was meant
 * to be, not to the noise in its last digits.
 */
function decimalsOf(x: number, tol = 1e-6): number {
  for (let k = 0; k <= 3; k++) if (Math.abs(Math.round(x * 10 ** k) / 10 ** k - x) <= tol) return k;
  return 3;
}

/**
 * `trackPx` is the track's drawn width, for deciding which edge labels fit side by side; the
 * default suits a bar in a half-width panel.
 */
export function marginScale(spec: LimitSpec, value: number | null | undefined, { trackPx = 240 }: { trackPx?: number } = {}): MarginScale {
  const v = value === null || value === undefined ? NaN : value;
  const up = spec.direction === 'higher-is-safer';
  const span = spec.span ?? autoSpan(spec, v);
  const [lo, hi] = span;
  const at = (x: number) => (x - lo) / (hi - lo);
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

  let pos: number | null = null;
  let clamped: MarginScale['clamped'] = null;
  if (Number.isFinite(v)) {
    const p = at(v);
    clamped = p < 0 ? 'below' : p > 1 ? 'above' : null;
    pos = clamp01(p);
  }

  // Zones: cut the track at every edge and grade each piece at its middle, so the colours can
  // never disagree with the grade.
  const edges: { value: number; kind: TickKind }[] = [
    { value: spec.limit, kind: 'limit' as const },
    ...(spec.warn !== undefined ? [{ value: spec.warn, kind: 'warn' as const }] : []),
    ...(spec.far?.warn !== undefined ? [{ value: spec.far.warn, kind: 'far-warn' as const }] : []),
    ...(spec.far?.limit !== undefined ? [{ value: spec.far.limit, kind: 'far-limit' as const }] : []),
  ].filter((e) => Number.isFinite(e.value));
  const cuts = [...new Set([0, 1, ...edges.map((e) => clamp01(at(e.value)))])].sort((a, b) => a - b);
  const zones: Zone[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [from, to] = [cuts[i], cuts[i + 1]];
    if (to - from < 1e-9) continue;
    const status = gradeLimit(spec, lo + ((from + to) / 2) * (hi - lo));
    const last = zones[zones.length - 1];
    if (last && last.status === status) last.to = to;
    else zones.push({ from, to, status });
  }

  // Ticks: every edge on the track, labelled alike ("1.0", "1.2"); labels thinned where two would
  // overlap at `trackPx`, the red line's kept first.
  // Exact to 0.2 % of the track: finer than a label can be read at, coarser than conversion noise.
  const tickDigits = Math.max(0, ...edges.map((e) => decimalsOf(e.value, Math.max(1e-6, 0.002 * (hi - lo)))));
  const onTrack: Tick[] = edges
    .map((e) => ({ pos: at(e.value), value: e.value, kind: e.kind, label: false, text: fmt(e.value, tickDigits) }))
    .filter((t) => t.pos >= -1e-9 && t.pos <= 1 + 1e-9);
  const ticks = thinLabels(onTrack.sort((a, b) => a.pos - b.pos), trackPx);

  // Normalised margin: distance to the nearest edge, in warn-band widths. Without an amber band,
  // a tenth of the track stands in for one.
  const norm = 0.1 * (hi - lo);
  const side = (x: number, bad: number, okEdge: number) => (x - bad) / (okEdge - bad);
  let margin = NaN;
  if (Number.isFinite(v)) {
    const nearOk = spec.warn ?? (up ? spec.limit + norm : spec.limit - norm);
    margin = nearOk === spec.limit ? (up ? v - spec.limit : spec.limit - v) / norm : side(v, spec.limit, nearOk);
    const far = spec.far;
    if (far && (far.limit !== undefined || far.warn !== undefined)) {
      // The far edge is on the other side: above for higher-is-safer, below for lower.
      const sgn = up ? -1 : 1;
      const bad = far.limit ?? (far.warn as number) - sgn * norm;
      const okEdge = far.warn ?? bad + sgn * norm;
      margin = Math.min(margin, okEdge === bad ? sgn * (v - bad) / norm : side(v, bad, okEdge));
    }
  }

  // The safe band of a two-sided limit: from the near side's ok edge to the far side's.
  let band: [number, number] | null = null;
  const farEdge = spec.far?.warn ?? spec.far?.limit;
  if (farEdge !== undefined && Number.isFinite(farEdge)) {
    const near = spec.warn ?? spec.limit;
    band = [Math.min(near, farEdge), Math.max(near, farEdge)];
  }

  return { direction: spec.direction, span, pos, clamped, zones, ticks, tickDigits, status: gradeLimit(spec, v), margin, band };
}

/**
 * Which edge labels to draw at a track `trackPx` wide: two labels that would overlap do not both
 * show, and the red line's is kept first. MarginBar calls this again with its measured width.
 */
export function thinLabels(ticks: Tick[], trackPx: number): Tick[] {
  const out = ticks.map((t) => ({ ...t, label: false }));
  const kept: Tick[] = [];
  const clear = (a: Tick, b: Tick) =>
    Math.abs(a.pos - b.pos) * trackPx >= ((a.text.length + b.text.length) / 2) * CHAR_PX + LABEL_PAD_PX;
  for (const t of [...out].sort((a, b) => TICK_PRIORITY[a.kind] - TICK_PRIORITY[b.kind])) {
    if (kept.every((k) => clear(k, t))) { t.label = true; kept.push(t); }
  }
  return out;
}

/** Worst first: by grade, then by normalised margin; an ungraded (NaN) margin last in its grade. */
export function compareMargins(a: Pick<MarginScale, 'status' | 'margin'>, b: Pick<MarginScale, 'status' | 'margin'>): number {
  const r = statusRank(a.status) - statusRank(b.status);
  if (r) return r;
  const [x, y] = [a.margin, b.margin];
  if (Number.isNaN(x) || Number.isNaN(y)) return Number(Number.isNaN(x)) - Number(Number.isNaN(y));
  return x - y;
}

const DIRECTION_WORDS = { 'higher-is-safer': 'Higher is safer', 'lower-is-safer': 'Lower is safer' } as const;

/** The direction in words: one-sided "Higher is safer", two-sided "Safe between 20 and 40". */
export function directionWords(scale: Pick<MarginScale, 'direction' | 'band' | 'tickDigits'>): string {
  if (scale.band) return `Safe between ${fmt(scale.band[0], scale.tickDigits)} and ${fmt(scale.band[1], scale.tickDigits)}`;
  return DIRECTION_WORDS[scale.direction];
}


/** Worst first, by the grade a bar shows and then its normalised margin; stable for ties. */
export function sortWorstFirst<T extends { status: Status; scale: Pick<MarginScale, 'margin'> }>(items: readonly T[]): T[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => compareMargins({ status: a.it.status, margin: a.it.scale.margin }, { status: b.it.status, margin: b.it.scale.margin }) || a.i - b.i)
    .map((x) => x.it);
}
