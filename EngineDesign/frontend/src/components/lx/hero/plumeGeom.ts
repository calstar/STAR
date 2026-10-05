import { areaRatio, boundary, machFromPressure, plume, SEPARATION_RATIO, type NozzleState, type Plume } from '../../layerx/plume';

/**
 * The plume as line art, in the nozzle's own units (x in exit diameters downstream of the exit,
 * r in exit radii), from layerx/plume.ts: the boundary swinging about the fully expanded jet once
 * per shock cell, the cells' diamonds, an expansion fan off the lip when under-expanded or the lip
 * shocks closing in when over-expanded, and where the flow would leave the wall when it separates.
 */

export interface PlumeArt {
  p: Plume;
  /** Upper boundary, (x De, r Re), from the lip. */
  edge: { x: number; r: number }[];
  /** Diamond centres [De] and their half-length [De] and half-height [Re]. */
  diamonds: { x: number; hx: number; hr: number }[];
  /** Rays from the upper lip (x De, r Re) to where they meet the boundary or the axis. */
  rays: { x: number; r: number }[];
  rayKind: 'fan' | 'shock' | null;
  /** How strongly the cells stand, 0.3..1, from how far the exit is from ambient: a near-matched
   *  jet still has weak cells, so they fade with the mismatch rather than switching off at a band. */
  strength: number;
}

/** Plume drawn out to `lengthDe` exit diameters. Null when the engine is not firing into air. */
export function plumeArt(s: NozzleState, lengthDe: number, samples = 64): PlumeArt | null {
  const p = plume(s);
  if (!p || !(lengthDe > 0)) return null;
  const edge = Array.from({ length: samples + 1 }, (_, k) => {
    const x = (k / samples) * lengthDe;
    return { x, r: boundary(p, x) };
  });
  const diamonds: PlumeArt['diamonds'] = [];
  if (p.cellOverDe > 0) {
    for (let k = 1; k * p.cellOverDe <= lengthDe - p.cellOverDe * 0.2; k++) {
      // Fainter and smaller downstream, as the cells decay.
      const f = Math.exp(-(k - 1) / 2.5);
      diamonds.push({ x: k * p.cellOverDe, hx: 0.22 * p.cellOverDe * f, hr: 0.38 * p.djOverDe * f });
    }
  }
  let rays: PlumeArt['rays'] = [];
  let rayKind: PlumeArt['rayKind'] = null;
  if (p.regime === 'under-expanded' && p.cellOverDe > 0) {
    rayKind = 'fan';
    rays = [0.12, 0.24, 0.4].map((f) => {
      const x = f * p.cellOverDe;
      return { x, r: boundary(p, x) };
    });
  } else if ((p.regime === 'over-expanded' || p.regime === 'separated') && p.cellOverDe > 0) {
    rayKind = 'shock';
    rays = [{ x: 0.5 * p.cellOverDe, r: 0 }];
  }
  const strength = Math.min(1, Math.max(0.3, 0.3 + Math.abs(Math.log(p.ratio)) / 0.25));
  return { p, edge, diamonds, rays, rayKind, strength };
}

/** The shortest and longest plume drawn [exit diameters]. */
export const PLUME_MIN_DE = 2.4;
export const PLUME_MAX_DE = 3.6;

/**
 * How far downstream to draw the plume for a whole burn [exit diameters]: long enough to show the
 * first shock cell at the burn's typical (median) state, within [PLUME_MIN_DE, PLUME_MAX_DE]. One
 * length per run, so the engine's scale does not move while the cursor does.
 */
export function plumeLengthDe(states: readonly NozzleState[]): number {
  const cells = states.map((s) => plume(s)?.cellOverDe).filter((c): c is number => c !== undefined && Number.isFinite(c) && c > 0).sort((a, b) => a - b);
  if (!cells.length) return PLUME_MIN_DE;
  const median = cells[Math.floor(cells.length / 2)];
  return Math.min(PLUME_MAX_DE, Math.max(PLUME_MIN_DE, median * 1.2));
}

/**
 * Where the wall pressure falls to the Summerfield separation level (0.4 of ambient): the area
 * ratio there, from which the station on the divergent follows. Null when the exit is above it.
 */
export function separationAreaRatio(s: NozzleState): number | null {
  const { pc_psia: p0, pe_psia: pe, pa_psia: pa, gamma } = s;
  if (![p0, pe, pa, gamma].every((v) => Number.isFinite(v) && v > 0) || gamma <= 1) return null;
  if (pe / pa >= SEPARATION_RATIO) return null;
  const pw = SEPARATION_RATIO * pa;
  if (p0 <= pw) return null;
  return areaRatio(machFromPressure(p0, pw, gamma), gamma);
}

/** The station [index] on the divergent where the radius first reaches r, or null. */
export function stationAtRadius(r: readonly number[], throat: number, rTarget: number): number | null {
  for (let i = throat + 1; i < r.length; i++) if (r[i] >= rTarget) return i;
  return null;
}
