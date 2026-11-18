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
}

interface NodeData {
  componentType?: string;
  label?: string;
  page?: string;
  options?: Record<string, string>;
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
    },
  };
}

/** SHA-256 of the drawing, hex. Which drawing a bundle was made from. */
export async function drawingHash(drawing: Drawing): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ nodes: drawing.nodes, edges: drawing.edges }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
