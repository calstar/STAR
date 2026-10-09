/**
 * The gas's state along the engine at one moment, from the contour: the isentropic area–Mach
 * relation, subsonic to the throat and supersonic after it, with the chamber's gamma up to the
 * throat and the exit's beyond it. Anchored on the solver's chamber pressure and temperature; the
 * exit station's own figures are the solver's (shifting composition), shown beside this profile.
 */

/** A / A* at Mach `m` for ratio of specific heats `g`. */
export function areaRatio(m: number, g: number): number {
  const e = (g + 1) / (2 * (g - 1));
  return (1 / m) * Math.pow((2 / (g + 1)) * (1 + ((g - 1) / 2) * m * m), e);
}

/** The Mach number at area ratio `ar` (>= 1) on the subsonic or supersonic branch. */
export function machAt(ar: number, g: number, supersonic: boolean): number {
  if (!(ar > 1)) return 1;
  let lo = supersonic ? 1 : 1e-6;
  let hi = supersonic ? 50 : 1;
  for (let k = 0; k < 80; k++) {
    const mid = 0.5 * (lo + hi);
    // Subsonic: A/A* falls as M rises; supersonic: it rises.
    const above = areaRatio(mid, g) > ar;
    if (above === supersonic) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}

export interface Along {
  /** Mach, static temperature [K] and static pressure [psia] at each station. */
  M: number[];
  T: number[];
  p: number[];
}

/**
 * `r` is the gas-side radius at each station (any unit), `it` the throat's index; `tc` the chamber
 * temperature [K] and `pc` its pressure [psia]; `gc`, `ge` gamma in the chamber and at the exit.
 */
export function stateAlong(r: readonly number[], it: number, tc: number, pc: number, gc: number, ge: number): Along {
  const rt = r[it];
  const M: number[] = [];
  const T: number[] = [];
  const p: number[] = [];
  r.forEach((ri, i) => {
    const g = i <= it ? gc : ge;
    const m = i === it ? 1 : machAt((ri / rt) ** 2, g, i > it);
    // Total temperature and pressure held at the chamber's: frozen, adiabatic, no losses.
    const t0 = 1 + ((g - 1) / 2) * m * m;
    M.push(m);
    T.push(tc / t0);
    p.push(pc * Math.pow(t0, -g / (g - 1)));
  });
  return { M, T, p };
}
