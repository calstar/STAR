import type { ParamValue } from './params';
import {
  engagementOf, isMissing, restrictingEnd, whyNotMated, MAKEUP,
} from './terminations';
import type { Engagement, Family, MissingEngagement, Termination } from './terminations';

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
  /**
   * How the fittings on this run join, asked once for the whole run.
   *
   * This is the thing that makes engagement automatic. A run is built to one
   * joint standard -- a JIC stand is JIC throughout, an NPT one is NPT -- so
   * the overlap at every joint follows from a single answer, and nobody types
   * a number per fitting. A fitting that really is an adapter overrides it on
   * its own `ends`.
   *
   * Four of the five line standards *are* joint families, so for those this is
   * already answered by `standard` and never has to be set. It exists for the
   * one that is not: `tube` says what the tube is and nothing about how the
   * fittings grip it, which could be swage, flare or weld.
   */
  joinBy?: Family;
  /**
   * The thread size the fittings join at, when it is not the tube's own size.
   *
   * These are different facts and the drawing has to keep them apart: a run of
   * 1/2 x 0.049 tube ending in 1/4 NPT is an ordinary thing to build, and
   * `1/2 x 0.049` is not an NPT size at all. Where the line standard *is* the
   * joint family the two coincide and this stays empty -- an NPT line's size
   * is already the nominal.
   */
  joinSize?: string;
  /**
   * The male thread length these joints close on, in mm, where the family
   * needs one: the ORB shoulder and the JIC/AN cone both stop at a length
   * rather than at a figure out of a table.
   *
   * On the run for the same reason as the family and the size -- a run built
   * of one size of one fitting series has one such length, and asking per
   * fitting would be the same number typed over and over. A fitting that
   * differs carries its own `threadMm`.
   */
  joinThreadMm?: number;
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
  /**
   * The male thread length, where the way the joint closes needs it.
   *
   * An ORB male runs in until its shoulder bottoms, and a JIC male stops on
   * the cone -- in both the engagement *is* this length, so one number covers
   * the joint and nobody works out an overlap. NPT does not need it: the
   * standard fixes that per size. See `terminations.ts`.
   */
  threadMm?: number;
  /**
   * What each end of this fitting is. Absent means "the same thread and size
   * as the run, male into female", which is what a plain elbow in a plain run
   * is -- so only an adapter ever has to say.
   */
  ends?: { a: Termination; b: Termination };
  /** Superseded by `ends` and the makeup rules. Kept so older drawings open. */
  engagementMm?: number;
  /** A measured or published K for this fitting. Beats the correlation. */
  K?: number;
  partId?: string;
  partNumber?: string;
}

/**
 * An id no existing member of `taken` is using.
 *
 * Derived from what is there rather than from a module counter, because a
 * counter has to be seeded when a saved drawing is opened and nothing was
 * seeding it: a line loaded with `fit_1` and `fit_2` on it got `fit_1` again
 * for the next fitting added. Rows are matched by id, so the duplicate meant
 * editing one edited both and deleting one deleted both -- with the only
 * visible symptom a React duplicate-key warning in the console.
 *
 * There is no counter to forget now. The id is a fact about the collection.
 */
function freshId(prefix: string, taken: { id: string }[]): string {
  let n = taken.length + 1;
  const used = new Set(taken.map(t => t.id));
  while (used.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

export const nextSegmentId = (segments: LineSegment[] = []) =>
  freshId('seg', segments);

export const fittingCount = (s: LineSegment): number =>
  (s.fittings ?? []).reduce((n, r) => n + (r.count || 0), 0);

export const nextRowId = (rows: FittingRow[] = []) => freshId('fit', rows);

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

/**
 * What a fitting's ends are, when the drawing has not said.
 *
 * A plain elbow in a plain run is the same thread and size as the run, one end
 * male and the other female, so that a chain of them mates. Saying that per
 * fitting would be sixty entries of the obvious; only an adapter differs, and
 * only an adapter has to say.
 */
/** The families a line standard names outright, so the run implies the joint. */
const STANDARD_IS_FAMILY: Record<string, Family> = {
  NPT: 'NPT', JIC: 'JIC', AN: 'AN', ORB: 'ORB',
};

/**
 * What this run's fittings join by, when the fitting does not say.
 *
 * Ordered by how much each source actually knows: the run's own answer first,
 * then the line standard where the standard is itself a joint family. A `tube`
 * standard falls through to undefined on purpose -- it does not imply a joint,
 * and guessing one here is how a drawing ends up asserting an overlap nobody
 * chose.
 */
export function joinFamilyOf(segment: LineSegment): Family | undefined {
  return segment.joinBy ?? STANDARD_IS_FAMILY[segment.standard ?? ''];
}

/**
 * Families that grip the tube itself, so their size *is* the tube's size.
 *
 * A 1/2 inch swage fitting takes 1/2 inch tube -- there is no second size to
 * ask for. A thread is the other case: 1/2 inch tube into a 1/4 NPT port is an
 * ordinary thing to build, so the thread size is its own fact.
 */
const SIZED_BY_TUBE: Partial<Record<Family, true>> = {
  swage: true, tube: true, weld: true,
};

/**
 * The size the joints are made at.
 *
 * The run's own answer first, then the tube size -- which is right in two
 * cases: the line standard is itself the joint family (an NPT line's size is
 * already the nominal), or the family grips the tube and has no separate size.
 */
export function joinSizeOf(segment: LineSegment): string {
  if (segment.joinSize) return segment.joinSize;
  const family = joinFamilyOf(segment);
  if (family && SIZED_BY_TUBE[family]) return segment.tubeSize ?? '';
  return STANDARD_IS_FAMILY[segment.standard ?? ''] ? (segment.tubeSize ?? '') : '';
}

/** Does this family's size have to be asked for separately from the tube's? */
export function needsOwnSize(family: Family): boolean {
  return !SIZED_BY_TUBE[family] && MAKEUP[family].rule !== 'unstated';
}

/**
 * The two ends of a fitting.
 *
 * Male into female, alternating, so consecutive fittings mate: that is a run
 * that can actually be built, and it is what the engagement is computed from.
 * Untouched, a fitting is the run's joint family at the run's size -- which is
 * what a plain elbow in a plain run is.
 */
export function endsOf(row: FittingRow, segment: LineSegment): { a: Termination; b: Termination } {
  if (row.ends) return row.ends;
  // `unset`, not `tube`: an unanswered run owes a number it has not been
  // given, and the one thing it must not do is hand back zero.
  const family = joinFamilyOf(segment) ?? 'unset';
  const size = joinSizeOf(segment);
  return {
    a: { family, size, gender: 'male' },
    b: { family, size, gender: 'female' },
  };
}

/** One place two things screw together, along a run. */
export interface Joint {
  /** Which fitting this joint is on the inlet side of. */
  rowId: string;
  a: Termination;
  b: Termination;
  engagement: Engagement | MissingEngagement;
  /** Set when the two ends cannot physically be joined. */
  mismatch: string | null;
  /** The end whose bore the flow actually sees. */
  restricting: Termination;
}

/**
 * The joints along a run, in order, with how far each goes together.
 *
 * Between each fitting and the next: the outlet end of one against the inlet
 * end of the next. What this replaces was an `engagementMm` typed onto each
 * fitting and subtracted from its own body -- which cannot be right, because
 * the same elbow makes up differently depending on what it is screwed into.
 */
/**
 * How deep a catalogued part's mate inserts, by part id.
 *
 * A swage insertion depth is the manufacturer's number for that series, so it
 * comes from the catalogue entry rather than from this file or from the user.
 * Passed in rather than read here so the model stays testable and knows
 * nothing about where the catalogue lives.
 */
export type PartDepths = (partId: string) => number | undefined;

const NO_DEPTHS: PartDepths = () => undefined;

export function jointsOf(segment: LineSegment, depths: PartDepths = NO_DEPTHS): Joint[] {
  const flat = (segment.fittings ?? []).flatMap(r =>
    Array.from({ length: Math.max(0, r.count) }, () => r));
  const out: Joint[] = [];
  for (let i = 0; i < flat.length - 1; i++) {
    const left = endsOf(flat[i], segment);
    const right = endsOf(flat[i + 1], segment);
    const a = left.b;                       // the outlet end of the one before
    const b = right.a;                      // the inlet end of the next
    // The half that goes in is the half whose figures apply.
    const male = a.gender === 'male' ? flat[i] : flat[i + 1];
    out.push({
      rowId: flat[i + 1].id,
      a, b,
      engagement: engagementOf(a, b, {
        // The fitting's own figure if it has one, else the run's.
        maleThreadMm: male.threadMm ?? segment.joinThreadMm,
        // The catalogue's, for the one family whose depth is a part number.
        insertionMm: male.partId ? depths(male.partId) : undefined,
      }),
      mismatch: whyNotMated(a, b),
      restricting: restrictingEnd(a, b),
    });
  }
  return out;
}

/**
 * How much shorter the run is than the sum of its parts.
 *
 * The overlap at every joint, added up. Null when any joint cannot say --
 * because a cut list built on a partial subtraction is a mis-cut part rather
 * than an approximate one, which is the same rule `cutLength` already applied
 * to body lengths.
 */
/**
 * The joints on either side of one fitting row.
 *
 * A fitting's own two ends do not screw into each other; they screw into its
 * neighbours. So the joint worth showing beside an end is the one that end
 * forms with what is next to it, which is why this reads `jointsOf` rather
 * than mating a row against itself.
 *
 * A row with a count of three has identical joints between its own instances,
 * so the first of each side is the whole story.
 */
export function jointsForRow(
  segment: LineSegment, rowId: string, depths?: PartDepths,
): { inlet: Joint | null; outlet: Joint | null } {
  const joints = jointsOf(segment, depths);
  const flat = (segment.fittings ?? []).flatMap(r =>
    Array.from({ length: Math.max(0, r.count) }, () => r));
  // `jointsOf` indexes a joint by the row on its *right*, so the joint at
  // index i sits between flat[i] and flat[i + 1].
  const inlet = joints.find(j => j.rowId === rowId) ?? null;
  const lastHere = flat.reduce((acc, r, i) => (r.id === rowId ? i : acc), -1);
  const outlet = lastHere >= 0 && lastHere < joints.length ? joints[lastHere] : null;
  return { inlet, outlet };
}

export function overlapOf(
  segment: LineSegment, depths?: PartDepths,
): { mm: number; unverified: number } | null {
  let mm = 0;
  let unverified = 0;
  for (const j of jointsOf(segment, depths)) {
    // A joint that cannot be made has no overlap to report. `engagementOf`
    // will still answer for one -- it reads the male's size and does the
    // arithmetic -- so without this a 1/4 male in a 1/2 female came back as a
    // confident 13.57 mm on a joint the same panel was calling impossible.
    if (j.mismatch !== null) return null;
    if (isMissing(j.engagement)) return null;
    mm += j.engagement.mm;
    if (!j.engagement.verified) unverified++;
  }
  return { mm: Math.round(mm * 1000) / 1000, unverified };
}

/**
 * The distinct things wrong with this run's joints, each with a count.
 *
 * Distinct because three identical elbows produce the same complaint three
 * times, and a panel that prints it three times reads as three faults.
 */
export function jointFaultsOf(
  segment: LineSegment, depths?: PartDepths,
): { why: string; joints: number }[] {
  const seen = new Map<string, number>();
  for (const j of mismatchesOf(segment, depths)) {
    seen.set(j.mismatch!, (seen.get(j.mismatch!) ?? 0) + 1);
  }
  return [...seen].map(([why, joints]) => ({ why, joints }));
}

/** Joints the drawing describes but the hardware could not make. */
export const mismatchesOf = (segment: LineSegment, depths?: PartDepths): Joint[] =>
  jointsOf(segment, depths).filter(j => j.mismatch !== null);

/** Whether a family needs a thread length stating. See `terminations.ts`. */
export const needsThreadLength = (family: Family): boolean =>
  MAKEUP[family].rule === 'bottoms_out' || MAKEUP[family].rule === 'cone_seat';

/**
 * The straight tube to cut, from an end-to-end measurement.
 *
 * `overall − Σ(body lengths) + Σ(overlaps)`. The overlap term is the whole
 * point of this file: two fittings screwed together occupy less than the sum
 * of their lengths, and how much less is fixed by the standard or the seal
 * rather than by anybody's judgement.
 *
 * Refuses rather than approximates. A cut list is a part somebody makes.
 */
export function cutTubeOf(
  segment: LineSegment, overallMm: number, depths?: PartDepths,
): { mm: number; unverified: number } | { needs: string } {
  const flat = (segment.fittings ?? []).flatMap(r =>
    Array.from({ length: Math.max(0, r.count) }, () => r));
  let bodies = 0;
  for (const f of flat) {
    if (f.lengthMm === undefined) return { needs: 'a body length on every fitting' };
    bodies += f.lengthMm;
  }
  const overlap = overlapOf(segment, depths);
  if (!overlap) {
    // A joint that cannot be made is the first thing to say; an unanswered one
    // comes next. Either way no length is offered.
    const broken = mismatchesOf(segment, depths)[0];
    if (broken) return { needs: `a joint that can be made — ${broken.mismatch}` };
    const first = jointsOf(segment, depths).map(j => j.engagement).find(isMissing);
    return { needs: first ? first.needs : 'how the joints make up' };
  }
  return {
    mm: Math.round((overallMm - bodies + overlap.mm) * 1000) / 1000,
    unverified: overlap.unverified,
  };
}
