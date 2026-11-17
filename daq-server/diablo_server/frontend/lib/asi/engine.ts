/**
 * ASI "engine": the torch at a design point, and sizing it.
 *
 * Hotbench Engine's job for the main engine, cut down to two gases and one
 * chamber: what Pc / O/F / Tc a pair of hole pressures gives (`operatingPoint`,
 * the same chamber solve the twin runs), and what holes and throat a target needs
 * (`sizeAsi`). Equations are the design point's own (asi_gox_gch4_..._2026-10-07.yaml):
 *   Pc = mdot eta c* / At ;  choked hole mdot = Cd A P0 sqrt(g/(R T0)) (2/(g+1))^((g+1)/(2(g-1)))
 */

import { CEA_OF } from './cea-gox-ch4';
import {
  GCH4, GOX, OF_FLAMMABLE, OF_STOICH, PA_PER_PSI, combustion, criticalPressureRatio, orificeMassFlow,
} from './physics';
import type { AsiModel } from './settings';
import { AsiTwin } from './twin';

export interface OperatingPoint {
  pcPsia: number;
  of: number;
  mdotOx_gs: number;
  mdotF_gs: number;
  tcK: number;
  cstarIdeal: number;
  goxHoleChoked: boolean;
  ch4HoleChoked: boolean;
  /** Delivered energy margin vs the main engine's light requirement. */
  energyMargin: number;
}

/**
 * Energy delivered to the main chamber, per the design point: deliverable
 * enthalpy 6.26 MJ/kg (CEA, O/F 2.5) against a 32.1 kW light requirement,
 * derated by ~eta^2. Stated at O/F 2.5 only; elsewhere it is indicative.
 */
export const ENERGY = { deliverableMJperKg: 6.26, requiredKW: 32.1, target: 3.0 } as const;

export function energyMargin(mdotTotal_gs: number, cstarEff: number): number {
  return ((mdotTotal_gs / 1000) * ENERGY.deliverableMJperKg * 1000 * cstarEff ** 2) / ENERGY.requiredKW;
}

/** The burning torch with both holes fed at the given gauge pressures. */
export function operatingPoint(model: AsiModel, goxHolePsig: number, ch4HolePsig: number): OperatingPoint {
  const tw = new AsiTwin(model);
  const atm = 101325;
  const sol = tw.solveChamber(goxHolePsig * PA_PER_PSI + atm, ch4HolePsig * PA_PER_PSI + atm, true);
  const of = sol.mF > 0 ? sol.mOx / sol.mF : NaN;
  const c = combustion(Number.isFinite(of) ? of : model.ofMax, sol.pc);
  const pOx = goxHolePsig * PA_PER_PSI + atm;
  const pF = ch4HolePsig * PA_PER_PSI + atm;
  return {
    pcPsia: sol.pc / PA_PER_PSI,
    of,
    mdotOx_gs: sol.mOx * 1000,
    mdotF_gs: sol.mF * 1000,
    tcK: c.tcK,
    cstarIdeal: c.cstar,
    goxHoleChoked: sol.pc / pOx <= criticalPressureRatio(GOX.gamma),
    ch4HoleChoked: sol.pc / pF <= criticalPressureRatio(GCH4.gamma),
    energyMargin: energyMargin((sol.mOx + sol.mF) * 1000, model.cstarEff),
  };
}

// ── Sizing ───────────────────────────────────────────────────────────────────

/** Number and letter drills, mm (ASME B94.11M). Enough to name ASI holes and throats. */
export const DRILLS: [string, number][] = [
  ['#45', 2.083], ['#46', 2.057], ['#47', 1.994], ['#48', 1.930], ['#49', 1.854], ['#50', 1.778],
  ['#51', 1.702], ['#52', 1.613], ['#53', 1.511], ['#54', 1.397], ['#55', 1.321], ['#56', 1.181],
  ['#57', 1.092], ['#58', 1.067], ['#59', 1.041], ['#60', 1.016], ['#61', 0.991], ['#62', 0.965],
  ['#63', 0.940], ['#64', 0.914], ['#65', 0.889], ['#66', 0.838], ['#67', 0.813], ['#68', 0.787],
  ['#69', 0.742], ['#70', 0.711],
  ['F', 6.528], ['G', 6.629], ['H', 6.756], ['I', 6.909], ['J', 7.036], ['K', 7.137], ['L', 7.366],
  ['M', 7.493], ['N', 7.671], ['O', 8.026], ['P', 8.204], ['Q', 8.433],
];

export function nearestDrill(dia_mm: number): { name: string; dia_mm: number } {
  let best = DRILLS[0];
  for (const d of DRILLS) if (Math.abs(d[1] - dia_mm) < Math.abs(best[1] - dia_mm)) best = d;
  return { name: best[0], dia_mm: best[1] };
}

export interface SizingInput {
  pcPsia: number;
  of: number;
  mdotTotal_gs: number;
  cstarEff: number;
  goxHolePsia: number;
  ch4HolePsia: number;
  cd: number;
}

export interface SizingResult {
  mdotOx_gs: number;
  mdotF_gs: number;
  throatDia_mm: number;
  throatDrill: { name: string; dia_mm: number };
  goxHoleDia_mm: number;
  goxDrill: { name: string; dia_mm: number };
  ch4HoleDia_mm: number;
  ch4Drill: { name: string; dia_mm: number };
  /** Hole P0 / Pc must exceed this for the hole to stay choked. */
  goxChokeMargin: number;
  ch4ChokeMargin: number;
  tcK: number;
  cstarIdeal: number;
  energyMargin: number;
  warnings: string[];
}

/** Hole area for a target flow, from the (choked or not) orifice equation. */
function holeDia(mdot: number, p0: number, pc: number, cd: number, gas: typeof GOX, t0: number): number {
  const perArea = orificeMassFlow(1, p0, t0, pc, gas); // kg/s per m^2 of Cd*A
  if (perArea <= 0) return NaN;
  const a = mdot / perArea / cd;
  return 2 * Math.sqrt(a / Math.PI) * 1000;
}

export function sizeAsi(inp: SizingInput, gasTempK = 293): SizingResult {
  const warnings: string[] = [];
  const pc = inp.pcPsia * PA_PER_PSI;
  const mOx = (inp.mdotTotal_gs * inp.of) / (1 + inp.of) / 1000;
  const mF = inp.mdotTotal_gs / (1 + inp.of) / 1000;
  const c = combustion(inp.of, pc);
  const at = ((mOx + mF) * inp.cstarEff * c.cstar) / pc;
  const throatDia = 2 * Math.sqrt(at / Math.PI) * 1000;
  const pOx = inp.goxHolePsia * PA_PER_PSI;
  const pF = inp.ch4HolePsia * PA_PER_PSI;
  const goxDia = holeDia(mOx, pOx, pc, inp.cd, GOX, gasTempK);
  const ch4Dia = holeDia(mF, pF, pc, inp.cd, GCH4, gasTempK);
  const goxCrit = 1 / criticalPressureRatio(GOX.gamma);
  const ch4Crit = 1 / criticalPressureRatio(GCH4.gamma);
  if (inp.goxHolePsia / inp.pcPsia < goxCrit) warnings.push(`GOx hole unchoked: P0/Pc ${(inp.goxHolePsia / inp.pcPsia).toFixed(2)} < ${goxCrit.toFixed(2)}; flow will follow Pc.`);
  if (inp.ch4HolePsia / inp.pcPsia < ch4Crit) warnings.push(`CH4 hole unchoked: P0/Pc ${(inp.ch4HolePsia / inp.pcPsia).toFixed(2)} < ${ch4Crit.toFixed(2)}; flow will follow Pc.`);
  if (inp.of < OF_FLAMMABLE.min) warnings.push(`O/F ${inp.of} is richer than CH4's flammability limit in O₂ (${OF_FLAMMABLE.min.toFixed(2)}): it will not light.`);
  if (inp.of > OF_STOICH) warnings.push(`O/F ${inp.of} is oxidiser-rich (stoichiometric ${OF_STOICH.toFixed(2)}): hot free O₂ on copper.`);
  if (inp.of < CEA_OF[0] || inp.of > CEA_OF[CEA_OF.length - 1]) warnings.push('O/F is outside the combustion table; values are clamped to its edge.');
  const em = energyMargin(inp.mdotTotal_gs, inp.cstarEff);
  if (em < ENERGY.target) warnings.push(`Energy margin ${em.toFixed(2)} is below the ${ENERGY.target} target.`);
  return {
    mdotOx_gs: mOx * 1000, mdotF_gs: mF * 1000,
    throatDia_mm: throatDia, throatDrill: nearestDrill(throatDia),
    goxHoleDia_mm: goxDia, goxDrill: nearestDrill(goxDia),
    ch4HoleDia_mm: ch4Dia, ch4Drill: nearestDrill(ch4Dia),
    goxChokeMargin: inp.goxHolePsia / inp.pcPsia / goxCrit,
    ch4ChokeMargin: inp.ch4HolePsia / inp.pcPsia / ch4Crit,
    tcK: c.tcK, cstarIdeal: c.cstar, energyMargin: em, warnings,
  };
}

/** Tc and c* across the table's O/F range at one chamber pressure. */
export function ofSweep(pcPsia: number, cstarEff: number): { of: number; tcK: number; cstar: number; cstarEff: number }[] {
  return CEA_OF.map((of) => {
    const c = combustion(of, pcPsia * PA_PER_PSI);
    return { of, tcK: c.tcK, cstar: c.cstar, cstarEff: c.cstar * cstarEff };
  });
}
