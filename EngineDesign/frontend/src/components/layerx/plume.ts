/**
 * The exhaust plume from the nozzle's state: its expansion, its width and its shock cells.
 *
 * From chamber (stagnation) pressure p0, exit pressure pe, ambient pa and the exit gamma:
 *
 *   M from p0/p      (p0/p)^((γ-1)/γ) = 1 + (γ-1)/2 M²            isentropic
 *   A/A*(M)          (1/M) [(2/(γ+1)) (1 + (γ-1)/2 M²)]^((γ+1)/(2(γ-1)))
 *   fully expanded   M_j at p0/pa; D_j/D_e = sqrt(A/A*(M_j) / A/A*(M_e))
 *   shock cell       L_s ≈ 1.22 D_j sqrt(M_j² - 1)                 Prandtl-Pack
 *   separation       pe/pa < 0.4                                    Summerfield criterion
 *
 * An over-expanded jet (pe < pa) narrows toward D_j < D_e; an under-expanded one (pe > pa)
 * swells toward D_j > D_e. Its boundary oscillates about D_j once per shock cell, more strongly
 * the further pe is from pa, and the cells are where the diamonds stand.
 */

export interface NozzleState {
  pc_psia: number;
  pe_psia: number;
  pa_psia: number;
  gamma: number;
  tc_K?: number;
  te_K?: number;
}

export interface Plume {
  /** pe / pa: below 1 over-expanded, above 1 under-expanded. */
  ratio: number;
  regime: 'separated' | 'over-expanded' | 'ideal' | 'under-expanded';
  machExit: number;
  machJet: number;
  /** Fully expanded jet diameter over the nozzle exit diameter. */
  djOverDe: number;
  /** Shock-cell length over the nozzle exit diameter. */
  cellOverDe: number;
}

/** Mach number at static pressure p from stagnation p0 (isentropic). */
export function machFromPressure(p0: number, p: number, gamma: number): number {
  const r = Math.pow(p0 / p, (gamma - 1) / gamma);
  return Math.sqrt(Math.max(0, (2 / (gamma - 1)) * (r - 1)));
}

/** Area over throat area at Mach M (isentropic). */
export function areaRatio(M: number, gamma: number): number {
  const g = gamma;
  return (1 / M) * Math.pow((2 / (g + 1)) * (1 + ((g - 1) / 2) * M * M), (g + 1) / (2 * (g - 1)));
}

/** Within this band of pe/pa the jet is drawn as ideally expanded. */
export const IDEAL_BAND = 0.03;
/** Summerfield: below this pe/pa the flow separates inside the nozzle. */
export const SEPARATION_RATIO = 0.4;

export function plume(s: NozzleState): Plume | null {
  const { pc_psia: p0, pe_psia: pe, pa_psia: pa, gamma } = s;
  if (![p0, pe, pa, gamma].every((v) => Number.isFinite(v) && v > 0) || gamma <= 1 || p0 <= pa || p0 <= pe) return null;
  const ratio = pe / pa;
  const Me = machFromPressure(p0, pe, gamma);
  const Mj = machFromPressure(p0, pa, gamma);
  const dj = Math.sqrt(areaRatio(Mj, gamma) / areaRatio(Me, gamma));
  const cell = 1.22 * dj * Math.sqrt(Math.max(Mj * Mj - 1, 0));
  const regime = ratio < SEPARATION_RATIO ? 'separated'
    : Math.abs(ratio - 1) <= IDEAL_BAND ? 'ideal'
    : ratio < 1 ? 'over-expanded' : 'under-expanded';
  return { ratio, regime, machExit: Me, machJet: Mj, djOverDe: dj, cellOverDe: cell };
}

/**
 * The plume's upper boundary as distance from the axis, in exit radii, at axial distance x (in
 * exit diameters) from the exit: oscillating about the fully expanded radius once per cell,
 * damped downstream, with the shear layer spreading it slowly.
 */
export function boundary(p: Plume, x: number): number {
  const rj = p.djOverDe;
  const swing = 1 - rj; // starts at the lip (radius 1) and swings to 2 rj - 1
  const damp = Math.exp(-x / (2.5 * p.cellOverDe));
  return rj + swing * damp * Math.cos((2 * Math.PI * x) / p.cellOverDe) + 0.06 * x;
}
