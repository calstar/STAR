/**
 * ASI system-test evaluations: pure functions over readings the ASI Test tab
 * captures, so each pass/fail rule is testable and stated in one place.
 */

import { GCH4, GOX, OF_FLAMMABLE, PA_PER_PSI, P_ATM, orificeMassFlow } from './physics';
import { holeCdA_mm2, type AsiModel, type LineId } from './settings';

export type Verdict = 'pass' | 'fail' | 'warn';

/** A PT at ambient should read ~0 psig. */
export function zeroCheck(psig: number | null, tolPsig: number): { verdict: Verdict; offset: number | null } {
  if (psig === null || !Number.isFinite(psig)) return { verdict: 'fail', offset: null };
  return { verdict: Math.abs(psig) <= tolPsig ? 'pass' : 'fail', offset: psig };
}

/** An ASI TC at rest should read near the room. */
export function tcAmbientCheck(c: number | null, ambientC: number, tolC: number): { verdict: Verdict; offset: number | null } {
  if (c === null || !Number.isFinite(c)) return { verdict: 'fail', offset: null };
  return { verdict: Math.abs(c - ambientC) <= tolC ? 'pass' : 'fail', offset: c - ambientC };
}

/**
 * Pressure-decay leak check on a locked-up volume. A pass is a decay slower than
 * `maxPsiPerMin`. A RISE is reported as a warning: on a regulated line it means
 * the regulator is creeping (or the run valve is leaking into a trapped volume).
 */
export function leakDecay(startPsig: number, endPsig: number, durationS: number, maxPsiPerMin: number):
  { ratePsiPerMin: number; verdict: Verdict } {
  if (durationS <= 0) return { ratePsiPerMin: NaN, verdict: 'fail' };
  const rate = ((startPsig - endPsig) / durationS) * 60;
  if (rate < -maxPsiPerMin) return { ratePsiPerMin: rate, verdict: 'warn' };
  return { ratePsiPerMin: rate, verdict: rate <= maxPsiPerMin ? 'pass' : 'fail' };
}

export interface Sample { t: number; v: number }

/**
 * Valve response from a pressure trace: time from the command to the trace
 * covering `frac` of its total change (rise on open, fall on close). Null when
 * the trace never moved by `minChange`.
 */
export function valveResponse(samples: Sample[], tCmd: number, frac = 0.9, minChange = 5): { ms: number | null; from: number; to: number } {
  const after = samples.filter((s) => s.t >= tCmd);
  const before = samples.filter((s) => s.t <= tCmd);
  if (!after.length) return { ms: null, from: NaN, to: NaN };
  const from = before.length ? before[before.length - 1].v : after[0].v;
  const tail = after.slice(-Math.max(1, Math.floor(after.length / 5)));
  const to = tail.reduce((a, s) => a + s.v, 0) / tail.length;
  const change = to - from;
  if (Math.abs(change) < minChange) return { ms: null, from, to };
  const target = from + frac * change;
  const hit = after.find((s) => (change > 0 ? s.v >= target : s.v <= target));
  return { ms: hit ? (hit.t - tCmd) * 1000 : null, from, to };
}

/** Relief crack pressure against its set point. */
export function reliefCrack(measuredPsig: number, setPsig: number, tolPct: number): { errorPct: number; verdict: Verdict } {
  const errorPct = ((measuredPsig - setPsig) / setPsig) * 100;
  return { errorPct, verdict: Math.abs(errorPct) <= tolPct ? 'pass' : 'fail' };
}

/** Live margin to a relief: ok below 90 % of set, warn up to set, over beyond. */
export function reliefMargin(psig: number | null, setPsig: number): { frac: number; status: 'ok' | 'warn' | 'over' | 'none' } {
  if (psig === null || !Number.isFinite(psig) || setPsig <= 0) return { frac: 0, status: 'none' };
  const frac = psig / setPsig;
  return { frac, status: frac > 1 ? 'over' : frac >= 0.9 ? 'warn' : 'ok' };
}

/**
 * What the downstream PTs say about flow, as the design point uses them
 * ("hole P0 -> mdot, O/F"): choked hole flow at the measured P0, assuming the
 * chamber is low enough for the holes to choke.
 */
export function holeFlowFromPt(model: AsiModel, id: LineId, dnPsig: number | null): number | null {
  if (dnPsig === null || !Number.isFinite(dnPsig)) return null;
  const l = model[id];
  const p0 = dnPsig * PA_PER_PSI + P_ATM;
  const pc = model.backPressurePsia * PA_PER_PSI;
  return Math.max(0, orificeMassFlow(holeCdA_mm2(l) * 1e-6, p0, l.gasTempK, pc, id === 'gox' ? GOX : GCH4)) * 1000;
}

/** O/F implied by the two downstream PTs, and whether it can light. */
export function ofFromPts(model: AsiModel, goxDnPsig: number | null, ch4DnPsig: number | null):
  { mdotOx_gs: number | null; mdotF_gs: number | null; of: number | null; lightable: boolean } {
  const ox = holeFlowFromPt(model, 'gox', goxDnPsig);
  const f = holeFlowFromPt(model, 'ch4', ch4DnPsig);
  const of = ox !== null && f !== null && f > 0.05 ? ox / f : null;
  return { mdotOx_gs: ox, mdotF_gs: f, of, lightable: of !== null && of >= OF_FLAMMABLE.min && of <= model.ofMax };
}
