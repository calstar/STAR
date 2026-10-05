import { describe, expect, it } from 'vitest';
import { plumeArt } from './plumeGeom';

const state = (pe: number) => ({ pc_psia: 380, pe_psia: pe, pa_psia: 13.6, gamma: 1.2 });

describe('the plume\'s shock cells', () => {
  it('stand even in a jet within a few percent of ambient, and do not switch on at a band', () => {
    // 13.7 vs 13.6 psia: the LE4 burn's opening, inside the old ±3 % "ideal" band that drew none
    // and made the diamonds appear from nowhere half way through the burn.
    const near = plumeArt(state(13.7), 6)!;
    expect(near.diamonds.length).toBeGreaterThan(0);
    const off = plumeArt(state(15.2), 6)!;
    expect(off.diamonds.length).toBeGreaterThan(0);
  });

  it('stand stronger the further the exit is from ambient', () => {
    const a = plumeArt(state(13.7), 6)!.strength;
    const b = plumeArt(state(15.2), 6)!.strength;
    const c = plumeArt(state(22), 6)!.strength;
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(a).toBeGreaterThanOrEqual(0.3);
    expect(c).toBeLessThanOrEqual(1);
  });
});
