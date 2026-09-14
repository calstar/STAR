/**
 * Dropping a symbol lines its ports up with the ones already on the drawing.
 *
 * The grid is not enough, and cannot be. A valve is sixty wide so its centre
 * port sits thirty from the node's origin; an engine is seventy-two, so its
 * top port sits at thirty-six. Node positions snap to ten, so the gap between
 * those two ports is always a multiple of ten minus six — an engine under a
 * rotary valve could not be lined up at all, at any position, by anybody.
 *
 * The obvious answer is to make every symbol's width a multiple of twenty so
 * every centre port lands on the same lattice. That works for centre ports and
 * then fails again for a tank with three outlets, or a manifold whose ports
 * were dragged round its perimeter by hand — the general case is symbols whose
 * ports are wherever the hardware puts them, and no lattice fixes that.
 *
 * So: on release, if a port of the symbol you moved is nearly in line with a
 * port already on the drawing, move the symbol the last few pixels so that it
 * *is*. Alignment stops being arithmetic the reader has to do and becomes
 * something the drawing does.
 *
 * Deliberately on release rather than during the drag. Nudging a symbol under
 * the cursor while it is still moving fights the hand holding it.
 */

/** Where one symbol's ports are, in flow coordinates. */
export interface PortPositions {
  id: string;
  xs: number[];
  ys: number[];
}

/**
 * How far a symbol may be moved to bring a port into line.
 *
 * Six, which is chosen rather than picked. Two ports are as far apart as the
 * difference in their offsets from their symbols' origins, and both origins
 * sit on the ten grid — so from the nearest grid square any pair is at most
 * five out, and six covers every pair there can be. The valve-and-engine case
 * is exactly six.
 *
 * Below the grid on purpose. A symbol put one square across from where it
 * would align is a decision, and it stays where it was put.
 */
export const SNAP_TOLERANCE = 6;

/**
 * The shift that lines `moved` up with anything in `others`, or zeros.
 *
 * Each axis is decided on its own — a symbol can line up vertically with one
 * neighbour and horizontally with a different one, which is what happens in
 * any real bay. The smallest shift wins, so the nearest alignment is the one
 * taken rather than whichever port happened to be looked at first.
 */
export function alignmentShift(
  moved: PortPositions,
  others: PortPositions[],
  tolerance = SNAP_TOLERANCE,
): { dx: number; dy: number } {
  return {
    dx: bestShift(moved.xs, others.flatMap(o => o.xs), tolerance),
    dy: bestShift(moved.ys, others.flatMap(o => o.ys), tolerance),
  };
}

function bestShift(mine: number[], theirs: number[], tolerance: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (const a of mine) {
    for (const b of theirs) {
      const gap = Math.abs(b - a);
      // Inclusive: the tolerance is the largest gap worth closing, so a pair
      // exactly that far apart is the case it was sized for, not the first
      // case it turns down.
      if (gap > tolerance) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = b - a;
      }
    }
  }
  return best;
}
