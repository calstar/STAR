import type { Node } from '@xyflow/react';
import type { PIDNodeData } from './types';

/**
 * Ports: what a component's connection points are, and what each one is for.
 *
 * A manifold is the reason this exists. One symbol on a drawing is a plenum
 * plus one branch per port in a solve, so "how many ports" was never enough --
 * which port feeds the engine and which one is instrumentation is the part a
 * reader and a solver both need, and it lived nowhere.
 *
 * Three kinds, matching `feedtwin.comps.manifold.PortKind`:
 *
 * - **flow** — carries fluid. The default, and what a drawn line attaches to.
 * - **instrument** — a tapping for a transducer. Real hardware, no flow; drawn
 *   smaller so it does not read as a feed.
 * - **plug** — blanked off. **Not drawn at all**, because a P&ID does not draw
 *   plugs; the port simply is not there until somebody says it is. That is
 *   also why a plug is a port kind rather than a symbol you place.
 */

export type PortKind = 'flow' | 'instrument' | 'plug';

export interface PortInfo {
  label?: string;
  kind?: PortKind;
}

/**
 * The id of port `i` in a group.
 *
 * Index 0 keeps the bare prefix -- `t`, not `t1`. That is not cosmetic: port
 * ids are what edges are attached to, so a scheme where raising a tank's port
 * count from one to two renames `t` into `t1` silently orphans every line
 * already drawn to it. An orphaned line is one React Flow cannot place, which
 * means it is saved and never rendered: the invisible-edge failure again.
 */
export const portId = (prefix: string, i: number) => (i === 0 ? prefix : `${prefix}${i + 1}`);

export const portIds = (prefix: string, count: number) =>
  Array.from({ length: Math.max(0, count) }, (_, i) => portId(prefix, i));

const dataOf = (n: Node) => n.data as unknown as PIDNodeData;

export function portInfo(data: PIDNodeData | undefined, id: string): PortInfo {
  return data?.ports?.[id] ?? {};
}

export const portKind = (data: PIDNodeData | undefined, id: string): PortKind =>
  portInfo(data, id).kind ?? 'flow';

/** A plugged port is not drawn, so nothing can be connected to it. */
export const portIsDrawn = (data: PIDNodeData | undefined, id: string) =>
  portKind(data, id) !== 'plug';

/**
 * Every port a component has, by id.
 *
 * This table repeats what the node components render, and that duplication is
 * deliberate but not free: the checks below and the config dialog both need
 * the list without a DOM to read it off. Kept in one place so there is exactly
 * one thing to change, and covered by a test that walks every declared
 * component type.
 */
export function portsOf(node: Node): string[] {
  const d = dataOf(node);
  const t = d?.componentType;
  const count = (key: string, fallback: number) => {
    const raw = Number(d?.options?.[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };

  switch (t) {
    case 'RTD': case 'TC': case 'PT': case 'PG': case 'LC':
    case 'QD': case 'JUNCTION':
      return ['t', 'b', 'l', 'r'];
    case 'MAN': case 'ROT': case 'SOL': case 'RV': case 'CV':
      return ['l', 'r'];
    case 'PR':
      return d?.options?.domeLoaded === 'yes' ? ['l', 'r', 'dome'] : ['l', 'r'];
    case 'TANK':
      return [
        ...portIds('t', count('portsTop', 1)),
        ...portIds('b', count('portsBottom', 1)),
      ];
    case 'MANIFOLD':
      return ['in', ...portIds('p', count('outlets', 4))];
    case 'ENGINE':
      return ['fuel', 'ox', 't'];
    case 'INJECTOR':
      return ['t', 'b'];
    case 'KBOTTLE':
      return ['t', 'r'];
    case 'DEWAR':
      return ['t', 'b', 'r'];
    default:
      return [];
  }
}

/** The ports actually drawn: everything except the plugged ones. */
export const drawnPortsOf = (node: Node) =>
  portsOf(node).filter(id => portIsDrawn(dataOf(node), id));
