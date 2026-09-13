/**
 * Copy, paste and duplicate.
 *
 * A stand has eight solenoid valves that are the same solenoid valve, and a
 * drawing tool with no way to copy one is a drawing tool where the eighth is
 * configured by hand from the palette like the first. This is the model
 * underneath Cmd+C / Cmd+V / Cmd+D: what a copy holds, and how it lands.
 *
 * What lands is a *new* symbol, not a reference. Fresh ids, because an id is
 * the tag a solver keys on; a fresh tag from the same template, because two
 * valves both called SOL-3 is exactly the duplicate the checks exist to
 * catch; and only the lines whose both ends were copied, because half a
 * pipe is worse than none. A probe clipped to a copied component stays
 * clipped to the copy; one clipped to something outside the selection is
 * pasted loose, since what it measured did not come along.
 */

import type { Edge, Node } from '@xyflow/react';
import { nextJunctionId, nextNodeId } from './ids';
import { numberTag, tagStem } from './tags';
import type { PIDNodeData } from './types';

export interface Clip {
  nodes: Node[];
  edges: Edge[];
}

/** How far a paste lands from the original: enough to see it is a copy. */
export const PASTE_OFFSET = { x: 40, y: 40 };

const dataOf = (n: Node) => n.data as unknown as PIDNodeData;

/** The selected symbols, and the lines that run between them. */
export function copySelection(nodes: Node[], edges: Edge[]): Clip | null {
  const picked = nodes.filter(n => n.selected);
  if (picked.length === 0) return null;
  const ids = new Set(picked.map(n => n.id));
  return {
    nodes: structuredClone(picked.map(({ selected: _s, dragging: _d, measured: _m, ...n }) => n as Node)),
    edges: structuredClone(edges
      .filter(e => ids.has(e.source) && ids.has(e.target))
      .map(({ selected: _s, ...e }) => e as Edge)),
  };
}

/**
 * The copy, as it will be added to the drawing.
 *
 * `existing` is what is already there, so tags can be numbered past it and
 * the paste lands on the page being looked at. Pasted symbols come back
 * selected and everything else is left alone, so a paste followed by a drag
 * moves the copy and not the original.
 */
export function pasteClip(
  clip: Clip,
  existing: Node[],
  page: string,
  offset = PASTE_OFFSET,
): { nodes: Node[]; edges: Edge[] } {
  const idMap = new Map<string, string>();
  for (const n of clip.nodes) {
    idMap.set(n.id, n.type === 'JUNCTION' ? nextJunctionId() : nextNodeId());
  }

  // Tags are numbered against the drawing *and* against the copies placed
  // before this one in the same paste, so eight valves land as eight tags.
  const taken = existing.map(n => dataOf(n)?.label ?? '');

  const nodes = clip.nodes.map(n => {
    const d = dataOf(n);
    const next: PIDNodeData = { ...d, page };
    if (d?.label && d.componentType && d.componentType !== 'REGION' && d.componentType !== 'TEXT') {
      const tag = numberTag(`${tagStem(d.label)}_#`, taken);
      taken.push(tag);
      next.label = tag;
    }
    if (d?.attachedTo) {
      const host = idMap.get(d.attachedTo);
      if (host) next.attachedTo = host;
      else delete next.attachedTo;
    }
    return {
      ...n,
      id: idMap.get(n.id)!,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      selected: true,
      data: next as unknown as Record<string, unknown>,
    } as Node;
  });

  const edges = clip.edges.map(e => ({
    ...e,
    id: `${idMap.get(e.source)}-${idMap.get(e.target)}`,
    source: idMap.get(e.source)!,
    target: idMap.get(e.target)!,
    selected: false,
  } as Edge));

  return { nodes, edges };
}
