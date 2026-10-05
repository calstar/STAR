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
export const dashPeriod = (mdot: number): number =>
  Math.min(2.0, Math.max(0.25, 1.2 / Math.max(Math.abs(mdot), 0.05)));
