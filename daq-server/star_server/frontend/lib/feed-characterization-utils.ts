/**
 * Feed / orifice characterization helpers (incompressible discharge model).
 */

export interface PressureSample {
  tSec: number;
  upPsi: number | null;
  downPsi: number | null;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function sampleStdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const v = values.reduce((acc, x) => acc + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

export function coefficientOfVariationPercent(values: number[]): number {
  const m = mean(values);
  if (!Number.isFinite(m) || Math.abs(m) < 1e-9) return 0;
  return (sampleStdev(values) / Math.abs(m)) * 100;
}

/** First index where down stays ≥ baseline + threshold for `hold` consecutive samples. */
export function detectDownstreamSpikeIndex(
  downSeries: (number | null)[],
  baselinePsi: number,
  thresholdPsi: number,
  hold = 2,
): number {
  let run = 0;
  for (let i = 0; i < downSeries.length; i++) {
    const d = downSeries[i];
    if (d == null || !Number.isFinite(d)) {
      run = 0;
      continue;
    }
    if (d >= baselinePsi + thresholdPsi) {
      run++;
      if (run >= hold) return i - hold + 1;
    } else run = 0;
  }
  return -1;
}

/** dP/dt (psi/s) using simple backward difference. */
export function downstreamSlopePsiPerS(samples: PressureSample[], i: number): number {
  if (i < 1) return 0;
  const a = samples[i - 1]!;
  const b = samples[i]!;
  const dt = b.tSec - a.tSec;
  if (dt < 1e-6) return 0;
  const da = a.downPsi;
  const db = b.downPsi;
  if (da == null || db == null) return 0;
  return (db - da) / dt;
}

export interface CdAComputeInput {
  totalMassKg: number;
  flowTimeSec: number;
  avgDeltaPsi: number;
  densityKgM3: number;
}

export interface CdAComputeResult {
  mdotKgS: number;
  deltaPPa: number;
  cdaM2: number;
  /** Valid incompressible orifice assumption: ΔP / P_abs ≪ 1 */
  incompressibleNote: string;
}

const PSI_TO_PA = 6894.76;

export function computeCdAIncompressible(inp: CdAComputeInput): CdAComputeResult | null {
  const { totalMassKg, flowTimeSec, avgDeltaPsi, densityKgM3 } = inp;
  if (!(flowTimeSec > 0) || !(totalMassKg > 0) || !(densityKgM3 > 0)) return null;
  const deltaPPa = avgDeltaPsi * PSI_TO_PA;
  if (!(deltaPPa > 0)) return null;
  const mdotKgS = totalMassKg / flowTimeSec;
  const cdaM2 = mdotKgS / Math.sqrt(2 * densityKgM3 * deltaPPa);
  return {
    mdotKgS,
    deltaPPa,
    cdaM2,
    incompressibleNote:
      'Uses ṁ = CdA√(2ρΔP) (liquid-like / low Mach). For large ΔP/P_upstream, use compressible nozzle relations.',
  };
}

/**
 * Reynolds number for a circular passage from mass flow: Re = 4ṁ/(πDμ).
 *
 * `diameterM` decides WHICH Reynolds number this is, and the caller has to mean one: the
 * orifice/throat diameter gives orifice Reynolds — the one Cd correlates against, and so the one
 * worth plotting CdA against — while the line ID gives line Reynolds. The maths is identical; only
 * the physical claim differs. Named "pipe" historically; it is not restricted to a pipe.
 */
export function reynoldsPipe(mdotKgS: number, diameterM: number, viscosityPas: number): number {
  if (!(diameterM > 0) || !(viscosityPas > 0)) return NaN;
  return (4 * mdotKgS) / (Math.PI * diameterM * viscosityPas);
}

/** Slice samples to [tStart, tEnd] inclusive on tSec. */
export function sliceSamplesByTime(samples: PressureSample[], tStart: number, tEnd: number): PressureSample[] {
  return samples.filter((s) => s.tSec >= tStart && s.tSec <= tEnd);
}

export function averagePressures(samples: PressureSample[]): { avgUp: number; avgDown: number; n: number } {
  let su = 0;
  let sd = 0;
  let nu = 0;
  let nd = 0;
  for (const s of samples) {
    if (s.upPsi != null && Number.isFinite(s.upPsi)) {
      su += s.upPsi;
      nu++;
    }
    if (s.downPsi != null && Number.isFinite(s.downPsi)) {
      sd += s.downPsi;
      nd++;
    }
  }
  return {
    avgUp: nu ? su / nu : NaN,
    avgDown: nd ? sd / nd : NaN,
    n: Math.min(nu, nd),
  };
}

export function deltaPSeries(samples: PressureSample[]): number[] {
  const out: number[] = [];
  for (const s of samples) {
    if (s.upPsi != null && s.downPsi != null && Number.isFinite(s.upPsi) && Number.isFinite(s.downPsi)) {
      out.push(s.upPsi - s.downPsi);
    }
  }
  return out;
}

export interface CdAIntegralInput {
  totalMassKg: number;
  /** The flow window, in time order. Samples with a non-positive or unreadable ΔP are skipped. */
  samples: PressureSample[];
  densityKgM3: number;
}

export interface CdAIntegralResult {
  cdaM2: number;
  /** Average mass flow over the window — reported for reference; CdA does NOT route through it. */
  mdotKgS: number;
  /** Window duration, from the first usable sample to the last. */
  flowTimeSec: number;
  avgDeltaPsi: number;
  /** ∫√(ΔP) dt over the window, in √Pa·s. The quantity the mass is actually divided by. */
  integralSqrtDpSi: number;
  usedSamples: number;
}

/**
 * CdA from a mass and a pressure trace, by integration.
 *
 * The orifice relation is instantaneous — ṁ(t) = CdA·√(2ρ·ΔP(t)) — so the mass that actually
 * passed is its integral:
 *
 *     m = CdA·√(2ρ) · ∫√(ΔP(t)) dt      ⟹      CdA = m / (√(2ρ) · ∫√(ΔP) dt)
 *
 * The previous form averaged ΔP first and then took the root, i.e. it used √(mean ΔP) where the
 * physics wants mean(√ΔP). Those are equal only when ΔP is constant; by Jensen the averaged form
 * reads low by roughly CV²/8. That is small for a stiff feed (well under 1% at 25% swing) but it
 * is not zero, and on a blowdown — where the ullage expands and ΔP decays all the way through the
 * window — it is exactly the case the approximation is worst for. Integrating costs nothing extra:
 * the samples are already collected.
 *
 * Trapezoidal over the real sample timestamps, so an irregular sample interval is handled
 * correctly rather than assumed uniform.
 *
 * @returns null if there is nothing usable to integrate.
 */
export function computeCdAIntegral(inp: CdAIntegralInput): CdAIntegralResult | null {
  const { totalMassKg, samples, densityKgM3 } = inp;
  if (!(totalMassKg > 0) || !(densityKgM3 > 0)) return null;

  // (t, √ΔP) pairs. A non-positive ΔP means no flow that way; including it would add area under
  // the curve for time the fluid was not moving.
  const pts: { t: number; rootDp: number; dpPsi: number }[] = [];
  for (const s of samples) {
    if (s.upPsi == null || s.downPsi == null) continue;
    if (!Number.isFinite(s.upPsi) || !Number.isFinite(s.downPsi) || !Number.isFinite(s.tSec)) continue;
    const dpPsi = s.upPsi - s.downPsi;
    if (!(dpPsi > 0)) continue;
    pts.push({ t: s.tSec, rootDp: Math.sqrt(dpPsi * PSI_TO_PA), dpPsi });
  }
  if (pts.length < 2) return null;

  let integral = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i]!.t - pts[i - 1]!.t;
    if (!(dt > 0)) continue;  // duplicate or out-of-order timestamps contribute nothing
    integral += 0.5 * (pts[i]!.rootDp + pts[i - 1]!.rootDp) * dt;
  }
  if (!(integral > 0)) return null;

  const flowTimeSec = pts[pts.length - 1]!.t - pts[0]!.t;
  const cdaM2 = totalMassKg / (Math.sqrt(2 * densityKgM3) * integral);

  return {
    cdaM2,
    mdotKgS: flowTimeSec > 0 ? totalMassKg / flowTimeSec : NaN,
    flowTimeSec,
    avgDeltaPsi: mean(pts.map((p) => p.dpPsi)),
    integralSqrtDpSi: integral,
    usedSamples: pts.length,
  };
}

/**
 * Least-squares slope of the upstream pressure over a trailing window, in PSI/s.
 *
 * A two-point difference on a noisy PT is useless — the noise dominates dt at 25 ms spacing. Fitting
 * a line over a short span averages that out while still responding quickly.
 *
 * @param samples ordered by tSec
 * @param endIdx  last sample to include
 * @param spanSec how far back to fit over
 * @returns NaN if there are fewer than 3 usable points in the span.
 */
export function upstreamSlopePsiPerSec(
  samples: PressureSample[],
  endIdx: number,
  spanSec = 0.15,
): number {
  if (endIdx < 0 || endIdx >= samples.length) return NaN;
  const tEnd = samples[endIdx]!.tSec;
  const pts: { t: number; p: number }[] = [];
  for (let i = endIdx; i >= 0; i--) {
    const s = samples[i]!;
    if (tEnd - s.tSec > spanSec) break;
    if (s.upPsi != null && Number.isFinite(s.upPsi) && Number.isFinite(s.tSec)) {
      pts.push({ t: s.tSec, p: s.upPsi });
    }
  }
  if (pts.length < 3) return NaN;

  const n = pts.length;
  const meanT = pts.reduce((a, x) => a + x.t, 0) / n;
  const meanP = pts.reduce((a, x) => a + x.p, 0) / n;
  let num = 0;
  let den = 0;
  for (const x of pts) {
    const dt = x.t - meanT;
    num += dt * (x.p - meanP);
    den += dt * dt;
  }
  if (!(den > 0)) return NaN;
  return num / den;
}

