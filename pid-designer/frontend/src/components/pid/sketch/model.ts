/**
 * The centerline sketch: a run of tube the way somebody measures it.
 *
 * A drawing of the centerline -- straight legs joined end to end, bends of
 * a stated radius at the corners, and an inner wall drawn either side of it
 * -- with lengths and diameters as dimensions on the drawing rather than as
 * fields in a form. What a CAD sketch does for a part, done for a run.
 *
 * This file is the geometry and nothing else: no DOM, no React, so every
 * rule about lengths, tangents, sections and units is tested on its own.
 * `export.ts` turns a sketch into the segment list feed-twin reads.
 *
 * Units: the model is in **millimetres** throughout. The display unit is a
 * view choice (in / m / mm), applied at the edge.
 */

export type Unit = 'in' | 'mm' | 'm';

export const MM_PER: Record<Unit, number> = { mm: 1, in: 25.4, m: 1000 };

export const toMm = (value: number, unit: Unit) => value * MM_PER[unit];
export const fromMm = (mm: number, unit: Unit) => mm / MM_PER[unit];

export interface Point { x: number; y: number }

/**
 * One straight leg of the centerline, from the previous vertex to `to`.
 *
 * Legs are stored by their end vertex. The first leg starts at the origin,
 * which is where the run leaves the upstream port -- so the first leg's
 * direction *is* the run's orientation: a horizontal first leg means the
 * port is on the side.
 */
export interface Leg {
  id: string;
  to: Point;
}

/** A bend at the vertex between leg `i` and leg `i+1`, by radius. */
export interface Bend {
  /** Index of the vertex: after leg `atLeg` and before the next. */
  atLeg: number;
  radiusMm: number;
}

/**
 * A change of inner diameter somewhere along the run.
 *
 * Sections are cut by *distance along the centerline*, so a split survives
 * the leg it was made on being lengthened. A run with no sections is all
 * one diameter, the sketch's `boreMm`.
 */
export interface Section {
  id: string;
  /** Distance along the centerline where this section begins, mm. */
  fromMm: number;
  boreMm: number;
}

export interface Sketch {
  /** The run's inner diameter until a section says otherwise, mm. */
  boreMm: number;
  legs: Leg[];
  bends: Bend[];
  sections: Section[];
  /** How the sketch was being viewed; not physics. */
  unit: Unit;
}

export const emptySketch = (unit: Unit = 'in'): Sketch =>
  ({ boreMm: 0, legs: [], bends: [], sections: [], unit });

export const ORIGIN: Point = { x: 0, y: 0 };

// ── Legs ─────────────────────────────────────────────────────────────────────

/** The vertex a leg starts from: the origin, or the previous leg's end. */
export function startOf(s: Sketch, i: number): Point {
  return i === 0 ? ORIGIN : s.legs[i - 1].to;
}

export const legLengthMm = (s: Sketch, i: number): number =>
  Math.hypot(s.legs[i].to.x - startOf(s, i).x, s.legs[i].to.y - startOf(s, i).y);

/** Unit direction of a leg; the zero vector for a zero-length leg. */
export function legDirection(s: Sketch, i: number): Point {
  const a = startOf(s, i), b = s.legs[i].to;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  return L === 0 ? { x: 0, y: 0 } : { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
}

/**
 * Snap a direction to the nearest of the eight compass directions.
 *
 * A run on a stand is horizontal or vertical nearly always, and 45° when it
 * is not. Free-drawn angles are what a mouse produces, not what a fitter
 * bends.
 */
export function snapDirection(from: Point, to: Point): Point {
  const dx = to.x - from.x, dy = to.y - from.y;
  const L = Math.hypot(dx, dy);
  if (L === 0) return from;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: from.x + Math.cos(angle) * L, y: from.y + Math.sin(angle) * L };
}

/** Add a leg ending at `to`, snapped to the eight directions unless `free`. */
export function addLeg(s: Sketch, to: Point, free = false): Sketch {
  const from = s.legs.length ? s.legs[s.legs.length - 1].to : ORIGIN;
  const end = free ? to : snapDirection(from, to);
  if (Math.hypot(end.x - from.x, end.y - from.y) < 1e-9) return s;
  return { ...s, legs: [...s.legs, { id: `leg_${s.legs.length + 1}`, to: end }] };
}

/**
 * Set a leg's length, keeping its direction and moving everything after it.
 *
 * Editing a dimension in a CAD sketch does not swing the rest of the run
 * about; the downstream legs translate with the vertex they hang from.
 */
export function setLegLength(s: Sketch, i: number, lengthMm: number): Sketch {
  if (i < 0 || i >= s.legs.length || !(lengthMm > 0)) return s;
  const d = legDirection(s, i);
  if (d.x === 0 && d.y === 0) return s;
  const a = startOf(s, i);
  const newEnd = { x: a.x + d.x * lengthMm, y: a.y + d.y * lengthMm };
  const shift = { x: newEnd.x - s.legs[i].to.x, y: newEnd.y - s.legs[i].to.y };
  const legs = s.legs.map((leg, k) => k < i ? leg
    : { ...leg, to: { x: leg.to.x + shift.x, y: leg.to.y + shift.y } });
  return { ...s, legs };
}

/** Remove the last leg, and any bend or section that lived on it. */
export function undoLeg(s: Sketch): Sketch {
  if (!s.legs.length) return s;
  const last = s.legs.length - 1;
  const total = totalLengthMm({ ...s, legs: s.legs.slice(0, last) });
  return {
    ...s,
    legs: s.legs.slice(0, last),
    bends: s.bends.filter(b => b.atLeg < last - 1),
    sections: s.sections.filter(sec => sec.fromMm < total),
  };
}

// ── Bends ────────────────────────────────────────────────────────────────────

/** The turn at vertex `i` (after leg `i`), in radians, 0 for collinear. */
export function turnAngle(s: Sketch, i: number): number {
  if (i < 0 || i + 1 >= s.legs.length) return 0;
  const a = legDirection(s, i), b = legDirection(s, i + 1);
  const cross = a.x * b.y - a.y * b.x;
  const dot = a.x * b.x + a.y * b.y;
  return Math.atan2(cross, dot);
}

/** Vertices a bend can go on: between two legs that are not collinear. */
export function bendableVertices(s: Sketch): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < s.legs.length; i++) {
    if (Math.abs(turnAngle(s, i)) > 1e-6) out.push(i);
  }
  return out;
}

/** The straight length a bend of this radius takes from each adjacent leg. */
export const tangentLengthMm = (radiusMm: number, angleRad: number) =>
  radiusMm * Math.tan(Math.abs(angleRad) / 2);

/** Arc length of a bend. */
export const arcLengthMm = (radiusMm: number, angleRad: number) =>
  radiusMm * Math.abs(angleRad);

/**
 * Put a bend at a vertex, or change its radius.
 *
 * Refused when the radius would eat more of a leg than the leg has -- a
 * bend needs tangent length on both sides, and a radius that does not fit
 * is not a bend anyone can make.
 */
export function setBend(s: Sketch, atLeg: number, radiusMm: number): Sketch | null {
  if (!bendableVertices(s).includes(atLeg) || !(radiusMm > 0)) return null;
  const t = tangentLengthMm(radiusMm, turnAngle(s, atLeg));
  const before = legLengthMm(s, atLeg) - tangentOnLeg(s, atLeg, 'start');
  const after = legLengthMm(s, atLeg + 1) - tangentOnLeg(s, atLeg + 1, 'end');
  if (t > before + 1e-9 || t > after + 1e-9) return null;
  const bends = s.bends.filter(b => b.atLeg !== atLeg).concat({ atLeg, radiusMm });
  return { ...s, bends: bends.sort((a, b) => a.atLeg - b.atLeg) };
}

export const removeBend = (s: Sketch, atLeg: number): Sketch =>
  ({ ...s, bends: s.bends.filter(b => b.atLeg !== atLeg) });

/** Tangent length already taken from one end of leg `i` by a bend there. */
function tangentOnLeg(s: Sketch, i: number, end: 'start' | 'end'): number {
  const vertex = end === 'start' ? i - 1 : i;
  const bend = s.bends.find(b => b.atLeg === vertex);
  return bend ? tangentLengthMm(bend.radiusMm, turnAngle(s, vertex)) : 0;
}

/** A leg's straight length once the bends at its ends are taken off. */
export function straightLengthMm(s: Sketch, i: number): number {
  return legLengthMm(s, i) - tangentOnLeg(s, i, 'start') - tangentOnLeg(s, i, 'end');
}

/** The developed length of the whole centerline: straights plus arcs. */
export function totalLengthMm(s: Sketch): number {
  let L = 0;
  for (let i = 0; i < s.legs.length; i++) L += straightLengthMm(s, i);
  for (const b of s.bends) L += arcLengthMm(b.radiusMm, turnAngle(s, b.atLeg));
  return L;
}

/** Vertical extent from origin to end: positive when the end is lower. Screen y grows downward. */
export function fallMm(s: Sketch): number {
  return s.legs.length ? s.legs[s.legs.length - 1].to.y : 0;
}

// ── Sections (inner diameter along the run) ─────────────────────────────────

/** Split the run at a distance along it; the new section keeps the old bore. */
export function splitAt(s: Sketch, alongMm: number): Sketch {
  const total = totalLengthMm(s);
  if (!(alongMm > 0) || alongMm >= total) return s;
  if (s.sections.some(sec => Math.abs(sec.fromMm - alongMm) < 1e-6)) return s;
  const bore = boreAt(s, alongMm);
  const sections = [...s.sections, { id: `sec_${s.sections.length + 1}`, fromMm: alongMm, boreMm: bore }]
    .sort((a, b) => a.fromMm - b.fromMm);
  return { ...s, sections };
}

/** The inner diameter in force at a distance along the run. */
export function boreAt(s: Sketch, alongMm: number): number {
  let bore = s.boreMm;
  for (const sec of s.sections) if (sec.fromMm <= alongMm) bore = sec.boreMm;
  return bore;
}

export function setSectionBore(s: Sketch, id: string | null, boreMm: number): Sketch {
  if (!(boreMm > 0)) return s;
  if (id === null) return { ...s, boreMm };
  return { ...s, sections: s.sections.map(sec => sec.id === id ? { ...sec, boreMm } : sec) };
}

export const removeSection = (s: Sketch, id: string): Sketch =>
  ({ ...s, sections: s.sections.filter(sec => sec.id !== id) });

/**
 * The run as a list of pieces in order: each straight and each bend, with
 * its start distance along the centerline. What the export and the
 * inner-wall drawing both walk.
 */
export interface Piece {
  kind: 'straight' | 'bend';
  legIndex: number;
  fromMm: number;
  lengthMm: number;
  /** Bends only. */
  radiusMm?: number;
  angleRad?: number;
}

export function pieces(s: Sketch): Piece[] {
  const out: Piece[] = [];
  let along = 0;
  for (let i = 0; i < s.legs.length; i++) {
    const L = straightLengthMm(s, i);
    out.push({ kind: 'straight', legIndex: i, fromMm: along, lengthMm: L });
    along += L;
    const bend = s.bends.find(b => b.atLeg === i);
    if (bend) {
      const angle = turnAngle(s, i);
      const arc = arcLengthMm(bend.radiusMm, angle);
      out.push({ kind: 'bend', legIndex: i, fromMm: along, lengthMm: arc, radiusMm: bend.radiusMm, angleRad: angle });
      along += arc;
    }
  }
  return out;
}

/** Where a distance along the centerline lands on the page, and which way it points. */
export function pointAlong(s: Sketch, alongMm: number): { p: Point; dir: Point } | null {
  if (!s.legs.length) return null;
  let along = 0;
  for (let i = 0; i < s.legs.length; i++) {
    const a = startOf(s, i);
    const d = legDirection(s, i);
    const t0 = tangentOnLeg(s, i, 'start');
    const L = straightLengthMm(s, i);
    if (alongMm <= along + L + 1e-9 || i === s.legs.length - 1) {
      const u = Math.max(0, Math.min(L, alongMm - along));
      return { p: { x: a.x + d.x * (t0 + u), y: a.y + d.y * (t0 + u) }, dir: d };
    }
    along += L;
    const bend = s.bends.find(b => b.atLeg === i);
    if (bend) {
      const angle = turnAngle(s, i);
      const arc = arcLengthMm(bend.radiusMm, angle);
      if (alongMm <= along + arc) {
        // On the arc: rotate about its centre.
        const f = (alongMm - along) / arc;
        const sign = Math.sign(angle);
        const centre = { x: s.legs[i].to.x - d.x * tangentLengthMm(bend.radiusMm, angle) - d.y * sign * bend.radiusMm,
                         y: s.legs[i].to.y - d.y * tangentLengthMm(bend.radiusMm, angle) + d.x * sign * bend.radiusMm };
        const start = Math.atan2((s.legs[i].to.y - d.y * tangentLengthMm(bend.radiusMm, angle)) - centre.y,
                                 (s.legs[i].to.x - d.x * tangentLengthMm(bend.radiusMm, angle)) - centre.x);
        const th = start + f * angle;
        const p = { x: centre.x + bend.radiusMm * Math.cos(th), y: centre.y + bend.radiusMm * Math.sin(th) };
        const dir = { x: -Math.sin(th) * sign, y: Math.cos(th) * sign };
        return { p, dir };
      }
      along += arc;
    }
  }
  return null;
}
