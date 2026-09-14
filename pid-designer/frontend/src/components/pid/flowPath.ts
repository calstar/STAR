import { FITTING_LABELS, methodOf } from './segments';
import type { FittingRow, LineSegment } from './segments';

/**
 * The flow path as a picture: the inner wall, plotted about the centreline.
 *
 * A tally of fittings is a claim about a piece of hardware, and until you can
 * see it there is no way to tell whether the program read it the way you meant.
 * This turns the tally back into a shape: where the bore steps, which way a
 * reducer goes, how much tube an engagement swallows, where the run turns.
 *
 * A flow path is axisymmetric, so half of it carries all the information --
 * one radius against distance along the centreline. The exception is a bend,
 * where what matters is not the section but that the path *turns*, so the
 * centreline turns and the wall follows it round.
 *
 * Nothing here feeds a calculation. It exists to be looked at, and it is
 * deliberately built from the same fields feed-twin reads so that what you see
 * is what will be solved -- if the picture is wrong, the model is wrong.
 */

/** Drawing conventions, not physics. The K comes from the correlation. */
const DEFAULT_BEND_RD = 1.5;
/** A fitting with no stated body length still has to occupy something. */
const ASSUMED_BODY_D = 2.5;
/** How long a bore change is drawn as taking. */
const TRANSITION_D = 0.6;

/** Which kinds turn the centreline, and by how much. */
const TURN: Partial<Record<string, number>> = {
  elbow_90: 90,
  elbow_45: 45,
  elbow_90_crane: 90,
  elbow_45_crane: 45,
  bend: 90,
};

export interface Element {
  id: string;
  kind: 'tube' | 'fitting' | 'transition';
  label: string;
  /** Along the centreline, mm. */
  length: number;
  /** Inner radius at each end, mm. Unequal makes a taper. */
  rStart: number;
  rEnd: number;
  /** Degrees the centreline turns through this element. */
  turn?: number;
  /** How far the neighbouring tube is swallowed, mm. Drawn, not subtracted. */
  engagement?: number;
  /** True when a length or bore was assumed rather than stated. */
  assumed?: boolean;
}

const MM: Record<string, number> = { mm: 1, m: 1000, cm: 10, in: 25.4, ft: 304.8 };
const toMm = (p?: { value: number; unit: string }): number | null =>
  p && MM[p.unit] !== undefined ? p.value * MM[p.unit] : null;

/**
 * Flatten segments and their fittings into what the picture is made of.
 *
 * A segment becomes a run of tube with its fittings in order along it. Fittings
 * are drawn where the tally puts them, which is the point: a list that reads
 * left to right is what somebody checks against the hardware.
 */
export function buildElements(segments: LineSegment[]): Element[] {
  const out: Element[] = [];

  segments.forEach((seg, si) => {
    const segBore = toMm(seg.bore);
    const r = segBore !== null ? segBore / 2 : null;
    const rows = methodOf(seg) === 'itemised' ? seg.fittings ?? [] : [];

    // Fittings, expanded by count so three elbows are three turns.
    const fittings: FittingRow[] = rows.flatMap(row =>
      Array.from({ length: Math.max(0, row.count) }, () => row));

    const totalMm = toMm(seg.length);
    const occupied = fittings.reduce(
      (n, f) => n + (f.lengthMm ?? (r ? r * 2 * ASSUMED_BODY_D : 0)), 0);

    // Tube between the fittings. When the length is stated as the whole
    // assembly, what is left after the fittings is the tube; when it is the
    // tube itself, that is what it is.
    const tubeTotal = totalMm === null
      ? null
      : seg.lengthBasis === 'overall'
        ? Math.max(0, totalMm - occupied)
        : totalMm;
    const pieces = fittings.length + 1;
    const each = tubeTotal === null ? null : tubeTotal / pieces;

    const rr = r ?? 5;                       // something to draw with
    const assumedBore = r === null;

    const tube = (n: number) => ({
      id: `${seg.id}-t${n}`,
      kind: 'tube' as const,
      label: seg.tubeSize ?? 'tube',
      length: each ?? rr * 2 * 6,
      rStart: rr, rEnd: rr,
      assumed: assumedBore || each === null,
    });

    out.push(tube(0));
    fittings.forEach((f, fi) => {
      const fr = f.boreMm !== undefined ? f.boreMm / 2 : rr;
      const body = f.lengthMm ?? fr * 2 * ASSUMED_BODY_D;
      out.push({
        id: `${seg.id}-f${fi}`,
        kind: 'fitting',
        label: FITTING_LABELS[f.kind] ?? f.kind,
        length: body,
        rStart: fr, rEnd: fr,
        turn: TURN[f.kind],
        engagement: f.engagementMm,
        assumed: f.lengthMm === undefined,
      });
      out.push(tube(fi + 1));
    });

    // The change of bore into the next segment, drawn as the taper it is.
    const next = segments[si + 1];
    if (next) {
      const nb = toMm(next.bore);
      if (segBore !== null && nb !== null && Math.abs(segBore - nb) > 1e-9) {
        out.push({
          id: `${seg.id}-x`,
          kind: 'transition',
          label: nb < segBore ? 'reducer' : 'expander',
          length: Math.max(segBore, nb) * TRANSITION_D,
          rStart: segBore / 2,
          rEnd: nb / 2,
        });
      }
    }
  });

  return out;
}

export interface Station {
  x: number;
  y: number;
  /** Radians. */
  heading: number;
  r: number;
}

export interface Walls {
  /** Sampled along the path, in order. */
  stations: Station[];
  /** One entry per element, marking where it starts and ends along the path. */
  spans: { element: Element; from: number; to: number; mid: Station }[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** Total developed length, mm. */
  length: number;
}

/**
 * Walk the elements, turning them into a centreline with a radius on it.
 *
 * Straight elements advance along the heading; a bend swings the heading round
 * an arc of `r/D · D` so the turn has a believable radius rather than being a
 * corner. The wall is then the centreline offset by ±r, which is what makes a
 * reducer look like a reducer.
 */
export function buildWalls(elements: Element[], arcSteps = 10): Walls {
  const stations: Station[] = [];
  const spans: Walls['spans'] = [];
  let x = 0, y = 0, heading = 0, travelled = 0;
  // Bends alternate direction. Which way a real run turns is not in the tally
  // and the drawing must not imply it -- and turning every bend the same way
  // spirals the path back over itself, which hides the very elements this
  // picture exists to show. Snaking never self-intersects.
  let turnSign = 1;

  const push = (s: Station) => { stations.push(s); return s; };

  for (const el of elements) {
    const from = travelled;
    const startIndex = stations.length;

    if (el.turn) {
      // An arc, so the picture shows the path turning rather than kinking.
      const turn = (el.turn * Math.PI) / 180;
      const radius = Math.max(el.rStart * 2 * DEFAULT_BEND_RD, 1e-6);
      const sign = turnSign;
      turnSign = -turnSign;
      const cx = x - Math.sin(heading) * radius * sign;
      const cy = y + Math.cos(heading) * radius * sign;
      const start = Math.atan2(y - cy, x - cx);
      for (let i = 1; i <= arcSteps; i++) {
        const t = i / arcSteps;
        const a = start + turn * t * sign;
        push({
          x: cx + Math.cos(a) * radius,
          y: cy + Math.sin(a) * radius,
          heading: heading + turn * t * sign,
          r: el.rStart + (el.rEnd - el.rStart) * t,
        });
      }
      const last = stations[stations.length - 1];
      x = last.x; y = last.y; heading = last.heading;
      travelled += radius * Math.abs(turn);
    } else {
      if (stations.length === 0) push({ x, y, heading, r: el.rStart });
      else stations.push({ x, y, heading, r: el.rStart });
      x += Math.cos(heading) * el.length;
      y += Math.sin(heading) * el.length;
      push({ x, y, heading, r: el.rEnd });
      travelled += el.length;
    }

    const mid = stations[Math.max(0, Math.floor((startIndex + stations.length - 1) / 2))];
    spans.push({ element: el, from, to: travelled, mid });
  }

  if (stations.length === 0) {
    return {
      stations: [], spans: [],
      bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, length: 0,
    };
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of stations) {
    minX = Math.min(minX, s.x - s.r); maxX = Math.max(maxX, s.x + s.r);
    minY = Math.min(minY, s.y - s.r); maxY = Math.max(maxY, s.y + s.r);
  }
  return { stations, spans, bounds: { minX, maxX, minY, maxY }, length: travelled };
}

/** The two walls, as point lists, offsetting the centreline by ±r. */
export function wallPoints(stations: Station[], rScale = 1) {
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (const s of stations) {
    const nx = -Math.sin(s.heading);
    const ny = Math.cos(s.heading);
    left.push([s.x + nx * s.r * rScale, s.y + ny * s.r * rScale]);
    right.push([s.x - nx * s.r * rScale, s.y - ny * s.r * rScale]);
  }
  return { left, right };
}
