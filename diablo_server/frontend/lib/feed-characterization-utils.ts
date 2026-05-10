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
