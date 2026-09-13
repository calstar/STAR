/**
 * How two fittings go together, and what that does to the length and the bore.
 *
 * The model this replaces had `engagementMm` on each fitting, subtracted from
 * its own body length. That is the wrong shape twice over. Engagement is not a
 * property of a fitting -- it is a property of the **joint**, and the same
 * elbow makes up differently depending on what it is screwed into. And how far
 * it goes in is not something anybody should be typing: for the families used
 * on a stand it is either fixed by a published standard or fixed by the
 * geometry of the seal.
 *
 * So a fitting has two **ends**, each with a family, a size and a gender, and
 * the joint between two ends is what carries a number.
 *
 * ## How each family makes up
 *
 * The families differ in kind, not just in value, and three of the four need
 * no table at all:
 *
 * - **ORB** (SAE straight thread O-ring boss) -- the male runs in until its
 *   shoulder bottoms on the boss face and the O-ring is trapped under it. It
 *   really does go all the way in: engagement *is* the male's thread length,
 *   with nothing left between the flats and the face. No lookup, and no slack
 *   for anybody to guess at.
 *
 * - **JIC 37 degree / AN** -- the nut's thread is not what sets the length. The
 *   two cones seat against each other, so the joint closes at the **cone
 *   seat**, a fixed feature of both halves. Engagement is measured to that
 *   seat; the threads are just what holds it there.
 *
 * - **NPT** -- tapered, and the only family where the answer is a number per
 *   size rather than a rule. The male wedges into the female and stops where
 *   the taper binds, which ASME B1.20.1 fixes as hand-tight engagement (L1)
 *   plus wrench makeup. That is what `NPT_L1_IN` holds, and it is the one
 *   table here that a person has to be able to check.
 *
 * - **Swage / compression** -- the tube bottoms on a shoulder inside the body
 *   and the ferrules grip it. The insertion depth is a manufacturer's number
 *   that varies by series, so it belongs in the catalogue with through-bore
 *   and body length, not here.
 *
 * ## Which bore counts
 *
 * A male fitting's through-bore is the hole the fluid goes down. The female it
 * screws into is, at the joint, a larger hole with threads cut in it -- so the
 * restriction at any threaded joint is the **male** side, every time. That is
 * why gender is not decoration: without it the drawing does not know which of
 * two numbers is the one the flow sees.
 *
 * ## What this file will not do
 *
 * Invent a number and call it a standard. See `NPT_L1_IN`.
 */

import { MM_PER_IN } from './catalog';

/** The termination families a stand is plumbed with. */
export type Family =
  | 'NPT' | 'JIC' | 'AN' | 'ORB' | 'swage' | 'tube' | 'weld'
  /**
   * Nobody has said yet.
   *
   * Distinct from `tube` and `weld`, which are answers that happen to overlap
   * by zero. This one refuses to produce a number, because a drawing that
   * quietly assumes zero overlap reads exactly like one where somebody checked
   * -- and the cut tube comes out long by the sum of every joint on the run.
   */
  | 'unset';

export type Gender = 'male' | 'female';

export const FAMILY_LABELS: Record<Family, string> = {
  NPT:   'NPT',
  JIC:   'JIC 37°',
  AN:    'AN',
  ORB:   'SAE ORB',
  swage: 'Swage / compression',
  tube:  'Bare tube',
  weld:  'Welded',
  unset: 'not stated',
};

/** One end of a fitting: what thread it is, what size, and which half. */
export interface Termination {
  family: Family;
  /** `1/2` for NPT, `-8` for a dash size, a tube label for bare tube. */
  size: string;
  gender: Gender;
}

/** How a family closes. The distinction that makes most of this table-free. */
export type Makeup =
  /** Runs in until a shoulder bottoms out: engagement is the whole thread. */
  | 'bottoms_out'
  /** Closes on a mating cone: engagement is measured to the seat. */
  | 'cone_seat'
  /** Tapered; binds at a length the standard fixes per size. */
  | 'tapered'
  /** Tube bottoms inside the body; depth is a manufacturer's number. */
  | 'insertion'
  /** Nothing screws together. */
  | 'none'
  /** Not yet answered, so no number is owed. */
  | 'unstated';

/**
 * What the length a joint closes on is called, per family.
 *
 * An ORB does not have a seat -- it runs in until the shoulder lands on the
 * boss face -- so asking for "flats to the seat" on one is asking the wrong
 * question about the right number.
 */
export const THREAD_PROMPT: Partial<Record<Family, string>> = {
  ORB: 'of thread — an ORB runs all the way in, so that is the engagement',
  JIC: 'flats to the seat on the male half',
  AN:  'flats to the seat on the male half',
};

export const MAKEUP: Record<Family, { rule: Makeup; note: string }> = {
  ORB:   { rule: 'bottoms_out', note: 'shoulder bottoms on the boss face' },
  JIC:   { rule: 'cone_seat',   note: 'closes on the 37° cone' },
  AN:    { rule: 'cone_seat',   note: 'closes on the 37° cone' },
  NPT:   { rule: 'tapered',     note: 'binds on the taper' },
  swage: { rule: 'insertion',   note: 'tube bottoms inside the body' },
  tube:  { rule: 'none',        note: 'bare tube' },
  weld:  { rule: 'none',        note: 'welded' },
  unset: { rule: 'unstated',    note: 'say how these join' },
};

/**
 * Threads per inch, by NPT nominal size.
 *
 * These are not in doubt and they are not a transcription risk: 1/8 is 27,
 * 1/4 and 3/8 are 18, 1/2 and 3/4 are 14, 1 inch is 11 1/2. Kept because the
 * pitch is what turns "three turns past hand tight" into a length.
 */
export const NPT_TPI: Record<string, number> = {
  '1/8': 27, '1/4': 18, '3/8': 18, '1/2': 14, '3/4': 14, '1': 11.5,
};

/** NPT taper: 1 in 16 on the diameter, 3/4 inch per foot. */
export const NPT_TAPER = 1 / 16;

/**
 * Turns past hand tight, which is a workshop convention rather than a length.
 *
 * ASME B1.20.1 fixes hand-tight engagement; how far past it you go is shop
 * practice, and two to three turns is what is taught. Three is used here
 * because it is what a stand gets wrenched to, and it is a named constant so
 * it can be argued with rather than buried in a sum.
 */
export const NPT_WRENCH_TURNS = 3;

/**
 * Hand-tight engagement (L1) per NPT size, in inches.
 *
 * **These are recalled, not transcribed, and they say so.** L1 is fixed by
 * ASME B1.20.1 Table 8 -- a genuine standard, identical for every
 * manufacturer, which is exactly why it belongs in software rather than in
 * sixty drawings. But this repo does not contain a copy of the standard, and a
 * number remembered to three decimal places is a number somebody will
 * eventually cut a tube to.
 *
 * So they are seeded, because automatic and checkable beats absent, and every
 * one carries `verified: false` until somebody sets it against the table.
 * `engagementOf` passes the flag through to whatever uses the result, and the
 * checks panel counts them. Replacing this block with the real table is a
 * ten-minute job for anyone holding B1.20.1, and nothing else has to change.
 */
export const NPT_L1_IN: Record<string, { in: number; verified: boolean }> = {
  '1/8': { in: 0.180, verified: false },
  '1/4': { in: 0.200, verified: false },
  '3/8': { in: 0.240, verified: false },
  '1/2': { in: 0.320, verified: false },
  '3/4': { in: 0.339, verified: false },
  '1':   { in: 0.400, verified: false },
};

export const SOURCE_UNVERIFIED =
  'ASME B1.20.1 Table 8 — from memory, not yet checked against the standard';

/** Why two ends cannot be joined, or null if they can. */
export function whyNotMated(a: Termination, b: Termination): string | null {
  // An unanswered end is not a wrong one. Saying "not stated does not mate with
  // NPT" would put a red line on every fitting of a run whose only fault is
  // that nobody has picked the joint family yet -- and the engagement already
  // says so, once, in the place where it can be fixed.
  if (a.family === 'unset' || b.family === 'unset') return null;
  const threaded = (t: Termination) => MAKEUP[t.family].rule !== 'none';
  if (!threaded(a) && !threaded(b)) return null;   // tube to tube: welded or butted

  if (a.family !== b.family) {
    // Cone families interchange; nothing else does.
    const cone = (f: Family) => MAKEUP[f].rule === 'cone_seat';
    if (!(cone(a.family) && cone(b.family))) {
      return `${FAMILY_LABELS[a.family]} does not mate with ${FAMILY_LABELS[b.family]}`;
    }
  }
  if (threaded(a) && threaded(b) && a.gender === b.gender) {
    return `two ${a.gender} ends cannot be joined`;
  }
  if (a.size !== b.size) {
    return `${a.size} to ${b.size} needs an adapter`;
  }
  return null;
}

export interface Engagement {
  /** How much the pair overlaps, so the assembly is shorter by this much. */
  mm: number;
  /** Where the number came from, which decides how far to trust it. */
  basis: 'rule' | 'standard' | 'catalogue';
  reference: string;
  /** False when the figure is seeded from memory. See `NPT_L1_IN`. */
  verified: boolean;
}

/** A number this file cannot supply, and what would supply it. */
export interface MissingEngagement {
  needs: string;
}

export const isMissing = (e: Engagement | MissingEngagement): e is MissingEngagement =>
  'needs' in e;

/**
 * How far two ends go into each other.
 *
 * `maleThreadMm` is the male's thread length, which the bottoming and cone
 * families need and the tapered one does not; a caller without it is told what
 * is missing rather than handed a guess.
 */
export function engagementOf(
  a: Termination,
  b: Termination,
  opts: { maleThreadMm?: number; insertionMm?: number } = {},
): Engagement | MissingEngagement {
  const male = a.gender === 'male' ? a : b;
  const rule = MAKEUP[male.family].rule;

  // Nothing below can be answered for a joint whose size is blank, and each
  // branch would otherwise ask its own question with a hole in it.
  if (rule !== 'none' && rule !== 'unstated' && !male.size) {
    return { needs: 'the thread size these join at' };
  }

  switch (rule) {
    case 'bottoms_out':
      // Really does go all the way in. Nothing to look up.
      return opts.maleThreadMm === undefined
        ? { needs: 'the male thread length — an ORB joint closes on its shoulder, so that length *is* the engagement' }
        : {
            mm: opts.maleThreadMm,
            basis: 'rule',
            reference: 'SAE ORB bottoms on the boss face: engagement = male thread length',
            verified: true,
          };

    case 'cone_seat':
      // The threads hold it; the cone decides where it stops.
      return opts.maleThreadMm === undefined
        ? { needs: 'the distance from the flats to the cone seat' }
        : {
            mm: opts.maleThreadMm,
            basis: 'rule',
            reference: `${FAMILY_LABELS[male.family]} closes on the cone: engagement = flats to seat`,
            verified: true,
          };

    case 'tapered': {
      // No size at all and an unlisted size are different questions. Asking
      // for "hand-tight engagement for NPT " when nobody has picked a size
      // sends the reader to the standard for something the drawing is simply
      // missing.
      if (!male.size) return { needs: 'the thread size these join at' };
      const l1 = NPT_L1_IN[male.size];
      if (!l1) return { needs: `hand-tight engagement for NPT ${male.size} (ASME B1.20.1 Table 8)` };
      const tpi = NPT_TPI[male.size];
      if (!tpi) return { needs: `threads per inch for NPT ${male.size}` };
      const inches = l1.in + NPT_WRENCH_TURNS / tpi;
      return {
        mm: Math.round(inches * MM_PER_IN * 1000) / 1000,
        basis: 'standard',
        reference:
          `NPT ${male.size}: L1 ${l1.in}in + ${NPT_WRENCH_TURNS} turns at ${tpi} TPI`
          + (l1.verified ? '' : ` — ${SOURCE_UNVERIFIED}`),
        verified: l1.verified,
      };
    }

    case 'insertion':
      return opts.insertionMm === undefined
        ? { needs: "the tube insertion depth for this series — a manufacturer's number, so it belongs in the catalogue" }
        : {
            mm: opts.insertionMm,
            basis: 'catalogue',
            reference: 'tube bottoms inside the body: insertion depth',
            verified: true,
          };

    case 'none':
      return { mm: 0, basis: 'rule', reference: 'nothing screws together', verified: true };

    case 'unstated':
      return { needs: 'how the fittings on this run join — set it once on the run' };
  }
}

/**
 * Which end's bore the fluid actually sees at a joint.
 *
 * Always the male. The female is, at the joint, a bigger hole with threads cut
 * into it -- so a run whose bores were taken off the female halves would be
 * reporting a restriction that is not there. This is the whole reason gender
 * is part of a termination rather than a note in the margin.
 */
export function restrictingEnd(a: Termination, b: Termination): Termination {
  if (a.gender === 'male' && b.gender !== 'male') return a;
  if (b.gender === 'male' && a.gender !== 'male') return b;
  return a;      // tube-to-tube, or a pairing `whyNotMated` has already refused
}
