import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { propagateFluids, edgeFluid, colorForSpecies, UNSET_COLOR } from './fluids';
import type { FluidAssignment } from './fluids';
import { instrumentTaps } from './ports';

/**
 * Which fluid is in what, published once for every symbol to read.
 *
 * This is **derived**, and deliberately never written back into node data.
 * What a line carries is a fact about the graph -- change which tank feeds it
 * and the answer changes -- so storing it would create a second copy that goes
 * stale the moment somebody moves an edge, and the stale copy is the one a
 * reader would trust. Only the *declaration* on a source is saved.
 *
 * A context rather than props because the node renderers are reached through
 * React Flow's `nodeTypes`, which passes them nothing of ours -- the same
 * reason `ReadOnlyProvider` exists.
 */

interface FluidMap {
  byNode: Map<string, FluidAssignment>;
  byEdge: Map<string, FluidAssignment>;
  /** Ports that are instrument tappings, by `"<node>:<port>"`. Derived from
   *  what is connected to them -- see `instrumentTaps`. */
  taps: Set<string>;
}

const EMPTY: FluidMap = { byNode: new Map(), byEdge: new Map(), taps: new Set() };
const FluidContext = createContext<FluidMap>(EMPTY);

export function FluidProvider({ nodes, edges, children }: {
  nodes: Node[]; edges: Edge[]; children: ReactNode;
}) {
  const value = useMemo<FluidMap>(() => {
    const byNode = propagateFluids(nodes, edges);
    const typeOf = new Map(nodes.map(n =>
      [n.id, (n.data as { componentType?: string } | undefined)?.componentType]));
    const byEdge = new Map(edges.map(e => [e.id, edgeFluid(e, byNode, typeOf)]));
    return { byNode, byEdge, taps: instrumentTaps(nodes, edges) };
  }, [nodes, edges]);

  return <FluidContext.Provider value={value}>{children}</FluidContext.Provider>;
}

/** Is this port an instrument tapping? True when everything on it is one. */
export function useIsTap(nodeId: string, portId: string): boolean {
  return useContext(FluidContext).taps.has(`${nodeId}:${portId}`);
}

/** What this component ended up carrying, declared or inherited. */
export function useNodeFluid(id: string): FluidAssignment | undefined {
  return useContext(FluidContext).byNode.get(id);
}

export function useEdgeFluidColor(id: string, override?: string): string {
  const f = useContext(FluidContext).byEdge.get(id);
  if (override) return override;
  if (f?.conflict) return CONFLICT_COLOR;
  return f?.species ? colorForSpecies(f.species) : UNSET_COLOR;
}

/** Two fluids meeting. Loud on purpose -- the shared danger token, not its
 *  own hardcoded red. */
export const CONFLICT_COLOR = 'var(--color-danger)';
