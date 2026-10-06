import { describe, expect, it } from 'vitest';
import type { ChamberGeometryResponse } from '../../../api/client';
import type { LayerXResult } from '../../../api/layerx';
import {
  chamberRecessionAt, geometryIsRuns, runThroatMm, sectionFromContour, sectionFromGeometry, thinIndices, throatAreaRatioAt,
  wallFromFrames, wallFromGrowth, type Section,
  framesAgree,
} from './contour';
import { plumeArt, plumeLengthDe, PLUME_MAX_DE, PLUME_MIN_DE, separationAreaRatio, stationAtRadius } from './plumeGeom';

/** A conical engine in metres, throat at x = 0: barrel r 40 mm, throat 20 mm, exit 40 mm. */
function geometry(over: Partial<ChamberGeometryResponse> = {}): ChamberGeometryResponse {
  const cx: number[] = [];
  const cy: number[] = [];
  for (let k = 0; k <= 200; k++) {
    const x = -0.15 + (0.25 * k) / 200; // -150 .. 100 mm
    cx.push(x);
    cy.push(x < -0.05 ? 0.04 : x < 0 ? 0.02 + (0.02 * -x) / 0.05 : 0.02 + (0.02 * x) / 0.1);
  }
  const positions = cx.map((x) => x + 0.15);
  return {
    positions, R_gas: cy, R_ablative_outer: cy.map((r) => r + 0.008), R_graphite_outer: cy.map((r, i) => (Math.abs(cx[i]) < 0.02 ? r + 0.006 : r)),
    R_stainless: cy.map(() => 0.051), throat_position: 0.15, graphite_start: 0.13, graphite_end: 0.17,
    D_chamber: 0.08, D_throat: 0.04, D_exit: 0.08, L_chamber: 0.15, L_nozzle: 0.1, expansion_ratio: 4,
    ablative_enabled: true, graphite_enabled: true, nozzle_x: [], nozzle_y: [], nozzle_method: 'cone',
    chamber_contour_x: cx, chamber_contour_y: cy, Cf: null, Cf_ideal: null, A_throat_solved: null, chamber_contour_method: 'solved',
    t_abl_opt_mm: null, t_gra_opt_mm: null, ...over,
  };
}

const run = (over: Record<string, unknown> = {}) => ({
  series: { t: [0, 1, 2] },
  replay: { A_throat_m2: [Math.PI * 0.02 ** 2], t: [0.1, 1, 2], recession_chamber_mm: [0, 0.4, 0.8] },
  delivered: { t: [0.1, 1, 2], throat_area_ratio: [1, 1.1, 1.21], eps: [3.9, 3.8, 3.7] },
  ...over,
}) as unknown as LayerXResult;

describe('sectionFromGeometry', () => {
  const s = sectionFromGeometry(geometry()) as Section;

  it('reads the solved contour in mm, throat narrowest, case and liner behind it', () => {
    expect(s.source).toBe('design');
    expect(s.r0[s.throat]).toBeCloseTo(20, 6);
    expect(s.x[s.throat]).toBeCloseTo(0, 6);
    expect(s.caseR).toBeCloseTo(51, 6);
    expect(s.liner![0] - s.r0[0]).toBeCloseTo(8, 6); // ablative in the barrel
    expect(s.liner![s.throat] - s.r0[s.throat]).toBeCloseTo(6, 6); // the insert at the throat
    expect(s.insert![0]).toBeCloseTo(-20, 6);
    expect(s.insert![1]).toBeCloseTo(20, 6);
    expect(s.liner![s.x.length - 1]).toBeCloseTo(s.r0[s.x.length - 1], 6); // a bare divergent
  });

  it('thins a long contour but keeps its ends and its throat', () => {
    const many = geometry();
    const n = 1000;
    many.chamber_contour_x = Array.from({ length: n }, (_, k) => -0.15 + (0.25 * k) / (n - 1));
    many.chamber_contour_y = many.chamber_contour_x.map((x) => 0.02 + Math.abs(x - 0.0123) * 0.2);
    const t = sectionFromGeometry(many)!;
    expect(t.x.length).toBeLessThanOrEqual(242);
    expect(t.r0[t.throat]).toBeCloseTo(Math.min(...many.chamber_contour_y) * 1000, 6);
    expect(t.x[t.x.length - 1]).toBeCloseTo(100, 6);
    expect(thinIndices([3, 2, 1, 2, 3], 10)).toEqual([0, 1, 2, 3, 4]);
  });

  it('returns nothing without a contour', () => {
    expect(sectionFromGeometry(geometry({ chamber_contour_x: [], chamber_contour_y: [], positions: [], R_gas: [] }))).toBeNull();
  });
});

describe('is the open design this run\'s engine?', () => {
  it('yes when the throats agree within 3 % and ε within 10 %', () => {
    expect(runThroatMm(run())).toBeCloseTo(40, 6);
    expect(geometryIsRuns(geometry(), run())).toBe(true);
  });
  it('no for another throat (the session moved on to another design)', () => {
    expect(geometryIsRuns(geometry({ D_throat: 0.035 }), run())).toBe(false);
  });
  it('no for another expansion ratio', () => {
    expect(geometryIsRuns(geometry({ expansion_ratio: 6.1 }), run())).toBe(false);
  });
  it('taken when the run states neither', () => {
    expect(geometryIsRuns(geometry({ D_throat: 0.02 }), run({ replay: undefined, delivered: undefined }))).toBe(true);
  });
});

describe('the wall at a moment', () => {
  const s = sectionFromGeometry(geometry()) as Section;

  it('throat area ratio: 1 before firing, interpolated, held after', () => {
    expect(throatAreaRatioAt(run(), -1)).toBe(1);
    expect(throatAreaRatioAt(run(), 1.5)).toBeCloseTo(1.155, 9);
    expect(throatAreaRatioAt(run(), 9)).toBe(1.21);
    expect(throatAreaRatioAt(run(), 1, { t: [0, 2], At_ratio: [1, 1.5] })).toBeCloseTo(1.25, 9);
  });

  it('chamber recession: 0 before, held after', () => {
    expect(chamberRecessionAt(run(), 0)).toBe(0);
    expect(chamberRecessionAt(run(), 1.5)).toBeCloseTo(0.6, 9);
    expect(chamberRecessionAt(run(), 5)).toBe(0.8);
  });

  it('grows the throat to sqrt(At/At0) of its radius, and only near the throat', () => {
    const w = wallFromGrowth(s, 1.21, 0);
    expect(w[s.throat]).toBeCloseTo(22, 6); // 20 mm x 1.1
    expect(w[s.x.length - 1]).toBeCloseTo(s.r0[s.x.length - 1], 6);
    expect(w[0]).toBeCloseTo(s.r0[0], 6);
  });

  it('recedes the barrel by the chamber recession', () => {
    const w = wallFromGrowth(s, 1, 0.5);
    expect(w[0]).toBeCloseTo(40.5, 6);
    expect(w[s.throat]).toBeCloseTo(20, 6);
  });

  it('reads the run\'s own frames, between the nearest two', () => {
    const c = { x_mm: [0, 1, 2], r0_mm: [10, 5, 10], frames: { t: [0, 2], r_mm: [[10, 5, 10], [10, 7, 10]] } };
    expect(wallFromFrames(c, 3, 1)).toEqual([10, 6, 10]);
    expect(wallFromFrames(c, 3, -1)).toEqual([10, 5, 10]);
    expect(wallFromFrames(c, 3, 9)).toEqual([10, 7, 10]);
    expect(sectionFromContour(c)?.throat).toBe(1);
    expect(sectionFromContour({ x_mm: [0, 1], r0_mm: [1, 1] })).toBeNull();
  });

  it('lines the throat with the graphite insert where the ablative stops (the backend writes nulls)', () => {
    // LE4's shape: the ablative ends before the throat, the insert spans it (insert_r_mm), each null where the other is.
    const c = { x_mm: [-60, -30, 0, 30, 60], r0_mm: [63.5, 40, 23.9, 30, 47], liner_r_mm: [76.2, null, null, null, null],
                insert_r_mm: [null, 46, 29.9, 36, null], x_insert_mm: [-35.85, 35.85] };
    const s = sectionFromContour(c)!;
    expect(s.liner).toEqual([76.2, 46, 29.9, 36, 47]);
    expect(s.insert).toEqual([-35.85, 35.85]);
    expect(s.liner![s.throat] - s.r0[s.throat]).toBeCloseTo(6, 6);
  });
});

describe('plume art', () => {
  const under = { pc_psia: 400, pe_psia: 15, pa_psia: 13.5, gamma: 1.14 };
  const over = { pc_psia: 400, pe_psia: 9, pa_psia: 14.7, gamma: 1.14 };

  it('an under-expanded jet swells and fans out from the lip', () => {
    const a = plumeArt(under, 3)!;
    expect(a.p.regime).toBe('under-expanded');
    expect(a.rayKind).toBe('fan');
    expect(Math.max(...a.edge.map((e) => e.r))).toBeGreaterThan(1);
    expect(a.edge[0].r).toBeCloseTo(1, 9); // starts at the lip
  });

  it('an over-expanded jet narrows, with lip shocks meeting on the axis', () => {
    const a = plumeArt(over, 3)!;
    expect(a.p.regime).toBe('over-expanded');
    expect(a.rayKind).toBe('shock');
    expect(a.rays[0].r).toBe(0);
    expect(Math.min(...a.edge.map((e) => e.r))).toBeLessThan(1);
  });

  it('puts the diamonds one shock cell apart, inside the length drawn', () => {
    const a = plumeArt(over, 6)!;
    expect(a.diamonds.length).toBeGreaterThan(0);
    a.diamonds.forEach((d, k) => expect(d.x).toBeCloseTo((k + 1) * a.p.cellOverDe, 9));
    for (const d of a.diamonds) expect(d.x).toBeLessThanOrEqual(6);
  });

  it('nothing when not firing into air', () => {
    expect(plumeArt({ pc_psia: 10, pe_psia: 1, pa_psia: 14.7, gamma: 1.2 }, 3)).toBeNull();
  });

  it('one length per run, long enough for the first cell, within bounds', () => {
    expect(plumeLengthDe([])).toBe(PLUME_MIN_DE);
    const L = plumeLengthDe([under, under, over]);
    expect(L).toBeGreaterThanOrEqual(PLUME_MIN_DE);
    expect(L).toBeLessThanOrEqual(PLUME_MAX_DE);
  });

  it('separation: where the wall falls to 0.4 of ambient, only when the exit is below it', () => {
    expect(separationAreaRatio(under)).toBeNull();
    const deep = { pc_psia: 300, pe_psia: 3, pa_psia: 14.7, gamma: 1.2 };
    const ar = separationAreaRatio(deep)!;
    expect(ar).toBeGreaterThan(1);
    expect(stationAtRadius([30, 20, 25, 30, 35], 1, 29)).toBe(3);
    expect(stationAtRadius([30, 20, 25], 1, 99)).toBeNull();
  });
});

describe('framesAgree', () => {
  const section = { x: [-1, 0, 1], r0: [30, 23.9, 30], throat: 1 } as unknown as Parameters<typeof framesAgree>[1];
  it('accepts frames whose narrowest point is the run throat, rejects the as-built one', () => {
    const grown = 23.9 * Math.sqrt(1.057);
    expect(framesAgree([30.5, grown, 30], section, 1.057)).toBe(true);
    expect(framesAgree([30.5, 23.9, 30], section, 1.057)).toBe(false);
  });
});
