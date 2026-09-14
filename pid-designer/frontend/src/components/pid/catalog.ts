/**
 * The parts library: what a fitting is, dimensionally.
 *
 * Three kinds of number live here and they are kept apart, because they have
 * very different claims to being right.
 *
 * **Arithmetic.** A dash size is 1/16 in of tube OD, and a tube's bore is
 * `OD − 2 × wall`. Nothing is looked up and nothing is remembered. `-8` is 1/2
 * in tube in every catalogue that has ever existed.
 *
 * **Catalogue.** Through-bore, body length and thread engagement are
 * manufacturer's numbers that vary by series. They are **not** seeded here. A
 * bore invented in this file would reach feed-twin wearing a `source` and a
 * `reference`, looking checked, and be wrong -- which is worse than absent,
 * because absent is visible. The team enters their own parts once, from the
 * catalogue on the desk, and every diagram uses them.
 *
 * **Derived.** Cut length, from an overall run length and the fittings in it.
 *
 * ## Where fitting length does and does not matter
 *
 * It does **not** go into the friction term. A fitting's K -- from Crane,
 * Hooper, or geometry -- already accounts for the fitting's own friction, so
 * adding its body length to the pipe length as well counts it twice. For a
 * 1.6 m run with three elbows that is a ~4% over-count of L.
 *
 * It matters for exactly one thing, and it is worth having: **the cut list.**
 * If somebody measured the run end to end, the straight tube is that length
 * minus what the fittings occupy, plus what they screw in by. Getting the
 * fabricator a cut length is the reason to know engagement -- not the pressure
 * drop.
 */

import type { FittingKind } from './segments';

export const MM_PER_IN = 25.4;

/** A dash size is sixteenths of an inch of tube OD. Standard, not catalogue. */
export const dashToTubeOdIn = (dash: number) => dash / 16;
export const dashToTubeOdMm = (dash: number) => dashToTubeOdIn(dash) * MM_PER_IN;

export type Standard = 'tube' | 'JIC' | 'ORB' | 'NPT' | 'AN';

export const STANDARDS: { id: Standard; label: string; sizing: 'dash' | 'nominal' | 'tube' }[] = [
  { id: 'tube', label: 'Tube (OD × wall)', sizing: 'tube' },
  { id: 'JIC',  label: 'JIC 37°',          sizing: 'dash' },
  { id: 'AN',   label: 'AN',               sizing: 'dash' },
  { id: 'ORB',  label: 'SAE ORB',          sizing: 'dash' },
  { id: 'NPT',  label: 'NPT',              sizing: 'nominal' },
];

/** Dash sizes we actually run. */
export const DASH_SIZES = [2, 3, 4, 5, 6, 8, 10, 12, 16] as const;
/** NPT nominal sizes, as written on the part. */
export const NPT_SIZES = ['1/8', '1/4', '3/8', '1/2', '3/4', '1'] as const;

/**
 * One catalogued part.
 *
 * `bore` is the only field feed-twin needs. `length` and `engagement` exist for
 * the cut list, and both are optional -- a part with only a bore is a perfectly
 * good entry.
 */
export interface CatalogPart {
  id: string;
  /** What it is, for the picker. */
  label: string;
  standard: Standard;
  /** Dash number, NPT nominal, or a tube label. */
  size: string;
  kind?: FittingKind;
  partNumber?: string;
  /** Through-bore, mm. The flow diameter — never the thread size. */
  boreMm?: number;
  /** Centreline length through the fitting body, mm. Cut list only. */
  lengthMm?: number;
  /** How far the mating part screws or inserts in, mm. Cut list only. */
  engagementMm?: number;
  /** Where these numbers came from. Required — that is the point of the file. */
  source: string;
}

const STORE_KEY = 'pid.catalog.v1';

/**
 * The team's parts, as entered.
 *
 * Held per browser for now, with import/export so a catalogue can be shared as
 * a file. Promoting it to a document on the userdata volume -- so it is shared
 * the way diagrams are -- is the obvious next step and is deliberately not done
 * here: it wants an endpoint and a picker, and this unblocks the work today.
 */
export function loadCatalog(): CatalogPart[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as CatalogPart[]) : [];
  } catch {
    return [];
  }
}

export function saveCatalog(parts: CatalogPart[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(parts));
  } catch {
    /* private mode: the catalogue is a convenience, not the drawing */
  }
}

let _part = 0;
export const nextPartId = () => `part_${Date.now().toString(36)}_${++_part}`;

/** Tube sizes, as ordered. The bore follows by arithmetic. */
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

export const tubeBoreMm = (odIn: number, wallIn: number) => (odIn - 2 * wallIn) * MM_PER_IN;

export const tubeByLabel = (label: string) => TUBE_SIZES.find(t => t.label === label);

export function boreForTube(label: string): number | null {
  const t = tubeByLabel(label);
  return t ? round3(tubeBoreMm(t.od, t.wall)) : null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface BoreSuggestion {
  mm: number;
  /** Goes into the parameter's `reference`. */
  reference: string;
  /** Arithmetic is trustworthy; a catalogue row is as good as its entry. */
  basis: 'arithmetic' | 'catalog';
}

/**
 * What bore to pre-fill, and why — or null when nothing here can honestly say.
 *
 * Null is a feature. It makes the dialog ask, which is the correct behaviour
 * when the alternative is a number nobody can cite.
 */
export function suggestBore(
  standard: Standard,
  size: string,
  catalog: CatalogPart[],
): BoreSuggestion | null {
  if (standard === 'tube') {
    const t = tubeByLabel(size);
    if (!t) return null;
    return {
      mm: round3(tubeBoreMm(t.od, t.wall)),
      reference: `${size} tube, OD − 2 × wall`,
      basis: 'arithmetic',
    };
  }
  const hit = catalog.find(p => p.standard === standard && p.size === size && p.boreMm !== undefined);
  return hit
    ? { mm: hit.boreMm!, reference: `${standard} ${size}, ${hit.source}`, basis: 'catalog' }
    : null;
}

/** The tube OD a size implies, for the "what does -8 mean" hint. */
export function tubeOdForSize(standard: Standard, size: string): number | null {
  if (standard === 'tube') return tubeByLabel(size)?.od ?? null;
  const dash = Number(size);
  return Number.isFinite(dash) && dash > 0 ? dashToTubeOdIn(dash) : null;
}

/**
 * Straight tube to cut, given an end-to-end measurement.
 *
 * `overall − Σ(body length − engagement)`. Returns null unless every fitting in
 * the run has a length, because a partial answer here is a mis-cut part.
 */
export function cutLength(
  overallMm: number,
  fittings: { lengthMm?: number; engagementMm?: number }[],
): number | null {
  let occupied = 0;
  for (const f of fittings) {
    if (f.lengthMm === undefined) return null;
    occupied += f.lengthMm - (f.engagementMm ?? 0);
  }
  return round3(overallMm - occupied);
}
