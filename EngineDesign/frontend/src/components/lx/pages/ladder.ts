import type { LayerXResult } from '../../../api/layerx';
import type { Ladder, Network } from '../contract';

/**
 * The pressure ladder at one moment as a waterfall: where each psi between the source and the
 * chamber goes. Pure, so the arithmetic is tested rather than eyeballed.
 *
 * The bottle sits thousands of psi above the tanks, so a waterfall drawn from the bottle is one
 * regulator bar and slivers. The regulator (and anything upstream of it) is the "supply": listed
 * with its drop, drawn broken, and left out of the scale. The waterfall proper runs from the
 * regulator's outlet (or the tank's lockup, on the coarse ladder) to the chamber, and each
 * element's share is of that span.
 */

export interface Rung {
  key: string;
  label: string;
  kind: string;
  /** psi; a gain (liquid head) is negative. Null: not known at this moment. */
  dp: number | null;
}

export interface PlacedRung extends Rung {
  /** The bar's ends on the track, 0..1 (left = the top of the span). */
  x0: number;
  x1: number;
  /** Of the span's total drop; null when the drop or the total is unknown. */
  share: number | null;
}

export interface LadderView {
  start: { label: string; p: number | null };
  /** Upstream of (and including) the regulator: listed, not scaled. */
  supply: Rung[];
  /** Where the waterfall starts: the regulator outlet, or the start when there is no supply. */
  top: { label: string; p: number | null };
  rungs: PlacedRung[];
  end: { label: string; p: number | null };
  /** The top-to-chamber drop the shares are of [psi]. */
  span: number | null;
}

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function ladderView(all: readonly Rung[], start: { label: string; p: number | null }, end: { label: string; p: number | null },
                           topLabel = 'Regulator outlet'): LadderView {
  let lastReg = -1;
  all.forEach((r, k) => { if (r.kind === 'regulator') lastReg = k; });
  const supply = all.slice(0, lastReg + 1);
  const down = all.slice(lastReg + 1);
  const supplyDrop = supply.reduce((a, r) => a + (num(r.dp) ? r.dp : 0), 0);
  const top = supply.length
    ? { label: topLabel, p: num(start.p) && supply.every((r) => num(r.dp)) ? start.p - supplyDrop : null }
    : start;

  let c = 0;
  const ends = down.map((r) => {
    const a = c;
    c += num(r.dp) ? r.dp : 0;
    return [a, c] as const;
  });
  const lo = Math.min(0, ...ends.flat());
  const hi = Math.max(0, ...ends.flat());
  const w = hi - lo || 1;
  const sum = down.reduce((a, r) => a + (num(r.dp) ? r.dp : 0), 0);
  const span = down.length && down.every((r) => num(r.dp)) ? sum : null;
  const rungs: PlacedRung[] = down.map((r, k) => {
    const [a, b] = ends[k];
    return {
      ...r,
      x0: (Math.min(a, b) - lo) / w,
      x1: (Math.max(a, b) - lo) / w,
      share: num(r.dp) && span !== null && span > 0 ? r.dp / span : null,
    };
  });
  return { start, supply, top, rungs, end, span };
}

/**
 * Start the ladder at the bottle's own pressure (the vessel state the figures, charts and limits
 * show) rather than the network's bottle node, which is the boundary of the step's last solve and
 * up to a sub-step earlier (2-7 psi high on LE4). The difference is the bottle's blowdown within
 * that sub-step; it is given to the regulator, whose drop is whatever lies between the bottle and
 * its outlet, so the ladder still closes on the same outlet and chamber.
 */
export function anchorToVessel(rungs: readonly Rung[], nodeStart: number | null, vessel: number | null): { rungs: Rung[]; start: number | null } {
  if (!num(vessel)) return { rungs: [...rungs], start: nodeStart };
  if (!num(nodeStart)) return { rungs: [...rungs], start: vessel };
  let lastReg = -1;
  rungs.forEach((r, k) => { if (r.kind === 'regulator') lastReg = k; });
  if (lastReg < 0 || !num(rungs[lastReg].dp)) return { rungs: [...rungs], start: nodeStart };
  const shift = vessel - nodeStart;
  return { rungs: rungs.map((r, k) => (k === lastReg ? { ...r, dp: (r.dp as number) + shift } : r)), start: vessel };
}

/** The backend's ladder at one of its steps, for one side. */
export function rungsFromDiag(ladder: Ladder, side: 'ox' | 'fuel', k: number): { rungs: Rung[]; total: number | null } | null {
  const s = ladder[side];
  if (!s || k < 0) return null;
  const at = (c: readonly (number | null)[] | undefined) => {
    const v = c?.[k];
    return num(v) ? v : null;
  };
  return {
    rungs: s.elements.map((e) => ({ key: e.id, label: e.label, kind: e.kind, dp: at(e.dp_psi) })),
    total: at(s.total_psi),
  };
}

/**
 * The ladder from the recorded network when the run has the network but not the ladder: the
 * branches along the side's path, bottle to chamber, each with its own drop at step `k`. The start
 * is the path's first node, by its own name.
 */
export function rungsFromNetwork(net: Network, side: 'ox' | 'fuel', k: number): { rungs: Rung[]; start: number | null; startLabel: string } | null {
  const path = net.paths?.[side];
  if (!path?.length || k < 0) return null;
  const rungs: Rung[] = [];
  for (const id of path) {
    const b = net.branches[id];
    if (!b) return null;
    const v = b.dp_psi?.[k];
    rungs.push({ key: id, label: b.label || id, kind: b.kind, dp: num(v) ? v : null });
  }
  const first = net.branches[path[0]];
  const node = first ? net.nodes[first.from] : undefined;
  const p0 = node?.p_psia?.[k];
  return { rungs, start: num(p0) ? p0 : null, startLabel: node?.label || 'Source' };
}

/**
 * The coarse ladder today's runs carry: lockup, then the tank's sag, the liquid head, the line,
 * the drop into the manifold and the injector, from the series at step `i`.
 */
export function coarseRungs(r: LayerXResult, side: 'ox' | 'fuel', i: number, pc: number | null): Rung[] {
  const s = r.series[side];
  const t0 = r.summary[side].t0_psia;
  const v = (x: number | undefined) => (num(x) ? x : null);
  const d = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
  const tank = v(s.tank_psia[i]);
  const out = v(s.outlet_psia[i]);
  const inl = v(s.inlet_psia[i]);
  const man = v(s.manifold_psia[i]);
  return [
    { key: 'sag', label: 'Tank sag', kind: 'tank', dp: d(t0, tank) },
    { key: 'head', label: 'Liquid head', kind: 'tank', dp: d(tank, out) },
    { key: 'line', label: 'Feed line', kind: 'line', dp: d(out, inl) },
    { key: 'dump', label: 'Into manifold', kind: 'fitting', dp: d(inl, man) },
    { key: 'inj', label: 'Injector', kind: 'injector', dp: d(man, pc) },
  ];
}
