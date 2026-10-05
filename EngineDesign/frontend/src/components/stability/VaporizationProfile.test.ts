import { describe, it, expect } from 'vitest';
import { remainingRows } from './VaporizationProfile';

type S = Parameters<typeof remainingRows>[0][number];
const stream = (k: string, over: Partial<S>): S => ({
  stream: k, fluid: k, phase: 'liquid', smd_um: 100, tau_conv_s: 0.01, L_vap_m: 0.1, L_ch_m: 0.2,
  vaporized_in_chamber: true, d2_profile: [], ...over,
} as S);

describe('vaporization card curves', () => {
  it('draw the march profile when the result has one, on one x grid in mm', () => {
    const rows = remainingRows([
      stream('O', { remaining_profile: [[0, 1], [0.05, 0.2], [0.2, 0]] }),
      stream('F', { remaining_profile: [[0, 1], [0.1, 0.5], [0.2, 0.03]] }),
    ]);
    expect(rows.map((r) => r.x_m)).toEqual([0, 50, 100, 200]);
    expect(rows[1].m_F).toBeCloseTo(0.75, 12);        // interpolated onto O's station
    expect(rows[3].m_F).toBeCloseTo(0.03, 12);
  });

  it('fall back to a d²-law mass curve only when there is no march', () => {
    const rows = remainingRows([stream('O', { L_vap_m: 0.1, d2_profile: [[0, 1], [0.2, 0]] })]);
    expect(rows[0].m_O).toBe(1);
    expect(rows[rows.length - 1].m_O).toBe(0);
  });
});
