import type { LayerXResult, SideSeries } from '../../../api/layerx';
import { PSI } from '../../layerx/format';
import { alignOnto } from '../charts/resample';
import { heroBlocks, type Col, type HeroBlocks, type NetNode, type NetworkBlock } from './contract';
import { domeLoaders, INLINE, isLiquidLine, isPressurant, JOIN, neighbours, type DLine, type DSymbol, type Drawing } from './drawing';
import { pressureRange } from './colormap';

/**
 * What the schematic shows on each line and symbol, over the whole burn, on the series' clock.
 *
 * From `result.network` (DATA-CONTRACT §2) when the run recorded it: every line is the branch of its
 * own id, every valve and regulator the branch of the symbol's id, every vessel the node(s) of its
 * id. Otherwise (runs before the network was recorded) from the series the result has, placed on the
 * drawing by role -- the bottle, the regulator, each tank's side -- and nothing else: a line that no
 * series speaks for keeps no reading and is drawn neutral.
 */

export interface Reading {
  /** Absolute pressure [psia]: a line's colour, a vessel's figure. */
  p?: Col | null;
  /** Upstream and downstream of a valve or regulator [psia]. */
  pIn?: Col | null;
  pOut?: Col | null;
  /** Its own loss [psi]. */
  dp?: Col | null;
  /** Mass flow [kg/s]. */
  mdot?: Col | null;
  /** Gas or line temperature [K]. */
  T?: Col | null;
  /** 0 shut .. 1 open. */
  state?: Col | null;
  /** Margin to boiling [psi]. */
  sat?: Col | null;
  /** A tank: liquid volume fraction 0..1, liquid mass [kg], what was loaded [kg], liquid temperature [K]. */
  level?: Col | null;
  liquidKg?: Col | null;
  loadedKg?: number | null;
  liquidT?: Col | null;
  /** A bottle's wall temperature [K] (the series has no gas temperature for it). */
  wallT?: Col | null;
  /** A regulator: share of its capacity in use (0..1). */
  use?: Col | null;
  /** An instrument: what it reads. */
  reading?: { values: Col; unit: 'psia' | 'K' } | null;
  side?: 'ox' | 'fuel' | 'gas' | null;
}

export interface NetView {
  source: 'network' | 'series';
  t: readonly number[];
  lines: Map<string, Reading>;
  symbols: Map<string, Reading>;
  /** Lowest and highest pressure on any line or vessel over the run [psia]. */
  pRange: [number, number] | null;
  /** Largest line flow over the run [kg/s]. */
  mdotMax: number;
  /** Lowest and highest tank gas temperature over the run [K]. */
  ullageRange: [number, number] | null;
}

// ------------------------------------------------------------------ column arithmetic

const mean2 = (a: Col | null | undefined, b: Col | null | undefined): Col | null => {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.map((x, i) => {
    const y = b[i];
    if (x === null || !Number.isFinite(x)) return y ?? null;
    if (y === null || y === undefined || !Number.isFinite(y)) return x;
    return (x + y) / 2;
  });
};

const add = (a: Col, b: Col): Col => a.map((x, i) => (x === null || b[i] === null ? null : x + (b[i] as number)));

/** Only where `mask` holds; null elsewhere. */
const masked = (a: Col, mask: readonly boolean[]): Col => a.map((x, i) => (mask[i] ? x : null));

/** Outflow from a falling mass [kg/s], central differences, never negative. */
export function outflow(t: readonly number[], mass: readonly number[]): Col {
  const n = Math.min(t.length, mass.length);
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dt = t[b] - t[a];
    if (!(dt > 0) || !Number.isFinite(mass[a]) || !Number.isFinite(mass[b])) continue;
    out[i] = Math.max(0, -(mass[b] - mass[a]) / dt);
  }
  return out;
}

const finiteRange = (cols: Iterable<Col | null | undefined>): [number, number] | null => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of cols) if (c) for (const v of c) if (v !== null && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return Number.isFinite(lo) ? [lo, hi] : null;
};

const maxAbs = (cols: Iterable<Col | null | undefined>): number => {
  let m = 0;
  for (const c of cols) if (c) for (const v of c) if (v !== null && Number.isFinite(v)) m = Math.max(m, Math.abs(v));
  return m;
};

// ------------------------------------------------------------------ roles

export type Side = 'ox' | 'fuel';

/** Each tank's side: the run's own roles, else by fluid (oxygen is the oxidiser). */
export function tankSides(d: Drawing, result: LayerXResult): Map<string, Side> {
  const roles = result.provenance?.derived?.roles;
  const m = new Map<string, Side>();
  const tanks = d.symbols.filter((s) => s.kind === 'tank' || s.kind === 'dewar');
  if (roles?.oxidiser && d.byId.has(roles.oxidiser)) m.set(roles.oxidiser, 'ox');
  if (roles?.fuel && d.byId.has(roles.fuel)) m.set(roles.fuel, 'fuel');
  for (const s of tanks) {
    if (m.has(s.id) || isPressurant(s.fluid)) continue;
    const f = (s.fluid ?? '').toLowerCase();
    const side: Side = f.includes('oxygen') || f === 'lox' || f.includes('nitrous') ? 'ox' : 'fuel';
    if (![...m.values()].includes(side)) m.set(s.id, side);
  }
  return m;
}

/** The bottle the run drew from. */
export function bottleOf(d: Drawing, result: LayerXResult): DSymbol | null {
  const id = (result.provenance?.derived as { copv_id?: unknown } | undefined)?.copv_id;
  const hit = typeof id === 'string' ? d.byId.get(id) : undefined;
  return hit ?? d.symbols.find((s) => s.kind === 'bottle') ?? null;
}

/**
 * The lines from a tank's liquid side to the engine, in order, with the symbols between. Only
 * paths that reach an engine count (a fill line does not).
 */
export function liquidPath(d: Drawing, tank: DSymbol): { lines: DLine[]; via: DSymbol[] } | null {
  const best: { lines: DLine[]; via: DSymbol[] }[] = [];
  const walk = (at: string, lines: DLine[], via: DSymbol[], seen: Set<string>) => {
    for (const n of neighbours(d, at)) {
      if (seen.has(n.other.id) || lines.includes(n.line)) continue;
      if (at === tank.id && !isLiquidLine(d, tank, n.line)) continue;
      const k = n.other.kind;
      if (k === 'engine') { best.push({ lines: [...lines, n.line], via }); continue; }
      if (k === 'tank' || k === 'bottle' || k === 'dewar' || k === 'vent' || k === 'instrument') continue;
      walk(n.other.id, [...lines, n.line], [...via, n.other], new Set([...seen, n.other.id]));
    }
  };
  walk(tank.id, [], [], new Set([tank.id]));
  best.sort((a, b) => a.lines.length - b.lines.length);
  return best[0] ?? null;
}

// ------------------------------------------------------------------ from the recorded network

function nodesOf(net: NetworkBlock, id: string): [string, NetNode][] {
  return Object.entries(net.nodes).filter(([k]) => k === id || k.startsWith(`${id}.`));
}

function fromNetwork(d: Drawing, result: LayerXResult, blocks: HeroBlocks, net: NetworkBlock): Pick<NetView, 'lines' | 'symbols'> {
  const lines = new Map<string, Reading>();
  const symbols = new Map<string, Reading>();
  const satOf = (...ids: (string | undefined)[]) => {
    for (const id of ids) {
      if (!id) continue;
      const hit = blocks.saturation.find((n) => n.id === id || n.id.startsWith(`${id}.`));
      if (hit?.margin_psi) return hit.margin_psi;
    }
    return null;
  };
  for (const l of d.lines) {
    const b = net.branches[l.id];
    if (!b) { lines.set(l.id, {}); continue; }
    const from = b.from ? net.nodes[b.from] : undefined;
    const to = b.to ? net.nodes[b.to] : undefined;
    lines.set(l.id, {
      p: mean2(from?.p_psia, to?.p_psia), pIn: from?.p_psia ?? null, pOut: to?.p_psia ?? null,
      dp: b.dp_psi ?? null, mdot: b.mdot ?? null, T: from?.T_K ?? to?.T_K ?? null, side: b.side ?? null,
      sat: satOf(b.from, b.to),
    });
  }
  const sides = tankSides(d, result);
  const reg = blocks.regulator;
  const regIds = new Set(Object.keys(result.series.regulators ?? {}));
  for (const s of d.symbols) {
    if (INLINE.has(s.kind)) {
      const b = net.branches[s.id];
      if (!b) { symbols.set(s.id, {}); continue; }
      const from = b.from ? net.nodes[b.from] : undefined;
      const to = b.to ? net.nodes[b.to] : undefined;
      const use = s.kind === 'regulator' && regIds.has(s.id) && reg?.use_frac && reg.t ? alignOnto(net.t, reg.t, reg.use_frac) : null;
      symbols.set(s.id, {
        p: from?.p_psia ?? null, pIn: from?.p_psia ?? null, pOut: to?.p_psia ?? null, dp: b.dp_psi ?? null,
        mdot: b.mdot ?? null, state: b.state ?? null, T: from?.T_K ?? null, side: b.side ?? null, use,
      });
      continue;
    }
    if (s.kind === 'instrument') {
      symbols.set(s.id, { reading: instrument(result, s.id) });
      continue;
    }
    const own = nodesOf(net, s.id);
    if (s.kind === 'engine') {
      const ch = Object.entries(net.nodes).find(([k, n]) => n.kind === 'chamber' && (k === s.id || k.startsWith(`${s.id}.`)))?.[1]
        ?? Object.values(net.nodes).find((n) => n.kind === 'chamber');
      // The chamber node's T_K is the arriving liquids' temperature (DATA-CONTRACT 2), not the gas's:
      // the engine shows no temperature rather than ~86 K.
      symbols.set(s.id, { ...engineFromSeries(result), ...(ch?.p_psia ? { p: ch.p_psia } : {}) });
      continue;
    }
    const gas = own.find(([, n]) => n.phase === 'gas')?.[1] ?? own[0]?.[1];
    const liq = own.find(([, n]) => n.phase === 'liquid')?.[1];
    const base: Reading = { p: gas?.p_psia ?? null, T: gas?.T_K ?? null, sat: satOf(...own.map(([k]) => k)), side: gas?.side ?? null };
    const side = sides.get(s.id);
    // Vessels read their own state (series), as the figures, charts and limits do. The network's
    // vessel node is the boundary of the step's last solve, up to a sub-step earlier: on the bottle
    // that is 2-7 psi high, and the same bottle must not read two numbers on one page.
    if (side) Object.assign(base, tankFromSeries(result, s.id, side, true), { liquidT: liq?.T_K ?? result.series[side].liquid_K });
    if (s.kind === 'bottle' && s.id === bottleOf(d, result)?.id) {
      base.p = result.series.copv_psia;
      base.wallT = result.series.copv_wall_K ?? null;
    } else if (s.kind === 'bottle') base.wallT = result.series.copv_wall_K ?? null;
    symbols.set(s.id, base);
  }
  return { lines, symbols };
}

// ------------------------------------------------------------------ from the series, by role

function instrument(result: LayerXResult, id: string): Reading['reading'] {
  const i = result.series.instruments?.[id];
  return i && Array.isArray(i.values) ? { values: i.values, unit: i.unit } : null;
}

function engineFromSeries(result: LayerXResult): Reading {
  const s = result.series;
  return {
    p: masked(s.chamber.pc_psia, s.firing),
    mdot: add(s.ox.mdot, s.fuel.mdot),
  };
}

function tankFromSeries(result: LayerXResult, id: string, side: Side, withPressure = true): Reading {
  const s: SideSeries = result.series[side];
  const loads = result.provenance?.derived?.loads_kg ?? null;
  const loaded = loads?.[id] ?? s.liquid_kg?.[0] ?? null;
  return {
    ...(withPressure ? { p: s.tank_psia, T: s.ullage_K } : {}),
    level: s.fill_fraction ?? null,
    liquidKg: s.liquid_kg ?? null,
    loadedKg: typeof loaded === 'number' ? loaded : null,
    liquidT: s.liquid_K ?? null,
    side,
  };
}

function fromSeries(d: Drawing, result: LayerXResult): Pick<NetView, 'lines' | 'symbols'> {
  const series = result.series;
  const lines = new Map<string, Reading>();
  const symbols = new Map<string, Reading>();
  const sides = tankSides(d, result);
  const bottle = bottleOf(d, result);
  const domes = domeLoaders(d);
  const gasOut = outflow(series.t, series.copv_mass_kg ?? []);

  const set = (l: DLine, r: Reading) => { if (!lines.has(l.id)) lines.set(l.id, r); };
  /**
   * Give `r` to `start`, and its pressure (not its flow, which splits where we cannot see) to every
   * unread line joined to it through manifolds and junctions.
   */
  const flood = (start: DLine, r: Reading) => {
    const queue = [start];
    while (queue.length) {
      const l = queue.shift() as DLine;
      if (lines.has(l.id)) continue;
      lines.set(l.id, l === start ? r : { p: r.p, side: r.side, mdot: null });
      for (const end of [l.from, l.to]) {
        const s = d.byId.get(end);
        if (!s || !JOIN.has(s.kind)) continue;
        for (const n of neighbours(d, end)) if (!lines.has(n.line.id)) queue.push(n.line);
      }
    }
  };

  // 1. Each tank's liquid side: tank outlet before the last valve, engine inlet after it; the
  //    side's flow throughout. A dead leg on the liquid side (a fill) holds the tank outlet.
  for (const [id, side] of sides) {
    const tank = d.byId.get(id) as DSymbol;
    const s = series[side];
    const path = liquidPath(d, tank);
    symbols.set(id, tankFromSeries(result, id, side));
    if (path) {
      const valves = path.via.map((v, k) => (INLINE.has(v.kind) ? k : -1)).filter((k) => k >= 0);
      const last = valves.length ? valves[valves.length - 1] : -1;
      path.lines.forEach((l, k) => {
        // Line k runs from via[k-1] (or the tank) to via[k] (or the engine).
        const p = last < 0 ? mean2(s.outlet_psia, s.inlet_psia) : k <= last ? s.outlet_psia : s.inlet_psia;
        set(l, { p, mdot: s.mdot, side });
      });
      for (const k of valves) {
        const v = path.via[k];
        symbols.set(v.id, { mdot: s.mdot, state: s.mdot.map((m) => (m > 1e-4 ? 1 : null)), side });
      }
    }
    for (const n of neighbours(d, id)) {
      if (isLiquidLine(d, tank, n.line)) set(n.line, { p: s.outlet_psia, mdot: null, side });
      else set(n.line, { p: s.tank_psia, side: 'gas' });
    }
  }

  // 2. The regulators the series records: their outlet, joined through manifolds; the bottle's
  //    outflow through them.
  for (const [rid, reg] of Object.entries(series.regulators ?? {})) {
    const sym = d.byId.get(rid);
    if (!sym) continue;
    for (const n of neighbours(d, rid)) {
      if (n.out && n.other.kind !== 'regulator') flood(n.line, { p: reg.outlet_psia, mdot: gasOut, side: 'gas' });
    }
    const inlet = neighbours(d, rid).find((n) => !n.out && n.other.kind !== 'regulator');
    symbols.set(rid, { p: reg.outlet_psia, pOut: reg.outlet_psia, pIn: series.copv_psia, mdot: gasOut, side: 'gas' });
    if (inlet && bottle) {
      // The supply line into it carries the same flow.
      const r: Reading = { p: series.copv_psia, mdot: gasOut, side: 'gas' };
      set(inlet.line, r);
    }
  }

  // 3. The bottle and everything joined to it before a regulator or valve.
  if (bottle) {
    symbols.set(bottle.id, { p: series.copv_psia, wallT: series.copv_wall_K ?? null, mdot: gasOut, side: 'gas' });
    const own = neighbours(d, bottle.id);
    for (const n of own) flood(n.line, { p: series.copv_psia, mdot: own.length === 1 ? gasOut : null, side: 'gas' });
  }

  // 4. A dome loader's outlet: the dome pressure the run set, constant.
  const derived = result.provenance?.derived ?? {};
  const domePsig = typeof derived.dome_psig === 'number' ? derived.dome_psig : null;
  const zeroPa = typeof (derived as { gauge_zero_pa?: unknown }).gauge_zero_pa === 'number' ? (derived as { gauge_zero_pa: number }).gauge_zero_pa : 101325;
  if (domePsig !== null) {
    const dome = series.t.map(() => domePsig + zeroPa / PSI);
    for (const [loader] of domes) {
      for (const n of neighbours(d, loader)) if (n.out) set(n.line, { p: dome, mdot: null, side: 'gas' });
      symbols.set(loader, { p: dome, pOut: dome, side: 'gas' });
    }
  }

  for (const s of d.symbols) {
    if (s.kind === 'engine') symbols.set(s.id, engineFromSeries(result));
    if (s.kind === 'instrument') symbols.set(s.id, { reading: instrument(result, s.id) });
  }
  for (const l of d.lines) if (!lines.has(l.id)) lines.set(l.id, {});
  return { lines, symbols };
}

// ------------------------------------------------------------------ the view

const empty = (r: Reading | undefined) => !r || Object.values(r).every((v) => v === null || v === undefined);

/**
 * The recorded network, with what it does not model filled in from the series by role. The network
 * carries the flow path only: a dome loader (PR-CTRL) and its lines (l_ctrl, l_dome) set the dome
 * and pass no flow, so they have no branch; the series' constant dome pressure speaks for them.
 */
export function withSeriesGaps(net: Pick<NetView, 'lines' | 'symbols'>, series: Pick<NetView, 'lines' | 'symbols'>): Pick<NetView, 'lines' | 'symbols'> {
  const lines = new Map(net.lines);
  const symbols = new Map(net.symbols);
  for (const [id, r] of series.lines) if (empty(lines.get(id)) && !empty(r)) lines.set(id, r);
  for (const [id, r] of series.symbols) if (empty(symbols.get(id)) && !empty(r)) symbols.set(id, r);
  return { lines, symbols };
}

export function buildNetView(d: Drawing, result: LayerXResult): NetView {
  const blocks = heroBlocks(result);
  const t = result.series.t;
  const net = blocks.network && blocks.network.t.length === t.length ? blocks.network : null;
  const { lines, symbols } = net ? withSeriesGaps(fromNetwork(d, result, blocks, net), fromSeries(d, result)) : fromSeries(d, result);
  const vessels = [...symbols.values()].map((r) => r.p);
  const pr = pressureRange([...[...lines.values()].map((r) => r.p ?? []), ...vessels.map((p) => p ?? [])]);
  const tanks = d.symbols.filter((s) => s.kind === 'tank' || s.kind === 'dewar').map((s) => symbols.get(s.id)?.T);
  return {
    source: net ? 'network' : 'series',
    t,
    lines,
    symbols,
    pRange: pr,
    mdotMax: maxAbs([...lines.values()].map((r) => r.mdot)),
    ullageRange: finiteRange(tanks),
  };
}
