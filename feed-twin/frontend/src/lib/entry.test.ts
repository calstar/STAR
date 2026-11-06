import { describe, expect, it } from 'vitest';
import { rowCommit, settled } from './entry';

// The cart's fields on the GSE tab, with their bounds from backend/tunables.py.
const fuelLoad = { unit: 's', low: 1, high: 3600, step: 5 };
const dewarCv = { unit: 'Cv', low: 0, high: 1, step: 0.001 };

describe("the cart's fields commit what is typed, not each keystroke's leftovers", () => {
  it('an emptied box commits nothing (it sent 0 to the running fill)', () => {
    expect(rowCommit('', fuelLoad, 15)).toBeNull();
    expect(rowCommit('', dewarCv, 0.019)).toBeNull();
  });
  it('a number under the floor is the floor, as the stand would run it', () => {
    expect(rowCommit('0', fuelLoad, 15)).toBe(1);
    expect(rowCommit('30', fuelLoad, 15)).toBe(30);
  });
});

describe('what the stand says it runs on is what shows', () => {
  it('a fill time it clamped reads as clamped', () => {
    expect(settled<Record<string, number>>({ fuel_fill_s: 0 }, { fuel_fill_s: 1, dome: 535 })).toEqual({ fuel_fill_s: 1 });
  });
  it('only what was sent, and nothing when the stand did not answer', () => {
    expect(settled<Record<string, number>>({ fuel_fill_s: 30 }, { dome: 535 })).toEqual({});
    expect(settled<Record<string, number>>({ fuel_fill_s: 30 }, null)).toEqual({});
  });
});
