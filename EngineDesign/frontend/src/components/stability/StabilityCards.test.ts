import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhaseClock, driveShare } from './PhaseClock';
import { StabilityRadar } from './StabilityRadar';
import type { StabilityRichPayload } from './types';
import payload from '../__fixtures__/stability_rich_6500N.json';

/** engine/pipeline/stability/report.py for the 6.5 kN doublet fixture config. */
const P = payload as unknown as StabilityRichPayload;

describe('phase clock', () => {
  it('reads the driving law the budget uses: (1 - cos wt)/2, not sin(wt)', () => {
    expect(driveShare({ omega_tau: Math.PI })).toBeCloseTo(1, 12);
    expect(driveShare({ omega_tau: 2 * Math.PI })).toBeCloseTo(0, 12);
    expect(driveShare({ omega_tau: 1.5 * Math.PI })).toBeCloseTo(0.5, 12);   // sin < 0, still driving
    for (const p of P.phase) {
      const m = P.acoustic.modes.find((x) => x.name === p.mode)!;
      expect(driveShare(p)).toBeCloseTo(m.driving / m.driving_max!, 9);
    }
  });

  it('never calls a growing mode "damping"', () => {
    const html = renderToStaticMarkup(createElement(PhaseClock, { data: P }));
    expect(html).not.toMatch(/>damping</);
    expect(html).toContain('Report only');
    expect(html).toContain('τ_conv');
  });
});

describe('stability radar', () => {
  const html = renderToStaticMarkup(createElement(StabilityRadar, { data: P }));
  it('grades only chug; acoustic and vaporization are reported, not passed or failed', () => {
    expect((html.match(/>report only</g) ?? []).length).toBe(3);
    expect(html).toMatch(/Chug<\/td>.*?(pass|tight)/s);
  });
});
