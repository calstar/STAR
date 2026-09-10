import type { ParamValue } from './params';

/**
 * What a line is actually made of.
 *
 * A line used to carry one lumped `K_minor` that somebody guessed, and fittings
 * are about half a line's resistance -- so that guess was the largest error in
 * an imported system. This is the shape that fixes it without making anybody
 * draw every elbow:
 *
 *   **Ordered segments. Unordered tally inside each.**
 *
 * Segments are ordered because their *bores* are: 1/4→3/8→1/2 and 1/2→1/4→3/8
 * are the same parts in a different order and differ by 2.1× in pressure drop.
 * Fittings *within* one bore are a bag with counts, because rearranging them
 * changes the answer by 0.003% -- so asking anyone to place them would be
 * tedium that buys nothing.
 *
 * Everything here is optional. A line with no segments behaves exactly as it
 * does today. **Absent means "not stated", never "zero"** -- feed-twin fills in
 * a default and its run report counts it as unchecked.
 */

/**
 * The fitting kinds feed-twin prices, exactly as registered in
 * `feedtwin/comps/correlations.py`. Not a vocabulary of our own: a name that
 * is not on this list has no correlation behind it, so it would silently
 * contribute nothing. If a union or a cross is needed, feed-twin registers it
 * first.
 */
export const FITTING_KINDS = [
  'elbow_90', 'elbow_45', 'bend',
  'tee_run', 'tee_branch',
  'contraction', 'expansion',
  'entrance_sharp', 'exit',
  'ball_valve_full', 'gate_valve_full', 'globe_valve', 'swing_check',
  'elbow_90_crane', 'elbow_45_crane',
] as const;

export type FittingKind = (typeof FITTING_KINDS)[number];

/** How each reads in the list. The name on the left is the contract. */
export const FITTING_LABELS: Record<FittingKind, string> = {
  elbow_90: 'Elbow 90°',
  elbow_45: 'Elbow 45°',
  bend: 'Bend',
  tee_run: 'Tee (run)',
  tee_branch: 'Tee (branch)',
  contraction: 'Contraction',
  expansion: 'Expansion',
  entrance_sharp: 'Entrance (sharp)',
  exit: 'Exit',
  ball_valve_full: 'Ball valve (full bore)',
  gate_valve_full: 'Gate valve (full bore)',
  globe_valve: 'Globe valve',
  swing_check: 'Swing check',
  elbow_90_crane: 'Elbow 90° (Crane f_T)',
  elbow_45_crane: 'Elbow 45° (Crane f_T)',
};

/**
 * How a segment's loss is known.
 *
 * The single most important thing in this file. A feed system gets built and
 * tested, and the way its resistance is *known* changes as that happens: you
 * start with an itemised guess, and once you have flowed it you have a number
 * that beats every correlation. Both have to be first-class, and which one is
 * in force must never be ambiguous.
 *
 * Ordered by authority. Higher wins, and only one applies:
 *
 *  1. `curve`     — Δp against ṁ from a cold flow. Supersedes everything, and
 *                   feed-twin refuses outside the measured range rather than
 *                   extrapolating.
 *  2. `measured_K`— one K fitted from a run. Same authority, less data.
 *  3. `itemised`  — tube size, length, fittings. feed-twin walks the K ladder.
 *  4. `lumped_K`  — one K somebody estimated.
 *  5. `unstated`  — nothing said; feed-twin defaults and reports it unchecked.
 *
 * This is also the answer to "do I have to itemise every elbow?" — no. Flow the
 * line and enter the number. The itemised path is for what has not been built
 * yet, which is most of a design.
 */
export type LossMethod = 'curve' | 'measured_K' | 'itemised' | 'lumped_K' | 'unstated';

export const LOSS_METHODS: { id: LossMethod; label: string; note: string }[] = [
  { id: 'itemised',   label: 'Fittings',      note: 'counted, priced by correlation' },
  { id: 'measured_K', label: 'Measured K',    note: 'fitted from a flow test' },
  { id: 'curve',      label: 'Δp vs ṁ curve', note: 'from a flow bench' },
  { id: 'lumped_K',   label: 'Estimated K',   note: 'one number, a guess' },
  { id: 'unstated',   label: 'Not stated',    note: 'feed-twin defaults it' },
];

/** A measured Δp against ṁ table. Mirrors `feedtwin.model.Curve`. */
export interface DpCurve {
  /** Mass flow, ascending. */
  mdot: number[];
  mdotUnit: string;
  /** Pressure drop at each flow. */
  dp: number[];
  dpUnit: string;
  reference?: string;
}

/** A fitting that needs more than a count — its own bore, or a measured K. */
export interface FittingInstance {
  kind: FittingKind;
  /** Overrides the segment bore for this fitting only. */
  bore?: ParamValue;
  /** For contraction / expansion: the other side. */
  bore2?: ParamValue;
  /** For a bend: r/D. */
  bend_diameters?: ParamValue;
  angle?: ParamValue;
  partNumber?: string;
  /** A measured or published K. Beats every correlation. */
  K?: ParamValue;
}

export interface LineSegment {
  id: string;
  /** How this segment's loss is known. Defaults to `itemised`. */
  method?: LossMethod;
  /** For `measured_K` / `lumped_K`. */
  K?: ParamValue;
  /** For `curve`. */
  curve?: DpCurve;
  /**
   * Whether `length` is the straight tube or the whole assembly.
   *
   * It matters because a fitting's K already contains its own friction, so the
   * friction term must use the *tube* length. Measuring a run end to end is
   * what people actually do, so both are accepted and the other is derived.
   */
  lengthBasis?: 'tube' | 'overall';
  /** The FLOW diameter, not the thread size. */
  bore?: ParamValue;
  /** Developed length along the centreline. */
  length?: ParamValue;
  roughness?: ParamValue;
  /** Signed; up is positive. */
  elevation_change?: ParamValue;
  /**
   * The fittings in this segment, in order.
   *
   * Ordered even though same-bore order is worth 0.003%, because a fitting can
   * carry its own bore and then the order *is* load-bearing -- and because a
   * list that matches the run as built is what somebody checks against the
   * hardware. Each row still carries a count: three identical elbows are one
   * row saying three, not three rows.
   */
  fittings?: FittingRow[];
  /** What the bore was derived from, when it came from a size. */
  tubeSize?: string;
  standard?: string;
}

/** One kind of fitting in a segment, and how many of it. */
export interface FittingRow {
  id: string;
  kind: FittingKind;
  count: number;
  /** Overrides the segment bore for these. */
  boreMm?: number;
  /** Centreline length, for the cut list. Never for the friction term. */
  lengthMm?: number;
  engagementMm?: number;
  /** A measured or published K for this fitting. Beats the correlation. */
  K?: number;
  partId?: string;
  partNumber?: string;
}

let _seg = 0;
export const nextSegmentId = () => `seg_${++_seg}`;

/** Advance past the ids already in a loaded diagram. */
export function seedSegmentIds(segments: LineSegment[] | undefined): void {
  for (const s of segments ?? []) {
    const m = /^seg_(\d+)$/.exec(s.id);
    if (m) _seg = Math.max(_seg, Number(m[1]));
  }
}

export const fittingCount = (s: LineSegment): number =>
  (s.fittings ?? []).reduce((n, r) => n + (r.count || 0), 0);

let _row = 0;
export const nextRowId = () => `fit_${++_row}`;

/** The method actually in force, with the default made explicit. */
export const methodOf = (s: LineSegment): LossMethod => s.method ?? 'itemised';

/**
 * Fittings whose K this drawing already knows, summed.
 *
 * Only the ones carrying their own measured K -- everything else is priced by
 * feed-twin, which has the Reynolds number and the correlation ladder. Shown so
 * the header total is honest about what it does and does not include.
 */
export const knownK = (s: LineSegment): number =>
  (s.fittings ?? []).reduce((n, r) => n + (r.K !== undefined ? r.K * r.count : 0), 0);

/**
 * A change of bore between two segments is a reducer or an expander.
 *
 * Derived, never typed: two adjacent segments with different bores *are* the
 * transition, so making somebody add a row for it is a step they can forget
 * and then be wrong about. Returned for display; feed-twin derives its own.
 */
export interface Transition {
  kind: 'contraction' | 'expansion';
  fromMm: number;
  toMm: number;
  /** Borda–Carnot for an expansion; Crane's sudden contraction otherwise. */
  K: number;
}

const MM: Record<string, number> = { mm: 1, m: 1000, cm: 10, in: 25.4, ft: 304.8 };
const toMm = (p?: ParamValue): number | null =>
  p && MM[p.unit] !== undefined ? p.value * MM[p.unit] : null;

export function transitionBetween(a: LineSegment, b: LineSegment): Transition | null {
  const from = toMm(a.bore);
  const to = toMm(b.bore);
  if (from === null || to === null || from <= 0 || to <= 0) return null;
  if (Math.abs(from - to) < 1e-9) return null;

  // Beta is always small-over-large, and K is referred to the smaller bore.
  const beta2 = to > from ? (from * from) / (to * to) : (to * to) / (from * from);
  if (to > from) {
    // Sudden expansion: Borda-Carnot, from momentum conservation alone.
    return { kind: 'expansion', fromMm: from, toMm: to, K: (1 - beta2) ** 2 };
  }
  // Sudden contraction, Crane's usual form.
  return { kind: 'contraction', fromMm: from, toMm: to, K: 0.5 * (1 - beta2) };
}

/** Every derived transition down a run, aligned to the gap after each segment. */
export function transitionsOf(segments: LineSegment[]): (Transition | null)[] {
  return segments.slice(0, -1).map((s, i) => transitionBetween(s, segments[i + 1]));
}
