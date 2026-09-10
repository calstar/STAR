import { Position } from '@xyflow/react';

/**
 * Orthogonal routing between two ports.
 *
 * A P&ID is drawn with square corners, and a line leaves a port the way the
 * port points. That second half is the one that was missing: the router used
 * to turn a corner at the target's coordinate regardless of which way either
 * end faced, so a line leaving a valve's right-hand port to reach something
 * below and to the left set off *left*, back across the valve it had just come
 * out of, before turning down.
 *
 * The rule here is one sentence: **every segment touching an end runs in the
 * direction that end faces.** Everything below is that rule applied to the
 * three shapes a run can take.
 */

/** One end of a run: where it is, and which way it points. */
export interface End {
  x: number;
  y: number;
  side: Position;
}

export interface Route {
  d: string;
  /** The middle segment, when there is one to drag. Null when the shape has no
   *  crossbar — a plain corner has nothing a reader could usefully move. */
  grip: { x: number; y: number } | null;
}

/**
 * How far a line runs straight out of a port before it is allowed to turn.
 *
 * Enough to read as "it leaves this way" at the zoom a bay is drawn at, and
 * short enough not to collide with a symbol sitting one grid square away.
 */
const STUB = 16;

/**
 * Two ends this close on the perpendicular axis are treated as in line.
 *
 * Ports sit at 0, 30 and 60 across a 60-pixel symbol and the grid is 10, so
 * two symbols stacked deliberately can still be a few pixels out. Snapping the
 * run to their average is straight; joining the points is a line that leans.
 */
const ALIGNED = 10;

/**
 * How far to the side a detour goes to clear the symbol it is leaving.
 *
 * A symbol is sixty across and its ports sit on the edge, so half of one is
 * thirty from the port. Two ports pointing the same way and nearly in line --
 * a regulator's dome and the bottle feeding it, sitting under it -- otherwise
 * got a run that went up, across by a few pixels, and back down straight
 * through the regulator body.
 */
const CLEAR = 44;

export const isHorizontal = (p: Position) =>
  p === Position.Left || p === Position.Right;

/** +1 for right/down, -1 for left/up: the way a port points, as a sign. */
export const facing = (p: Position): 1 | -1 =>
  p === Position.Right || p === Position.Bottom ? 1 : -1;

export function routeOrthogonal(a: End, b: End, offset = 0): Route {
  const aH = isHorizontal(a.side);
  const bH = isHorizontal(b.side);
  const as = facing(a.side);
  const bs = facing(b.side);

  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);

  // ── In line, and pointing along the run ──────────────────────────────────
  //
  // Only when both ends face along it. Two ports that happen to be vertically
  // aligned but both point sideways still need to leave sideways, and drawing
  // the straight line between them would run out of the side of each symbol.
  if (dx <= ALIGNED && dy > dx && !aH && !bH
      && (b.y - a.y) * as > 0 && (a.y - b.y) * bs > 0) {
    const x = (a.x + b.x) / 2;
    return { d: `M ${x},${a.y} L ${x},${b.y}`, grip: null };
  }
  if (dy <= ALIGNED && dx > dy && aH && bH
      && (b.x - a.x) * as > 0 && (a.x - b.x) * bs > 0) {
    const y = (a.y + b.y) / 2;
    return { d: `M ${a.x},${y} L ${b.x},${y}`, grip: null };
  }

  // ── One end horizontal, one vertical: a corner, if the corner is ahead ───
  if (aH !== bH) {
    const h = aH ? a : b;                 // the end that leaves sideways
    const v = aH ? b : a;                 // the end that leaves up or down
    const hs = aH ? as : bs;
    const vs = aH ? bs : as;
    // The natural corner sits at the vertical end's x and the horizontal
    // end's y. It only works if it is on the side each end actually faces.
    const ahead = (v.x - h.x) * hs > 0 && (h.y - v.y) * vs > 0;
    if (ahead) {
      const d = aH
        ? `M ${a.x},${a.y} L ${b.x},${a.y} L ${b.x},${b.y}`
        : `M ${a.x},${a.y} L ${a.x},${b.y} L ${b.x},${b.y}`;
      return { d, grip: null };
    }
    // Otherwise stub out of both ends first and join the stubs. Four segments,
    // and every one of them leaves an end the way that end points.
    const hx = h.x + hs * STUB;
    const vy = v.y + vs * STUB;
    const d = aH
      ? `M ${a.x},${a.y} L ${hx},${a.y} L ${hx},${vy} L ${b.x},${vy} L ${b.x},${b.y}`
      : `M ${a.x},${a.y} L ${a.x},${vy} L ${hx},${vy} L ${hx},${b.y} L ${b.x},${b.y}`;
    return { d, grip: null };
  }

  // ── Both horizontal, or both vertical: a crossbar between them ───────────
  //
  // Where the crossbar can go depends on which way the two ends point. Facing
  // each other, it goes between them and the reader can slide it. Facing the
  // same way, or facing apart with no room in between, it has to clear both
  // ends instead -- and then it is not a free crossbar any more, so there is
  // nothing to offer a drag handle for.
  // Two ends pointing the same way and nearly in line have to double back,
  // and doing that at the same coordinate draws the return leg through the
  // symbol. Send those round the side instead.
  const perp = aH ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x);
  const doublesBack = as === bs && perp < CLEAR;

  if (aH) {
    const mid = doublesBack ? null : crossbar(a.x, as, b.x, bs, offset);
    if (mid) {
      const d = `M ${a.x},${a.y} L ${mid.at},${a.y} L ${mid.at},${b.y} L ${b.x},${b.y}`;
      return { d, grip: mid.free ? { x: mid.at, y: (a.y + b.y) / 2 } : null };
    }
    // Facing apart, with nothing between them: out of both ends, and round.
    const ax = a.x + as * STUB;
    const bx = b.x + bs * STUB;
    const my = aside(a.y, b.y);
    return {
      d: `M ${a.x},${a.y} L ${ax},${a.y} L ${ax},${my} L ${bx},${my} L ${bx},${b.y} L ${b.x},${b.y}`,
      grip: null,
    };
  }
  const mid = doublesBack ? null : crossbar(a.y, as, b.y, bs, offset);
  if (mid) {
    return {
      d: `M ${a.x},${a.y} L ${a.x},${mid.at} L ${b.x},${mid.at} L ${b.x},${b.y}`,
      grip: mid.free ? { x: (a.x + b.x) / 2, y: mid.at } : null,
    };
  }
  const ay = a.y + as * STUB;
  const by = b.y + bs * STUB;
  const mx = aside(a.x, b.x);
  return {
    d: `M ${a.x},${a.y} L ${a.x},${ay} L ${mx},${ay} L ${mx},${by} L ${b.x},${by} L ${b.x},${b.y}`,
    grip: null,
  };
}

/**
 * A line to run round on, on the axis the two ends do *not* leave along.
 *
 * Their midpoint, unless they share it -- two symbols stacked exactly would
 * otherwise get a "detour" that retraces the line it just drew.
 */
function aside(a: number, b: number): number {
  // Far apart, the midpoint is between the two symbols and clear of both.
  // Close together, it is *inside* them, so go round instead.
  return Math.abs(a - b) > 2 * CLEAR ? (a + b) / 2 : Math.max(a, b) + CLEAR;
}

/**
 * Where the crossbar sits on a same-axis run, and whether it may be moved.
 *
 * It must be ahead of both ends: `(at - a)·as > 0` and `(at - b)·bs > 0`. When
 * the two point at each other with room in between, every position in that gap
 * satisfies both and the midpoint is as good a default as any -- so that one is
 * free to drag. In every other arrangement exactly one side of both ends works,
 * and the crossbar is pinned just past the further of them.
 */
function crossbar(
  a: number, as: number, b: number, bs: number, offset: number,
): { at: number; free: boolean } | null {
  // Pointing at each other with room between: anywhere in the gap works, so
  // the midpoint is the default and the reader may slide it.
  if (as > 0 && bs < 0 && b - a > 2 * STUB) {
    return { at: (a + b) / 2 + offset, free: true };
  }
  if (as < 0 && bs > 0 && a - b > 2 * STUB) {
    return { at: (a + b) / 2 + offset, free: true };
  }
  // Pointing the same way: one side of both ends works. Out past the further.
  if (as === bs) {
    return { at: as > 0 ? Math.max(a, b) + STUB : Math.min(a, b) - STUB, free: false };
  }
  // Pointing apart, or at each other with no room. No single crossbar can be
  // ahead of both, and pretending otherwise is what drew a line back through
  // the symbol it came from. The caller routes round instead.
  return null;
}
