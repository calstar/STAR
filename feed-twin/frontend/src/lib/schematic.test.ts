import { describe, expect, it } from 'vitest';
import { dashPeriod, isFlowing } from './schematic';

describe('flow animation', () => {
  it('does not animate a line that is not really flowing', () => {
    // A dash creeping along a shut line reads as flow, and on a schematic that
    // is a lie somebody acts on.
    expect(isFlowing(0)).toBe(false);
    expect(isFlowing(1e-6)).toBe(false);
    expect(isFlowing(0.5)).toBe(true);
  });

  it('animates reverse flow too', () => {
    expect(isFlowing(-0.5)).toBe(true);
  });

  it('clamps the dash speed at both ends', () => {
    expect(dashPeriod(1e-9)).toBeLessThanOrEqual(2.0);
    expect(dashPeriod(1e9)).toBeGreaterThanOrEqual(0.25);
    // And is monotone in between: more flow is never a slower dash.
    expect(dashPeriod(2.0)).toBeLessThan(dashPeriod(0.2));
  });
});
