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

/**
 * To a ten-thousandth: of a millimetre for a bore, of a metre for the fall.
 * An inch sketch's 0.43 in is 10.921999999999999 mm in floating point, and a
 * fall off its geometry 0.8029517354603677 m; written so, they were stored
 * and shown so.
 */
const tidy = (x: number) => Math.round(x * 1e4) / 1e4;

export function exportSketch(s: Sketch): Exported {
  const segments: LineSegment[] = [];
  let n = 0;
  // A stretch whose inner diameter was never given states no bore: absent is
  // "not stated", never zero (segments.ts). Written as 0 'estimated' it read
  // as a size -- the sheet's check counted the line sized -- while feed-twin
  // priced nothing for the run, tube or bends (LE4 (3)'s fuel tank-to-main).
  const open = (boreMm: number): LineSegment => ({
    id: `seg_${++n}`, method: 'itemised', standard: 'tube',
    ...(boreMm > 0 ? { bore: { value: tidy(boreMm), unit: 'mm', source: 'estimated', reference: SOURCE } } : {}),
    length: { value: 0, unit: 'mm', source: 'measured', reference: SOURCE },
    lengthBasis: 'tube', fittings: [],
  });
  let current: LineSegment | null = null;
  let currentBore = NaN;

  const boundaries = s.sections.map(sec => sec.fromMm).sort((a, b) => a - b);

  for (const piece of pieces(s)) {
    if (piece.kind === 'bend') {
      const bore = boreAt(s, piece.fromMm);
      if (!current) { current = open(bore); currentBore = bore; }
      current.fittings!.push({
        id: `fit_${current.fittings!.length + 1}`, kind: 'bend', count: 1,
        ...(bore > 0 ? { boreMm: tidy(bore), bendDiameters: piece.radiusMm! / bore } : {}),
        lengthMm: piece.lengthMm,
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
      if (!current || currentBore !== bore) {
        current = open(bore);
        currentBore = bore;
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
    elevationChange: { value: -tidy(fallMm(s) / 1000), unit: 'm', source: 'measured', reference: SOURCE },
    totalLengthMm: segments.reduce((L, seg) => L + seg.length!.value, 0)
      + s.bends.reduce((L, b) => L + (pieces(s).find(p => p.kind === 'bend' && p.legIndex === b.atLeg)?.lengthMm ?? 0), 0),
    orientation,
  };
}
