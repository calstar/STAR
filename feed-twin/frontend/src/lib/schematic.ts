/**
 * The flow animation's speed and when it runs: the one part of the schematic
 * feed-twin decides. Everything else is pid-designer's drawing.
 */

/** Below this a line is drawn as static: a dash creeping along a line that is
 *  not really flowing reads as flow, and on a schematic that is a lie. */
export const FLOW_THRESHOLD = 1e-3;

export const isFlowing = (mdot: number): boolean =>
  Math.abs(mdot) > FLOW_THRESHOLD;

/**
 * Seconds per dash cycle. Faster flow, faster dash — clamped at both ends so a
 * trickle does not freeze and a surge does not strobe.
 */
/** Where a symbol's live reading is anchored (its bottom centre), in the
 *  drawing's coordinates: just over the symbol, centred -- or, when the
 *  symbol's tag was dragged above it, just over the tag. A tag is drawn from
 *  its `labelOffset` (top left, from the symbol's top left) and by default
 *  hangs below; LE4 (3)'s FU-PT-R carries its tag above, and the chip sat on
 *  it and read "F 545 R". */
export function readingAnchor(node: {
  position: { x: number; y: number };
  measured: { width: number; height: number };
  data: { labelOffset?: { x: number; y: number } };
}): { x: number; y: number } {
  const above = Math.min(0, node.data.labelOffset?.y ?? 0);
  return { x: node.position.x + node.measured.width / 2, y: node.position.y + above - 3 };
}

export const dashPeriod = (mdot: number): number =>
  Math.min(2.0, Math.max(0.25, 1.2 / Math.max(Math.abs(mdot), 0.05)));
