/**
 * A sketch, as the segment list feed-twin reads.
 *
 * Straights become segments -- one per stretch of one diameter, so a split
 * inside a leg makes two -- and bends become `bend` fittings carrying their
 * radius (as r/D) and angle. Both are the shapes `feedtwin.pid.segments`
 * already accepts; nothing new is invented on the wire. The fall comes off
 * the geometry, and the first leg's direction is the run's orientation.
 */

import type { LineSegment } from '../segments';
import type { ParamValue } from '../params';
import { boreAt, fallMm, pieces, legDirection } from './model';
import type { Sketch } from './model';

export interface Exported {
  segments: LineSegment[];
  /** feed-twin's signed rise, metres: negative when the run falls. */
  elevationChange: ParamValue;
  totalLengthMm: number;
  /** `side` when the run leaves horizontally, `down`/`up` when vertically. */
  orientation: 'side' | 'down' | 'up' | 'none';
}

const SOURCE = 'from the centerline sketch';

export function exportSketch(s: Sketch): Exported {
  const segments: LineSegment[] = [];
  let n = 0;
  const open = (boreMm: number): LineSegment => ({
    id: `seg_${++n}`, method: 'itemised', standard: 'tube',
    bore: { value: boreMm, unit: 'mm', source: 'estimated', reference: SOURCE },
    length: { value: 0, unit: 'mm', source: 'measured', reference: SOURCE },
    lengthBasis: 'tube', fittings: [],
  });
  let current: LineSegment | null = null;

  const boundaries = s.sections.map(sec => sec.fromMm).sort((a, b) => a - b);

  for (const piece of pieces(s)) {
    if (piece.kind === 'bend') {
      if (!current) current = open(boreAt(s, piece.fromMm));
      const bore = boreAt(s, piece.fromMm);
      current.fittings!.push({
        id: `fit_${current.fittings!.length + 1}`, kind: 'bend', count: 1,
        boreMm: bore, lengthMm: piece.lengthMm,
        bendDiameters: bore > 0 ? piece.radiusMm! / bore : undefined,
        angleDeg: Math.abs((piece.angleRad! * 180) / Math.PI),
      });
      continue;
    }
    // A straight, cut at every section boundary inside it.
    let from = piece.fromMm;
    const end = piece.fromMm + piece.lengthMm;
    const cuts = boundaries.filter(b => b > from + 1e-9 && b < end - 1e-9);
    for (const cut of [...cuts, end]) {
      const bore = boreAt(s, from);
      if (!current || current.bore!.value !== bore) {
        current = open(bore);
        segments.push(current);
      }
      current.length!.value += cut - from;
      from = cut;
    }
  }
  for (const seg of segments) seg.length!.value = Math.round(seg.length!.value * 100) / 100;
  if (current && !segments.includes(current)) segments.push(current);

  const first = s.legs.length ? legDirection(s, 0) : { x: 0, y: 0 };
  const orientation = !s.legs.length ? 'none'
    : Math.abs(first.x) > Math.abs(first.y) ? 'side'
    : first.y > 0 ? 'down' : 'up';

  return {
    segments,
    elevationChange: { value: -fallMm(s) / 1000, unit: 'm', source: 'measured', reference: SOURCE },
    totalLengthMm: segments.reduce((L, seg) => L + seg.length!.value, 0)
      + s.bends.reduce((L, b) => L + (pieces(s).find(p => p.kind === 'bend' && p.legIndex === b.atLeg)?.lengthMm ?? 0), 0),
    orientation,
  };
}
