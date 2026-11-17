/**
 * ASI (augmented spark igniter) physics: GOx / GCH4 gas flow and combustion.
 *
 * The ASI burns two gases, so none of the main engine's liquid machinery applies:
 * every restriction is a compressible orifice (choked or not), every volume an
 * isothermal ideal-gas node, and the chamber a quasi-steady balance between what
 * the two injectors deliver and what the throat passes.
 *
 * Units inside: SI, pressures ABSOLUTE (Pa). The DAQ's transducers read gauge, so
 * the pages convert at the edge with `psigToPa` / `paToPsig`.
 */

import { CEA_CSTAR_MS, CEA_GAMMA, CEA_MW, CEA_OF, CEA_PC_PSIA, CEA_TC_K, FEED_GAS } from './cea-gox-ch4';

export const PA_PER_PSI = 6894.757;
/** Standard atmosphere, Pa. The stand's ambient; the twin lets it be changed. */
export const P_ATM = 101325;
/** Universal gas constant, J/(kmol K). */
export const R_UNIVERSAL = 8314.462618;

export const psigToPa = (psig: number, pAtm = P_ATM): number => psig * PA_PER_PSI + pAtm;
export const paToPsig = (pa: number, pAtm = P_ATM): number => (pa - pAtm) / PA_PER_PSI;
export const paToPsia = (pa: number): number => pa / PA_PER_PSI;
export const mm2ToM2 = (mm2: number): number => mm2 * 1e-6;
export const ccToM3 = (cc: number): number => cc * 1e-6;

export interface IdealGas {
  name: string;
  gamma: number;
  /** Specific gas constant, J/(kg K). */
  R: number;
}

/** Feed gases at 293 K from the generated table (Cantera, ideal gas). */
export const GOX: IdealGas = { name: 'GOx', gamma: FEED_GAS.O2.gamma, R: R_UNIVERSAL / FEED_GAS.O2.mw };
export const GCH4: IdealGas = { name: 'CH4', gamma: FEED_GAS.CH4.gamma, R: R_UNIVERSAL / FEED_GAS.CH4.mw };

/** Mass O2 per mass CH4 for complete combustion: CH4 + 2 O2 -> CO2 + 2 H2O. */
export const OF_STOICH = (2 * FEED_GAS.O2.mw) / FEED_GAS.CH4.mw;

/** Critical (choking) back-pressure ratio Pb/P0 for a gas. */
export function criticalPressureRatio(gamma: number): number {
  return Math.pow(2 / (gamma + 1), gamma / (gamma - 1));
}

/**
 * Isentropic mass flow through an orifice of effective area `cda` (Cd x A, m^2)
 * from stagnation (p0, t0) to back pressure pb. Choked below the critical ratio,
 * subsonic above it. Negative when pb > p0 (flow runs backwards, priced at the
 * same gas and temperature -- adequate for the brief reversals a valve closing
 * against a live chamber produces).
 */
export function orificeMassFlow(cda: number, p0: number, t0: number, pb: number, gas: IdealGas): number {
  if (cda <= 0) return 0;
  if (pb > p0) return -orificeMassFlow(cda, pb, t0, p0, gas);
  if (p0 <= 0) return 0;
  const g = gas.gamma;
  const r = pb / p0;
  const rc = criticalPressureRatio(g);
  if (r <= rc) {
    return cda * p0 * Math.sqrt(g / (gas.R * t0)) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
  }
  const term = Math.pow(r, 2 / g) - Math.pow(r, (g + 1) / g);
  return cda * p0 * Math.sqrt(((2 * g) / ((g - 1) * gas.R * t0)) * Math.max(0, term));
}

/** Is flow from p0 into pb choked? */
export function isChoked(p0: number, pb: number, gas: IdealGas): boolean {
  return p0 > 0 && pb / p0 <= criticalPressureRatio(gas.gamma);
}

// ── Combustion lookup ────────────────────────────────────────────────────────

export interface CombustionState {
  /** Adiabatic flame temperature, K (ideal; no efficiency applied). */
  tcK: number;
  /** Frozen chamber gamma. */
  gamma: number;
  /** Mean molecular weight, kg/kmol. */
  mw: number;
  /** Ideal c*, m/s. */
  cstar: number;
}

function bracket(xs: number[], x: number): [number, number, number] {
  if (x <= xs[0]) return [0, 0, 0];
  const n = xs.length - 1;
  if (x >= xs[n]) return [n, n, 0];
  let i = 0;
  while (xs[i + 1] < x) i++;
  return [i, i + 1, (x - xs[i]) / (xs[i + 1] - xs[i])];
}

/**
 * Burning chamber state at mixture ratio `of` and chamber pressure `pcPa` (abs),
 * bilinear in (O/F, log Pc) over the generated table and clamped to its edges
 * (O/F 0.5-8, Pc 25-400 psia). Pc matters little -- a few percent across the
 * range -- O/F is what moves it.
 */
export function combustion(of: number, pcPa: number): CombustionState {
  const [i0, i1, fo] = bracket(CEA_OF, of);
  const logPc = CEA_PC_PSIA.map((p) => Math.log(p));
  const [j0, j1, fp] = bracket(logPc, Math.log(Math.max(1e-6, paToPsia(pcPa))));
  const pick = (tbl: number[][]): number => {
    const a = tbl[j0][i0] + (tbl[j0][i1] - tbl[j0][i0]) * fo;
    const b = tbl[j1][i0] + (tbl[j1][i1] - tbl[j1][i0]) * fo;
    return a + (b - a) * fp;
  };
  return { tcK: pick(CEA_TC_K), gamma: pick(CEA_GAMMA), mw: pick(CEA_MW), cstar: pick(CEA_CSTAR_MS) };
}

/** Unburnt GOx/CH4 mixture (mass-weighted cp, cv) -- the chamber before light and during cold flow. */
export function coldMixture(mdotOx: number, mdotF: number): IdealGas {
  const tot = mdotOx + mdotF;
  if (tot <= 0) return { name: 'air', gamma: 1.4, R: 287.05 };
  const yo = mdotOx / tot;
  const yf = mdotF / tot;
  const cp = (g: IdealGas) => (g.gamma * g.R) / (g.gamma - 1);
  const R = yo * GOX.R + yf * GCH4.R;
  const cpMix = yo * cp(GOX) + yf * cp(GCH4);
  return { name: 'GOx/CH4 mix', gamma: cpMix / (cpMix - R), R };
}

/** c* of any ideal gas at stagnation temperature t0: sqrt(R T) / Gamma. */
export function cstarOf(gas: IdealGas, t0: number): number {
  const g = gas.gamma;
  const big = Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
  return Math.sqrt(gas.R * t0) / big;
}

/**
 * CH4 flammability in pure O2: 5.1-61 % CH4 by volume (Coward & Jones, US Bureau
 * of Mines Bulletin 503, 1952). As mass O/F: 61 % CH4 -> 1.28, 5.1 % -> 37.
 */
export const FLAMMABLE_CH4_MOLE_FRACTION = { lean: 0.051, rich: 0.61 } as const;

export function ofFromCh4MoleFraction(x: number): number {
  return ((1 - x) * FEED_GAS.O2.mw) / (x * FEED_GAS.CH4.mw);
}

export const OF_FLAMMABLE = {
  min: ofFromCh4MoleFraction(FLAMMABLE_CH4_MOLE_FRACTION.rich),
  max: ofFromCh4MoleFraction(FLAMMABLE_CH4_MOLE_FRACTION.lean),
} as const;
