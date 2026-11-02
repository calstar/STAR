import { describe, expect, it } from 'vitest';
import { vehiclePage } from './vehiclePage';

const node = (page: string, componentType = 'TANK') => ({ data: { page, componentType } });

describe('the Feed system card shows the vehicle', () => {
  it('picks the page holding the engine, not the page holding most symbols', () => {
    // LE4: 91 symbols on the GSE page, 35 on the Rocket page, the engine on the Rocket's.
    const nodes = [...Array.from({ length: 91 }, () => node('GSE')), ...Array.from({ length: 34 }, () => node('Rocket')), node('Rocket', 'ENGINE')];
    expect(vehiclePage(nodes)).toBe('Rocket');
  });
  it('falls back to the fullest page when no engine is drawn', () => {
    expect(vehiclePage([node('A'), node('B'), node('B')])).toBe('B');
  });
});
