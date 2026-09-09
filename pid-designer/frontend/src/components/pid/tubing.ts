/**
 * Where a bore comes from.
 *
 * **A 3/8″ NPT fitting does not have a 3/8″ bore.** Thread size is not flow
 * diameter, and using the thread size under-predicts loss by several times.
 * That is the mistake this file exists to stop, and it is why picking a size
 * pre-fills a bore rather than leaving somebody to type the number on the
 * label.
 *
 * Two different kinds of knowledge live here, and they are kept apart on
 * purpose:
 *
 * **Tube is arithmetic.** You order tube by OD and wall, and the bore is
 * `OD − 2 × wall`. Nothing is looked up and nothing is remembered: 1/2 × 0.035
 * is 0.430 in, and it is 0.430 in in every catalogue there has ever been.
 *
 * **Fitting standards are catalogue data.** The through-bore of a JIC 37° −8 or
 * an ORB #8 is a manufacturer's number that varies by series, and it is not
 * derivable from the size code. `THROUGH_BORE` is therefore declared and
 * deliberately **empty**: a number invented here would arrive in feed-twin
 * wearing a `source` and a reference, looking checked, and be wrong. Fill it in
 * from catalogues, one cited row at a time. Until a row exists the dialog asks
 * for the bore instead of guessing it.
 */

export const MM_PER_IN = 25.4;

/** Tube sizes we actually run, as ordered: OD × wall, in inches. */
export const TUBE_SIZES: { od: number; wall: number; label: string }[] = [
  { od: 0.25,  wall: 0.028, label: '1/4 × 0.028' },
  { od: 0.25,  wall: 0.035, label: '1/4 × 0.035' },
  { od: 0.375, wall: 0.035, label: '3/8 × 0.035' },
  { od: 0.375, wall: 0.049, label: '3/8 × 0.049' },
  { od: 0.5,   wall: 0.035, label: '1/2 × 0.035' },
  { od: 0.5,   wall: 0.049, label: '1/2 × 0.049' },
  { od: 0.5,   wall: 0.065, label: '1/2 × 0.065' },
  { od: 0.75,  wall: 0.049, label: '3/4 × 0.049' },
  { od: 0.75,  wall: 0.065, label: '3/4 × 0.065' },
  { od: 1.0,   wall: 0.065, label: '1 × 0.065' },
];

/** `OD − 2 × wall`, in millimetres. Arithmetic, not a lookup. */
export const tubeBoreMm = (odIn: number, wallIn: number): number =>
  (odIn - 2 * wallIn) * MM_PER_IN;

export function tubeByLabel(label: string) {
  return TUBE_SIZES.find(t => t.label === label);
}

/** The bore a tube size implies, to a sane number of figures. */
export function boreForTube(label: string): number | null {
  const t = tubeByLabel(label);
  return t ? Math.round(tubeBoreMm(t.od, t.wall) * 1000) / 1000 : null;
}

export type Standard = 'NPT' | 'JIC' | 'ORB' | 'AN';

/**
 * Fitting standard → size code → through-bore, with the catalogue it came
 * from. **Every row must cite a source.** Empty until somebody does that work;
 * see the note at the top of this file for why it is not seeded from memory.
 */
export const THROUGH_BORE: Record<Standard, Record<string, { mm: number; source: string }>> = {
  NPT: {},
  JIC: {},
  ORB: {},
  AN: {},
};

export interface BoreSuggestion {
  mm: number;
  /** Goes into the parameter's `reference`, so a run report can trace it. */
  reference: string;
}

/**
 * What bore to pre-fill for a size, or null if nothing here can say.
 *
 * Returned with the reasoning attached rather than as a bare number, so the
 * value stored carries where it came from. Stored as `source: 'default'` by the
 * caller: derived, not measured, and feed-twin's report should keep saying so
 * until somebody puts a caliper on the part.
 */
export function suggestBore(kind: 'tube', size: string): BoreSuggestion | null;
export function suggestBore(kind: Standard, size: string): BoreSuggestion | null;
export function suggestBore(kind: 'tube' | Standard, size: string): BoreSuggestion | null {
  if (kind === 'tube') {
    const t = tubeByLabel(size);
    if (!t) return null;
    return {
      mm: Math.round(tubeBoreMm(t.od, t.wall) * 1000) / 1000,
      reference: `${size} tube, OD − 2 × wall`,
    };
  }
  const row = THROUGH_BORE[kind]?.[size];
  return row ? { mm: row.mm, reference: `${kind} ${size}, ${row.source}` } : null;
}
