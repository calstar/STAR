import type { LayerXResult } from '../../../api/layerx';

/**
 * The parts of docs/layerx/DATA-CONTRACT.md the hero reads, typed here because the backend is adding
 * them while this is written: every one is optional, and a block that failed is
 * `{ available: false, error }`. `heroBlocks` reads them defensively, so a half-written block
 * (wrong lengths, a missing column) reads as absent rather than throwing mid-render.
 */

export type Col = readonly (number | null)[];

export interface NetNode {
  label?: string;
  kind?: string;
  side?: 'ox' | 'fuel' | 'gas' | null;
  p_psia?: Col;
  T_K?: Col;
  phase?: 'gas' | 'liquid';
}

export interface NetBranch {
  label?: string;
  kind?: string;
  from?: string;
  to?: string;
  side?: 'ox' | 'fuel' | 'gas';
  mdot?: Col;
  dp_psi?: Col;
  cv?: number;
  /** 0..1 open fraction, for a valve. */
  state?: Col;
}

export interface NetworkBlock {
  t: readonly number[];
  nodes: Record<string, NetNode>;
  branches: Record<string, NetBranch>;
  paths?: { ox?: string[]; fuel?: string[] };
}

export interface SaturationNode {
  id: string;
  label?: string;
  side?: string;
  margin_psi?: Col;
  min_psi?: number;
  t_min?: number;
}

export interface ContourBlock {
  x_mm: readonly number[];
  r0_mm: readonly number[];
  frames?: { t: readonly number[]; r_mm: readonly (readonly number[])[] };
  liner_r_mm?: readonly (number | null)[];
  /** The graphite insert's outer radius [mm] over its span, null elsewhere. */
  insert_r_mm?: readonly (number | null)[];
  /** The insert's axial span [mm]. */
  x_insert_mm?: readonly number[];
}

export interface HardwareBlock {
  t?: readonly number[];
  throat_d_mm?: Col;
  At_ratio?: Col;
  liner_min_mm?: Col;
  contour?: ContourBlock;
  separation?: { pe_pa?: Col; summerfield?: readonly boolean[]; flag?: boolean };
}

export interface RegulatorBlock {
  t?: readonly number[];
  use_frac?: Col;
  wide_open?: readonly boolean[];
}

export interface HeroBlocks {
  network: NetworkBlock | null;
  saturation: SaturationNode[];
  hardware: HardwareBlock | null;
  regulator: RegulatorBlock | null;
}

type Loose = Record<string, unknown> | null | undefined;

const obj = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

/** A block that is present and did not fail. */
const live = (x: unknown): Record<string, unknown> | null => {
  const o = obj(x);
  return o && o.available !== false ? o : null;
};

const isNums = (x: unknown): x is number[] => Array.isArray(x);

/** The network, if it is there and follows the series' clock. */
function networkOf(raw: unknown): NetworkBlock | null {
  const o = live(raw);
  if (!o || !isNums(o.t) || !obj(o.nodes) || !obj(o.branches)) return null;
  return o as unknown as NetworkBlock;
}

/** The contract's blocks the hero draws from, each null when absent or failed. */
export function heroBlocks(result: LayerXResult): HeroBlocks {
  const r = result as LayerXResult & { network?: unknown; diagnostics?: unknown };
  const diag: Loose = live(r.diagnostics);
  const sat = live(diag?.saturation);
  const nodes = Array.isArray(sat?.nodes) ? (sat.nodes as SaturationNode[]).filter((n) => n && typeof n.id === 'string') : [];
  const hw = live(diag?.hardware) as HardwareBlock | null;
  const reg = live(diag?.regulator) as RegulatorBlock | null;
  return { network: networkOf(r.network), saturation: nodes, hardware: hw, regulator: reg };
}

/** A column's value at index i, finite or null. */
export function at(col: Col | readonly number[] | null | undefined, i: number): number | null {
  if (!col || i < 0 || i >= col.length) return null;
  const v = col[i];
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}
