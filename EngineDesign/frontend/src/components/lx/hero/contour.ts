import type { ChamberGeometryResponse } from '../../../api/client';
import type { LayerXResult } from '../../../api/layerx';
import { valueAt } from '../time/search';
import type { ContourBlock } from './contract';

/**
 * The engine's section, to scale: the as-built gas-side contour, the liner behind it, the case, and
 * the wall at a moment of the burn.
 *
 * From `diagnostics.hardware.contour` when the run has it (the wall at each frame, as the erosion
 * replay computed it). Otherwise from the open design's geometry (GET /api/geometry, what the
 * Chamber Geometry tab draws) -- but only when its throat is this run's throat: the geometry
 * endpoint answers for whatever design the session has open now, which need not be the one that
 * was burned. The wall then moves by what the run does carry: the throat area ratio (the throat's
 * radius grows by sqrt(At/At0)) and the chamber's recession.
 */

export interface Section {
  /** Axial stations [mm], ascending, injector face first. */
  x: number[];
  /** As-built gas-side radius [mm]. */
  r0: number[];
  /** The liner's outer radius [mm] (ablative or insert); equal to r0 where there is none. */
  liner: number[] | null;
  /** The case's outer radius [mm]. */
  caseR: number | null;
  /** Index of the throat (smallest r0). */
  throat: number;
  /** The graphite insert's axial span [mm], if any. */
  insert: [number, number] | null;
  source: 'run' | 'design';
}

export const M_TO_MM = 1000;

const argmin = (v: readonly number[]) => v.reduce((k, x, i) => (x < v[k] ? i : k), 0);

/** Stations kept when a contour is drawn. */
export const MAX_STATIONS = 240;

/** Every k-th index so at most `max` remain, always with the first, the last and the narrowest. */
export function thinIndices(r: readonly number[], max: number): number[] {
  const n = r.length;
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (max - 1);
  const out = new Set<number>();
  for (let k = 0; k < max; k++) out.add(Math.round(k * step));
  out.add(argmin(r));
  out.add(n - 1);
  return [...out].sort((a, b) => a - b);
}

/** The run's own contour (DATA-CONTRACT §3 hardware.contour). */
export function sectionFromContour(c: ContourBlock): Section | null {
  const n = Math.min(c.x_mm?.length ?? 0, c.r0_mm?.length ?? 0);
  if (n < 3) return null;
  const x = c.x_mm.slice(0, n).map(Number);
  const r0 = c.r0_mm.slice(0, n).map(Number);
  if (!x.every(Number.isFinite) || !r0.every((r) => Number.isFinite(r) && r > 0)) return null;
  // The lining is the ablative where there is one and the graphite insert over its span (the
  // backend writes each null where the other is): either is what stands behind the wall.
  const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const lin = c.liner_r_mm && c.liner_r_mm.length >= n ? c.liner_r_mm : null;
  const ins = c.insert_r_mm && c.insert_r_mm.length >= n ? c.insert_r_mm : null;
  const liner = lin || ins ? r0.map((r, i) => Math.max(num(lin?.[i]) ?? num(ins?.[i]) ?? r, r)) : null;
  const span = c.x_insert_mm && c.x_insert_mm.length === 2 && c.x_insert_mm.every((v) => Number.isFinite(v)) ? [c.x_insert_mm[0], c.x_insert_mm[1]] as [number, number] : null;
  return { x, r0, liner, caseR: null, throat: argmin(r0), insert: ins ? span : null, source: 'run' };
}

/** The open design's contour, liner and case, from the geometry endpoint (the Chamber Geometry tab's build). */
export function sectionFromGeometry(g: ChamberGeometryResponse): Section | null {
  const cx = g.chamber_contour_x ?? [];
  const cy = g.chamber_contour_y ?? [];
  let xm: number[];
  let rm: number[];
  let xT: number;
  if (cx.length > 2 && cy.length === cx.length) {
    xm = cx;
    rm = cy;
    xT = cx[argmin(cy)];
  } else if (g.positions?.length > 2 && g.R_gas?.length === g.positions.length) {
    xm = g.positions;
    rm = g.R_gas;
    xT = g.throat_position;
  } else {
    return null;
  }
  const n = g.positions?.length ?? 0;
  const tAbl = n > 0 && g.ablative_enabled ? Math.max(0, g.R_ablative_outer[0] - g.R_gas[0]) : 0;
  let tGra = 0;
  if (g.graphite_enabled) {
    for (let i = 0; i < n; i++) {
      const p = g.positions[i];
      if (p >= g.graphite_start && p <= g.graphite_end) tGra = Math.max(tGra, g.R_graphite_outer[i] - g.R_gas[i]);
    }
  }
  const g0 = xT - (g.throat_position - g.graphite_start);
  const g1 = xT + (g.graphite_end - g.throat_position);
  const nozzleAblative = (g as unknown as { nozzle_ablative?: boolean }).nozzle_ablative === true;
  const linerEnd = tGra > 0 ? g0 : xT;
  const liner = xm.map((x, i) => {
    const inInsert = tGra > 0 && x >= g0 && x <= g1;
    const lined = !inInsert && (x <= linerEnd || nozzleAblative);
    return (rm[i] + (inInsert ? tGra : lined ? tAbl : 0)) * M_TO_MM;
  });
  const caseR = n > 0 && Number.isFinite(g.R_stainless?.[0]) ? g.R_stainless[0] * M_TO_MM : null;
  // The solved contour has ~1000 stations; a few hundred draw the same curve.
  const keep = thinIndices(rm, MAX_STATIONS);
  const x = keep.map((i) => xm[i] * M_TO_MM);
  const r0 = keep.map((i) => rm[i] * M_TO_MM);
  return {
    x, r0,
    liner: tAbl > 0 || tGra > 0 ? keep.map((i) => liner[i]) : null,
    caseR,
    throat: argmin(r0),
    insert: tGra > 0 ? [g0 * M_TO_MM, g1 * M_TO_MM] : null,
    source: 'design',
  };
}

/** The run's as-built throat diameter [mm] (the replay's first throat area), or null. */
export function runThroatMm(result: LayerXResult): number | null {
  const a = result.replay?.A_throat_m2?.find((v) => Number.isFinite(v) && v > 0);
  return a ? Math.sqrt((4 * a) / Math.PI) * M_TO_MM : null;
}

/** The run's expansion ratio at the first firing step, or null. */
export function runEps(result: LayerXResult): number | null {
  const replayEps = (result.replay as { eps?: (number | null)[] } | undefined)?.eps;
  const e = result.delivered?.eps?.find((v) => Number.isFinite(v) && v > 1) ?? replayEps?.find((v) => v !== null && Number.isFinite(v) && v > 1);
  return typeof e === 'number' ? e : null;
}

/**
 * Is the open design's geometry this run's engine? Its throat within 3 % of the run's and, when
 * the run states it, its expansion ratio within 10 % (the run's ε is the eroded one, slightly lower).
 * With neither stated by the run there is nothing to check against, and it is taken.
 */
export function geometryIsRuns(g: ChamberGeometryResponse, result: LayerXResult): boolean {
  const dRun = runThroatMm(result);
  const dGeo = g.D_throat * M_TO_MM;
  if (dRun !== null && Number.isFinite(dGeo) && Math.abs(dGeo / dRun - 1) > 0.03) return false;
  const eRun = runEps(result);
  if (eRun !== null && Number.isFinite(g.expansion_ratio) && Math.abs(g.expansion_ratio / eRun - 1) > 0.1) return false;
  return true;
}

// ------------------------------------------------------------------ the wall at a moment

/** Throat area over as-built at t: the run's own hardware block, else the delivered replay; 1 before firing, held after. */
export function throatAreaRatioAt(result: LayerXResult, t: number, hw?: { t?: readonly number[]; At_ratio?: readonly (number | null)[] } | null): number {
  const pick = (ts: readonly number[] | undefined, vs: readonly (number | null)[] | undefined): number | null => {
    if (!ts?.length || !vs?.length) return null;
    if (t <= ts[0]) return 1;
    if (t >= ts[ts.length - 1]) {
      for (let k = vs.length - 1; k >= 0; k--) { const v = vs[k]; if (v !== null && Number.isFinite(v)) return v; }
      return null;
    }
    return valueAt(ts, vs, t);
  };
  const v = pick(hw?.t, hw?.At_ratio) ?? pick(result.delivered?.t, result.delivered?.throat_area_ratio);
  return v !== null && v > 0 ? v : 1;
}

/** The chamber wall's recession at t [mm] (replay), 0 when the run has none. */
export function chamberRecessionAt(result: LayerXResult, t: number): number {
  const r = result.replay;
  if (!r?.t?.length || !r.recession_chamber_mm?.length) return 0;
  if (t <= r.t[0]) return 0;
  const vs = r.recession_chamber_mm;
  if (t >= r.t[r.t.length - 1]) {
    for (let k = vs.length - 1; k >= 0; k--) { const v = vs[k]; if (v !== null && Number.isFinite(v)) return Math.max(0, v); }
    return 0;
  }
  return Math.max(0, valueAt(r.t, vs, t) ?? 0);
}

/**
 * The gas-side wall at a moment, from the as-built section and what the run carries: the throat
 * grown to sqrt(At/At0) of its radius over the throat region (the insert's span, or one throat
 * radius either side, with a raised-cosine edge), and the chamber barrel receded uniformly.
 */
export function wallFromGrowth(s: Section, areaRatio: number, chamberMm: number): number[] {
  const xT = s.x[s.throat];
  const rT = s.r0[s.throat];
  const dT = rT * (Math.sqrt(Math.max(areaRatio, 0)) - 1);
  const [a, b] = s.insert ?? [xT - rT, xT + rT];
  const edge = Math.max(rT * 0.5, 1);
  const rMax = Math.max(...s.r0.slice(0, s.throat + 1));
  return s.x.map((x, i) => {
    let w = 0;
    if (x >= a && x <= b) w = 1;
    else if (x < a && x > a - edge) w = 0.5 * (1 + Math.cos((Math.PI * (a - x)) / edge));
    else if (x > b && x < b + edge) w = 0.5 * (1 + Math.cos((Math.PI * (x - b)) / edge));
    // The barrel: upstream of the throat, where the wall is still at the chamber's radius.
    const barrel = i < s.throat && s.r0[i] >= 0.98 * rMax ? 1 : 0;
    return s.r0[i] + dT * w + chamberMm * barrel;
  });
}

/** Whether a drawn wall's narrowest point has the throat area the run reports (within 0.2 %). */
export function framesAgree(wall: readonly number[], section: Section, areaRatio: number): boolean {
  const r0 = section.r0[section.throat];
  const rMin = Math.min(...wall.filter((r) => Number.isFinite(r)));
  if (!(r0 > 0) || !Number.isFinite(rMin) || !(areaRatio > 0)) return true;
  return Math.abs((rMin / r0) ** 2 / areaRatio - 1) < 0.002;
}

/** The run's own wall at t, between its two nearest frames. */
export function wallFromFrames(c: ContourBlock, n: number, t: number): number[] | null {
  const f = c.frames;
  if (!f?.t?.length || !f.r_mm?.length) return null;
  const ts = f.t;
  const ok = (k: number) => Array.isArray(f.r_mm[k]) && f.r_mm[k].length >= n;
  if (t <= ts[0]) return ok(0) ? f.r_mm[0].slice(0, n) : null;
  const last = Math.min(ts.length, f.r_mm.length) - 1;
  if (t >= ts[last]) return ok(last) ? f.r_mm[last].slice(0, n) : null;
  let k = 0;
  while (k < last && ts[k + 1] <= t) k++;
  if (!ok(k) || !ok(k + 1)) return null;
  const w = (t - ts[k]) / (ts[k + 1] - ts[k]);
  return f.r_mm[k].slice(0, n).map((r, i) => r + (f.r_mm[k + 1][i] - r) * w);
}

/** The section as a closed SVG path (both halves) in screen space. */
export function sectionPath(x: readonly number[], r: readonly number[], sx: (v: number) => number, sy: (v: number) => number): string {
  const top = x.map((v, i) => `${i ? 'L' : 'M'}${sx(v).toFixed(1)} ${sy(r[i]).toFixed(1)}`).join(' ');
  return top;
}
