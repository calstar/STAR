import { describe, it, expect } from 'vitest';
import {
  computeCdAIntegral,
  computeCdAIncompressible,
  upstreamSlopePsiPerSec,
  buildValvePlan,
  referenceValve,
  plannedHoldMs,
  valvePlanProblem,
  valvePlanSummary,
  type PressureSample,
  type FlowValve,
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

// ── Per-run valve plans ───────────────────────────────────────────────────────────────────────

describe('valve plans', () => {
  // A stand whose flow column opens both mains, with the ox main staggered half a second behind
  // the fuel main and nothing lingering in the return state.
  const VALVES: FlowValve[] = [
    { role: 'Ox Main', delayMs: 500, closeDelayMs: 0 },
    { role: 'Fuel Main', delayMs: 0, closeDelayMs: 0 },
  ];
  const GATE = 'Ox Main';

  it('sends nothing when the operator has changed nothing', () => {
    // The whole opt-in property: an untouched card has to produce the frame this page sent before
    // plans existed, which is the one with no VALVES field at all.
    expect(buildValvePlan(VALVES, {})).toEqual({});
    expect(plannedHoldMs(1000, VALVES, {}, GATE)).toBe(1500);
  });

  it('cancelling a configured stagger is a real override, and shortens the hold', () => {
    // "Make both mains open together": the ox main's 500 ms becomes 0. The hold must follow —
    // reading the stagger from config here would hold the valves open half a second too long.
    const settings = { 'Ox Main': { shut: false, delayMs: 0 } };
    expect(buildValvePlan(VALVES, settings)).toEqual({ 'Ox Main': { delayMs: 0 } });
    expect(plannedHoldMs(1000, VALVES, settings, GATE)).toBe(1000);
    expect(valvePlanProblem(1000, VALVES, settings, GATE)).toBeNull();
  });

  it('a 0 that matches the config is not an override', () => {
    expect(buildValvePlan(VALVES, { 'Fuel Main': { shut: false, delayMs: 0 } })).toEqual({});
  });

  it('introducing a stagger lengthens the hold by it, so the gate is open as long as asked', () => {
    const settings = { 'Ox Main': { shut: false, delayMs: 250 } };
    expect(buildValvePlan(VALVES, settings)).toEqual({ 'Ox Main': { delayMs: 250 } });
    expect(plannedHoldMs(1000, VALVES, settings, GATE)).toBe(1250);
  });

  it('holding the gate shut moves the window to the valve that does open', () => {
    // Characterizing the fuel side alone. A window still measured on the shut gate would hold the
    // state 1500 ms for a 1000 ms request, with the fuel main open for all of it.
    const settings = { 'Ox Main': { shut: true, delayMs: 500 } };
    expect(buildValvePlan(VALVES, settings)).toEqual({ 'Ox Main': { shut: true } });
    expect(referenceValve(VALVES, settings, GATE)).toBe('Fuel Main');
    expect(plannedHoldMs(1000, VALVES, settings, GATE)).toBe(1000);
    expect(valvePlanSummary(1000, VALVES, settings, GATE)).toContain('Ox Main held shut');
  });

  it('a stagger in the return state shortens the hold by the same amount', () => {
    // The valve does not close at the expiry transition; it closes 300 ms after it.
    const lingering: FlowValve[] = [
      { role: 'Ox Main', delayMs: 500, closeDelayMs: 300 },
      { role: 'Fuel Main', delayMs: 0, closeDelayMs: 0 },
    ];
    expect(plannedHoldMs(1000, lingering, {}, GATE)).toBe(1200);
  });

  it('refuses a plan with nothing flowing, and one whose valve opens after the window', () => {
    const allShut = {
      'Ox Main': { shut: true, delayMs: 0 },
      'Fuel Main': { shut: true, delayMs: 0 },
    };
    expect(valvePlanProblem(1000, VALVES, allShut, GATE)).toMatch(/held shut/);
    expect(referenceValve(VALVES, allShut, GATE)).toBeNull();

    // The gate opens at +0 so the window is 1000 ms; the fuel main asked for +1000 never opens.
    const late = {
      'Ox Main': { shut: false, delayMs: 0 },
      'Fuel Main': { shut: false, delayMs: 1000 },
    };
    expect(valvePlanProblem(1000, VALVES, late, GATE)).toMatch(/Fuel Main/);
    // The same numbers inside a longer window are fine — the refusal is about the window.
    expect(valvePlanProblem(2000, VALVES, late, GATE)).toBeNull();
  });

  it('a stand with no gate configured keeps the state-timed window it always had', () => {
    expect(referenceValve(VALVES, {}, null)).toBeNull();
    expect(plannedHoldMs(1000, VALVES, { 'Ox Main': { shut: false, delayMs: 300 } }, null)).toBe(1000);
  });

  it('says nothing at all when the CSVs named no valves', () => {
    expect(buildValvePlan([], {})).toEqual({});
    expect(valvePlanProblem(1000, [], {}, GATE)).toBeNull();
    expect(valvePlanSummary(1000, [], {}, GATE)).toBeNull();
  });

  it('names the valve the duration is measured on in the run record', () => {
    const summary = valvePlanSummary(1000, VALVES, {}, GATE);
    expect(summary).toContain('Ox Main +500 ms');
    expect(summary).toContain('window on Ox Main');
    expect(summary).toContain('held 1500 ms');
  });
});
