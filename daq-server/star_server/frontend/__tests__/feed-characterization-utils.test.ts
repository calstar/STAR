import { describe, it, expect } from 'vitest';
import {
  computeCdAIntegral,
  computeCdAIncompressible,
  upstreamSlopePsiPerSec,
  type PressureSample,
} from '@/lib/feed-characterization-utils';

const PSI_TO_PA = 6894.76;
const RHO = 1000; // water

/** A window of samples at `dt` with ΔP walking linearly from `dp0` to `dp1` (psi, gauge). */
function ramp(dp0: number, dp1: number, seconds: number, dt = 0.025): PressureSample[] {
  const out: PressureSample[] = [];
  const n = Math.round(seconds / dt);
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    out.push({ tSec: i * dt, upPsi: dp0 + (dp1 - dp0) * f, downPsi: 0 });
  }
  return out;
}

/** Mass that a given CdA would actually pass over the window — the forward direction. */
function massFor(cda: number, samples: PressureSample[]): number {
  let m = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i]!.tSec - samples[i - 1]!.tSec;
    const a = Math.sqrt(2 * RHO * (samples[i - 1]!.upPsi! - samples[i - 1]!.downPsi!) * PSI_TO_PA);
    const b = Math.sqrt(2 * RHO * (samples[i]!.upPsi! - samples[i]!.downPsi!) * PSI_TO_PA);
    m += cda * 0.5 * (a + b) * dt;
  }
  return m;
}

describe('computeCdAIntegral', () => {
  it('recovers the CdA that produced the mass, on a constant ΔP', () => {
    const s = ramp(400, 400, 1.0);
    const trueCda = 3.2e-5;
    const r = computeCdAIntegral({ totalMassKg: massFor(trueCda, s), samples: s, densityKgM3: RHO });
    expect(r).not.toBeNull();
    expect(r!.cdaM2).toBeCloseTo(trueCda, 12);
  });

  it('recovers it on a decaying ΔP too — the blowdown case', () => {
    // GN2 ullage expanding over the pull: ΔP falls through the window. This is where averaging
    // first and rooting after goes wrong, and integrating does not.
    const s = ramp(400, 150, 1.0);
    const trueCda = 3.2e-5;
    const r = computeCdAIntegral({ totalMassKg: massFor(trueCda, s), samples: s, densityKgM3: RHO });
    expect(r!.cdaM2).toBeCloseTo(trueCda, 12);
  });

  it('is the fix for the mean-then-root bias, and the old form reads low', () => {
    const s = ramp(400, 150, 1.0);
    const trueCda = 3.2e-5;
    const mass = massFor(trueCda, s);

    const integral = computeCdAIntegral({ totalMassKg: mass, samples: s, densityKgM3: RHO })!;
    const averaged = computeCdAIncompressible({
      totalMassKg: mass,
      flowTimeSec: integral.flowTimeSec,
      avgDeltaPsi: integral.avgDeltaPsi,
      densityKgM3: RHO,
    })!;

    // Jensen: √(mean ΔP) ≥ mean(√ΔP), so dividing by the larger root understates CdA.
    expect(averaged.cdaM2).toBeLessThan(integral.cdaM2);
    expect(integral.cdaM2).toBeCloseTo(trueCda, 12);
    // Small, but real and one-directional — it never averages out across runs.
    const errPct = (1 - averaged.cdaM2 / trueCda) * 100;
    expect(errPct).toBeGreaterThan(0);
    expect(errPct).toBeLessThan(5);
  });

  it('ignores samples with no flow rather than counting them as window time', () => {
    const flowing = ramp(400, 400, 1.0);
    const withDeadTail: PressureSample[] = [
      ...flowing,
      // valve shut: downstream above upstream, i.e. ΔP ≤ 0 — no flow through the orifice
      { tSec: 1.1, upPsi: 0, downPsi: 5 },
      { tSec: 1.2, upPsi: 0, downPsi: 5 },
    ];
    const a = computeCdAIntegral({ totalMassKg: 1, samples: flowing, densityKgM3: RHO })!;
    const b = computeCdAIntegral({ totalMassKg: 1, samples: withDeadTail, densityKgM3: RHO })!;
    expect(b.cdaM2).toBeCloseTo(a.cdaM2, 12);
  });

  it('handles an irregular sample interval', () => {
    const even = ramp(300, 200, 1.0, 0.01);
    const trueCda = 1.1e-5;
    const mass = massFor(trueCda, even);
    // Drop every third interior sample: same curve, same span, ragged dt. The endpoints must be
    // kept — dropping the last one shortens the window, which is a different test entirely.
    const ragged = even.filter((_, i) => i === 0 || i === even.length - 1 || i % 3 !== 1);
    const r = computeCdAIntegral({ totalMassKg: mass, samples: ragged, densityKgM3: RHO })!;
    expect(r.cdaM2).toBeCloseTo(trueCda, 8);
  });

  it('returns null when there is nothing to integrate', () => {
    expect(computeCdAIntegral({ totalMassKg: 1, samples: [], densityKgM3: RHO })).toBeNull();
    expect(
      computeCdAIntegral({
        totalMassKg: 1,
        samples: [{ tSec: 0, upPsi: null, downPsi: null }],
        densityKgM3: RHO,
      }),
    ).toBeNull();
    expect(computeCdAIntegral({ totalMassKg: 0, samples: ramp(400, 400, 1), densityKgM3: RHO })).toBeNull();
  });
});

describe('upstreamSlopePsiPerSec', () => {
  const mk = (pts: [number, number][]) =>
    pts.map(([t, p]) => ({ tSec: t, upPsi: p, downPsi: 0 }));

  it('measures a steady decay — the blowdown signature', () => {
    // 400 -> 250 psi over 1 s = -150 PSI/s
    const s = mk(Array.from({ length: 41 }, (_, i) => [i * 0.025, 400 - 150 * i * 0.025]));
    expect(upstreamSlopePsiPerSec(s, s.length - 1, 0.3)).toBeCloseTo(-150, 6);
  });

  it('reads ~0 once the valves shut and pressure just sits there', () => {
    // The case the level test could never catch: pressure stays DOWN, it does not recover.
    const s = mk(Array.from({ length: 41 }, (_, i) => [i * 0.025, 250]));
    expect(Math.abs(upstreamSlopePsiPerSec(s, s.length - 1, 0.3))).toBeLessThan(1e-9);
  });

  it('is not fooled by noise the way a two-point difference is', () => {
    // Flat at 250 with ±2 psi of alternating noise. Consecutive samples imply ±160 PSI/s;
    // the fit over the span should stay near zero.
    const s = mk(Array.from({ length: 41 }, (_, i) => [i * 0.025, 250 + (i % 2 ? 2 : -2)]));
    expect(Math.abs(upstreamSlopePsiPerSec(s, s.length - 1, 0.3))).toBeLessThan(20);
  });

  it('crosses the 15% stop threshold between flowing and shut', () => {
    const flowing = mk(Array.from({ length: 41 }, (_, i) => [i * 0.025, 400 - 150 * i * 0.025]));
    const shut = mk(Array.from({ length: 41 }, (_, i) => [i * 0.025, 250]));
    const flowingSlope = upstreamSlopePsiPerSec(flowing, flowing.length - 1, 0.3);
    const shutSlope = upstreamSlopePsiPerSec(shut, shut.length - 1, 0.15);
    expect(Math.abs(flowingSlope) * 0.15).toBeGreaterThan(Math.abs(shutSlope));
    expect(Math.abs(flowingSlope)).toBeGreaterThan(Math.abs(flowingSlope) * 0.15);
  });

  it('returns NaN when the span has too few points to fit', () => {
    expect(Number.isNaN(upstreamSlopePsiPerSec(mk([[0, 400], [0.025, 399]]), 1, 0.3))).toBe(true);
    expect(Number.isNaN(upstreamSlopePsiPerSec([], 0))).toBe(true);
  });
});
