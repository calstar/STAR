/**
 * What the DAQ's schematic page is given: `stand_pid.json`.
 *
 * The DAQ shows the drawing read-only, with its own live readings on it, and
 * must not need feed-twin or pid-designer running to do so. So everything it
 * needs travels in one file, committed beside the DAQ's config:
 *
 * - the whole stand as one SVG (pid-designer's `composeStand`), every symbol
 *   tagged with its id and its box written out;
 * - the hookup's `channels` -- the DAQ box as wired, whose `name` is the
 *   DAQ's own role name (`[actuator_roles]`, `[sensor_roles_*]`), which is
 *   the whole of the join between the DAQ's names and the drawing's tags;
 * - per symbol, what the overlay needs: type, tag, page, and for a valve the
 *   console drives, whether it is normally open or closed;
 * - which drawing this is, so the page can say what it is showing.
 *
 * The DAQ app reads this shape with its own copy of the types
 * (`lib/schematic.ts` there); `FORMAT` changes when the shape does.
 */

import type { StandSheet } from '@pid/standSheet';
import type { ChannelDef, Drawing } from '../api';
import { ATMOSPHERE_PSI, PRESSURE_UNIT, isGaugeUnit } from './pressure';

export const FORMAT = 'star.stand-pid/1';

export interface BundleSymbol {
  type: string;
  tag: string;
  page: string;
  /** For a valve the DAQ actuates: its unpowered position. Otherwise null. */
  normally: 'NO' | 'NC' | null;
}

export interface DaqBundle {
  format: typeof FORMAT;
  drawing: {
    /** feed-twin's id for the drawing. */
    diagram: string;
    /** The library artifact it was pulled as, when it was. */
    artifact: string | null;
    /** SHA-256 of the drawing's nodes and edges, as feed-twin held them. */
    sha256: string;
    exported_at: string;
  };
  svg: string;
  width: number;
  height: number;
  boxes: StandSheet['boxes'];
  mates: StandSheet['mates'];
  symbols: Record<string, BundleSymbol>;
  channels: ChannelDef[];
  /** Runs of line one pressure holds, for shading (`bundleSections`). */
  sections: Record<string, BundleSection>;
  /** The section each transducer reads. */
  sectionOf: Record<string, string>;
}

export interface BundleSection {
  lines: string[];
  /** What the section is shaded against, from the drawing; null leaves it to
   *  the DAQ (its transducers' full scale). Data, not words: the DAQ's screen
   *  says it (in gauge, as the DAQ reads), feed-twin's never does. */
  limit: SectionLimit | null;
}

export interface SectionLimit {
  /** Gauge. */
  psig: number;
  /** The vessel's tag. */
  vessel: string;
  /** A drawn MAWP, or burst pressure over the factor of safety. */
  basis: 'MAWP' | 'burst';
  burst_psig?: number;
  factor?: number;
}

interface Param {
  value: number;
  unit: string;
}

interface NodeData {
  componentType?: string;
  label?: string;
  page?: string;
  options?: Record<string, string>;
  params?: Record<string, Param>;
  attachedTo?: string;
}

/**
 * What a section ends at: anything that can hold two pressures across it.
 * Everything else -- a junction, a manifold, a tank, a disconnect, a
 * transducer -- is one pressure on every port.
 */
export const SECTION_BOUNDARY = new Set([
  'SOL', 'ROT', 'MOV', 'MAN', 'VALVE_BANK', 'PR', 'RV', 'CV', 'ENGINE',
]);

/** What carries a vessel limit on the drawing. */
const VESSELS = new Set(['TANK', 'KBOTTLE', 'DEWAR']);

/**
 * feed-twin trips a vessel at its burst pressure over this factor
 * (`Setup.burst_safety_factor`, default 2.0); the shading reaches red there too.
 */
export const BURST_SAFETY_FACTOR = 2.0;

/** A drawn pressure as gauge psi: bare psi is gauge on the drawing (ADR 0004). */
function drawnPsig(p: Param | undefined): number | null {
  if (!p || !Number.isFinite(p.value)) return null;
  const u = p.unit.trim().toLowerCase();
  if (u === 'psi' || isGaugeUnit(u)) return p.value;
  if (u === PRESSURE_UNIT) return p.value - ATMOSPHERE_PSI;
  return null;
}

/** A vessel's limit, gauge: its MAWP, else its burst over the factor of safety. */
export function vesselLimit(d: NodeData): SectionLimit | null {
  const vessel = d.label || 'vessel';
  const mawp = drawnPsig(d.params?.MAWP);
  if (mawp !== null && mawp > 0) return { psig: mawp, vessel, basis: 'MAWP' };
  const burst = drawnPsig(d.params?.burst_pressure);
  if (burst !== null && burst > 0) {
    return { psig: burst / BURST_SAFETY_FACTOR, vessel, basis: 'burst', burst_psig: burst, factor: BURST_SAFETY_FACTOR };
  }
  return null;
}

/**
 * The drawing cut into sections: lines joined through every symbol that is
 * not a boundary, the two halves of a mated disconnect joined to each other.
 * A section takes the lowest limit of the vessels on it.
 */
export function bundleSections(drawing: Drawing, mates: Record<string, string>): {
  sections: Record<string, BundleSection>;
  sectionOf: Record<string, string>;
} {
  const data = new Map(drawing.nodes.map((n) => [n.id, (n.data ?? {}) as NodeData]));
  const type = (id: string) => data.get(id)?.componentType ?? '';
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const edges = drawing.edges.filter((e) => data.has(e.source) && data.has(e.target));
  for (const e of edges) parent.set(e.id, e.id);

  // Lines meeting at a symbol that is not a boundary hold one pressure.
  const at = new Map<string, string[]>();
  for (const e of edges) {
    for (const end of [e.source, e.target]) at.set(end, [...(at.get(end) ?? []), e.id]);
  }
  const joined = (id: string) => !SECTION_BOUNDARY.has(type(id));
  for (const [node, ids] of at) if (joined(node)) for (const id of ids.slice(1)) union(ids[0], id);
  for (const [a, b] of Object.entries(mates)) {
    const la = at.get(a)?.[0];
    const lb = at.get(b)?.[0];
    if (la && lb && joined(a) && joined(b)) union(la, lb);
  }

  const sid = new Map<string, string>();
  const sections: Record<string, BundleSection> = {};
  for (const e of edges) {
    const root = find(e.id);
    if (!sid.has(root)) sid.set(root, `s${sid.size + 1}`);
    const s = sid.get(root)!;
    (sections[s] ??= { lines: [], limit: null }).lines.push(e.id);
  }
  const sectionOfNode = (id: string): string | undefined => {
    const line = at.get(id)?.[0];
    return line && joined(id) ? sid.get(find(line)) : undefined;
  };

  for (const [id, d] of data) {
    if (!VESSELS.has(d.componentType ?? '')) continue;
    const s = sectionOfNode(id);
    const limit = vesselLimit(d);
    if (!s || !limit) continue;
    const cur = sections[s].limit;
    if (!cur || limit.psig < cur.psig) sections[s].limit = limit;
  }

  // A transducer reads the section its line is on, or the line or symbol it
  // is clipped to.
  const sectionOf: Record<string, string> = {};
  const lineSection = new Map(edges.map((e) => [e.id, sid.get(find(e.id))!]));
  for (const [id, d] of data) {
    if (d.componentType !== 'PT') continue;
    const s = sectionOfNode(id)
      ?? (d.attachedTo ? lineSection.get(d.attachedTo) ?? sectionOfNode(d.attachedTo) : undefined);
    if (s) sectionOf[id] = s;
  }
  return { sections, sectionOf };
}

/**
 * Each symbol as the overlay needs it.
 *
 * `actuated` is the valves the hookup can put on a solenoid connector: only
 * those carry NO/NC, because only those the DAQ energises. An actuated valve
 * drawn with no `failState` is normally closed, the drawing's default.
 */
export function bundleSymbols(drawing: Drawing, actuated: ReadonlySet<string>): Record<string, BundleSymbol> {
  const out: Record<string, BundleSymbol> = {};
  for (const n of drawing.nodes) {
    const d = (n.data ?? {}) as NodeData;
    const type = d.componentType ?? n.type ?? '';
    out[n.id] = {
      type,
      tag: d.label || `unlabelled ${type || 'symbol'}`,
      page: d.page || 'Main',
      normally: actuated.has(n.id) ? (d.options?.failState === 'open' ? 'NO' : 'NC') : null,
    };
  }
  return out;
}

/**
 * The lines the picture must carry: those between two symbols on one page.
 * A line between pages is not drawn (pages.ts), so it is not looked for.
 */
export function drawnLines(drawing: Drawing): string[] {
  const page = new Map(drawing.nodes.map((n) => [n.id, ((n.data ?? {}) as NodeData).page || 'Main']));
  return drawing.edges
    .filter((e) => page.has(e.source) && page.has(e.target) && page.get(e.source) === page.get(e.target))
    .map((e) => e.id);
}

/**
 * The bundle, or why there is none.
 *
 * A picture missing a symbol is refused rather than shipped: the DAQ would
 * paint a reading onto nothing, and the first anyone would hear of it is a
 * transducer that never shows on the stand. A channel naming a symbol the
 * drawing does not have is refused for the same reason.
 */
export function buildBundle(args: {
  stand: StandSheet;
  drawing: Drawing;
  diagram: string;
  artifact: string | null;
  sha256: string;
  channels: ChannelDef[];
  actuated: ReadonlySet<string>;
  now?: Date;
}): { bundle: DaqBundle } | { error: string } {
  const { stand, drawing } = args;
  const { symbols: lostSymbols, lines: lostLines } = stand.missing;
  if (lostSymbols.length || lostLines.length) {
    const what = [
      lostSymbols.length ? `${lostSymbols.length} symbol(s) (${lostSymbols.slice(0, 5).join(', ')})` : '',
      lostLines.length ? `${lostLines.length} line(s) (${lostLines.slice(0, 5).join(', ')})` : '',
    ].filter(Boolean).join(' and ');
    return { error: `The picture came back without ${what}. Nothing was exported.` };
  }
  const symbols = bundleSymbols(drawing, args.actuated);
  const orphans = args.channels.filter((c) => c.symbol && !symbols[c.symbol]);
  if (orphans.length) {
    return {
      error: `The DAQ box has cables to symbols this drawing does not have: ${orphans.map((c) => c.name).join(', ')}. Unplug them first.`,
    };
  }
  return {
    bundle: {
      format: FORMAT,
      drawing: {
        diagram: args.diagram,
        artifact: args.artifact,
        sha256: args.sha256,
        exported_at: (args.now ?? new Date()).toISOString(),
      },
      svg: stand.svg,
      width: stand.width,
      height: stand.height,
      boxes: stand.boxes,
      mates: stand.mates,
      symbols,
      // Only cabled connectors: one with no symbol tells the DAQ nothing.
      channels: args.channels.filter((c) => c.symbol),
      ...bundleSections(drawing, stand.mates),
    },
  };
}

/** SHA-256 of the drawing, hex. Which drawing a bundle was made from. */
export async function drawingHash(drawing: Drawing): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ nodes: drawing.nodes, edges: drawing.edges }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
