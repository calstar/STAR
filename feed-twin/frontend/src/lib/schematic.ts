/**
 * The bits of the schematic that can be *wrong* rather than merely ugly.
 *
 * Colour by fluid, and the flow animation's direction and speed. Everything
 * else in the drawing is layout.
 */

/** Fluid colours, matching pid-designer's `ROLE_COLORS` so a line is the same
 *  colour in the editor and here. */
export const FLUID_COLOR: Record<string, string> = {
  oxygen: '#60a5fa',
  ethanol: '#f97316',
  methane: '#f97316',
  water: '#38bdf8',
  nitrogen: '#ef4444',
  helium: '#ef4444',
};

export const UNSET_COLOR = '#64748b';

export const colorOf = (fluid: string): string =>
  FLUID_COLOR[fluid] ?? UNSET_COLOR;

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
