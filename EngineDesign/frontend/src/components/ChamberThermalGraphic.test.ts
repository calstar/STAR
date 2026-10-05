import { describe, expect, it } from 'vitest';
import type { ChamberGeometryResponse } from '../api/client';
import { buildThermalSection } from './ChamberThermalGraphic';

// The 6500 N payload's shape: the solved contour with its throat at x = 0 (face at -154.4 mm,
// exit at +90.1 mm), and the layer arrays in the router's face frame -- face at 0, throat at
// L_chamber = 130.97 mm, a cylinder run to the throat, insert at throat +/- 0.75 Dt.
const MM = 1e-3;
const Rt = 22.095 * MM;
const Rc = 63.5 * MM;
const tAbl = 12.7 * MM;
const tGra = 6.0 * MM;
const Lch = 130.97 * MM;
const half = 0.75 * 2 * Rt;

function contour(): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  const xFace = -154.4 * MM, xCone = -55.13 * MM, xArc = -23.435 * MM, xExit = 90.1 * MM;
  for (let i = 0; i <= 400; i++) {
    const xm = xFace + (xExit - xFace) * (i / 400);
    let r: number;
    if (xm <= xCone) r = Rc;
    else if (xm <= xArc) r = Rc - (xm - xCone);
    else if (xm <= 0) r = Rt + (Rc - (xArc - xCone) - Rt) * (xm / xArc) ** 2;
    else r = Rt + (52.28 * MM - Rt) * Math.sqrt(xm / xExit);
    x.push(xm);
    y.push(r);
  }
  return { x, y };
}

function payload(extra: Partial<ChamberGeometryResponse & { nozzle_ablative: boolean }> = {}) {
  const positions: number[] = [];
  const R_gas: number[] = [];
  const R_abl: number[] = [];
  const R_gra: number[] = [];
  const R_ss: number[] = [];
  for (let i = 0; i <= 200; i++) {
    const p = (243.6 * MM) * (i / 200);
    const rg = p <= Lch ? Rc : Rt + (p - Lch) * Math.tan((15 * Math.PI) / 180);
    const inG = p >= Lch - half && p <= Lch + half;
    positions.push(p);
    R_gas.push(rg);
    R_abl.push(rg + tAbl);
    R_gra.push(inG ? rg + tGra : rg);
    R_ss.push(rg + tAbl + 2.5 * MM);
  }
  const c = contour();
  return {
    positions, R_gas, R_ablative_outer: R_abl, R_graphite_outer: R_gra, R_stainless: R_ss,
    throat_position: Lch, graphite_start: Lch - half, graphite_end: Lch + half,
    D_chamber: 2 * Rc, D_throat: 2 * Rt, D_exit: 104.56 * MM, L_chamber: Lch, L_nozzle: 112.6 * MM,
    expansion_ratio: 5.5985, ablative_enabled: true, graphite_enabled: true,
    nozzle_x: [], nozzle_y: [], nozzle_method: 'top',
    chamber_contour_x: c.x, chamber_contour_y: c.y,
    Cf: null, Cf_ideal: null, A_throat_solved: null, chamber_contour_method: 'solved',
    t_abl_opt_mm: null, t_gra_opt_mm: null,
    ...extra,
  } as ChamberGeometryResponse & { nozzle_ablative?: boolean };
}

describe('buildThermalSection draws the layers in the contour frame', () => {
  const pts = buildThermalSection(payload(), 1000, false);
  const at = (xmm: number) => pts.reduce((a, b) => (Math.abs(b.x - xmm) < Math.abs(a.x - xmm) ? b : a));

  it('draws the insert at the throat of the solved contour', () => {
    expect(at(0).isGraphiteRegion).toBe(true);
    expect(Number(at(0).tGra)).toBeCloseTo(6.0, 1);
    // the insert spans throat +/- 0.75 Dt = +/- 33.1 mm
    expect(at(-30).isGraphiteRegion).toBe(true);
    expect(at(-40).isGraphiteRegion).toBe(false);
  });

  it('keeps the liner off a nozzle that is not ablative', () => {
    for (const p of pts.filter((q) => q.x > 34)) expect(p.tAbl).toBe('0.00');
  });

  it('lines the barrel with the declared liner', () => {
    expect(Number(at(-150).tAbl)).toBeCloseTo(12.7, 1);
    expect(Number(at(-40).tAbl)).toBeGreaterThan(0);
  });

  it('holds the case at one radius', () => {
    const r = pts.map((p) => p.rStainless_upper);
    expect(Math.max(...r) - Math.min(...r)).toBeLessThan(1e-9);
  });

  it('lines the nozzle when it is declared ablative', () => {
    const q = buildThermalSection(payload({ nozzle_ablative: true }), 1000, false);
    const exit = q[q.length - 1];
    expect(Number(exit.tAbl)).toBeGreaterThan(0);
  });
});
